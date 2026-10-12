// CLI-contract tests: exit codes, which stream output goes to, and key
// behaviors of the root entry verify.js. These cover the argument/usage/output
// layer that the golden report snapshots (exercising runPipeline) do not.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import YAML from "yaml";

import { pipelineOptsFromArgv } from "../../src/cli.js";
import { readPrepare, writePrepare } from "../../src/prepare/state.js";
import { advisory, answer, auditCache, realPreparation } from "../prepared.js";
import {
  addonOutsideRepo,
  cdnMissCache,
  freshFixtureCache,
  freshWorkFolder,
  osvEntries,
  popularityEntries,
  seedFixtureCache,
  seedWorkCache,
} from "../seed-caches.js";
import { relativeInside } from "../../src/addon/load.js";
import { workPaths } from "../../src/util/dest.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");
const REVIEW = path.join(ROOT, "verify.js");
// A cache pre-seeded from the fixtures. Point every fetchable source at it so the
// spawned CLI (schema auto-detection, library-hash DB, experiments allow-list) runs
// fully offline.
const CACHE = seedFixtureCache();
// The CDN lookup runs as in any review, answered from a cache that already holds jsDelivr's
// answer for every fixture file: none of them is on the CDN. A cache of its own, apart from
// the harness's, whose CDN fixtures expect a hit for their files.
const FIXTURES_DIR = path.join(ROOT, "tests", "addons");
const CDN_CACHE = cdnMissCache(FIXTURES_DIR);
/** The flags that point every cache at a prepared one, so a run is answered from caches
 *  alone. */
const cacheFlags = (cache, cdnCache = CDN_CACHE) => [
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
const OFFLINE_FLAGS = cacheFlags(CACHE);

/** What the Review Details block prints under one of its names - the value sits on the
 *  line beneath the name, indented, so no line holds both. Undefined when the run printed
 *  no such name, which is how a caller asserts a value is absent. */
function headerValue(stdout, name) {
  const lines = stdout.split("\n");
  const at = lines.findIndex((l) => l.trim() === name);
  return at === -1 ? undefined : lines[at + 1].trim();
}

/** The review file a prompt names, and what is in it. The prompt is the only place any
 *  path is given out, which is exactly what a test should read. */
function reviewFile(stdout) {
  const at = stdout.match(/(\S+\/review\.json)/);
  return at ? at[1] : undefined;
}
function entriesOf(stdout) {
  const file = reviewFile(stdout);
  assert.ok(file, "the prompt names the review file");
  return JSON.parse(fs.readFileSync(file, "utf8")).entries;
}

/** What the reviewer sends to the developer. The linter WRITES this one, and the final
 *  prompt links it rather than reproducing it - so a test asserting on the report reads
 *  the file, the way the reviewer does. Read out of the link's target, because a path
 *  taken as "the next run of non-space" would take the `](` with it. */
function reportOf(stdout) {
  const at = stdout.match(/\]\((\S+\/report\.md)\)/);
  assert.ok(at, "the prompt links the report file");
  return fs.readFileSync(at[1], "utf8");
}

/** Run a root entry file, capturing stdout/stderr/exit code. */
function runFile(file, args = []) {
  const r = spawnSync(process.execPath, [file, ...args], { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The fixtures' folder: a review creates its work folder beside its add-on, so an add-on
 *  there is reviewed as a copy (addonOutsideRepo). */
const FIXTURES = path.join(ROOT, "tests", "addons");

/** The flags whose value names a folder the review READS, never the add-on, and so is
 *  passed as it stands. */
const READ_FOLDER_FLAGS = new Set(["--sca-root", "--sca-exp-source"]);

/** Run the review entry (verify.js), with an add-on from the fixtures' folder replaced by a
 *  copy outside the repository, so no review writes its work folder into tests/addons. */
function run(args) {
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
    )
  );
}

/** The default work folder a review of `addon` created beside it: the one folder there
 *  named after it and a moment. */
function defaultFolderOf(addon) {
  const leaf = path.basename(addon).replace(/\.xpi$/, "");
  const made = fs
    .readdirSync(path.dirname(addon))
    .filter((n) =>
      new RegExp(`^${leaf}-\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z$`).test(n)
    );
  assert.equal(made.length, 1, "one default work folder, beside the add-on");
  return path.join(path.dirname(addon), made[0]);
}

// --help prints the usage (the check-id list and the verify.js command) to
// stdout, nothing to stderr, and exits 0.
test("--help prints usage to stdout and exits 0", () => {
  const r = run(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--checks-only/);
  assert.match(r.stdout, /node verify\.js/);
  assert.doesNotMatch(r.stdout, /node review\.js|node build\.js|node lint\.js/);
  assert.equal(r.stderr, "");
  // The run header opens the output, echoing the args (here --help).
  assert.match(r.stdout, /> (?:@[\w-]+\/)?webext-linter@\d+\.\d+\.\d+ review/);
  assert.match(r.stdout, /node verify\.js --help/);
  // Every flag is listed under a group that holds more than it. --report-format has no
  // group of its own: one option under a heading is a heading that says nothing.
  assert.match(r.stdout, /--warnings-as-errors/);
  assert.match(r.stdout, /--report-format/);
  assert.doesNotMatch(r.stdout, /Report output:/);
});

// An unknown top-level option exits 2 with a clean message - no node:util
// "place it after --" hint, which does not apply to this tool.
test("unknown option errors cleanly (no -- separator hint)", () => {
  const r = run(["--bogusflag"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown option '--bogusflag'/);
  assert.doesNotMatch(r.stderr, /To specify a positional argument/);
});

// None of these flag strings is a valid option; passing any of them is an
// "Unknown option" error (exit 2). Guards the CLI surface against their return.
test("unrecognized cache/cdn flag strings are unknown options", () => {
  for (const flag of [
    "--schema-force-refresh",
    "--schema-cache",
    "--lib-mozilla-hash-db-cache",
    "--experiments-cache",
    "--lib-cdn-lookup",
  ]) {
    const r = run(["x.xpi", flag, "v"]);
    assert.equal(r.code, 2, `${flag} should exit 2`);
    assert.match(r.stderr, /Unknown option/, `${flag} should be unknown`);
  }
});

// The cache/cdn flags map to the internal pipeline opts.
test("cache/cdn flags map to the pipeline opts", () => {
  assert.equal(pipelineOptsFromArgv([]).cdnLookup, true); // default on
  assert.equal(
    pipelineOptsFromArgv(["--cdn-lib-lookup", "false"]).cdnLookup,
    false
  );
  const o = pipelineOptsFromArgv([
    "--cache-schema-dir",
    "/a",
    "--cache-hash-db-dir",
    "/b",
    "--cache-cdn-lookup-dir",
    "/c",
    "--cache-experiments-dir",
    "/d",
    "--cache-npm-registry-dir",
    "/e",
    "--cache-sources-dir",
    "/f",
  ]);
  assert.equal(o.schemaCache, "/a");
  assert.equal(o.libraryHashesCache, "/b");
  assert.equal(o.cdnLookupCache, "/c");
  assert.equal(o.experimentsCache, "/d");
  assert.equal(o.npmRegistryCache, "/e");
  assert.equal(o.sourcesCache, "/f");
});

// --cache-work-dir names the folder the run's cache is read from, so a review is answered
// by what a test kept there: every lock package popular, and one advisory, which the review
// reports. Seeded with the run cache's own keys (seedWorkCache), so the entries are spelt as
// the review reads them.
test("--cache-work-dir: a review reads its answers from the folder named", async () => {
  const fixture = addonOutsideRepo(path.join(FIXTURES, "sca-unrescued"));
  const lock = JSON.parse(
    fs.readFileSync(path.join(fixture, "src", "package-lock.json"), "utf8")
  );
  const packages = Object.entries(lock.packages)
    .filter(([at]) => at)
    .map(([at, { version }]) => ({
      name: at.slice("node_modules/".length),
      version,
    }));
  const seeded = advisory(
    "GHSA-seed-0000-0000",
    "CRITICAL",
    "tidy-lantern",
    "2.1.1"
  );
  const release = ({ name, version }) => `${name}@${version}`;
  const dir = seedWorkCache({
    osv: osvEntries({
      batch: Object.fromEntries(
        packages.map((p) => [
          release(p),
          release(p) === "tidy-lantern@2.1.0"
            ? { vulns: [{ id: seeded.id }] }
            : {},
        ])
      ),
      advisories: { [seeded.id]: seeded },
    }),
    popularity: popularityEntries({
      npm: Object.fromEntries(
        packages.map(({ name }) => [name, { downloads: 1e9 }])
      ),
    }),
  });

  const r = run([
    path.join(fixture, "xpi"),
    "--sca-root",
    path.join(fixture, "src"),
    ...OFFLINE_FLAGS,
    "--cache-work-dir",
    dir,
  ]);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stdout, /GHSA-seed-0000-0000/);
});

// A review of a source that declares npm dependencies, run as the reviewer runs it, with
// every answer it reads already in a cache: OSV's for each package the lock installs, npm's
// download count for each declared dependency, and the fixture caches for the rest. One
// advisory on a package the build pulls in for production rejects the add-on at its lock
// entry. The same run with one package's OSV answer missing asks the network, which the test
// switch refuses, so the review is answered by the caches and nothing else.
test("--cache-work-dir: a source review is answered by its seeded caches alone", () => {
  const fixture = addonOutsideRepo(
    path.join(FIXTURES, "sca-transitive-vulnerability")
  );
  const seeded = advisory(
    "GHSA-seed-1111-1111",
    "HIGH",
    "entity-decoder",
    "1.4.1"
  );
  const batch = {
    "markdown-render@2.0.0": {},
    "color-name-map@3.1.0": {},
    "entity-decoder@1.4.0": { vulns: [{ id: seeded.id }] },
    "bundler@5.0.0": {},
    "script-serializer@6.0.2": {},
  };
  const review = (answers) =>
    run([
      path.join(fixture, "xpi"),
      "--sca-root",
      path.join(fixture, "src"),
      ...OFFLINE_FLAGS,
      "--cache-work-dir",
      seedWorkCache({
        osv: osvEntries({
          batch: answers,
          advisories: { [seeded.id]: seeded },
        }),
        popularity: popularityEntries({
          npm: {
            "markdown-render": { downloads: 500000 },
            bundler: { downloads: 500000 },
          },
        }),
      }),
    ]);

  const r = review(batch);
  assert.equal(r.code, 1, r.stderr);
  assert.match(
    r.stdout,
    /\[SCA\] package-lock\.json:29 - entity-decoder@1\.4\.0 has known vulnerabilities \(GHSA-seed-1111-1111\)/
  );

  const { "color-name-map@3.1.0": _, ...unanswered } = batch;
  const missing = review(unanswered);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /network request in a test: \S*osv\.dev/);
});

// --cache-clear wipes the cache directories before the review (so every source
// re-fetches from scratch). Every --cache-*-dir points at one temp dir so the delete touches
// nothing else, the kept sources at one of their own, and a nonexistent add-on makes
// runPipeline fail at load (before any network) - we assert only that the stale files were
// deleted.
test("--cache-clear deletes the cache directories before the review", () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-clear-"));
  const stale = path.join(cacheDir, "webext-annotated-schemas-junk.zip");
  fs.writeFileSync(stale, "stale");
  const sourcesDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "wrr-clear-sources-")
  );
  const kept = path.join(sourcesDir, "sources.json");
  fs.writeFileSync(kept, "{}");
  run([
    "/no/such/addon.xpi",
    "--cache-clear",
    "--cache-schema-dir",
    cacheDir,
    "--cache-hash-db-dir",
    cacheDir,
    "--cache-cdn-lookup-dir",
    cacheDir,
    "--cache-experiments-dir",
    cacheDir,
    "--cache-npm-registry-dir",
    cacheDir,
    "--cache-sources-dir",
    sourcesDir,
  ]);
  assert.ok(!fs.existsSync(stale), "the stale cache file was cleared");
  assert.ok(!fs.existsSync(kept), "the kept sources were cleared");
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.rmSync(sourcesDir, { recursive: true, force: true });
});

// A pipeline hard-fail the review could not run through (here a missing add-on; an
// unusable schema or a failed schema download take the same path) exits 2 and
// states "verify failed" on stderr - distinct from a completed review that found
// error findings.
test("a pipeline hard-fail aborts: exit 2 and 'verify failed' on stderr", () => {
  const r = run(["/no/such/addon.xpi", ...OFFLINE_FLAGS]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /verify failed/);
});

