// The build check of a source code review, one hand-back at a time (src/build-check/steps.js):
// what its audit of a root's lock decides (src/build-check/audit.js), how the agent's build of
// a clean lock is recorded, when a rescued copy is made, how a rescue is checked and how it
// fails, what each hand-back refuses, which Experiment folder the unpack hand-back reads back,
// which folders the record names for the hand-back's folder check, and what the review of a
// rescued copy tells the developer (sca-dependencies-changed). Driven through handBack(), its
// handout issued as the hand-back issues it, with OSV's answers seeded into a run cache folder
// outside the work folder, which the record names as its --cache-work-dir (auditCache), so
// every OSV answer is the test's, and a request for one it does not give is refused by the
// switched-off network.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzeEntries,
  handBack,
  unpackEntries,
  unpackedExperiments,
} from "../../src/build-check/steps.js";
import {
  BUILD_CHECK_STEP,
  buildCheckBody,
} from "../../src/build-check/state.js";
import {
  MODE,
  addToRecord,
  namedFolders,
  readRecord,
  startMode,
  writeRecord,
} from "../../src/review/record.js";
import {
  HandbackRefused,
  reviewFile,
  writeReviewFile,
} from "../../src/report/handback.js";
import { settlePackageRoot } from "../../src/addon/package-root.js";
import { loadRegistry } from "../../src/checks/registry.js";
import { loadTheXpi } from "../../src/review/start.js";
import { NoAnswerError } from "../../src/util/net.js";
import {
  misplacedFolders,
  misplacedFoldersError,
  runCache,
  workPaths,
} from "../../src/util/dest.js";
import { loadSourceArchive } from "../../src/addon/load.js";
import depsChanged from "../../src/checks/rules/sca-dependencies-changed.js";
import {
  advisory,
  answer,
  auditCache,
  buildInto,
  buildRescued,
  writeBuildReport,
  writeTree,
} from "../build-checked.js";
import {
  osvEntries,
  popularityEntries,
  seeded,
  seedWorkCache,
} from "../seed-caches.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");

/** A HIGH advisory on the build tool every source below declares. */
const TOOL_HIGH = {
  "lint-pebble@0.4.0": [advisory("GHSA-tool", "HIGH", "lint-pebble", "0.4.1")],
};

/** The build tool every source below declares, as OSV answers it with no advisory. */
const TOOL_CLEAN = { "lint-pebble@0.4.0": [] };

/** The build safety issues an agent hands back for a build it judges unsafe: one step of the
 *  package.json every source below holds. */
const UNSAFE = [
  {
    file: "package.json",
    line: 1,
    hint: "runs a script it downloads with curl",
  },
];

/** The counts of a lock with no vulnerable package, and of one with the tool's advisory. */
const NONE = { moderate: 0, high: 0, critical: 0 };
const ONE_HIGH = { moderate: 0, high: 1, critical: 0 };

/** A package.json for the sources below: no dependency of its own, and a lint tool pinned
 *  as a devDependency unless `tool` is null. */
function packageFile(tool = "0.4.0", extra = {}) {
  return JSON.stringify({
    name: "lantern-sorter",
    version: "1.0.0",
    scripts: { build: "node build.js" },
    ...(tool ? { devDependencies: { "lint-pebble": tool } } : {}),
    ...extra,
  });
}

/** The npm lock that installs it, one key per line, so an entry has a line of its own. */
function npmLock(tool = "0.4.0", extraPackages = {}) {
  const root = { name: "lantern-sorter", version: "1.0.0" };
  if (tool) {
    root.devDependencies = { "lint-pebble": tool };
  }
  return JSON.stringify(
    {
      name: "lantern-sorter",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": root,
        ...(tool
          ? { "node_modules/lint-pebble": { version: tool, dev: true } }
          : {}),
        ...extraPackages,
      },
    },
    null,
    2
  );
}

/** The authored registry every hand-back below is taken with. */
const registry = loadRegistry();

/** The add-on's manifest, the same in the shipped add-on and in its source. */
const MANIFEST = '{"manifest_version": 3, "name": "x", "version": "1"}';

/**
 * What the hand-back issues for a handout, without the print (src/review/issue.js): a step's
 * record written, then its answers file. A done folder's record was written by the step.
 * @param {string} work
 * @param {object} out  The handout (handBack).
 * @returns {object}  The handout, its record as written.
 */
function issue(work, out) {
  if (out.next !== "step") {
    return out;
  }
  const record = writeRecord(work, out.record);
  writeReviewFile(workPaths(work).answers, reviewFile(out.entries));
  return { ...out, record };
}

/**
 * A work folder whose build check starts, as the run that starts one leaves it
 * (tests/build-checked.js realBuildCheck): the add-on loaded into it with an empty record,
 * what the run was given added to the record, its source in sca/ (`files`, relative to sca/,
 * beside a manifest and a script), that folder added too, and the record in mode build-check
 * at `analyze`, its folders settled in sca/, issued with the analyze question. Inside a fresh
 * parent, real, as the hand-back is given it.
 * Its record names `cache` as its --cache-work-dir: by default a folder seeded with OSV's
 * answers `vulns` (auditCache), for every step of the build check. A null `cache` names none,
 * so the run's cache is the work folder's own.
 * @param {Record<string, string>} files
 * @param {{vulns?: Record<string, object[]>, cache?: ?string, flags?: object}} [opts]
 * @returns {string} The work folder.
 */
function workFolder(
  files,
  { vulns = {}, cache = auditCache(vulns), flags = {} } = {}
) {
  const parent = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "wl-build-check-"))
  );
  const addon = path.join(parent, "addon");
  writeTree(addon, { "manifest.json": MANIFEST });
  const work = path.join(parent, "work");
  const loaded = loadTheXpi(addon, work);
  const given = addToRecord(work, loaded.record, {
    submission: { xpi: addon, experiments: false },
    kind: "sca",
    flags: { ...flags, ...(cache ? { "cache-work-dir": cache } : {}) },
    folders: { xpi: workPaths(work).xpi },
  });
  const sca = workPaths(work).sca;
  writeTree(sca, {
    "manifest.json": MANIFEST,
    "bg.js": 'console.log("source");\n',
    ...files,
  });
  const copied = addToRecord(work, given, { folders: { sca } });
  issue(work, {
    next: "step",
    record: startMode(
      copied,
      MODE.buildCheck,
      buildCheckBody(settlePackageRoot(sca, {}).folders),
      BUILD_CHECK_STEP.analyze
    ),
    entries: analyzeEntries(),
  });
  return work;
}

/** One hand-back of the folder in mode build-check: its record read, the step taken, and
 *  the handout issued. */
const stepOn = async (work) =>
  issue(work, await handBack(work, readRecord(work), registry));

/** The analyze step: the build report written and `answers` filled in (the build judged safe
 *  unless they say otherwise). */
const analyzeStep = async (work, answers = {}) => {
  answer(work, answers);
  writeBuildReport(work);
  return stepOn(work);
};

/** The analyze step, and the permission step after it: the reviewer's answer is read from
 *  `answers` too, letting the agent build unless they say otherwise. */
const first = async (work, answers = {}) => {
  const at = await analyzeStep(work, answers);
  if (at.record.current.step !== BUILD_CHECK_STEP.permission) {
    return at;
  }
  answer(work, answers);
  return stepOn(work);
};

/** The labels a build or rescue answers LLM_BUILD_OUTPUT with where it produced nothing. */
const FAILED = ["The build failed", "The rescue failed"];

/** The build or rescue step handed back with `output` as its LLM_BUILD_OUTPUT answer, and `match`
 *  as its LLM_BUILD_XPI_MATCH answer: `no match` beside an output, and null beside a failed label,
 *  unless the test says otherwise. */
const handOutput = (
  work,
  output,
  match = FAILED.includes(output) ? null : "no match"
) => {
  answer(work, { LLM_BUILD_OUTPUT: output, LLM_BUILD_XPI_MATCH: match });
  return stepOn(work);
};

/** The review file's entries, as the folder holds them. */
const reviewEntries = (work) =>
  JSON.parse(fs.readFileSync(workPaths(work).answers, "utf8")).entries;

/**
 * OSV's responses to an audit of one release, as run cache entries (osvEntries), each played
 * in place of OSV and kept like a live answer: `vulns` maps the "name@version" asked about to
 * its advisories, as auditEntries takes it.
 * @param {Record<string, object[]>} vulns  One release.
 * @returns {Record<string, object>}
 */
function liveAudit(vulns) {
  const [[release, list]] = Object.entries(vulns);
  return osvEntries({
    batch: {
      [release]: seeded({
        status: 200,
        json: { results: [{ vulns: list.map((v) => ({ id: v.id })) }] },
      }),
    },
    advisories: Object.fromEntries(
      list.map((v) => [v.id, seeded({ status: 200, json: v })])
    ),
  });
}

/** OSV's batch endpoint answering 404 for `release`, which is no answer from OSV and ends
 *  the run, as run cache entries (osvEntries). */
const batchDown = (release) =>
  osvEntries({ batch: { [release]: seeded({ status: 404 }) } });

/** Add `entries` to the OSV cache of the run the record of `work` names. */
function seedRunOsv(work, entries) {
  const file = runCache(work, recordOf(work).flags?.["cache-work-dir"]).osv;
  const cache = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : {};
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...cache, ...entries }));
}

/** npm's downloads of the build tool every lock here declares: a widely-used one, so the
 *  audit's popularity question lets it through. */
const POPULAR_TOOL = popularityEntries({
  npm: { "lint-pebble": { downloads: 9_000_000 } },
});

/** Seed the run's own popularity cache with the build tool's reading (POPULAR_TOOL). */
function seedRunPopularity(work) {
  const file = runCache(
    work,
    recordOf(work).flags?.["cache-work-dir"]
  ).popularity;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(POPULAR_TOOL));
}

