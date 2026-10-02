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
import { seedFixtureCache } from "../seed-caches.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");
const REVIEW = path.join(ROOT, "verify.js");
// A cache pre-seeded from the fixtures. Point every fetchable source at it so the
// spawned CLI (schema auto-detection, library-hash DB, experiments allow-list) runs
// fully offline.
const CACHE = seedFixtureCache();
const OFFLINE_FLAGS = [
  "--cache-schema-dir",
  CACHE,
  "--cache-hash-db-dir",
  CACHE,
  "--cache-experiments-dir",
  CACHE,
];

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
  const at = stdout.match(/(\S+\.review\.json)/);
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
  const at = stdout.match(/\]\((\S+\.report\.md)\)/);
  assert.ok(at, "the prompt links the report file");
  return fs.readFileSync(at[1], "utf8");
}

/** Run a root entry file, capturing stdout/stderr/exit code. */
function runFile(file, args = []) {
  const r = spawnSync(process.execPath, [file, ...args], { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Run the review entry (verify.js). */
function run(args) {
  return runFile(REVIEW, args);
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
  ]);
  assert.equal(o.schemaCache, "/a");
  assert.equal(o.libraryHashesCache, "/b");
  assert.equal(o.cdnLookupCache, "/c");
  assert.equal(o.experimentsCache, "/d");
});

// --cache-clear wipes the cache directories before the review (so every source
// re-fetches from scratch). ALL FOUR --cache-*-dir point at one temp dir so the
// delete touches nothing else, and a nonexistent add-on makes runPipeline fail at
// load (before any network) - we assert only that the stale cache file was deleted.
test("--cache-clear deletes the cache directories before the review", () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-clear-"));
  const stale = path.join(cacheDir, "webext-annotated-schemas-junk.zip");
  fs.writeFileSync(stale, "stale");
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
  ]);
  assert.ok(!fs.existsSync(stale), "the stale cache file was cleared");
  fs.rmSync(cacheDir, { recursive: true, force: true });
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

  const r = run([file, ...OFFLINE_FLAGS]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Could not read archive: /);
  assert.match(r.stderr, /verify failed/);
  // The entry name is the submission's, and the refusal carries none of it.
  assert.doesNotMatch(r.stderr, /SECRET/);
  // No review was produced: the run stopped at the read.
  assert.doesNotMatch(r.stdout, /Found Issues|Summary/);
  // A refusal mid-extraction leaves nothing behind for a reviewer to mistake for the
  // whole submission (src/addon/load.js extractZip's cleanup-on-throw).
  assert.ok(!fs.existsSync(`${file}.extracted`));

  fs.rmSync(dir, { recursive: true, force: true });
});

