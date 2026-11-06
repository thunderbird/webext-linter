// THE RECORD: .review/state.json in a work folder, one file in every mode. The load creates
// it empty, with the work folder (src/review/start.js loadTheXpi). It has two parts:
//
// - the permanent part: what earlier steps settled, only ever added to (addToRecord), never
//   replaced. The entry point adds what the run was given (the submission, the kind of review,
//   the flags and the folder xpi/), the step that puts the source in sca/ that folder, and the
//   build check's rescue the folder rescued/. The review of the loaded submission adds what
//   its early-exit run worked out (the Experiment verdict, which early-exit checks ran and
//   whether they passed, and in a source review an agent runs, whether its XPI could be
//   reviewed on its own). The build check, once done, adds its results (`build`). Whatever
//   ends a review adds the review (`review`): after a rejected early-exit run in LLM mode the
//   review as those checks produced it, at the loop's end the review and the verdicts so far.
//   "close the review" reads only this part;
// - the current part (`current`): the mode, its step or phase and the mode's own body, which
//   says what the next hand-back of the folder does (src/cli.js runHandback). Starting a mode
//   replaces it whole (startMode), and moving on within a mode moves only it on.
//
// The modes:
//
// - `unpack`: the agent extracts the source archive into `sca/` (--llm-auto-review only);
// - `build-check`: the build of a source review is checked, step by step from `analyze` on
//   (src/build-check/steps.js);
// - `review`: the review loop, at the phase it handed out last (src/report/loop.js), and at
//   the close, with no body, where every later hand-back is refused;
// - `downgrade`: an aborted source review waits for the reviewer's answer to the restart
//   prompt, whether to restart it as a review of the XPI alone. It has no body: the review
//   and its verdicts are in the permanent part.
//
// A record with no current part, empty or as a plain review leaves it, holds no review in
// progress. The submission's folders are facts of the permanent part (`folders`), each added
// by the step that creates it, and the folders a hand-back finds as the linter left them
// (namedFolders). A step moves the record on with one atomic write, so a run cut short leaves
// it as it was or as it moved, and no hand-back deletes a record.
//
// The file is the linter's alone. The agent works in the same folder as the same user, so
// nothing makes it tamper-proof, and three things stand in for that. Every write leaves it
// read-only. Every write stores a hash over the record in it (`digest`), so any change at all
// is caught on the next read. And what a changed record could still decide is checked as the
// linter would write it, by the one reader of the record's mode.
//
// Belongs here: the modes, the two parts, starting a mode (startMode), adding to the
// permanent part (addToRecord), the folders a record names, and reading and writing the
// record. Does NOT belong here: what a mode's own part holds and how it moves on within the
// mode (src/build-check/state.js and src/build-check/steps.js for the build check,
// src/report/loop.js for the review), or the folder's names (src/util/dest.js workPaths).

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { writeFileAtomic } from "../util/atomic.js";
import { rawSha256 } from "../normalize/hash.js";
import { parseJson } from "../util/json.js";
import { workPaths } from "../util/dest.js";
import { recordError, rethrowIfFatal, wiringError } from "../lib/errors.js";
import { checkBuildCheck, recordBoolean } from "../build-check/state.js";

/** The mode every write leaves the record at: readable, and writable by nobody. */
const READ_ONLY = 0o444;

/** The record's modes, which the hand-back switches on. */
export const MODE = Object.freeze({
  unpack: "unpack",
  buildCheck: "build-check",
  review: "review",
  downgrade: "downgrade",
});

/**
 * The field a mode's record names where it stands in: the review's phase, every other
 * mode's step.
 * @param {string} mode
 * @returns {"phase"|"step"}
 */
function positionOf(mode) {
  return mode === MODE.review ? "phase" : "step";
}

/**
 * Start a mode: the record with its current part replaced by `mode`, the mode's own body
 * given, at its first step or phase. The permanent part is not touched, and nothing of the
 * mode before it is left. Nothing is written: issuing the mode's prompt writes it.
 * @param {object} record
 * @param {string} mode  A MODE value.
 * @param {object} body  The mode's own part.
 * @param {?string} at  Its first step or phase.
 * @returns {object}  The record.
 */
