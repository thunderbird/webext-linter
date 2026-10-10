// The PREPARATION's record: prepare.json in a work folder, written by the run that creates the
// folder for a source code review, and by every hand-back of that folder after it - and read
// by those hand-backs and by the review that starts in the folder.
//
// The preparation runs in steps, and the agent following it hands back only the roots it
// worked out (src/prepare/steps.js). So everything a later step needs - which submission
// this is, how its review is to be run, which roots were settled, where the preparation
// stands - is recorded here by the linter and read back by the next run, never taken from
// the agent. No prompt names this file.
//
// The file is the linter's alone. The agent works in the same folder as the same user, so
// nothing makes it tamper-proof; three things stand in for that. Every write leaves it
// read-only, the plainest signal that it is out of the agent's reach. Every write stores a
// hash over the record in it (`digest`), so any change at all - a plausible one included -
// is caught on the next read; an integrity check, not proof of who wrote it. And what a
// changed record could still decide is checked as the linter would write it (recordBoolean).
//
// One record per work folder. The folder the source was extracted into holds one from the
// start; a rescued copy (`<work>-rescued`) holds its own, which names the folder it was
// copied from. The hand-back that finds a folder done starts its review from this record
// (src/cli.js), and that review reads it too (src/pipeline.js): a rescued review reads the
// original's package files from the root it names, to tell the developer the rescue changed
// them (originalPackages).
//
// Belongs here: the record's shape and version, reading and writing it, marking a folder at
// a step, and reading the package files of the original root it names. Does NOT belong
// here: what each step does and when the record moves on (-> ./steps.js), the audit that
// decides it (-> ./audit.js), the folder's names (-> src/util/dest.js workPaths), or how a
// prompt is printed (-> src/report/format.js).

import fs from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../util/atomic.js";
import { rawSha256 } from "../normalize/hash.js";
import { parseJson } from "../util/json.js";
import { workPaths } from "../util/dest.js";
import { rethrowIfFatal, wiringError } from "../lib/errors.js";
import { PACKAGE_FILE } from "../vendor/package-file.js";
import { TREE_LOCKS } from "../vendor/locks.js";
import { HandbackRefused } from "../report/handback.js";

/** Bumped when the record's shape, or what a step does with it, changes in a way an older
 *  file cannot satisfy. A preparation in flight does not survive the upgrade, and saying so
 *  beats reading it wrongly. */
export const PREPARE_VERSION = 2;

/** The mode every write leaves the record at: readable, and writable by nobody. */
const READ_ONLY = 0o444;

/**
 * Where a preparation stands, which is what the next hand-back of the folder does:
 *
 * - `extract`: the source is to be extracted into `sca/` and its roots handed back in the
 *   review file, and the next hand-back settles and audits them;
 * - `reduce` and `fix`: a rescued copy, waiting for its dependencies to be reduced, then
 *   audit-fixed, and audited again after each;
 * - `handed`: the folder handed its source to a rescued copy (`rescued`), which carries the
 *   preparation on;
 * - `done`: the review may start here, and the record holds what its command is built from.
 *   A folder whose rescue was given up is `done` too, marked `unrescued`.
 */
export const PREPARE_STEP = Object.freeze({
  extract: "extract",
  reduce: "reduce",
  fix: "fix",
  handed: "handed",
  done: "done",
});