// A PLAIN review - no --llm-review at all - now extracts a packed .xpi too: the linter
// reads a submission from disk once, whether or not an agent is involved, rather than
// keeping the zip's bytes in memory only and never writing them anywhere. This is new:
// before this, extraction was --llm-review-only and asked of the agent, not the tool.
test("a plain review of a packed .xpi extracts it beside the file", () => {
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
  const extracted = `${file}.extracted`;
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

  // Reviewed a second time: a fresh, timestamp-suffixed extraction, not a silent reuse
  // or overwrite of the first.
  const again = run([file, ...OFFLINE_FLAGS]);
  assert.notEqual(again.code, 2, again.stderr);
  const secondRoot = headerValue(again.stdout, "XPI_ROOT");
  assert.notEqual(secondRoot, `${extracted}${path.sep}`);
  assert.ok(
    fs.existsSync(path.join(extracted, "manifest.json")),
    "the first survives"
  );
  assert.ok(
    fs.existsSync(path.join(secondRoot, "manifest.json")),
    "the second is its own tree"
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

// An already-unpacked submission needs no extraction at all: it already IS the folder,
// and XPI_ROOT names it directly with nothing written beside it.
test("a directory submission writes nothing extra to disk", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const before = fs.readdirSync(path.dirname(addon));
  const r = run([addon, ...OFFLINE_FLAGS]);
  assert.notEqual(r.code, 2, r.stderr);
  assert.equal(headerValue(r.stdout, "XPI_ROOT"), `${addon}${path.sep}`);
  assert.deepEqual(fs.readdirSync(path.dirname(addon)), before);
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
    [["some.xpi", "--llm-verdict="], "--llm-verdict"],
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
    /--sca-exp-source must point at a folder: "\.src"/
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
// the guard and the review cannot answer it differently: a ".." segment names a folder by
// the way out of another, and a path resolving outside --sca-root names one on the reviewing
// machine. For --sca-exp-source "nothing to exclude" is also the legitimate answer for an
// Experiment outside the source, so neither mistake announces itself.
test("a folder flag takes an absolute path inside the root, and refuses one outside it or with a .. segment (exit 2)", () => {
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
  ]) {
    const r = run(argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.stderr, /which is outside/, argv.join(" "));
  }

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
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.stderr, /never a way out of one/, argv.join(" "));
    assert.match(r.stderr, /carries a "\.\." segment/, argv.join(" "));
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
  assert.match(r.stderr, /"some\.xpi", "another\.xpi"/);
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
// review RESOLVED to be, never what the flags asked for - a rejected Experiment keeps
// --sca-root and is still an XPI review, so a step reading the flag would send an agent to a
// root nothing had read. Driven through the CLI because that is the seam: rendering from a
// hand-built meta cannot catch a pipeline that feeds its two halves different values.
//
// Keyed on the paths themselves, because a path is all a step gives out: a sub-agent is
// handed the request and nothing else, so nothing in one stands for a path by name.
test("a source code review's steps carry the paths the review resolved to", () => {
  const sca = path.join(ROOT, "tests", "addons", "build-hygiene-sca");
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
    lines.some((l) => /\.build\.md$/.test(l)),
    "and where the build report goes"
  );

  // An invalid Experiment submitted WITH --sca-root is rejected from the shipped XPI alone:
  // the source archive is never read, so neither path may appear anywhere - not in a block
  // naming it, and not in a step asking for work on a root this review does not have.
  const exp = path.join(ROOT, "tests", "addons", "experiment-disallowed-sca");
  const rejected = run([
    path.join(exp, "xpi"),
    ...OFFLINE_FLAGS,
    "--sca-root",
    exp,
    "--llm-review",
  ]);
  assert.match(rejected.stdout, /── LLM Prompt ──/);
  assert.doesNotMatch(rejected.stdout, /SCA_ROOT|BUILD_PROCESS/);
  const rejectedLines = rejected.stdout.split("\n").map((l) => l.trim());
  assert.ok(!rejectedLines.includes(exp), "no source root is handed out");
  assert.ok(
    !rejectedLines.some((l) => /\.build\.md$/.test(l)),
    "and no build report is asked for"
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
  assert.match(on.stdout, /\.review\.json/, "the file to hand back is named");
  assert.match(
    on.stdout,
    /--llm-verdict/,
    "and the command that hands it back"
  );
  // The description is a file the reader writes and the reviewer opens: this run names
  // the path, and never reads what lands there.
  assert.match(on.stdout, /^\s*\S+\.summary\.md$/m);
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
  const request = on.stdout.match(/^\s*(\S+\.sweep-xpi\.yaml)$/m);
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
// not one. --llm-verdict used to be asked nowhere: it returns from its own branch before
// reaching the test --llm-review takes, so it accepted --report-format json and then
// printed text anyway, ignoring what it had been asked for. The message names the flag
// that was actually used, because a run that said --llm-verdict is not helped by being
// told about --llm-review.
// `base` in a handed-back file names the state it belongs to, and the state names the
// one review file it hands out - so a file whose `base` was pointed at ANOTHER review's
// state is caught, rather than advancing that review with this one's answers. Needed on
// purpose because a pass asking for no entry (the spawn phase) carries nothing that could
// disagree with the wrong state by accident.
test("a hand-back whose base leads to another review is refused", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const reviewOf = () => {
    const out = run([addon, ...OFFLINE_FLAGS, "--llm-review"]);
    assert.equal(out.code, 0, out.stderr);
    return out.stdout.match(/(\S+\.review\.json)/)[1];
  };
  const a = reviewOf();
  const b = reviewOf();
  assert.notEqual(a, b);
  const bState = JSON.parse(fs.readFileSync(b, "utf8")).base;
  const before = fs.readFileSync(bState, "utf8");

  const handed = JSON.parse(fs.readFileSync(a, "utf8"));
  handed.base = bState;
  fs.writeFileSync(a, JSON.stringify(handed, null, 1));

  const out = run(["--llm-verdict", a, ...OFFLINE_FLAGS]);
  assert.equal(out.code, 2);
  assert.match(out.stdout, /belongs to a different review/);
  assert.equal(
    fs.readFileSync(bState, "utf8"),
    before,
    "the other review is untouched"
  );
});

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
  const file = first.stdout.match(/(\S+\.review\.json)/)[1];
  const stateFile = JSON.parse(fs.readFileSync(file, "utf8")).base;
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

  const out = run(["--llm-verdict", file, ...OFFLINE_FLAGS]);
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
    "--llm-verdict",
    "/nonexistent.json",
    "--report-format",
    "json",
  ]);
  assert.equal(started.code, 2);
  assert.match(started.stderr, /--llm-verdict is text only/);
  assert.doesNotMatch(
    started.stderr,
    /--llm-review/,
    "names the flag the run used"
  );

  // Text is still the loop's own format, so the pass runs and answers in its own words.
  const text = run(["--llm-verdict", "/nonexistent.json"]);
  assert.match(text.stdout, /not what this pass expected/);
});

