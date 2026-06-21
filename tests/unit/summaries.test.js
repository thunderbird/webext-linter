// Unit tests for the advisory LLM summaries. buildDiffText / buildAddonText are
// pure (no network); the summarizers are tested with a fake ctx.llm so nothing
// reaches the API.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildDiffText,
  buildAddonText,
  buildSummarizer,
  buildAddonSummarizer,
} from "../../src/checks/summaries.js";
import { loadRegistry } from "../../src/checks/registry.js";
import { parseVendorManifest } from "../../src/normalize/vendor.js";

/** Build an Addon-shaped object from a {path: contents} map. */
function addon(files) {
  const a = {
    files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
    manifest: JSON.parse(files["manifest.json"]),
  };
  // The pipeline resolves the vendored set once; mirror it deterministically.
  const manifest = parseVendorManifest(a);
  a.vendor = { set: new Set(manifest.map((e) => e.path)), manifest };
  return a;
}
/** A ctx with previous + current addons (no llm). */
function ctxFrom(prev, cur) {
  return { addon: addon(cur), previous: addon(prev) };
}

const MV1 = JSON.stringify({ manifest_version: 3, name: "x", version: "1.0" });
const MV2 = JSON.stringify({ manifest_version: 3, name: "x", version: "1.1" });

// ---- change summary (diff) ----

// Added/removed/changed classification: authored text files are quoted
// before+after, a changed binary is named with byte sizes only (not quoted),
// and the manifest's change is surfaced.
test("buildDiffText reports added/removed/changed with authored bodies", () => {
  const prev = {
    "manifest.json": MV1,
    "background.js": "console.log('old');",
    "gone.js": "console.log('gone');",
    "icon.png": "OLDPNG",
  };
  const cur = {
    "manifest.json": MV2,
    "background.js": "console.log('new');",
    "added.js": "console.log('added');",
    "icon.png": "NEWPNGDATA",
  };
  const diff = buildDiffText(ctxFrom(prev, cur));
  assert.match(diff, /Added files: added\.js/);
  assert.match(diff, /Removed files: gone\.js/);
  assert.match(diff, /Changed files: background\.js, icon\.png/);
  assert.ok(diff.includes("console.log('old')")); // changed: previous body
  assert.ok(diff.includes("console.log('new')")); // changed: current body
  assert.ok(diff.includes("console.log('added')")); // added authored body
  assert.match(diff, /icon\.png: changed \(\d+ -> \d+ bytes\)/); // binary: names only
  assert.ok(!diff.includes("NEWPNGDATA")); // binary body never quoted
  assert.match(diff, /manifest\.json changed/);
});

// No change in any file and an identical manifest -> nothing to summarize.
test("buildDiffText returns null when nothing changed", () => {
  const files = { "manifest.json": MV1, "background.js": "same" };
  assert.equal(buildDiffText(ctxFrom(files, files)), null);
});

// buildSummarizer returns { bytes, run }: run() hands the registry prompt + diff
// to the client and returns its prose; bytes is the sent message's UTF-8 size.
test("buildSummarizer sends prompt+diff and reports the transmitted size", async () => {
  const prev = { "manifest.json": MV1, "background.js": "OLD" };
  const cur = { "manifest.json": MV2, "background.js": "NEW" };
  let received;
  const ctx = {
    ...ctxFrom(prev, cur),
    llm: {
      summarize: async (p) => {
        received = p;
        return "Bumped version and changed background.js.";
      },
    },
  };
  const registry = loadRegistry();
  const s = buildSummarizer(ctx, registry);
  assert.equal(typeof s.run, "function");
  assert.ok(s.bytes > 0);
  const out = await s.run();
  assert.equal(out, "Bumped version and changed background.js.");
  assert.ok(received.includes(registry.prompt("change-summary")));
  assert.ok(received.includes("background.js"));
  assert.equal(s.bytes, Buffer.byteLength(received, "utf8"));
});

// No baseline, no llm, or no change -> no summarizer at all (returns null).
test("buildSummarizer returns null without a baseline/llm/change", () => {
  const registry = loadRegistry();
  const cur = { "manifest.json": MV1 };
  const llm = { summarize: async () => "x" };
  // no previous
  assert.equal(buildSummarizer({ addon: addon(cur) }, registry), null);
  // previous but no llm
  const prev = { "manifest.json": MV1, "a.js": "OLD" };
  const next = { "manifest.json": MV1, "a.js": "NEW" };
  assert.equal(buildSummarizer(ctxFrom(prev, next), registry), null);
  // llm but nothing changed
  assert.equal(buildSummarizer({ ...ctxFrom(cur, cur), llm }, registry), null);
});

// The summary is advisory: a failing LLM call yields null, never a throw.
// run() propagates an LLM error; the pipeline (generateSummary) catches it,
// reports it at the step, and keeps the review going - so the deferred itself
// no longer swallows.
test("buildSummarizer run() propagates an LLM error", async () => {
  const prev = { "manifest.json": MV1, "a.js": "OLD" };
  const cur = { "manifest.json": MV2, "a.js": "NEW" };
  const ctx = {
    ...ctxFrom(prev, cur),
    llm: {
      summarize: async () => {
        throw new Error("boom");
      },
    },
  };
  const s = buildSummarizer(ctx, loadRegistry());
  await assert.rejects(() => s.run(), /boom/);
});

