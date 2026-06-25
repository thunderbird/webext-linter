// Unit tests for buildRunContext's AST-retention contract: api-usage is
// extracted from every source, but the parsed AST is kept (src.parsed) only for
// files a source-level scanner will read - non-authored files (the skip set the
// scanners use) and every file of a rejected Experiment are freed to null, so a
// bundle-heavy add-on does not pin every AST in memory at once. A reader that
// reaches a freed file re-parses on demand (src.parsed ?? parseJs).

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRunContext } from "../../src/checks/context.js";

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
