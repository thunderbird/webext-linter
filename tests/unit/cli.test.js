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
    "pkg",
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
  // the next wording change happens to move.
  assert.match(on.stdout, /"Report"/);
  assert.match(on.stdout, /"Clear"/);
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

// --llm-review takes an OPTIONAL path, which parseArgs has no option type for: a bare flag
// writes wherever the linter chooses, a flag with a path writes there and overwrites what
// was there. The one shape parseArgs cannot disambiguate is the flag BEFORE the add-on,
// where the add-on becomes the output file - that has to say so rather than read as a
// missing argument.
test("--llm-review writes where told, or where it chooses", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const named = (r) =>
    r.stdout
      .split("\n")
      .find((l) => l.startsWith("Review items: "))
      ?.slice("Review items: ".length);

  const bare = named(run([addon, ...OFFLINE_FLAGS, "--llm-review"]));
  assert.ok(
    bare && fs.existsSync(bare),
    "bare flag picks a path and writes it"
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-items-"));
  const mine = path.join(dir, "mine.json");
  fs.writeFileSync(mine, "STALE");
  for (const form of [[`--llm-review=${mine}`], ["--llm-review", mine]]) {
    const at = named(run([addon, ...OFFLINE_FLAGS, ...form]));
    assert.equal(at, mine, form[0]);
    // Overwritten, not appended to.
    assert.ok(Array.isArray(JSON.parse(fs.readFileSync(mine, "utf8"))));
  }
  // A following option is not mistaken for the path.
  assert.equal(
    named(run([addon, ...OFFLINE_FLAGS, "--llm-review", "--eslint"])),
    bare
  );

  // The flag before the add-on: the add-on is taken as the file, which must be said.
  const swallowed = run([...OFFLINE_FLAGS, "--llm-review", addon]);
  assert.equal(swallowed.code, 2);
  assert.match(swallowed.stderr, /was taken as --llm-review's output file/);
  fs.rmSync(dir, { recursive: true, force: true });
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

// --llm-verify end to end: the same round trip, minus the two parts that need a person.
// The sweep, the findings and the Extended Code Review are asked for exactly as
// --llm-review asks for them; the add-on description and the manual questions are not, and
// the manual items are absent from the item file so the prompt and the file agree about
// what the reader is being asked to settle. They stay in the REPORT, for the reviewer.
test("--llm-verify withholds the description and the manual items", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const on = run([addon, ...OFFLINE_FLAGS, "--llm-verify"]);
  const lines = on.stdout.split("\n");
  const intro = lines.findIndex((l) => l.startsWith("Please verify"));
  const target = lines.findIndex((l) => l.startsWith("Reviewed XPI:"));
  assert.ok(intro > -1, "prompt is printed");
  assert.ok(intro < target, "prompt comes before the Review Details section");
  assert.ok(!on.stdout.includes("── Found Issues ──"), "no prose report");
  assert.ok(!on.stdout.includes("── Setup ──"), "no feed");

  // The inverse of the --llm-review assertions above: these are the two withheld steps,
  // and their absence is the whole feature.
  assert.ok(!on.stdout.includes('"Report"'), "no manual questions asked");
  assert.ok(!on.stdout.includes('"Clear"'), "no manual questions asked");
  assert.ok(
    !on.stdout.includes("summary.md"),
    "no add-on description asked for"
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

// The two flags are one round trip at two depths, so asking for both leaves no one prompt
// to print. Refused before anything that names a flag, so every later message can name the
// one that was actually given.
test("--llm-review and --llm-verify are refused together", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const both = run([addon, ...OFFLINE_FLAGS, "--llm-review", "--llm-verify"]);
  assert.equal(both.code, 2);
  assert.match(both.stderr, /--llm-review and --llm-verify/);
  assert.match(both.stderr, /Pick one/);
});

// Every guard --llm-review carries applies to --llm-verify too, and each message names the
// flag that was actually used rather than the one the guard was written for.
test("--llm-verify carries the same guards, named for itself", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const json = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-verify",
    "--report-format",
    "json",
  ]);
  assert.equal(json.code, 2);
  assert.match(json.stderr, /--llm-verify is text only/);

  const verdict = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-verify",
    "--llm-verdict",
    "answers.json",
  ]);
  assert.equal(verdict.code, 2);
  assert.match(verdict.stderr, /--llm-verify and --llm-verdict/);

  // The optional value swallows a following add-on path, leaving nothing to review.
  const swallowed = run([...OFFLINE_FLAGS, "--llm-verify", addon]);
  assert.equal(swallowed.code, 2);
  assert.match(swallowed.stderr, /--llm-verify's output file/);
  assert.match(swallowed.stderr, /--llm-verify=<file>/);
});

// A review flag switches on the verification prompt and nothing else: the review stays
// deterministic, so the flag must reach the pipeline as a print decision and leave every
// other opt alone. It arrives as the MODE, not a boolean, so the two pipeline sites that
// read it as a truthiness test keep working while format.js and items.js can tell the two
// prompts apart.
test("a review flag carries only the prompt decision into the run", () => {
  const bare = pipelineOptsFromArgv([]);
  assert.equal(bare.llmReview, undefined);

  const full = pipelineOptsFromArgv(["--llm-review"]);
  assert.equal(full.llmReview, "full");
  assert.deepEqual({ ...full, llmReview: undefined }, bare);

  const verify = pipelineOptsFromArgv(["--llm-verify"]);
  assert.equal(verify.llmReview, "verify");
  assert.deepEqual({ ...verify, llmReview: undefined }, bare);
});

// The optional value belongs to whichever flag carried it, and a BARE flag is encoded as
// an empty value - so the path must be read with `??`, never truthiness, or a bare
// --llm-review would fall through and pick up --llm-verify's.
test("either review flag takes an optional output path", () => {
  assert.equal(pipelineOptsFromArgv(["--llm-review"]).llmReviewOut, undefined);
  assert.equal(pipelineOptsFromArgv(["--llm-verify"]).llmReviewOut, undefined);
  assert.equal(
    pipelineOptsFromArgv(["--llm-verify=/tmp/items.json"]).llmReviewOut,
    "/tmp/items.json"
  );
  assert.equal(
    pipelineOptsFromArgv(["--llm-review=/tmp/items.json"]).llmReviewOut,
    "/tmp/items.json"
  );
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
