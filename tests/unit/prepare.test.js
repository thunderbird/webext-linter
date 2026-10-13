// The preparation of a source code review, one hand-back at a time (src/prepare/steps.js):
// which roots it reads back and settles, what its audit of a root's lock decides
// (src/prepare/audit.js), how the agent's build of a clean lock is recorded, when a rescued
// copy is made, how a rescue is checked and how it fails, what each hand-back refuses, and
// what the review of a rescued copy tells the developer (sca-dependencies-changed). Driven through handBack() with OSV's
// answers seeded into a run cache folder outside the work folder, which the record names as
// its --cache-work-dir (auditCache), so every OSV answer is the test's, and a request for one
// it does not give is refused by the switched-off network.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handBack, startPreparation } from "../../src/prepare/steps.js";
import {
  PREPARE_STEP,
  readPrepare,
  startRecord,
  writePrepare,
} from "../../src/prepare/state.js";
import { HandbackRefused } from "../../src/report/handback.js";
import { NoAnswerError } from "../../src/util/net.js";
import { runCache, workPaths } from "../../src/util/dest.js";
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
} from "../prepared.js";
import { osvEntries, seeded, seedWorkCache } from "../seed-caches.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");

/** A HIGH advisory on the build tool every source below declares. */
const TOOL_HIGH = {
  "lint-pebble@0.4.0": [advisory("GHSA-tool", "HIGH", "lint-pebble", "0.4.1")],
};

/** The build tool every source below declares, as OSV answers it with no advisory. */
const TOOL_CLEAN = { "lint-pebble@0.4.0": [] };

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

/**
 * A work folder as the run that starts a preparation leaves it, its source extracted into
 * sca/ (`files`, relative to sca/), inside a fresh parent. Real, as the hand-back is given it.
 * Its record names `cache` as its --cache-work-dir: by default a folder seeded with OSV's
 * answers `vulns` (auditCache), for every step of the preparation. A null `cache` names none,
 * so the run's cache is the work folder's own.
 * @param {Record<string, string>} files
 * @param {{experiments?: boolean, vulns?: Record<string, object[]>, cache?: ?string}} [opts]
 * @returns {string} The work folder.
 */
function workFolder(
  files,
  {
    experiments = false,
    vulns = {},
    cache = auditCache(vulns),
    flags = {},
  } = {}
) {
  const parent = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "wl-prepare-"))
  );
  const work = path.join(parent, "work");
  fs.mkdirSync(work);
  startPreparation(
    work,
    startRecord({
      submission: { xpi: path.join(parent, "addon.xpi"), experiments },
      flags: { ...flags, ...(cache ? { "cache-work-dir": cache } : {}) },
    })
  );
  writeTree(workPaths(work).sca, {
    "manifest.json": '{"manifest_version": 3, "name": "x", "version": "1"}',
    "bg.js": 'console.log("source");\n',
    ...files,
  });
  return work;
}

/** The extract step alone: the extracted source handed back as the root, sca/ itself, with
 *  the build report written and `answers` filled in beside it (the build judged safe unless
 *  they say otherwise). */
const extractStep = (work, answers = {}) => {
  answer(work, { SCA_ROOT: workPaths(work).sca, ...answers });
  writeBuildReport(work);
  return handBack(work);
};

/** The first step, and the permission step after a safe build: the reviewer's answer is
 *  read from `answers` too, letting the agent build unless they say otherwise. */
const first = async (work, answers = {}) => {
  const at = await extractStep(work, answers);
  if (at.record.step !== PREPARE_STEP.permission) {
    return at;
  }
  answer(work, answers);
  return handBack(work);
};

/** A later step: the folder handed back, nothing to fill in. */
const later = (work) => handBack(work);

/** The labels a build or rescue answers BUILD_OUTPUT with where it produced nothing. */
const FAILED = ["The build failed", "The rescue failed"];

/** The build or rescue step handed back with `output` as its BUILD_OUTPUT answer, and `match`
 *  as its BUILD_MATCH answer: `no match` beside an output, and null beside a failed label,
 *  unless the test says otherwise. */
const handOutput = (
  work,
  output,
  match = FAILED.includes(output) ? null : "no match"
) => {
  answer(work, { BUILD_OUTPUT: output, BUILD_MATCH: match });
  return handBack(work);
};

/** The review file's entries, as the folder holds them. */
const reviewEntries = (work) =>
  JSON.parse(fs.readFileSync(workPaths(work).review, "utf8")).entries;

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

/** Whether every entry of a run's OSV cache file holds OSV's answer. */
const allAnswered = (file) =>
  Object.values(JSON.parse(fs.readFileSync(file, "utf8"))).every((e) =>
    Object.hasOwn(e, "answer")
  );