// --sca-root is the SCA-mode switch; --sca-exp-source names a location inside it, so it
// is a usage error on its own. (--sca-root alone is fine - the whole archive is reviewed.)
test("--sca-exp-source without --sca-root is a usage error (exit 2)", () => {
  const r = run(["some.xpi", "--sca-exp-source", "src"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--sca-exp-source requires --sca-root/);
});

// In SCA mode, Experiment code is told apart from WebExtension code only by
// --sca-exp-source, so --allow-experiments without it is a usage error (else the
// privileged Experiment code would be reviewed as WebExtension code).
// And it names a folder INSIDE the root, so it may not BE the root: naming the root
// excludes nothing, which leaves the Experiment's privileged code reviewed as WebExtension
// code - the one thing the flag exists to prevent. Refused where the pair settles
// (src/addon/sca-root.js), so this asserts the throw reaches the EXIT rather than only the
// unit: "." is what a reviewer types for an add-on that is entirely an Experiment.
test("--sca-exp-source naming --sca-root itself is a usage error (exit 2)", () => {
  const r = run([
    "tests/addons/sca-nested-layout/xpi",
    "--sca-root",
    "tests/addons/sca-nested-layout/src",
    "--sca-exp-source",
    ".",
  ]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /cannot be the root/);
  assert.match(r.stderr, /Name the subfolder holding it/);
});

// The format decides how everything below it is routed, so it is checked where it is
// read - before the --llm-sca-review branch, which would otherwise print nothing at all
// and exit 0 for an unknown value.
test("an unknown --report-format is refused on every path (exit 2)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-fmt-"));
  fs.writeFileSync(path.join(dir, "a.xpi"), "");
  fs.writeFileSync(path.join(dir, "source.tar.gz"), "");
  for (const args of [
    ["some.xpi", "--report-format", "xml"],
    [dir, "--llm-sca-review", "--report-format", "xml"],
  ]) {
    const r = run(args);
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.stderr, /Invalid --report-format "xml"/, args.join(" "));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// The other flag whose value is a closed set. It reads as a boolean but arrives as a
// string, and the derivation disables the lookup on the exact lowercase "false" alone - so
// every near miss used to leave it ON, silently, while sending content hashes of the
// submission to a third party. "False" is the case worth naming: the plausible mistake, not
// a nonsense string.
test("an unknown --cdn-lib-lookup is refused (exit 2)", () => {
  for (const value of ["False", "no", "0", "flase", ""]) {
    const r = run(["some.xpi", "--cdn-lib-lookup", value]);
    assert.equal(r.code, 2, value);
    assert.match(
      r.stderr,
      new RegExp(`Invalid --cdn-lib-lookup "${value}"`),
      value
    );
    assert.match(r.stderr, /expected true or false/, value);
  }
  // The two it does take, and its absence, get past the guard - they fail later on the
  // add-on that is not there, which is a different exit and the point of the assertion.
  for (const args of [
    ["some.xpi"],
    ["some.xpi", "--cdn-lib-lookup", "true"],
    ["some.xpi", "--cdn-lib-lookup", "false"],
  ]) {
    assert.doesNotMatch(
      run(args).stderr,
      /Invalid --cdn-lib-lookup/,
      args.join(" ")
    );
  }
});

// --sca-root is the EXTRACTED source, and the guard asks one question: does the path
// point at a folder? A packed root is the case that motivates it: the loader reads .xpi
// archives and nothing else, so a .tar.gz reaches it as a file it cannot open - and the
// answer a reviewer needs is about the FLAG they got wrong, not about the bytes. A missing
// path and a trailing slash are the same answer. The loader's own refusal is asserted
// against below: this guard has to come first, or the usage error never gets printed.
test("--sca-root must point at a folder (exit 2)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-sca-root-"));
  const zip = path.join(dir, "source.zip");
  fs.writeFileSync(zip, "not a folder");
  fs.writeFileSync(path.join(dir, "source.tar.gz"), "not a folder");
  const refused = [
    zip,
    path.join(dir, "source.tar.gz"),
    // A trailing slash: existsSync says no, path.resolve drops it, and the loader would
    // have opened the archive anyway - so the guard asks about the resolved path.
    `${zip}/`,
    path.join(dir, "no-such-folder"),
  ];
  for (const root of refused) {
    const r = run(["some.xpi", "--sca-root", root]);
    assert.equal(r.code, 2, root);
    assert.match(r.stderr, /--sca-root must point at a folder/, root);
    // Neither the loader's refusal nor AdmZip's: this never reached the read.
    assert.doesNotMatch(
      r.stderr,
      /END header|unsupported zip|Could not read archive/i,
      root
    );
  }

  // The other names a folder INSIDE the root, and is asked the same question. It is why
  // this is a refusal and not a warning: warn and carry on, and the review reads the
  // Experiment's privileged code as WebExtension code.
  for (const flag of ["--sca-exp-source"]) {
    const r = run(["some.xpi", "--sca-root", dir, flag, "no-such-dir"]);
    assert.equal(r.code, 2, flag);
    assert.match(
      r.stderr,
      new RegExp(`\\${flag} must point at a folder`),
      flag
    );
    assert.match(r.stderr, /no-such-dir/, flag);
  }

  // A folder passes this guard, whatever ends the run after it.
  const ok = run(["some.xpi", "--sca-root", dir]);
  assert.doesNotMatch(ok.stderr, /must point at a folder/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// An .xpi the loader will not take ends the run before a review exists - the tool-failure
// channel, exit 2, no report - rather than reviewing whatever part of it could be read. Here
// the archive holds an entry whose name carries a "." segment, so the key it would land under
// is not the key the manifest.json's own reference resolves to (tests/unit/load.test.js covers
// each refused shape). Driven through the CLI for the one thing only this layer shows: that
// the refusal reaches stderr as the linter's own sentence, and that nothing from inside the
// archive rides along with it.
test("an archive the loader will not take fails the run (exit 2)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-badzip-"));
  const zip = new AdmZip();
  zip.addFile(
    "manifest.json",
    Buffer.from('{"manifest_version":3,"name":"x","version":"1"}')
  );
  zip.addFile("SECRET.js", Buffer.from("browser.runtime.id;\n"));
  // AdmZip's writer normalizes, so the name is stamped on after the entry is added.
  zip.getEntries().find((e) => e.entryName === "SECRET.js").entryName =
    "a/./SECRET.js";
  const file = path.join(dir, "addon.xpi");
  zip.writeZip(file);

  // In the default work folder, beside the add-on: the run that created it removes it.
  const r = runFile(REVIEW, [file, ...OFFLINE_FLAGS]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Could not read archive: /);
  assert.match(r.stderr, /verify failed/);
  // The entry name is the submission's, and the refusal carries none of it.
  assert.doesNotMatch(r.stderr, /SECRET/);
  // No review was produced: the run stopped at the read.
  assert.doesNotMatch(r.stdout, /Found Issues|Summary/);
  // A refusal mid-extraction leaves nothing behind for a reviewer to mistake for the
  // whole submission (src/addon/load.js extractZip's cleanup-on-throw), and no work folder
  // the run created for a review that never began.
  assert.deepEqual(fs.readdirSync(dir), ["addon.xpi"]);

  fs.rmSync(dir, { recursive: true, force: true });
});

// The linter reads a submission from disk once, whether or not an agent is involved: a
// packed .xpi is extracted into the work folder, under the one name every review uses, and
// read back from there.
test("a plain review of a packed .xpi extracts it into the work folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-plain-extract-"));
  const zip = new AdmZip();
  zip.addFile(
    "manifest.json",
    Buffer.from('{"manifest_version":3,"name":"x","version":"1"}')
  );
  zip.addFile("bg.js", Buffer.from("browser.runtime.id;\n"));
  const file = path.join(dir, "addon.xpi");
  zip.writeZip(file);

  const r = run([file, ...OFFLINE_FLAGS]);
  assert.notEqual(r.code, 2, r.stderr);
  // The review gets its folder beside the add-on, named after it.
  const work = defaultFolderOf(file);
  const extracted = path.join(work, "xpi");
  assert.equal(
    fs.readFileSync(path.join(extracted, "manifest.json"), "utf8"),
    '{"manifest_version":3,"name":"x","version":"1"}'
  );
  assert.equal(
    fs.readFileSync(path.join(extracted, "bg.js"), "utf8"),
    "browser.runtime.id;\n"
  );
  // The terminal header names which add-on and where to read it, in place of the raw
  // .xpi path.
  assert.equal(headerValue(r.stdout, "XPI_FILE"), "addon.xpi");
  assert.equal(headerValue(r.stdout, "XPI_ROOT"), `${extracted}${path.sep}`);
  // A plain review writes nothing else there: its report is printed.
  assert.deepEqual(fs.readdirSync(work), ["xpi"]);

  fs.rmSync(dir, { recursive: true, force: true });
});

// An unpacked submission is copied into the work folder like a packed one is extracted
// there, so XPI_ROOT is the same name in every review - and the submission is only read: its
// folder gets nothing but the work folder beside it.
test("a folder add-on is copied into the work folder and its parent left alone", () => {
  const addon = addonOutsideRepo(path.join(ROOT, "tests", "addons", "clean"));
  const before = fs.readdirSync(addon).sort();
  const r = run([addon, ...OFFLINE_FLAGS]);
  assert.notEqual(r.code, 2, r.stderr);
  const work = defaultFolderOf(addon);
  const copy = path.join(work, "xpi");
  assert.equal(headerValue(r.stdout, "XPI_ROOT"), `${copy}${path.sep}`);
  assert.deepEqual(fs.readdirSync(copy).sort(), before);
  assert.deepEqual(
    fs.readFileSync(path.join(copy, "manifest.json")),
    fs.readFileSync(path.join(addon, "manifest.json"))
  );
  assert.deepEqual(fs.readdirSync(addon).sort(), before);
  assert.deepEqual(fs.readdirSync(path.dirname(addon)).sort(), [
    "clean",
    path.basename(work),
  ]);
});

// A start that fails after the add-on was copied - here a source review of an Experiment
// without --sca-exp-source, which fails once its XPI is read - gives back the folder it
// created, so the same command can simply run again.
test("a failed start leaves the work folder as it found it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-failed-start-"));
  const xpi = path.join(dir, "xpi");
  const src = path.join(dir, "src");
  fs.mkdirSync(xpi);
  fs.mkdirSync(src);
  fs.writeFileSync(
    path.join(xpi, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Exp",
      version: "1.0",
      experiment_apis: { myapi: {} },
    })
  );
  fs.writeFileSync(path.join(src, "package.json"), "{}");
  const argv = [
    xpi,
    "--sca-root",
    src,
    "--allow-experiments",
    "--llm-review",
    ...OFFLINE_FLAGS,
  ];
  for (let i = 0; i < 2; i++) {
    const r = run(argv);
    assert.equal(r.code, 2, `run ${i + 1}`);
    assert.match(r.stderr, /--sca-exp-source/, `run ${i + 1}`);
    assert.doesNotMatch(r.stderr, /must not exist/, `run ${i + 1}`);
    assert.deepEqual(
      fs.readdirSync(dir).sort(),
      ["src", "xpi"],
      `run ${i + 1}`
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// A review's work folder is always its default, beside the add-on, and the only run that
// names an existing one is --llm-handback: --work-folder is no option, for any run.
test("--work-folder is an unknown option", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-work-flag-"));
  for (const argv of [
    ["x.xpi", "--work-folder", dir],
    [dir, "--llm-sca-review", "--work-folder", dir],
    ["--llm-handback", dir, "--work-folder", dir],
  ]) {
    const r = run(argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.stderr, /Unknown option '--work-folder'/, argv.join(" "));
  }
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Everything under --sca-root is reviewed as the source, so the add-on may never lie inside
// it - nor be it. Every folder argument is the folder it really is, so a link in a path
// changes none of this, and nothing is created.
test("--sca-root must not include the add-on", () => {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "wl-work-sca-"))
  );
  const proj = path.join(dir, "proj");
  const addon = path.join(proj, "dist", "addon");
  fs.cpSync(path.join(ROOT, "tests", "addons", "clean"), addon, {
    recursive: true,
  });
  fs.writeFileSync(path.join(proj, "package.json"), "{}");
  const link = path.join(dir, "link");
  fs.symlinkSync(proj, link);
  const before = fs.readdirSync(path.join(proj, "dist"));
  for (const [named, root] of [
    [addon, proj],
    [path.join(link, "dist", "addon"), proj],
    [addon, link],
    [addon, addon],
  ]) {
    const r = run([named, "--sca-root", root]);
    assert.equal(r.code, 2, named);
    const realRoot = root === link ? proj : root;
    assert.equal(
      r.stderr,
      `--sca-root "${realRoot}" must not include the add-on "${addon}".\n`,
      `${named} in ${root}`
    );
  }
  assert.deepEqual(fs.readdirSync(path.join(proj, "dist")), before);
  // Without --sca-root nothing is reviewed in place, and the default beside it is fine.
  const xpiOnly = run([addon, ...OFFLINE_FLAGS]);
  assert.notEqual(xpiOnly.code, 2, xpiOnly.stderr);
  const work = defaultFolderOf(addon);
  assert.ok(fs.existsSync(path.join(work, "xpi", "manifest.json")));
  fs.rmSync(dir, { recursive: true, force: true });
});