// The review file is the linter's to name, so the flag takes no value at all - which is
// what lets it sit anywhere on the command line, including before the add-on, where a flag
// with an optional value would have swallowed the path and left nothing to review. The name
// carries the moment as well as the SUBMISSION - the leaf of the path this run was given,
// which is what the reviewer recognises - so no second run can open the file a reader is
// still working from.
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
    // `clean` is the folder that was reviewed, not the "Clean" its manifest declares.
    assert.match(
      path.basename(file),
      /^clean-\d{4}-\d{2}-\d{2}T[\d-]+Z\.review\.json$/
    );
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
  const base = [addon, ...OFFLINE_FLAGS, "--cdn-lib-lookup", "false"];
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
test("--warnings-as-errors is refused on a --llm-verdict pass", () => {
  const r = run([
    "--llm-verdict",
    "/nonexistent.review.json",
    "--warnings-as-errors",
  ]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /belongs to the review/);
  // Refused before the file is read: the message is about the flag, not about the path.
  assert.doesNotMatch(r.stderr, /nonexistent/);
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
    /\.summary\.md/,
    "no add-on description asked for, and no file named for one"
  );
  // ...while the step that closes the round trip survives the renumbering.
  assert.match(on.stdout, /--llm-verdict/);

  // Both skips are off the spawn phase, so its only agent is the sweep - and the manual
  // items are not dropped from the REVIEW, only from what a phase puts to anyone. They
  // are still in the report the last pass prints.
  assert.ok(
    entriesOf(on.stdout).every((e) => e.check),
    "the first pass asks about the sweep and nothing else"
  );
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
  assert.doesNotMatch(noSummary.stdout, /\.summary\.md/);
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
  assert.match(noManual.stdout, /^\s*\S+\.summary\.md$/m);
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
    /Write it to\n\n\s+\S+\.summary\.md\n\n\s+and to nothing else/
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
// still text only, and it is still the asking half of a round trip --llm-verdict closes.
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
    "--llm-verdict",
    "answers.json",
  ]);
  assert.equal(verdict.code, 2);
  assert.match(verdict.stderr, /--llm-review and --llm-verdict/);
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
  assert.deepEqual(cut.llmSkip, ["summary", "manual"]);
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
  const { base } = JSON.parse(fs.readFileSync(reviewFile, "utf8"));
  const state = JSON.parse(fs.readFileSync(base, "utf8"));
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