const recordOf = (work) => readPrepare(work);

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

// ---- the first step ----

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
  assert.equal(at.work, work);
  assert.equal(at.record.step, PREPARE_STEP.build);
  assert.deepEqual(at.record.roots, {
    scaRoot: workPaths(work).sca,
    scaExpSource: null,
  });
  assert.equal(at.record.packageManagers, true, "the reviewer allowed them");
  assert.deepEqual(at.record.vulnerabilities, NONE);
  assert.equal(at.record.buildResult, null);
  assert.deepEqual(recordOf(work), at.record);
  const [output, match, ...rest] = reviewEntries(work);
  assert.deepEqual(rest, []);
  assert.equal(output.index, "BUILD_OUTPUT");
  assert.equal(output.message, "Where did the build put what it produced?");
  assert.deepEqual(
    output.answers.map((a) => a.label),
    ["The build failed"]
  );
  assert.equal(match.index, "BUILD_MATCH");
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
  const at = await first(work, { SCA_ROOT: path.join(sca, "proj") });
  assert.equal(at.record.step, PREPARE_STEP.build);
  assert.equal(at.record.roots.scaRoot, path.join(sca, "proj"));
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
  assert.equal(done.record.buildResult, "built");
  assert.equal(
    done.record.buildOutput,
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
    assert.equal(at.work, work);
    assert.equal(at.record.step, PREPARE_STEP.done);
    assert.equal(at.record.buildResult, "built");
    assert.equal(at.record.buildOutput, output);
    assert.deepEqual(at.record.vulnerabilities, NONE);
    assert.deepEqual(recordOf(work), at.record);
    assert.ok(
      !fs.existsSync(workPaths(work).review),
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
  assert.equal(at.record.step, PREPARE_STEP.done);
  assert.equal(at.record.buildResult, "failed");
  assert.equal(at.record.buildOutput, null);
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
    assert.equal(at.record.buildResult, "built");
    assert.equal(at.record.buildOutput, output);
    assert.equal(at.record.buildMatch, match);
    assert.deepEqual(recordOf(work), at.record);
    cleanup(work);
  }
  const { work } = await clean();
  const at = await handOutput(work, "The build failed");
  assert.equal(at.record.buildMatch, null, "a failed build compares nothing");
  cleanup(work);
});

// BUILD_MATCH goes with an output only: a failed build that answers it, and an output that
// leaves it open or answers it with no label it offers, are refused, with nothing changed.
test("a comparison that does not go with the build's answer is refused", async () => {
  const { work } = await clean();
  const output = buildInto(workPaths(work).buildCopy);
  for (const [named, match, problem] of [
    [
      "The build failed",
      "match",
      'BUILD_MATCH answers "match", but BUILD_OUTPUT answers "The build failed": ' +
        'leave its "answer" null',
    ],
    [output, null, 'BUILD_MATCH still has no "answer"'],
    [
      output,
      "close enough",
      'BUILD_MATCH answers "close enough", which this entry',
    ],
  ]) {
    await assert.rejects(handOutput(work, named, match), refused(problem));
  }
  assert.equal(recordOf(work).step, PREPARE_STEP.build);
  assert.ok(fs.existsSync(workPaths(work).review), "nothing moved");
  cleanup(work);
});

// An output is something the build produced in build/. Anything else is refused, with the
// folder unchanged, so the agent can correct the answer and hand it back again.
test("a build output outside build/, or missing, is refused", async () => {
  const { work } = await clean();
  const copy = workPaths(work).buildCopy;
  fs.rmSync(copy, { recursive: true });
  await assert.rejects(
    handOutput(work, "dist"),
    refused(
      `BUILD_OUTPUT names "dist", but the build copy "${copy}" does not exist`
    )
  );
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
  assert.equal(recordOf(work).step, PREPARE_STEP.build);
  assert.ok(fs.existsSync(workPaths(work).review), "nothing moved");
  cleanup(work);
});

// A run cut short after it moved the record to `build` and before it wrote the question
// leaves the permission step's review file: the next hand-back writes the question again.
test("a build step without its question hands the question out again", async () => {
  const { work } = await clean();
  const file = workPaths(work).review;
  fs.writeFileSync(
    file,
    JSON.stringify({ entries: [{ index: "PACKAGE_MANAGERS" }] })
  );
  const at = await handBack(work);
  assert.equal(at.next, "step");
  assert.equal(at.record.step, PREPARE_STEP.build);
  assert.deepEqual(
    reviewEntries(work).map((e) => e.index),
    ["BUILD_OUTPUT", "BUILD_MATCH"]
  );
  cleanup(work);
});

