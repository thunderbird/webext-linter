// Belongs here: the STATE file - the review itself, written once and re-read every pass,
// and the pairing between it and the REVIEW file the agent is handed.
//
// Does NOT belong here: what a phase asks (src/report/phases.js), what a hand-back must
// look like (src/report/handback.js), or how a prompt is printed (src/report/format.js).
//
// WHY A FILE AT ALL: the loop runs one deterministic review, in the first --llm-review
// run, and every pass after it reads this. Nothing is re-derived - so anything the report
// reads must be in here, and the invariant test (equivalent decisions produce today's
// report byte for byte) is really a completeness check on this shape.
//
// WHY THE AGENT NEVER SEES IT: what the linter needs across passes would otherwise become
// a contract. `wantsBuild` only decided whether a step printed; BUILD_PROCESS is named by
// a step, so that one is handed over and this one is not.
import fs from "node:fs";
import path from "node:path";

/** The two files share a stem, so a person sees them as a pair on disk. Nothing in the
 *  loop derives one from the other: the review file names its own state directly, in its
 *  `base` field (src/report/handback.js readHandback). */
export const STATE_SUFFIX = ".state.json";
export const REVIEW_SUFFIX = ".review.json";

/**
 * @typedef {object} LoopState
 * @property {number} version  Refuses a file this build cannot read, rather than reading
 *   it wrongly.
 * @property {string} review  Where the agent's file goes. Stored, because the name carries
 *   the moment the review began and no later pass can recompute one.
 * @property {object} report  Everything formatText needs that the registry cannot
 *   recompute: findings, meta, mode, experiments, flags. NOT ruleInputs / issueHeadings /
 *   verdictIntros - those are the registry's, and a stale copy here would outlive an edit
 *   to it.
 * @property {object[]} manual  The to-do items, kept beside the findings because
 *   orderReview numbers the two together and either alone renumbers the rest.
 * @property {?object} preSweep  The blind-spot sweep as the registry authored it, or null
 *   when this review does not sweep.
 * @property {{skip: string[], sca: boolean, sweep: boolean}} run  What this run was told
 *   to leave out (PROMPT_SKIPS), whether it is a source code review, and whether it
 *   sweeps. One record, read by everything that asks: a step prints by it, the routing
 *   drops entries by it, and both legs of a hand-over ask it the same question.
 * @property {object} paths  The values a step names: description, build, schemaCache,
 *   scaRoot. Held here because a later pass prints them and cannot re-derive a moment.
 * @property {?string} phase  The phase in flight - what went out last, and so what the
 *   next hand-back is read as.
 * @property {string[]} issued  Every phase that has gone out, in order. What the final
 *   prompt reads to know whether a link was already handed over.
 * @property {Object<string, *>} answers  index -> what came back, once it is settled.
 * @property {Object<string, string>} route  index -> the phase it is open in NOW, when a
 *   verdict moved it. Absent means the phase its kind routes it to.
 * @property {Object<string, *>} sweep  check -> the hints that check's sweep returned.
 */

/**
 * Write the state, replacing whatever was there.
 *
 * The linter always overwrites its own file, so the agent can never hand back an older
 * one: there is exactly one state per review, and it only moves forward.
 * @param {string} file
 * @param {LoopState} state
 */
export function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 1)}\n`);
}

/**
 * Read the state back, or throw naming the file.
 *
 * Every failure here is the same class - the review cannot continue - so each says which
 * file and why, rather than surfacing a JSON parse error with no subject.
 * @param {string} file
 * @returns {LoopState}
 */
export function readState(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`Could not read the review's state: ${file}`);
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    throw new Error(`The review's state is not JSON: ${file}`);
  }
  if (state?.version !== STATE_VERSION) {
    throw new Error(
      `The review's state was written by another version of this tool: ${file}`
    );
  }
  return state;
}

/** Bumped when the shape, or what the loop DOES with it, changes in a way an older file
 *  cannot satisfy. A review in flight does not survive the upgrade, and saying so beats
 *  reading it wrongly. Version 4 is a meaning change rather than a shape one: nothing new
 *  is stored, but a review that stops early no longer issues the phase a v3 review would
 *  have, so resuming one across the two would ask a reviewer what this build would not. */
export const STATE_VERSION = 4;