// A folder named through a link is the folder it names: an add-on is copied from its
// target, and a source root is reviewed where it really is.
test("folders named through a link are reviewed as their targets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-work-link-"));
  const addonLink = path.join(dir, "addon");
  const target = addonOutsideRepo(path.join(ROOT, "tests", "addons", "clean"));
  fs.symlinkSync(target, addonLink);
  const r = run([addonLink, ...OFFLINE_FLAGS]);
  assert.notEqual(r.code, 2, r.stderr);
  // The work folder goes beside the target, the folder the add-on really is.
  const work = defaultFolderOf(target);
  assert.ok(fs.existsSync(path.join(work, "xpi", "manifest.json")));
  const fixture = path.join(ROOT, "tests", "addons", "build-hygiene-sca");
  const srcLink = path.join(dir, "src");
  fs.symlinkSync(path.join(fixture, "src"), srcLink);
  const sca = run([
    path.join(fixture, "xpi"),
    "--sca-root",
    srcLink,
    ...OFFLINE_FLAGS,
  ]);
  assert.notEqual(sca.code, 2, sca.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Files are never followed: the .xpi named, and the files of a submission folder, must be
// the files themselves. The folder holding them may be a link.
test("an .xpi or a source archive given through a link is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-file-link-"));
  const real = path.join(dir, "real");
  fs.mkdirSync(real);
  const zip = new AdmZip();
  zip.addFile(
    "manifest.json",
    Buffer.from('{"manifest_version":2,"name":"x","version":"1"}')
  );
  zip.writeZip(path.join(real, "a.xpi"));
  fs.writeFileSync(path.join(real, "src.zip"), "");
  const linkedXpi = path.join(dir, "linked.xpi");
  fs.symlinkSync(path.join(real, "a.xpi"), linkedXpi);
  const r = runFile(REVIEW, [linkedXpi]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /The add-on ".+linked\.xpi" is a symlink/);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["linked.xpi", "real"]);

  // A submission folder named through a link is accepted ...
  const folderLink = path.join(dir, "submission");
  fs.symlinkSync(real, folderLink);
  const prepared = run(["--llm-sca-review", folderLink]);
  assert.equal(prepared.code, 0, prepared.stderr);
  // ... but not a submission whose files are links.
  for (const name of ["a.xpi", "src.zip"]) {
    const sub = path.join(dir, `sub-${name}`);
    fs.mkdirSync(sub);
    for (const file of ["a.xpi", "src.zip"]) {
      const target = path.join(real, file);
      if (file === name) {
        fs.symlinkSync(target, path.join(sub, file));
      } else {
        fs.copyFileSync(target, path.join(sub, file));
      }
    }
    const refused = run(["--llm-sca-review", sub]);
    assert.equal(refused.code, 2, name);
    assert.match(
      refused.stderr,
      new RegExp(`"${name.replace(".", "\\.")}" is a symlink`),
      name
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// A flag given with no value names something and says nothing. Asked of EVERY option that
// takes one, before any branch reads one: parseArgs hands "--flag=" down as "", which every
// reader tests for truth and so reads as "not given" - a named cache would silently be the
// default one, a named verdict file would print an unsettled report, a named format would
// fall back to text, and a named source root would review the XPI alone. Whitespace counts
// as none.
test("a flag given no value is refused (exit 2)", () => {
  for (const [argv, flag] of [
    [["some.xpi", "--report-format="], "--report-format"],
    [["some.xpi", "--checks-only="], "--checks-only"],
    [["some.xpi", "--cache-schema-dir="], "--cache-schema-dir"],
    [["some.xpi", "--llm-handback="], "--llm-handback"],
    [["some.xpi", "--sca-root="], "--sca-root"],
    [["some.xpi", "--sca-root", " "], "--sca-root"],
  ]) {
    const r = run(argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.stderr, new RegExp(`\\${flag} needs a value`), flag);
  }
  // --help is a request for the usage text, not a run: it is answered before this.
  assert.equal(run(["--help", "--report-format="]).code, 0);
});

// The guard asks the LOADER which folder a value names, rather than spelling the path math
// a second time. Spelled twice, ".src" validates as ".src" (found) and reads as "src" - a
// real folder, but not the one named, reviewed in silence. Pinned from the CLI end, because
// what fails there is the two ends disagreeing.
test("a folder flag is checked against the folder the review will read", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-dotdir-"));
  fs.mkdirSync(path.join(dir, "src"));

  // Only src/ exists: naming .src refuses, rather than reviewing src/ without a word.
  const missing = run([
    "some.xpi",
    "--sca-root",
    dir,
    "--sca-exp-source",
    ".src",
  ]);
  assert.equal(missing.code, 2);
  assert.match(
    missing.stderr,
    /--sca-exp-source must point at a folder: "[^"]*\/\.src"/
  );
  assert.match(missing.stderr, new RegExp(`${dir}/\\.src`), "looked in .src");

  // With the folder there, it passes this guard and the run reaches the next refusal.
  fs.mkdirSync(path.join(dir, ".src"));
  const ok = run(["some.xpi", "--sca-root", dir, "--sca-exp-source", ".src"]);
  // The run goes on to fail on the missing add-on instead, which is the point: this guard
  // no longer has anything to say about it.
  assert.doesNotMatch(ok.stderr, /must point at a folder/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Where a folder flag LANDS is the question, asked with the loader's own relativeInside so
// the guard and the review cannot answer it differently: a path resolving outside
// --sca-root names a folder on the reviewing machine. How it was spelled - a ".." segment
// included - makes no difference. For --sca-exp-source "nothing to exclude" is also the
// legitimate answer for an Experiment outside the source, so the mistake would not
// announce itself.
test("a folder flag is judged by where it lands, however it was spelled (exit 2 outside the root)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-folder-"));
  fs.mkdirSync(path.join(dir, "src"));

  // A folder INSIDE --sca-root may be named either way - relative to the root, or absolute,
  // which is the spelling the report prints and a reader hands straight back. What is
  // refused is where it LANDS: outside the root it names a folder on the reviewing machine,
  // so what it names is not the submission's and cannot be shown to be.
  const inside = run([
    "some.xpi",
    "--sca-root",
    dir,
    "--sca-exp-source",
    path.join(dir, "src"),
  ]);
  assert.doesNotMatch(
    inside.stderr,
    /--sca-exp-source/,
    "an absolute path inside is taken"
  );
  for (const argv of [
    ["some.xpi", "--sca-root", dir, "--sca-exp-source", "/tmp"],
    ["some.xpi", "--sca-root", dir, "--sca-exp-source", "../outside"],
  ]) {
    const r = run(argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.stderr, /which is outside/, argv.join(" "));
  }

  // A ".." segment is no reason to refuse: where it lands, the folder is the one named.
  for (const argv of [
    ["some.xpi", "--sca-root", `${dir}/../${path.basename(dir)}`],
    [
      "some.xpi",
      "--sca-root",
      dir,
      "--sca-exp-source",
      `../${path.basename(dir)}/src`,
    ],
  ]) {
    const r = run(argv);
    assert.doesNotMatch(r.stderr, /--sca-(root|exp-source)/, argv.join(" "));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// One add-on per run. A second positional silently ignored is how an unquoted path with a
// space in it would review the half before the space and say nothing about the rest - the
// shape --llm-sca-review's printed command could produce.
test("a second positional is refused (exit 2)", () => {
  const r = run(["some.xpi", "another.xpi"]);
  assert.equal(r.code, 2);
  assert.match(
    r.stderr,
    /Only one add-on can be reviewed at a time, and 2 were given/
  );
  assert.match(r.stderr, /"[^"]*some\.xpi", "another\.xpi"/);
});

// --help is a request for the usage text, not a run, so it is answered before every guard
// that judges the command line - a reader asking what the flags ARE is told, rather than
// refused over a flag this run will never reach. The two exceptions are the things that
// make an answer impossible: a command line that does not parse (and a registry that does
// not load, which no flag can reach).
test("--help is answered before every guard that judges a run", () => {
  for (const extra of [
    [],
    ["--report-format", "xml"],
    ["--llm-skip-manual"],
    ["--sca-root="],
    ["--checks-only", "no-such-check"],
    ["some.xpi", "another.xpi"],
  ]) {
    const r = run(["--help", ...extra]);
    assert.equal(r.code, 0, extra.join(" "));
    assert.match(r.stdout, /webext-linter - verify/, extra.join(" "));
    assert.equal(r.stderr, "", extra.join(" "));
  }
  // A command line that cannot be parsed has no flags to explain: the usage text comes
  // with the refusal, and the exit code says it was one.
  const unparsable = run(["--nope", "--help"]);
  assert.equal(unparsable.code, 2);
  assert.match(unparsable.stderr, /Unknown option/);
});

// No positional argument is a usage error: usage to stdout, exit 2.
test("no add-on argument prints usage and exits 2", () => {
  const r = run([]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /--checks-only/);
});

// An invalid --report-format is rejected before any work, on stderr, exit 2.
test("invalid --report-format errors to stderr and exits 2", () => {
  const r = run(["some.xpi", "--report-format", "bogus"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Invalid --report-format/);
});

// An unknown --checks-only id is rejected (validated against the registry) on
// stderr, exit 2.
test("unknown --checks-only id errors to stderr and exits 2", () => {
  const r = run(["some.xpi", "--checks-only", "no-such-check"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown check/);
});

// A real review renders a report to stdout and sets the exit code by severity
// (0 = clean, 1 = has error-severity findings).
test("reviewing a fixture renders to stdout with a severity-based exit", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const r = run([addon, ...OFFLINE_FLAGS, "--report-format", "json"]);
  assert.ok([0, 1].includes(r.code));
  const json = JSON.parse(r.stdout);
  assert.equal(json.meta.action, "review");
  assert.ok(Array.isArray(json.findings));
});

// A source code review's own steps send a sub-agent to paths, and those paths are what the
// review RESOLVED to be, never what the flags asked for: the root a review settles on can
// sit below the one --sca-root named, so a step reading the flag would send an agent to a
// root nothing had read. Driven through the CLI because that is the seam: rendering from a
// hand-built meta cannot catch a pipeline that feeds its two halves different values.
//
// Keyed on the paths themselves, because a path is all a step gives out: a sub-agent is
// handed the request and nothing else, so nothing in one stands for a path by name.
test("a source code review's steps carry the paths the review resolved to", () => {
  // A source review nothing aborts, so its first prompt is the build opening, which takes
  // both paths.
  const sca = path.join(ROOT, "tests", "addons", "sca-transpiled-kept");
  const r = run([
    path.join(sca, "xpi"),
    ...OFFLINE_FLAGS,
    "--sca-root",
    path.join(sca, "src"),
    "--llm-review",
  ]);
  // Each sits on its own line inside the step that hands it over, unwrapped and unaltered,
  // so the agent can copy it whole.
  const lines = r.stdout.split("\n").map((l) => l.trim());
  assert.ok(
    lines.includes(path.join(sca, "src")),
    "the step names the source root"
  );
  assert.ok(
    lines.some((l) => /\/build\.md$/.test(l)),
    "and where the build report goes"
  );

  // A rejected Experiment submitted WITH --sca-root is the source review it was asked to be:
  // it needs --sca-exp-source like any Experiment reviewed with source, and with it the review
  // starts and is aborted at its first check - so its first prompt is the close, and no build
  // report is asked for.
  const exp = path.join(ROOT, "tests", "addons", "experiment-disallowed-sca");
  const asked = [
    path.join(exp, "xpi"),
    ...OFFLINE_FLAGS,
    "--sca-root",
    path.join(exp, "src"),
    "--llm-review",
  ];
  const refused = run(asked);
  assert.equal(refused.code, 2, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /--sca-exp-source/);
  const rejected = run([
    ...asked,
    "--sca-exp-source",
    path.join(exp, "src", "experiment"),
  ]);
  assert.equal(rejected.code, 1, rejected.stderr);
  assert.match(rejected.stdout, /── LLM Prompt ──/);
  assert.doesNotMatch(rejected.stdout, /BUILD_PROCESS/);
  assert.ok(
    !rejected.stdout.split("\n").some((l) => /\/build\.md$/.test(l.trim())),
    "no build report is asked for"
  );
});

// --llm-review end to end. Its whole output is the prompt, the Review Details section and
// an item file: the prose report is deliberately absent, because its reader settles the
// items it can address rather than the report it can see. JSON is refused - that is the
// machine contract for ATN, which wants neither half of this.
test("--llm-review prints a prompt and writes the item file, not the report", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const on = run([addon, ...OFFLINE_FLAGS, "--llm-review"]);
  const lines = on.stdout.split("\n");
  const intro = lines.findIndex((l) =>
    l.startsWith("This review runs in passes")
  );
  assert.ok(intro > -1, "the loop's preamble is printed");
  // The prompt is the WHOLE output: no header block beside it, because every value a step
  // uses is printed by that step, and no Summary, because the tally is about to change.
  assert.doesNotMatch(on.stdout, /── Review Details ──/, "no header block");
  assert.doesNotMatch(on.stdout, /── Summary ──/, "no tally");
  // The first pass is the SPAWN phase, and it says nothing about the questions: a later
  // pass asks those, and the agent only ever sees what the pass in front of it needs.
  assert.doesNotMatch(on.stdout, /"answers"/, "the questions are a later pass");
  assert.match(on.stdout, /\/review\.json/, "the file to hand back is named");
  assert.match(
    on.stdout,
    /--llm-handback/,
    "and the command that hands it back"
  );
  // The description is a file the reader writes and the reviewer opens: this run names
  // the path, and never reads what lands there.
  assert.match(on.stdout, /^\s*\S+\/summary\.md$/m);
  assert.ok(
    !on.stdout.includes('"Report"'),
    "the answers are not prose in the prompt"
  );
  // The review itself is in the file, so none of it is printed.
  assert.ok(!on.stdout.includes("── Found Issues ──"), "no prose report");
  assert.ok(!on.stdout.includes("── Setup ──"), "no feed");

  // The spawn pass asks for nothing in this file: its work is starting the agents, and
  // each of those answers in a file of its own.
  assert.deepEqual(entriesOf(on.stdout), []);
  // The sweep request IS that file, named in the prompt and nowhere near it in content:
  // the orchestrating agent is handed a path and told to pass it on, so no instruction
  // text travels through the prompt at all.
  const request = on.stdout.match(/^\s*(\S+\/sweep-xpi\.yaml)$/m);
  assert.ok(request, "the sweep request is named");
  const doc = YAML.parse(fs.readFileSync(request[1], "utf8"));
  assert.ok(doc.sweepTarget, "it names the tree to read");
  assert.ok(
    doc.sweeps.length > 0,
    "one sweep per check that declared an instruction"
  );
  assert.ok(
    doc.sweeps.every((x) => x.label && x.instruction),
    "each carries its own label and the check's own instruction"
  );
  // And the answers file beside it is pre-created, one null per label - so a sweep
  // nobody ran cannot read as one that ran and found nothing.
  const slots = JSON.parse(fs.readFileSync(doc.answerFile, "utf8")).answers;
  assert.deepEqual(
    Object.keys(slots).map(Number),
    doc.sweeps.map((x) => x.label)
  );
  assert.ok(Object.values(slots).every((v) => v === null));

  const off = run([addon, ...OFFLINE_FLAGS]);
  assert.ok(!off.stdout.includes("Please verify"), "off by default");
  assert.match(off.stdout, /── Found Issues ──/, "the report prints normally");

  const json = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--report-format",
    "json",
  ]);
  assert.equal(json.code, 2);
  assert.match(json.stderr, /--llm-review is text only/);
});

// Both ends of the loop print a prompt, so both have to refuse the one format that is
// not one. --llm-handback returns from its own branch before reaching the test
// --llm-review takes, so the refusal is asked ahead of both. The message names the flag
// that was actually used, because a run that said --llm-handback is not helped by being
// told about --llm-review.
// A failure while building the NEXT pass is the tool's, not the agent's: its hand-back was
// accepted. So it is not a refusal - that would send the agent to retry a file it got right,
// into the same failure - but the clean failure every other tool error in the loop gives:
// the error's own message and "verify failed", exit 2, and the state left as it was.
test("a failure building the next pass ends it cleanly, not with a stack trace", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const first = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--llm-skip-summary",
  ]);
  assert.equal(first.code, 0, first.stderr);
  const file = first.stdout.match(/(\S+\/review\.json)/)[1];
  const stateFile = path.join(path.dirname(file), "state.json");
  // A finding in the archive, in a review that has no archive: the next phase cannot
  // resolve its path, which is the linter's own inconsistency to report.
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.report.findings.push({
    ruleId: "eval-call",
    severity: "error",
    file: "orphan.js",
    loc: { line: 1 },
    artifact: "SCA",
    message: "eval",
  });
  fs.writeFileSync(stateFile, JSON.stringify(state));
  sweepBack(file);
  const before = fs.readFileSync(stateFile, "utf8");

  const out = run(["--llm-handback", path.dirname(file), ...OFFLINE_FLAGS]);
  assert.equal(out.code, 2);
  assert.match(out.stderr, /orphan\.js/, "the error's own message");
  assert.match(out.stderr, /verify failed/);
  assert.doesNotMatch(out.stderr, /^\s+at /m, "no stack trace");
  assert.doesNotMatch(
    out.stdout,
    /not what this pass expected/,
    "not a refusal"
  );
  assert.equal(
    fs.readFileSync(stateFile, "utf8"),
    before,
    "the state is untouched"
  );
});

