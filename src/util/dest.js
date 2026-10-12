// The naming convention for what a review puts on disk: the WORK FOLDER every file of one
// review lives in, and the bare name each of those files has inside it. One folder per
// review, so a review is something a reviewer can open, archive or delete as one thing,
// and the names inside it are the same in every review, so a prompt, a test and a person
// looking at the folder all find a file where the last one was.
//
// A command-line review always starts in the folder named here: what the submission is
// called, and the moment the review began, beside the add-on argument - no flag names
// another, and only --llm-handback names one that exists (src/cli.js). The submission's name is read back off the
// path rather than off the manifest.json, which is submission data of any shape - see
// submissionLeaf.
//
// Belongs here: the default folder, the stamp that makes it unique, the submission's name
// it is built from, the folder a rescued copy is made in, and the bare names inside it
// (workPaths). Does NOT belong here: writing
// anything there, or deciding which of those names a run may create (src/pipeline.js claims
// them when a review starts, and src/cli.js creates the folder a source code review is
// prepared in).

import path from "node:path";

/** A moment, spelled so it can sit in a filename: no colons, no dots. */
export function pathStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * What the submission is CALLED: the last segment of the path a run was given, without the
 * `.xpi` it was packed as.
 *
 * An unpacked submission has no extension to remove and keeps the name its folder has.
 * @param {string} p  A path, absolute or not.
 * @returns {string}  Its leaf name, never a path.
 */
export function submissionLeaf(p) {
  return path.basename(p).replace(/\.xpi$/, "");
}

/**
 * The work folder a review starts in: `<name>-<stamp>`, beside the add-on argument.
 *
 * Beside it, because that is the folder the reviewer downloaded the submission into and is
 * working out of: what they are handed opens where they are looking. For an unpacked
 * submission it is the folder holding it, for the same reason, and never inside what is
 * being reviewed.
 *
 * The submission's name does not identify a review - the same file can be reviewed twice in
 * a session, and a fork carries the name of what it forked - so the run's own moment
 * separates them, and a later run does not open what an earlier one left behind.
 * Millisecond resolution, which separates reviews a person runs. Two started in the same
 * millisecond would name one folder, and the second is then refused because the folder
 * already exists (src/cli.js), rather than writing into the first.
 *
 * Escaped, though a leaf cannot contain a separator and so cannot escape a directory:
 * `My Add-on 1.0.xpi` is an ordinary name, and anything outside [A-Za-z0-9._@-] can still
 * upset a shell.
 * @param {string} addonPath  The add-on argument, absolute.
 * @returns {string}
 */
export function defaultWorkFolder(addonPath) {
  const name = `${submissionLeaf(addonPath)}-${pathStamp()}`.replace(
    /[^A-Za-z0-9._@-]/g,
    "_"
  );
  return path.join(path.dirname(addonPath), name);
}

/**
 * Where one RUN of a review keeps what it caches: a dot folder in its work folder. Every
 * invocation of the run - the preparation's hand-backs and the review - works in that one
 * folder, so they all find the same cache. Not one of workPaths' names: a run claims those
 * afresh, while this one is there to be found again by every invocation of the run.
 * @param {string} work  The work folder, absolute.
 * @returns {{dir: string, osv: string}}  The folder, and OSV's answers in it
 *   (src/vendor/osv-cache.js).
 */
export function runCache(work) {
  const dir = path.join(work, ".cache");
  return { dir, osv: path.join(dir, "osv.json") };
}

/**
 * Every name a review uses inside its work folder, as absolute paths.
 *
 * - `xpi`, the shipped add-on, extracted or copied there by the linter (src/addon/load.js),
 *   so every reader - the checks, a reviewer, an agent - reads one unpacked tree.
 * - `sca`, where the source archive is extracted when the review is prepared. An INPUT to
 *   the review, never written by it.
 * - `rescued`, the preparation's copy of that source, made where its lock needs a rescue
 *   (src/prepare/steps.js). An input like `sca`: the review reads it when the rescue came
 *   out clean, and never writes it.
 * - `prepare`, reserved for the preparation of a source code review. An input like `sca`,
 *   so no review claims it.
 * - `state`, the linter's own record of the review, and `review`, the file it hands the
 *   agent one phase at a time. A pass is handed back with the work folder (--llm-handback,
 *   src/cli.js), and finds both in it by these names.
 * - `report`, the text the reviewer sends to the developer. The one document the linter
 *   writes itself (src/report/report-file.js).
 * - `summary`, where a sub-agent writes the add-on description, and `build`, where the
 *   agent writes what building it takes (the build-safety phase). `buildDiff` is where the
 *   build phase's agent writes the difference between its build and the shipped XPI, and
 *   `buildCopy` the copy of the source archive it builds in, never the archive itself, which
 *   the reviewer and the other agents read as submitted.
 * - `sweep`, one sweeping agent's request and answers, per artifact it is asked about. A
 *   FUNCTION, because how many there are is the review's answer and not this module's: an
 *   XPI review has one tree with sweeps and a source review may have two, and a fixed pair
 *   of fields here would invent a path for a tree that does not exist.
 * @param {string} work  The work folder, absolute.
 * @returns {{xpi: string, sca: string, rescued: string, prepare: string, state: string,
 *   review: string,
 *   report: string, summary: string, build: string, buildDiff: string, buildCopy: string,
 *   sweep: (artifact: string) => {request: string, answers: string}}}
 */
export function workPaths(work) {
  const at = (name) => path.join(work, name);
  return {
    xpi: at("xpi"),
    sca: at("sca"),
    rescued: at("rescued"),
    prepare: at("prepare.json"),
    state: at("state.json"),
    review: at("review.json"),
    report: at("report.md"),
    summary: at("summary.md"),
    build: at("build.md"),
    buildDiff: at("build-diff.md"),
    buildCopy: at("build"),
    sweep: (artifact) => {
      const tag = String(artifact).toLowerCase();
      return {
        request: at(`sweep-${tag}.yaml`),
        answers: at(`sweep-${tag}.answers.json`),
      };
    },
  };
}