/** Whether every entry of a run's OSV cache file holds OSV's answer. */
const allAnswered = (file) =>
  Object.values(JSON.parse(fs.readFileSync(file, "utf8"))).every((e) =>
    Object.hasOwn(e, "answer")
  );

const recordOf = (work) => readRecord(work);

const cleanup = (work) =>
  fs.rmSync(path.dirname(work), { recursive: true, force: true });

/** A refusal, with the problem it names: matching `expected`, or holding it as written. */
const refused = (expected) => (err) => {
  assert.ok(err instanceof HandbackRefused, err.message);
  if (typeof expected === "string") {
    assert.ok(err.problem.includes(expected), err.problem);
  } else {
    assert.match(err.problem, expected);
  }
  return true;
};

/** A failure, no refusal: the record cannot be carried on, the problem it names in it. */
const failed = (problem) => (err) => {
  assert.ok(!(err instanceof HandbackRefused), `not a refusal: ${err.message}`);
  assert.ok(
    err.message.startsWith("The review's record cannot be carried on: "),
    err.message
  );
  assert.ok(err.message.includes(problem), err.message);
  return true;
};

/** The record with its current part changed by `edit`, written as the linter writes one:
 *  a forged record, sealed again. */
const forge = (work, edit) => {
  const record = recordOf(work);
  return writeRecord(work, { ...record, current: edit(record.current) });
};

// ---- the analyze step ----

/** A work folder whose lock the audit finds clean, at its `build` step. */
async function clean() {
  const work = workFolder(
    {
      "package.json": packageFile(),
      "package-lock.json": npmLock(),
    },
    { vulns: TOOL_CLEAN }
  );
  const at = await first(work);
  return { work, at };
}

// A clean lock is built: the agent is handed the build, its one entry asking where the build
// put what it produced, and the lock's counts are recorded. The linter copies the source into
// build/ for it, and makes no rescued copy.
test("a clean source moves on to the build", async () => {
  const { work, at } = await clean();
  assert.equal(at.next, "step");
  assert.equal(at.record.current.step, BUILD_CHECK_STEP.build);
  assert.deepEqual(at.record.current.roots, {
    source: workPaths(work).sca,
    used: workPaths(work).sca,
    packageRoot: workPaths(work).sca,
  });
  assert.equal(
    at.record.current.packageManagers,
    true,
    "the reviewer allowed them"
  );
  assert.deepEqual(at.record.current.vulnerabilities, NONE);
  assert.equal(at.record.current.buildResult, null);
  assert.deepEqual(recordOf(work), at.record);
  const [output, match, ...rest] = reviewEntries(work);
  assert.deepEqual(rest, []);
  assert.equal(output.index, "LLM_BUILD_OUTPUT");
  assert.equal(output.message, "Where did the build put what it produced?");
  assert.deepEqual(
    output.answers.map((a) => a.label),
    ["The build failed"]
  );
  assert.equal(match.index, "LLM_BUILD_XPI_MATCH");
  assert.equal(match.answer, null);
  assert.deepEqual(
    match.answers.map((a) => a.label),
    ["match", "no match"]
  );
  assert.ok(!fs.existsSync(workPaths(work).rescued), "no copy is made");
  assert.ok(fs.existsSync(workPaths(work).buildCopy), "the build copy is made");
  cleanup(work);
});

// The build copy is the whole source archive, never only its root: a build that writes next
// to its root still writes inside build/. A stale build/ is replaced, and sca/ is unchanged.
test("the build pass copies the whole source archive into build/", async () => {
  const work = workFolder(
    {
      "proj/package.json": packageFile(),
      "proj/package-lock.json": npmLock(),
      "beside.txt": "next to the root",
    },
    { vulns: TOOL_CLEAN }
  );
  const { sca, buildCopy } = workPaths(work);
  writeTree(buildCopy, { "left-over.txt": "stale" });
  const at = await first(work);
  assert.equal(at.record.current.step, BUILD_CHECK_STEP.build);
  assert.equal(at.record.current.roots.packageRoot, path.join(sca, "proj"));
  for (const file of [
    "beside.txt",
    "manifest.json",
    "bg.js",
    "proj/package.json",
    "proj/package-lock.json",
  ]) {
    assert.equal(
      fs.readFileSync(path.join(buildCopy, file), "utf8"),
      fs.readFileSync(path.join(sca, file), "utf8"),
      file
    );
  }
  assert.ok(!fs.existsSync(path.join(buildCopy, "left-over.txt")));
  assert.ok(!fs.existsSync(path.join(sca, "left-over.txt")));
  // An output written next to the root lies inside build/, and is taken.
  writeTree(buildCopy, { "lantern-sorter.xpi": "PK" });
  const done = await handOutput(
    work,
    path.join(buildCopy, "lantern-sorter.xpi")
  );
  assert.equal(done.record.current.buildResult, "built");
  assert.equal(
    done.record.current.buildOutput,
    path.join(buildCopy, "lantern-sorter.xpi")
  );
  cleanup(work);
});

// What the build produced, named inside build/ - relative to it or absolute, a file or a
// folder - is recorded as the real path it is, and the folder is done: its review starts
// there, and the review file it claims for itself is gone.
test("a build output inside build/ is recorded, and the folder done", async () => {
  for (const [named, made] of [
    ["dist", (copy) => buildInto(copy)],
    [
      null,
      (copy) => {
        writeTree(copy, { "out/addon.xpi": "PK" });
        return path.join(copy, "out", "addon.xpi");
      },
    ],
  ]) {
    const { work } = await clean();
    const output = made(workPaths(work).buildCopy);
    const at = await handOutput(work, named ?? output);
    assert.equal(at.next, "review");
    assert.equal(at.record.current.step, BUILD_CHECK_STEP.done);
    assert.equal(at.record.current.buildResult, "built");
    assert.equal(at.record.current.buildOutput, output);
    assert.deepEqual(at.record.current.vulnerabilities, NONE);
    assert.deepEqual(recordOf(work), at.record);
    assert.ok(
      !fs.existsSync(workPaths(work).answers),
      "the review file is gone"
    );
    cleanup(work);
  }
});

// A build that failed names no output: the failure is recorded, and the folder is done.
test("a failed build is recorded, and the folder done", async () => {
  const { work } = await clean();
  const at = await handOutput(work, "The build failed");
  assert.equal(at.next, "review");
  assert.equal(at.record.current.step, BUILD_CHECK_STEP.done);
  assert.equal(at.record.current.buildResult, "failed");
  assert.equal(at.record.current.buildOutput, null);
  assert.deepEqual(recordOf(work), at.record);
  cleanup(work);
});

// The agent's comparison of its output with the submitted XPI is recorded as the id it
// answered, beside the output.
test("a build output is recorded with the agent's comparison", async () => {
  for (const match of ["match", "no match"]) {
    const { work } = await clean();
    const output = buildInto(workPaths(work).buildCopy);
    const at = await handOutput(work, output, match);
    assert.equal(at.record.current.buildResult, "built");
    assert.equal(at.record.current.buildOutput, output);
    assert.equal(at.record.current.buildMatch, match);
    assert.deepEqual(recordOf(work), at.record);
    cleanup(work);
  }
  const { work } = await clean();
  const at = await handOutput(work, "The build failed");
  assert.equal(
    at.record.current.buildMatch,
    null,
    "a failed build compares nothing"
  );
  cleanup(work);
});

// LLM_BUILD_XPI_MATCH goes with an output only: a failed build that answers it, and an output that
// leaves it open or answers it with no label it offers, are refused, with nothing changed.
test("a comparison that does not go with the build's answer is refused", async () => {
  const { work } = await clean();
  const output = buildInto(workPaths(work).buildCopy);
  for (const [named, match, problem] of [
    [
      "The build failed",
      "match",
      'LLM_BUILD_XPI_MATCH answers "match", but LLM_BUILD_OUTPUT answers "The build failed": ' +
        'leave its "answer" null',
    ],
    [output, null, 'LLM_BUILD_XPI_MATCH still has no "answer"'],
    [
      output,
      "close enough",
      'LLM_BUILD_XPI_MATCH answers "close enough", which this entry',
    ],
  ]) {
    await assert.rejects(handOutput(work, named, match), refused(problem));
  }
  assert.equal(recordOf(work).current.step, BUILD_CHECK_STEP.build);
  assert.ok(fs.existsSync(workPaths(work).answers), "nothing moved");
  cleanup(work);
});

// An output is something the build produced in build/. Anything else is refused, with the
// folder unchanged, so the agent can correct the answer and hand it back again.
test("a build output outside build/, or missing, is refused", async () => {
  const { work } = await clean();
  const copy = workPaths(work).buildCopy;
  // The build copy is no folder the record names, and the agent builds in it, so one that
  // is gone is refused as the build's: the agent builds there and hands it back again.
  fs.rmSync(copy, { recursive: true });
  await assert.rejects(
    handOutput(work, "dist"),
    refused(
      `LLM_BUILD_OUTPUT names "dist", but the build copy "${copy}" does not exist`
    )
  );
  assert.equal(recordOf(work).current.step, BUILD_CHECK_STEP.build);
  buildInto(copy);
  fs.symlinkSync(workPaths(work).sca, path.join(copy, "linked"));
  for (const [named, problem] of [
    [workPaths(work).sca, "is not inside the build copy"],
    ["../sca", "is not inside the build copy"],
    ["linked", "is not inside the build copy"],
    [".", "is not inside the build copy"],
    ["nothing-here", "which does not exist"],
    ["  ", 'names no path and does not answer "The build failed"'],
  ]) {
    await assert.rejects(handOutput(work, named), refused(problem));
  }
  assert.equal(recordOf(work).current.step, BUILD_CHECK_STEP.build);
  assert.ok(fs.existsSync(workPaths(work).answers), "nothing moved");
  cleanup(work);
});