// The first prompt asks the agent to judge the build, and the record holds no judgement
// and no permission until the first hand-back reads them.
test("the first step asks for the build judgement", () => {
  const work = workFolder({ "package.json": packageFile() });
  const [safety, root] = JSON.parse(
    fs.readFileSync(workPaths(work).review, "utf8")
  ).entries;
  assert.equal(safety.index, "BUILD_SAFETY");
  assert.equal(safety.answer, null);
  assert.equal(recordOf(work).vulnerabilities, null);
  assert.equal(recordOf(work).buildResult, null);
  assert.deepEqual(
    safety.answers.map((a) => a.label),
    ["safe", "unsafe"]
  );
  assert.equal(root.index, "SCA_ROOT");
  assert.equal(recordOf(work).buildSafety, null);
  assert.equal(recordOf(work).packageManagers, null);
  cleanup(work);
});

// A safe build is recorded, and the reviewer is asked alone whether the agent may build:
// the review file holds that one question, and nothing is audited yet. The lock is
// vulnerable and OSV is given no answer, so an audit would ask the switched-off network.
test("a safe build moves on to the permission question, with nothing audited", async () => {
  const work = workFolder(
    { "package.json": packageFile(), "package-lock.json": npmLock() },
    { cache: auditCache() }
  );
  const at = await extractStep(work);
  assert.equal(at.next, "step");
  assert.equal(at.record.step, PREPARE_STEP.permission);
  assert.equal(at.record.buildSafety, "safe");
  assert.equal(at.record.packageManagers, null);
  assert.equal(at.record.vulnerabilities, null, "nothing is audited");
  assert.deepEqual(at.record.roots, {
    scaRoot: workPaths(work).sca,
    scaExpSource: null,
  });
  assert.deepEqual(recordOf(work), at.record);
  const [managers, ...rest] = JSON.parse(
    fs.readFileSync(workPaths(work).review, "utf8")
  ).entries;
  assert.deepEqual(rest, []);
  assert.equal(managers.index, "PACKAGE_MANAGERS");
  assert.equal(managers.answer, null);
  assert.equal(
    managers.message,
    "Let the agent build the add-on (including its package-manager commands), or not?"
  );
  assert.deepEqual(
    managers.answers.map((a) => a.label),
    ["Let it build", "Do not let it build"]
  );
  cleanup(work);
});

// An unsafe build ends the preparation: the folder is done with nothing audited and nothing
// rescued, and no question is put to the reviewer. The agent may run no package-manager
// command, which the review reads as it reads a declined permission.
test("an unsafe build is done at once, with nothing audited", async () => {
  const work = workFolder(
    { "package.json": packageFile(), "package-lock.json": npmLock() },
    { cache: auditCache() }
  );
  const at = await extractStep(work, { BUILD_SAFETY: "unsafe" });
  assert.equal(at.next, "review");
  assert.equal(at.record.step, PREPARE_STEP.done);
  assert.equal(at.record.buildSafety, "unsafe");
  assert.equal(at.record.packageManagers, false);
  assert.equal(at.record.vulnerabilities, null);
  assert.equal(at.record.buildResult, null, "nothing is built");
  assert.deepEqual(recordOf(work), at.record);
  assert.ok(!fs.existsSync(workPaths(work).review), "the review file is gone");
  assert.ok(!fs.existsSync(workPaths(work).rescued), "no copy is made");
  cleanup(work);
});

// --llm-agent-builds answered the permission question up front: a safe build goes straight
// to the audit, recorded as let it build, and a clean lock to the build.
test("--llm-agent-builds skips the permission question", async () => {
  const work = workFolder(
    { "package.json": packageFile(), "package-lock.json": npmLock() },
    { vulns: TOOL_CLEAN, flags: { "llm-agent-builds": true } }
  );
  const at = await extractStep(work);
  assert.equal(at.next, "step");
  assert.equal(at.record.step, PREPARE_STEP.build);
  assert.equal(at.record.buildSafety, "safe");
  assert.equal(at.record.packageManagers, true);
  cleanup(work);
});

// The judgement is one of the labels its entry offered, and comes with the build report it
// rests on. Anything else is refused with the folder unchanged.
test("a build judgement that is no label, or has no build report, is refused", async () => {
  const work = workFolder({ "package.json": packageFile() });
  await assert.rejects(
    extractStep(work, { BUILD_SAFETY: "fine" }),
    refused(/BUILD_SAFETY answers "fine", which this entry does not accept/)
  );
  await assert.rejects(
    extractStep(work, { BUILD_SAFETY: null }),
    refused(/BUILD_SAFETY still has no "answer"/)
  );
  answer(work, { SCA_ROOT: workPaths(work).sca });
  fs.rmSync(workPaths(work).build, { force: true });
  await assert.rejects(handBack(work), refused(/holds no build report/));
  assert.equal(recordOf(work).step, PREPARE_STEP.extract);
  cleanup(work);
});

