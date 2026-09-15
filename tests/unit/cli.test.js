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

// The renamed cache/cdn flags map to the internal pipeline opts.
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
// read. It used to be checked after the --llm-sca-review branch, which then printed
// nothing at all and exited 0 for an unknown value.
test("an unknown --report-format is refused on every path (exit 2)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-fmt-"));
  fs.writeFileSync(path.join(dir, "a.xpi"), "");
  fs.writeFileSync(path.join(dir, "source.tar.gz"), "");
  for (const args of [
    ["some.xpi", "--report-format", "xml"],
    ["--llm-sca-review", dir, "--report-format", "xml"],
  ]) {
    const r = run(args);
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.stderr, /Invalid --report-format "xml"/, args.join(" "));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// --sca-root is the EXTRACTED source, and the guard asks one question: does the path
// point at a folder? A packed root is the case that motivated it - a .tar.gz used to
// reach AdmZip and come back with "No END header found", an error about a format nobody
// claimed to support - but a missing path and a trailing slash are the same answer.
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
    assert.doesNotMatch(r.stderr, /END header|unsupported zip/i, root);
  }

  // The other two name folders INSIDE the root, and are asked the same question. The
  // Experiment one is why this is a refusal and not a warning: it used to warn and carry
  // on, and the review then read the Experiment's privileged code as WebExtension code.
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

// A flag given with no value names something and says nothing. Asked of EVERY option that
// takes one, before any branch reads one: parseArgs hands "--flag=" down as "", which every
// reader tests for truth and so reads as "not given" - a named cache silently became the
// default one, a named verdict file printed an unsettled report, a named format fell back
// to text, and a named source root reviewed the XPI alone. Whitespace counts as none.
test("a flag given no value is refused (exit 2)", () => {
  for (const [argv, flag] of [
    [["some.xpi", "--report-format="], "--report-format"],
    [["some.xpi", "--report-out="], "--report-out"],
    [["some.xpi", "--checks-only="], "--checks-only"],
    [["some.xpi", "--cache-schema-dir="], "--cache-schema-dir"],
    [["some.xpi", "--llm-verdict="], "--llm-verdict"],
    [["some.xpi", "--sca-root="], "--sca-root"],
    [["some.xpi", "--sca-root", " "], "--sca-root"],
    [["--llm-sca-review="], "--llm-sca-review"],
  ]) {
    const r = run(argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.stderr, new RegExp(`\\${flag} needs a value`), flag);
  }
  // --help is a request for the usage text, not a run: it is answered before this.
  assert.equal(run(["--help", "--report-out="]).code, 0);
});