// A run cut short after it moved the record to `build` and before it wrote the question
// leaves the permission step's review file: the next hand-back writes the question again.
test("a build step without its question hands the question out again", async () => {
  const { work } = await clean();
  const file = workPaths(work).answers;
  fs.writeFileSync(
    file,
    JSON.stringify({ entries: [{ index: "SCA_BUILD_PERMISSION" }] })
  );
  const at = await stepOn(work);
  assert.equal(at.next, "step");
  assert.equal(at.record.current.step, BUILD_CHECK_STEP.build);
  assert.deepEqual(
    reviewEntries(work).map((e) => e.index),
    ["LLM_BUILD_OUTPUT", "LLM_BUILD_XPI_MATCH"]
  );
  cleanup(work);
});

// The build check starts at `analyze`, its folders settled in sca/ before it, and the analyze
// prompt asks the agent for the build's safety issues: the record holds no verdict and no
// permission until that hand-back reads them.
test("the analyze step asks for the build's safety issues", () => {
  const work = workFolder({ "package.json": packageFile() });
  const record = recordOf(work);
  assert.equal(record.current.mode, MODE.buildCheck);
  assert.equal(record.current.step, BUILD_CHECK_STEP.analyze);
  assert.equal(record.current.roots.packageRoot, workPaths(work).sca);
  const [safety, ...rest] = reviewEntries(work);
  assert.deepEqual(rest, [], "the root is the linter's, and asked of nobody");
  assert.deepEqual(safety, { index: "SCA_BUILD_SAFETY_ISSUES", answer: null });
  assert.equal(recordOf(work).current.vulnerabilities, null);
  assert.equal(recordOf(work).current.buildResult, null);
  assert.equal(recordOf(work).current.buildIssues, null);
  assert.equal(recordOf(work).current.buildSafety, null);
  assert.equal(recordOf(work).current.packageManagers, null);
  cleanup(work);
});

// A safe build is recorded, and the reviewer is asked alone for their build decision, worded
// by the safe verdict: the review file holds that one question, and nothing is audited yet. The lock is
// vulnerable and OSV is given no answer, so an audit would ask the switched-off network.
test("a safe build moves on to the permission question, with nothing audited", async () => {
  const work = workFolder(
    { "package.json": packageFile(), "package-lock.json": npmLock() },
    { cache: auditCache() }
  );
  const at = await analyzeStep(work);
  assert.equal(at.next, "step");
  assert.equal(at.record.current.step, BUILD_CHECK_STEP.permission);
  assert.equal(at.record.current.buildSafety, "safe");
  assert.equal(at.record.current.packageManagers, null);
  assert.equal(at.record.current.buildSafe, null);
  assert.equal(at.record.current.vulnerabilities, null, "nothing is audited");
  assert.deepEqual(at.record.current.roots, {
    source: workPaths(work).sca,
    used: workPaths(work).sca,
    packageRoot: workPaths(work).sca,
  });
  assert.deepEqual(recordOf(work), at.record);
  const [managers, ...rest] = JSON.parse(
    fs.readFileSync(workPaths(work).answers, "utf8")
  ).entries;
  assert.deepEqual(rest, []);
  assert.equal(managers.index, "SCA_BUILD_PERMISSION");
  assert.equal(managers.answer, null);
  assert.ok(managers.message.startsWith("The agent judged the build safe."));
  assert.deepEqual(
    managers.answers.map((a) => a.label),
    ["Let the agent build", "Build it myself"]
  );
  cleanup(work);
});

// An unsafe verdict is put to the reviewer too, worded by it, and nothing is audited until
// they answer.
test("an unsafe build asks the reviewer, with nothing audited", async () => {
  const work = workFolder(
    { "package.json": packageFile(), "package-lock.json": npmLock() },
    { cache: auditCache() }
  );
  const at = await analyzeStep(work, { SCA_BUILD_SAFETY_ISSUES: UNSAFE });
  assert.equal(at.next, "step");
  assert.equal(at.record.current.step, BUILD_CHECK_STEP.permission);
  assert.equal(at.record.current.buildSafety, "unsafe");
  assert.equal(at.record.current.vulnerabilities, null, "nothing is audited");
  const [decision] = reviewEntries(work);
  assert.ok(decision.message.startsWith("The agent judged the build unsafe"));
  assert.deepEqual(
    decision.answers.map((a) => a.label),
    ["Trust the verdict, do not build", "Build anyhow"]
  );
  cleanup(work);
});

// Each answer of the decision, after its verdict: whether the build is held safe, whether the
// agent builds it, and the reviewer's own words as the reasons for holding it unsafe. Only an
// answer that lets the agent build goes on to the audit, whose clean lock is built.
test("the build decision records what the reviewer answered", async () => {
  const words = "It downloads a binary from a host nobody pinned.";
  for (const [verdict, given, expected] of [
    ["safe", "Let the agent build", [true, true, null, BUILD_CHECK_STEP.build]],
    ["safe", "build it myself", [false, true, null, BUILD_CHECK_STEP.done]],
    ["safe", words, [false, false, words, BUILD_CHECK_STEP.done]],
    [
      "unsafe",
      "Trust the verdict, do not build",
      [false, false, null, BUILD_CHECK_STEP.done],
    ],
    ["unsafe", "Build anyhow", [true, true, null, BUILD_CHECK_STEP.build]],
    ["unsafe", words, [false, false, words, BUILD_CHECK_STEP.done]],
  ]) {
    const work = workFolder(
      { "package.json": packageFile(), "package-lock.json": npmLock() },
      { vulns: TOOL_CLEAN }
    );
    await analyzeStep(work, {
      SCA_BUILD_SAFETY_ISSUES: verdict === "unsafe" ? UNSAFE : [],
    });
    answer(work, { SCA_BUILD_PERMISSION: given });
    const at = await stepOn(work);
    const { packageManagers, buildSafe, buildReasons, step } =
      at.record.current;
    assert.deepEqual(
      [packageManagers, buildSafe, buildReasons, step],
      expected,
      `${verdict}: ${given}`
    );
    cleanup(work);
  }
});

/** `run` with the hot runs' switch for the agent's builds on (WEBEXT_LINTER_AGENT_BUILDS=1),
 *  as the hot runs export it for the whole session. */
async function withAgentBuilds(run) {
  process.env.WEBEXT_LINTER_AGENT_BUILDS = "1";
  try {
    return await run();
  } finally {
    delete process.env.WEBEXT_LINTER_AGENT_BUILDS;
  }
}

// The hot runs' switch for the agent's builds answers the permission question for the
// reviewer: a safe build goes straight to the audit, recorded as let it build, and a clean
// lock to the build. An unsafe one is built by nobody. The switch is read from the
// environment, and the record holds nothing of it.
test("the hot runs' switch for the agent's builds skips the permission question", async () => {
  const work = workFolder(
    { "package.json": packageFile(), "package-lock.json": npmLock() },
    { vulns: TOOL_CLEAN }
  );
  const at = await withAgentBuilds(() => analyzeStep(work));
  assert.ok(!Object.hasOwn(at.record, "agentBuilds"), "nothing recorded");
  assert.equal(at.next, "step");
  assert.equal(at.record.current.step, BUILD_CHECK_STEP.build);
  assert.equal(at.record.current.buildSafety, "safe");
  assert.equal(at.record.current.packageManagers, true);
  assert.equal(at.record.current.buildSafe, true);
  cleanup(work);
  const unsafe = workFolder(
    { "package.json": packageFile(), "package-lock.json": npmLock() },
    { cache: auditCache() }
  );
  const skipped = await withAgentBuilds(() =>
    analyzeStep(unsafe, { SCA_BUILD_SAFETY_ISSUES: UNSAFE })
  );
  assert.equal(skipped.next, "review");
  assert.equal(skipped.record.current.packageManagers, false);
  assert.equal(skipped.record.current.buildSafe, false);
  cleanup(unsafe);
});

// With a check the build relies on switched off (`build-guard`), nothing vouches for what an
// install pulls in: a safe build is done at once, the reviewer is not asked, and the agent
// builds nothing, whether or not the hot runs' switch lets it.
test("a build guard switched off lets nobody build", async () => {
  // A guard the lists can reach: one that ends a review early always runs (checkSelected).
  const registry = loadRegistry();
  const guard = registry
    .buildGuardIds()
    .find((id) => registry.earlyExitFor(id) === null);
  for (const [flag, value] of [
    ["checks-skip", guard],
    ["checks-only", "manifest-missing"],
  ]) {
    const work = workFolder(
      { "package.json": packageFile(), "package-lock.json": npmLock() },
      { vulns: TOOL_CLEAN, flags: { [flag]: value } }
    );
    const at = await withAgentBuilds(() => analyzeStep(work));
    assert.equal(at.next, "review", flag);
    assert.equal(at.record.current.buildSafety, "safe");
    assert.equal(at.record.current.packageManagers, false);
    assert.equal(at.record.current.buildSafe, null, "nobody is asked");
    assert.equal(at.record.current.vulnerabilities, null, "nothing is audited");
    cleanup(work);
  }
});

// The verdict is read off the issues: none is a safe build, any is an unsafe one. The issues
// are recorded as handed back, and written to build-issues.md, which says the same.
test("the verdict is read off the build's safety issues", async () => {
  for (const [issues, verdict, written] of [
    [[], "safe", "found nothing the build reaches for"],
    [
      UNSAFE,
      "unsafe",
      "- package.json:1 - runs a script it downloads with curl",
    ],
    [
      [{ file: "package.json", hint: "its install hook fetches a binary" }],
      "unsafe",
      "- package.json - its install hook fetches a binary",
    ],
  ]) {
    const work = workFolder({ "package.json": packageFile() });
    const at = await analyzeStep(work, { SCA_BUILD_SAFETY_ISSUES: issues });
    assert.equal(at.record.current.buildSafety, verdict);
    assert.deepEqual(
      at.record.current.buildIssues,
      issues.map((i) => ({ line: null, ...i }))
    );
    const file = fs.readFileSync(workPaths(work).buildIssues, "utf8");
    assert.ok(file.includes(written), file);
    cleanup(work);
  }
});