// Let it build: the root's lock is audited, and a clean one is built.
test("letting the agent build audits the lock", async () => {
  const work = workFolder(
    { "package.json": packageFile(), "package-lock.json": npmLock() },
    { vulns: TOOL_CLEAN }
  );
  await extractStep(work);
  answer(work, { PACKAGE_MANAGERS: "Let it build" });
  const at = await handBack(work);
  assert.equal(at.next, "step");
  assert.equal(at.record.step, PREPARE_STEP.build);
  assert.equal(at.record.packageManagers, true);
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
  const at = await first(work, { PACKAGE_MANAGERS: "Do not let it build" });
  assert.equal(at.next, "review");
  assert.equal(at.record.step, PREPARE_STEP.done);
  assert.equal(at.record.packageManagers, false);
  assert.equal(at.record.vulnerabilities, null);
  assert.equal(at.record.buildResult, null, "nothing is built");
  assert.deepEqual(at.record.roots, {
    scaRoot: workPaths(work).sca,
    scaExpSource: null,
  });
  assert.deepEqual(recordOf(work), at.record);
  assert.ok(!fs.existsSync(workPaths(work).rescued), "no copy is made");
  cleanup(work);
});

// The answer is one of the labels its entry offered, and anything else is refused with the
// folder unchanged.
test("an answer to the permission question that is no label is refused", async () => {
  const work = workFolder({ "package.json": packageFile() });
  await extractStep(work);
  for (const [given, problem] of [
    [
      "Maybe",
      /PACKAGE_MANAGERS answers "Maybe", which this entry does not accept/,
    ],
    [null, /PACKAGE_MANAGERS still has no "answer"/],
  ]) {
    answer(work, { PACKAGE_MANAGERS: given });
    await assert.rejects(handBack(work), refused(problem));
  }
  assert.equal(recordOf(work).step, PREPARE_STEP.permission);
  cleanup(work);
});

// A run cut short after it moved the record to `permission` and before it wrote the
// question leaves the extract step's review file: the next hand-back writes the question
// and hands it out again, with nothing else changed.
test("a permission step without its question hands the question out again", async () => {
  const work = workFolder({ "package.json": packageFile() });
  await extractStep(work);
  const file = workPaths(work).review;
  fs.writeFileSync(file, JSON.stringify({ entries: [{ index: "SCA_ROOT" }] }));
  const at = await handBack(work);
  assert.equal(at.next, "step");
  assert.equal(at.record.step, PREPARE_STEP.permission);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(file, "utf8")).entries.map((e) => e.index),
    ["PACKAGE_MANAGERS"]
  );
  cleanup(work);
});

