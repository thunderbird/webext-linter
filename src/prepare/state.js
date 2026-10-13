// The PREPARATION's record: prepare.json in a work folder, written by the run that creates the
// folder for a source code review, and by every hand-back of that folder after it - and read
// by those hand-backs and by the review that starts in the folder.
//
// The preparation runs in steps, and the agent following it hands back only the answers it
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
// One record per work folder, which is the whole run: the source is extracted into its `sca/`,
// a rescue copies that whole folder into `rescued/` beside it, and every build runs in a whole
// copy of one of the two in `build/`. The hand-back that finds the folder
// done starts its review from this record (src/cli.js), and that review reads it too
// (src/pipeline.js): a rescued review reads the package files of the root it was copied
// from, in `sca/`, to tell the developer the rescue changed them (originalPackages).
//
// Belongs here: the record's shape and version, reading and writing it, marking a folder at
// a step, where a root lies in each of the folders, and reading the package files of the root
// a rescue copied. Does NOT belong
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
import {
  BUILD_MATCH_VALUES,
  BUILD_SAFETY_VALUES,
} from "../checks/registry-vocabulary.js";

/** Bumped when the record's shape, or what a step does with it, changes in a way an older
 *  file cannot satisfy. A preparation in flight does not survive the upgrade, and saying so
 *  beats reading it wrongly. */
export const PREPARE_VERSION = 9;

/** The mode every write leaves the record at: readable, and writable by nobody. */
const READ_ONLY = 0o444;

/**
 * Where a preparation stands, which is what the next hand-back of the folder does:
 *
 * - `extract`: the source is to be extracted into `sca/`, its build reported in build.md,
 *   and its roots and the build judgement handed back in the review file. The next
 *   hand-back settles them, and moves a safe build on to `permission` (or, where
 *   the record holds agentBuilds, audits the root) and an unsafe one to `done`;
 * - `permission`: the reviewer is shown the Build Review Details and asked whether the
 *   agent may build, and the next hand-back reads the answer and audits the root where it
 *   may;
 * - `build`: the root's lock is clean, the linter copies `sca/` into `build/`, and the agent
 *   builds it there and names what the build produced and whether it matches the submitted
 *   XPI, or that it failed;
 * - `rescue`: the root's lock is vulnerable, and the agent makes the lock of the rescued copy
 *   in `rescued/` clean, builds a copy of it in `build/`, and names what the build produced
 *   and whether it matches the submitted XPI, or that the rescue failed. The next hand-back audits the copy and checks what it named;
 * - `done`: the review may start here, and the record holds the flags it starts with.
 *   A folder whose rescue failed is `done` too, its roots back in `sca/`.
 */
export const PREPARE_STEP = Object.freeze({
  extract: "extract",
  permission: "permission",
  build: "build",
  rescue: "rescue",
  done: "done",
});

/**
 * What came of the agent's build, as a done record holds it: `built` (the record names the
 * output), `failed` (the clean original did not build), or `rescue-failed` (the rescued copy
 * did not come out clean and built, and was deleted). A folder where the agent built nothing
 * holds none.
 */
export const BUILD_RESULT = Object.freeze({
  built: "built",
  failed: "failed",
  rescueFailed: "rescue-failed",
});

/** The severities a record counts the reviewed lock's vulnerable packages by. */
const COUNTED = ["moderate", "high", "critical"];