/**
 * @typedef {object} PrepareRecord
 * @property {number} version  PREPARE_VERSION.
 * @property {string} step  A PREPARE_STEP value.
 * @property {{xpi: string, experiments: boolean}} submission  The built add-on, absolute,
 *   and whether its manifest.json declares Experiments - which decides whether the roots
 *   include the Experiment folder.
 * @property {Record<string, string|boolean>} flags  The flags the review is to be run with,
 *   as parsed (src/cli.js), named without their dashes. A folder among them is absolute, so
 *   the command means the same wherever it is run.
 * @property {?{scaRoot: string, scaExpSource: ?string}} roots  The settled roots, absolute
 *   and real, once known.
 * @property {?{work: string, scaRoot: string}} original  In a rescued copy: the work folder
 *   it was copied from, and that folder's settled root. Null otherwise.
 * @property {?string} rescued  In a folder that handed its source to a rescued copy: that
 *   copy. Kept once the folder is `done` again after a rescue was given up, so the pair can
 *   still be proven while the copy is removed. Null otherwise.
 * @property {boolean} unrescued  The rescue was given up: the folder's own source is
 *   reviewed, like any other, and its vulnerability checks stop it.
 * @property {string} digest  The hash over every other field, as writePrepare stored it
 *   (recordDigest). A record whose digest does not match was changed after it was written.
 *
 * Every boolean in the record - `unrescued`, `submission.experiments`, a boolean flag - is
 * `true` or `false`, which is all the linter writes. Anything else was put there by an edit,
 * and the record is refused rather than read (recordBoolean).
 */

/**
 * The record a work folder holds, or null when it holds none.
 *
 * A record that is there and cannot be read is not "none": the folder was prepared, and
 * reading past a broken record would start a review the preparation never finished.
 * @param {string} work  The work folder.
 * @returns {?PrepareRecord}
 */
export function readPrepare(work) {
  const file = workPaths(work).prepare;
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    rethrowIfFatal(err);
    // No such file, or no such folder for it to be in: either way, none was prepared here.
    if (err.code === "ENOENT" || err.code === "ENOTDIR") {
      return null;
    }
    throw new Error(
      `Could not read the preparation's record: ${file} (${err.code ?? err.message})`
    );
  }
  const record = parseJson(raw);
  if (record === null || typeof record !== "object") {
    throw new Error(`The preparation's record is not JSON: ${file}`);
  }
  if (record.version !== PREPARE_VERSION) {
    throw new Error(
      `The preparation's record was written by another version of this tool: ${file}`
    );
  }
  const { digest, ...body } = record;
  if (digest !== recordDigest(body)) {
    throw new HandbackRefused(
      "the preparation's record was changed after the linter wrote it"
    );
  }
  if (!Object.values(PREPARE_STEP).includes(record.step)) {
    throw new Error(
      `The preparation's record names no step this tool knows: ${file}`
    );
  }
  // The record's own booleans, checked here so no reader tests one itself.
  recordBoolean(record.unrescued, "unrescued");
  if (!record.submission || typeof record.submission !== "object") {
    throw new HandbackRefused("the preparation's record names no submission");
  }
  recordBoolean(record.submission.experiments, "submission.experiments");
  return record;
}

/**
 * A boolean read from a preparation's record: `true` or `false`, which is all the linter
 * writes. Anything else - a string, a number, null, nothing - was put there by an edit, and
 * guessing what it meant would let the edit decide; so it is refused to the agent as a
 * hand-back is.
 * @param {unknown} value
 * @param {string} what  How the refusal names it.
 * @returns {boolean}
 * @throws {HandbackRefused}
 */
export function recordBoolean(value, what) {
  if (value !== true && value !== false) {
    throw new HandbackRefused(
      `the preparation's record holds ${what} as neither true nor false`
    );
  }
  return value;
}

/**
 * The record of a preparation that has not started: at its first step, with what the run
 * that created the work folder alone knows, and nothing worked out yet.
 * @param {Pick<PrepareRecord, "submission" | "flags">} known
 * @returns {PrepareRecord}
 */
export function startRecord({ submission, flags }) {
  return {
    version: PREPARE_VERSION,
    step: PREPARE_STEP.extract,
    submission,
    flags,
    roots: null,
    original: null,
    rescued: null,
    unrescued: false,
  };
}

/**
 * Write the record, replacing whatever was there, with its digest, and leave it read-only.
 * Atomic, so a run that is interrupted leaves the step it was in or the one it moved to,
 * never half of either.
 * @param {string} work  The work folder.
 * @param {PrepareRecord} record  Any `digest` it carries is replaced.
 * @returns {PrepareRecord}  The record as written, with its new digest.
 */