// The root is settled the way the review settles it: named one wrapper folder too high, it
// moves down to the folder holding package.json, and that is what is recorded and audited.
test("a wrapper folder named as the root settles on the folder below", async () => {
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
  assert.equal(at.work, work);
  assert.equal(at.record.step, PREPARE_STEP.rescue);
  assert.equal(
    at.record.roots.scaRoot,
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
  assert.equal(at.work, work);
  assert.equal(at.record.step, PREPARE_STEP.rescue);
  assert.equal(at.record.roots.scaRoot, copy);
  assert.deepEqual(at.record.vulnerabilities, ONE_HIGH);
  assert.equal(at.record.buildResult, null);
  assert.deepEqual(recordOf(work), at.record);
  const [output, match, ...rest] = reviewEntries(work);
  assert.deepEqual(rest, []);
  assert.equal(output.index, "BUILD_OUTPUT");
  assert.deepEqual(
    output.answers.map((a) => a.label),
    ["The rescue failed"]
  );
  assert.equal(match.index, "BUILD_MATCH");
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
  assert.equal(at.work, work);
  assert.equal(at.record.step, PREPARE_STEP.rescue);
  assert.deepEqual(at.record.vulnerabilities, {
    moderate: 0,
    high: 0,
    critical: 1,
  });
  cleanup(work);
});

// ---- the roots handed back ----
// Every way they can be wrong is refused to the agent, with nothing changed.

test("roots that are missing, blank or outside the source are refused", async () => {
  const work = workFolder({ "package.json": packageFile() });
  const sca = workPaths(work).sca;
  const unchanged = () =>
    assert.equal(recordOf(work).step, PREPARE_STEP.extract);

  await assert.rejects(later(work), refused(/SCA_ROOT still has no "answer"/));
  unchanged();
  await assert.rejects(
    first(work, { SCA_ROOT: "   " }),
    refused(/SCA_ROOT names no folder/)
  );
  unchanged();
  const elsewhere = path.join(path.dirname(work), "elsewhere");
  writeTree(elsewhere, { "package.json": packageFile() });
  await assert.rejects(
    first(work, { SCA_ROOT: elsewhere }),
    refused(/SCA_ROOT ".+elsewhere" is not a folder inside/)
  );
  await assert.rejects(
    first(work, { SCA_ROOT: path.join(sca, "nothing-here") }),
    refused(/is not a folder inside/)
  );
  // A link inside the source that leads out is the folder it leads to, and refused.
  fs.symlinkSync(elsewhere, path.join(sca, "out"));
  await assert.rejects(
    first(work, { SCA_ROOT: path.join(sca, "out") }),
    refused(/is not a folder inside/)
  );
  unchanged();
  // One that leads to a folder inside it is that folder, and taken as it.
  writeTree(path.join(sca, "real"), { "package.json": packageFile() });
  fs.symlinkSync(path.join(sca, "real"), path.join(sca, "in"));
  const at = await first(work, { SCA_ROOT: "in" });
  assert.equal(at.record.roots.scaRoot, path.join(sca, "real"));
  cleanup(work);
});

test("a source folder that is a link is refused", async () => {
  const work = workFolder({ "package.json": packageFile() });
  const sca = workPaths(work).sca;
  const moved = path.join(path.dirname(work), "moved");
  fs.renameSync(sca, moved);
  fs.symlinkSync(moved, sca);
  await assert.rejects(
    first(work, { SCA_ROOT: sca }),
    refused(/is not the folder the source was extracted into/)
  );
  cleanup(work);
});

test("an Experiment folder is read against the root, and must lie inside it", async () => {
  const work = workFolder(
    { "package.json": packageFile(), "exp/api.js": "" },
    { experiments: true }
  );
  const sca = workPaths(work).sca;
  // Asked for, so an answer missing is refused like any other.
  await assert.rejects(
    first(work, {}),
    refused(/SCA_EXP_SOURCE still has no "answer"/)
  );
  await assert.rejects(
    first(work, { SCA_EXP_SOURCE: "../.." }),
    refused(/SCA_EXP_SOURCE "\.\.\/\.\." is not a folder inside/)
  );
  // The root itself excludes nothing, and the review refuses it - so the hand-back does.
  await assert.rejects(
    first(work, { SCA_EXP_SOURCE: "." }),
    refused(/sca-exp-source/)
  );
  assert.equal(recordOf(work).step, PREPARE_STEP.extract, "nothing moved");
  const at = await first(work, { SCA_EXP_SOURCE: "exp" });
  assert.equal(at.record.roots.scaExpSource, path.join(sca, "exp"));
  cleanup(work);
});

// ---- not rescued ----
// Each of these is built as it is, or done at once, and its review decides the rest.

// The preparation audits the lock alone: a library committed to the archive is the review's
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
  assert.equal(at.work, work);
  assert.equal(at.record.step, PREPARE_STEP.build);
  assert.ok(!fs.existsSync(workPaths(work).rescued), "no copy is made");
  cleanup(work);
});

// The preparation looks at the lock and nothing else: a review that will stop for another
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
  assert.equal(at.record.step, PREPARE_STEP.rescue);
  cleanup(work);
});

/** A done folder whose lock the audit could not read in full: nothing was built, nothing
 *  counted, nothing copied. */
function notAudited(work, at) {
  assert.equal(at.next, "review");
  assert.equal(at.work, work);
  assert.equal(at.record.step, PREPARE_STEP.done);
  assert.equal(at.record.vulnerabilities, null);
  assert.equal(at.record.buildResult, null, "nothing is built");
  assert.ok(!fs.existsSync(workPaths(work).rescued), "no copy is made");
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
  return { work, copy: workPaths(work).rescued, root: at.record.roots.scaRoot };
}

/** A rescue that failed: done, its roots back in sca/, the copy deleted, and the original
 *  lock's counts recorded. */
function rescueFailed(work, at) {
  assert.equal(at.next, "review");
  assert.equal(at.work, work);
  assert.equal(at.record.step, PREPARE_STEP.done);
  assert.equal(at.record.buildResult, "rescue-failed");
  assert.equal(at.record.buildOutput, null);
  assert.equal(at.record.buildMatch, null);
  assert.equal(at.record.roots.scaRoot, workPaths(work).sca);
  assert.deepEqual(at.record.vulnerabilities, ONE_HIGH);
  assert.deepEqual(recordOf(work), at.record);
  assert.ok(!fs.existsSync(workPaths(work).rescued), "the copy is deleted");
  assert.ok(!fs.existsSync(workPaths(work).buildCopy), "the build is deleted");
}