/**
 * @typedef {object} PrepareRecord
 * @property {number} version  PREPARE_VERSION.
 * @property {string} step  A PREPARE_STEP value.
 * @property {{xpi: string, experiments: boolean}} submission  The built add-on, absolute,
 *   and whether its manifest.json declares Experiments - which decides whether the roots
 *   include the Experiment folder.
 * @property {Record<string, string|boolean>} flags  The flags the review is to be run with,
 *   as parsed (src/cli.js), named without their dashes. A folder among them is absolute, so
 *   it names the same folder wherever the review starts.
 * @property {boolean} agentBuilds  Whether the hot runs answered the permission question up
 *   front (src/prepare/steps.js agentBuildsSwitchedOn), as the run that created the work
 *   folder read it. Not a flag, so the review never sees it.
 * @property {?string} buildSafety  The agent's judgement of the build it reported in
 *   build.md, a BUILD_SAFETY_VALUES id, as the first hand-back read it, and null before it.
 *   The review starts with it as its `build-safety` value.
 * @property {?boolean} packageManagers  Whether the agent may build the add-on and run its
 *   package-manager commands: the reviewer's answer to the permission question (true where
 *   `agentBuilds` answered it up front), false after an unsafe judgement, which asks
 *   nothing, and null before either. False, the preparation audits and rescues nothing,
 *   and the agent builds nothing.
 * @property {?import("./audit.js").VulnerabilityCounts} vulnerabilities  The lock the
 *   review reads, its vulnerable packages counted by severity as the linter's audit found
 *   them: the original's, or the rescued copy's once its rescue came out clean. Held from
 *   `build` and `rescue` on, and null where the lock was never audited or could not be
 *   read in full.
 * @property {?string} buildResult  A BUILD_RESULT value once the agent's build was handed
 *   back, and null where it built nothing.
 * @property {?string} buildOutput  What the build produced, a file or folder, absolute and
 *   real: inside `build/`. Held only where
 *   `buildResult` is `built`.
 * @property {?string} buildMatch  The agent's comparison of that output with the submitted
 *   XPI, a BUILD_MATCH_VALUES id. Held only where `buildResult` is `built`.
 * @property {?{scaRoot: string, scaExpSource: ?string}} roots  The settled roots, absolute
 *   and real, once known: inside `sca/`, or inside `rescued/` while a rescue runs and once it
 *   came out clean - the tree the next step, or the review, reads.
 * @property {string} digest  The hash over every other field, as writePrepare stored it
 *   (recordDigest). A record whose digest does not match was changed after it was written.
 *
 * Every boolean in the record - `submission.experiments`, `agentBuilds`, `packageManagers`, a
 * boolean flag - is `true` or `false`, which is all the linter writes. Anything else was put
 * there by an edit, and the record is refused rather than read (recordBoolean).
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
  if (!record.submission || typeof record.submission !== "object") {
    throw new HandbackRefused("the preparation's record names no submission");
  }
  recordBoolean(record.submission.experiments, "submission.experiments");
  recordBoolean(record.agentBuilds, "agentBuilds");
  // The judgement is unknown until the first hand-back reads it, and the permission until
  // the reviewer answered it or an unsafe judgement settled it.
  const before = record.step === PREPARE_STEP.extract;
  if (before ? record.buildSafety !== null : !isJudgement(record.buildSafety)) {
    throw new HandbackRefused(
      before
        ? "the preparation's record holds buildSafety before the agent judged the build"
        : "the preparation's record holds buildSafety as no judgement the agent can give"
    );
  }
  if (
    record.step === PREPARE_STEP.permission &&
    record.buildSafety !== "safe"
  ) {
    throw new HandbackRefused(
      "the preparation's record asks the reviewer about a build judged unsafe"
    );
  }
  if (before || record.step === PREPARE_STEP.permission) {
    if (record.packageManagers !== null) {
      throw new HandbackRefused(
        "the preparation's record holds packageManagers before the reviewer answered it"
      );
    }
  } else {
    recordBoolean(record.packageManagers, "packageManagers");
  }
  checkBuild(record, before || record.step === PREPARE_STEP.permission);
  return record;
}

/**
 * The record's audit counts, build result, output and comparison, each held only where the
 * record can know it, and each of the shape the linter writes. Anything else was put there by an edit.
 * @param {PrepareRecord} record
 * @param {boolean} unaudited  The record is at a step before any audit.
 * @throws {HandbackRefused}
 */
