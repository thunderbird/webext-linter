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

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");
const REVIEW = path.join(ROOT, "verify.js");
const SCHEMA = path.join(ROOT, "tests", "schema-fixture");

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
  const r = run([addon, "--schema-zip", SCHEMA, "--report-format", "json"]);
  assert.ok([0, 1].includes(r.code));
  const json = JSON.parse(r.stdout);
  assert.equal(json.meta.action, "review");
  assert.ok(Array.isArray(json.findings));
});

// The ESLint code-sanity check is opt-in: it runs only when --eslint is passed.
test("--eslint gates the code-sanity check", () => {
  const addon = path.join(ROOT, "tests", "addons", "all-checks");
  const base = [addon, "--schema-zip", SCHEMA, "--report-format", "json"];
  const off = JSON.parse(run(base).stdout);
  assert.ok(!off.meta.checksRun.includes("code-sanity")); // default: not run
  const on = JSON.parse(run([...base, "--eslint"]).stdout);
  assert.ok(on.meta.checksRun.includes("code-sanity")); // --eslint: runs
});

// The two unused-permission checks always run (after the add-on summary) and read
// the checks memory, so both are in checksRun whether or not --full-summary is
// set: `unused-permission` evaluates a produced list, `unused-permission-manual`
// raises the by-hand reminder when none was produced.
test("both unused-permission checks always run", () => {
  const addon = path.join(ROOT, "tests", "addons", "all-checks");
  const base = [addon, "--schema-zip", SCHEMA, "--report-format", "json"];
  const off = JSON.parse(run(base).stdout);
  assert.ok(off.meta.checksRun.includes("unused-permission"));
  assert.ok(off.meta.checksRun.includes("unused-permission-manual"));
  const on = JSON.parse(run([...base, "--full-summary"]).stdout);
  assert.ok(on.meta.checksRun.includes("unused-permission"));
  assert.ok(on.meta.checksRun.includes("unused-permission-manual"));
});

// JSON is a machine contract: stdout is the document, stderr is silent - even
// with --verbose (no activity feed, no notices).
test("JSON output is fully silent on stderr, even with --verbose", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const r = run([
    addon,
    "--schema-zip",
    SCHEMA,
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
  const r = run([addon, "--schema-zip", SCHEMA, "--report-out", out]);
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
    "--schema-zip",
    SCHEMA,
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

// --full-summary needs a token: without one, the review still runs and a one-line
// notice is printed instead of an add-on summary section.
test("--full-summary without a token prints a skip notice, no add-on section", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const env = { ...process.env };
  delete env.LLM_API_KEY;
  const r = spawnSync(
    process.execPath,
    [REVIEW, addon, "--schema-zip", SCHEMA, "--full-summary"],
    { encoding: "utf8", env }
  );
  assert.ok([0, 1].includes(r.status));
  assert.match(r.stdout, /--full-summary needs the LLM/);
  assert.ok(!r.stdout.includes("── Summary of add-on ──"));
});

// --llm-enabled without any token is a usage error: the run asked for the LLM
// but no key resolved, so fail fast on stderr, exit 2.
test("--llm-enabled without a token errors to stderr and exits 2", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const env = { ...process.env };
  delete env.LLM_API_KEY;
  const r = spawnSync(
    process.execPath,
    [REVIEW, addon, "--schema-zip", SCHEMA, "--llm-enabled"],
    { encoding: "utf8", env }
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs an API token/);
});

// An unknown LLM_API_TYPE is a usage error even with a key set: there is no
// provider for it, so fail fast on stderr, exit 2 (before any network call).
test("--llm-enabled with an unknown LLM_API_TYPE errors and exits 2", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const env = { ...process.env, LLM_API_KEY: "sk-test", LLM_API_TYPE: "bogus" };
  const r = spawnSync(
    process.execPath,
    [REVIEW, addon, "--schema-zip", SCHEMA, "--llm-enabled"],
    { encoding: "utf8", env }
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown LLM_API_TYPE/);
});