// The copy's lock audits clean, and the output the agent named lies inside it: the folder is
// done with the copy as the reviewed source, its build recorded, and the copy's own counts -
// a moderate advisory left in it included - in place of the original's.
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
  assert.equal(at.work, work);
  assert.equal(at.record.step, PREPARE_STEP.done);
  assert.equal(at.record.roots.scaRoot, root, "the copy is what is reviewed");
  assert.equal(at.record.buildResult, "built");
  assert.equal(at.record.buildOutput, output);
  assert.deepEqual(at.record.vulnerabilities, {
    moderate: 1,
    high: 0,
    critical: 0,
  });
  assert.deepEqual(recordOf(work), at.record);
  assert.ok(fs.existsSync(copy));
  assert.ok(!fs.existsSync(workPaths(work).review), "the review file is gone");
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
      'BUILD_MATCH answers "no match", but BUILD_OUTPUT answers "The rescue failed"',
    ],
    [output, null, 'BUILD_MATCH still has no "answer"'],
  ]) {
    await assert.rejects(handOutput(work, named, match), refused(problem));
  }
  assert.equal(recordOf(work).step, PREPARE_STEP.rescue);
  const at = await handOutput(work, output, "match");
  assert.equal(at.record.buildResult, "built");
  assert.equal(at.record.buildMatch, "match");
  assert.deepEqual(recordOf(work), at.record);
  cleanup(work);
});

// The linter audits the copy itself: a copy still vulnerable fails the rescue, whatever
// the agent built from it.
test("a copy still vulnerable on its audit fails the rescue", async () => {
  const { work, root } = await rescued();
  rescueFailed(work, await handOutput(work, buildRescued(work, root)));
  // Handed back again, its review is handed out once more, asking nothing.
  const again = await later(work);
  assert.equal(again.next, "review");
  assert.deepEqual(again.record, recordOf(work));
  cleanup(work);
});

// The agent's own word that the rescue failed is taken: nothing is audited, and the copy
// goes.
test("a rescue the agent answers as failed fails", async () => {
  const { work } = await rescued();
  rescueFailed(work, await handOutput(work, "The rescue failed"));
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
      rescueFailed(work, await handOutput(work, named(work, root)));
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
      'BUILD_OUTPUT names no path and does not answer "The rescue failed"'
    )
  );
  assert.equal(recordOf(work).step, PREPARE_STEP.rescue);
  assert.ok(fs.existsSync(workPaths(work).rescued));
  cleanup(work);
});

// The preparation is one run with its review: OSV is asked through the run's cache in the
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
  const at = await first(work);
  assert.equal(at.record.step, PREPARE_STEP.rescue);
  assert.ok(allAnswered(path.join(work, ".cache", "osv.json")));
  // The copy's audit reads the same lock from the same cache, and finds it vulnerable.
  rescueFailed(
    work,
    await handOutput(work, buildRescued(work, at.record.roots.scaRoot))
  );
  cleanup(work);
});

// A run that names its cache folder (--cache-work-dir, forwarded in the record) keeps OSV's
// answers there instead, so the preparation and its review read the folder a test seeded.
test("a step asks through the cache folder its record names", async () => {
  const dir = seedWorkCache({ osv: liveAudit(TOOL_HIGH) });
  const work = workFolder(
    {
      "package.json": packageFile(),
      "package-lock.json": npmLock(),
    },
    { cache: dir }
  );
  const at = await first(work);
  assert.equal(at.record.step, PREPARE_STEP.rescue, "the advisory was read");
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
      rescueFailed(work, await handOutput(work, output));
      cleanup(work);
    });
  }
});

