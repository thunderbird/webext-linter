// The BUILD CHECK's part of the review's record: the record in mode `build-check`
// (src/review/record.js), written by the run that starts the build check of a source review
// and by every hand-back of that folder after it, and read by those hand-backs and by the
// review that starts in the folder once the build check is done.
//
// The build check runs in steps, and the agent following it hands back only the answers it
// worked out (src/build-check/steps.js). So everything a later step needs - which folders were
// settled, where the build check stands, what the reviewer decided - is recorded by the
// linter and read back by the next run, never taken from the agent. No prompt names the
// record.
//
// One record per work folder, which is the whole run: the source is in its `sca/`,
// a rescue copies that whole folder into `rescued/` beside it, and every build runs in a whole
// copy of one of the two in `build/`. The hand-back that finds the folder done starts its
// review from this record (src/cli.js), adding the build results to its permanent part
// (buildResults), which that review reads (src/pipeline.js, src/report/loop.js): a
// rescued review reads the package files of the package root it was copied from, in `sca/`,
// to tell the developer the rescue changed them (originalPackages).
//
// Belongs here: the build check's own part of the record, its shape, marking a folder done,
// the build results it adds to the record's permanent part once done, where a package root
// lies in each of the folders, and reading the package files of the package root a rescue
// copied. Does NOT belong here: reading and writing the record and its two parts
// (-> src/review/record.js), what each step does and when
// the record moves on (-> ./steps.js), the audit that decides it (-> ./audit.js), the folder's
// names (-> src/util/dest.js workPaths), or how a prompt is printed (-> src/report/format.js).

import fs from "node:fs";
import path from "node:path";

import { workPaths } from "../util/dest.js";
import { writeRecord } from "../review/record.js";
import { PACKAGE_FILE } from "../vendor/package-file.js";
import { TREE_LOCKS } from "../vendor/locks.js";
import { checkedNote } from "../report/verdicts.js";
import { recordError } from "../lib/errors.js";
import {
  BUILD_MATCH_VALUES,
  BUILD_SAFETY_VALUES,
} from "../checks/registry-vocabulary.js";

/**
 * Where a build check stands, which is what the next hand-back of the folder does:
 *
 * - `analyze`: the folders are known, in `sca/`, and the build is to be reported in build.md,
 *   with the build's issues handed back in the answers file. Every build check starts here,
 *   once the early-exit checks passed on the source in `sca/`. The next hand-back moves to
 *   `done` where a build-guard check is switched off. Otherwise it audits the package root's
 *   lock, and moves to `done` where the agent may build nothing from it, else either verdict
 *   on to `decision` (or, where the hot runs switched the agent's builds on, decides for the
 *   reviewer);
 * - `decision`: the reviewer is shown the Build Review Details and asked for the build
 *   decision, and the next hand-back reads it and, where the agent may build, goes on by the
 *   audit at `analyze`;
 * - `build`: the package root's lock is clean, the linter copies `sca/` into `build/`, and
 *   the agent builds it there and names what the build produced and whether it matches the
 *   submitted XPI, or that it failed;
 * - `rescue`: the package root's lock is vulnerable, and the agent makes the lock of the
 *   rescued copy in `rescued/` clean, builds a copy of it in `build/`, and names what the
 *   build produced and whether it matches the submitted XPI, or that the rescue failed. The
 *   next hand-back audits the copy and checks what it named;
 * - `done`: the review may start here. A folder whose rescue failed is `done` too, its
 *   roots back in `sca/`. A review start that failed leaves the folder here, and the next
 *   hand-back starts it again.
 */