// The issues are a list of results, each held as a sweep's are and each with a hint, and come
// with the build report they rest on. Anything else is refused with the folder unchanged.
test("build safety issues a reader could not mean, or no build report, are refused", async () => {
  const work = workFolder({ "package.json": packageFile() });
  const issue = (over) => [{ ...UNSAFE[0], ...over }];
  for (const [given, problem] of [
    [null, /SCA_BUILD_SAFETY_ISSUES still has no "answer"/],
    ["fine", /SCA_BUILD_SAFETY_ISSUES answers with no list/],
    [
      issue({ file: "../elsewhere.js" }),
      /SCA_BUILD_SAFETY_ISSUES entry 1 has file/,
    ],
    [
      issue({ file: "gone.js" }),
      /entry 1 names file "gone.js", which is not a file/,
    ],
    [issue({ line: 999 }), /entry 1 names line 999 of "package.json"/],
    [issue({ hint: undefined }), /entry 1 has no "hint"/],
    [issue({ severity: "error" }), /entry 1 carries "severity"/],
    [issue({ hint: "x".repeat(501) }), /entry 1 has a 501-character hint/],
  ]) {
    await assert.rejects(
      analyzeStep(work, { SCA_BUILD_SAFETY_ISSUES: given }),
      refused(problem),
      JSON.stringify(given)
    );
  }
  assert.equal(recordOf(work).current.buildIssues, null);
  answer(work, {});
  fs.rmSync(workPaths(work).build, { force: true });
  await assert.rejects(stepOn(work), refused(/holds no build report/));
  assert.equal(recordOf(work).current.step, BUILD_CHECK_STEP.analyze);
  cleanup(work);
});

// The analyze answer is checked against what was asked, as every step's is: the entry twice,
// or one nobody asked about, is refused rather than the first one deciding the verdict.
test("an analyze hand-back with an entry twice or one never asked is refused", async () => {
  const work = workFolder({ "package.json": packageFile() });
  writeBuildReport(work);
  const issues = { index: "SCA_BUILD_SAFETY_ISSUES", answer: [] };
  for (const [entries, problem] of [
    [[issues, { ...issues, answer: UNSAFE }], /appears twice/],
    [
      [issues, { index: "OTHER", answer: "x" }],
      /OTHER is not one of the entries/,
    ],
  ]) {
    fs.writeFileSync(workPaths(work).answers, JSON.stringify({ entries }));
    await assert.rejects(stepOn(work), refused(problem));
    assert.equal(recordOf(work).current.step, BUILD_CHECK_STEP.analyze);
  }
  cleanup(work);
});

// A run cut short after the record moved to analyze, but before the review file held its
// question, leaves the file the unpack mode handed out, asking nothing, or none. The next
// hand-back hands the question out again, and answering it carries on as usual.
test("an analyze question that was never written is handed out again", async () => {
  for (const cut of ["unpack file", "no file"]) {
    const work = workFolder({ "package.json": packageFile() });
    const file = workPaths(work).answers;
    if (cut === "unpack file") {
      writeReviewFile(file, reviewFile([]));
    } else {
      fs.rmSync(file);
    }
    const again = await stepOn(work);
    assert.equal(again.next, "step", cut);
    assert.equal(again.record.current.step, BUILD_CHECK_STEP.analyze, cut);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(file, "utf8")).entries,
      [{ index: "SCA_BUILD_SAFETY_ISSUES", answer: null }],
      cut
    );
    const at = await analyzeStep(work);
    assert.equal(at.record.current.step, BUILD_CHECK_STEP.permission, cut);
    cleanup(work);
  }
});

// Let it build: the root's lock is audited, and a clean one is built.
test("letting the agent build audits the lock", async () => {
  const work = workFolder(
    { "package.json": packageFile(), "package-lock.json": npmLock() },
    { vulns: TOOL_CLEAN }
  );
  await analyzeStep(work);
  answer(work, { SCA_BUILD_PERMISSION: "Let the agent build" });
  const at = await stepOn(work);
  assert.equal(at.next, "step");
  assert.equal(at.record.current.step, BUILD_CHECK_STEP.build);
  assert.equal(at.record.current.packageManagers, true);
  cleanup(work);
});

// Not letting it build: nothing is audited and nothing rescued, since a rescue runs
// package-manager commands. The lock is vulnerable and OSV is given no answer, so any
// audit would ask the switched-off network and fail. The folder is done at once.
test("not letting the agent build is done at once, with nothing audited", async () => {
  const work = workFolder(
    { "package.json": packageFile(), "package-lock.json": npmLock() },
    { cache: auditCache() }
  );
  const at = await first(work, { SCA_BUILD_PERMISSION: "Build it myself" });
  assert.equal(at.next, "review");
  assert.equal(at.record.current.step, BUILD_CHECK_STEP.done);
  assert.equal(at.record.current.packageManagers, false);
  assert.equal(at.record.current.vulnerabilities, null);
  assert.equal(at.record.current.buildResult, null, "nothing is built");
  assert.deepEqual(at.record.current.roots, {
    source: workPaths(work).sca,
    used: workPaths(work).sca,
    packageRoot: workPaths(work).sca,
  });
  assert.deepEqual(recordOf(work), at.record);
  assert.ok(!fs.existsSync(workPaths(work).rescued), "no copy is made");
  cleanup(work);
});

// The answer is one of the labels its entry offered, or the reviewer's own words, held to the
// rule a reviewer's note is: none at all, nothing in it, or too long is refused with the folder
// unchanged.
test("an answer to the permission question a reviewer could not give is refused", async () => {
  const work = workFolder({ "package.json": packageFile() });
  await analyzeStep(work);
  for (const [given, problem] of [
    [null, /SCA_BUILD_PERMISSION still has no "answer"/],
    ["   ", /SCA_BUILD_PERMISSION carries an answer with nothing in it/],
    ["x".repeat(5000), /SCA_BUILD_PERMISSION carries a 5000-character answer/],
  ]) {
    answer(work, { SCA_BUILD_PERMISSION: given });
    await assert.rejects(stepOn(work), refused(problem));
  }
  assert.equal(recordOf(work).current.step, BUILD_CHECK_STEP.permission);
  cleanup(work);
});

// A run cut short after it moved the record to `permission` and before it wrote the
// question leaves the analyze step's review file: the next hand-back writes the question
// and hands it out again, with nothing else changed.
test("a permission step without its question hands the question out again", async () => {
  const work = workFolder({ "package.json": packageFile() });
  await analyzeStep(work);
  const file = workPaths(work).answers;
  fs.writeFileSync(
    file,
    JSON.stringify({ entries: [{ index: "SCA_BUILD_SAFETY_ISSUES" }] })
  );
  const at = await stepOn(work);
  assert.equal(at.next, "step");
  assert.equal(at.record.current.step, BUILD_CHECK_STEP.permission);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(file, "utf8")).entries.map((e) => e.index),
    ["SCA_BUILD_PERMISSION"]
  );
  cleanup(work);
});

// The root is derived the way the review derives it: below a wrapper folder the archive put
// its contents in, the folder holding package.json, and that is what is recorded and audited.
test("a source in a wrapper folder is rooted in the folder below", async () => {
  const work = workFolder(
    {
      "proj/package.json": packageFile(),
      "proj/package-lock.json": npmLock(),
    },
    { vulns: TOOL_HIGH }
  );
  const at = await first(work);
  // Audited at the settled root: the build tool's advisory is found there, so it is rescued,
  // and the copy's root is the same folder in the copy.
  assert.equal(at.record.current.step, BUILD_CHECK_STEP.rescue);
  assert.equal(
    at.record.current.roots.packageRoot,
    path.join(workPaths(work).rescued, "proj")
  );
  cleanup(work);
});

// The rescue's whole case: a known vulnerability in the lock. The source is copied into the
// work folder's rescued/, beside sca/, and the record's roots move into the copy - a symbolic
// link copied as it is written. One folder, one record, holding the original lock's counts.
// The agent is handed the rescue, its one entry asking where the copy's build put what it
// produced, or that the rescue failed.
test("a source stopped only by a locked vulnerability gets a rescued copy", async () => {
  const work = workFolder(
    {
      "package.json": packageFile(),
      "package-lock.json": npmLock(),
    },
    { vulns: TOOL_HIGH }
  );
  fs.symlinkSync("bg.js", path.join(workPaths(work).sca, "link.js"));
  const at = await first(work);
  const copy = workPaths(work).rescued;
  assert.equal(at.next, "step");
  assert.equal(at.record.current.step, BUILD_CHECK_STEP.rescue);
  assert.equal(at.record.current.roots.packageRoot, copy);
  assert.deepEqual(at.record.current.vulnerabilities, ONE_HIGH);
  assert.equal(at.record.current.buildResult, null);
  assert.deepEqual(recordOf(work), at.record);
  const [output, match, ...rest] = reviewEntries(work);
  assert.deepEqual(rest, []);
  assert.equal(output.index, "LLM_BUILD_OUTPUT");
  assert.deepEqual(
    output.answers.map((a) => a.label),
    ["The rescue failed"]
  );
  assert.equal(match.index, "LLM_BUILD_XPI_MATCH");
  assert.deepEqual(
    match.answers.map((a) => a.label),
    ["match", "no match"]
  );
  assert.equal(
    fs.readFileSync(path.join(copy, "package.json"), "utf8"),
    packageFile()
  );
  assert.equal(fs.readlinkSync(path.join(copy, "link.js")), "bg.js");
  cleanup(work);
});