// A message that is not part of the normal review goes to stderr. In a run printing a
// prompt for an agent it is held back and written last, under its own header - the
// agent's harness merges both streams, and a warning printed in place reads as part of
// the prompt.
test("a warning reaches stderr, held back to the end of a prompt run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxl-warn-"));
  fs.cpSync(
    path.join(ROOT, "tests", "addons", "sca-experiment-vendored"),
    dir,
    {
      recursive: true,
    }
  );
  // A folder that exists and holds nothing: the run carries on, degraded, and says so.
  fs.mkdirSync(path.join(dir, "src", "emptyexp"));
  // Its VENDORS.md sends the review to GitHub for the vendored file, which no cache answers;
  // what this test reads is the held warning, which does not need it.
  fs.rmSync(path.join(dir, "src", "VENDORS.md"));
  const args = [
    path.join(dir, "xpi"),
    "--sca-root",
    path.join(dir, "src"),
    "--sca-exp-source",
    "emptyexp",
    ...OFFLINE_FLAGS,
  ];
  const WARNING = /matched no files under --sca-root/;

  const prompt = run([...args, "--llm-review", "--llm-skip-summary"]);
  assert.notEqual(prompt.code, 2, prompt.stderr);
  assert.doesNotMatch(prompt.stdout, WARNING, "not in the prompt");
  assert.match(prompt.stderr, /── Tool messages ──[\s\S]*matched no files/);

  const text = run(args);
  assert.doesNotMatch(text.stdout, WARNING);
  assert.match(text.stderr, WARNING, "a text run prints it in place");
  assert.doesNotMatch(text.stderr, /Tool messages/, "with nothing held back");
});

// A failure OUTSIDE main's promise - a throw from a callback nothing awaits - would end
// the process through Node's own handler, past exitWith, and lose every message the run
// was holding back. The entry point catches those too.
//
// Driven by a preloaded module that throws from a microtask queued as the prompt is
// printed: by then the run is holding its warning, and that microtask is queued ahead of
// main's own settlement, so it runs before the exit every time - no timing. (A nextTick
// would not: Node drains the microtask queue, exit included, before any nextTick.)
test("a failure outside main still dumps the held messages", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxl-crash-"));
  fs.cpSync(
    path.join(ROOT, "tests", "addons", "sca-experiment-vendored"),
    dir,
    {
      recursive: true,
    }
  );
  fs.mkdirSync(path.join(dir, "src", "emptyexp"));
  // Its VENDORS.md sends the review to GitHub for the vendored file, which no cache answers;
  // what this test reads is the held warning, which does not need it.
  fs.rmSync(path.join(dir, "src", "VENDORS.md"));
  const stray = path.join(dir, "stray.mjs");
  fs.writeFileSync(
    stray,
    [
      "const write = process.stdout.write.bind(process.stdout);",
      "let thrown = false;",
      "process.stdout.write = (chunk, ...rest) => {",
      '  if (!thrown && String(chunk).includes("LLM Prompt")) {',
      "    thrown = true;",
      "    queueMicrotask(() => {",
      '      throw new Error("stray failure outside main");',
      "    });",
      "  }",
      "  return write(chunk, ...rest);",
      "};",
      "",
    ].join("\n")
  );
  const r = spawnSync(
    process.execPath,
    [
      "--import",
      stray,
      REVIEW,
      path.join(dir, "xpi"),
      "--sca-root",
      path.join(dir, "src"),
      "--sca-exp-source",
      "emptyexp",
      "--llm-review",
      ...OFFLINE_FLAGS,
    ],
    { encoding: "utf8" }
  );
  assert.equal(r.status, 2, r.stderr);
  assert.match(
    r.stderr,
    /── Tool messages ──[\s\S]*matched no files[\s\S]*stray failure outside main/,
    "the held warning, then the failure, in one block"
  );
});

test("both ends of the review loop refuse --report-format json", () => {
  const started = run([
    "--llm-handback",
    "/nonexistent",
    "--report-format",
    "json",
  ]);
  assert.equal(started.code, 2);
  assert.match(started.stderr, /--llm-handback is text only/);
  assert.doesNotMatch(
    started.stderr,
    /--llm-review/,
    "names the flag the run used"
  );

  // Text is still the loop's own format, so the pass runs - and a folder holding no review
  // is a hand-back gone wrong, refused to the agent on stdout like any other.
  const text = run(["--llm-handback", "/nonexistent"]);
  assert.equal(text.code, 2);
  assert.match(
    text.stdout,
    /The hand-back was refused: "\/nonexistent" holds no review/
  );
});

// The review file is the linter's to name, so the flag takes no value at all - which is
// what lets it sit anywhere on the command line, including before the add-on, where a flag
// with an optional value would have swallowed the path and left nothing to review. It sits
// in the run's own work folder, so no second run can open the file a reader is still
// working from.
test("--llm-review names its own review file and swallows no argument", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const named = (r) => reviewFile(r.stdout);

  // After the add-on, before it, and before another option: the same review either way.
  const written = [
    named(run([addon, ...OFFLINE_FLAGS, "--llm-review"])),
    named(run([...OFFLINE_FLAGS, "--llm-review", addon])),
    named(run([addon, ...OFFLINE_FLAGS, "--llm-review", "--eslint"])),
  ];
  for (const file of written) {
    assert.ok(file && fs.existsSync(file), `${file} was written`);
    assert.ok(Array.isArray(JSON.parse(fs.readFileSync(file, "utf8")).entries));
    assert.equal(path.basename(file), "review.json");
  }
  assert.equal(
    new Set(written).size,
    written.length,
    "each run writes its own file, so none truncates another's"
  );
});

// The ESLint code-sanity check is opt-in: it runs only when --eslint is passed.
test("--eslint gates the code-sanity check", () => {
  const addon = path.join(ROOT, "tests", "addons", "all-checks");
  const base = [addon, ...OFFLINE_FLAGS, "--report-format", "json"];
  const off = JSON.parse(run(base).stdout);
  assert.ok(!off.meta.checksRun.includes("code-sanity")); // default: not run
  const on = JSON.parse(run([...base, "--eslint"]).stdout);
  assert.ok(on.meta.checksRun.includes("code-sanity")); // --eslint: runs
});

// The whole of --warnings-as-errors, from the outside: the band a finding is published at,
// the tally that counts it, the verdict preamble that opens the section, and the exit code.
// One flag is read in one place (src/checks/registry.js bandUnder) and all four follow.
test("--warnings-as-errors settles a warning as an error, exit code included", () => {
  const addon = path.join(ROOT, "tests", "addons", "mistyped-manifest-value");
  const base = [addon, ...OFFLINE_FLAGS];
  const off = run([...base, "--report-format", "json"]);
  const offDoc = JSON.parse(off.stdout);
  assert.equal(off.code, 0); // a warning alone does not fail the run
  assert.ok(offDoc.summary.warning > 0 && offDoc.summary.error === 0);

  const on = run([...base, "--warnings-as-errors", "--report-format", "json"]);
  const onDoc = JSON.parse(on.stdout);
  assert.equal(on.code, 1);
  assert.equal(onDoc.summary.warning, 0);
  assert.equal(onDoc.summary.error, offDoc.summary.warning);
  // The same findings, not more of them: the flag moves a band, it finds nothing new.
  assert.deepEqual(onDoc.summary.byRule, offDoc.summary.byRule);

  // The text report opens with the rejection preamble rather than the one that thanks the
  // developer and asks for a fix in the next release.
  const text = run([...base, "--warnings-as-errors"]).stdout;
  assert.match(text, /caused the submission to be rejected/);
  assert.doesNotMatch(
    text,
    /resolve the following issues with your next release/
  );
});

// The band belongs to the REVIEW, recorded when it started, so a later pass reads it back
// instead of being told it again - two sources for one fact is one of them going stale.
test("--warnings-as-errors is refused on a --llm-handback pass", () => {
  const r = run(["--llm-handback", "/nonexistent", "--warnings-as-errors"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /belongs to the review/);
  // Refused before the folder is read: the message is about the flag, not about the path.
  assert.doesNotMatch(r.stderr, /nonexistent/);
});

// ...and read back it is: a case a later pass reports becomes a finding in the band the
// review started with, so a warning reported under the flag is an error, exit code included.
test("a hand-back pass reports a case in the band its review recorded", () => {
  const addon = path.join(ROOT, "tests", "addons", "optional-permission");
  const settle = (...flags) => {
    const first = run([
      addon,
      ...OFFLINE_FLAGS,
      "--llm-review",
      "--llm-skip-summary",
      "--llm-skip-manual",
      "--llm-skip-sweep",
      "--checks-only",
      "unused-permission",
      ...flags,
    ]);
    assert.equal(first.code, 0, first.stderr);
    const file = reviewFile(first.stdout);
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(
      doc.entries.map((e) => e.ruleId),
      ["unused-permission"]
    );
    doc.entries = doc.entries.map((e) => ({ ...e, answer: "reported" }));
    fs.writeFileSync(file, JSON.stringify(doc));
    return run(["--llm-handback", path.dirname(file)]);
  };
  const plain = settle();
  assert.equal(plain.code, 0, plain.stdout + plain.stderr);
  assert.match(plain.stdout, /0 error\(s\), 0 hold, 1 warning\(s\)/);
  const strict = settle("--warnings-as-errors");
  assert.equal(strict.code, 1, strict.stdout + strict.stderr);
  assert.match(strict.stdout, /1 error\(s\), 0 hold, 0 warning\(s\)/);
});

// JSON is a machine contract: stdout is the document, stderr is silent - even
// with --verbose (no activity feed, no notices).
test("JSON output is fully silent on stderr, even with --verbose", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const r = run([
    addon,
    ...OFFLINE_FLAGS,
    "--report-format",
    "json",
    "--verbose",
  ]);
  assert.ok([0, 1].includes(r.code));
  assert.doesNotThrow(() => JSON.parse(r.stdout));
  assert.equal(r.stderr, "");
});

