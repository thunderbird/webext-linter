// CLI-contract tests of --llm-auto-review: the build check, what it records, and the review
// its hand-back starts.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readRecord, writeRecord } from "../../src/review/record.js";
import { advisory, auditCache, realBuildCheck } from "../build-checked.js";
import { cdnMissCache, freshFixtureCache } from "../seed-caches.js";
import { workPaths } from "../../src/util/dest.js";
import {
  ROOT,
  CACHE,
  FIXTURES_DIR,
  CDN_CACHE,
  cacheFlags,
  OFFLINE_FLAGS,
  headerValue,
  run,
  submissionFolder,
  packAddon,
  commandOf,
  workOf,
  readJson,
  handBackRoots,
  handBackUntil,
  unpackSource,
  unwrapped,
} from "../cli-run.js";

// ---- --llm-auto-review ----
// The half of an SCA review a program can do: which file is the add-on, which is the
// source, and where it is extracted. It reviews nothing - it cannot, until its reader has
// opened the source archive - so its whole output is that prompt, and every run after it is
// a hand-back of the work folder, which starts the review itself once the build check is
// done.

test("--llm-auto-review prints the prompt, names both files, and reviews nothing", () => {
  const dir = submissionFolder();
  const r = run([dir, "--llm-auto-review", ...OFFLINE_FLAGS]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /── SCA Review Prompt ──/);
  // A name on its own line and its value beneath it, whole: the steps name the values
  // rather than carrying them, so no path has to be read out of a wrapped paragraph.
  assert.match(r.stdout, new RegExp(`\\n  XPI\\n    ${dir}/addon\\.xpi\\n`));
  assert.match(
    r.stdout,
    new RegExp(
      `\\n  SOURCE_ARCHIVE\\n    ${dir}/src-4\\.3\\.12\\.tar_ABC\\.gz\\n`
    )
  );
  assert.match(r.stdout, new RegExp(`\\n  FOLDER\\n    ${dir}\\n`));
  // No review ran: no report sections, and no item file was claimed.
  assert.doesNotMatch(r.stdout, /── Found Issues ──|REVIEW_ITEMS/);
  // The unpack prompt only extracts: the build is the next prompt's.
  assert.doesNotMatch(r.stdout, /SCA_PACKAGE_ROOT|SCA_BUILD_REPORT|ANSWERS/);
  // Only an install hook reaching outside the declared dependencies is a safety concern.
  const analyze = unpackSource(r.stdout);
  assert.equal(analyze.code, 0, analyze.stderr);
  for (const said of [
    "an install hook that downloads or runs code from outside the declared dependencies",
  ]) {
    assert.ok(unwrapped(analyze.stdout).includes(said), said);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// The source is extracted into the review's work folder before the review starts, so the
// entry point creates that folder - at its default place, beside the .xpi - names its sca/
// as EXTRACT_TO, writes its record and an empty review file, and hands the folder back with
// --llm-handback. That hand-back derives the root in sca/ and asks for the build judgement
// alone.
test("--llm-auto-review creates the work folder and hands it back", () => {
  const dir = submissionFolder();
  const r = run([dir, "--llm-auto-review", ...OFFLINE_FLAGS]);
  assert.equal(r.code, 0, r.stderr);
  const made = fs
    .readdirSync(dir)
    .filter((n) => /^sca-review-addon-\d{4}-\d{2}-\d{2}T[\d-]+Z$/.test(n));
  assert.equal(made.length, 1, "one work folder, beside the .xpi");
  const work = path.join(dir, made[0]);
  // The add-on's copy, which the load put there, and the record.
  assert.deepEqual(fs.readdirSync(work).sort(), [".review", "xpi"]);
  // The early-exit checks have not run yet: they run once the source is in sca/, so no
  // verdict is recorded before them.
  assert.ok(!("verification" in readJson(work, "state")));
  assert.deepEqual(fs.readdirSync(path.join(work, ".review")).sort(), [
    "answers.json",
    "state.json",
  ]);
  assert.equal(
    headerValue(r.stdout, "EXTRACT_TO"),
    `${path.join(work, "sca")}${path.sep}`
  );
  assert.deepEqual(readJson(work, "answers").entries, []);
  assert.deepEqual(commandOf(r.stdout), [`--llm-handback ${work}`]);
  const analyze = unpackSource(r.stdout);
  assert.equal(analyze.code, 0, analyze.stderr);
  assert.equal(readJson(work, "state").current.step, "analyze");
  assert.equal(headerValue(analyze.stdout, "ANSWERS"), workPaths(work).answers);
  assert.equal(
    headerValue(analyze.stdout, "SCA_PACKAGE_ROOT"),
    workPaths(work).sca
  );
  assert.equal(
    headerValue(analyze.stdout, "SCA_BUILD_REPORT"),
    workPaths(work).build
  );
  const [safety, ...rest] = readJson(work, "answers").entries;
  assert.deepEqual(safety, { index: "SCA_BUILD_SAFETY_ISSUES", answer: null });
  assert.deepEqual(rest, [], "the root is the linter's, and asked of nobody");
  assert.deepEqual(commandOf(analyze.stdout), [`--llm-handback ${work}`]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The hand-back that finds the build check done starts the review itself, in that folder,
// with the add-on and the root the build check recorded - the agent runs no command but the
// hand-back. The review's first prompt is what it prints, and the next hand-back of the
// same folder carries the review on.
test("the hand-back that finishes the build check starts the review", () => {
  const dir = submissionFolder();
  const begun = run([
    dir,
    "--llm-auto-review",
    ...OFFLINE_FLAGS,
    "--checks-only",
    "unused-files",
  ]);
  assert.equal(begun.code, 0, begun.stderr);
  const work = workOf(begun.stdout);
  const handed = handBackRoots(begun.stdout);
  assert.notEqual(handed.code, 2, handed.stdout + handed.stderr);
  assert.equal(handed.stderr, "", "the review starts cleanly");
  assert.match(handed.stdout, /── LLM Prompt ──/);
  assert.doesNotMatch(handed.stdout, /SCA Review Prompt/);
  assert.equal(readJson(work, "state").current.mode, "review");
  const { meta } = readJson(work, "state").current.report;
  assert.equal(meta.xpi, path.join(dir, "addon.xpi"));
  assert.deepEqual(meta.scaFolders, {
    source: path.join(work, "sca"),
    used: path.join(work, "sca"),
    packageRoot: path.join(work, "sca"),
  });
  // The checks that end a review early run whatever --checks-only says.
  assert.deepEqual(meta.checksRun, [
    "experiment-not-allowed",
    "lockfile-injection",
    "unused-files",
  ]);
  // From here on the folder holds a review, and its hand-back is a pass of the loop.
  const next = run(["--llm-handback", work]);
  assert.doesNotMatch(next.stdout, /SCA Review Prompt/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A reviewer who builds the add-on themselves has the review started at once, with no build
// of the agent's: the build is held safe, and the reviewer answers the build question.
test("a reviewer who builds it themselves starts a review they build for", () => {
  const dir = submissionFolder();
  const begun = run([dir, "--llm-auto-review", ...OFFLINE_FLAGS]);
  assert.equal(begun.code, 0, begun.stderr);
  const work = workOf(begun.stdout);
  const handed = handBackRoots(begun.stdout, {
    managers: "Build it myself",
  });
  assert.notEqual(handed.code, 2, handed.stdout + handed.stderr);
  // The build check's results, in the record's permanent part: it audited nothing. The
  // review's own audit counts nothing either, since the source has no lock to count.
  const record = readJson(work, "state");
  assert.equal(record.build.packageManagers, false);
  assert.deepEqual(
    {
      result: record.build.result,
      output: record.build.output,
      match: record.build.match,
      vulnerabilities: record.build.vulnerabilities,
      rescuedVulnerabilities: record.build.rescuedVulnerabilities,
      safety: record.build.safety,
      safe: record.build.safe,
    },
    {
      result: null,
      output: null,
      match: null,
      vulnerabilities: null,
      rescuedVulnerabilities: null,
      safety: "safe",
      safe: true,
    }
  );
  assert.equal(record.current.vulnerabilities, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A record is checked as a command line is when a review starts from it: one that names an
// early-exit check in a check list, as no command line can, is the tool's failure, since the
// record is the linter's alone and the agent cannot repair it. The early-exit checks run in
// the unpack case, so that is where the recorded flags are read.
test("a build check record naming an early-exit check fails when its review starts", () => {
  const dir = submissionFolder();
  const begun = run([dir, "--llm-auto-review", ...OFFLINE_FLAGS]);
  assert.equal(begun.code, 0, begun.stderr);
  const work = workOf(begun.stdout);
  // Written by the linter itself, as an older one that took the flag would have: a record
  // edited by anything else fails as changed, before its flags are read.
  const record = readRecord(work);
  record.flags["checks-skip"] = "experiment-not-allowed";
  writeRecord(work, record);
  const handed = handBackRoots(begun.stdout);
  assert.equal(handed.code, 2);
  assert.match(
    handed.stderr,
    /"experiment-not-allowed" ends a review early and always runs/
  );
  assert.match(handed.stderr, /verify failed/);
  assert.equal(
    readJson(work, "state").current.mode,
    "unpack",
    "nothing started"
  );
});

// The flags the review is run with are this run's own, recorded as parsed: the same however
// they were spelt and in the order OPTIONS declares them, a boolean never paired with what
// follows it. The run's own --cache-clear and --report-format stay with it, and --verbose is
// recorded, so every hand-back of the review runs verbose. A flag invented or
// dropped here reviews a different submission than the reviewer asked about -
// --allow-experiments most of all, which decides whether the review runs at all.
test("the build check records the flags its review is started with", () => {
  const dir = submissionFolder();
  const xpi = path.join(dir, "addon.xpi");
  // The offline flags every run here is given are recorded too, and left out of what is
  // compared.
  const ownFlags = (work) =>
    Object.fromEntries(
      Object.entries(readJson(work, "state").flags).filter(
        ([name]) => !/^(cache-|cdn-lib-lookup)/.test(name)
      )
    );
  const begun = (...flags) => {
    const r = run([dir, "--llm-auto-review", ...OFFLINE_FLAGS, ...flags]);
    assert.equal(r.code, 0, r.stderr);
    return r;
  };

  const both = begun("--allow-experiments", "--eslint");
  assert.deepEqual(Object.entries(ownFlags(workOf(both.stdout))), [
    ["eslint", true],
    ["allow-experiments", true],
  ]);
  const only = begun("--checks-only=unused-files");
  assert.deepEqual(ownFlags(workOf(only.stdout)), {
    "checks-only": "unused-files",
  });
  handBackRoots(only.stdout);
  assert.deepEqual(
    readJson(workOf(only.stdout), "state").current.report.meta.checksRun,
    ["experiment-not-allowed", "lockfile-injection", "unused-files"],
    "the started review runs with them"
  );
  // --cache-clear really empties the caches it is given, so this run is given its own.
  const own = begun(
    "--eslint",
    "--verbose",
    "--cache-clear",
    "--report-format",
    "text",
    ...cacheFlags(freshFixtureCache(), cdnMissCache(FIXTURES_DIR))
  );
  assert.deepEqual(ownFlags(workOf(own.stdout)), {
    eslint: true,
    verbose: true,
  });

  // With no Experiment shipped, the prompt neither asks for the Experiment folder nor
  // records one - and the steps renumber over what survives.
  const plain = unpackSource(begun().stdout);
  assert.doesNotMatch(plain.stdout, /SCA_EXPERIMENTS|Experiment/);
  assert.match(plain.stdout, /\n4\. That run checks the source/);

  // An add-on that ships an Experiment needs the folder, so the .xpi's own manifest.json
  // decides: the unpack prompt asks for it, beside the extraction, the unpack review file has
  // a slot for it, and the started review reads it as the Experiment folder.
  packAddon(xpi, { experiment_apis: { x: {} } });
  const exp = begun("--allow-experiments");
  assert.match(exp.stdout, /SCA_EXPERIMENTS/, "unpack asks for it");
  const work = workOf(exp.stdout);
  assert.deepEqual(readJson(work, "answers").entries, [
    { index: "SCA_EXPERIMENTS", answer: null },
  ]);
  handBackRoots(exp.stdout, { experimentsFolder: "experiment" });
  assert.equal(
    readJson(work, "state").current.report.meta.scaFolders.experiments,
    path.join(work, "sca", "experiment")
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// --cache-work-dir is handed to the review the build check starts, as the real folder it
// names, so the build check and its review read one cache. --cache-clear leaves it alone:
// it holds what a test seeded, not a cache this tool fills.
test("the build check records --cache-work-dir for its review", () => {
  const dir = submissionFolder();
  const seeded = fs.mkdtempSync(path.join(os.tmpdir(), "wl-run-cache-"));
  const kept = path.join(seeded, "osv.json");
  fs.writeFileSync(kept, "{}");
  const r = run([
    dir,
    "--llm-auto-review",
    "--cache-clear",
    ...cacheFlags(freshFixtureCache(), cdnMissCache(FIXTURES_DIR)),
    "--cache-work-dir",
    seeded,
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(
    readJson(workOf(r.stdout), "state").flags["cache-work-dir"],
    fs.realpathSync(seeded)
  );
  assert.ok(fs.existsSync(kept), "--cache-clear does not delete it");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(seeded, { recursive: true, force: true });
});

// A skip names part of the prompt the PREPARED review will print, so it belongs to the
// review the build check starts rather than to this run - which prints no such prompt.
test("--llm-auto-review hands a skip to the review it prepares", () => {
  const dir = submissionFolder();
  const r = run([
    dir,
    "--llm-auto-review",
    ...OFFLINE_FLAGS,
    "--llm-skip-summary",
  ]);
  assert.equal(r.code, 0, r.stderr);
  // The prompt itself is unchanged: the skip belongs to the review, not to this run, which
  // asks nobody anything either way. Each run creates a work folder of its own, so the two
  // prompts name two of them.
  const prompt = (out) =>
    out
      .split("── SCA Review Prompt ──")[1]
      .replace(/sca-review-addon-\d{4}-\d{2}-\d{2}T[\d-]+Z/g, "<WORK>");
  assert.equal(
    prompt(r.stdout),
    prompt(run([dir, "--llm-auto-review", ...OFFLINE_FLAGS]).stdout)
  );
  handBackRoots(r.stdout);
  assert.deepEqual(readJson(workOf(r.stdout), "state").current.run.skip, [
    "llm-skip-summary",
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A hand-back that cannot be read is refused to the agent, with the folder as it was.
test("a build check refuses an unanswered hand-back", () => {
  const dir = submissionFolder();
  const r = run([dir, "--llm-auto-review", ...OFFLINE_FLAGS]);
  assert.equal(r.code, 0, r.stderr);
  const work = workOf(r.stdout);
  const unextracted = run(["--llm-handback", work]);
  assert.equal(unextracted.code, 2);
  assert.match(
    unextracted.stdout,
    /The hand-back was refused: ".+\/sca" is gone, so it is not the folder the source was extracted into/
  );
  // A hand-back that fails takes nothing away: the folder was not this run's to remove.
  assert.ok(fs.existsSync(workPaths(work).state), "the record stays");
  assert.equal(readJson(work, "state").current.step, "unpack");
  assert.equal(unpackSource(r.stdout).code, 0);
  const unanswered = run(["--llm-handback", work]);
  assert.equal(unanswered.code, 2);
  assert.match(
    unanswered.stdout,
    /The hand-back was refused: SCA_BUILD_SAFETY_ISSUES still has no "answer"/
  );
  assert.equal(readJson(work, "state").current.step, "analyze");
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A work folder whose build check is done, made for real: the sca-unrescued fixture's
 *  source, whose lock carries a critical advisory, run through a rescue that fails, so the
 *  folder is unrescued as a real build check leaves it. Then `edit` changes that real
 *  record, which is written again the way the linter writes it, sealed, as an agent that
 *  edited the record and recomputed its hash would, so what is tested is the check behind
 *  the digest. `name` runs another fixture instead: one with no lock, done at once, whose
 *  review asks nothing of a registry. */
async function preparedFolder(edit = () => {}, name = "sca-unrescued") {
  const fixture = path.join(ROOT, "tests", "addons", name);
  const { work } = await realBuildCheck({
    source: path.join(fixture, "src"),
    xpi: path.join(fixture, "xpi"),
    flags: {
      "cache-schema-dir": CACHE,
      "cache-hash-db-dir": CACHE,
      "cache-experiments-dir": CACHE,
      "cache-cdn-lookup-dir": CDN_CACHE,
    },
    cache: auditCache({
      "lint-pebble@0.4.0": [
        advisory("GHSA-fixture-pebble", "CRITICAL", "lint-pebble", "0.4.1"),
      ],
      "argv-crumb@0.0.8": [],
      "tidy-lantern@2.1.0": [],
      "wick-trim@1.0.1": [],
    }),
  });
  const record = readRecord(work);
  edit(record, work);
  writeRecord(work, record);
  return work;
}

// The record a review is started from is the linter's alone: the agent cannot repair it, so
// each record it cannot start from is the tool's failure, on stderr with "verify failed",
// with nothing written and the files kept.
test("a review whose build check is done fails on a record it cannot start from", (t) => {
  const failsFor = (name, edit, problem) =>
    t.test(name, async () => {
      const work = await preparedFolder(edit, "missing-lock-sca");
      const r = run(["--llm-handback", work]);
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.match(r.stderr, problem);
      assert.match(r.stderr, /verify failed/);
      assert.doesNotMatch(r.stdout, /refused/);
      // What the build check left: its record, the build report, the source and the
      // add-on's copy.
      assert.deepEqual(fs.readdirSync(work).sort(), [
        ".review",
        "build-issues.md",
        "build.md",
        "sca",
        "xpi",
      ]);
      assert.deepEqual(fs.readdirSync(path.join(work, ".review")), [
        "state.json",
      ]);
      assert.equal(readJson(work, "state").current.mode, "build-check");
    });
  failsFor(
    "an experiments that is neither true nor false",
    (record) => {
      record.submission = {
        xpi: path.join(os.tmpdir(), "x.xpi"),
        experiments: 1,
      };
    },
    /The review's record cannot be carried on: the review's record holds submission\.experiments as neither true nor false\. /
  );
  failsFor(
    "no roots",
    (record) => {
      record.current.roots = null;
    },
    /The review's record cannot be carried on: the build check's record holds no source copy, reviewed copy and package root of the shape the linter writes\. /
  );
  failsFor(
    "no submission",
    (record) => {
      record.submission = { xpi: "", experiments: false };
    },
    /The review's record cannot be carried on: the review's record names no submission to review\. /
  );
  failsFor(
    "a flag of the wrong type",
    (record) => {
      record.flags = { ...record.flags, eslint: "yes" };
    },
    /The review's record cannot be carried on: the review's record holds --eslint as neither true nor false/
  );
  // A folder the record names that is no longer that folder is not the agent's to correct
  // either: the tool's failure, on stderr, and nothing written.
  t.test("an sca/ that is a link", async () => {
    const work = await preparedFolder((record, w) => {
      const sca = path.join(w, "sca");
      const moved = fs.mkdtempSync(path.join(os.tmpdir(), "wl-sca-"));
      fs.cpSync(sca, moved, { recursive: true });
      fs.rmSync(sca, { recursive: true });
      fs.symlinkSync(moved, sca);
    }, "missing-lock-sca");
    const r = run(["--llm-handback", work]);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(
      r.stderr,
      /no longer holds the folders the linter put there for this review: sca\/ is a link\. It cannot be carried on/
    );
    assert.match(r.stderr, /verify failed/);
    assert.doesNotMatch(r.stdout, /refused/);
    assert.equal(readJson(work, "state").current.mode, "build-check");
  });
});

// Nor can a record name a folder for the linter to delete: --cache-clear is never forwarded,
// and a key no option declares is dropped.
test("a review whose build check is done drops what a record must not say", async () => {
  const before = fs.readdirSync(CACHE).sort();
  const work = await preparedFolder((record) => {
    record.flags = {
      "cache-clear": true,
      "cache-schema-dir": CACHE,
      "cache-hash-db-dir": CACHE,
      "cache-experiments-dir": CACHE,
      "cache-cdn-lookup-dir": CDN_CACHE,
      eslint: false,
      "rm-rf": "/",
    };
  }, "missing-lock-sca");
  const r = run(["--llm-handback", work]);
  assert.notEqual(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /── LLM Prompt ──/);
  assert.deepEqual(
    fs.readdirSync(CACHE).sort(),
    before,
    "no cache was cleared"
  );
});

// A source whose rescue failed is reviewed as submitted: the hand-back starts that review.
// Nothing is left to build, so no build question is put: the review opens on its passes,
// and its vulnerability checks abort it late and end it on the known vulnerabilities alone,
// and the run exits as a rejected review does. Its details say the rescue failed, and count
// the submitted lock and the rescued copy's lock as the build check audited them. The copy
// stays in the work folder, where the record names it.
test("the hand-back starts the review of an unrescued source, which is aborted late", async () => {
  // The fixture's source with nothing declared, so the review asks npm for no package's
  // downloads, and only the vulnerable build tool its lock installs.
  const fixture = path.join(ROOT, "tests", "addons", "sca-unrescued");
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "wl-unrescued-"));
  fs.cpSync(path.join(fixture, "src"), source, { recursive: true });
  const own = { name: "lantern-sorter", version: "1.0.0" };
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify(own));
  fs.writeFileSync(
    path.join(source, "package-lock.json"),
    JSON.stringify({
      ...own,
      lockfileVersion: 3,
      packages: { "": own, "node_modules/lint-pebble": { version: "0.4.0" } },
    })
  );
  const { work, record } = await realBuildCheck({
    source,
    xpi: path.join(fixture, "xpi"),
    flags: {
      "cache-schema-dir": CACHE,
      "cache-hash-db-dir": CACHE,
      "cache-experiments-dir": CACHE,
      "cache-cdn-lookup-dir": CDN_CACHE,
      "cache-npm-registry-dir": CACHE,
    },
    cache: auditCache({
      "lint-pebble@0.4.0": [
        advisory("GHSA-fixture-pebble", "CRITICAL", "lint-pebble", "0.4.1"),
      ],
    }),
  });
  assert.equal(
    record.build.roots.packageRoot,
    workPaths(work).sca,
    "the rescue failed"
  );
  const started = run(["--llm-handback", work]);
  assert.notEqual(started.code, 2, started.stdout + started.stderr);
  assert.match(started.stdout, /── LLM Prompt ──/);
  assert.doesNotMatch(started.stdout, /SCA Review Prompt/);
  assert.notEqual(
    readJson(work, "state").current.phase,
    "built",
    "nothing to build"
  );
  const { out: r } = handBackUntil(work, "close");
  assert.equal(r.code, 1, r.stdout + r.stderr);
  // The close, its report already written, and its vulnerability checks are what aborted it.
  assert.match(r.stdout, /The review was aborted before it finished/);
  assert.ok(r.stdout.includes(`[review.md](${work}/review.md)`), r.stdout);
  assert.ok(r.stdout.includes("- Known security vulnerabilities"), r.stdout);
  assert.ok(!r.stdout.includes("- Build process issues"), r.stdout);
  for (const row of [
    "* SCA_VULNERABILITIES: 0 moderate, 0 high, 1 critical",
    "* LLM_BUILD_RESULT: not built: rescue failed",
    "* LLM_RESCUED_VULNERABILITIES: 0 moderate, 0 high, 1 critical",
  ]) {
    assert.ok(r.stdout.includes(row), `${row}\n${r.stdout}`);
  }
  const closed = readJson(work, "state");
  assert.equal(
    closed.review.roots.used,
    closed.review.roots.source,
    "the source archive is reviewed"
  );
  assert.ok(
    !Object.hasOwn(closed.build, "copy"),
    "nothing of the rescue was built"
  );
  assert.ok(
    fs.existsSync(workPaths(work).rescued),
    "the failed rescue's copy stays"
  );
  const { findings } = closed.review.report;
  assert.ok(findings.some((f) => f.ruleId === "vendor-vulnerable-indirect"));
  assert.ok(!findings.some((f) => f.ruleId === "build-fails"));
  fs.rmSync(source, { recursive: true, force: true });
});

// A source the agent built clean in the build check: the hand-back starts its review in the
// folder the build ran in, and the review opens on the build question, whose first step is
// the Build Review Details. They name what the agent's build produced and count the lock's
// vulnerable packages as the build check's audit found them - a moderate advisory, which
// decides nothing, among them - every row in the rows' order.
test("a review of a source the agent built opens on its Build Review Details", async () => {
  const fixture = path.join(ROOT, "tests", "addons", "sca-unrescued");
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "wl-built-"));
  fs.cpSync(path.join(fixture, "src"), source, { recursive: true });
  const own = { name: "lantern-sorter", version: "1.0.0" };
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify(own));
  fs.writeFileSync(
    path.join(source, "package-lock.json"),
    JSON.stringify({
      ...own,
      lockfileVersion: 3,
      packages: { "": own, "node_modules/lint-pebble": { version: "0.4.0" } },
    })
  );
  const { work, record } = await realBuildCheck({
    source,
    xpi: path.join(fixture, "xpi"),
    flags: {
      "cache-schema-dir": CACHE,
      "cache-hash-db-dir": CACHE,
      "cache-experiments-dir": CACHE,
      "cache-cdn-lookup-dir": CDN_CACHE,
      "cache-npm-registry-dir": CACHE,
    },
    cache: auditCache({
      "lint-pebble@0.4.0": [
        advisory("GHSA-fixture-pebble", "MODERATE", "lint-pebble", "0.4.1"),
      ],
    }),
  });
  assert.equal(record.build.result, "built");
  const r = run(["--llm-handback", work]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const started = readJson(work, "state");
  const state = started.current;
  assert.equal(state.phase, "built");
  // The reviewer let the agent build, so the build question does not offer to call the
  // build unsafe.
  assert.deepEqual(
    readJson(work, "answers").entries[0].answers.map((a) => a.label),
    ["Builds and reproduces", "Does not reproduce", "Does not build"]
  );
  const { build } = started;
  assert.deepEqual(
    {
      result: build.result,
      copy: build.copy,
      output: build.output,
      match: build.match,
      vulnerabilities: build.vulnerabilities,
      rescuedVulnerabilities: build.rescuedVulnerabilities,
      safety: build.safety,
      safe: build.safe,
    },
    {
      result: "built",
      copy: workPaths(work).buildCopy,
      output: record.build.output,
      match: "no match",
      vulnerabilities: { moderate: 1, high: 0, critical: 0 },
      rescuedVulnerabilities: null,
      safety: "safe",
      safe: true,
    }
  );
  assert.equal(state.roots.used, state.roots.source);
  const rows = [
    `* XPI_FILE: [xpi](${path.join(fixture, "xpi")})`,
    `* SCA_SOURCE: [source archive](${workPaths(work).sca})`,
    "* SCA_BUILD_SAFETY_ASSESSMENT: safe",
    `* SCA_BUILD: [build copy](${workPaths(work).buildCopy})`,
    "* SCA_VULNERABILITIES: 1 moderate, 0 high, 0 critical",
    `* LLM_BUILD_OUTPUT: [dist](${record.build.output})`,
    "* LLM_BUILD_RESULT: build succeeded",
    "* LLM_BUILD_XPI_MATCH: no match",
  ];
  const at = rows.map((row) => r.stdout.indexOf(row));
  rows.forEach((row, i) => assert.ok(at[i] >= 0, `${row}\n${r.stdout}`));
  assert.deepEqual(
    at,
    [...at].sort((a, b) => a - b),
    "the rows are in their order"
  );
  fs.rmSync(source, { recursive: true, force: true });
});