// A pnpm lock is read the same way: the advisory sits in the tree, anchored at
// pnpm-lock.yaml, which is a file a rescue changes.
test("a pnpm tree vulnerability is rescued like an npm one", async () => {
  const lock = [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    devDependencies:",
    "      lint-pebble:",
    "        specifier: 0.4.0",
    "        version: 0.4.0",
    "",
    "packages:",
    "",
    "  lint-pebble@0.4.0:",
    "    resolution: {integrity: sha512-aaaa==}",
    "",
    "  argv-crumb@0.0.8:",
    "    resolution: {integrity: sha512-bbbb==}",
    "",
    "snapshots:",
    "",
    "  lint-pebble@0.4.0:",
    "    dependencies:",
    "      argv-crumb: 0.0.8",
    "",
    "  argv-crumb@0.0.8: {}",
    "",
  ].join("\n");
  const work = workFolder(
    {
      "package.json": packageFile(),
      "pnpm-lock.yaml": lock,
    },
    {
      vulns: {
        ...TOOL_CLEAN,
        "argv-crumb@0.0.8": [
          advisory("GHSA-crumb", "CRITICAL", "argv-crumb", "0.0.10"),
        ],
      },
    }
  );
  const at = await first(work);
  assert.equal(at.record.current.step, BUILD_CHECK_STEP.rescue);
  assert.deepEqual(at.record.current.vulnerabilities, {
    moderate: 0,
    high: 0,
    critical: 1,
  });
  cleanup(work);
});

// ---- the Experiment folder the unpack hand-back reads back ----

// Unpack is a mode of its own, before the build check: where the add-on declares
// Experiments, its answers file asks for the Experiment folder, which the agent names as the
// absolute path it has inside sca/. An answer missing, blank or relative is refused. Where
// the add-on declares none, nothing is asked and nothing read.
test("the unpack hand-back reads the Experiment folder as an absolute path", () => {
  const work = workFolder({ "exp/api.js": "" });
  const sca = workPaths(work).sca;
  const unpacking = (experiments) => {
    const record = recordOf(work);
    return startMode(
      { ...record, submission: { ...record.submission, experiments } },
      MODE.unpack,
      {},
      "unpack"
    );
  };
  assert.deepEqual(unpackEntries(unpacking(false)), []);
  assert.equal(unpackedExperiments(work, unpacking(false)), undefined);
  const record = unpacking(true);
  writeReviewFile(workPaths(work).answers, reviewFile(unpackEntries(record)));
  assert.deepEqual(reviewEntries(work), [
    { index: "SCA_EXPERIMENTS", answer: null },
  ]);
  for (const [given, problem] of [
    [null, 'SCA_EXPERIMENTS still has no "answer"'],
    ["   ", "SCA_EXPERIMENTS names no folder"],
    ["exp", 'SCA_EXPERIMENTS "exp" is not an absolute path'],
  ]) {
    answer(work, { SCA_EXPERIMENTS: given });
    assert.throws(
      () => unpackedExperiments(work, record),
      refused(problem),
      String(given)
    );
  }
  answer(work, { SCA_EXPERIMENTS: ` ${path.join(sca, "exp")} ` });
  assert.equal(unpackedExperiments(work, record), path.join(sca, "exp"));
  cleanup(work);
});

// ---- not rescued ----
// Each of these is built as it is, or done at once, and its review decides the rest.

// The build check audits the lock alone: a library committed to the archive is the review's
// to report, and the clean lock beside it is built.
test("a vulnerable library committed to the archive is not rescued", async () => {
  const work = workFolder(
    {
      "package.json": packageFile(null),
      "package-lock.json": npmLock(null),
      "vendor/bootstrap.min.css": fs.readFileSync(
        path.join(
          ROOT,
          "tests/addons/sca-undeclared-library/src/vendor/bootstrap/bootstrap.min.css"
        )
      ),
    },
    {
      vulns: {
        "bootstrap@5.3.0": [advisory("GHSA-css", "HIGH", "bootstrap", "5.3.1")],
      },
    }
  );
  const at = await first(work);
  assert.equal(at.record.current.step, BUILD_CHECK_STEP.build);
  assert.ok(!fs.existsSync(workPaths(work).rescued), "no copy is made");
  cleanup(work);
});

// The build check looks at the lock and nothing else: a review that will stop for another
// reason as well is rescued all the same, and stops on that reason after.
test("a vulnerable lock beside another reason to stop is rescued", async () => {
  const work = workFolder(
    {
      "package.json": packageFile(),
      "package-lock.json": npmLock(),
      ".npmrc": "registry=https://registry.example.invalid/\n",
    },
    { vulns: TOOL_HIGH }
  );
  const at = await first(work);
  assert.equal(at.record.current.step, BUILD_CHECK_STEP.rescue);
  cleanup(work);
});

/** A done folder whose lock the audit could not read in full: nothing was built, nothing
 *  counted, nothing copied. */
function notAudited(work, at) {
  assert.equal(at.next, "review");
  assert.equal(at.record.current.step, BUILD_CHECK_STEP.done);
  assert.equal(at.record.current.vulnerabilities, null);
  assert.equal(at.record.current.buildResult, null, "nothing is built");
  assert.ok(!fs.existsSync(workPaths(work).rescued), "no copy is made");
  assert.ok(!fs.existsSync(workPaths(work).buildCopy), "nothing is built");
}

// A lock entry that names one release and installs another is a lock the audit cannot trust
// to say what is installed: it is not audited at all - no request reaches OSV - and neither
// built nor rescued, and the review it is handed to stops on it.
test("a forged lock is neither audited nor rescued", async () => {
  const work = workFolder({
    "package.json": packageFile(),
    "package-lock.json": npmLock("0.4.0", {
      "node_modules/lint-pebble": {
        version: "0.4.0",
        dev: true,
        resolved:
          "https://registry.npmjs.org/lint-pebble/-/lint-pebble-0.3.9.tgz",
      },
    }),
  });
  notAudited(work, await first(work));
  cleanup(work);
});

// More than one lock is a source the audit cannot trust either: it would read one while the
// build installs from another. Not audited - no request reaches OSV - neither built nor
// rescued, and the review it is handed to stops on it (sca-lock-file-multiple).
test("a source with more than one lock is neither audited nor built", async () => {
  const work = workFolder({
    "package.json": packageFile(),
    "package-lock.json": npmLock(),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
  });
  notAudited(work, await first(work));
  cleanup(work);
});

test("a source the audit cannot read in full is neither built nor rescued", async (t) => {
  await t.test("no lock at all", async () => {
    const work = workFolder(
      { "package.json": packageFile() },
      { vulns: TOOL_HIGH }
    );
    notAudited(work, await first(work));
    cleanup(work);
  });
  await t.test("a lock that does not parse", async () => {
    const work = workFolder(
      {
        "package.json": packageFile(),
        "package-lock.json": '{"packages": {',
      },
      { vulns: TOOL_HIGH }
    );
    notAudited(work, await first(work));
    cleanup(work);
  });
  await t.test("a file the loader cannot read", async () => {
    const work = workFolder(
      {
        "package.json": packageFile(),
        "package-lock.json": npmLock(),
        "secret.js": "",
      },
      { vulns: TOOL_HIGH }
    );
    fs.chmodSync(path.join(workPaths(work).sca, "secret.js"), 0);
    notAudited(work, await first(work));
    cleanup(work);
  });
});

// A declared package that is not a confirmed widely-used library is one nobody can review, and
// the review aborts on it. So nothing is built that runs it, and a vulnerable lock is not
// rescued either. The audit read the tree in full, so its counts are recorded.
test("a lock declaring a package nobody can review is neither built nor rescued", async () => {
  const work = workFolder(
    {
      "package.json": packageFile(),
      "package-lock.json": npmLock(),
    },
    { cache: auditCache(TOOL_HIGH, ["lint-pebble"]) }
  );
  const at = await first(work);
  assert.equal(at.next, "review");
  assert.equal(at.record.current.step, BUILD_CHECK_STEP.done);
  assert.deepEqual(at.record.current.vulnerabilities, ONE_HIGH);
  assert.equal(at.record.current.buildResult, null, "nothing is built");
  assert.ok(!fs.existsSync(workPaths(work).rescued), "no copy is made");
  assert.ok(!fs.existsSync(workPaths(work).buildCopy), "nothing is built");
  cleanup(work);
});

// ---- the rescue ----

/** A work folder rescued for the build tool's advisory: the copy, at `rescue`. Its audits
 *  are answered from `vulns`, which holds that advisory. */
async function rescued(vulns = TOOL_HIGH) {
  const work = workFolder(
    {
      "package.json": packageFile(),
      "package-lock.json": npmLock(),
    },
    { vulns }
  );
  const at = await first(work);
  return {
    work,
    copy: workPaths(work).rescued,
    root: at.record.current.roots.packageRoot,
  };
}

/** A rescue that failed: done, its roots back in sca/, the copy left in place and its build
 *  deleted, the original lock's counts recorded, and beside them the copy's, as its audit
 *  found them. */
function rescueFailed(work, at, copyCounts) {
  assert.equal(at.next, "review");
  assert.equal(at.record.current.step, BUILD_CHECK_STEP.done);
  assert.equal(at.record.current.buildResult, "rescue-failed");
  assert.equal(at.record.current.buildOutput, null);
  assert.equal(at.record.current.buildMatch, null);
  assert.equal(at.record.current.roots.packageRoot, workPaths(work).sca);
  assert.deepEqual(at.record.current.vulnerabilities, ONE_HIGH);
  assert.deepEqual(at.record.current.rescuedVulnerabilities, copyCounts);
  assert.deepEqual(recordOf(work), at.record);
  assert.ok(fs.existsSync(workPaths(work).rescued), "the copy stays");
  assert.ok(!fs.existsSync(workPaths(work).buildCopy), "the build is deleted");
}