// The guard asks the LOADER which folder a value names, rather than spelling the path math
// a second time. ".src" used to be validated as ".src" (found) and then read as "src" - a
// real folder, not the one named, reviewed in silence. Pinned from the CLI end, because the
// defect was the two ends disagreeing.
test("a folder flag is checked against the folder the review will read", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-dotdir-"));
  fs.mkdirSync(path.join(dir, "src"));

  // Only src/ exists: naming .src refuses, where it used to review src/ without a word.
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

// A ".." segment is the value this guard and the loader read differently: the loader strips
// leading dots, so the folder that answered here is not the folder the review reads, and for
// --sca-exp-source "nothing" is also the legitimate answer for an Experiment outside the
// source - so the mistake was silent at both ends.
test("a folder flag refuses a .. segment (exit 2)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-folder-"));
  fs.mkdirSync(path.join(dir, "src"));

  // A folder INSIDE --sca-root is written relative to it: an absolute path names one on
  // the reviewing machine, which can be anywhere, so what it names is not the submission's
  // - true for a path that happens to sit inside the root as much as for one that does not.
  for (const argv of [
    ["some.xpi", "--sca-root", dir, "--sca-source", path.join(dir, "src")],
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
    assert.match(r.stderr, /is an absolute path/, argv.join(" "));
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
    ["--llm-sca-review", `${dir}/..`],
  ]) {
    const r = run(argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.stderr, /never a way out of one/, argv.join(" "));
    assert.match(r.stderr, /carries a "\.\." segment/, argv.join(" "));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// One add-on per run. A second positional was silently ignored, which is how an unquoted
// path with a space in it reviewed the half before the space and said nothing about the
// rest - the shape --llm-sca-review's printed command could produce.
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

// --llm-review end to end. Its whole output is the prompt, the Review Details section and
// an item file: the prose report is deliberately absent, because its reader settles the
// items it can address rather than the report it can see. JSON is refused - that is the
// machine contract for ATN, which wants neither half of this.
test("--llm-review prints a prompt and writes the item file, not the report", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const on = run([addon, ...OFFLINE_FLAGS, "--llm-review"]);
  const lines = on.stdout.split("\n");
  const intro = lines.findIndex((l) => l.startsWith("Please verify"));
  const target = lines.findIndex((l) => l.startsWith("Reviewed XPI:"));
  assert.ok(intro > -1, "prompt is printed");
  assert.ok(intro < target, "prompt comes before the Review Details section");
  // Wrapped at 80 columns, so match only single tokens: any phrase can straddle a break
  // the next wording change happens to move. The answers themselves are not here - they
  // travel on each question in the item file - so the prompt names the field instead.
  assert.match(on.stdout, /"answers"/);
  // The description is a file the reader writes and the reviewer opens: this run names
  // the path, and never reads what lands there.
  assert.match(on.stdout, /Add-on description: .*\.summary\.md/);
  assert.ok(
    !on.stdout.includes('"Report"'),
    "the answers are not prose in the prompt"
  );
  // The review itself is in the file, so none of it is printed.
  assert.ok(!on.stdout.includes("── Found Issues ──"), "no prose report");
  assert.ok(!on.stdout.includes("── Setup ──"), "no feed");

  // The path is named in the output, and the file behind it is the review as an array.
  const named = lines.find((l) => l.startsWith("Review items: "));
  assert.ok(named, "the item file is named");
  const items = JSON.parse(
    fs.readFileSync(named.slice("Review items: ".length), "utf8")
  );
  assert.ok(Array.isArray(items) && items.length > 0);
  // The numbered review is the head of the array, and a position in it IS the item's
  // number. The pre-sweep entries are the tail and carry no index at all: they settle
  // nothing, so there is no number for a verdict to name them by.
  const numbered = items.filter((x) => x.index !== undefined);
  const tail = items.slice(numbered.length);
  assert.deepEqual(
    numbered.map((x) => x.index),
    numbered.map((_, i) => i + 1),
    "index is the position in the array"
  );
  // Exactly one, because the sweep is ONE request: the shared method, then the bare
  // per-check items it is asking about.
  assert.deepEqual(
    tail.map((x) => x.kind),
    ["pre-sweep"],
    "one unnumbered pre-sweep entry follows the numbered items"
  );
  const sweep = tail[0];
  assert.equal(sweep.index, undefined, "the sweep carries no index");
  assert.ok(sweep.intro, "the sweep carries the shared method");
  assert.ok(
    sweep.items.length > 0 &&
      sweep.items.every((s) => s.check && s.severity && s.instruction),
    "each item names its check, the band it would file at, and what to look for"
  );
  for (const x of items) {
    assert.ok(["finding", "todo", "pre-sweep"].includes(x.kind));
    // The section is named as the report prints it, not by an internal key.
    assert.match(
      x.section,
      /^(Found Issues|Extended Code Review|Extended Manual Review|Standard Code Review|Standard Manual Review)$/
    );
  }

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

// The item file is the linter's to name, so the flag takes no value at all - which is what
// lets it sit anywhere on the command line, including before the add-on, where a flag with
// an optional value would have swallowed the path and left nothing to review. The name
// carries the moment as well as the add-on, so no second run can open the file a reader is
// still working from.
test("--llm-review names its own item file and swallows no argument", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const named = (r) =>
    r.stdout
      .split("\n")
      .find((l) => l.startsWith("Review items: "))
      ?.slice("Review items: ".length);

  // After the add-on, before it, and before another option: the same review either way.
  const written = [
    named(run([addon, ...OFFLINE_FLAGS, "--llm-review"])),
    named(run([...OFFLINE_FLAGS, "--llm-review", addon])),
    named(run([addon, ...OFFLINE_FLAGS, "--llm-review", "--eslint"])),
  ];
  for (const file of written) {
    assert.ok(file && fs.existsSync(file), `${file} was written`);
    assert.ok(Array.isArray(JSON.parse(fs.readFileSync(file, "utf8"))));
    assert.match(
      path.basename(file),
      /^webext-linter-Clean-1\.0-.*\.items\.json$/
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
test("--sca-root / --sca-source map to the sca pipeline opts", () => {
  const o = pipelineOptsFromArgv(["--sca-root", "pkg", "--sca-source", "src"]);
  assert.equal(o.scaRoot, "pkg");
  assert.equal(o.scaSource, "src");
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
  const intro = lines.findIndex((l) => l.startsWith("Please verify"));
  const target = lines.findIndex((l) => l.startsWith("Reviewed XPI:"));
  assert.ok(intro > -1, "prompt is printed");
  assert.ok(intro < target, "prompt comes before the Review Details section");
  assert.ok(!on.stdout.includes("── Found Issues ──"), "no prose report");
  assert.ok(!on.stdout.includes("── Setup ──"), "no feed");

  // The inverse of the --llm-review assertions above: these are the two withheld steps,
  // and their absence is the whole feature.
  assert.ok(!on.stdout.includes('"answers"'), "no manual questions asked");
  assert.ok(
    !on.stdout.includes("Add-on description"),
    "no add-on description asked for, and no file named for one"
  );
  // ...while the step that closes the round trip survives the renumbering.
  assert.match(on.stdout, /--llm-verdict/);

  const named = lines.find((l) => l.startsWith("Review items: "));
  assert.ok(named, "the item file is named");
  const items = JSON.parse(
    fs.readFileSync(named.slice("Review items: ".length), "utf8")
  );
  assert.ok(Array.isArray(items) && items.length > 0);
  const numbered = items.filter((x) => x.index !== undefined);
  // TRUNCATED, never renumbered: the manual sections are the last ones the review numbers,
  // so what survives is still 1..M at positions 0..M-1 and an index means the same item
  // here as it does in the report.
  assert.deepEqual(
    numbered.map((x) => x.index),
    numbered.map((_, i) => i + 1),
    "index is still the position in the array"
  );
  for (const item of items) {
    assert.ok(
      !["Extended Manual Review", "Standard Manual Review"].includes(
        item.section
      ),
      `item file carries a manual entry: ${item.section}`
    );
  }
  // The pre-sweep block is still the tail, and still unnumbered.
  const tail = items.slice(numbered.length);
  assert.equal(tail.length, 1);
  assert.equal(tail[0].index, undefined);

  // The Summary still prints, and still counts the manual items the reviewer owes: they
  // were withheld from the PROMPT, not dropped from the review.
  assert.match(on.stdout, /standard manual review item\(s\)/);
  assert.equal(on.code, 0);
});

// Each skip cuts ONE part, and the other is untouched: the pair is not a single decision
// wearing two names. Asserted at both ends - what the prompt asks for, and what the item
// file carries - because the two must agree about what the reader is being asked to settle.
test("each skip leaves out its own part and nothing else", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const itemsOf = (r) => {
    const named = r.stdout
      .split("\n")
      .find((l) => l.startsWith("Review items: "));
    assert.ok(named, "the item file is named");
    return JSON.parse(
      fs.readFileSync(named.slice("Review items: ".length), "utf8")
    );
  };
  const manualSections = ["Extended Manual Review", "Standard Manual Review"];

  // The description goes, the questions stay: the file still offers answers.
  const noSummary = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--llm-skip-summary",
  ]);
  assert.equal(noSummary.code, 0, noSummary.stderr);
  assert.ok(!noSummary.stdout.includes("Add-on description"));
  assert.ok(noSummary.stdout.includes('"answers"'), "questions still asked");
  assert.ok(
    itemsOf(noSummary).some((x) => manualSections.includes(x.section)),
    "the manual items are still in the file"
  );

  // The questions go, the description stays: the file carries no manual entry.
  const noManual = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--llm-skip-manual",
  ]);
  assert.equal(noManual.code, 0, noManual.stderr);
  assert.match(noManual.stdout, /Add-on description: .*\.md/);
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
  assert.doesNotMatch(r.stdout, /^1\. /m, "no steps were printed");
  assert.doesNotMatch(r.stdout, /Add-on description/);
  // The item file is still named and still written - it is simply empty.
  const named = r.stdout
    .split("\n")
    .find((l) => l.startsWith("Review items: "));
  assert.ok(named);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(named.slice("Review items: ".length), "utf8")),
    []
  );
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
  const bare = pipelineOptsFromArgv([]);
  assert.equal(bare.llmReview, false);
  assert.deepEqual(bare.llmSkip, []);

  const full = pipelineOptsFromArgv(["--llm-review"]);
  assert.equal(full.llmReview, true);
  assert.deepEqual(full.llmSkip, []);
  assert.deepEqual({ ...full, llmReview: false }, bare);

  const cut = pipelineOptsFromArgv([
    "--llm-review",
    "--llm-skip-manual",
    "--llm-skip-summary",
  ]);
  // Authored order, never the order the flags were given: the registry names the steps.
  assert.deepEqual(cut.llmSkip, ["summary", "manual"]);
  assert.deepEqual({ ...cut, llmReview: false, llmSkip: [] }, bare);
});