export const BUILD_CHECK_STEP = Object.freeze({
  analyze: "analyze",
  decision: "decision",
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
 * The build check's own part of the record, its current part in mode `build-check`
 * (src/review/record.js), beside the permanent part every mode reads: the submission, whose
 * `experiments` decides whether the roots include the Experiment folder, the flags, and
 * the folders the submission is made of.
 * @typedef {object} BuildCheckPart
 * @property {"build-check"} mode
 * @property {string} step  A BUILD_CHECK_STEP value.
 * @property {?{file: string, line: ?number, hint: string}[]} buildIssues  What the build
 *   reaches for outside the declared dependencies, as the `analyze` hand-back read it, each
 *   at its file relative to the extracted archive (`sca/`), and null before it. Also in the
 *   work folder's build-issues.md, which the review links, and reported by build-unsafe where
 *   the reviewer trusts the verdict.
 * @property {?string} buildSafety  The verdict read off `buildIssues`, a BUILD_SAFETY_VALUES
 *   id, unsafe where it holds an entry, and null before it.
 *   The review starts with it as its build's judgement (state.build.safety).
 * @property {?boolean} buildSafe  The reviewer's one decision about the build, at the
 *   decision question: whether it is safe, the agent's verdict as they kept or overrode
 *   it (the hot runs' switch answering for them, src/build-check/steps.js
 *   agentBuildsSwitchedOn). Null before it, and where a build-guard check
 *   is switched off or the audit found nothing the agent may build, which asks nothing. The review reads it as its `build-judged` and
 *   `build-safe` facts.
 * @property {?string} buildReasons  The reviewer's own words for holding the build unsafe,
 *   where they answered the question with them, which build-unsafe reports. Held only
 *   where `buildSafe` is false.
 * @property {?boolean} packageManagers  Whether the agent may build the add-on and run its
 *   package-manager commands: true where the reviewer let it (`allow` or `override`), false
 *   for any other answer and where nothing was asked, and null before either. False, the
 *   build check audits and rescues nothing, and the agent builds nothing.
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
 *   real: inside `build/`. Held only where `buildResult` is `built`.
 * @property {?string} buildMatch  The agent's comparison of that output with the submitted
 *   XPI, a BUILD_MATCH_VALUES id. Held only where `buildResult` is `built`.
 * @property {import("../addon/package-root.js").ScaFolders} roots  The settled folders,
 *   absolute and real: the source copy `sca/`, the tree the next step or the review reads
 *   (`used`: `sca/`, or `rescued/` while a rescue runs and once it came out clean), and the
 *   package root and the Experiment folder inside that tree. The Experiment folder is there
 *   exactly when the add-on declares Experiments (checkRoots).
 *
 * Every boolean in the record - `submission.experiments`, `packageManagers`, a
 * boolean flag - is `true` or `false`, which is all the linter writes. Anything else was put
 * there by an edit, and the record is a failure rather than read (recordBoolean).
 */

/**
 * Check a record in mode `build-check` for the shape the linter writes at its step: its
 * current part, the build check's own, against the submission its permanent part names
 * (src/review/record.js readRecord).
 * @param {object} record  In mode build-check.
 * @throws {Error}
 */
export function checkBuildCheck(record) {
  const check = record.current;
  if (!Object.values(BUILD_CHECK_STEP).includes(check.step)) {
    throw new Error("The build check's record names no step this tool knows");
  }
  // The judgement is unknown until the `analyze` hand-back reads it, and the decision until
  // the reviewer answered it or an unsafe judgement settled it.
  const before = check.step === BUILD_CHECK_STEP.analyze;
  if (
    before
      ? check.buildSafety !== null || check.buildIssues !== null
      : !isJudgement(check.buildSafety) ||
        !isIssueList(check.buildIssues) ||
        check.buildSafety !== (check.buildIssues.length ? "unsafe" : "safe")
  ) {
    throw recordError(
      before
        ? "the build check's record holds buildSafety before the agent judged the build"
        : "the build check's record holds buildSafety as no verdict its buildIssues give"
    );
  }
  if (before || check.step === BUILD_CHECK_STEP.decision) {
    for (const key of ["packageManagers", "buildSafe", "buildReasons"]) {
      if (check[key] !== null) {
        throw recordError(
          `the build check's record holds ${key} before the reviewer answered it`
        );
      }
    }
  } else {
    recordBoolean(check.packageManagers, "packageManagers");
    checkDecision(check);
  }
  checkBuild(check, before);
  checkRoots(check, record.submission.experiments);
}

/**
 * The record's folders, of the shape the linter writes: the source copy, the tree the review
 * reads and the package root, and the Experiment folder exactly where the add-on declares
 * Experiments.
 * @param {object} check  The build check's own part (the record's `current`).
 * @param {boolean} experiments  Whether the add-on declares Experiments.
 * @throws {Error}
 */
function checkRoots(check, experiments) {
  const roots = check.roots;
  const keys = roots && typeof roots === "object" ? Object.keys(roots) : [];
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
    throw recordError(
      "the build check's record holds no source copy, reviewed copy and package root of the shape the linter writes"
    );
  }
  const named = keys.includes("experiments");
  if (named !== experiments) {
    throw recordError(
      named
        ? "the build check's record names an Experiment folder for an add-on without Experiments"
        : "the build check's record names no Experiment folder for an add-on with Experiments"
    );
  }
}

/**
 * The reviewer's build decision, as the decision step writes it: a boolean, or null where
 * nothing was asked, which lets nobody build. The agent builds only a build held safe, and
 * reasons come only with one held unsafe, as words a reviewer could have typed.
 * @param {object} check  The build check's own part (the record's `current`), past the
 *   decision step.
 * @throws {Error}
 */
function checkDecision(check) {
  const safe = check.buildSafe;
  if (safe !== null && typeof safe !== "boolean") {
    throw recordError(
      "the build check's record holds buildSafe as neither true, false nor null"
    );
  }
  if (check.packageManagers && safe !== true) {
    throw recordError(
      "the build check's record lets the agent build a build not held safe"
    );
  }
  const reasons = check.buildReasons;
  if (reasons === null) {
    return;
  }
  if (safe !== false || checkedNote(reasons).problem) {
    throw recordError(
      "the build check's record holds buildReasons the reviewer could not have given"
    );
  }
}

/**
 * The record's audit counts, build result, output and comparison, each held only where the
 * record can know it, and each of the shape the linter writes. Anything else was put there
 * by an edit.
 * @param {object} check  The build check's own part (the record's `current`).
 * @param {boolean} unaudited  The record is at a step before any audit.
 * @throws {Error}
 */
function checkBuild(check, unaudited) {
  const building =
    check.step === BUILD_CHECK_STEP.build ||
    check.step === BUILD_CHECK_STEP.rescue;
  if (building && (check.buildSafe !== true || !check.packageManagers)) {
    throw recordError(
      "the build check's record builds where the agent may not build"
    );
  }
  const counts = check.vulnerabilities;
  // Unknown before the audit, known at the decision and while the agent builds, since only a
  // lock the audit read in full gets there, and either once done.
  const asked = building || check.step === BUILD_CHECK_STEP.decision;
  const countsHold = unaudited
    ? counts === null
    : isCounts(counts) || (!asked && counts === null);
  if (!countsHold) {
    throw recordError(
      "the build check's record holds vulnerabilities as no count the linter writes"
    );
  }
  const result = check.buildResult;
  const known = Object.values(BUILD_RESULT);
  const done = check.step === BUILD_CHECK_STEP.done;
  // Counted only at a rescue's hand-back, which leaves the folder done with a result, and
  // only beside the submitted lock's own count.
  const rescued = check.rescuedVulnerabilities;
  const rescuedHold =
    rescued === null ||
    (done && result !== null && isCounts(counts) && isCounts(rescued));
  if (!rescuedHold) {
    throw recordError(
      "the build check's record holds rescuedVulnerabilities as no count the linter writes"
    );
  }
  if (
    done
      ? result !== null && (!known.includes(result) || !check.packageManagers)
      : result !== null
  ) {
    throw recordError(
      "the build check's record holds buildResult as no result the linter writes"
    );
  }
  const output = check.buildOutput;
  if (
    result === BUILD_RESULT.built
      ? typeof output !== "string" || output === ""
      : output !== null
  ) {
    throw recordError(
      "the build check's record holds buildOutput without a build that produced it"
    );
  }
  const match = check.buildMatch;
  if (result !== BUILD_RESULT.built && match !== null) {
    throw recordError(
      "the build check's record holds buildMatch without a build that produced an output"
    );
  }
  if (result === BUILD_RESULT.built && !BUILD_MATCH_VALUES.includes(match)) {
    throw recordError(
      match === null || match === undefined
        ? "the build check's record holds a built result without buildMatch"
        : "the build check's record holds buildMatch as no answer the agent can give"
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
 * A boolean read from the review's record: `true` or `false`, which is all the linter
 * writes. Anything else - a string, a number, null, nothing - was put there by an edit, and
 * guessing what it meant would let the edit decide, so the record is a failure
 * (recordError), which the agent cannot repair.
 * @param {unknown} value
 * @param {string} what  How the failure names it.
 * @returns {boolean}
 * @throws {Error}
 */
export function recordBoolean(value, what) {
  if (value !== true && value !== false) {
    throw recordError(
      `the review's record holds ${what} as neither true nor false`
    );
  }
  return value;
}

/**
 * The build check's own part as it starts, at `analyze` (src/review/record.js startMode): the
 * folders settled in `sca/`, and every slot a later step fills still empty.
 * @param {import("../addon/package-root.js").ScaFolders} roots
 * @returns {object}
 */
export function buildCheckBody(roots) {
  return {
    buildIssues: null,
    buildSafety: null,
    buildSafe: null,
    buildReasons: null,
    packageManagers: null,
    roots,
    vulnerabilities: null,
    rescuedVulnerabilities: null,
    buildResult: null,
    buildOutput: null,
    buildMatch: null,
  };
}

/**
 * The build results a done build check adds to the record's permanent part before its review
 * starts (src/review/record.js addToRecord), which the review and its checks read from there:
 * the verdict and the issues it rests on, the reviewer's build decision, what came of the
 * agent's build, the vulnerability counts, and the source folders the review reads (`roots`:
 * the tree in `sca/` or the rescued copy, its package root and Experiment folder). The build
 * copy is named where the agent built in it.
 * @param {string} work  The work folder.
 * @param {BuildCheckPart} check  The build check's own part, at `done`.
 * @returns {object}  The `build` fact.
 */
export function buildResults(work, check) {
  const built =
    check.buildResult === BUILD_RESULT.built ||
    check.buildResult === BUILD_RESULT.failed;
  return {
    safety: check.buildSafety,
    issues: check.buildIssues,
    safe: check.buildSafe,
    reasons: check.buildReasons,
    packageManagers: check.packageManagers,
    result: check.buildResult,
    ...(built ? { copy: workPaths(work).buildCopy } : {}),
    output: check.buildOutput,
    match: check.buildMatch,
    vulnerabilities: check.vulnerabilities,
    rescuedVulnerabilities: check.rescuedVulnerabilities,
    roots: check.roots,
  };
}

/**
 * Move a folder on to `done`, where its agent is no longer handed an answers file. The record
 * is written FIRST and the answers file deleted after, so a run cut short in between leaves a
 * folder already at its new step, and the next hand-back of it deletes the file again. The
 * answers file holds the build check's last entries, which no prompt names once the folder is
 * done: the review's first phase writes its own, and a review that closes at once writes none,
 * so a file left there would only be a stale one the agent might answer.
 * @param {string} work
 * @param {BuildCheckPart} record  The record to write, at its new step.
 * @returns {BuildCheckPart}  The record as written.
 */
export function markDone(work, record) {
  const written = writeRecord(work, record);
  fs.rmSync(workPaths(work).answers, { force: true });
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