// The copy's lock audits clean, and the output the agent named lies inside it: the folder is
// done with the copy as the reviewed source, its build recorded, the original's counts kept,
// and the copy's own counts beside them, a moderate advisory left in it included.
test("a clean copy with its build output is done with the copy's roots", async () => {
  const { work, copy, root } = await rescued({
    ...TOOL_HIGH,
    "lint-pebble@0.4.1": [
      advisory("GHSA-tool-moderate", "MODERATE", "lint-pebble", "0.4.2"),
    ],
  });
  writeTree(root, {
    "package.json": packageFile("0.4.1"),
    "package-lock.json": npmLock("0.4.1"),
  });
  const output = buildRescued(work, root);
  const at = await handOutput(work, output);
  assert.equal(at.next, "review");
  assert.equal(at.record.current.step, BUILD_CHECK_STEP.done);
  assert.equal(
    at.record.current.roots.packageRoot,
    root,
    "the copy is what is reviewed"
  );
  assert.equal(at.record.current.buildResult, "built");
  assert.equal(at.record.current.buildOutput, output);
  assert.deepEqual(at.record.current.vulnerabilities, ONE_HIGH);
  assert.deepEqual(at.record.current.rescuedVulnerabilities, {
    moderate: 1,
    high: 0,
    critical: 0,
  });
  assert.deepEqual(recordOf(work), at.record);
  assert.ok(fs.existsSync(copy));
  assert.ok(!fs.existsSync(workPaths(work).answers), "the review file is gone");
  cleanup(work);
});

// A rescue's comparison is recorded beside its output, and goes with an output only, as a
// build's does.
test("a rescue's comparison is recorded, and refused without an output", async () => {
  const { work, root } = await rescued({
    ...TOOL_HIGH,
    "lint-pebble@0.4.1": [],
  });
  writeTree(root, {
    "package.json": packageFile("0.4.1"),
    "package-lock.json": npmLock("0.4.1"),
  });
  const output = buildRescued(work, root);
  for (const [named, match, problem] of [
    [
      "The rescue failed",
      "no match",
      'LLM_BUILD_XPI_MATCH answers "no match", but LLM_BUILD_OUTPUT answers "The rescue failed"',
    ],
    [output, null, 'LLM_BUILD_XPI_MATCH still has no "answer"'],
  ]) {
    await assert.rejects(handOutput(work, named, match), refused(problem));
  }
  assert.equal(recordOf(work).current.step, BUILD_CHECK_STEP.rescue);
  const at = await handOutput(work, output, "match");
  assert.equal(at.record.current.buildResult, "built");
  assert.equal(at.record.current.buildMatch, "match");
  assert.deepEqual(recordOf(work), at.record);
  cleanup(work);
});

// The linter audits the copy itself: a copy still vulnerable fails the rescue, whatever
// the agent built from it.
test("a copy still vulnerable on its audit fails the rescue", async () => {
  const { work, root } = await rescued();
  rescueFailed(
    work,
    await handOutput(work, buildRescued(work, root)),
    ONE_HIGH
  );
  // Handed back again, its review is handed out once more, asking nothing.
  const again = await stepOn(work);
  assert.equal(again.next, "review");
  assert.deepEqual(again.record, recordOf(work));
  cleanup(work);
});

// The agent's own word that the rescue failed is taken, and the copy goes. It is audited
// first, so the record counts what the agent left in it: here a fixed release with a
// moderate advisory, which the original lock does not hold.
test("a rescue the agent answers as failed fails", async () => {
  const { work, root } = await rescued({
    ...TOOL_HIGH,
    "lint-pebble@0.4.1": [
      advisory("GHSA-tool-moderate", "MODERATE", "lint-pebble", "0.4.2"),
    ],
  });
  writeTree(root, {
    "package.json": packageFile("0.4.1"),
    "package-lock.json": npmLock("0.4.1"),
  });
  rescueFailed(work, await handOutput(work, "The rescue failed"), {
    moderate: 1,
    high: 0,
    critical: 0,
  });
  cleanup(work);
});

// An output is something the build produced inside build/, never in the rescued copy, where
// nothing is built. One that names anything else fails the rescue, even where the copy itself
// is clean.
test("a rescue output outside build/ fails the rescue", async (t) => {
  for (const [name, named] of [
    ["outside the copies", (work) => workPaths(work).sca],
    ["inside the rescued copy", (work, root) => buildInto(root)],
    ["build/ itself", (work) => workPaths(work).buildCopy],
    ["missing", (work) => path.join(workPaths(work).buildCopy, "dist")],
  ]) {
    await t.test(name, async () => {
      const { work, root } = await rescued();
      writeTree(root, {
        "package.json": packageFile(null),
        "package-lock.json": npmLock(null),
      });
      writeTree(workPaths(work).buildCopy, { "notes.txt": "" });
      rescueFailed(work, await handOutput(work, named(work, root)), NONE);
      cleanup(work);
    });
  }
});

// An answer that is neither a path nor the label is refused, with nothing changed.
test("a rescue answer that names no path is refused", async () => {
  const { work } = await rescued();
  await assert.rejects(
    handOutput(work, "  "),
    refused(
      'LLM_BUILD_OUTPUT names no path and does not answer "The rescue failed"'
    )
  );
  assert.equal(recordOf(work).current.step, BUILD_CHECK_STEP.rescue);
  assert.ok(fs.existsSync(workPaths(work).rescued));
  cleanup(work);
});

// The build check is one run with its review: OSV is asked through the run's cache in the
// work folder. A step over a lock already audited asks OSV nothing, and the advisory it
// reads there is what rescues the copy.
test("the audit reads the run's OSV cache", async () => {
  const work = workFolder(
    {
      "package.json": packageFile(),
      "package-lock.json": npmLock(),
    },
    { cache: null }
  );
  seedRunOsv(work, liveAudit(TOOL_HIGH));
  seedRunPopularity(work);
  const at = await first(work);
  assert.equal(at.record.current.step, BUILD_CHECK_STEP.rescue);
  assert.ok(allAnswered(path.join(work, ".cache", "osv.json")));
  // The copy's audit reads the same lock from the same cache, and finds it vulnerable.
  rescueFailed(
    work,
    await handOutput(
      work,
      buildRescued(work, at.record.current.roots.packageRoot)
    ),
    ONE_HIGH
  );
  cleanup(work);
});

// A run that names its cache folder (--cache-work-dir, forwarded in the record) keeps OSV's
// answers there instead, so the build check and its review read the folder a test seeded.
test("a step asks through the cache folder its record names", async () => {
  const dir = seedWorkCache({
    osv: liveAudit(TOOL_HIGH),
    popularity: POPULAR_TOOL,
  });
  const work = workFolder(
    {
      "package.json": packageFile(),
      "package-lock.json": npmLock(),
    },
    { cache: dir }
  );
  const at = await first(work);
  assert.equal(
    at.record.current.step,
    BUILD_CHECK_STEP.rescue,
    "the advisory was read"
  );
  assert.ok(allAnswered(path.join(dir, "osv.json")));
  assert.ok(!fs.existsSync(path.join(work, ".cache")));
  cleanup(work);
});

// A copy is clean only where the audit can vouch for it. Each of these would otherwise read
// as a lock with no advisory left in it, and fails the rescue.
test("a copy the audit cannot vouch for is not clean", async (t) => {
  const cases = {
    "its lock deleted": (root) =>
      fs.rmSync(path.join(root, "package-lock.json")),
    "its lock unreadable": (root) =>
      writeTree(root, { "package-lock.json": "{ not json" }),
    "its lock pointed at git": (root) =>
      writeTree(root, {
        "package-lock.json": npmLock("0.4.0", {
          "node_modules/lint-pebble": {
            version: "0.4.0",
            dev: true,
            resolved: "git+ssh://git@example.invalid/pebble.git#abc",
          },
        }),
      }),
    "its lock forged to name a fixed release": (root) =>
      writeTree(root, {
        "package-lock.json": npmLock("0.4.0", {
          "node_modules/lint-pebble": {
            version: "0.4.1",
            dev: true,
            resolved:
              "https://registry.npmjs.org/lint-pebble/-/lint-pebble-0.4.0.tgz",
          },
        }),
      }),
    "a file the loader cannot read": (root) => {
      writeTree(root, {
        "package.json": packageFile(null),
        "package-lock.json": npmLock(null),
        "secret.js": "",
      });
      fs.chmodSync(path.join(root, "secret.js"), 0);
    },
  };
  for (const [name, edit] of Object.entries(cases)) {
    await t.test(name, async () => {
      const { work, root } = await rescued();
      const output = buildRescued(work, root);
      edit(root);
      rescueFailed(work, await handOutput(work, output), null);
      cleanup(work);
    });
  }
});

// OSV answering 404 is no answer: it says nothing about the tree, so the build check ends as
// the tool's failure, with the record where it was, for the folder to be handed back once OSV
// answers again - at the step that audits the root, and at the rescue's.
test("an audit OSV does not answer ends the build check", async (t) => {
  const noAnswer = (err) =>
    err instanceof NoAnswerError && /querybatch \(HTTP 404\)/.test(err.message);
  await t.test("at the permission step", async () => {
    const work = workFolder(
      {
        "package.json": packageFile(),
        "package-lock.json": npmLock(),
      },
      {
        cache: seedWorkCache({
          osv: batchDown("lint-pebble@0.4.0"),
          popularity: POPULAR_TOOL,
        }),
      }
    );
    await assert.rejects(first(work), noAnswer);
    assert.equal(recordOf(work).current.step, BUILD_CHECK_STEP.permission);
    cleanup(work);
  });
  await t.test("at the rescue", async () => {
    const { work, root } = await rescued();
    // A package the run has not asked OSV about yet, so the copy's audit asks.
    writeTree(root, {
      "package.json": packageFile(null),
      "package-lock.json": npmLock(null, {
        "node_modules/argv-crumb": { version: "0.0.8", dev: true },
      }),
    });
    seedRunOsv(work, batchDown("argv-crumb@0.0.8"));
    await assert.rejects(handOutput(work, buildRescued(work, root)), noAnswer);
    assert.equal(recordOf(work).current.step, BUILD_CHECK_STEP.rescue);
    assert.ok(fs.existsSync(workPaths(work).rescued), "the copy stays");
    assert.ok(fs.existsSync(workPaths(work).buildCopy), "the build stays");
    cleanup(work);
  });
});

