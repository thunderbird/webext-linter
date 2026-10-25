// The PREPARATION's record: prepare.json in a work folder, written by the run that creates the
// folder for a source code review, and by every hand-back of that folder after it - and read
// by those hand-backs and by the review that starts in the folder.
//
// The preparation runs in steps, and the agent following it hands back only the answers it
// worked out (src/prepare/steps.js). So everything a later step needs - which submission
// this is, how its review is to be run, which folders were settled, where the preparation
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
// One record per work folder, which is the whole run: the source is in its `sca/`,
// a rescue copies that whole folder into `rescued/` beside it, and every build runs in a whole
// copy of one of the two in `build/`. The hand-back that finds the folder
// done starts its review from this record (src/cli.js), and that review reads it too
// (src/pipeline.js): a rescued review reads the package files of the package root it was
// copied from, in `sca/`, to tell the developer the rescue changed them (originalPackages).
//
// Belongs here: the record's shape, reading and writing it, marking a folder at a step, where
// a package root lies in each of the folders, and reading the package files of the package
// root a rescue copied. Does NOT belong here: what each step does and when the record moves
// on (-> ./steps.js), the audit that decides it (-> ./audit.js), the folder's names
// (-> src/util/dest.js workPaths), or how a prompt is printed (-> src/report/format.js).

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
import { checkedNote } from "../report/verdicts.js";
import {
  BUILD_MATCH_VALUES,
  BUILD_SAFETY_VALUES,
} from "../checks/registry-vocabulary.js";

/** The mode every write leaves the record at: readable, and writable by nobody. */
const READ_ONLY = 0o444;

/**
 * Where a preparation stands, which is what the next hand-back of the folder does:
 *
 * - `unpack`: the source archive is to be extracted into `sca/` (--llm-auto-review only), and the
 *   Experiment folder in it named where the add-on declares Experiments. The next hand-back
 *   derives the package root inside it (src/addon/package-root.js) and moves on to `analyze`;
 * - `analyze`: the folders are known, in `sca/`, and the build is to be reported in build.md,
 *   with the build's issues handed back in the review file. A review given
 *   --sca-extracted starts here, its source copied into `sca/`. The next hand-back moves
 *   either verdict on to `permission` (or, where the record holds agentBuilds, decides for
 *   the reviewer), and to `done` where a build-guard check is switched off;
 * - `permission`: the reviewer is shown the Build Review Details and asked for the build
 *   decision, and the next hand-back reads it and audits the package root's lock where the
 *   agent may build;
 * - `build`: the package root's lock is clean, the linter copies `sca/` into `build/`, and
 *   the agent builds it there and names what the build produced and whether it matches the
 *   submitted XPI, or that it failed;
 * - `rescue`: the package root's lock is vulnerable, and the agent makes the lock of the
 *   rescued copy in `rescued/` clean, builds a copy of it in `build/`, and names what the
 *   build produced and whether it matches the submitted XPI, or that the rescue failed. The
 *   next hand-back audits the copy and checks what it named;
 * - `done`: the review may start here, and the record holds the flags it starts with.
 *   A folder whose rescue failed is `done` too, its roots back in `sca/`.
 */
