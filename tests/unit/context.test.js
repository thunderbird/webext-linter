// Unit tests for buildRunContext's AST-retention contract: api-usage is
// extracted from every source, but the parsed AST is kept (src.parsed) only for
// files a source-level scanner will read - non-authored files (the skip set the
// scanners use) and every file of a rejected Experiment are freed to null, so a
// bundle-heavy add-on does not pin every AST in memory at once. A reader that
// reaches a freed file re-parses on demand (src.parsed ?? parseJs).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildRunContext,
  buildShippedCtx,
  buildScsBuildCtx,
} from "../../src/checks/context.js";

const addonWith = (files, nonAuthored = []) => ({
  files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
  bundled: { nonAuthored: new Set(nonAuthored), classified: [] },
});

test("buildRunContext retains the AST only for files a scanner reads", () => {
  const addon = addonWith(
    { "app.js": "export const x = 1;", "lib/vendor.js": "globalThis.y = 2;" },
    ["lib/vendor.js"]
  );
  const ctx = buildRunContext({ addon, schema: {}, options: {} });
  const byFile = Object.fromEntries(ctx.jsSources.map((s) => [s.file, s]));
  const usage = Object.fromEntries(ctx.apiUsages.map((u) => [u.file, u]));
  // api-usage still ran for every file, parsing it cleanly before the AST was
  // dropped (parseError is recorded on the apiUsage entry, not the JsSource).
  assert.equal(ctx.apiUsages.length, 2);
  assert.equal(usage["lib/vendor.js"].parseError ?? null, null);
  // Authored file keeps its parsed AST; the non-authored bundle is freed to null.
  assert.ok(byFile["app.js"].parsed?.ast);
  assert.equal(byFile["lib/vendor.js"].parsed, null);
});

test("buildRunContext retains no AST when addon.bundled is absent", () => {
  // No pre-step (no skip set): nothing is freed, the old retain-all behavior.
  const addon = { files: new Map([["a.js", Buffer.from("const a = 1;")]]) };
  const ctx = buildRunContext({ addon, schema: {}, options: {} });
  assert.ok(ctx.jsSources[0].parsed?.ast);
});

test("buildRunContext frees every AST for a rejected Experiment", () => {
  // Reject-only mode runs no AST consumer, so retain nothing (the OOM guard the
  // pre-step's skip set cannot cover, since classifyBundled is skipped here).
  const addon = addonWith({ "app.js": "export const x = 1;" });
  const ctx = buildRunContext({
    addon,
    schema: {},
    options: {},
    invalidExperiment: true,
  });
  assert.equal(ctx.jsSources[0].parsed, null);
});

// buildShippedCtx swaps the artifact-specific fields to the built XPI's, shares the
// run-state, drops the source's apiUsages, and marks itself the shipped view. When
// the XPI IS the review target (an XPI review) it is a no-op - the same ctx object -
// so callers route unconditionally through it.
test("buildShippedCtx swaps the artifact fields and is a no-op in an XPI review", () => {
  const source = addonWith({ "src/app.js": "export const x = 1;" });
  const xpi = addonWith({ "app.js": "export const x = 1;" });
  const ctx = buildRunContext({
    addon: source,
    schema: { s: 1 },
    options: {},
    mode: "scs",
  });

  const shipped = buildShippedCtx(ctx, xpi);
  // ctx.addon is a reviewView (a shallow copy without manifest/experiments), so the
  // shipped view's addon carries the XPI's files Map by reference, not the XPI object.
  assert.equal(shipped.addon.files, xpi.files);
  assert.notEqual(shipped.jsSources, ctx.jsSources); // recomputed for the XPI
  assert.equal(shipped.jsSources[0].file, "app.js");
  assert.equal(shipped.apiUsages, undefined); // per-source, source-only: dropped
  assert.equal(shipped.schema, ctx.schema); // shared run-state
  assert.equal(shipped.isShippedView, true); // gates reachability's SCS fallback

  // XPI review: the built XPI IS the review target -> the same ctx object, no copy,
  // and NOT marked a shipped view (there is only one artifact).
  const same = buildShippedCtx(ctx, ctx.addon);
  assert.equal(same, ctx);
  assert.equal(same.isShippedView, undefined);
});

// buildScsBuildCtx routes the SCS build corpus onto ctx.addon (the input: build seam),
// shares run-state, and empties the source-only jsSources/apiUsages. The corpus is
// projected through reviewView like every other ctx.addon, so a build check can never
// read ctx.addon.manifest against another artifact's files.
test("buildScsBuildCtx puts the build corpus on ctx.addon and strips manifest/sources", () => {
  const source = addonWith({ "src/app.js": "export const x = 1;" });
  const ctx = buildRunContext({
    addon: source,
    schema: { s: 1 },
    options: {},
    mode: "scs",
  });
  const buildFiles = new Map([["build.sh", Buffer.from("echo hi")]]);
  // A full-addon shape (manifest present) must NOT leak through: reviewView strips it.
  const buildAddon = { files: buildFiles, manifest: { name: "leak" } };

  const build = buildScsBuildCtx(ctx, buildAddon);
  assert.equal(build.addon.files, buildFiles); // the build corpus is the artifact
  assert.equal(build.addon.manifest, undefined); // reviewView stripped it (no leak)
  assert.deepEqual(build.jsSources, []); // source-only, emptied
  assert.equal(build.apiUsages, undefined);
  assert.equal(build.schema, ctx.schema); // shared run-state
  assert.equal(build.manifest, ctx.manifest); // shipped manifest stays for framing

  // The invalid-Experiment fallback shape {files:new Map()} is a valid, readable ctx.
  const empty = buildScsBuildCtx(ctx, { files: new Map() });
  assert.equal(empty.addon.files.size, 0);
});