export function startMode(record, mode, body, at) {
  return { ...record, current: { mode, ...body, [positionOf(mode)]: at } };
}

/**
 * Add to the record: the facts a step settled added to the permanent part and the record
 * written at once (atomic), its current part as it is. A fact already there with the same
 * value is left as it is, so a step run again in the same folder adds nothing twice, and one
 * given a different value is the tool's own error. A fact that is an object of facts, such as
 * `folders`, is added to key by key, so adding one folder never replaces another.
 * @param {string} work  The work folder.
 * @param {object} record  The record the folder holds.
 * @param {object} facts  What the step settled, by name. None of them is `current`.
 * @returns {object}  The record as written.
 */
export function addToRecord(work, record, facts) {
  const { current, digest: _digest, ...permanent } = record;
  if (Object.hasOwn(facts, "current") || Object.hasOwn(facts, "digest")) {
    throw wiringError(
      "addToRecord: `current` and `digest` are no facts of the permanent part."
    );
  }
  const clashing = [];
  const added = addedFacts(permanent, facts, "", clashing);
  if (clashing.length) {
    throw wiringError(
      `addToRecord: the record's permanent part is only added to, and ${clashing.join(", ")} ` +
        "would replace what is there."
    );
  }
  return writeRecord(work, {
    ...added,
    ...(current === undefined ? {} : { current }),
  });
}

/**
 * The facts `have` holds with `facts` added, an object of facts on both sides added to key by
 * key. A fact there with another value is named in `clashing`.
 * @param {object} have
 * @param {object} facts
 * @param {string} at  The name of `have` in the record, empty at its top.
 * @param {string[]} clashing  Collects what would be replaced.
 * @returns {object}
 */
function addedFacts(have, facts, at, clashing) {
  const out = { ...have };
  for (const [key, value] of Object.entries(facts)) {
    const name = at ? `${at}.${key}` : key;
    if (!Object.hasOwn(have, key)) {
      out[key] = value;
    } else if (isPlainObject(have[key]) && isPlainObject(value)) {
      out[key] = addedFacts(have[key], value, name, clashing);
    } else if (!isDeepStrictEqual(have[key], value)) {
      clashing.push(name);
    }
  }
  return out;
}

/**
 * Whether a value is an object of named facts: not null, no list.
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The mode a record is in, undefined for one with no current part.
 * @param {object} record
 * @returns {string|undefined}
 */
export function modeOf(record) {
  return record.current?.mode;
}

/**
 * The submission's folders a record names (`folders`), each added once by the step that
 * created it: xpi/ with what the run was given, sca/ once the source is there, and rescued/
 * when the build check made the rescued copy. What a hand-back expects to find as the linter
 * left them. Nothing is inferred from the kind, the mode or the roots.
 * @param {object} record
 * @returns {string[]}  Absolute.
 */
export function namedFolders(record) {
  return Object.values(record.folders ?? {});
}

/**
 * The record a work folder holds, checked for its mode's shape. A record with no mode, empty
 * as the load created it or as a plain review left it, is returned unchecked, for the caller
 * to say that no review is in progress.
 *
 * Every record it does not take is a failure, never a refusal: the record is the linter's
 * alone, so the agent cannot repair it. That is a folder holding the record of a run from
 * before the record had a mode (prepare.json), a record that is not there or cannot be read,
 * one that is not JSON, one changed after the linter wrote it, one naming a mode this tool
 * does not know, and one not of its mode's shape.
 * @param {string} work  The work folder.
 * @returns {object}
 * @throws {Error}
 */
export function readRecord(work) {
  const paths = workPaths(work);
  if (fs.existsSync(paths.prepare)) {
    throw new Error(
      `The work folder "${work}" holds the record of an older version of the linter, and ` +
        "cannot be carried on. Start the review again from the submission."
    );
  }
  let raw;
  try {
    raw = fs.readFileSync(paths.state, "utf8");
  } catch (err) {
    rethrowIfFatal(err);
    throw new Error(
      `The work folder "${work}" holds no review this command can carry on: its record ` +
        `cannot be read (${err.code ?? err.message}: ${paths.state}).`
    );
  }
  const record = parseJson(raw);
  if (record === null || typeof record !== "object") {
    throw new Error(
      `The work folder "${work}" holds no review this command can carry on: its record is ` +
        `not JSON (${paths.state}).`
    );
  }
  const { digest, ...body } = record;
  if (digest !== recordDigest(body)) {
    throw recordError(
      `it was changed after the linter wrote it (${paths.state})`
    );
  }
  const mode = modeOf(record);
  if (mode !== undefined && !Object.values(MODE).includes(mode)) {
    throw new Error(
      `The review's record names no mode this tool knows: ${paths.state}`
    );
  }
  checkShape(record);
  return record;
}

