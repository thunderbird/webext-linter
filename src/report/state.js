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
import { parseJson } from "../util/json.js";
import { rethrowIfFatal } from "../lib/errors.js";

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
 *   recompute: findings, meta, mode, experiments, flags. NOT issueHeadings /
 *   verdictIntros - those are the registry's, and a stale copy here would outlive an edit
 *   to it.
 * @property {object[]} manual  The to-do items, kept beside the findings because
 *   orderReview numbers the two together and either alone renumbers the rest.
 * @property {?object} preSweep  The blind-spot sweeps as the registry authored them, or
 *   null when no check that ran authors one.
 * @property {{skip: string[], sca: boolean, warningsAsErrors: boolean}} run
 *   What this run was told to leave out (PROMPT_SKIPS), whether it is a source code review,
 *   which trees it sweeps (one sweepRun key each), and the band it publishes a warning at (--warnings-as-errors). One
 *   record, read by everything that asks: a step prints by it, the routing drops entries by
 *   it, the registry is read under it, and both legs of a hand-over ask it the same question.
 * @property {object} paths  The values a step names: description, build, report,
 *   schemaCache, schema, the two artifact roots (scaRoot, xpiRoot) an entry's paths are
 *   resolved against, and `sweeps` - each tree's sweep request and answers file, by
 *   artifact, which is also what says WHICH trees this review asked about. Held here
 *   because a later pass prints them and cannot re-derive a moment - and `report` is also
 *   where a later pass WRITES, so losing it would leave the reviewer holding a link to a
 *   file nothing refreshes.
 * @property {?string} phase  The phase in flight - what went out last, and so what the
 *   next hand-back is read as.
 * @property {string[]} issued  Every phase that has gone out, in order. What the final
 *   prompt reads to know whether a link was already handed over.
 * @property {Object<string, *>} answers  index -> what came back, once it is settled.
 * @property {Object<string, string>} route  index -> the phase it is open in NOW, when a
 *   verdict moved it. Absent means the phase its kind routes it to.
 * @property {?object[]} sweep  Everything the sweeping agents found, read back off their
 *   own answer files and already resolved to the check and the artifact each belongs to
 *   (src/report/sweep-files.js). Null where no tree was asked, which is not the same as
 *   every tree answering with nothing. Written and read inside the one `accept` that
 *   starts them; what stops a second pass starting them again is `issued`.
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
  } catch (err) {
    rethrowIfFatal(err);
    throw new Error(`Could not read the review's state: ${file}`);
  }
  const state = parseJson(raw);
  if (state === null) {
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
 *  reading it wrongly. Version 9 needs an `artifact` and a `label` on every pre-swept
 *  sweep, an `artifact` on every finding and case, `paths.xpiRoot`, and `paths.sweeps`
 *  naming each tree's request and answers. A v8 file has no `paths.sweeps` and no labels,
 *  because its sweeps were asked for as rows in the review file and answered by the agent
 *  transcribing them - so there are no answer files to read and nothing to read them
 *  against. Saying the version is wrong sends the reviewer to start the review again,
 *  where reading it would find every sweep unanswered. */
export const STATE_VERSION = 9;