// ---- order, and runs cut short ----

// A run cut short after the copy was made and the record moved on, before the question was
// written, leaves the permission step's review file: the next hand-back writes the question
// again, and the rescue carries on.
test("a rescue without its question hands the question out again", async () => {
  const { work } = await rescued();
  fs.writeFileSync(
    workPaths(work).answers,
    JSON.stringify({ entries: [{ index: "SCA_BUILD_PERMISSION" }] })
  );
  const again = await stepOn(work);
  assert.equal(again.next, "step");
  assert.equal(again.record.current.step, BUILD_CHECK_STEP.rescue);
  assert.deepEqual(
    reviewEntries(work).map((e) => e.index),
    ["LLM_BUILD_OUTPUT", "LLM_BUILD_XPI_MATCH"]
  );
  cleanup(work);
});

// A finished build check is not audited again: its review is handed out once more, for the
// hand-back to start again, and the build check's answers file, which no prompt names any
// more, is deleted again, in case the run that marked it was cut short before it could.
test("a done folder handed back again hands out its review again", async () => {
  const { work } = await clean();
  const done = await handOutput(work, buildInto(workPaths(work).buildCopy));
  fs.writeFileSync(workPaths(work).answers, "{}");
  const again = await stepOn(work);
  assert.equal(again.next, "review");
  assert.deepEqual(again.record, done.record);
  assert.ok(!fs.existsSync(workPaths(work).answers));
  cleanup(work);
});

// A clean rescue's folder handed back again keeps its copy: its roots lie there, so the copy
// is what its review reads.
test("a clean rescue handed back again keeps its copy", async () => {
  const { work, copy, root } = await rescued();
  writeTree(root, {
    "package.json": packageFile(null),
    "package-lock.json": npmLock(null),
  });
  await handOutput(work, buildRescued(work, root));
  const again = await stepOn(work);
  assert.equal(again.next, "review");
  assert.equal(again.record.current.roots.packageRoot, root);
  assert.ok(fs.existsSync(copy));
  assert.ok(fs.existsSync(workPaths(work).buildCopy), "its build stays");
  cleanup(work);
});

// A failed rescue cut short after the folder was marked done leaves its build behind. The
// next hand-back finishes removing it, keeps the copy, and hands the review out.
test("a failed rescue cut short keeps its copy and removes its build", async () => {
  const { work, copy, root } = await rescued();
  buildRescued(work, root);
  forge(work, (current) => ({
    ...current,
    step: BUILD_CHECK_STEP.done,
    roots: {
      source: workPaths(work).sca,
      used: workPaths(work).sca,
      packageRoot: workPaths(work).sca,
    },
    buildResult: "rescue-failed",
  }));
  assert.ok(fs.existsSync(copy));
  const at = await stepOn(work);
  assert.equal(at.next, "review");
  assert.ok(fs.existsSync(copy), "the copy stays");
  assert.ok(!fs.existsSync(workPaths(work).buildCopy), "the build is removed");
  cleanup(work);
});

// The agent can write any file, records included, so no record decides what is deleted: the
// only folder the build check ever removes is the work folder's own build/, whatever the
// record names.
test("a forged record never removes a folder outside the work folder", async () => {
  const { work } = await rescued();
  const stray = path.join(path.dirname(work), "stray");
  fs.mkdirSync(stray);
  // Roots that name a folder outside the work folder, at the failed rescue that removes the
  // build.
  forge(work, (current) => ({
    ...current,
    step: BUILD_CHECK_STEP.done,
    roots: {
      source: workPaths(work).sca,
      used: workPaths(work).sca,
      packageRoot: stray,
    },
    buildResult: "rescue-failed",
  }));
  fs.mkdirSync(workPaths(work).buildCopy, { recursive: true });
  await stepOn(work);
  assert.ok(fs.existsSync(stray));
  assert.ok(fs.existsSync(workPaths(work).rescued), "the copy stays");
  assert.ok(!fs.existsSync(workPaths(work).buildCopy), "the build is removed");
  cleanup(work);
});

// The record is the linter's alone: every write leaves it read-only, the plainest signal that
// it is out of the agent's reach - at every step.
test("every record the build check writes is read-only", async () => {
  const mode = (folder) => fs.statSync(workPaths(folder).state).mode & 0o777;
  const work = workFolder(
    {
      "package.json": packageFile(),
      "package-lock.json": npmLock(),
    },
    { vulns: TOOL_HIGH }
  );
  assert.equal(mode(work), 0o444, "as the build check starts");
  await first(work);
  assert.equal(mode(work), 0o444, "at the rescue");
  await handOutput(work, "The rescue failed");
  assert.equal(mode(work), 0o444, "rescue failed");
  const { work: built } = await clean();
  assert.equal(mode(built), 0o444, "at the build");
  await handOutput(built, "The build failed");
  assert.equal(mode(built), 0o444, "build failed");
  cleanup(work);
  cleanup(built);
});

// Every write stores a hash over the record, so a change made after it - even a plausible
// one, like the root it names - is caught on the next read: the record cannot be carried on.
test("a record changed after the linter wrote it cannot be carried on", async () => {
  const { work } = await rescued();
  const file = workPaths(work).state;
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.current.roots.experiments = record.current.roots.packageRoot;
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, JSON.stringify(record, null, 1));
  await assert.rejects(
    stepOn(work),
    failed("it was changed after the linter wrote it")
  );
  cleanup(work);
});

// A boolean in the record is true or false, as the linter writes it. Anything else was put
// there by an edit, and the record cannot be carried on rather than having a meaning read
// into it.
test("a record boolean that is neither true nor false cannot be carried on", async () => {
  const { work } = await rescued();
  const record = recordOf(work);
  writeRecord(work, {
    ...record,
    submission: { ...record.submission, experiments: "yes" },
  });
  await assert.rejects(
    stepOn(work),
    failed("holds submission.experiments as neither true nor false")
  );
  cleanup(work);
});

test("a packageManagers that is neither true nor false cannot be carried on", async () => {
  const { work } = await rescued();
  forge(work, (current) => ({ ...current, packageManagers: "no" }));
  await assert.rejects(
    stepOn(work),
    failed("holds packageManagers as neither true nor false")
  );
  cleanup(work);
});

// The record's folders are the extracted copy and the package root, and the Experiment
// folder exactly where the add-on declares Experiments, as the linter writes them. Anything
// else was put there by an edit.
test("a record's folders of another shape cannot be carried on", async () => {
  const { work } = await rescued();
  const before = recordOf(work);
  const roots = before.current.roots;
  const shape =
    "holds no source copy, reviewed copy and package root of the shape the linter writes";
  const current = (over) => ({ current: { ...before.current, ...over } });
  for (const [edit, problem] of [
    [current({ roots: null }), shape],
    [current({ roots: { source: roots.source, used: roots.used } }), shape],
    [
      current({ roots: { ...roots, scaPackageRoot: roots.packageRoot } }),
      shape,
    ],
    [current({ roots: { ...roots, experiments: "" } }), shape],
    [
      current({ roots: { ...roots, experiments: roots.packageRoot } }),
      "names an Experiment folder for an add-on without Experiments",
    ],
    [
      { submission: { ...before.submission, experiments: true } },
      "names no Experiment folder for an add-on with Experiments",
    ],
  ]) {
    writeRecord(work, { ...before, ...edit });
    await assert.rejects(stepOn(work), failed(problem), JSON.stringify(edit));
  }
  cleanup(work);
});

// The judgement is one the agent can give, and the record of a step it is known at holds
// one: anything else was put there by an edit.
test("a buildSafety its buildIssues do not give cannot be carried on", async () => {
  const { work } = await rescued();
  const before = recordOf(work);
  for (const edit of [
    { buildSafety: "maybe" },
    { buildSafety: null },
    { buildSafety: "unsafe" },
    { buildIssues: null },
    { buildIssues: [{ file: "package.json", line: 0, hint: "x" }] },
  ]) {
    writeRecord(work, { ...before, current: { ...before.current, ...edit } });
    await assert.rejects(
      stepOn(work),
      failed("holds buildSafety as no verdict its buildIssues give"),
      JSON.stringify(edit)
    );
  }
  cleanup(work);
});

