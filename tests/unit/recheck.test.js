// The post-summary recheck mechanism (src/checks/lib/recheck.js + the runChecks
// divert): producers hand their manual items to a recheck consumer when the full
// summary runs, the summary re-judges them, and resolveRecheck maps each verdict
// back to a finding / drop / manual item. Covers the verdict mapping, the guard
// (only handed-over items can be touched), the summary-prompt composition, and the
// orchestrator divert itself.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveRecheck,
  buildRecheckSections,
} from "../../src/checks/lib/recheck.js";
import { runChecks, loadRegistry } from "../../src/checks/registry.js";

// A handed-over manual item, as the producer's escalation became (manualRef).
const handed = (item, line) => ({
  ruleId: "producer",
  item,
  file: "manifest.json",
  loc: { line },
  kind: "escalation",
  data: null,
});

// ---- resolveRecheck: verdict -> finding / drop / manual ----
// fail -> a finding (carrying the model reason + locus), pass -> dropped, unsure
// -> a manual escalation, and an item with no verdict at all (summary skipped or
// errored) also -> manual. The consumer's own id/severity are stamped later by
// runOneCheck, so resolveRecheck leaves them null here.
test("resolveRecheck maps each verdict to a finding, a drop, or a manual item", () => {
  const ctx = {
    recheck: new Map([
      ["c", [handed("a", 4), handed("b", 5), handed("c", 6), handed("d", 7)]],
    ]),
    addon: {
      recheck: [
        { check: "c", item: "a", verdict: "fail", reason: "unused" },
        { check: "c", item: "b", verdict: "pass", reason: "used" },
        { check: "c", item: "c", verdict: "unsure", reason: "cannot tell" },
        // "d" gets no verdict at all.
      ],
    },
  };
  const out = resolveRecheck(ctx, { id: "c" });

  assert.deepEqual(
    out.findings.map((f) => f.item),
    ["a"] // only the fail
  );
  assert.equal(out.findings[0].data.reason, "unused");
  assert.equal(out.findings[0].loc.line, 4); // locus carried from the handed item
  assert.equal(out.findings[0].file, "manifest.json");

  assert.deepEqual(
    out.escalations.map((e) => e.item).sort(),
    ["c", "d"] // unsure AND the missing verdict both fall to manual
  );
  const c = out.escalations.find((e) => e.item === "c");
  assert.equal(c.data.reason, "cannot tell");
  assert.equal(c.loc.line, 6);
});

// The guard: resolveRecheck only consults verdicts for items it was actually
// handed. A verdict for an item that was never handed over (a model invention),
// or one tagged for a different check, is inert - it can neither add nor flip a
// result.
test("resolveRecheck ignores verdicts for items it was not handed (the guard)", () => {
  const ctx = {
    recheck: new Map([["c", [handed("real", 4)]]]),
    addon: {
      recheck: [
        { check: "c", item: "real", verdict: "pass", reason: "" },
        { check: "c", item: "ghost", verdict: "fail", reason: "invented" },
        {
          check: "other",
          item: "real",
          verdict: "fail",
          reason: "wrong check",
        },
      ],
    },
  };
  const out = resolveRecheck(ctx, { id: "c" });
  // "real" passed -> dropped; "ghost" and the other-check verdict are ignored.
  assert.deepEqual(out.findings, []);
  assert.deepEqual(out.escalations, []);
});

// With nothing handed to this consumer, it is a clean no-op (even if the summary
// happened to return verdicts tagged with its id).
test("resolveRecheck is a no-op when nothing was handed over", () => {
  assert.deepEqual(resolveRecheck({}, { id: "c" }), {
    findings: [],
    escalations: [],
  });
  assert.deepEqual(
    resolveRecheck(
      {
        recheck: new Map(),
        addon: { recheck: [{ check: "c", item: "x", verdict: "fail" }] },
      },
      { id: "c" }
    ),
    { findings: [], escalations: [] }
  );
});