// The sweep path end to end: a swept case enters through --llm-sweep-results, is settled
// through --llm-verdict, and comes out the far side as a finding of the check that owns
// it, worded by that check's registry response. This is the chain the unit tests cannot
// see - mergeSweepResults -> reviewItems -> applyVerdicts -> renderFindings -> formatText
// - and it is where a check whose response carried a placeholder, or whose band could not
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
  const file = first.stdout.match(/(\S+\.review\.json)/)[1];

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
  const second = run(["--llm-verdict", file, ...OFFLINE_FLAGS]);
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
  let out = run(["--llm-verdict", file, ...OFFLINE_FLAGS]);
  while (/── LLM Prompt ──/.test(out.stdout)) {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.entries = doc.entries.map((e) => ({ ...e, answer: "Clear" }));
    fs.writeFileSync(file, JSON.stringify(doc, null, 1));
    out = run(["--llm-verdict", file, ...OFFLINE_FLAGS]);
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
  const file = first.stdout.match(/(\S+\.review\.json)/)[1];

  sweepBack(file, {
    "cleartext-transmission": [
      { file: "sync.js", line: 12, hint: "posts over http://" },
    ],
  });

  // It arrives in VERIFY, as a finding: a locus and the agent's hint, and no `instructions`
  // - a finding carries no question, because it is a claim to be audited.
  const second = run(["--llm-verdict", file, ...OFFLINE_FLAGS]);
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
  let out = run(["--llm-verdict", file, ...OFFLINE_FLAGS]);
  while (/── LLM Prompt ──/.test(out.stdout)) {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.entries = doc.entries.map((e) => ({ ...e, answer: "Clear" }));
    fs.writeFileSync(file, JSON.stringify(doc, null, 1));
    out = run(["--llm-verdict", file, ...OFFLINE_FLAGS]);
  }
  const report = reportOf(out.stdout);
  assert.match(report, /Data is sent over an unencrypted connection/);
  assert.match(report, /sync\.js:12 - posts over http:\/\//);
});

// ---- --llm-sca-review ----
// The half of an SCA review a program can do: which file is the add-on, which is the
// source, and what command the review is run with. It reviews nothing - it cannot, until
// its reader has opened the source archive - so its whole output is that prompt.

/** A submission folder: one built add-on, one source archive, and the usual clutter. */
function submissionFolder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-submission-"));
  fs.writeFileSync(path.join(dir, "addon.xpi"), "");
  fs.writeFileSync(path.join(dir, "src-4.3.12.tar_ABC.gz"), "");
  fs.writeFileSync(path.join(dir, "README.txt"), "");
  return dir;
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

