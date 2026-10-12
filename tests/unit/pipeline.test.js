// End-to-end test for the review pipeline, against the offline schema fixture.
// The tool is read-only: it never reformats or repacks the submission.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runPipeline, resolveReviewSchema } from "../../src/pipeline.js";
import {
  fixtureCacheOpts,
  freshWorkFolder,
  popularityEntries,
  seedSourcesCache,
  seedWorkCache,
} from "../seed-caches.js";
import { createHash } from "node:crypto";
import { NoAnswerError, setNetworkPacing } from "../../src/util/net.js";

// A cache pre-seeded from the fixtures, so the pipeline's schema / experiments /
// library-hash fetches all hit disk - these runs stay offline.
const OFFLINE = fixtureCacheOpts();

/** runPipeline in a fresh work folder of its own, as every review gets one - unless the
 *  test names the folder itself. */
function runReview(opts) {
  return runPipeline({ workFolder: freshWorkFolder(), ...opts });
}

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

  const result = await runReview({
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
// experiment-not-allowed runs first and aborts the review, so no other check runs (the
// eval in impl.js that would otherwise fire is never scanned), with no manual-review
// reminders and no AI summaries.
test("invalid Experiment: only the reject check runs, nothing else", async () => {
  const src = tmpAddon({
    "manifest.json": EXPERIMENT_MANIFEST,
    "bg.js": "browser.myApi.doThing();\n",
    "impl.js": 'this.myApi = class { getAPI() { eval("y"); return {}; } };\n',
  });

  const result = await runReview({
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

  const result = await runReview({
    addonPath: src,
    ...OFFLINE,
    allowExperiments: true,
  });

  const ids = result.findings.map((f) => f.ruleId);
  assert.ok(ids.includes("eval-call"), "eval-call fires in normal mode");
  assert.ok(!ids.includes("experiment-not-allowed"));

  fs.rmSync(src, { recursive: true, force: true });
});

// The verdict decides nothing but what experiment-not-allowed reports: with that check left
// out, a rejected Experiment's review runs exactly as an allowed one does - the same findings,
// its own APIs registered (browser.myApi resolves, so unknown-api is silent), and the review
// mode it was asked for.
test("a rejected Experiment without its reject check reviews as an allowed one", async () => {
  const src = tmpAddon({
    "manifest.json": EXPERIMENT_MANIFEST,
    "bg.js": "browser.myApi.doThing();\n",
    "impl.js": 'this.myApi = class { getAPI() { eval("y"); return {}; } };\n',
  });
  const ids = async (extra) =>
    (await runReview({ addonPath: src, ...OFFLINE, ...extra })).findings
      .map((f) => f.ruleId)
      .sort();
  const skipped = await ids({ checksSkip: ["experiment-not-allowed"] });
  assert.deepEqual(skipped, await ids({ allowExperiments: true }));
  assert.ok(!skipped.includes("unknown-api"), "its APIs are registered");
  fs.rmSync(src, { recursive: true, force: true });

  // Submitted as source, it is a source review.
  const fixture = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "addons",
    "experiment-disallowed-sca"
  );
  const { meta } = await runReview({
    addonPath: path.join(fixture, "xpi"),
    scaRoot: path.join(fixture, "src"),
    scaExpSource: path.join(fixture, "src", "experiment"),
    ...OFFLINE,
  });
  assert.equal(meta.scaRoot, path.join(fixture, "src"));
  assert.deepEqual(meta.checksRun, ["experiment-not-allowed"]);
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

  await assert.rejects(runReview({ addonPath: src, ...OFFLINE }), {
    message:
      "Invalid XPI: node_modules is a symbolic link (an add-on must contain regular files only).",
  });

  [src, outside].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

// Every review has a work folder, named by its caller: a caller that forgot is a wiring
// error, refused before anything is read or written, rather than a review put somewhere
// nobody chose.
test("a review with no work folder is a wiring error", async () => {
  const src = tmpAddon({
    "manifest.json": '{"manifest_version":3,"name":"No Work","version":"1.0"}',
  });
  await assert.rejects(runPipeline({ addonPath: src, ...OFFLINE }), {
    name: "LinterError",
    message: /no workFolder/,
  });
  fs.rmSync(src, { recursive: true, force: true });
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

  const { findings } = await runReview({ addonPath: src, ...OFFLINE });

  assert.ok(
    findings.some(
      (f) => f.ruleId === "eval-call" && f.file === "node_modules/dep/index.js"
    ),
    "code inside the shipped folder is reviewed at its own path"
  );
  // committed-node-modules is input: sca: an installed tree is build output only where a
  // reviewer installs one, so it says nothing about a packaged add-on.
  assert.ok(
    !findings.some((f) => f.ruleId === "committed-node-modules"),
    "the source-submission check does not reach across to the add-on"
  );

  fs.rmSync(src, { recursive: true, force: true });
});

// ---- a host that gives no answer ends the review ----

// The add-on ships lodash under its own file name; package.json + the lock name the
// release, its unpkg listing matches the shipped bytes, and the OSV audit of the release
// rejects. Each answer the review needs comes from a cache the test seeded (lodashCaches),
// and one host gives no answer (failing).
const LODASH = path.resolve("tests/addons/package-range-locked-shipped");
const LISTING = "https://unpkg.com/lodash@4.17.21/?meta";
const OSV_QUERY = "https://api.osv.dev/v1/query";

/** globalThis.fetch answering each URL in `failures` with that status, which no cache can
 *  hold. It refuses every other request as the switched-off network does, which stops
 *  guarding once fetch is replaced. */
function failing(t, failures) {
  setNetworkPacing({ intervalMs: 0, backoffMs: 0, maxWaitMs: 0 });
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const status = failures[String(url)];
    if (status === undefined) {
      throw new Error(`network request in a test: ${url}`);
    }
    return new Response("", { status });
  };
  t.after(() => {
    globalThis.fetch = real;
  });
}

const lodashListing = () => {
  const bytes = fs.readFileSync(path.join(LODASH, "lib/collection-helpers.js"));
  const sri = createHash("sha256").update(bytes).digest("base64");
  return {
    type: "directory",
    files: [{ path: "/lodash.core.js", integrity: `sha256-${sri}` }],
  };
};

/** The review's caches for the lodash add-on, as runPipeline opts: npm's downloads reading,
 *  and the unpkg `listing` when one is given. */
const lodashCaches = (listing) => ({
  workCache: seedWorkCache({
    popularity: popularityEntries({
      npm: { lodash: { downloads: 50000000 } },
    }),
  }),
  sourcesCache: seedSourcesCache({
    meta: listing ? { [LISTING]: listing } : {},
  }),
});

// AUDITS #49: a refused listing read as "lodash is not shipped" would drop the declaration
// before its audit and pass the add-on clean.
test("a listing unpkg does not answer ends the review instead of passing it", async (t) => {
  failing(t, { [LISTING]: 503 });
  await assert.rejects(
    runReview({ addonPath: LODASH, ...OFFLINE, ...lodashCaches() }),
    (err) =>
      err instanceof NoAnswerError &&
      err.message.includes("unpkg.com") &&
      err.message.includes("HTTP 503")
  );
});

// An OSV outage that recorded nothing would read as a release with no advisories.
test("an OSV query that gets no answer ends the review", async (t) => {
  failing(t, { [OSV_QUERY]: 502 });
  await assert.rejects(
    runReview({
      addonPath: LODASH,
      ...OFFLINE,
      ...lodashCaches(lodashListing()),
    }),
    (err) =>
      err instanceof NoAnswerError &&
      err.message.includes("api.osv.dev") &&
      err.message.includes("HTTP 502")
  );
});

// A schema cache known to be too old for the add-on is refreshed; a refresh that gets no
// answer ends the review rather than reviewing against the stale copy.
test("a stale schema cache whose refresh gets no answer ends the review", async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-stale-schema-"));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  fs.cpSync(OFFLINE.schemaCache, cacheDir, { recursive: true });
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  for (const f of fs.readdirSync(cacheDir)) {
    fs.utimesSync(path.join(cacheDir, f), old, old);
  }
  setNetworkPacing({ intervalMs: 0, backoffMs: 0, maxWaitMs: 0 });
  const real = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  globalThis.fetch = async () => new Response("", { status: 503 }); // every download answers 503
  await assert.rejects(
    resolveReviewSchema({
      cacheDir,
      manifest: {
        manifest_version: 3,
        browser_specific_settings: {
          gecko: { id: "x@example.invalid", strict_max_version: "999.*" },
        },
      },
    }),
    NoAnswerError
  );
});
