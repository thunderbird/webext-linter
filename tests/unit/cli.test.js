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
  assert.match(r.stdout, /> webext-linter@\d+\.\d+\.\d+ review/);
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

// The ESLint code-sanity check is opt-in: it runs only when --eslint is passed.
test("--eslint gates the code-sanity check", () => {
  const addon = path.join(ROOT, "tests", "addons", "all-checks");
  const base = [addon, ...OFFLINE_FLAGS, "--report-format", "json"];
  const off = JSON.parse(run(base).stdout);
  assert.ok(!off.meta.checksRun.includes("code-sanity")); // default: not run
  const on = JSON.parse(run([...base, "--eslint"]).stdout);
  assert.ok(on.meta.checksRun.includes("code-sanity")); // --eslint: runs
});

// The two unused-permission checks always run (after the add-on summary) and read
// the checks memory, so both are in checksRun even in a plain (no-LLM) review:
// `unused-permission` evaluates a produced list, `unused-permission-manual` raises
// the by-hand reminder when none was produced.
test("both unused-permission checks always run", () => {
  const addon = path.join(ROOT, "tests", "addons", "all-checks");
  const base = [addon, ...OFFLINE_FLAGS, "--report-format", "json"];
  const off = JSON.parse(run(base).stdout);
  assert.ok(off.meta.checksRun.includes("unused-permission"));
  assert.ok(off.meta.checksRun.includes("unused-permission-manual"));
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

// --llm-review without any token is a usage error: the run asked for the LLM
// but no key resolved, so fail fast on stderr, exit 2.
test("--llm-review without a token errors to stderr and exits 2", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const env = { ...process.env };
  delete env.LLM_API_KEY;
  const r = spawnSync(
    process.execPath,
    [REVIEW, addon, ...OFFLINE_FLAGS, "--llm-review"],
    { encoding: "utf8", env }
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs an API token/);
});

// An unknown LLM_API_TYPE is a usage error even with a key set: there is no
// provider for it, so fail fast on stderr, exit 2 (before any network call).
test("--llm-review with an unknown LLM_API_TYPE errors and exits 2", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const env = { ...process.env, LLM_API_KEY: "sk-test", LLM_API_TYPE: "bogus" };
  const r = spawnSync(
    process.execPath,
    [REVIEW, addon, ...OFFLINE_FLAGS, "--llm-review"],
    { encoding: "utf8", env }
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown LLM_API_TYPE/);
});

// The model is set via the LLM_API_MODEL env var (there is no --llm-model flag):
// it reaches the pipeline's llmModel when --llm-review, and stays undefined
// otherwise (the wants gate - config without --llm-review does not turn it on).
test("LLM_API_MODEL sets llmModel only when --llm-review", () => {
  const saved = process.env.LLM_API_MODEL;
  process.env.LLM_API_MODEL = "my-model";
  try {
    assert.equal(pipelineOptsFromArgv(["--llm-review"]).llmModel, "my-model");
    assert.equal(pipelineOptsFromArgv([]).llmModel, undefined);
  } finally {
    if (saved === undefined) {
      delete process.env.LLM_API_MODEL;
    } else {
      process.env.LLM_API_MODEL = saved;
    }
  }
});

// Without --llm-review, the provider config (LLM_API_KEY) is NOT forwarded.
test("provider config is not forwarded unless --llm-review", () => {
  const saved = process.env.LLM_API_KEY;
  process.env.LLM_API_KEY = "sk-test-key";
  try {
    assert.equal(pipelineOptsFromArgv([]).llmApiKey, undefined);
    assert.equal(
      pipelineOptsFromArgv(["--llm-review"]).llmApiKey,
      "sk-test-key"
    );
  } finally {
    if (saved === undefined) {
      delete process.env.LLM_API_KEY;
    } else {
      process.env.LLM_API_KEY = saved;
    }
  }
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

// --llm-review is the sole LLM on-switch: it sets llmReview (which turns on the
// checks + the summaries + the recheck). Without it, the LLM stays off.
test("--llm-review is the LLM on-switch (llmReview)", () => {
  assert.equal(pipelineOptsFromArgv(["--llm-review"]).llmReview, true);
  assert.equal(pipelineOptsFromArgv([]).llmReview, false);
});

// LLM_API_TYPE=ollama is keyless and local: a localhost default base URL and the
// llama3.1 default model, resolved with NO fabricated key (llmApiKey undefined).
test("LLM_API_TYPE=ollama resolves keyless local defaults", () => {
  const keys = ["LLM_API_TYPE", "LLM_API_KEY", "LLM_API_URL", "LLM_API_MODEL"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    delete process.env[k];
  }
  process.env.LLM_API_TYPE = "ollama";
  try {
    const opts = pipelineOptsFromArgv(["--llm-review"]);
    assert.equal(opts.llmReview, true);
    assert.equal(opts.llmApiType, "ollama");
    assert.equal(opts.llmModel, "llama3.1"); // provider default
    assert.equal(opts.llmApiUrl, "http://localhost:11434/v1"); // local default
    assert.equal(opts.llmApiKey, undefined); // keyless, no fabricated placeholder
    // An explicit LLM_API_URL wins over the local default.
    process.env.LLM_API_URL = "http://remote:11434/v1";
    assert.equal(
      pipelineOptsFromArgv(["--llm-review"]).llmApiUrl,
      "http://remote:11434/v1"
    );
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  }
});

// A bare LLM_API_KEY in the environment does not auto-enable the LLM: without
// --llm-review the run stays deterministic - no LLM, and no add-on summary section
// - even though the env var is set.
test("a bare LLM_API_KEY does not enable the LLM without --llm-review", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const env = { ...process.env, LLM_API_KEY: "sk-not-used" };
  const r = spawnSync(process.execPath, [REVIEW, addon, ...OFFLINE_FLAGS], {
    encoding: "utf8",
    env,
  });
  assert.ok([0, 1].includes(r.status));
  assert.ok(!r.stdout.includes("── Summary of add-on ──"));
});

// The removed LLM/summary flags parse as unknown options (exit 2): --llm-review is
// the sole on-switch; the summaries are part of it, not separate flags.
test("removed LLM/summary flags are unknown options", () => {
  for (const flag of ["--llm-enabled", "--full-summary", "--diff-summary"]) {
    const r = run(["x.xpi", flag]);
    assert.equal(r.code, 2, `${flag} should exit 2`);
    assert.match(r.stderr, /Unknown option/, `${flag} should be unknown`);
  }
});
