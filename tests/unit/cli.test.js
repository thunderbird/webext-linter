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

// --sca-root is the SCA-mode switch; --sca-source / --sca-exp-source name locations
// inside it, so they are a usage error on their own. (--sca-root alone is fine -
// --sca-source defaults to ".".)
test("--sca-source without --sca-root is a usage error (exit 2)", () => {
  const r = run(["some.xpi", "--sca-source", "src"]);
  assert.equal(r.code, 2);
  assert.match(
    r.stderr,
    /--sca-source and --sca-exp-source require --sca-root/
  );
});

// In SCA mode, Experiment code is told apart from WebExtension code only by
// --sca-exp-source, so --allow-experiments without it is a usage error (else the
// privileged Experiment code would be reviewed as WebExtension code).
test("--allow-experiments in SCA mode requires --sca-exp-source (exit 2)", () => {
  const r = run([
    "some.xpi",
    "--sca-root",
    ROOT,
    "--sca-source",
    "src",
    "--allow-experiments",
  ]);
  assert.equal(r.code, 2);
  assert.match(
    r.stderr,
    /--sca-exp-source is required with --allow-experiments/
  );
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

  // The other two name folders INSIDE the root, and are asked the same question. The
  // Experiment one is why this is a refusal and not a warning: warn and carry on, and the
  // review reads the Experiment's privileged code as WebExtension code.
  for (const flag of ["--sca-source", "--sca-exp-source"]) {
    const r = run([
      "some.xpi",
      "--sca-root",
      dir,
      ...(flag === "--sca-exp-source" ? ["--sca-source", "."] : []),
      flag,
      "no-such-dir",
    ]);
    assert.equal(r.code, 2, flag);
    assert.match(
      r.stderr,
      new RegExp(`\\${flag} must point at a folder`),
      flag
    );
    assert.match(r.stderr, /no-such-dir/, flag);
  }

  // A folder passes this guard and the run reaches the NEXT --sca-* refusal, which pins
  // both that a directory is accepted and that the folder check comes first.
  const ok = run(["some.xpi", "--sca-root", dir, "--allow-experiments"]);
  assert.equal(ok.code, 2);
  assert.match(
    ok.stderr,
    /--sca-exp-source is required with --allow-experiments/
  );
  assert.doesNotMatch(ok.stderr, /must point at a folder/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// An .xpi the loader will not take ends the run before a review exists - the tool-failure
// channel, exit 2, no report - rather than reviewing whatever part of it could be read. Here
// the archive holds an entry whose name carries a "." segment, so the key it would land under
// is not the key the manifest's own reference resolves to (tests/unit/load.test.js covers
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
    [["some.xpi", "--report-out="], "--report-out"],
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
  assert.equal(run(["--help", "--report-out="]).code, 0);
});

// The guard asks the LOADER which folder a value names, rather than spelling the path math
// a second time. Spelled twice, ".src" validates as ".src" (found) and reads as "src" - a
// real folder, but not the one named, reviewed in silence. Pinned from the CLI end, because
// what fails there is the two ends disagreeing.
test("a folder flag is checked against the folder the review will read", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-dotdir-"));
  fs.mkdirSync(path.join(dir, "src"));

  // Only src/ exists: naming .src refuses, rather than reviewing src/ without a word.
  const missing = run(["some.xpi", "--sca-root", dir, "--sca-source", ".src"]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /--sca-source must point at a folder: "\.src"/);
  assert.match(missing.stderr, new RegExp(`${dir}/\\.src`), "looked in .src");

  // With the folder there, it passes this guard and the run reaches the next refusal.
  fs.mkdirSync(path.join(dir, ".src"));
  const ok = run([
    "some.xpi",
    "--sca-root",
    dir,
    "--sca-source",
    ".src",
    "--allow-experiments",
  ]);
  assert.equal(ok.code, 2);
  assert.match(
    ok.stderr,
    /--sca-exp-source is required with --allow-experiments/
  );
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
    "--sca-source",
    path.join(dir, "src"),
  ]);
  assert.doesNotMatch(
    inside.stderr,
    /--sca-source/,
    "an absolute path inside is taken"
  );
  for (const argv of [
    ["some.xpi", "--sca-root", dir, "--sca-source", "/tmp"],
    [
      "some.xpi",
      "--sca-root",
      dir,
      "--sca-source",
      ".",
      "--sca-exp-source",
      "/tmp",
    ],
  ]) {
    const r = run(argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.stderr, /which is outside/, argv.join(" "));
  }

  for (const argv of [
    ["some.xpi", "--sca-root", `${dir}/../${path.basename(dir)}`],
    ["some.xpi", "--sca-root", dir, "--sca-source", "../*"],
    [
      "some.xpi",
      "--sca-root",
      dir,
      "--sca-source",
      ".",
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
    ["--llm-review", "--report-out", "/nope/x.txt"],
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

// The seam between the two: a source code review's own steps send a sub-agent to paths, and
// the Review Details block names them. Both come from what the review RESOLVED to be, never
// from the flags it was given - a rejected Experiment keeps --sca-root and is still an XPI
// review, and reading the flag there would send an agent to a root nothing had read, under
// a name the block never prints. Driven through the CLI because that is the seam: rendering the
// two halves from a hand-built meta cannot catch a pipeline that feeds them different
// values.
test("a source code review's steps carry exactly the paths its header names", () => {
  const sca = path.join(ROOT, "tests", "addons", "build-hygiene-sca");
  const r = run([
    path.join(sca, "xpi"),
    ...OFFLINE_FLAGS,
    "--sca-root",
    path.join(sca, "src"),
    "--sca-source",
    ".",
    "--llm-review",
  ]);
  const root = headerValue(r.stdout, "SCA_ROOT");
  const build = headerValue(r.stdout, "BUILD_PROCESS");
  assert.equal(root, path.join(sca, "src"));
  assert.match(build, /\.build\.md$/);
  // Each sits on its own line inside the step that hands them over, unwrapped and
  // unaltered, so what the agent is given is what the reviewer was shown.
  const lines = r.stdout.split("\n").map((l) => l.trim());
  assert.ok(lines.includes(root), "the prompt carries SCA_ROOT");
  assert.ok(lines.includes(build), "the prompt carries BUILD_PROCESS");

  // An invalid Experiment submitted WITH --sca-root is rejected from the shipped XPI alone:
  // the source archive is never read, so neither name may appear anywhere - not in the
  // block, and not in a step asking for work on a root this review does not have.
  const exp = path.join(ROOT, "tests", "addons", "experiment-disallowed-sca");
  const rejected = run([
    path.join(exp, "xpi"),
    ...OFFLINE_FLAGS,
    "--sca-root",
    exp,
    "--sca-source",
    "src",
    "--llm-review",
  ]);
  assert.match(rejected.stdout, /── LLM Prompt ──/);
  assert.doesNotMatch(rejected.stdout, /SCA_ROOT|BUILD_PROCESS/);
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
  assert.match(headerValue(on.stdout, "ADDON_DESCRIPTION"), /\.summary\.md$/);
  assert.ok(
    !on.stdout.includes('"Report"'),
    "the answers are not prose in the prompt"
  );
  // The review itself is in the file, so none of it is printed.
  assert.ok(!on.stdout.includes("── Found Issues ──"), "no prose report");
  assert.ok(!on.stdout.includes("── Setup ──"), "no feed");

  // The prompt names the review file, and the file behind it holds what THIS pass asks
  // about - the sweep's rows, one per check, each unanswered.
  const entries = entriesOf(on.stdout);
  assert.ok(entries.length > 0);
  assert.ok(
    entries.every((e) => e.check && e.answer === null),
    "one unanswered row per check that declared a sweep instruction"
  );
  // No index: a sweep takes no verdict and produces cases rather than being one, so it
  // must not consume a number from a sequence it is not in.
  assert.ok(
    entries.every((e) => e.index === undefined),
    "the sweep carries no index"
  );
  assert.ok(
    entries.every((e) => e.instruction),
    "each row carries the check's own instruction"
  );

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

// The review file is the linter's to name, so the flag takes no value at all - which is
// what lets it sit anywhere on the command line, including before the add-on, where a flag
// with an optional value would have swallowed the path and left nothing to review. The name
// carries the moment as well as the add-on, so no second run can open the file a reader is
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
    assert.match(
      path.basename(file),
      /^webext-linter-Clean-1\.0-.*\.review\.json$/
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

// --report-out is a tee, not a redirect: the report still prints to stdout, and
// the file is a carbon copy of it.
test("--report-out tees the report to stdout and copies it to the file", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-cli-"));
  const out = path.join(dir, "report.txt");
  const r = run([addon, ...OFFLINE_FLAGS, "--report-out", out]);
  assert.ok([0, 1].includes(r.code));
  assert.match(r.stdout, /── Summary ──/); // report is on stdout, not hidden
  assert.equal(fs.readFileSync(out, "utf8"), r.stdout); // file == screen
  fs.rmSync(dir, { recursive: true, force: true });
});

// JSON + --report-out writes a plain JSON file (no activity-feed prefix), and
// stdout carries the same document.
test("JSON + --report-out writes a plain JSON file", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-cli-"));
  const out = path.join(dir, "report.json");
  const r = run([
    addon,
    ...OFFLINE_FLAGS,
    "--report-format",
    "json",
    "--report-out",
    out,
  ]);
  assert.ok([0, 1].includes(r.code));
  const file = fs.readFileSync(out, "utf8");
  assert.doesNotThrow(() => JSON.parse(file));
  assert.equal(JSON.parse(file).meta.action, "review");
  assert.deepEqual(JSON.parse(r.stdout), JSON.parse(file));
  fs.rmSync(dir, { recursive: true, force: true });
});

// --sca-root / --sca-source flow through to the source-code submission pipeline
// opts (the pipeline derives SCA mode from both being set).
// The reader is where a path stops being a spelling and becomes a place: --sca-root against
// the working directory, and the two that name a folder inside it against the RESOLVED root.
// Everything downstream is handed absolutes and re-resolves nothing.
test("--sca-root / --sca-source map to the sca pipeline opts", () => {
  const o = pipelineOptsFromArgv(["--sca-root", "pkg", "--sca-source", "src"]);
  assert.equal(o.scaRoot, path.resolve("pkg"));
  assert.equal(o.scaSource, path.resolve("pkg", "src"));
  // Every spelling of the same folder arrives as one value.
  for (const written of [
    "src",
    "./src",
    "./src/",
    path.resolve("pkg", "src"),
  ]) {
    const each = pipelineOptsFromArgv([
      "--sca-root",
      "pkg",
      "--sca-source",
      written,
    ]);
    assert.equal(each.scaSource, path.resolve("pkg", "src"), written);
  }
  assert.ok(!pipelineOptsFromArgv([]).scaRoot);
  assert.ok(!pipelineOptsFromArgv([]).scaSource);
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
  assert.ok(
    !on.stdout.includes("ADDON_DESCRIPTION"),
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
  assert.ok(!noSummary.stdout.includes("ADDON_DESCRIPTION"));
  // The questions are a later pass, so the first prompt names none either way. What the
  // skip decides is whether the FILE still carries them.

  assert.ok(
    !noSummary.stdout.includes("ADDON_DESCRIPTION"),
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
  assert.match(headerValue(noManual.stdout, "ADDON_DESCRIPTION"), /\.md$/);
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
  // The step that spawns the description agent names the file it writes - printed by the
  // step that uses it, which is the only place any path is given out.
  assert.match(r.stdout, /ADDON_DESCRIPTION\n\s+\S+\.summary\.md/);
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

  // The spawn phase asks one row per check that declared a sweep instruction, and every
  // row must be answered: an empty list is "swept and clean", null is "never looked".
  const handed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(
    handed.entries.every((e) => e.check && e.answer === null),
    "one unanswered row per check"
  );
  handed.entries = handed.entries.map((e) => ({
    ...e,
    answer:
      e.check === "data-exfiltration"
        ? [
            {
              file: "background.js",
              line: 12,
              hint: "<a ping> attribute carries the message digest",
            },
          ]
        : [],
  }));
  fs.writeFileSync(file, JSON.stringify(handed, null, 1));

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
  assert.match(
    out.stdout,
    /send user data to a remote server without an explicit opt-in/
  );
  assert.match(
    out.stdout,
    /background\.js:12 - <a ping> attribute carries the message digest/
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

  const handed = JSON.parse(fs.readFileSync(file, "utf8"));
  handed.entries = handed.entries.map((e) => ({
    ...e,
    answer:
      e.check === "cleartext-transmission"
        ? [{ file: "sync.js", line: 12, hint: "posts over http://" }]
        : [],
  }));
  fs.writeFileSync(file, JSON.stringify(handed, null, 1));

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
  assert.match(out.stdout, /Data is sent over an unencrypted connection/);
  assert.match(out.stdout, /sync\.js:12 - posts over http:\/\//);
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
  // Computed the same way scaSubmission() does: beside the source archive, named after
  // it. Real, not a placeholder - --sca-root is now given, not worked out.
  const scaRoot = `${path.join(dir, "src-4.3.12.tar_ABC.gz")}.extracted${path.sep}`;
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
        `--sca-root ${scaRoot}`,
        "--sca-source <SCA_SOURCE>",
        "--sca-exp-source <SCA_EXP_SOURCE>",
      ],
      flag.join(" ")
    );
  }
  assert.deepEqual(
    flagsOf(run([dir, "--llm-sca-review", "--checks-only=unused-files"])),
    [
      `--llm-review ${xpi}`,
      "--checks-only unused-files",
      `--sca-root ${scaRoot}`,
      "--sca-source <SCA_SOURCE>",
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
    [
      `--llm-review ${xpi}`,
      "--eslint",
      "--verbose",
      `--sca-root ${scaRoot}`,
      "--sca-source <SCA_SOURCE>",
    ]
  );

  // Without --allow-experiments nothing reads --sca-exp-source, so the prompt neither
  // asks for it nor prints it - and the steps renumber over what survives.
  const plain = run([dir, "--llm-sca-review"]);
  assert.deepEqual(flagsOf(plain), [
    `--llm-review ${xpi}`,
    `--sca-root ${scaRoot}`,
    "--sca-source <SCA_SOURCE>",
  ]);
  assert.doesNotMatch(plain.stdout, /SCA_EXP_SOURCE|Experiment/);
  assert.match(plain.stdout, /\n4\. That review prints a prompt of its own/);
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
// unknown check id, --report-out, the folder questions - and each of them could turn the
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

  // SCA_ROOT is given, not worked out: extract into the exact folder the tool named,
  // same as its reader would.
  const root = headerValue(prepared.stdout, "SCA_ROOT");
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

  // Substitute what its reader still has to work out - where the add-on's own code sits
  // inside SCA_ROOT - and run what is left.
  const argv = flags
    .flatMap((line) => {
      const [flag, ...rest] = line.split(" ");
      const value = rest.join(" ").replace(/^'|'$/g, "");
      return value ? [flag, value] : [flag];
    })
    .map((arg) => (arg === "<SCA_SOURCE>" ? "." : arg));
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

// --report-out saves the REPORT, and no run of the --llm-* round trip is one to save: two
// print a prompt, and the third prints the settled report for the agent to hand back in
// its own answer. ONE rule for every --llm-* flag, so there is nothing to work out per
// flag - and no saved prompt for the command --llm-sca-review hands back to overwrite.
test("--report-out is refused with any --llm-* flag", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const dir = submissionFolder();
  const out = path.join(os.tmpdir(), "wl-report-out.txt");

  for (const flags of [
    ["--llm-review"],
    ["--llm-review", "--llm-skip-manual"],
    ["--llm-verdict", "answers.json"],
  ]) {
    const r = run([addon, ...OFFLINE_FLAGS, ...flags, "--report-out", out]);
    assert.equal(r.code, 2, flags.join(" "));
    assert.match(
      r.stderr,
      /--report-out cannot be given with/,
      flags.join(" ")
    );
    assert.match(r.stderr, new RegExp(flags[0]), flags.join(" "));
  }

  const sca = run([dir, "--llm-sca-review", "--report-out", out]);
  assert.equal(sca.code, 2);
  assert.match(
    sca.stderr,
    /--report-out cannot be given with --llm-sca-review/
  );
  assert.doesNotMatch(sca.stdout, /SCA Review Prompt/);
  assert.ok(!fs.existsSync(out), "nothing was written");
  fs.rmSync(dir, { recursive: true, force: true });
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
    [["--sca-source", "."], /works out --sca-source for you/],
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