/**
 * The one reader of a record's shape, by its mode: the permanent part every mode reads, and
 * the mode's own part.
 * @param {object} record
 * @throws {Error}
 */
function checkShape(record) {
  const mode = modeOf(record);
  if (mode === undefined) {
    return;
  }
  if (!record.submission || typeof record.submission !== "object") {
    throw recordError("the review's record names no submission");
  }
  recordBoolean(record.submission.experiments, "submission.experiments");
  if (mode === MODE.buildCheck) {
    checkBuildCheck(record);
    return;
  }
  if (mode === MODE.unpack) {
    return;
  }
  // A review in the loop is mode review's own part. Once the review ended, at the close or at
  // the restart prompt, the review is the permanent part's, and the current part holds only
  // the mode and where it stands.
  const loop = mode === MODE.review && record.current.report !== undefined;
  const review = loop ? record.current : record.review;
  if (
    !review?.report ||
    typeof review.report !== "object" ||
    (loop && !review.run)
  ) {
    throw recordError(
      "the review's record holds no review of the shape the linter writes"
    );
  }
}

/**
 * Write the record, replacing whatever was there, with its digest, and leave it read-only.
 * Atomic, so a run that is interrupted leaves the mode and step it was in or the ones it
 * moved to, never half of either.
 * @param {string} work  The work folder.
 * @param {object} record  Any `digest` it carries is replaced.
 * @returns {object}  The record as written, with its new digest.
 */
export function writeRecord(work, record) {
  const relative = relativeFolders(record);
  if (relative.length) {
    throw wiringError(
      "writeRecord: the review's record must hold every folder as an absolute path, " +
        `and ${relative.join(", ")} is not.`
    );
  }
  const { digest: _stale, ...body } = record;
  const written = { ...body, digest: recordDigest(body) };
  const file = workPaths(work).state;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Replaced by a rename, which asks for permission on the folder rather than on the file,
  // so the record's own read-only mode never stands in the linter's way.
  writeFileAtomic(file, `${JSON.stringify(written, null, 1)}\n`);
  fs.chmodSync(file, READ_ONLY);
  return written;
}

/**
 * The fields of a record that name a folder or file and are not absolute, by name. Every
 * path a record holds is read by a later run, from whatever directory that run is started
 * in, so each is turned absolute where it enters (src/cli.js realFolder) and checked here,
 * where a missed conversion would otherwise be written down for good. The folder flags are
 * the `*-dir` ones, the only folder flags a review forwards.
 * @param {object} record
 * @returns {string[]}
 */
function relativeFolders(record) {
  const named = [
    ["submission.xpi", record.submission?.xpi],
    ...Object.entries(record.current?.roots ?? {}).map(([key, value]) => [
      `current.roots.${key}`,
      value,
    ]),
    ["current.buildOutput", record.current?.buildOutput],
    ["build.output", record.build?.output],
    ...Object.entries(record.folders ?? {}).map(([key, value]) => [
      `folders.${key}`,
      value,
    ]),
    ...Object.entries(record.flags ?? {})
      .filter(([flag]) => flag.endsWith("-dir"))
      .map(([flag, value]) => [`flags.${flag}`, value]),
  ];
  return named
    .filter(
      ([, value]) =>
        typeof value === "string" && value !== "" && !path.isAbsolute(value)
    )
    .map(([field]) => field);
}

/**
 * The hash over a record's fields, in the order they are written: what writeRecord stores as
 * `digest` and readRecord checks the record against.
 * @param {object} body  The record without its `digest`.
 * @returns {string}
 */
function recordDigest(body) {
  return rawSha256(JSON.stringify(body));
}
