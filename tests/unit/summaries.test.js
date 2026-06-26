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
  buildSelfAssessment,
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
      summarize: async (msg) => {
        received = msg;
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
  // Trusted instructions in system; the untrusted diff, nonce-wrapped, in user.
  assert.ok(received.system.includes(registry.prompt("change-summary")));
  assert.ok(received.user.includes("[[[BEGIN DIFF "));
  assert.ok(received.user.includes("background.js"));
  assert.equal(
    s.bytes,
    Buffer.byteLength(received.system, "utf8") +
      Buffer.byteLength(received.user, "utf8")
  );
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
      "VENDOR.md":
        "vendor/lib.min.js:\n  - Version: 1.0\n" +
        "  - URL: https://unpkg.com/lib@1.0.0/dist/lib.min.js\n",
      "vendor/lib.min.js": "/* third-party lib */",
    }),
  };
  const text = buildAddonText(ctx, "NONCE", { unused: new Set(["orphan.js"]) });
  assert.ok(text.includes("[[[BEGIN MANIFEST NONCE]]]"));
  assert.ok(text.includes("[[[BEGIN PERMISSIONS NONCE]]]")); // permission anchor
  assert.ok(text.includes('[[[BEGIN FILE NONCE path="background.js"]]]'));
  assert.ok(text.includes("console.log('bg')")); // authored: included (verbatim)
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
  const text = buildAddonText(ctx, "NONCE");
  assert.match(text, /required permissions: messagesRead/);
  assert.match(text, /optional permissions: downloads/);
  assert.match(text, /host permissions: <all_urls>/);
  // No proven-used set -> the confirmed-used line is present but empty.
  assert.match(text, /confirmed used by static analysis[^\n]*: \(none\)/);
  // With a proven-used set, the deterministically-used permission is named there
  // so the prompt can tell the model to leave it alone.
  const annotated = buildAddonText(ctx, "NONCE", {
    used: new Set(["messagesRead"]),
  });
  assert.match(
    annotated,
    /confirmed used by static analysis[^\n]*: messagesRead/
  );
});

// Prompt-only library net: a file that looks like a vendored library even when
// classify() did not catch it (a leading "/*!" license banner, or a top-level
// vendor/ dir) is trimmed from the model input - while a developer's MID-file
// "/*!" (the C2 CSS case) is kept, since the anchor requires it at the start.
test("buildAddonText drops a leading-/*! or vendor/ file, keeps a mid-file /*!", () => {
  const ctx = {
    addon: addon({
      "manifest.json": MV1,
      "background.js": "console.log('bg');",
      "purify.es.mjs": "/*! DOMPurify 3.2.6 | Cure53 */\nexport const x = 1;",
      "vendor/sheet.js": "var XLSX = {};",
      "styles.css": ".a{color:red} /*! mid-file */ .b{color:blue}",
    }),
  };
  const text = buildAddonText(ctx, "NONCE");
  assert.ok(text.includes("console.log('bg')")); // authored: kept
  assert.ok(!text.includes("DOMPurify 3.2.6")); // leading /*! banner: dropped
  assert.ok(!text.includes("var XLSX")); // vendor/ dir: dropped
  assert.ok(text.includes("color:blue")); // mid-file /*!: kept (authored CSS)
});

// The self-assessment FINDINGS block labels each finding with its severity, so the
// audit prompt can tell an info/advisory finding from an error.
test("buildSelfAssessment labels findings with severity", () => {
  const ctx = { addon: addon({ "manifest.json": MV1, "bg.js": "x" }) };
  const findings = [
    {
      file: "bg.js",
      loc: { line: 3 },
      ruleId: "unsafe-html",
      severity: "warning",
      message: "Dynamic content assigned.",
    },
    {
      file: "manifest.json",
      ruleId: "addon-icon-missing",
      severity: "info",
      message: "Adding an add-on icon improves user acceptance.",
    },
  ];
  const out = buildSelfAssessment(ctx, loadRegistry(), findings);
  assert.ok(out, "self-assessment built");
  assert.match(out.user, /bg\.js:3 {2}\[warning: unsafe-html\]/);
  assert.match(out.user, /\[info: addon-icon-missing\]/);
});

// buildAddonSummarizer returns { bytes, run }: run() sends the registry prompt +
// the current add-on via ctx.llm.reviewAddon, and yields the structured
// { summary, recheck }; bytes is the sent message's UTF-8 size.
test("buildAddonSummarizer sends prompt+add-on and returns the structured review", async () => {
  let received;
  const review = {
    summary: "The add-on logs on startup.",
    recheck: [
      {
        check: "unused-permission",
        item: "tabs",
        verdict: "fail",
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
      reviewAddon: async (msg) => {
        received = msg;
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
  // Trusted prompt in system; the untrusted add-on corpus, nonce-wrapped, in user.
  assert.ok(received.system.includes(registry.prompt("add-on-summary")));
  assert.ok(received.user.includes("[[[BEGIN FILE "));
  assert.ok(received.user.includes("console.log('bg')"));
  // Coverage guard: no add-on file body leaks into the trusted system role.
  assert.ok(!received.system.includes("console.log('bg')"));
  assert.equal(
    s.bytes,
    Buffer.byteLength(received.system, "utf8") +
      Buffer.byteLength(received.user, "utf8")
  );
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

// buildSelfAssessment carries the authored sources (minus unused/vendored, like
// the add-on summary), a FINDINGS block of the deterministic results to audit, and
// the already-escalated items - under the self-assessment prompt.
test("buildSelfAssessment carries the sources, findings, and escalations", () => {
  const ctx = {
    addon: addon({
      "manifest.json": MV1,
      "background.js": "el.innerHTML = data;",
      "orphan.js": "console.log('dead');",
    }),
  };
  const registry = loadRegistry();
  const findings = [
    {
      file: "background.js",
      loc: { line: 1 },
      ruleId: "unsafe-html",
      message: "Dynamic content is assigned via .innerHTML.\nRead more: ...",
    },
  ];
  const manualItems = [
    { file: "background.js", loc: { line: 1 }, ruleId: "data-exfiltration" },
  ];
  const out = buildSelfAssessment(
    ctx,
    registry,
    findings,
    manualItems,
    new Set(["orphan.js"])
  );
  assert.ok(out.system.includes(registry.prompt("self-assessment")));
  // Sources are present; the unused file is excluded.
  assert.ok(out.user.includes("el.innerHTML = data;"));
  assert.ok(!out.user.includes("console.log('dead');"));
  // The findings block lists the finding (first message line only) for the FP audit.
  assert.ok(out.user.includes("FINDINGS"));
  assert.ok(out.user.includes("background.js:1  [error: unsafe-html]")); // severity defaults to error
  assert.ok(!out.user.includes("Read more: ...")); // only the first message line
  // Already-escalated items are listed so they are not re-reported as misses.
  assert.ok(out.user.includes("ALREADY_ESCALATED"));
  assert.ok(out.user.includes("data-exfiltration"));
  assert.equal(
    out.bytes,
    Buffer.byteLength(out.system, "utf8") + Buffer.byteLength(out.user, "utf8")
  );
  // No prompt -> null (defensive).
  assert.equal(
    buildSelfAssessment(ctx, { prompt: () => null }, findings),
    null
  );
});