// --sca-root / --sca-exp-source flow through to the source-code submission pipeline opts
// (--sca-root alone switches the review to SCA mode).
// The reader is where a path stops being a spelling and becomes a place: --sca-root against
// the working directory, and the one that names a folder inside it against the RESOLVED
// root. Everything downstream is handed absolutes and re-resolves nothing.
test("--sca-root / --sca-exp-source map to the sca pipeline opts", () => {
  const o = pipelineOptsFromArgv([
    "--sca-root",
    "pkg",
    "--sca-exp-source",
    "exp",
  ]);
  assert.equal(o.scaRoot, path.resolve("pkg"));
  assert.equal(o.scaExpSource, path.resolve("pkg", "exp"));
  // Every spelling of the same folder arrives as one value.
  for (const written of [
    "exp",
    "./exp",
    "./exp/",
    path.resolve("pkg", "exp"),
  ]) {
    const each = pipelineOptsFromArgv([
      "--sca-root",
      "pkg",
      "--sca-exp-source",
      written,
    ]);
    assert.equal(each.scaExpSource, path.resolve("pkg", "exp"), written);
  }
  assert.ok(!pipelineOptsFromArgv([]).scaRoot);
  assert.ok(!pipelineOptsFromArgv([]).scaExpSource);
});

// The two skips end to end: the same round trip, minus the two parts that need a person.
// The sweep, the findings and the Extended Code Review are asked for exactly as a plain
// --llm-review asks for them; the add-on description and the manual questions are not, and
// the manual items are absent from the item file so the prompt and the file agree about
// what the reader is being asked to settle. They stay in the REPORT, for the reviewer.
test("the two skips withhold the description and the manual items", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const on = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--llm-skip-summary",
    "--llm-skip-manual",
  ]);
  const lines = on.stdout.split("\n");
  const intro = lines.findIndex((l) =>
    l.startsWith("This review runs in passes")
  );
  assert.ok(intro > -1, "the loop's preamble is printed");
  // The prompt is the WHOLE output: no header block beside it, because every value a step
  // uses is printed by that step, and no Summary, because the tally is about to change.
  assert.doesNotMatch(on.stdout, /── Review Details ──/, "no header block");
  assert.doesNotMatch(on.stdout, /── Summary ──/, "no tally");
  assert.ok(!on.stdout.includes("── Found Issues ──"), "no prose report");
  assert.ok(!on.stdout.includes("── Setup ──"), "no feed");

  // The inverse of the --llm-review assertions above: these are the two withheld steps,
  // and their absence is the whole feature.
  assert.ok(!on.stdout.includes('"answers"'), "no manual questions asked");
  assert.doesNotMatch(
    on.stdout,
    /\/summary\.md/,
    "no add-on description asked for, and no file named for one"
  );
  // ...while the step that closes the round trip survives the renumbering.
  assert.match(on.stdout, /--llm-handback/);

  // --llm-skip-summary leaves the sweep as the spawn phase's only agent, and the pass asks
  // about nothing in the file.
  assert.match(on.stdout, /Spawn an independent sub-agent NOW to sweep/);
  assert.deepEqual(entriesOf(on.stdout), []);
  assert.equal(on.code, 0);
});

// Each skip cuts ONE part, and the other is untouched: the pair is not a single decision
// wearing two names. Asserted at both ends - what the prompt asks for, and what the item
// file carries - because the two must agree about what the reader is being asked to settle.
test("each skip leaves out its own part and nothing else", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const itemsOf = (r) => entriesOf(r.stdout);
  const manualSections = ["Extended Manual Review", "Standard Manual Review"];

  // The description goes, the questions stay: the file still offers answers.
  const noSummary = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--llm-skip-summary",
  ]);
  assert.equal(noSummary.code, 0, noSummary.stderr);
  assert.doesNotMatch(noSummary.stdout, /\/summary\.md/);
  // The questions are a later pass, so the first prompt names none either way. What the
  // skip decides is whether the FILE still carries them.

  assert.doesNotMatch(
    noSummary.stdout,
    /Spawn an independent sub-agent NOW to describe/,
    "no description agent is spawned"
  );

  // The questions go, the description stays: the file carries no manual entry.
  const noManual = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--llm-skip-manual",
  ]);
  assert.equal(noManual.code, 0, noManual.stderr);
  assert.match(noManual.stdout, /^\s*\S+\/summary\.md$/m);
  assert.ok(!noManual.stdout.includes('"answers"'), "no questions asked");
  assert.ok(
    !itemsOf(noManual).some((x) => manualSections.includes(x.section)),
    "no manual entry in the file"
  );
});

// The description file is named only when the step that writes it PRINTS. Two things
// withhold that step - --llm-skip-summary names it, and a review with nothing to settle
// prints no steps at all - and a path printed for a file nobody is asked to write is an
// instruction with no step behind it. The second route is the one a skip does not cover.
test("a review with nothing to settle names no description file", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const r = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--llm-skip-manual",
    "--checks-only",
    "debugger-statement",
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /── LLM Prompt ──/);
  // A review with nothing to SETTLE still has something to DO: the description is for the
  // reviewer, who still gets a report. So the spawn phase prints, and the phases that
  // settle entries do not - which is the rule, not an exception to it.
  assert.match(r.stdout, /^1\. Spawn an independent sub-agent/m);
  assert.doesNotMatch(r.stdout, /Verify every entry/, "nothing to verify");
  assert.doesNotMatch(r.stdout, /Settle each entry/, "nothing to settle");
  // The step that spawns the description agent gives it the PATH it writes to, on a line
  // of its own and in the sentence that tells it to write - a sub-agent is handed the
  // request and nothing else, so a name standing for a path it never saw names nothing.
  assert.match(
    r.stdout,
    /Write it to\n\n\s+\S+\/summary\.md\n\n\s+and to nothing else/
  );
  assert.doesNotMatch(r.stdout, /ADDON_DESCRIPTION/);
  // The review file is handed over with nothing to answer: this phase has a step to do
  // and no entries, which is work either way.
  assert.deepEqual(entriesOf(r.stdout), []);
});

// Each skip names part of the --llm-review prompt, so neither says anything without it:
// a run that prints its report has no prompt to cut down. Refused before every other
// guard, and the wording names the flags that were actually given.
test("a skip without --llm-review is refused", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const one = run([addon, ...OFFLINE_FLAGS, "--llm-skip-manual"]);
  assert.equal(one.code, 2);
  assert.match(one.stderr, /--llm-skip-manual names part/);
  assert.match(one.stderr, /it needs --llm-review, or --llm-sca-review/);

  const both = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-skip-summary",
    "--llm-skip-manual",
  ]);
  assert.equal(both.code, 2);
  assert.match(
    both.stderr,
    /--llm-skip-summary and --llm-skip-manual name parts/
  );
  assert.match(both.stderr, /they need --llm-review, or --llm-sca-review/);

  // --llm-skip-sweep is not one of them - it names no `skip:` step, so it feeds the
  // `run: sweep` condition instead - but the rule it lives under is the same one.
  const sweep = run([addon, ...OFFLINE_FLAGS, "--llm-skip-sweep"]);
  assert.equal(sweep.code, 2);
  assert.match(sweep.stderr, /--llm-skip-sweep names part/);
});

// --llm-review carries its own guards, and a skip changes none of them: the prompt is
// still text only, and it is still the asking half of a round trip --llm-handback closes.
test("a skipped review carries the same guards", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const json = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--llm-skip-manual",
    "--report-format",
    "json",
  ]);
  assert.equal(json.code, 2);
  assert.match(json.stderr, /--llm-review is text only/);

  const verdict = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--llm-skip-summary",
    "--llm-handback",
    os.tmpdir(),
  ]);
  assert.equal(verdict.code, 2);
  assert.match(verdict.stderr, /--llm-review and --llm-handback/);
});

// --llm-review switches on the verification prompt and the skips cut it down: the review
// stays deterministic, so all three must reach the pipeline as print decisions and leave
// every other opt alone. The skips arrive as the registry's own words, which is what
// format.js and items.js match them against.
test("a review flag carries only the prompt decision into the run", () => {
  // The hand-back command is a closure over the parsed flags, so two runs never produce
  // the same function object however alike the flags were. Compared by what it BUILDS
  // instead, below; dropped from the structural comparisons, which it would always fail.
  const shape = ({ llmSweepCommand: _drop, ...rest }) => rest;
  const bare = pipelineOptsFromArgv([]);
  assert.equal(bare.llmReview, false);
  assert.deepEqual(bare.llmSkip, []);

  const full = pipelineOptsFromArgv(["--llm-review"]);
  assert.equal(full.llmReview, true);
  assert.deepEqual(full.llmSkip, []);
  assert.deepEqual(shape({ ...full, llmReview: false }), shape(bare));

  const cut = pipelineOptsFromArgv([
    "--llm-review",
    "--llm-skip-manual",
    "--llm-skip-summary",
  ]);
  // Authored order, never the order the flags were given: the registry names the steps.
  assert.deepEqual(cut.llmSkip, ["llm-skip-summary", "llm-skip-manual"]);
  assert.deepEqual(
    shape({ ...cut, llmReview: false, llmSkip: [] }),
    shape(bare)
  );

  // The skips do not ride along in a hand-back any more: the run that was given them puts
  // them in the state, and every pass after reads that. So a later pass needs no flags at
  // all beyond the file it hands back.
});

// The retired flags parse as unknown options (exit 2), so a stale command line fails
// loudly instead of being quietly ignored.
test("retired flags are unknown options", () => {
  for (const flag of [
    "--ai-review",
    "--full-summary",
    "--diff-summary",
    "--llm-sweep-results",
  ]) {
    const r = run(["x.xpi", flag]);
    assert.equal(r.code, 2, `${flag} should exit 2`);
    assert.match(r.stderr, /Unknown option/, `${flag} should be unknown`);
  }
});

/**
 * Play the sweeping sub-agents this run started: answer every sweep it asked for, taking
 * what to report for a check from `found` and answering every other with the empty list.
 *
 * Which label belongs to which check is read off the STATE, because that is where the
 * review recorded it - the request handed to an agent names no check id at all, which is
 * the point of it.
 */
function sweepBack(reviewFile, found = {}) {
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

// A sweep, end to end through the loop. The blind spot the sweep covers is the one thing
// the deterministic checks cannot find for themselves, so what it hands back has to become
// an item of the check it names - routed, numbered, and settled like any other.
//
// This one ESCALATES, so a swept case becomes an escalation of it, asking the question that
// check asks. The route below it covers the other kind.
test("a swept case becomes an item of its check and settles like any other", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const first = run([addon, ...OFFLINE_FLAGS, "--llm-review"]);
  assert.equal(first.code, 0, first.stderr);
  const file = first.stdout.match(/(\S+\/review\.json)/)[1];

  // The spawn pass asks nothing in this file - the sweeping agents answer in their own,
  // where an empty list is "swept and clean" and a null is "never looked".
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).entries, []);
  sweepBack(file, {
    "data-exfiltration": [
      {
        file: "background.js",
        line: 12,
        hint: "<a ping> attribute carries the message digest",
      },
    ],
  });

  // The next pass carries it as a case of its own check, with its locus and its hint.
  const second = run(["--llm-handback", path.dirname(file), ...OFFLINE_FLAGS]);
  assert.equal(second.code, 0, second.stderr);
  const next = JSON.parse(fs.readFileSync(file, "utf8"));
  const swept = next.entries.find((e) => e.ruleId === "data-exfiltration");
  assert.ok(swept, "the swept case is an entry of its own check");
  assert.equal(swept.hint, "<a ping> attribute carries the message digest");
  assert.match(second.stdout, /Settle each entry yourself/);

  // Settled like any other, and the developer reads the OWNING check's words - not the
  // sweeping agent's, which never leave the hint.
  next.entries = next.entries.map((e) => ({ ...e, answer: "reported" }));
  fs.writeFileSync(file, JSON.stringify(next, null, 1));
  let out = run(["--llm-handback", path.dirname(file), ...OFFLINE_FLAGS]);
  // Every prompt but the closing one ends on the command that hands it back.
  while (/^\s+node verify\.js --llm-handback /m.test(out.stdout)) {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.entries = doc.entries.map((e) => ({ ...e, answer: "Clear" }));
    fs.writeFileSync(file, JSON.stringify(doc, null, 1));
    out = run(["--llm-handback", path.dirname(file), ...OFFLINE_FLAGS]);
  }
  assert.equal(out.code, 1, out.stderr);
  // The invariant clause, not the subject: what the response calls the data (user data,
  // telemetry, ...) is wording the registry owns and may reword, and this test is about
  // the response reaching the output at all.
  const report = reportOf(out.stdout);
  assert.match(report, /to a remote server without an explicit opt-in/);
  // Squared off on the way into the report, like every other angle bracket in it. The hint
  // is a THIRD source of them, after our own prose and the submission's own tokens: the
  // agent wrote this one, and it names an HTML element, so it would open a tag in the
  // document the reviewer sends.
  assert.match(
    report,
    /background\.js:12 - \[a ping\] attribute carries the message digest/
  );
});