// ---- add-on summary (full current) ----

// buildAddonText quotes the manifest and authored files, but excludes vendored
// (VENDOR.md-declared) files and files the review found unused.
test("buildAddonText includes authored files, excludes vendored and unused", () => {
  const ctx = {
    addon: addon({
      "manifest.json": MV1,
      "background.js": "console.log('bg');",
      "orphan.js": "console.log('orphan');",
      "VENDOR.md": "lib.js:\n  - Version: 1.0\n",
      "lib.js": "/* third-party lib */",
    }),
  };
  const text = buildAddonText(ctx, { unused: new Set(["orphan.js"]) });
  assert.ok(text.includes("=== manifest.json ==="));
  assert.ok(text.includes("=== declared permissions ===")); // permission anchor
  assert.ok(text.includes("console.log('bg')")); // authored: included
  assert.ok(!text.includes("console.log('orphan')")); // unused: excluded
  assert.ok(!text.includes("third-party lib")); // vendored: excluded
});

// The declared-permissions block splits the manifest's permission sets so the
// summary's permission review has an explicit anchor: required (permissions),
// optional (optional_permissions), and host (match patterns).
test("buildAddonText lists declared permissions split by kind", () => {
  const manifest = JSON.stringify({
    manifest_version: 3,
    name: "x",
    version: "1.0",
    permissions: ["messagesRead", "<all_urls>"],
    optional_permissions: ["downloads"],
  });
  const ctx = { addon: addon({ "manifest.json": manifest }) };
  const text = buildAddonText(ctx);
  assert.match(text, /required permissions: messagesRead/);
  assert.match(text, /optional permissions: downloads/);
  assert.match(text, /host permissions: <all_urls>/);
  // No proven-used set -> the confirmed-used line is present but empty.
  assert.match(text, /confirmed used by static analysis[^\n]*: \(none\)/);
  // With a proven-used set, the deterministically-used permission is named there
  // so the prompt can tell the model to leave it alone.
  const annotated = buildAddonText(ctx, { used: new Set(["messagesRead"]) });
  assert.match(
    annotated,
    /confirmed used by static analysis[^\n]*: messagesRead/
  );
});

// buildAddonSummarizer returns { bytes, run }: run() sends the registry prompt +
// the current add-on via ctx.llm.reviewAddon, and yields the structured
// { summary, unusedPermissions }; bytes is the sent message's UTF-8 size.
test("buildAddonSummarizer sends prompt+add-on and returns the structured review", async () => {
  let received;
  const review = {
    summary: "The add-on logs on startup.",
    unusedPermissions: [
      {
        permission: "tabs",
        status: "unused",
        reason: "no tab property is read",
      },
    ],
  };
  const ctx = {
    addon: addon({
      "manifest.json": MV1,
      "background.js": "console.log('bg');",
    }),
    llm: {
      reviewAddon: async (p) => {
        received = p;
        return review;
      },
    },
  };
  const registry = loadRegistry();
  const s = buildAddonSummarizer(ctx, registry);
  assert.equal(typeof s.run, "function");
  assert.ok(s.bytes > 0);
  const out = await s.run();
  assert.deepEqual(out, review);
  assert.ok(received.includes(registry.prompt("add-on-summary")));
  assert.ok(received.includes("console.log('bg')"));
  assert.equal(s.bytes, Buffer.byteLength(received, "utf8"));
});

// run() propagates an LLM error; the pipeline (generateAddonSummary) catches it
// and reports it at the step, so the deferred no longer swallows it itself.
test("buildAddonSummarizer run() propagates an LLM error", async () => {
  const ctx = {
    addon: addon({ "manifest.json": MV1 }),
    llm: {
      reviewAddon: async () => {
        throw new Error("boom");
      },
    },
  };
  const s = buildAddonSummarizer(ctx, loadRegistry());
  await assert.rejects(() => s.run(), /boom/);
});

// No token -> no add-on summarizer.
test("buildAddonSummarizer returns null without a token", () => {
  const ctx = { addon: addon({ "manifest.json": MV1 }) };
  assert.equal(buildAddonSummarizer(ctx, loadRegistry()), null);
});

// ---- registry prompts ----

// The prompts are registry-owned (the `prompts:` map): change-summary,
// add-on-summary, and the reviewer system intro all resolve via prompt(name).
test("registry exposes the change-summary, add-on-summary and system-intro prompts", () => {
  const registry = loadRegistry();
  for (const name of ["change-summary", "add-on-summary"]) {
    const p = registry.prompt(name);
    assert.equal(typeof p, "string", name);
    assert.ok(p.length > 0, name);
  }
  assert.ok(registry.prompt("system-intro").includes("report_verdicts"));
});