export const PREPARE_STEP = Object.freeze({
  unpack: "unpack",
  analyze: "analyze",
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

/** The severities a record counts a lock's vulnerable packages by. */
const COUNTED = ["moderate", "high", "critical"];

/**
 * @typedef {object} PrepareRecord
 * @property {string} step  A PREPARE_STEP value.
 * @property {{xpi: string, experiments: boolean,
 *   verification?: ?import("../experiments/verify.js").ExperimentVerification}} submission
 *   The built add-on, absolute, whether its manifest.json declares Experiments - which
 *   decides whether the roots include the Experiment folder - and the Experiment verdict the
 *   load reached (src/review/start.js loadTheXpi), null for an add-on that declares none,
 *   which the review the preparation starts takes as its own.
 * @property {Record<string, string|boolean>} flags  The flags the review is to be run with,
 *   as parsed (src/cli.js), named without their dashes. A folder among them is absolute, so
 *   it names the same folder wherever the review starts.
 * @property {boolean} agentBuilds  Whether the hot runs answered the permission question up
 *   front (src/prepare/steps.js agentBuildsSwitchedOn), as the run that created the work
 *   folder read it. Not a flag, so the review never sees it.
 * @property {?{file: string, line: ?number, hint: string}[]} buildIssues  What the build
 *   reaches for outside the declared dependencies, as the `analyze` hand-back read it, each
 *   at its file relative to the extracted archive (`sca/`), and null before it. Also in the
 *   work folder's build-issues.md, which the review links, and reported by build-unsafe where the reviewer
 *   trusts the verdict.
 * @property {?string} buildSafety  The verdict read off `buildIssues`, a BUILD_SAFETY_VALUES
 *   id, unsafe where it holds an entry, and null before it.
 *   The review starts with it as its build's judgement (state.build.safety).
 * @property {?boolean} buildSafe  The reviewer's one decision about the build, at the
 *   permission question: whether it is safe, the agent's verdict as they kept or overrode
 *   it (`agentBuilds` answering for them). Null before it, and where a build-guard check
 *   is switched off, which asks nothing. The review reads it as its `build-judged` and
 *   `build-safe` facts.
 * @property {?string} buildReasons  The reviewer's own words for holding the build unsafe,
 *   where they answered the question with them, which build-unsafe reports. Held only
 *   where `buildSafe` is false.
 * @property {?boolean} packageManagers  Whether the agent may build the add-on and run its
 *   package-manager commands: true where the reviewer let it (`allow` or `override`), false
 *   for any other answer and where nothing was asked, and null before either. False, the
 *   preparation audits and rescues nothing, and the agent builds nothing.
 * @property {?import("./audit.js").VulnerabilityCounts} vulnerabilities  The submitted
 *   lock's vulnerable packages, counted by severity as the linter's first audit found them.
 *   Held from `build` and `rescue` on, never replaced, and null where the lock was never
 *   audited or could not be read in full.
 * @property {?import("./audit.js").VulnerabilityCounts} rescuedVulnerabilities  The rescued
 *   copy's lock, counted the same way by the audit at the rescue's hand-back, whether the
 *   rescue came out clean or failed. Held only in a done record whose rescue was attempted,
 *   and null where no rescue was attempted or the copy's lock could not be read in full.
 * @property {?string} buildResult  A BUILD_RESULT value once the agent's build was handed
 *   back, and null where it built nothing.
 * @property {?string} buildOutput  What the build produced, a file or folder, absolute and
 *   real: inside `build/`. Held only where
 *   `buildResult` is `built`.
 * @property {?string} buildMatch  The agent's comparison of that output with the submitted
 *   XPI, a BUILD_MATCH_VALUES id. Held only where `buildResult` is `built`.
 * @property {import("../addon/package-root.js").ScaFolders} [roots]  The settled folders,
 *   absolute and real, there from `analyze` on: the source copy `sca/`, the tree the next step
 *   or the review reads (`used`: `sca/`, or `rescued/` while a rescue runs and once it came out
 *   clean), and the package root and the Experiment folder inside that tree. The Experiment
 *   folder is there exactly when the add-on declares Experiments (checkRoots).
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
  // The judgement is unknown until the `analyze` hand-back reads it, and the permission until
  // the reviewer answered it or an unsafe judgement settled it.
  const before =
    record.step === PREPARE_STEP.unpack || record.step === PREPARE_STEP.analyze;
  if (
    before
      ? record.buildSafety !== null || record.buildIssues !== null
      : !isJudgement(record.buildSafety) ||
        !isIssueList(record.buildIssues) ||
        record.buildSafety !== (record.buildIssues.length ? "unsafe" : "safe")
  ) {
    throw new HandbackRefused(
      before
        ? "the preparation's record holds buildSafety before the agent judged the build"
        : "the preparation's record holds buildSafety as no verdict its buildIssues give"
    );
  }
  if (before || record.step === PREPARE_STEP.permission) {
    for (const key of ["packageManagers", "buildSafe", "buildReasons"]) {
      if (record[key] !== null) {
        throw new HandbackRefused(
          `the preparation's record holds ${key} before the reviewer answered it`
        );
      }
    }
  } else {
    recordBoolean(record.packageManagers, "packageManagers");
    checkDecision(record);
  }
  checkBuild(record, before || record.step === PREPARE_STEP.permission);
  checkRoots(record);
  return record;
}

/**
 * The record's folders, of the shape the linter writes: none before `analyze`, then the
 * source copy, the tree the review reads and the package root, and the Experiment folder
 * exactly where the add-on declares Experiments.
 * @param {PrepareRecord} record
 * @throws {HandbackRefused}
 */
function checkRoots(record) {
  const has = Object.hasOwn(record, "roots");
  if (record.step === PREPARE_STEP.unpack) {
    if (has) {
      throw new HandbackRefused(
        "the preparation's record holds folders before the archive was extracted"
      );
    }
    return;
  }
  const roots = record.roots;
  const keys =
    has && roots && typeof roots === "object" ? Object.keys(roots) : [];
  const folder = (key) => typeof roots?.[key] === "string" && roots[key] !== "";
  const shaped =
    folder("source") &&
    folder("used") &&
    folder("packageRoot") &&
    keys.every((k) =>
      ["source", "used", "packageRoot", "experiments"].includes(k)
    ) &&
    (!keys.includes("experiments") || folder("experiments"));
  if (!shaped) {
    throw new HandbackRefused(
      "the preparation's record holds no source copy, reviewed copy and package root of the shape the linter writes"
    );
  }
  const named = keys.includes("experiments");
  if (named !== record.submission.experiments) {
    throw new HandbackRefused(
      named
        ? "the preparation's record names an Experiment folder for an add-on without Experiments"
        : "the preparation's record names no Experiment folder for an add-on with Experiments"
    );
  }
}

/**
 * The reviewer's build decision, as the permission step writes it: a boolean, or null where
 * nothing was asked, which lets nobody build. The agent builds only a build held safe, and
 * reasons come only with one held unsafe, as words a reviewer could have typed.
 * @param {PrepareRecord} record  Past the permission step.
 * @throws {HandbackRefused}
 */
function checkDecision(record) {
  const safe = record.buildSafe;
  if (safe !== null && typeof safe !== "boolean") {
    throw new HandbackRefused(
      "the preparation's record holds buildSafe as neither true, false nor null"
    );
  }
  if (record.packageManagers && safe !== true) {
    throw new HandbackRefused(
      "the preparation's record lets the agent build a build not held safe"
    );
  }
  const reasons = record.buildReasons;
  if (reasons === null) {
    return;
  }
  if (safe !== false || checkedNote(reasons).problem) {
    throw new HandbackRefused(
      "the preparation's record holds buildReasons the reviewer could not have given"
    );
  }
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
  if (building && (record.buildSafe !== true || !record.packageManagers)) {
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
  // Counted only at a rescue's hand-back, which leaves the folder done with a result, and
  // only beside the submitted lock's own count.
  const rescued = record.rescuedVulnerabilities;
  const rescuedHold =
    rescued === null ||
    (done && result !== null && isCounts(counts) && isCounts(rescued));
  if (!rescuedHold) {
    throw new HandbackRefused(
      "the preparation's record holds rescuedVulnerabilities as no count the linter writes"
    );
  }
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
 * Whether a value is a list of build issues as the `analyze` hand-back records them: each a
 * file, a whole line from 1 or none, and a hint.
 * @param {*} value
 * @returns {boolean}
 */
function isIssueList(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (issue) =>
        issue !== null &&
        typeof issue === "object" &&
        typeof issue.file === "string" &&
        issue.file !== "" &&
        (issue.line === null ||
          (Number.isInteger(issue.line) && issue.line >= 1)) &&
        typeof issue.hint === "string" &&
        issue.hint !== ""
    )
  );
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
 * The record of a preparation that has not started, with what the run that created the work
 * folder alone knows. Without folders it starts at `unpack` (--llm-auto-review, whose agent
 * extracts the source); with them at `analyze` (a review given --sca-extracted, whose source the
 * linter copied into `sca/`).
 * @param {Pick<PrepareRecord, "submission" | "flags" | "agentBuilds" | "roots">} known
 * @returns {PrepareRecord}
 */
export function startRecord({ submission, flags, agentBuilds, roots }) {
  return {
    step: roots ? PREPARE_STEP.analyze : PREPARE_STEP.unpack,
    submission,
    flags,
    agentBuilds,
    buildIssues: null,
    buildSafety: null,
    buildSafe: null,
    buildReasons: null,
    packageManagers: null,
    ...(roots ? { roots } : {}),
    vulnerabilities: null,
    rescuedVulnerabilities: null,
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
    ...Object.entries(record.roots ?? {}).map(([key, value]) => [
      `roots.${key}`,
      value,
    ]),
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
 * The package root's place in the work folder's `build/`, where every build runs: the same
 * place in that copy as in the tree the review reads.
 * @param {string} work  The work folder.
 * @param {import("../addon/package-root.js").ScaFolders} roots
 * @returns {string}
 */
export function buildRootOf(work, roots) {
  return path.join(
    workPaths(work).buildCopy,
    path.relative(roots.used, roots.packageRoot)
  );
}

/** The package root's files that say what a source archive installs: package.json and the locks. */
const PACKAGE_FILES = [PACKAGE_FILE, ...TREE_LOCKS];

/**
 * The package files of the package root a rescued copy was made from, as the lock reader takes an
 * artifact (`files`, src/vendor/locks.js lockedPackages): what the developer submitted,
 * beside which the rescued copy's own are compared (sca-dependencies-changed).
 *
 * A review that reads a rescued copy (`used` is not `source`) has its package root in that
 * copy, and the folder it was copied from is the same place in `source`. Null for every other
 * review. One that is gone ends the review: the report of a rescued review says what the
 * rescue changed, and without the original there is nothing to say it against.
 * @param {import("../addon/package-root.js").ScaFolders} folders  The review's.
 * @returns {?{files: Map<string, Buffer>}}
 */
export function originalPackages(folders) {
  if (folders.used === folders.source) {
    return null;
  }
  const root = path.join(
    folders.source,
    path.relative(folders.used, folders.packageRoot)
  );
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      `The package root this rescued copy was made from is gone: ${root}. The review ` +
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
