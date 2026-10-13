// Belongs here: the STATE file - the review itself, written once and re-read every pass,
// and the pairing between it and the REVIEW file the agent is handed.
//
// Does NOT belong here: what a phase asks (src/report/phases.js), what a hand-back must
// look like (src/report/handback.js), how a prompt is printed (src/report/format.js), or
// where either file lives (src/util/dest.js workPaths).
//
// WHY A FILE AT ALL: the loop runs one deterministic review, in the first --llm-review
// run, and every pass after it reads this. Nothing is re-derived - so anything the report
// reads must be in here, and the invariant test (equivalent decisions produce today's
// report byte for byte) is really a completeness check on this shape.
//
// WHY THE AGENT NEVER SEES IT: what the linter needs across passes would otherwise become
// a contract. A value a step names (LLM_BUILD_PROCESS, say) is handed over in the prompt, and
// the rest stays here.
import fs from "node:fs";
import path from "node:path";
import { parseJson } from "../util/json.js";
import { rethrowIfFatal } from "../lib/errors.js";

/**
 * @typedef {object} LoopState
 * @property {number} version  Refuses a file this build cannot read, rather than reading
 *   it wrongly.
 * @property {object} report  Everything formatText needs that the registry cannot
 *   recompute: findings, meta, and whether it is a source code review (`sca`). NOT issueHeadings /
 *   verdictIntros - those are the registry's, and a stale copy here would outlive an edit
 *   to it.
 * @property {object[]} manual  The to-do items, kept beside the findings because
 *   orderReview orders the two together.
 * @property {?object} preSweep  The blind-spot sweeps as the registry authored them, or
 *   null when no check that ran authors one.
 * @property {{skip: string[], sca: boolean, warningsAsErrors: boolean}} run
 *   What this run was told to leave out (PROMPT_SKIPS), whether it is a source code review,
 *   whether every check a build relies on runs (`build-guarded`), which trees it sweeps
 *   (one sweepRun key each), and the band it publishes a warning at (--warnings-as-errors). One
 *   record, read by everything that asks: a step prints by it, the routing drops entries by
 *   it, the registry is read under it, and both legs of a hand-over ask it the same question.
 * @property {object} paths  The values a step names: description, build, report (all in
 *   the review's work folder, src/util/dest.js workPaths, which also holds this file and
 *   the review file and is not recorded: the state is read from it), schemaCache, schema,
 *   the two artifact roots
 *   (scaRoot, xpiRoot) an entry's paths are resolved against, and `sweeps` - each tree's sweep
 *   request (the text its step hands over) and answers file, by artifact, which is also
 *   what says WHICH trees this review asked about. Held here
 *   because a later pass prints them and cannot re-derive a moment - and `report` is also
 *   where a later pass WRITES, so losing it would leave the reviewer holding a link to a
 *   file nothing refreshes.
 * @property {{result: ?string, output: ?string, match: ?string,
 *   vulnerabilities: ?{moderate: number, high: number, critical: number}}} build  What came
 *   of the agent's build in the preparation (a BUILD_RESULT value, src/prepare/state.js, or
 *   null where it built nothing), what it produced where it built and the agent's comparison
 *   of that with the submitted XPI, and the lock's vulnerable packages as this
 *   review's own audit counted them, null where that audit was not made in full. The Build
 *   Review Details show them, and the `built` step is worded by them.
 * @property {?string} phase  The phase in flight - what went out last, and so what the
 *   next hand-back is read as. Unset until the first prompt goes out, which is how a prompt
 *   knows it is the first (`first`, src/report/loop.js runOf).
 * @property {string[]} issued  Every phase that has been handed back, in order. What a
 *   later prompt reads to know what already happened: whether agents were started
 *   (`spawned`) and whether the agent judged anything (`decided`).
 * @property {Object<string, string>} [values]  The process values returned so far: a
 *   phase answering `value` -> the id it returned. Read by value(phase, id) in a `when:`.
 * @property {Object<string, *>} answers  An item's reference (`ref`, src/report/order.js
 *   assignRefs) -> what came back, once it is settled.
 * @property {?object[]} sweep  Everything the sweeping agents found, read back off their
 *   answers files and already resolved to the check and the artifact each belongs to
 *   (src/report/sweep-files.js). Null where no tree was asked, which is not the same as
 *   every tree answering with nothing. Written and read inside the one `accept` that
 *   starts them; what stops a second pass starting them again is `issued`.
 * @property {string[]} [products]  The `paths` keys of the phase products that came back
 *   (a phase's `product`: a file its agent wrote, src/report/handback.js productWritten,
 *   or the path an output phase's answer named), recorded once as that phase is handed
 *   back.
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
 *  where reading it would find every sweep unanswered. Version 10 adds the build phase,
 *  which reads `paths.buildCopy` and `paths.buildDiff`. Version 11 names each skip in
 *  `run.skip` by its full flag (`llm-skip-manual`), the name the registry's step
 *  conditions read - a v10 file's short names would match no step. Version 12 carries where a
 *  to-do item is asked on the item itself (`askedIn`), set by its check or by the agent's
 *  `ask` verdict, instead of in a `route` map keyed by index - a v11 file's routes would be
 *  read by nothing. Version 13 records no path to the state or the review file: both are in
 *  the work folder the state is read from, by their fixed names - a v12 file's recorded
 *  review path is read by nothing. Version 14 keys `answers` by each item's fixed `ref`,
 *  stored on the item, instead of by its position - a v13 file's numbers name no item.
 *  Version 15 adds `values`, the process values a `when:` reads - a v14 review in flight
 *  would never be asked for them. Version 16 carries each tree's sweep request in
 *  `paths.sweeps` as the text its step hands over, where a v15 file names a request file
 *  that no step hands over and no review writes any more. Version 17 has the build phase
 *  answer where its build put what it produced, kept as `paths.buildOutput`, where a v16 file
 *  names a `paths.buildDiff` no step writes and its build phase asks nothing. Version 18 builds
 *  nothing in the review: it holds the preparation's build in `build`, which the Build Review
 *  Details and the `built` step read, where a v17 file has no `build` and may be waiting on
 *  a `build` phase this review does not have. */
export const STATE_VERSION = 18;
