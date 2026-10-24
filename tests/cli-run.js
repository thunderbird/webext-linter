// Shared helpers of the CLI-contract tests (tests/unit/cli-*.test.js): running verify.js
// offline from seeded caches, and reading back what a run printed and wrote. These tests cover
// the argument, usage and output layer that the golden report snapshots do not.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import {
  addonOutsideRepo,
  cdnMissCache,
  seedFixtureCache,
} from "./seed-caches.js";
import { relativeInside } from "../src/addon/load.js";
import { workPaths } from "../src/util/dest.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const REVIEW = path.join(ROOT, "verify.js");
// A cache pre-seeded from the fixtures. Point every fetchable source at it so the
// spawned CLI (schema auto-detection, library-hash DB, experiments allow-list) runs
// fully offline.
export const CACHE = seedFixtureCache();
// The CDN lookup runs as in any review, answered from a cache that already holds jsDelivr's
// answer for every fixture file: none of them is on the CDN. A cache of its own, apart from
// the harness's, whose CDN fixtures expect a hit for their files.
export const FIXTURES_DIR = path.join(ROOT, "tests", "addons");
export const CDN_CACHE = cdnMissCache(FIXTURES_DIR);
/** The flags that point every cache at a prepared one, so a run is answered from caches
 *  alone. */
export const cacheFlags = (cache, cdnCache = CDN_CACHE) => [
  "--cache-schema-dir",
  cache,
  "--cache-hash-db-dir",
  cache,
  "--cache-experiments-dir",
  cache,
  "--cache-cdn-lookup-dir",
  cdnCache,
  "--cache-npm-registry-dir",
  cache,
  "--cache-sources-dir",
  cache,
];
export const OFFLINE_FLAGS = cacheFlags(CACHE);

/** What the Review Details block prints under one of its names - the value sits on the
 *  line beneath the name, indented, so no line holds both. Undefined when the run printed
 *  no such name, which is how a caller asserts a value is absent. */
export function headerValue(stdout, name) {
  const lines = stdout.split("\n");
  const at = lines.findIndex((l) => l.trim() === name);
  return at === -1 ? undefined : lines[at + 1].trim();
}

/** The review file a prompt names, and what is in it. The prompt is the only place any
 *  path is given out, which is exactly what a test should read. */
export function reviewFile(stdout) {
  const at = stdout.match(/(\S+\/review\.json)/);
  return at ? at[1] : undefined;
}
export function entriesOf(stdout) {
  const file = reviewFile(stdout);
  assert.ok(file, "the prompt names the review file");
  return JSON.parse(fs.readFileSync(file, "utf8")).entries;
}