export function writePrepare(work, record) {
  const relative = relativeFolders(record);
  if (relative.length) {
    throw wiringError(
      "writePrepare: the preparation's record must hold every folder as an absolute path, " +
        `and ${relative.join(", ")} is not.`
    );
  }
  const { digest: _stale, ...body } = record;
  const written = { ...body, digest: recordDigest(body) };
  const file = workPaths(work).prepare;
  // Replaced by a rename, which asks for permission on the folder rather than on the file,
  // so the record's own read-only mode never stands in the linter's way.
  writeFileAtomic(file, `${JSON.stringify(written, null, 1)}\n`);
  fs.chmodSync(file, READ_ONLY);
  return written;
}

/**
 * The fields of a record that name a folder or file and are not absolute, by name. Every
 * path a record holds is read by a later run, from whatever directory that run is started
 * in, so each is turned absolute where it enters (src/cli.js realFolder) - and checked here,
 * where a missed conversion would otherwise be written down for good. The folder flags are
 * the `*-dir` ones, the only folder flags a preparation forwards. An empty value names no
 * path, and is the record's "missing" (src/cli.js RECORD_FIELDS), not a relative one.
 * @param {PrepareRecord} record
 * @returns {string[]}
 */
function relativeFolders(record) {
  const named = [
    ["submission.xpi", record.submission?.xpi],
    ["roots.scaRoot", record.roots?.scaRoot],
    ["roots.scaExpSource", record.roots?.scaExpSource],
    ["original.work", record.original?.work],
    ["original.scaRoot", record.original?.scaRoot],
    ["rescued", record.rescued],
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
 * The hash over a record's fields, in the order they are written: what writePrepare stores
 * as `digest` and readPrepare checks the record against.
 * @param {object} body  The record without its `digest`.
 * @returns {string}
 */
function recordDigest(body) {
  return rawSha256(JSON.stringify(body));
}

/**
 * Move a folder on to a step its agent is no longer handed a review file at: `handed` or
 * `done`. The record is written FIRST and the review file deleted after, so a
 * run cut short in between leaves a folder already at its new step, and the next hand-back
 * of it deletes the file again. The review file has to go: the review that starts in a
 * `done` folder claims that name for its own (src/pipeline.js), and refuses a folder where
 * it is taken.
 * @param {string} work
 * @param {PrepareRecord} record  The record to write, at its new step.
 * @returns {PrepareRecord}  The record as written.
 */
export function markPrepare(work, record) {
  const written = writePrepare(work, record);
  fs.rmSync(workPaths(work).review, { force: true });
  return written;
}

/** The root files that say what a source archive installs: package.json and the locks. */
const PACKAGE_FILES = [PACKAGE_FILE, ...TREE_LOCKS];

/**
 * The package files of the root a rescued copy was made from, as the lock reader takes an
 * artifact (`files`, src/vendor/locks.js lockedPackages): what the developer submitted,
 * beside which the rescued copy's own are compared (sca-dependencies-changed).
 *
 * Null for a folder that is not a rescued copy. A root that is gone ends the review: the
 * report of a rescued review says what the rescue changed, and without the original there
 * is nothing to say it against.
 * @param {?PrepareRecord} record  The review's work folder's record.
 * @returns {?{files: Map<string, Buffer>}}
 */
export function originalPackages(record) {
  const root = record?.original?.scaRoot;
  if (!root) {
    return null;
  }
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      `The source root this rescued copy was made from is gone: ${root}. The review ` +
        "reports what the rescue changed against it, so it cannot start without it."
    );
  }
  const files = new Map();
  for (const name of PACKAGE_FILES) {
    const file = path.join(root, name);
    if (fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      files.set(name, fs.readFileSync(file));
    }
  }
  return { files };
}