// A check with NO escalation settles its cases as FINDINGS - `cleartext-transmission` sees
// http:// and files one. So a hint its detectors missed is a finding too, and the verify
// phase audits it exactly like a detected one: same phase, same two verbs, and the report
// words it from that check's own response. The sweep's own text settles nothing.
test("a swept case of a check that files findings is verified like one", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const first = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--llm-skip-summary",
  ]);
  assert.equal(first.code, 0, first.stderr);
  const file = first.stdout.match(/(\S+\/review\.json)/)[1];

  sweepBack(file, {
    "cleartext-transmission": [
      { file: "sync.js", line: 12, hint: "posts over http://" },
    ],
  });

  // It arrives in VERIFY, as a finding: a locus and the agent's hint, and no `instructions`
  // - a finding carries no question, because it is a claim to be audited.
  const second = run(["--llm-handback", path.dirname(file), ...OFFLINE_FLAGS]);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /Verify every entry in ONE pass/);
  const verify = JSON.parse(fs.readFileSync(file, "utf8"));
  const swept = verify.entries.find(
    (e) => e.ruleId === "cleartext-transmission"
  );
  assert.ok(swept, "the swept hint is a verify entry of its own check");
  assert.equal(swept.hint, "posts over http://");
  assert.equal(
    swept.instructions,
    undefined,
    "a finding carries no instructions"
  );

  // Confirmed, it reaches the developer worded by the OWNING check - never by the sweep.
  verify.entries = verify.entries.map((e) => ({ ...e, answer: "reported" }));
  fs.writeFileSync(file, JSON.stringify(verify, null, 1));
  let out = run(["--llm-handback", path.dirname(file), ...OFFLINE_FLAGS]);
  // Every prompt but the closing one ends on the command that hands it back.
  while (/^\s+node verify\.js --llm-handback /m.test(out.stdout)) {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.entries = doc.entries.map((e) => ({ ...e, answer: "Clear" }));
    fs.writeFileSync(file, JSON.stringify(doc, null, 1));
    out = run(["--llm-handback", path.dirname(file), ...OFFLINE_FLAGS]);
  }
  const report = reportOf(out.stdout);
  assert.match(report, /Data is sent over an unencrypted connection/);
  assert.match(report, /sync\.js:12 - posts over http:\/\//);
});

// ---- --llm-sca-review ----
// The half of an SCA review a program can do: which file is the add-on, which is the
// source, and where it is extracted. It reviews nothing - it cannot, until its reader has
// opened the source archive - so its whole output is that prompt, and every run after it is
// a hand-back of the work folder, which starts the review itself once the preparation is
// done.

/** A submission folder: one built add-on, one source archive, and the usual clutter. The
 *  add-on is a real one, because the hand-back that finishes the preparation reviews it. */
function submissionFolder(name = "addon.xpi") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-submission-"));
  packAddon(path.join(dir, name));
  fs.writeFileSync(path.join(dir, "src-4.3.12.tar_ABC.gz"), "");
  fs.writeFileSync(path.join(dir, "README.txt"), "");
  return dir;
}