// OSV answering 404 is no answer: it says nothing about the tree, so the preparation ends as
// the tool's failure, with the record where it was, for the folder to be handed back once OSV
// answers again - at the step that audits the root, and at the rescue's.
test("an audit OSV does not answer ends the preparation", async (t) => {
  const noAnswer = (err) =>
    err instanceof NoAnswerError && /querybatch \(HTTP 404\)/.test(err.message);
  await t.test("at the permission step", async () => {
    const work = workFolder(
      {
        "package.json": packageFile(),
        "package-lock.json": npmLock(),
      },
      { cache: seedWorkCache({ osv: batchDown("lint-pebble@0.4.0") }) }
    );
    await assert.rejects(first(work), noAnswer);
    assert.equal(recordOf(work).step, PREPARE_STEP.permission);
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
    assert.equal(recordOf(work).step, PREPARE_STEP.rescue);
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
    workPaths(work).review,
    JSON.stringify({ entries: [{ index: "PACKAGE_MANAGERS" }] })
  );
  const again = await later(work);
  assert.equal(again.next, "step");
  assert.equal(again.work, work);
  assert.equal(again.record.step, PREPARE_STEP.rescue);
  assert.deepEqual(
    reviewEntries(work).map((e) => e.index),
    ["BUILD_OUTPUT", "BUILD_MATCH"]
  );
  cleanup(work);
});

// A finished preparation is not audited again: its review is handed out once more, for the
// hand-back to start again, and the review file the review claims is deleted again, in case
// the run that marked it was cut short before it could.
test("a done folder handed back again hands out its review again", async () => {
  const { work } = await clean();
  const done = await handOutput(work, buildInto(workPaths(work).buildCopy));
  fs.writeFileSync(workPaths(work).review, "{}");
  const again = await later(work);
  assert.equal(again.next, "review");
  assert.deepEqual(again.record, done.record);
  assert.ok(!fs.existsSync(workPaths(work).review));
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
  const again = await later(work);
  assert.equal(again.next, "review");
  assert.equal(again.record.roots.scaRoot, root);
  assert.ok(fs.existsSync(copy));
  assert.ok(fs.existsSync(workPaths(work).buildCopy), "its build stays");
  cleanup(work);
});

// A failed rescue cut short after the folder was marked done leaves the copy and its build
// behind. The next hand-back finishes removing both, and hands the review out.
test("a copy left behind by a failed rescue cut short is removed", async () => {
  const { work, copy, root } = await rescued();
  buildRescued(work, root);
  writePrepare(work, {
    ...recordOf(work),
    step: PREPARE_STEP.done,
    roots: { scaRoot: workPaths(work).sca, scaExpSource: null },
    buildResult: "rescue-failed",
  });
  assert.ok(fs.existsSync(copy));
  const at = await later(work);
  assert.equal(at.next, "review");
  assert.equal(at.work, work);
  assert.ok(!fs.existsSync(copy));
  assert.ok(!fs.existsSync(workPaths(work).buildCopy));
  cleanup(work);
});

// The agent can write any file, records included, so no record decides what is deleted: the
// only folders the preparation ever removes are the work folder's own rescued/ and build/,
// whatever the record names.
test("a forged record never removes a folder outside the work folder", async () => {
  const { work } = await rescued();
  const stray = path.join(path.dirname(work), "stray");
  fs.mkdirSync(stray);
  // Roots that name a folder outside the work folder, at the failed rescue that removes the
  // copy.
  writePrepare(work, {
    ...recordOf(work),
    step: PREPARE_STEP.done,
    roots: { scaRoot: stray, scaExpSource: null },
  });
  await later(work);
  assert.ok(fs.existsSync(stray));
  assert.ok(!fs.existsSync(workPaths(work).rescued));
  cleanup(work);
});

// The record is the linter's alone: every write leaves it read-only, the plainest signal that
// it is out of the agent's reach - at every step.
test("every record the preparation writes is read-only", async () => {
  const mode = (folder) => fs.statSync(workPaths(folder).prepare).mode & 0o777;
  const work = workFolder(
    {
      "package.json": packageFile(),
      "package-lock.json": npmLock(),
    },
    { vulns: TOOL_HIGH }
  );
  assert.equal(mode(work), 0o444, "as the preparation starts");
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
// one, like the root it names - is caught on the next read, and refused.
test("a record changed after the linter wrote it is refused", async () => {
  const { work } = await rescued();
  const file = workPaths(work).prepare;
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.roots.scaExpSource = record.roots.scaRoot;
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, JSON.stringify(record, null, 1));
  await assert.rejects(
    later(work),
    refused(/changed after the linter wrote it/)
  );
  cleanup(work);
});

// A record from the version of this tool before the hash has none, and is told apart as
// another version's rather than read as a changed one.
test("a record of another version of this tool is refused as one", async () => {
  const work = workFolder({ "package.json": packageFile() });
  const file = workPaths(work).prepare;
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  delete record.digest;
  record.version = 1;
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, JSON.stringify(record));
  await assert.rejects(later(work), /written by another version/);
  cleanup(work);
});

// A boolean in the record is true or false, as the linter writes it. Anything else was put
// there by an edit, and the hand-back is refused rather than reading a meaning into it.
test("a record boolean that is neither true nor false is refused", async () => {
  const { work } = await rescued();
  const record = recordOf(work);
  writePrepare(work, {
    ...record,
    submission: { ...record.submission, experiments: "yes" },
  });
  await assert.rejects(
    later(work),
    refused(/holds submission\.experiments as neither true nor false/)
  );
  cleanup(work);
});

test("a packageManagers that is neither true nor false is refused", async () => {
  const { work } = await rescued();
  writePrepare(work, { ...recordOf(work), packageManagers: "no" });
  await assert.rejects(
    later(work),
    refused(/holds packageManagers as neither true nor false/)
  );
  cleanup(work);
});

// The judgement is one the agent can give, and the record of a step it is known at holds
// one: anything else was put there by an edit.
test("a buildSafety that is no judgement is refused", async () => {
  const { work } = await rescued();
  for (const buildSafety of ["maybe", null]) {
    writePrepare(work, { ...recordOf(work), buildSafety });
    await assert.rejects(
      later(work),
      refused(/holds buildSafety as no judgement the agent can give/)
    );
    writePrepare(work, {
      ...JSON.parse(fs.readFileSync(workPaths(work).prepare, "utf8")),
      buildSafety: "safe",
    });
  }
  cleanup(work);
});

// The counts and the build result are held only at the steps that can know them, each of the
// shape the linter writes, and a build only where the agent may build. Anything else was put
// there by an edit.
test("a build record the linter would not write is refused", async (t) => {
  const cases = [
    [
      "counts before the audit",
      (r) => ({ ...r, step: PREPARE_STEP.permission, packageManagers: null }),
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
      "a result before the build is handed back",
      (r) => ({ ...r, buildResult: "built", buildOutput: r.roots.scaRoot }),
      "holds buildResult as no result the linter writes",
    ],
    [
      "a result the linter does not write",
      (r) => ({ ...r, step: PREPARE_STEP.done, buildResult: "maybe" }),
      "holds buildResult as no result the linter writes",
    ],
    [
      "a build without its output",
      (r) => ({ ...r, step: PREPARE_STEP.done, buildResult: "built" }),
      "holds buildOutput without a build that produced it",
    ],
    [
      "an output without a build",
      (r) => ({
        ...r,
        step: PREPARE_STEP.done,
        buildResult: "failed",
        buildOutput: r.roots.scaRoot,
      }),
      "holds buildOutput without a build that produced it",
    ],
    [
      "a comparison without a build",
      (r) => ({
        ...r,
        step: PREPARE_STEP.done,
        buildResult: "failed",
        buildMatch: "no match",
      }),
      "holds buildMatch without a build that produced an output",
    ],
    [
      "a build without its comparison",
      (r) => ({
        ...r,
        step: PREPARE_STEP.done,
        buildResult: "built",
        buildOutput: r.roots.scaRoot,
      }),
      "holds a built result without buildMatch",
    ],
    [
      "a comparison the agent cannot give",
      (r) => ({
        ...r,
        step: PREPARE_STEP.done,
        buildResult: "built",
        buildOutput: r.roots.scaRoot,
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
      writePrepare(work, edit(recordOf(work)));
      await assert.rejects(later(work), refused(problem));
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
  assert.equal(at.record.step, PREPARE_STEP.rescue);
  assert.ok(!fs.existsSync(path.join(copy, "left-over.txt")));
  assert.ok(fs.existsSync(path.join(copy, "package.json")));
  cleanup(work);
});

test("a rescued copy that cannot be made ends the preparation", async (t) => {
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
  await extractStep(work);
  answer(work, {});
  fs.chmodSync(work, 0o555);
  try {
    await assert.rejects(handBack(work), (err) => {
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
  assert.equal(recordOf(work).step, PREPARE_STEP.permission);
  cleanup(work);
});

// Every path a record holds is read by a later run, from any directory, so each is written
// absolute - and a record about to hold a relative one is refused at the write, naming it.
test("a record holding a relative path is never written", async () => {
  const { work } = await rescued();
  const record = recordOf(work);
  const relative = {
    "submission.xpi": {
      submission: { ...record.submission, xpi: "addon.xpi" },
    },
    "roots.scaRoot": { roots: { ...record.roots, scaRoot: "sca" } },
    "roots.scaExpSource": { roots: { ...record.roots, scaExpSource: "exp" } },
    buildOutput: { buildOutput: "build/dist" },
    "flags.cache-schema-dir": { flags: { "cache-schema-dir": "cache" } },
  };
  for (const [field, over] of Object.entries(relative)) {
    assert.throws(
      () => writePrepare(work, { ...record, ...over }),
      new RegExp(`and ${field.replace(/\./g, "\\.")} is not`),
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
