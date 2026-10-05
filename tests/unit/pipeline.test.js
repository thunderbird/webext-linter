// End-to-end test for the review pipeline, against the offline schema fixture.
// The tool is read-only: it never reformats or repacks the submission.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runPipeline } from "../../src/pipeline.js";
import { fixtureCacheOpts } from "../seed-caches.js";

// A cache pre-seeded from the fixtures, so the pipeline's schema / experiments /
// library-hash fetches all hit disk - these runs stay offline.
const OFFLINE = fixtureCacheOpts();

function tmpAddon(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-"));
  for (const [name, content] of Object.entries(files)) {
    const dest = path.join(dir, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  return dir;
}

// Review reports the finding at its original line 1 (no pretty-print shift) and
// leaves the source file on disk untouched (read-only: no reformat, no pack).
// (Uses a debugger statement as the probe: a WebExtension background script
// cannot run eval & friends without a permissive CSP, so those file checks skip it -
// see src/lib/eval-scan.js.)
test("review: read-only; line numbers match the submitted source", async () => {
  const src = tmpAddon({
    "manifest.json":
      '{"manifest_version":3,"name":"Review Lines","version":"1.0",' +
      '"background":{"scripts":["bg.js"]}}',
    "bg.js": "const x=1;debugger;\n",
  });

  const result = await runPipeline({
    addonPath: src,
    ...OFFLINE,
  });

  // debugger-statement escalates rather than rejecting, so the probe reads the item
  // list - the line is what matters here either way.
  const item = (result.meta.manualReview ?? []).find(
    (m) => m.ruleId === "debugger-statement"
  );
  assert.ok(item, "expected a debugger-statement item");
  assert.equal(item.loc.line, 1);
  assert.equal(result.meta.reviewed, true);
  // The source file on disk is untouched.
  assert.equal(
    fs.readFileSync(path.join(src, "bg.js"), "utf8"),
    "const x=1;debugger;\n"
  );

  fs.rmSync(src, { recursive: true, force: true });
});

const EXPERIMENT_MANIFEST =
  '{"manifest_version":3,"name":"Exp","version":"1.0",' +
  '"background":{"scripts":["bg.js"]},' +
  '"experiment_apis":{"myApi":{"schema":"s.json",' +
  '"parent":{"scopes":["addon_parent"],"script":"impl.js","paths":[["myApi"]]}}}}';

// The eval lives in the privileged Experiment implementation (impl.js), which is
// OUTSIDE the pure WebExtension tree - the one place the eval-call file check
// scans (a WebExtension sandbox needs a permissive CSP to run eval, flagged
// separately by csp-unsafe-*).

// An Experiment add-on submitted without --allow-experiments rejects outright:
// the review runs ONLY the experiment-not-allowed check (the eval in impl.js that
// would otherwise fire is never scanned), with no manual-review reminders and no
// AI summaries.
test("invalid Experiment: only the reject check runs, nothing else", async () => {
  const src = tmpAddon({
    "manifest.json": EXPERIMENT_MANIFEST,
    "bg.js": "browser.myApi.doThing();\n",
    "impl.js": 'this.myApi = class { getAPI() { eval("y"); return {}; } };\n',
  });

  const result = await runPipeline({
    addonPath: src,
    ...OFFLINE,
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
// eval-call check fires (on the impl.js Experiment code, outside the WebExtension
// tree) and the reject check does not run.
test("allowed Experiment: normal review runs, no reject", async () => {
  const src = tmpAddon({
    "manifest.json": EXPERIMENT_MANIFEST,
    "bg.js": "browser.myApi.doThing();\n",
    "impl.js": 'this.myApi = class { getAPI() { eval("y"); return {}; } };\n',
  });

  const result = await runPipeline({
    addonPath: src,
    ...OFFLINE,
    allowExperiments: true,
  });

  const ids = result.findings.map((f) => f.ruleId);
  assert.ok(ids.includes("eval-call"), "eval-call fires in normal mode");
  assert.ok(!ids.includes("experiment-not-allowed"));

  fs.rmSync(src, { recursive: true, force: true });
});

// A link named node_modules is a link like any other here. Nothing installs anything into
// an add-on, so the name earns it no special handling: the XPI holding it is refused before
// any review starts, and nothing behind the link is read.
test("add-on: a node_modules symlink out of the package refuses the XPI", async () => {
  const outside = tmpAddon({ "secret/payload.js": "exfiltrate();\n" });
  const src = tmpAddon({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "Linked",
      version: "1.0",
      background: { scripts: ["bg.js"] },
    }),
    "bg.js": "browser.runtime.onInstalled.addListener(() => {});\n",
  });
  fs.symlinkSync(
    path.join(outside, "secret"),
    path.join(src, "node_modules"),
    "dir"
  );

  await assert.rejects(runPipeline({ addonPath: src, ...OFFLINE }), {
    message:
      "Invalid XPI: node_modules is a symbolic link (an add-on must contain regular files only).",
  });

  [src, outside].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

// The other half: a real node_modules DIRECTORY in an add-on is shipped content, so its
// files are held like any other and are reviewed at their own paths. The fixture
// xpi-shipped-node-modules pins the reported shape; this pins the seam.
test("add-on: a shipped node_modules folder is reviewed like any other folder", async () => {
  const src = tmpAddon({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "Shipped",
      version: "1.0",
      background: { scripts: ["bg.js"] },
    }),
    "bg.js": "browser.runtime.onInstalled.addListener(() => {});\n",
    "node_modules/dep/index.js": 'function f() { return eval("1 + 1"); }\n',
  });

  const { findings } = await runPipeline({ addonPath: src, ...OFFLINE });

  assert.ok(
    findings.some(
      (f) => f.ruleId === "eval-call" && f.file === "node_modules/dep/index.js"
    ),
    "code inside the shipped folder is reviewed at its own path"
  );
  // committed-node-modules is sca:true: an installed tree is build output only where a
  // reviewer installs one, so it says nothing about a packaged add-on.
  assert.ok(
    !findings.some((f) => f.ruleId === "committed-node-modules"),
    "the source-submission check does not reach across to the add-on"
  );

  fs.rmSync(src, { recursive: true, force: true });
});
