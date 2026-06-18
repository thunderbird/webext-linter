// End-to-end test for the review pipeline, against the offline schema fixture.
// The tool is read-only: it never reformats or repacks the submission.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runPipeline } from "../../src/pipeline.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FIXTURE = path.join(here, "..", "schema-fixture");

function tmpAddon(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-"));
  for (const [name, content] of Object.entries(files)) {
    const dest = path.join(dir, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  return dir;
}

// Review reports the eval finding at its original line 1 (no pretty-print shift)
// and leaves the source file on disk untouched (read-only: no reformat, no pack).
test("review: read-only; line numbers match the submitted source", async () => {
  const src = tmpAddon({
    "manifest.json":
      '{"manifest_version":3,"name":"Review Lines","version":"1.0",' +
      '"background":{"scripts":["bg.js"]}}',
    "bg.js": 'const x=1;eval("y");\n',
  });

  const result = await runPipeline({
    addonPath: src,
    schemaZip: SCHEMA_FIXTURE,
  });

  const evalFinding = result.findings.find((f) => f.ruleId === "eval-call");
  assert.ok(evalFinding, "expected an eval-call finding");
  assert.equal(evalFinding.loc.line, 1);
  assert.equal(result.meta.reviewed, true);
  // The source file on disk is untouched.
  assert.equal(
    fs.readFileSync(path.join(src, "bg.js"), "utf8"),
    'const x=1;eval("y");\n'
  );

  fs.rmSync(src, { recursive: true, force: true });
});

const EXPERIMENT_MANIFEST =
  '{"manifest_version":3,"name":"Exp","version":"1.0",' +
  '"background":{"scripts":["bg.js"]},' +
  '"experiment_apis":{"myApi":{"schema":"s.json"}}}';

// An Experiment add-on submitted without --allow-experiments rejects outright:
// the review runs ONLY the experiment-not-allowed check (the eval that would
// otherwise fire is never scanned), with no manual-review reminders and no AI
// summaries.
test("invalid Experiment: only the reject check runs, nothing else", async () => {
  const src = tmpAddon({
    "manifest.json": EXPERIMENT_MANIFEST,
    "bg.js": 'eval("y");\n',
  });

  const result = await runPipeline({
    addonPath: src,
    schemaZip: SCHEMA_FIXTURE,
  });

  assert.deepEqual(
    result.findings.map((f) => f.ruleId),
    ["experiment-not-allowed"]
  );
  assert.deepEqual(result.meta.checksRun, ["experiment-not-allowed"]);
  assert.deepEqual(result.meta.manualReview, []);
  assert.equal(result.summarize, undefined);
  assert.equal(result.summarizeAddon, undefined);

  fs.rmSync(src, { recursive: true, force: true });
});

// Control: with --allow-experiments the same add-on takes the normal path - the
// eval-call check fires and the reject check does not run.
test("allowed Experiment: normal review runs, no reject", async () => {
  const src = tmpAddon({
    "manifest.json": EXPERIMENT_MANIFEST,
    "bg.js": 'eval("y");\n',
  });

  const result = await runPipeline({
    addonPath: src,
    schemaZip: SCHEMA_FIXTURE,
    allowExperiments: true,
  });

  const ids = result.findings.map((f) => f.ruleId);
  assert.ok(ids.includes("eval-call"), "eval-call fires in normal mode");
  assert.ok(!ids.includes("experiment-not-allowed"));

  fs.rmSync(src, { recursive: true, force: true });
});