function checkBuild(record, unaudited) {
  const building =
    record.step === PREPARE_STEP.build || record.step === PREPARE_STEP.rescue;
  if (building && (record.buildSafety !== "safe" || !record.packageManagers)) {
    throw new HandbackRefused(
      "the preparation's record builds where the agent may not build"
    );
  }
  const counts = record.vulnerabilities;
  // Unknown before the audit, known while the agent builds, and either once done.
  const countsHold = unaudited
    ? counts === null
    : isCounts(counts) || (!building && counts === null);
  if (!countsHold) {
    throw new HandbackRefused(
      "the preparation's record holds vulnerabilities as no count the linter writes"
    );
  }
  const result = record.buildResult;
  const known = Object.values(BUILD_RESULT);
  const done = record.step === PREPARE_STEP.done;
  if (
    done
      ? result !== null && (!known.includes(result) || !record.packageManagers)
      : result !== null
  ) {
    throw new HandbackRefused(
      "the preparation's record holds buildResult as no result the linter writes"
    );
  }
  const output = record.buildOutput;
  if (
    result === BUILD_RESULT.built
      ? typeof output !== "string" || output === ""
      : output !== null
  ) {
    throw new HandbackRefused(
      "the preparation's record holds buildOutput without a build that produced it"
    );
  }
  const match = record.buildMatch;
  if (result !== BUILD_RESULT.built && match !== null) {
    throw new HandbackRefused(
      "the preparation's record holds buildMatch without a build that produced an output"
    );
  }
  if (result === BUILD_RESULT.built && !BUILD_MATCH_VALUES.includes(match)) {
    throw new HandbackRefused(
      match === null || match === undefined
        ? "the preparation's record holds a built result without buildMatch"
        : "the preparation's record holds buildMatch as no answer the agent can give"
    );
  }
}

/**
 * Whether `value` is a count by severity as the linter writes it: each COUNTED severity, a
 * whole number, and nothing else.
 * @param {unknown} value
 * @returns {boolean}
 */
function isCounts(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).length === COUNTED.length &&
    COUNTED.every((k) => Number.isInteger(value[k]) && value[k] >= 0)
  );
}

/**
 * Whether `value` is a judgement the agent can give the build.
 * @param {unknown} value
 * @returns {boolean}
 */
function isJudgement(value) {
  return BUILD_SAFETY_VALUES.includes(value);
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
 * @param {Pick<PrepareRecord, "submission" | "flags" | "agentBuilds">} known
 * @returns {PrepareRecord}
 */
export function startRecord({ submission, flags, agentBuilds }) {
  return {
    version: PREPARE_VERSION,
    step: PREPARE_STEP.extract,
    submission,
    flags,
    agentBuilds,
    buildSafety: null,
    packageManagers: null,
    roots: null,
    vulnerabilities: null,
    buildResult: null,
    buildOutput: null,
    buildMatch: null,
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
    ["buildOutput", record.buildOutput],
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
 * Move a folder on to `done`, where its agent is no longer handed a review file. The record is written FIRST and the review file deleted after, so a
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

/**
 * Where a root the record holds lies in the work folder's trees: inside `rescued/` while a
 * rescue runs and once it came out clean, else inside `sca/`. `scaRootOrig` is the same place
 * in `sca/` for a root in `rescued/`, and null for one in `sca/`, where it is that root itself.
 * `buildRoot` is the same place in `build/`, where every build runs, and null for a root in
 * neither tree.
 * @param {string} work  The work folder.
 * @param {string} root  The root, absolute and real.
 * @returns {{scaRootOrig: ?string, buildRoot: ?string}}
 */
export function treeRoots(work, root) {
  const paths = workPaths(work);
  const inside = (tree) => {
    if (!fs.existsSync(tree)) {
      return null;
    }
    const rel = path.relative(fs.realpathSync(tree), root);
    return rel.startsWith("..") || path.isAbsolute(rel) ? null : rel;
  };
  const rescued = inside(paths.rescued);
  const rel = rescued ?? inside(paths.sca);
  return {
    scaRootOrig: rescued === null ? null : path.join(paths.sca, rescued),
    buildRoot: rel === null ? null : path.join(paths.buildCopy, rel),
  };
}

/** The root files that say what a source archive installs: package.json and the locks. */
const PACKAGE_FILES = [PACKAGE_FILE, ...TREE_LOCKS];

/**
 * The package files of the root a rescued copy was made from, as the lock reader takes an
 * artifact (`files`, src/vendor/locks.js lockedPackages): what the developer submitted,
 * beside which the rescued copy's own are compared (sca-dependencies-changed).
 *
 * A review whose root lies in the work folder's `rescued/` reviews the copy, and the root it
 * was copied from is the same place in `sca/`. Null for every other review. A root that is
 * gone ends the review: the report of a rescued review says what the rescue changed, and
 * without the original there is nothing to say it against.
 * @param {string} work  The review's work folder.
 * @param {?PrepareRecord} record  Its record.
 * @returns {?{files: Map<string, Buffer>}}
 */
export function originalPackages(work, record) {
  const reviewed = record?.roots?.scaRoot;
  const root = reviewed ? treeRoots(work, reviewed).scaRootOrig : null;
  if (root === null) {
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