// The retired flags parse as unknown options (exit 2), so a stale command line fails
// loudly instead of being quietly ignored.
test("retired flags are unknown options", () => {
  for (const flag of ["--ai-review", "--full-summary", "--diff-summary"]) {
    const r = run(["x.xpi", flag]);
    assert.equal(r.code, 2, `${flag} should exit 2`);
    assert.match(r.stderr, /Unknown option/, `${flag} should be unknown`);
  }
});

// The addition path end to end: a swept finding enters through --llm-verdict and comes
// out the far side as a finding of the check that owns it, worded by that check's
// registry response. This is the chain the unit tests cannot see - applyVerdicts ->
// renderFindings -> resolveHolds -> formatText - and it is where a check whose response
// carried a placeholder, or whose band could not be stamped, would actually break.
test("a swept addition is reported as a finding of the check that owns it", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-addition-"));
  const vfile = path.join(dir, "v.json");
  fs.writeFileSync(
    vfile,
    JSON.stringify({
      addon,
      additions: [
        {
          check: "data-exfiltration",
          file: "background.js",
          line: 12,
          hint: "<a ping> attribute carries the message digest",
        },
      ],
    })
  );

  const errorsIn = (stdout) =>
    Number(stdout.match(/(\d+) error\(s\)/)?.[1] ?? -1);
  const baseline = run([addon, ...OFFLINE_FLAGS]);
  const out = run([addon, ...OFFLINE_FLAGS, "--llm-verdict", vfile]);
  assert.equal(out.code, 1, out.stderr);
  // Exactly one more error than the same review without it: the addition enters the
  // tally as a finding of data-exfiltration, at the band that check declares.
  assert.equal(errorsIn(out.stdout), errorsIn(baseline.stdout) + 1);
  // Counted apart from the verdicts, because an addition settles nothing - it adds.
  assert.match(out.stdout, /Added 1 swept finding\(s\)/);
  // The developer reads the owning check's own words, not the reader's.
  assert.match(
    out.stdout,
    /send user data to a remote server without an explicit opt-in/
  );
  // The locus and the hint, on the location line where a detected finding puts them.
  assert.match(
    out.stdout,
    /background\.js:12 - <a ping> attribute carries the message digest/
  );

  // The add-on binding guards an addition as much as a verdict: it CREATES a finding, so
  // a file written elsewhere would invent one here.
  fs.writeFileSync(
    vfile,
    JSON.stringify({
      addon: path.join(ROOT, "tests", "addons", "all-checks"),
      additions: [{ check: "data-exfiltration", file: "a.js", line: 1 }],
    })
  );
  const wrong = run([addon, ...OFFLINE_FLAGS, "--llm-verdict", vfile]);
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.stderr + wrong.stdout, /was written for/);
  fs.rmSync(dir, { recursive: true, force: true });
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
  const r = run(["--llm-sca-review", dir, ...OFFLINE_FLAGS]);
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
  assert.doesNotMatch(r.stdout, /── Found Issues ──|Review items:/);
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
  for (const flag of [["--llm-sca-review", dir], [`--llm-sca-review=${dir}`]]) {
    assert.deepEqual(
      flagsOf(run([...flag, "--allow-experiments", "--eslint"])),
      [
        `--llm-review ${xpi}`,
        "--eslint",
        "--allow-experiments",
        "--sca-root <SCA_ROOT>",
        "--sca-source <SCA_SOURCE>",
        "--sca-exp-source <SCA_EXP_SOURCE>",
      ],
      flag.join(" ")
    );
  }
  assert.deepEqual(
    flagsOf(run(["--llm-sca-review", dir, "--checks-only=unused-files"])),
    [
      `--llm-review ${xpi}`,
      "--checks-only unused-files",
      "--sca-root <SCA_ROOT>",
      "--sca-source <SCA_SOURCE>",
    ],
    "--flag=value"
  );

  // A boolean flag is never paired with what follows it, wherever it sits: the OPTIONS
  // table says which flags take a value, so nothing is guessed from the token shapes. A
  // trailing one used to be printed with the argument after it, which was "undefined".
  assert.doesNotMatch(
    run(["--llm-sca-review", dir, "--eslint"]).stdout,
    /undefined/
  );
  assert.deepEqual(
    flagsOf(run(["--llm-sca-review", dir, "--eslint", "--verbose"])),
    [
      `--llm-review ${xpi}`,
      "--eslint",
      "--verbose",
      "--sca-root <SCA_ROOT>",
      "--sca-source <SCA_SOURCE>",
    ]
  );

  // Without --allow-experiments nothing reads --sca-exp-source, so the prompt neither
  // asks for it nor prints it - and the steps renumber over what survives.
  const plain = run(["--llm-sca-review", dir]);
  assert.deepEqual(flagsOf(plain), [
    `--llm-review ${xpi}`,
    "--sca-root <SCA_ROOT>",
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
  const r = run(["--llm-sca-review", dir, "--llm-skip-manual"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\n {3}--llm-skip-manual\n/);
  // The prompt itself is unchanged: the skip belongs to the run the command starts, not to
  // this one, which asks nobody anything either way.
  const prompt = (out) => out.split("── SCA Review Prompt ──")[1];
  assert.equal(
    prompt(r.stdout).replace(/ {3}--llm-skip-manual\n/, ""),
    prompt(run(["--llm-sca-review", dir]).stdout)
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// The prompt tells its reader to run the printed command "with exactly these flags, and
// nothing else", so the one thing worth asserting about it is that it RUNS. Every guard
// this round added lives between that command and a review - the empty-value rule, the
// unknown check id, --report-out, the folder questions - and each of them could turn the
// handed-back command into a usage error without a single test noticing.
test("the command --llm-sca-review prints is one the tool accepts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-handback-"));
  const zip = new AdmZip();
  zip.addLocalFolder(path.join(ROOT, "tests", "addons", "clean"));
  zip.writeZip(path.join(dir, "addon.xpi"));
  fs.writeFileSync(path.join(dir, "src-1.0.tar.gz"), "");
  // What its reader works out: an extracted source, and where the add-on's code sits in it.
  const root = path.join(dir, "extracted");
  fs.cpSync(
    path.join(ROOT, "tests", "addons", "build-hygiene-sca", "src"),
    root,
    {
      recursive: true,
    }
  );

  const prepared = run([
    "--llm-sca-review",
    dir,
    ...OFFLINE_FLAGS,
    "--checks-only",
    "unused-files",
  ]);
  assert.equal(prepared.code, 0, prepared.stderr);
  const flags = prepared.stdout
    .split("with exactly these flags, and nothing else:\n\n")[1]
    .split("\n\n")[0]
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // Substitute the three values the prompt asks its reader for, and run what is left.
  const argv = flags
    .flatMap((line) => {
      const [flag, ...rest] = line.split(" ");
      const value = rest.join(" ").replace(/^'|'$/g, "");
      return value ? [flag, value] : [flag];
    })
    .map((arg) =>
      arg === "<SCA_ROOT>" ? root : arg === "<SCA_SOURCE>" ? "." : arg
    );
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

  const r = run(["--llm-sca-review", dir, "--cache-schema-dir", out]);
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

  const sca = run(["--llm-sca-review", dir, "--report-out", out]);
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
  const sca = run(["--llm-sca-review", dir, "--checks-only", "no-such-check"]);
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
    [
      ["x.xpi"],
      /names the submission folder, so "x\.xpi" is one add-on too many/,
    ],
  ];
  for (const [extra, message] of cases) {
    const r = run(["--llm-sca-review", dir, ...extra]);
    assert.equal(r.code, 2, extra.join(" "));
    assert.match(r.stderr, message, extra.join(" "));
    assert.doesNotMatch(r.stdout, /SCA Review Prompt/, extra.join(" "));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// A folder that is not a submission fails here, where the reviewer can see it, rather than
// handing back a command aimed at a file nobody submitted.
test("--llm-sca-review refuses a folder that is not a submission", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-empty-"));
  const r = run(["--llm-sca-review", dir]);
  assert.equal(r.code, 2);
  assert.match(
    r.stderr,
    /must hold exactly one \.xpi and exactly one other archive/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