/** Run a root entry file, capturing stdout/stderr/exit code. */
export function runFile(file, args = [], env = {}) {
  const r = spawnSync(process.execPath, [file, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The fixtures' folder: a review creates its work folder beside its add-on, so an add-on
 *  there is reviewed as a copy (addonOutsideRepo). */
export const FIXTURES = path.join(ROOT, "tests", "addons");

/** The flags whose value names a folder the review READS, never the add-on, and so is
 *  passed as it stands. */
const READ_FOLDER_FLAGS = new Set([
  "--sca-extracted",
  "--sca-package-root",
  "--sca-experiments",
]);

/** Run the review entry (verify.js), with an add-on from the fixtures' folder replaced by a
 *  copy outside the repository, so no review writes its work folder into tests/addons, and
 *  with `env` added to this process's environment. */
export function run(args, env = {}) {
  return runFile(
    REVIEW,
    args.map((a, i) =>
      typeof a === "string" &&
      !READ_FOLDER_FLAGS.has(args[i - 1]) &&
      relativeInside(a, FIXTURES) !== null &&
      relativeInside(a, FIXTURES) !== "" &&
      fs.existsSync(a)
        ? addonOutsideRepo(a)
        : a
    ),
    env
  );
}

/** The work folder a review file is in: the parent of its `.review/` folder. */
export const workOfReviewFile = (file) => path.dirname(path.dirname(file));

/** The default work folder a review of `addon` created beside it: the one folder there
 *  named after the kind of review (`xpi` or `sca`), the add-on and a moment. */
export function defaultFolderOf(addon, kind) {
  const leaf = path.basename(addon).replace(/\.xpi$/, "");
  const made = fs
    .readdirSync(path.dirname(addon))
    .filter((n) =>
      new RegExp(`^${kind}-review-${leaf}-\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z$`).test(
        n
      )
    );
  assert.equal(made.length, 1, "one default work folder, beside the add-on");
  return path.join(path.dirname(addon), made[0]);
}

/**
 * Play the sweeping sub-agents this run started: answer every sweep it asked for, taking
 * what to report for a check from `found` and answering every other with the empty list.
 *
 * Which label belongs to which check is read off the STATE, because that is where the
 * review recorded it - the request handed to an agent names no check id at all, which is
 * the point of it.
 */
export function sweepBack(reviewFile, found = {}) {
  const state = JSON.parse(
    fs.readFileSync(path.join(path.dirname(reviewFile), "state.json"), "utf8")
  );
  for (const [artifact, paths] of Object.entries(state.paths.sweeps ?? {})) {
    const mine = state.preSweep.items.filter((i) => i.artifact === artifact);
    fs.writeFileSync(
      paths.answers,
      JSON.stringify({
        answers: Object.fromEntries(
          mine.map((i) => [i.label, found[i.check] ?? []])
        ),
      })
    );
  }
}

/**
 * Hand a --llm-review back until its state reaches the phase `stop` or the close, the way a
 * plain agent would: every sweep answers nothing, the summary is written, a finding is kept
 * (`reported`), and every other entry is cleared where it may be, else given its first answer.
 * @param {string} work  The review's work folder.
 * @param {string} stop  The phase to stop at.
 * @returns {{state: object, out: ?{code: number, stdout: string, stderr: string}}}  The
 *   state at that phase, and the hand-back that printed its prompt (null where the review was
 *   already there).
 */
export function handBackUntil(work, stop) {
  const files = workPaths(work);
  let out = null;
  for (let pass = 0; pass < 10; pass++) {
    const state = readJson(work, "state");
    if (state.phase === stop || state.phase === "close") {
      return { state, out };
    }
    sweepBack(files.review);
    const summary = state.report.meta.summaryFile;
    if (summary && !fs.existsSync(summary)) {
      fs.writeFileSync(summary, "A summary.\n");
    }
    const doc = JSON.parse(fs.readFileSync(files.review, "utf8"));
    doc.entries = doc.entries.map((e) => {
      const labels = (e.answers ?? []).map((a) => a.label);
      const answer =
        ["cleared", "reported"].find((l) => labels.includes(l)) ??
        labels[0] ??
        null;
      return { ...e, answer };
    });
    fs.writeFileSync(files.review, JSON.stringify(doc, null, 1));
    out = run(["--llm-handback", work]);
    assert.notEqual(out.code, 2, out.stdout + out.stderr);
  }
  throw new Error(`the review never reached ${stop}`);
}

/** A submission folder: one built add-on, one source archive, and the usual clutter. The
 *  add-on is a real one, because the hand-back that finishes the preparation reviews it. */
export function submissionFolder(name = "addon.xpi") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-submission-"));
  packAddon(path.join(dir, name));
  fs.writeFileSync(path.join(dir, "src-4.3.12.tar_ABC.gz"), "");
  fs.writeFileSync(path.join(dir, "README.txt"), "");
  return dir;
}

/** Pack the clean fixture as an .xpi at `file`, with `manifest` merged into its own. */
export function packAddon(file, manifest = {}) {
  const clean = path.join(ROOT, "tests", "addons", "clean");
  const zip = new AdmZip();
  zip.addLocalFolder(clean);
  const own = JSON.parse(
    fs.readFileSync(path.join(clean, "manifest.json"), "utf8")
  );
  zip.updateFile(
    "manifest.json",
    Buffer.from(JSON.stringify({ ...own, ...manifest }))
  );
  zip.writeZip(file);
}

/** The source the preparation tests extract: one with no lock, so its audit asks no
 *  network and cannot read a tree to rescue - the review is started at once. */
export const NO_LOCK_SOURCE = path.join(
  ROOT,
  "tests",
  "addons",
  "missing-lock-sca",
  "src"
);

/** The command a preparation prompt prints, one flag per line: the paragraph after the
 *  step that says to run the linter. */
export function commandOf(stdout) {
  return stdout
    .split("with exactly these flags, and nothing else:\n\n")[1]
    .split("\n\n")[0]
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** The work folder a preparation prompt names: the one its ANSWERS file is in, in
 *  `.review/`, or on the `unpack` prompt, which hands out no ANSWERS, the one EXTRACT_TO is
 *  `sca/` of. */
export const workOf = (stdout) => {
  const answers = headerValue(stdout, "ANSWERS");
  return answers
    ? path.dirname(path.dirname(answers))
    : path.dirname(headerValue(stdout, "EXTRACT_TO"));
};

/** A work folder's JSON file, by its workPaths name, read back. */
export const readJson = (work, name) =>
  JSON.parse(fs.readFileSync(workPaths(work)[name], "utf8"));

/**
 * Do what the `unpack` prompt asks, the way its reader would: extract the source into
 * EXTRACT_TO (with an Experiment folder `experimentsFolder` in it, where given), and run the
 * hand-back it prints, which derives the root and prints the `analyze` prompt.
 * @param {string} stdout  The --llm-sca-review run's output.
 * @param {{experimentsFolder?: string, typed?: (work: string) => string}} [opts]  As handBackRoots.
 * @returns {{code: number, stdout: string, stderr: string}}  The hand-back's run.
 */
export function unpackSource(stdout, { experimentsFolder, typed } = {}) {
  const root = headerValue(stdout, "EXTRACT_TO");
  fs.cpSync(NO_LOCK_SOURCE, root, { recursive: true });
  if (experimentsFolder) {
    fs.mkdirSync(path.join(root, experimentsFolder), { recursive: true });
  }
  // The Experiment folder is named in the unpack review file, where the prompt asks for it.
  const answers = headerValue(stdout, "ANSWERS");
  if (answers) {
    const doc = JSON.parse(fs.readFileSync(answers, "utf8"));
    doc.entries = doc.entries.map((e) =>
      e.index === "SCA_EXPERIMENTS" ? { ...e, answer: experimentsFolder } : e
    );
    fs.writeFileSync(answers, JSON.stringify(doc, null, 1));
  }
  const work = workOf(stdout);
  return typed
    ? run(["--llm-handback", typed(work)])
    : run(argvOf(commandOf(stdout)));
}

/** The build safety issue a test hands back for a build it wants judged unsafe: one step of
 *  the root's package.json, which every source a test hands back holds. */
export const UNSAFE_ISSUE = {
  file: "package.json",
  line: 1,
  hint: "runs a script it downloads with curl",
};

/** The SCA_BUILD_SAFETY_ISSUES answer for a build a test wants judged `safety`. */
const issuesFor = (safety) => (safety === "unsafe" ? [UNSAFE_ISSUE] : []);

/**
 * Do what the `analyze` prompt asks, the way its reader would: write the build report to
 * SCA_BUILD_PROCESS and answer ANSWERS with the build's safety issues, none by default, one
 * (UNSAFE_ISSUE) for a build to be judged unsafe. Its hand-back prints the permission prompt
 * (answerPermission). The hand-back itself is the caller's, so it can run it as it likes.
 * @param {string} stdout  The `analyze` prompt's run.
 * @param {{safety?: string}} [opts]  The judgement.
 * @returns {string[]}  The hand-back's argv, as the prompt prints it.
 */
export function answerAnalyze(stdout, { safety = "safe" } = {}) {
  fs.writeFileSync(headerValue(stdout, "SCA_BUILD_PROCESS"), "1. `npm ci`\n");
  const answers = headerValue(stdout, "ANSWERS");
  const doc = JSON.parse(fs.readFileSync(answers, "utf8"));
  const given = { SCA_BUILD_SAFETY_ISSUES: issuesFor(safety) };
  doc.entries = doc.entries.map((e) => ({ ...e, answer: given[e.index] }));
  fs.writeFileSync(answers, JSON.stringify(doc, null, 1));
  return argvOf(commandOf(stdout));
}

/**
 * Do what the permission prompt asks, the way its reader would: answer the reviewer's build
 * decision with `decision`, by default building it themselves, so the hand-back starts the
 * review at once with nothing for the agent to build. The hand-back is the caller's.
 * @param {string} stdout  The permission prompt's run.
 * @param {string} [decision]  A label the question offers, or the reviewer's own words.
 * @returns {string[]}  The hand-back's argv, as the prompt prints it.
 */
export function answerPermission(stdout, decision = "Build it myself") {
  const answers = headerValue(stdout, "ANSWERS");
  const doc = JSON.parse(fs.readFileSync(answers, "utf8"));
  doc.entries = doc.entries.map((e) => ({ ...e, answer: decision }));
  fs.writeFileSync(answers, JSON.stringify(doc, null, 1));
  return argvOf(commandOf(stdout));
}

/**
 * Do what the first prompts ask, the way their reader would: extract the source into
 * EXTRACT_TO, name the Experiment folder where `unpack` asks for it, and run the hand-back the
 * `unpack` prompt prints, then write the build report to SCA_BUILD_PROCESS, answer ANSWERS (the
 * build judged safe), and run the hand-back the `analyze` prompt prints. Where that prints the
 * permission prompt, answer it too (the agent let build) and run its hand-back - which, with
 * nothing to rescue, starts the review.
 * @param {string} stdout  The --llm-sca-review run's output.
 * @param {{experimentsFolder?: string, typed?: (work: string) => string, safety?: string,
 *   managers?: string}} [opts]  The Experiment folder to answer, relative to the root, for
 *   an add-on that declares Experiments, how the work folder is typed, where not as the
 *   prompt prints it, the agent's build judgement, and the reviewer's answer to the
 *   permission question.
 * @returns {{code: number, stdout: string, stderr: string}}  The last hand-back's run.
 */
export function handBackRoots(
  stdout,
  {
    experimentsFolder,
    typed,
    safety = "safe",
    managers = "Let the agent build",
  } = {}
) {
  const work = workOf(stdout);
  const handBack = (out) =>
    typed ? run(["--llm-handback", typed(work)]) : run(argvOf(commandOf(out)));
  const unpacked = unpackSource(stdout, { experimentsFolder, typed });
  if (unpacked.code !== 0) {
    return unpacked;
  }
  fs.writeFileSync(
    headerValue(unpacked.stdout, "SCA_BUILD_PROCESS"),
    "1. `npm ci`\n"
  );
  const answers = headerValue(unpacked.stdout, "ANSWERS");
  const fill = (given) => {
    const doc = JSON.parse(fs.readFileSync(answers, "utf8"));
    doc.entries = doc.entries.map((e) => ({ ...e, answer: given[e.index] }));
    fs.writeFileSync(answers, JSON.stringify(doc, null, 1));
  };
  fill({ SCA_BUILD_SAFETY_ISSUES: issuesFor(safety) });
  const handed = handBack(unpacked.stdout);
  if (handed.code !== 0 || readJson(work, "prepare").step !== "permission") {
    return handed;
  }
  fill({ SCA_BUILD_PERMISSION: managers });
  return handBack(handed.stdout);
}

/** A printed command, one flag per line, as the argv it stands for. */
export function argvOf(flags) {
  return flags.flatMap((line) => {
    const [flag, ...rest] = line.split(" ");
    const value = rest.join(" ").replace(/^'|'$/g, "");
    return value ? [flag, value] : [flag];
  });
}

/** A prompt's text with its wrapping undone: its lines trimmed and joined by a space, so a
 *  phrase reads the same wherever the prompt wrapped it. */
export const unwrapped = (stdout) =>
  stdout
    .split("\n")
    .map((l) => l.trim())
    .join(" ");