// The counts and the build result are held only at the steps that can know them, each of the
// shape the linter writes, and a build only where the agent may build. Anything else was put
// there by an edit.
test("a build record the linter would not write cannot be carried on", async (t) => {
  const cases = [
    [
      "counts before the audit",
      (r) => ({
        ...r,
        step: BUILD_CHECK_STEP.permission,
        packageManagers: null,
        buildSafe: null,
      }),
      "holds vulnerabilities as no count the linter writes",
    ],
    [
      "no counts at the rescue",
      (r) => ({ ...r, vulnerabilities: null }),
      "holds vulnerabilities as no count the linter writes",
    ],
    [
      "a count that is no whole number",
      (r) => ({ ...r, vulnerabilities: { ...ONE_HIGH, high: "1" } }),
      "holds vulnerabilities as no count the linter writes",
    ],
    [
      "a count of another severity",
      (r) => ({ ...r, vulnerabilities: { ...ONE_HIGH, low: 0 } }),
      "holds vulnerabilities as no count the linter writes",
    ],
    [
      "a rescued count while the agent builds",
      (r) => ({ ...r, rescuedVulnerabilities: ONE_HIGH }),
      "holds rescuedVulnerabilities as no count the linter writes",
    ],
    [
      "a rescued count of another severity",
      (r) => ({
        ...r,
        step: BUILD_CHECK_STEP.done,
        buildResult: "rescue-failed",
        rescuedVulnerabilities: { ...ONE_HIGH, low: 0 },
      }),
      "holds rescuedVulnerabilities as no count the linter writes",
    ],
    [
      "a result before the build is handed back",
      (r) => ({ ...r, buildResult: "built", buildOutput: r.roots.packageRoot }),
      "holds buildResult as no result the linter writes",
    ],
    [
      "a result the linter does not write",
      (r) => ({ ...r, step: BUILD_CHECK_STEP.done, buildResult: "maybe" }),
      "holds buildResult as no result the linter writes",
    ],
    [
      "a build without its output",
      (r) => ({ ...r, step: BUILD_CHECK_STEP.done, buildResult: "built" }),
      "holds buildOutput without a build that produced it",
    ],
    [
      "an output without a build",
      (r) => ({
        ...r,
        step: BUILD_CHECK_STEP.done,
        buildResult: "failed",
        buildOutput: r.roots.packageRoot,
      }),
      "holds buildOutput without a build that produced it",
    ],
    [
      "a comparison without a build",
      (r) => ({
        ...r,
        step: BUILD_CHECK_STEP.done,
        buildResult: "failed",
        buildMatch: "no match",
      }),
      "holds buildMatch without a build that produced an output",
    ],
    [
      "a build without its comparison",
      (r) => ({
        ...r,
        step: BUILD_CHECK_STEP.done,
        buildResult: "built",
        buildOutput: r.roots.packageRoot,
      }),
      "holds a built result without buildMatch",
    ],
    [
      "a comparison the agent cannot give",
      (r) => ({
        ...r,
        step: BUILD_CHECK_STEP.done,
        buildResult: "built",
        buildOutput: r.roots.packageRoot,
        buildMatch: "close enough",
      }),
      "holds buildMatch as no answer the agent can give",
    ],
    [
      "a build the reviewer did not allow",
      (r) => ({ ...r, packageManagers: false }),
      "builds where the agent may not build",
    ],
  ];
  for (const [name, edit, problem] of cases) {
    await t.test(name, async () => {
      const { work } = await rescued();
      forge(work, edit);
      await assert.rejects(stepOn(work), failed(problem));
      cleanup(work);
    });
  }
});

// The copy is the run's own, inside its work folder: one an earlier hand-back left behind, cut
// short before the record moved on, is simply made again. A copy that cannot be made ends the
// run before any prompt names it, and the record stays at the step that audited, so handing
// the folder back retries.
test("a rescued copy is made again over a stale one", async () => {
  const work = workFolder(
    {
      "package.json": packageFile(),
      "package-lock.json": npmLock(),
    },
    { vulns: TOOL_HIGH }
  );
  const copy = workPaths(work).rescued;
  fs.mkdirSync(copy);
  fs.writeFileSync(path.join(copy, "left-over.txt"), "stale");
  const at = await first(work);
  assert.equal(at.record.current.step, BUILD_CHECK_STEP.rescue);
  assert.ok(!fs.existsSync(path.join(copy, "left-over.txt")));
  assert.ok(fs.existsSync(path.join(copy, "package.json")));
  cleanup(work);
});

test("a rescued copy that cannot be made ends the build check", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root writes any folder");
    return;
  }
  const work = workFolder(
    {
      "package.json": packageFile(),
      "package-lock.json": npmLock(),
    },
    { vulns: TOOL_HIGH }
  );
  await analyzeStep(work);
  answer(work, {});
  fs.chmodSync(work, 0o555);
  try {
    await assert.rejects(stepOn(work), (err) => {
      assert.ok(!(err instanceof HandbackRefused), err.message);
      assert.match(
        err.message,
        /^The rescued copy ".+rescued" could not be made \(\w+\)\. Hand the work folder back once that is fixed\.$/
      );
      return true;
    });
  } finally {
    fs.chmodSync(work, 0o755);
  }
  assert.equal(recordOf(work).current.step, BUILD_CHECK_STEP.permission);
  cleanup(work);
});

// Every path a record holds is read by a later run, from any directory, so each is written
// absolute - and a record about to hold a relative one is refused at the write, naming it.
test("a record holding a relative path is never written", async () => {
  const { work } = await rescued();
  const record = recordOf(work);
  const current = (over) => ({ current: { ...record.current, ...over } });
  const relative = {
    "submission.xpi": {
      submission: { ...record.submission, xpi: "addon.xpi" },
    },
    "current.roots.packageRoot": current({
      roots: { ...record.current.roots, packageRoot: "sca" },
    }),
    "current.roots.experiments": current({
      roots: { ...record.current.roots, experiments: "exp" },
    }),
    "current.buildOutput": current({ buildOutput: "build/dist" }),
    "folders.rescued": { folders: { ...record.folders, rescued: "rescued" } },
    "flags.cache-schema-dir": { flags: { "cache-schema-dir": "cache" } },
  };
  for (const [field, over] of Object.entries(relative)) {
    assert.throws(
      () => writeRecord(work, { ...record, ...over }),
      (err) => {
        assert.ok(err.message.includes(`and ${field} is not.`), err.message);
        return true;
      },
      field
    );
  }
  cleanup(work);
});

// ---- sca-dependencies-changed: what a rescued review tells the developer ----

/** The check run on a source archive written from `files`, beside the original package
 *  files `original` (null for a source that is no rescued copy). */
function changed(files, original) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-changed-"));
  writeTree(dir, files);
  const artifact = loadSourceArchive(dir);
  artifact.originalPackages = original && {
    files: new Map(
      Object.entries(original).map(([name, text]) => [name, Buffer.from(text)])
    ),
  };
  const { findings } = depsChanged.run({ artifact });
  fs.rmSync(dir, { recursive: true, force: true });
  return findings.map((f) => [
    `${f.file}${f.loc?.line ? `:${f.loc.line}` : ""}`,
    f.item,
  ]);
}

test("sca-dependencies-changed says nothing for a source that is no rescued copy", () => {
  const files = {
    "package.json": packageFile(),
    "package-lock.json": npmLock(),
  };
  assert.deepEqual(changed(files, null), []);
  // A copy whose lock installs what the original's did has nothing to say either - a
  // package.json edit alone included, since the lock is what the install follows.
  assert.deepEqual(
    changed({ ...files, "package.json": packageFile(null) }, files),
    []
  );
});

test("sca-dependencies-changed says once, at package.json, that the copy changed", () => {
  const original = {
    "package.json": packageFile("0.4.0"),
    "package-lock.json": npmLock("0.4.0", {
      "node_modules/tidy-lantern": { version: "2.1.0" },
      "node_modules/wick-trim": { version: "1.0.1" },
    }),
  };
  // A declared tool removed: one finding, no list - the developer's own audit names what to
  // fix.
  const reduced = {
    "package.json": packageFile(null),
    "package-lock.json": npmLock(null, {
      "node_modules/tidy-lantern": { version: "2.1.0" },
      "node_modules/wick-trim": { version: "1.0.1" },
    }),
  };
  assert.deepEqual(changed(reduced, original), [["package.json", null]]);
  // A moved release alone is a change too.
  const relocked = {
    ...original,
    "package-lock.json": npmLock("0.4.0", {
      "node_modules/tidy-lantern": { version: "2.1.0" },
      "node_modules/wick-trim": { version: "1.0.3" },
    }),
  };
  assert.deepEqual(changed(relocked, original), [["package.json", null]]);
});

// ---- the folders the record names ----

// The record names each of the submission's folders once the step that made it is done: the
// add-on's copy and the source from the start of the build check, and the rescued copy from
// the rescue on. Those are the folders the hand-back checks before any step is taken
// (namedFolders), and the build copy, which the agent may replace, is none of them.
test("the record names the folders the linter made for the build check", async () => {
  const work = workFolder(
    { "package.json": packageFile(), "package-lock.json": npmLock() },
    { vulns: TOOL_HIGH }
  );
  const { xpi, sca, rescued } = workPaths(work);
  assert.deepEqual(namedFolders(recordOf(work)), [xpi, sca]);
  const at = await first(work);
  assert.equal(at.record.current.step, BUILD_CHECK_STEP.rescue);
  assert.deepEqual(namedFolders(recordOf(work)), [xpi, sca, rescued]);
  cleanup(work);
  const { work: built } = await clean();
  assert.deepEqual(namedFolders(recordOf(built)), [
    workPaths(built).xpi,
    workPaths(built).sca,
  ]);
  cleanup(built);
});

// A folder the record names that is gone, or no longer a folder of its own, when the step is
// handed back is not the agent's to correct: the hand-back's folder check finds it, and the
// failure names it, before any step reads or writes anything.
test("a folder the record names that is gone or a link is found by the folder check", async () => {
  const found = (work, name, problem) => {
    const misplaced = misplacedFolders(namedFolders(recordOf(work)));
    assert.deepEqual(misplaced, [{ folder: path.join(work, name), problem }]);
    const { message } = misplacedFoldersError(work, misplaced);
    assert.ok(
      message.includes(`${name}/ ${problem}. It cannot be carried on`),
      message
    );
  };
  for (const name of ["xpi", "sca"]) {
    const work = workFolder({ "package.json": packageFile() });
    assert.deepEqual(misplacedFolders(namedFolders(recordOf(work))), []);
    fs.rmSync(path.join(work, name), { recursive: true, force: true });
    found(work, name, "is gone");
    cleanup(work);
  }
  // A source folder moved away and linked back is no longer the folder the source was put in.
  const linked = workFolder({ "package.json": packageFile() });
  const moved = path.join(path.dirname(linked), "moved");
  fs.renameSync(workPaths(linked).sca, moved);
  fs.symlinkSync(moved, workPaths(linked).sca);
  found(linked, "sca", "is a link");
  cleanup(linked);
  const vulnerable = workFolder(
    { "package.json": packageFile(), "package-lock.json": npmLock() },
    { vulns: TOOL_HIGH }
  );
  assert.equal(
    (await first(vulnerable)).record.current.step,
    BUILD_CHECK_STEP.rescue
  );
  fs.rmSync(workPaths(vulnerable).rescued, { recursive: true, force: true });
  found(vulnerable, "rescued", "is gone");
  cleanup(vulnerable);
});