/** Pack the clean fixture as an .xpi at `file`, with `manifest` merged into its own. */
function packAddon(file, manifest = {}) {
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
const NO_LOCK_SOURCE = path.join(
  ROOT,
  "tests",
  "addons",
  "missing-lock-sca",
  "src"
);

/** The command a preparation prompt prints, one flag per line: the paragraph after the
 *  step that says to run the linter. */
function commandOf(stdout) {
  return stdout
    .split("with exactly these flags, and nothing else:\n\n")[1]
    .split("\n\n")[0]
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** The work folder a first prompt created: the folder its ANSWERS file is in. */
const workOf = (stdout) => path.dirname(headerValue(stdout, "ANSWERS"));

/** A work folder's JSON file, read back. */
const readJson = (work, name) =>
  JSON.parse(fs.readFileSync(path.join(work, name), "utf8"));

/**
 * Do what the first prompt asks, the way its reader would: extract the source into
 * EXTRACT_TO, fill the roots into ANSWERS, and run the hand-back it prints - which, with
 * nothing to rescue, starts the review.
 * @param {string} stdout  The --llm-sca-review run's output.
 * @param {{expSource?: string, typed?: (work: string) => string}} [opts]  The Experiment
 *   folder to answer, relative to the root, for an add-on that declares Experiments - and
 *   how the work folder is typed, where not as the prompt prints it.
 * @returns {{code: number, stdout: string, stderr: string}}  The hand-back's run.
 */
function handBackRoots(stdout, { expSource, typed } = {}) {
  const root = headerValue(stdout, "EXTRACT_TO");
  fs.cpSync(NO_LOCK_SOURCE, root, { recursive: true });
  if (expSource) {
    fs.mkdirSync(path.join(root, expSource), { recursive: true });
  }
  const answers = headerValue(stdout, "ANSWERS");
  const doc = JSON.parse(fs.readFileSync(answers, "utf8"));
  doc.entries = doc.entries.map((e) => ({
    ...e,
    answer: e.index === "SCA_ROOT" ? root : expSource,
  }));
  fs.writeFileSync(answers, JSON.stringify(doc, null, 1));
  return typed
    ? run(["--llm-handback", typed(workOf(stdout))])
    : run(argvOf(commandOf(stdout)));
}

/** A printed command, one flag per line, as the argv it stands for. */
function argvOf(flags) {
  return flags.flatMap((line) => {
    const [flag, ...rest] = line.split(" ");
    const value = rest.join(" ").replace(/^'|'$/g, "");
    return value ? [flag, value] : [flag];
  });
}

test("--llm-sca-review prints the prompt, names both files, and reviews nothing", () => {
  const dir = submissionFolder();
  const r = run([dir, "--llm-sca-review", ...OFFLINE_FLAGS]);
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
  fs.rmSync(dir, { recursive: true, force: true });
});

// The source is extracted into the review's work folder before the review starts, so the
// preparation creates that folder - at its default place, beside the .xpi - names its sca/
// as EXTRACT_TO, writes its record and the review file the roots come back in, and hands
// the folder back with --llm-handback.
test("--llm-sca-review creates the work folder and hands it back", () => {
  const dir = submissionFolder();
  const r = run([dir, "--llm-sca-review"]);
  assert.equal(r.code, 0, r.stderr);
  const made = fs
    .readdirSync(dir)
    .filter((n) => /^addon-\d{4}-\d{2}-\d{2}T[\d-]+Z$/.test(n));
  assert.equal(made.length, 1, "one work folder, beside the .xpi");
  const work = path.join(dir, made[0]);
  assert.deepEqual(fs.readdirSync(work).sort(), [
    "prepare.json",
    "review.json",
  ]);
  assert.equal(
    headerValue(r.stdout, "EXTRACT_TO"),
    `${path.join(work, "sca")}${path.sep}`
  );
  assert.equal(
    headerValue(r.stdout, "ANSWERS"),
    path.join(work, "review.json")
  );
  assert.deepEqual(readJson(work, "review.json"), {
    entries: [{ index: "SCA_ROOT", answer: null }],
  });
  assert.deepEqual(commandOf(r.stdout), [`--llm-handback ${work}`]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The hand-back that finds the preparation done starts the review itself, in that folder,
// with the add-on and the root the preparation recorded - the agent runs no command but the
// hand-back. The review's first prompt is what it prints, and the next hand-back of the
// same folder carries the review on.
test("the hand-back that finishes the preparation starts the review", () => {
  const dir = submissionFolder();
  const prepared = run([
    dir,
    "--llm-sca-review",
    ...OFFLINE_FLAGS,
    "--checks-only",
    "unused-files",
  ]);
  assert.equal(prepared.code, 0, prepared.stderr);
  const work = workOf(prepared.stdout);
  const handed = handBackRoots(prepared.stdout);
  assert.notEqual(handed.code, 2, handed.stdout + handed.stderr);
  assert.equal(handed.stderr, "", "the review starts cleanly");
  assert.match(handed.stdout, /── LLM Prompt ──/);
  assert.doesNotMatch(handed.stdout, /SCA Review Prompt/);
  assert.equal(readJson(work, "prepare.json").step, "done");
  const { meta } = readJson(work, "state.json").report;
  assert.equal(meta.xpi, path.join(dir, "addon.xpi"));
  assert.equal(meta.scaRoot, path.join(work, "sca"));
  assert.deepEqual(meta.checksRun, ["unused-files"]);
  // From here on the folder holds a review, and its hand-back is a pass of the loop.
  const next = run(["--llm-handback", work]);
  assert.doesNotMatch(next.stdout, /SCA Review Prompt/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The flags the review is run with are this run's own, recorded as parsed: the same however
// they were spelt and in the order OPTIONS declares them, a boolean never paired with what
// follows it. The run's own --cache-clear and --verbose stay with it. A flag invented or
// dropped here reviews a different submission than the reviewer asked about -
// --allow-experiments most of all, which decides whether the review runs at all.
test("the preparation records the flags its review is started with", () => {
  const dir = submissionFolder();
  const xpi = path.join(dir, "addon.xpi");
  // The offline flags every run here is given are recorded too, and left out of what is
  // compared.
  const ownFlags = (work) =>
    Object.fromEntries(
      Object.entries(readJson(work, "prepare.json").flags).filter(
        ([name]) => !/^(cache-|cdn-lib-lookup)/.test(name)
      )
    );
  const prepared = (...flags) => {
    const r = run([dir, "--llm-sca-review", ...OFFLINE_FLAGS, ...flags]);
    assert.equal(r.code, 0, r.stderr);
    return r;
  };

  const both = prepared("--allow-experiments", "--eslint");
  assert.deepEqual(Object.entries(ownFlags(workOf(both.stdout))), [
    ["eslint", true],
    ["allow-experiments", true],
  ]);
  const only = prepared("--checks-only=unused-files");
  assert.deepEqual(ownFlags(workOf(only.stdout)), {
    "checks-only": "unused-files",
  });
  handBackRoots(only.stdout);
  assert.deepEqual(
    readJson(workOf(only.stdout), "state.json").report.meta.checksRun,
    ["unused-files"],
    "the started review runs with them"
  );
  // --cache-clear really empties the caches it is given, so this run is given its own.
  const own = prepared(
    "--eslint",
    "--verbose",
    "--cache-clear",
    ...cacheFlags(freshFixtureCache(), cdnMissCache(FIXTURES_DIR))
  );
  assert.deepEqual(ownFlags(workOf(own.stdout)), { eslint: true });

  // With no Experiment shipped, the prompt neither asks for the Experiment folder nor
  // records one - and the steps renumber over what survives.
  const plain = prepared();
  assert.doesNotMatch(plain.stdout, /SCA_EXP_SOURCE|Experiment/);
  assert.match(plain.stdout, /\n5\. That run checks the source/);

  // An add-on that ships an Experiment needs the folder, so the .xpi's own manifest.json
  // decides: the prompt asks for it, the review file has a slot for it, and the started
  // review reads it as the Experiment folder.
  packAddon(xpi, { experiment_apis: { x: {} } });
  const exp = prepared("--allow-experiments");
  assert.match(exp.stdout, /SCA_EXP_SOURCE/);
  handBackRoots(exp.stdout, { expSource: "experiment" });
  const work = workOf(exp.stdout);
  assert.equal(
    readJson(work, "state.json").report.meta.scaExpSource,
    path.join(work, "sca", "experiment")
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// --cache-work-dir is handed to the review the preparation starts, as the real folder it
// names, so the preparation and its review read one cache. --cache-clear leaves it alone:
// it holds what a test seeded, not a cache this tool fills.
test("the preparation records --cache-work-dir for its review", () => {
  const dir = submissionFolder();
  const seeded = fs.mkdtempSync(path.join(os.tmpdir(), "wl-run-cache-"));
  const kept = path.join(seeded, "osv.json");
  fs.writeFileSync(kept, "{}");
  const r = run([
    dir,
    "--llm-sca-review",
    "--cache-clear",
    ...cacheFlags(freshFixtureCache(), cdnMissCache(FIXTURES_DIR)),
    "--cache-work-dir",
    seeded,
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(
    readJson(workOf(r.stdout), "prepare.json").flags["cache-work-dir"],
    fs.realpathSync(seeded)
  );
  assert.ok(fs.existsSync(kept), "--cache-clear does not delete it");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(seeded, { recursive: true, force: true });
});

// A skip names part of the prompt the PREPARED review will print, so it belongs to the
// review the preparation starts rather than to this run - which prints no such prompt.
test("--llm-sca-review hands a skip to the review it prepares", () => {
  const dir = submissionFolder();
  const r = run([
    dir,
    "--llm-sca-review",
    ...OFFLINE_FLAGS,
    "--llm-skip-manual",
  ]);
  assert.equal(r.code, 0, r.stderr);
  // The prompt itself is unchanged: the skip belongs to the review, not to this run, which
  // asks nobody anything either way. Each run creates a work folder of its own, so the two
  // prompts name two of them.
  const prompt = (out) =>
    out
      .split("── SCA Review Prompt ──")[1]
      .replace(/addon-\d{4}-\d{2}-\d{2}T[\d-]+Z/g, "<WORK>");
  assert.equal(
    prompt(r.stdout),
    prompt(run([dir, "--llm-sca-review", ...OFFLINE_FLAGS]).stdout)
  );
  handBackRoots(r.stdout);
  assert.deepEqual(readJson(workOf(r.stdout), "state.json").run.skip, [
    "llm-skip-manual",
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A hand-back that cannot be read is refused to the agent, with the folder as it was.
test("a preparation refuses an unanswered hand-back", () => {
  const dir = submissionFolder();
  const r = run([dir, "--llm-sca-review", ...OFFLINE_FLAGS]);
  assert.equal(r.code, 0, r.stderr);
  const work = workOf(r.stdout);
  const unanswered = run(["--llm-handback", work]);
  assert.equal(unanswered.code, 2);
  assert.match(
    unanswered.stdout,
    /The hand-back was refused: SCA_ROOT still has no "answer"/
  );
  assert.equal(readJson(work, "prepare.json").step, "extract");
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A work folder whose preparation is done, made for real: the sca-unrescued fixture's
 *  source, whose lock carries a critical advisory, prepared through its rescue to the
 *  give-up, so the folder is unrescued as a real preparation leaves it. Then `over` is
 *  written into that real record, the way an agent that edited the record and recomputed
 *  its hash would, so what is tested is the check behind the digest. `name` prepares
 *  another fixture instead: one with no lock, done at once, whose review asks nothing of a
 *  registry. */
async function preparedFolder(over = {}, name = "sca-unrescued") {
  const fixture = path.join(ROOT, "tests", "addons", name);
  const { work } = await realPreparation({
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
  writePrepare(work, {
    ...readPrepare(work),
    ...(typeof over === "function" ? over(work) : over),
  });
  return work;
}

// The record a review is started from is a file the agent can write, so it is never taken
// as it stands. Each of these is refused to the agent the way a hand-back is - the refusal
// text, which has it redo the pass once - and nothing is claimed in the folder.
test("a prepared review refuses a record it cannot start from", (t) => {
  const refusedFor = (name, over, problem) =>
    t.test(name, async () => {
      const work = await preparedFolder(over);
      const r = run(["--llm-handback", work]);
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.match(r.stdout, problem);
      // What the preparation left: its record and the source.
      assert.deepEqual(fs.readdirSync(work).sort(), ["prepare.json", "sca"]);
    });
  refusedFor(
    "an experiments that is neither true nor false",
    { submission: { xpi: path.join(os.tmpdir(), "x.xpi"), experiments: 1 } },
    /The hand-back was refused: the preparation's record holds submission\.experiments as neither true nor false/
  );
  refusedFor(
    "no roots",
    { roots: null },
    /The hand-back was refused: the preparation's record names no settled source root\. /
  );
  refusedFor(
    "no submission",
    { submission: { xpi: "", experiments: false } },
    /The hand-back was refused: the preparation's record names no submission to review\. /
  );
  refusedFor(
    "neither",
    { roots: null, submission: { xpi: "", experiments: false } },
    /The hand-back was refused: the preparation's record names no submission to review and no settled source root\. /
  );
  refusedFor(
    "a root that is gone",
    (work) => ({
      roots: { scaRoot: path.join(work, "sca", "gone"), scaExpSource: null },
    }),
    /The hand-back was refused: the preparation's record names a source root ".*gone" that is not a folder inside /
  );
  // The agent works in the folder between the step that settled the roots and the start,
  // so each root is followed to where it really is, and must still be where it was put.
  refusedFor(
    "a root that is the work folder itself",
    (work) => ({ roots: { scaRoot: work, scaExpSource: null } }),
    /The hand-back was refused: the preparation's record names a source root ".*" that is not a folder inside ".*[/]sca"/
  );
  refusedFor(
    "a root that links out of sca/",
    (work) => {
      const link = path.join(work, "sca", "out");
      fs.symlinkSync(fs.mkdtempSync(path.join(os.tmpdir(), "wl-out-")), link);
      return { roots: { scaRoot: link, scaExpSource: null } };
    },
    /The hand-back was refused: the preparation's record names a source root ".*out" that is not a folder inside /
  );
  refusedFor(
    "an Experiment folder that links out of the root",
    (work) => {
      const link = path.join(work, "sca", "exp");
      fs.symlinkSync(fs.mkdtempSync(path.join(os.tmpdir(), "wl-out-")), link);
      return {
        roots: { scaRoot: path.join(work, "sca"), scaExpSource: link },
      };
    },
    /The hand-back was refused: the preparation's record names an Experiment folder ".*exp" that is not a folder inside /
  );
  refusedFor(
    "an sca/ that is a link",
    (work) => {
      const sca = path.join(work, "sca");
      const moved = fs.mkdtempSync(path.join(os.tmpdir(), "wl-sca-"));
      fs.cpSync(sca, moved, { recursive: true });
      fs.rmSync(sca, { recursive: true });
      fs.symlinkSync(moved, sca);
      return { roots: { scaRoot: sca, scaExpSource: null } };
    },
    /The hand-back was refused: ".*[/]sca" is not the folder the source was extracted into/
  );
  refusedFor(
    "a flag of the wrong type",
    { flags: { eslint: "yes" } },
    /The hand-back was refused: the preparation's record holds --eslint as neither true nor false/
  );
});

// Nor can a record name a folder for the linter to delete: --cache-clear is never forwarded,
// and a key no option declares is dropped.
test("a prepared review drops what a record must not say", async () => {
  const before = fs.readdirSync(CACHE).sort();
  const work = await preparedFolder(
    {
      flags: {
        "cache-clear": true,
        "cache-schema-dir": CACHE,
        "cache-hash-db-dir": CACHE,
        "cache-experiments-dir": CACHE,
        "cache-cdn-lookup-dir": CDN_CACHE,
        eslint: false,
        "rm-rf": "/",
      },
    },
    "missing-lock-sca"
  );
  const r = run(["--llm-handback", work]);
  assert.notEqual(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /── LLM Prompt ──/);
  assert.deepEqual(
    fs.readdirSync(CACHE).sort(),
    before,
    "no cache was cleared"
  );
});

// A source whose rescue was given up is reviewed as submitted: the hand-back starts that
// review, its vulnerability checks abort it, so its first prompt is the close, and the run
// exits as a rejected review does.
test("the hand-back starts the review of an unrescued source, which closes at once", async () => {
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
  const { work, record } = await realPreparation({
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
  assert.equal(record.roots.scaRoot, workPaths(work).sca, "the rescue gave up");
  const r = run(["--llm-handback", work]);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /── LLM Prompt ──/);
  assert.doesNotMatch(r.stdout, /SCA Review Prompt/);
  // The first prompt is the close, its report already written, and its vulnerability checks
  // are what aborted it.
  assert.match(r.stdout, /The review was aborted before it finished/);
  assert.ok(r.stdout.includes(`[report.md](${work}/report.md)`), r.stdout);
  const { findings, meta } = readJson(work, "state.json").report;
  assert.equal(meta.checksRun.at(-1), "vendor-vulnerable-indirect");
  assert.ok(findings.some((f) => f.ruleId === "vendor-vulnerable-indirect"));
  fs.rmSync(source, { recursive: true, force: true });
});

// A vulnerable source is rescued through the prompts the hand-backs print: the step that
// settles the roots hands out the copy's `reduce`, and one that leaves the copy vulnerable
// its `fix`, each naming the copy and the work folder to hand back. OSV is answered from the
// run cache folder named as --cache-work-dir, which the record hands to every step.
test("the hand-backs print a rescued copy's reduce and then its fix", async () => {
  const fixture = path.join(ROOT, "tests", "addons", "sca-unrescued");
  const source = path.join(fixture, "src");
  const cache = auditCache({
    "lint-pebble@0.4.0": [
      advisory("GHSA-fixture-pebble", "CRITICAL", "lint-pebble", "0.4.1"),
    ],
    "argv-crumb@0.0.8": [],
    "tidy-lantern@2.1.0": [],
    "wick-trim@1.0.1": [],
  });
  const dir = submissionFolder();
  const r = run([
    dir,
    "--llm-sca-review",
    ...OFFLINE_FLAGS,
    "--cache-work-dir",
    cache,
  ]);
  assert.equal(r.code, 0, r.stderr);
  const work = workOf(r.stdout);
  fs.cpSync(source, headerValue(r.stdout, "EXTRACT_TO"), { recursive: true });
  answer(work, { SCA_ROOT: headerValue(r.stdout, "EXTRACT_TO") });
  const copy = path.join(work, "rescued");
  const step = (prompt, name) => {
    const next = run(argvOf(commandOf(prompt)));
    assert.equal(next.code, 0, next.stdout + next.stderr);
    assert.match(next.stdout, /── SCA Review Prompt ──/);
    assert.equal(headerValue(next.stdout, "RESCUE_ROOT"), copy);
    assert.deepEqual(commandOf(next.stdout), [`--llm-handback ${work}`]);
    assert.equal(readJson(work, "prepare.json").step, name);
    return next.stdout;
  };
  const reduce = step(r.stdout, "reduce");
  assert.doesNotMatch(reduce, /npm audit fix/);
  const fix = step(reduce, "fix");
  assert.match(fix, /npm audit fix/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The prompt's one command is typed by its reader, and a submission folder is as likely to
// hold a space as not. Quoted where it matters and nowhere else: an unquoted path with a
// space in it is a second argument the hand-back refuses.
test("the preparation quotes an argument that carries whitespace", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl sub mission-"));
  packAddon(path.join(dir, "addon  v2.xpi"));
  fs.writeFileSync(path.join(dir, "src.tar.gz"), "");
  const r = run([dir, "--llm-sca-review", ...OFFLINE_FLAGS]);
  assert.equal(r.code, 0, r.stderr);
  // The values above the command are read by eye, not typed, so they carry no quotes, and
  // keep the run of spaces the file name has.
  assert.match(r.stdout, new RegExp(`\n  FOLDER\n    ${dir}\n`));
  assert.equal(headerValue(r.stdout, "XPI"), path.join(dir, "addon  v2.xpi"));
  assert.match(r.stdout, new RegExp(`--llm-handback '${dir}/addon__v2-`));
  const handed = handBackRoots(r.stdout);
  assert.notEqual(handed.code, 2, handed.stdout + handed.stderr);
  assert.equal(
    readJson(workOf(r.stdout), "state.json").report.meta.xpi,
    path.join(dir, "addon  v2.xpi"),
    "the review reads the file the block named"
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// The work folder is recorded, a rescued copy goes inside it, and the next prompt names it,
// so however it is typed - relative, with a trailing slash - it is taken as one absolute
// name: the review starts in it, and the prompt names its files by that name.
test("a hand-back takes its folder as one absolute name", () => {
  const dir = submissionFolder();
  const r = run([dir, "--llm-sca-review", ...OFFLINE_FLAGS]);
  assert.equal(r.code, 0, r.stderr);
  const work = workOf(r.stdout);
  const handed = handBackRoots(r.stdout, {
    typed: (w) => `${path.relative(process.cwd(), w)}/`,
  });
  assert.notEqual(handed.code, 2, handed.stdout + handed.stderr);
  assert.ok(fs.existsSync(workPaths(work).state), "the review starts in it");
  assert.ok(
    handed.stdout.includes(`[report.md](${work}/report.md)`),
    handed.stdout
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// An Experiment the review would reject is not worth preparing: --llm-sca-review asks the
// review's own verdict of the .xpi first, and where it rejects, starts that review at once -
// the same review --llm-review of the .xpi starts, which the reject aborts, so its first
// prompt is the close. An Experiment
// the review accepts is prepared as any submission is.
test("--llm-sca-review starts the review of an Experiment it would reject", () => {
  const submission = (fixture) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-exp-gate-"));
    const zip = new AdmZip();
    zip.addLocalFolder(path.join(ROOT, "tests", "addons", fixture));
    zip.writeZip(path.join(dir, "addon.xpi"));
    fs.writeFileSync(path.join(dir, "src.tar.gz"), "");
    return dir;
  };
  const dir = submission("experiment-disallowed");
  const r = run([dir, "--llm-sca-review", ...OFFLINE_FLAGS]);
  assert.equal(r.code, 1, r.stderr);
  assert.doesNotMatch(r.stdout, /SCA Review Prompt/);
  assert.match(r.stdout, /── LLM Prompt ──/);
  const work = defaultFolderOf(path.join(dir, "addon.xpi"));
  // The reject aborts the review, so its first prompt is the close, with the report.
  assert.deepEqual(fs.readdirSync(work).sort(), [
    "report.md",
    "review.json",
    "state.json",
    "xpi",
  ]);
  assert.ok(r.stdout.includes(`[report.md](${work}/report.md)`), r.stdout);
  assert.deepEqual(readJson(work, "state.json").report.meta.checksRun, [
    "experiment-not-allowed",
  ]);
  const plain = run([
    path.join(dir, "addon.xpi"),
    "--llm-review",
    ...OFFLINE_FLAGS,
  ]);
  assert.equal(plain.code, 1, plain.stderr);
  const promptOf = (out, w) =>
    out.split("── LLM Prompt ──")[1].replaceAll(w, "<W>");
  assert.equal(
    promptOf(r.stdout, work),
    promptOf(
      plain.stdout,
      fs
        .readdirSync(dir)
        .map((n) => path.join(dir, n))
        .find((p) => /addon-[\d-]+T[\d-]+Z$/.test(p) && p !== work)
    ),
    "the review --llm-review of the .xpi starts"
  );
  fs.rmSync(dir, { recursive: true, force: true });

  for (const [fixture, extra] of [
    ["experiment-disallowed", ["--allow-experiments"]],
    ["experiment-pristine", []],
  ]) {
    const allowed = submission(fixture);
    const prepared = run([
      allowed,
      "--llm-sca-review",
      ...OFFLINE_FLAGS,
      ...extra,
    ]);
    assert.equal(prepared.code, 0, prepared.stderr);
    assert.match(prepared.stdout, /── SCA Review Prompt ──/, fixture);
    fs.rmSync(allowed, { recursive: true, force: true });
  }
});

// The preparation records every cache its review is to read, given or default, as one
// absolute name: a hand-back started from another directory reads the same caches.
test("the preparation records every cache as an absolute path", () => {
  const dir = submissionFolder();
  const cwd = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "wl-cwd-"))
  );
  const r = spawnSync(
    process.execPath,
    [REVIEW, dir, "--llm-sca-review", "--cache-schema-dir", "mycache"],
    { encoding: "utf8", cwd }
  );
  assert.equal(r.status, 0, r.stderr);
  const flags = readJson(workOf(r.stdout), "prepare.json").flags;
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(flags).filter(([name]) => name.endsWith("-dir"))
    ),
    {
      "cache-schema-dir": path.join(cwd, "mycache"),
      "cache-hash-db-dir": path.join(
        cwd,
        "WEBEXT-LINTER-CACHE",
        "mozilla-hash-db"
      ),
      "cache-cdn-lookup-dir": path.join(
        cwd,
        "WEBEXT-LINTER-CACHE",
        "cdn-lookup"
      ),
      "cache-npm-registry-dir": path.join(
        cwd,
        "WEBEXT-LINTER-CACHE",
        "npm-registry"
      ),
      "cache-sources-dir": path.join(cwd, "WEBEXT-LINTER-CACHE", "sources"),
      "cache-experiments-dir": path.join(
        cwd,
        "WEBEXT-LINTER-CACHE",
        "experiments"
      ),
    }
  );
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

// A check id nobody can run is a bad command line whatever the run does with it - and
// --llm-sca-review would record it for the review it starts, which would then fail on it.
// Answered before any branch, so no prompt is printed at all.
test("an unknown check id is refused before a prompt is printed", () => {
  const dir = submissionFolder();
  const sca = run([dir, "--llm-sca-review", "--checks-only", "no-such-check"]);
  assert.equal(sca.code, 2);
  assert.match(sca.stderr, /Unknown check "no-such-check"/);
  assert.doesNotMatch(sca.stdout, /SCA Review Prompt/);

  const review = run([
    path.join(ROOT, "tests", "addons", "clean"),
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--checks-skip",
    "no-such-check",
  ]);
  assert.equal(review.code, 2);
  assert.match(review.stderr, /Unknown check "no-such-check"/);
  assert.doesNotMatch(review.stdout, /LLM Prompt/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Each way the flag cannot be used, refused before it prints anything - it starts its own
// review, so it shares no run with the flags that do.
test("--llm-sca-review refuses what it cannot be combined with", () => {
  const dir = submissionFolder();
  const cases = [
    [["--sca-root", "src"], /works out --sca-root for you/],
    [["--llm-review"], /starts its own review/],
    [["--llm-handback", "work"], /starts its own review/],
    [["--report-format", "json"], /--llm-sca-review is text only/],
    // A SECOND add-on argument: the flag reads the first one as the submission.
    [
      ["x.xpi"],
      /Only one submission can be prepared at a time, and 2 were given/,
    ],
  ];
  for (const [extra, message] of cases) {
    const r = run([dir, "--llm-sca-review", ...extra]);
    assert.equal(r.code, 2, extra.join(" "));
    assert.match(r.stderr, message, extra.join(" "));
    assert.doesNotMatch(r.stdout, /SCA Review Prompt/, extra.join(" "));
  }
  // And the add-on argument it reads is REQUIRED: this flag changes what that argument
  // means, it does not carry the folder itself.
  const none = run(["--llm-sca-review"]);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /as a submission folder, and none was given/);
  assert.doesNotMatch(none.stdout, /SCA Review Prompt/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A folder that is not a submission fails here, where the reviewer can see it, rather than
// handing back a command aimed at a file nobody submitted.
test("--llm-sca-review refuses a folder that is not a submission", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-empty-"));
  const r = run([dir, "--llm-sca-review"]);
  assert.equal(r.code, 2);
  // The flag's name and the value that was given are the front-end's half of the message;
  // what was found in the folder is the loader's.
  assert.match(r.stderr, new RegExp(`--llm-sca-review "${dir}":`));
  assert.match(
    r.stderr,
    /a submission folder holds exactly one \.xpi and exactly one other archive/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// An answer that reaches settle() already invalid - too long to have been typed into the
// question it answers - fails cleanly, not as a raw stack trace. It cannot be redone: the
// answer is already in the state by the time settle() sees it, so this is a terminal
// failure of the review, the same as a state file this build cannot read - not a
// HandbackRefused, which exists only for a hand-back that can still be corrected.
test("an answer too long for settle() to apply fails cleanly, not as a crash", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const first = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--llm-skip-sweep",
  ]);
  assert.equal(first.code, 0, first.stderr);
  const file = first.stdout.match(/(\S+\/review\.json)/)[1];

  let out = run(["--llm-handback", path.dirname(file), ...OFFLINE_FLAGS]);
  // Every prompt but the closing one ends on the command that hands it back.
  while (/^\s+node verify\.js --llm-handback /m.test(out.stdout)) {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.entries = doc.entries.map((e) => ({
      ...e,
      answer: "answers".repeat(400),
    }));
    fs.writeFileSync(file, JSON.stringify(doc, null, 1));
    out = run(["--llm-handback", path.dirname(file), ...OFFLINE_FLAGS]);
  }
  assert.equal(out.code, 2, out.stdout);
  assert.match(out.stderr, /carries a \d+-character answer and the limit is/);
  assert.match(out.stderr, /verify failed/);
  assert.doesNotMatch(out.stderr, /at settleAnswer|at applyVerdicts|at Object/);
});

// The live feed and the report are two renderings of one review, so they must not
// disagree about which artifact a path is in. They reach the label by different routes -
// the feed settles it per note as a check runs, the report reads what was stamped on the
// finding - and a signature change once left the feed calling the label rule with a route
// where it expects an artifact, which silently blanked every label in it. Nothing caught
// that, because the feed is stdout and no unit test reads it.
test("the activity feed labels a locus the same way the report does", () => {
  const fx = "tests/addons/sca-multiple-vendor-files";
  const r = run([
    `${fx}/xpi`,
    "--sca-root",
    `${fx}/src`,
    "--verbose",
    ...OFFLINE_FLAGS,
  ]);
  const feed = r.stdout
    .split("\n")
    .filter((l) => l.trimStart().startsWith("•"));
  assert.ok(feed.length > 0, "the run narrated something");

  // Every note that names a file says which artifact it is in. An unlabelled one in a
  // source review is the failure: two artifacts, and the line says neither.
  const unlabelled = feed.filter(
    (l) => /\s-\s/.test(l) && !/\[(XPI|SCA)\]/.test(l)
  );
  assert.deepEqual(unlabelled, [], "no note names a file without its artifact");

  // And the labels are not all one value: this fixture has both artifacts in play, which
  // is what makes the agreement worth asserting.
  assert.ok(feed.some((l) => l.includes("[XPI]")));
  assert.ok(feed.some((l) => l.includes("[SCA]")));

  // The same file, labelled the same way in both places. VENDOR.md exists in BOTH
  // artifacts here, so this is the case a wrong label would be invisible in.
  assert.match(r.stdout, /• .*\[XPI\] VENDOR\.md - vendoring information/);
  assert.match(r.stdout, /^ - \[XPI\] VENDOR\.md$/m);
});

// Nothing the submission names reaches the terminal with a control character in it: every
// write passes one guarded door (src/util/log.js). The case that found the gap - a source
// archive whose only folder is named with escape sequences, which the "Source root" feed
// line printed raw - now prints them as plain text.
test("a submission's escape sequences never reach the terminal raw", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-escape-"));
  const xpi = path.join(dir, "xpi");
  fs.mkdirSync(xpi);
  fs.writeFileSync(
    path.join(xpi, "manifest.json"),
    '{"manifest_version":3,"name":"x","version":"1"}'
  );
  const root = path.join(dir, "src");
  const evil = path.join(root, "evil\u001b[2K\u001b[1Aname");
  fs.mkdirSync(evil, { recursive: true });
  fs.writeFileSync(
    path.join(evil, "package.json"),
    '{"name":"x","version":"1.0.0"}'
  );
  const r = run([xpi, "--sca-root", root, ...OFFLINE_FLAGS]);
  assert.match(r.stdout, /evil \[2K \[1Aname/, "the folder was named");
  assert.ok(!r.stdout.includes("\u001b"), "raw ESC on stdout");
  assert.ok(!r.stderr.includes("\u001b"), "raw ESC on stderr");
  fs.rmSync(dir, { recursive: true, force: true });
});

// An unreadable submission file makes it invalid: exit 2 and one sentence naming the artifact,
// the file and why, before any check runs - never a review that read it as empty.
test("an unreadable submission file makes it invalid, exit 2", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root reads every file");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-unreadable-"));
  const xpi = path.join(dir, "xpi");
  const src = path.join(dir, "src");
  fs.mkdirSync(xpi);
  fs.mkdirSync(src);
  fs.writeFileSync(
    path.join(xpi, "manifest.json"),
    '{"manifest_version":3,"name":"x","version":"1","background":{"scripts":["bg.js"]}}'
  );
  const bg = path.join(xpi, "bg.js");
  fs.writeFileSync(bg, "browser.runtime.id;\n");
  fs.writeFileSync(
    path.join(src, "package.json"),
    '{"name":"x","version":"1.0.0"}'
  );
  const build = path.join(src, "build.js");
  fs.writeFileSync(build, "1;\n");
  try {
    fs.chmodSync(bg, 0o000);
    const r = run([xpi, ...OFFLINE_FLAGS]);
    assert.equal(r.code, 2, r.stderr);
    assert.match(
      r.stderr,
      /Invalid XPI: bg\.js cannot be read \(permission denied\)\./
    );
    // The same in a source archive: the archive is the invalid input.
    fs.chmodSync(bg, 0o644);
    fs.chmodSync(build, 0o000);
    const sca = run([xpi, "--sca-root", src, ...OFFLINE_FLAGS]);
    assert.equal(sca.code, 2, sca.stderr);
    assert.match(
      sca.stderr,
      /Invalid source archive: build\.js cannot be read \(permission denied\)\./
    );
  } finally {
    fs.chmodSync(bg, 0o644);
    fs.chmodSync(build, 0o644);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Code Babel parses but cannot walk (a `const` declared twice) is one file's failure, not
// the run's: the review finishes and reports it at its line, in the XPI and in a source
// archive alike, instead of ending as a tool failure.
test("code Babel cannot walk is reported at its line, not exit 2", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-walk-"));
  const xpi = path.join(dir, "xpi");
  const src = path.join(dir, "src");
  fs.mkdirSync(xpi);
  fs.mkdirSync(src);
  fs.writeFileSync(
    path.join(xpi, "manifest.json"),
    '{"manifest_version":3,"name":"x","version":"1","background":{"scripts":["bg.js"]}}'
  );
  fs.writeFileSync(path.join(xpi, "bg.js"), "const k = 1;\nconst k = 2;\n");
  fs.writeFileSync(
    path.join(src, "package.json"),
    '{"name":"x","version":"1.0.0"}'
  );
  // The lock a source submission owes; without it the review stops before the code checks.
  fs.writeFileSync(
    path.join(src, "package-lock.json"),
    '{"lockfileVersion":3,"packages":{"":{}}}'
  );
  fs.writeFileSync(path.join(src, "broken.js"), "let a;\nlet a;\n");
  try {
    const r = run([xpi, ...OFFLINE_FLAGS]);
    assert.equal(r.code, 1, r.stderr);
    assert.match(
      r.stdout,
      /bg\.js:2 - Identifier 'k' has already been declared\./
    );
    assert.doesNotMatch(r.stderr, /verify failed/);
    fs.writeFileSync(path.join(xpi, "bg.js"), "browser.runtime.id;\n");
    const sca = run([xpi, "--sca-root", src, ...OFFLINE_FLAGS]);
    assert.equal(sca.code, 1, sca.stderr);
    assert.match(
      sca.stdout,
      /broken\.js:2 - Identifier 'a' has already been declared\./
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// An XPI may hold no symbolic link, whichever file it is and however it arrives: the run
// refuses it as invalid, names the link, and reviews nothing - in an XPI review and as the
// XPI of a source review alike.
test("an XPI holding a symlink is invalid, exit 2", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-symlink-"));
  const xpi = path.join(dir, "xpi");
  const src = path.join(dir, "src");
  fs.mkdirSync(xpi);
  fs.mkdirSync(src);
  fs.writeFileSync(
    path.join(xpi, "real.json"),
    '{"manifest_version":3,"name":"x","version":"1"}'
  );
  fs.symlinkSync("real.json", path.join(xpi, "manifest.json"));
  fs.writeFileSync(
    path.join(src, "package.json"),
    '{"name":"x","version":"1.0.0"}'
  );
  const refusal =
    /Invalid XPI: manifest\.json is a symbolic link \(an add-on must contain regular files only\)\./;
  try {
    for (const args of [
      [xpi, ...OFFLINE_FLAGS],
      [xpi, "--sca-root", src, ...OFFLINE_FLAGS],
    ]) {
      const r = run(args);
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, refusal);
      assert.match(r.stderr, /verify failed/);
      assert.doesNotMatch(r.stdout, /Found Issues/);
    }
    // A packed XPI that stored an entry AS a link is the same refusal.
    const zip = new AdmZip();
    zip.addFile(
      "manifest.json",
      Buffer.from('{"manifest_version":3,"name":"x","version":"1"}')
    );
    zip.addFile("lib/a.js", Buffer.from("../../etc/passwd"));
    zip.getEntry("lib/a.js").attr = (0o120777 << 16) >>> 0;
    const packed = path.join(dir, "addon.xpi");
    zip.writeZip(packed);
    const r = run([packed, ...OFFLINE_FLAGS]);
    assert.equal(r.code, 2, r.stderr);
    assert.match(
      r.stderr,
      /Invalid XPI: lib\/a\.js is a symbolic link \(an add-on must contain regular files only\)\./
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