// A per-site producer hands items with no `item` token but a `loc` (e.g.
// data-exfiltration's per-sink manual items). Those key on file:line, so two sinks
// in the same file get distinct verdicts instead of collapsing to one key.
test("loc-bearing items with no item token key on file:line", () => {
  const sink = (line) => ({
    ruleId: "p",
    item: null,
    file: "bg.js",
    loc: { line },
    kind: "escalation",
    data: null,
  });
  const ctx = {
    recheck: new Map([["x", [sink(4), sink(7)]]]),
    addon: {
      recheck: [
        { check: "x", item: "bg.js:4", verdict: "fail", reason: "a" },
        { check: "x", item: "bg.js:7", verdict: "pass", reason: "b" },
      ],
    },
  };
  // The two same-file sinks resolve independently: 4 -> finding, 7 -> dropped.
  const out = resolveRecheck(ctx, { id: "x" });
  assert.deepEqual(
    out.findings.map((f) => f.loc.line),
    [4]
  );
  assert.deepEqual(out.escalations, []);
  // ...and they are listed in the prompt as distinct file:line keys.
  const section = buildRecheckSections(
    { recheck: new Map([["x", [sink(4), sink(7)]]]) },
    { checkEntry: () => ({ "summary-prompt": "R" }) }
  );
  assert.ok(section.includes("- bg.js:4"));
  assert.ok(section.includes("- bg.js:7"));
});

// ---- buildRecheckSections: the prompt fragment ----
// One section per consumer with handed items, carrying that consumer's
// summary-prompt and the de-duplicated item keys, labeled with the check id so the
// model can echo it back. Empty when nothing was handed over.
test("buildRecheckSections composes a labeled section per consumer", () => {
  const registry = {
    checkEntry: (id) => ({ "summary-prompt": `RUBRIC for ${id}` }),
  };
  const ctx = {
    recheck: new Map([
      ["unused-permission", [handed("tabs", 4), handed("storage", 5)]],
    ]),
  };
  const out = buildRecheckSections(ctx, registry);
  assert.ok(out.includes("recheck: unused-permission"));
  assert.ok(out.includes("RUBRIC for unused-permission"));
  assert.ok(out.includes('check="unused-permission"'));
  assert.ok(out.includes("- tabs"));
  assert.ok(out.includes("- storage"));
});

test("buildRecheckSections is empty when nothing was handed over", () => {
  const registry = { checkEntry: () => ({ "summary-prompt": "R" }) };
  assert.equal(buildRecheckSections({}, registry), "");
  assert.equal(buildRecheckSections({ recheck: new Map() }, registry), "");
});

// A recheck target whose registry entry has no summary-prompt is skipped (its
// items still fall back to manual via resolveRecheck, so none are lost).
test("buildRecheckSections skips a consumer with no summary-prompt", () => {
  const registry = { checkEntry: () => ({}) };
  const ctx = { recheck: new Map([["x", [handed("a", 1)]]]) };
  assert.equal(buildRecheckSections(ctx, registry), "");
});

// ---- the runChecks divert ----
// A producer (post-summary-recheck: unused-permission) declares its manual items.
// When ctx.recheckActive, runChecks hands them to ctx.recheck instead of manual
// review; otherwise they stay in manual review and ctx.recheck is never created.
const producerCtx = () => {
  const manifest = { manifest_version: 3, permissions: ["tabs", "storage"] };
  return {
    addon: {
      manifest,
      files: new Map([
        ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))],
      ]),
      // Pre-set so getPermissionAnalysis returns it (nothing provably used), no
      // schema needed: both declared permissions are escalated by the producer.
      permissionAnalysis: { usedPermissions: new Set() },
    },
  };
};

test("runChecks diverts a producer's manual items to ctx.recheck when active", async () => {
  const registry = loadRegistry();
  const ctx = { ...producerCtx(), recheckActive: true };
  const out = await runChecks(ctx, registry, {
    only: ["unused-permission-manual"],
  });
  // Not in manual review - handed to the recheck consumer instead.
  assert.deepEqual(out.manualItems, []);
  assert.deepEqual(
    ctx.recheck
      .get("unused-permission")
      .map((m) => m.item)
      .sort(),
    ["storage", "tabs"]
  );
});

test("runChecks leaves a producer's manual items in manual review when inactive", async () => {
  const registry = loadRegistry();
  const ctx = { ...producerCtx(), recheckActive: false };
  const out = await runChecks(ctx, registry, {
    only: ["unused-permission-manual"],
  });
  assert.deepEqual(out.manualItems.map((m) => m.item).sort(), [
    "storage",
    "tabs",
  ]);
  assert.equal(ctx.recheck, undefined); // nothing was diverted
});