// The model is set via the LLM_API_MODEL env var (there is no --llm-model flag):
// it reaches the pipeline's llmModel when --llm-enabled, and stays undefined
// otherwise (the wants gate - config without --llm-enabled does not turn it on).
test("LLM_API_MODEL sets llmModel only when --llm-enabled", () => {
  const saved = process.env.LLM_API_MODEL;
  process.env.LLM_API_MODEL = "my-model";
  try {
    assert.equal(pipelineOptsFromArgv(["--llm-enabled"]).llmModel, "my-model");
    assert.equal(pipelineOptsFromArgv([]).llmModel, undefined);
  } finally {
    if (saved === undefined) {
      delete process.env.LLM_API_MODEL;
    } else {
      process.env.LLM_API_MODEL = saved;
    }
  }
});

// --self-assessment-summary back-doors the LLM: it pulls the provider config
// (LLM_API_KEY/TYPE) so its one closing call has a token, but it does NOT enable
// the LLM checks (llmEnabled stays false).
test("--self-assessment-summary forwards the config without enabling the checks", () => {
  const saved = process.env.LLM_API_KEY;
  process.env.LLM_API_KEY = "sk-test-key";
  try {
    const opts = pipelineOptsFromArgv(["--self-assessment-summary"]);
    assert.equal(opts.selfAssessmentSummary, true);
    assert.equal(opts.llmApiKey, "sk-test-key"); // config reaches the closing call
    assert.equal(opts.llmEnabled, false); // but the LLM checks stay off
    // Without the flag and without --llm-enabled, the key is NOT forwarded.
    assert.equal(pipelineOptsFromArgv([]).llmApiKey, undefined);
  } finally {
    if (saved === undefined) {
      delete process.env.LLM_API_KEY;
    } else {
      process.env.LLM_API_KEY = saved;
    }
  }
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
    const opts = pipelineOptsFromArgv(["--llm-enabled"]);
    assert.equal(opts.llmEnabled, true);
    assert.equal(opts.llmApiType, "ollama");
    assert.equal(opts.llmModel, "llama3.1"); // provider default
    assert.equal(opts.llmApiUrl, "http://localhost:11434/v1"); // local default
    assert.equal(opts.llmApiKey, undefined); // keyless, no fabricated placeholder
    // An explicit LLM_API_URL wins over the local default.
    process.env.LLM_API_URL = "http://remote:11434/v1";
    assert.equal(
      pipelineOptsFromArgv(["--llm-enabled"]).llmApiUrl,
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

// A bare LLM_API_KEY in the environment no longer auto-enables the LLM: with
// --full-summary but no opt-in flag, the run stays deterministic and skips the
// add-on summary even though the env var is set.
test("a bare LLM_API_KEY does not enable the LLM without an opt-in", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const env = { ...process.env, LLM_API_KEY: "sk-not-used" };
  const r = spawnSync(
    process.execPath,
    [REVIEW, addon, "--schema-zip", SCHEMA, "--full-summary"],
    { encoding: "utf8", env }
  );
  assert.ok([0, 1].includes(r.status));
  assert.match(r.stdout, /--full-summary needs the LLM/);
  assert.ok(!r.stdout.includes("── Summary of add-on ──"));
});

// --diff-summary needs --diff-to and a token; with neither, the review still
// completes and prints a one-line notice instead of a change-summary section.
test("--diff-summary without --diff-to or a token prints a skip notice", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const env = { ...process.env };
  delete env.LLM_API_KEY;
  const r = spawnSync(
    process.execPath,
    [REVIEW, addon, "--schema-zip", SCHEMA, "--diff-summary"],
    { encoding: "utf8", env }
  );
  assert.ok([0, 1].includes(r.status));
  assert.match(r.stdout, /--diff-summary needs/);
  assert.ok(!r.stdout.includes("── Summary of changes ──"));
});
