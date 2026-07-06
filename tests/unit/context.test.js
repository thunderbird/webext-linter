// Unit tests for buildRunContext's extraction contract: the pass extracts
// api-usage from every source and the content results (remote-js, ...) only for
// AUTHORED files - a non-authored file (the skip set the scanners use) and every
// file of a rejected Experiment are skipped. No parsed AST is retained on the
// source (peak memory is one AST); a reader that needs a skipped file re-parses.

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

test("buildRunContext extracts content only for authored files, retaining no AST", () => {
  const addon = addonWith(
    { "app.js": "export const x = 1;", "lib/vendor.js": "globalThis.y = 2;" },
    ["lib/vendor.js"]
  );
  const ctx = buildRunContext({ addon, schema: {}, options: {} });
  const byFile = Object.fromEntries(ctx.jsSources.map((s) => [s.file, s]));
  const usage = Object.fromEntries(ctx.apiUsages.map((u) => [u.file, u]));
  // api-usage ran for every file (parseError is recorded on the apiUsage entry).
  assert.equal(ctx.apiUsages.length, 2);
  assert.equal(usage["lib/vendor.js"].parseError ?? null, null);
  // The authored file got content extraction; the non-authored bundle did not,
  // but both carry the every-source refs. No AST is retained (only summaries).
  assert.ok(byFile["app.js"].extracted.remoteJs);
  assert.equal(byFile["lib/vendor.js"].extracted.remoteJs, undefined);
  assert.ok(byFile["lib/vendor.js"].extracted.localImports);
  assert.equal(byFile["app.js"].parsed, undefined);
});

test("buildRunContext treats every file as authored when addon.bundled is absent", () => {
  // No pre-step (no skip set): every file is authored and gets content extraction.
  const addon = { files: new Map([["a.js", Buffer.from("const a = 1;")]]) };
  const ctx = buildRunContext({ addon, schema: {}, options: {} });
  assert.ok(ctx.jsSources[0].extracted.remoteJs);
});

test("buildRunContext skips content extraction for a rejected Experiment", () => {
  // Reject-only mode runs no content consumer, so extract only api-usage.
  const addon = addonWith({ "app.js": "export const x = 1;" });
  const ctx = buildRunContext({
    addon,
    schema: {},
    options: {},
    invalidExperiment: true,
  });
  assert.equal(ctx.jsSources[0].extracted.remoteJs, undefined);
  assert.ok(ctx.apiUsages[0]); // api-usage still ran
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