// The block NAMES the files and the command RUNS on them, so the two have to name one
// file. A run of spaces is what separates them: only one of the two sanitisers keeps it,
// and every other test here builds its folder with mkdtemp, whose names have none.
test("the command --llm-sca-review prints names the file its block names", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-spaced-"));
  const sub = path.join(dir, "my  submission");
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, "addon  v2.xpi"), "");
  fs.writeFileSync(path.join(sub, "src.tar.gz"), "");
  const r = run([sub, "--llm-sca-review", ...OFFLINE_FLAGS]);
  assert.equal(r.code, 0, r.stderr);
  const xpi = headerValue(r.stdout, "XPI");
  assert.equal(xpi, path.join(sub, "addon  v2.xpi"));
  // Quoted because it carries whitespace, and quoting is worth nothing if the path inside
  // was altered first.
  assert.ok(
    r.stdout.includes(`--llm-review '${xpi}'`),
    "the command names the file the block named"
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// The contract the review rests on: the flags printed are this run's own, with the flag
// swapped and the add-on in place of the folder, plus the ones its reader works out. A
// flag invented or dropped here reviews a different submission than the reviewer asked
// about - --allow-experiments most of all, which decides whether the review runs at all.
// They print in the order OPTIONS declares them, never the order they were typed: composed
// from the parsed values, so the command reads the same however it was written.
test("--llm-sca-review prints the flags the review is run with", () => {
  const dir = submissionFolder();
  const xpi = path.join(dir, "addon.xpi");
  // Both SCA paths are placeholders: only a reader who has opened the archive can say
  // which folder is the root and which part of it is the add-on's own code. The
  // extraction DESTINATION is given, above the flags, under EXTRACT_TO.
  // The flags are the paragraph after the step that says to run the linter, indented
  // beneath its number and ending at the blank line before the next step.
  const flagsOf = (r) =>
    r.stdout
      .split("with exactly these flags, and nothing else:\n\n")[1]
      .split("\n\n")[0]
      .split("\n")
      .map((l) => l.trim());

  // Every spelling of every flag collapses to one command: the parser reads them, so
  // "--flag=value" and "--flag value" reach the reader as the same line.
  for (const flag of [[dir, "--llm-sca-review"]]) {
    assert.deepEqual(
      flagsOf(run([...flag, "--allow-experiments", "--eslint"])),
      [
        `--llm-review ${xpi}`,
        "--eslint",
        "--allow-experiments",
        "--sca-root <SCA_ROOT>",
      ],
      flag.join(" ")
    );
  }
  assert.deepEqual(
    flagsOf(run([dir, "--llm-sca-review", "--checks-only=unused-files"])),
    [
      `--llm-review ${xpi}`,
      "--checks-only unused-files",
      "--sca-root <SCA_ROOT>",
    ],
    "--flag=value"
  );

  // A boolean flag is never paired with what follows it, wherever it sits: the OPTIONS
  // table says which flags take a value, so nothing is guessed from the token shapes -
  // a trailing one printed with the argument after it would print "undefined".
  assert.doesNotMatch(
    run([dir, "--llm-sca-review", "--eslint"]).stdout,
    /undefined/
  );
  assert.deepEqual(
    flagsOf(run([dir, "--llm-sca-review", "--eslint", "--verbose"])),
    [`--llm-review ${xpi}`, "--eslint", "--verbose", "--sca-root <SCA_ROOT>"]
  );

  // With no Experiment shipped, the prompt neither asks for --sca-exp-source nor prints
  // it - and the steps renumber over what survives.
  const plain = run([dir, "--llm-sca-review"]);
  assert.deepEqual(flagsOf(plain), [
    `--llm-review ${xpi}`,
    "--sca-root <SCA_ROOT>",
  ]);
  assert.doesNotMatch(plain.stdout, /SCA_EXP_SOURCE|Experiment/);
  assert.match(plain.stdout, /\n4\. That review prints a prompt of its own/);

  // An add-on that ships an Experiment needs the folder, so the .xpi's own manifest.json
  // decides, and the prompt asks for it.
  const zip = new AdmZip();
  zip.addFile(
    "manifest.json",
    Buffer.from(
      JSON.stringify({ manifest_version: 3, experiment_apis: { x: {} } })
    )
  );
  zip.writeZip(xpi);
  const exp = run([dir, "--llm-sca-review"]);
  assert.deepEqual(flagsOf(exp), [
    `--llm-review ${xpi}`,
    "--sca-root <SCA_ROOT>",
    "--sca-exp-source <SCA_EXP_SOURCE>",
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A skip names part of the prompt the PREPARED review will print, so it belongs to the
// command handed back rather than to this run - which prints no such prompt of its own.
test("--llm-sca-review hands a skip to the review it prepares", () => {
  const dir = submissionFolder();
  const r = run([dir, "--llm-sca-review", "--llm-skip-manual"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\n {3}--llm-skip-manual\n/);
  // The prompt itself is unchanged: the skip belongs to the run the command starts, not to
  // this one, which asks nobody anything either way.
  const prompt = (out) => out.split("── SCA Review Prompt ──")[1];
  assert.equal(
    prompt(r.stdout).replace(/ {3}--llm-skip-manual\n/, ""),
    prompt(run([dir, "--llm-sca-review"]).stdout)
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// The prompt tells its reader to run the printed command "with exactly these flags, and
// nothing else", so the one thing worth asserting about it is that it RUNS. Every guard
// between that command and a review - the empty-value rule, the
// unknown check id, the folder questions - and each of them could turn the
// handed-back command into a usage error without a single test noticing.
test("the command --llm-sca-review prints is one the tool accepts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-handback-"));
  const zip = new AdmZip();
  zip.addLocalFolder(path.join(ROOT, "tests", "addons", "clean"));
  zip.writeZip(path.join(dir, "addon.xpi"));
  fs.writeFileSync(path.join(dir, "src-1.0.tar.gz"), "");

  const prepared = run([
    dir,
    "--llm-sca-review",
    ...OFFLINE_FLAGS,
    "--checks-only",
    "unused-files",
  ]);
  assert.equal(prepared.code, 0, prepared.stderr);

  // EXTRACT_TO is given: unpack into the exact folder the tool named, same as its reader
  // would. Which folder inside it is the ROOT is the reader's to settle, below.
  const root = headerValue(prepared.stdout, "EXTRACT_TO");
  fs.cpSync(
    path.join(ROOT, "tests", "addons", "build-hygiene-sca", "src"),
    root,
    {
      recursive: true,
    }
  );

  const flags = prepared.stdout
    .split("with exactly these flags, and nothing else:\n\n")[1]
    .split("\n\n")[0]
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // Substitute what its reader still has to work out - which folder is the source root,
  // and where the add-on's own code sits inside it - and run what is left. Here the
  // archive unpacked flat, so the root IS the folder it was unpacked into.
  const argv = flags
    .flatMap((line) => {
      const [flag, ...rest] = line.split(" ");
      const value = rest.join(" ").replace(/^'|'$/g, "");
      return value ? [flag, value] : [flag];
    })
    .map((arg) => (arg === "<SCA_ROOT>" ? root : arg));
  const review = run(argv);

  // A review may pass or find something (0 or 1); what it must not be is a usage error,
  // and its own prompt must be what it prints.
  assert.notEqual(review.code, 2, review.stderr);
  assert.equal(
    review.stderr,
    "",
    "the handed-back command is accepted as written"
  );
  assert.match(review.stdout, /── LLM Prompt ──/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// These lines are a command their reader types, and a submission folder is as likely to
// hold a space as not. Quoted where it matters and nowhere else: an unquoted path with a
// space in it is the second add-on argument a review refuses.
test("--llm-sca-review quotes an argument that carries whitespace", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl sub mission-"));
  fs.writeFileSync(path.join(dir, "addon.xpi"), "");
  fs.writeFileSync(path.join(dir, "src.tar.gz"), "");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "wl cache-"));

  const r = run([dir, "--llm-sca-review", "--cache-schema-dir", out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`--llm-review '${dir}/addon\\.xpi'`));
  assert.match(r.stdout, new RegExp(`--cache-schema-dir '${out}'`));
  // The values above the flags are read by eye, not typed, so they carry no quotes.
  assert.match(r.stdout, new RegExp(`\n  FOLDER\n    ${dir}\n`));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

// A check id nobody can run is a bad command line whatever the run does with it - and
// --llm-sca-review would print it into the command it tells its reader to run, which then
// exits 2 on that very line. Answered before any branch, so no prompt is printed at all.
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

// Each way the flag cannot be used, refused before it prints anything - it prepares a
// review rather than running one, so it shares no run with the flags that do.
test("--llm-sca-review refuses what it cannot be combined with", () => {
  const dir = submissionFolder();
  const cases = [
    [["--sca-root", "src"], /works out --sca-root for you/],
    [["--llm-review"], /comes BEFORE a review/],
    [["--llm-verdict", "answers.json"], /comes BEFORE a review/],
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
  const file = first.stdout.match(/(\S+\.review\.json)/)[1];

  let out = run(["--llm-verdict", file, ...OFFLINE_FLAGS]);
  while (/── LLM Prompt ──/.test(out.stdout)) {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.entries = doc.entries.map((e) => ({
      ...e,
      answer: "answers".repeat(400),
    }));
    fs.writeFileSync(file, JSON.stringify(doc, null, 1));
    out = run(["--llm-verdict", file, ...OFFLINE_FLAGS]);
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
    "--cdn-lib-lookup",
    "false",
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
