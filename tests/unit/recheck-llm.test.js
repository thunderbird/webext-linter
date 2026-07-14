// End-to-end coverage over the REAL --llm-review path: assemble the add-on summary
// prompt (framing + rubric + the per-occurrence "sites to judge" list + numbered
// corpus), run it through the real reviewAddon -> coerceReview boundary via a fake
// transport, feed the coerced verdicts to resolvePermissionRecheck, and assert the
// per-site aggregation. This is the path the "compose incident" slipped through - a
// green unit suite alone would not have caught it. The verdict TRANSPORT onto
// ctx.recheckVerdicts (keepVerdicts, the SCA split) is covered by summaries.test.js;
// here it is assigned directly so the test stays on the recheck seam.

import { test } from "node:test";
import assert from "node:assert/strict";

import { withManifest, parsed } from "./manifest-ctx.js";
import { createLlmClient } from "../../src/checks/llm-client.js";
import { buildAddonSummarizer } from "../../src/checks/summaries.js";
import { loadRegistry, loadChecks } from "../../src/checks/registry.js";
import { resolvePermissionRecheck } from "../../src/lib/recheck.js";
import { fakeReviewTransport } from "./fake-llm.js";

const BG = "tabs.executeScript(tabId);\nconst other = 1;\n";
const MANIFEST = {
  manifest_version: 3,
  name: "x",
  version: "1",
  permissions: ["compose"],
};

// The handed "compose" permission with its single located token site (as the producer
// would stamp it): executeScript at bg.js:1. The model verdicts the site by its id.
const COMPOSE_ITEM = {
  ruleId: "producer",
  item: "compose",
  file: "manifest.json",
  loc: { line: 3 },
  kind: "escalation",
  data: null,
  occurrences: [
    { id: "compose#1", file: "bg.js", line: 1, token: "executeScript" },
  ],
};

// Drive the real path once: assemble via buildAddonSummarizer, run reviewAddon through
// the fake transport (which applies coerceReview to `raw`), then resolvePermissionRecheck
// the handed "compose" permission. Returns the resolve output, the recorded prompt, and
// the coerced review.
async function drive(raw) {
  const ctx = {
    recheck: new Map([["unused-permission-recheck", [COMPOSE_ITEM]]]),
    jsSources: parsed([
      { file: "bg.js", code: BG, lineOffset: 0, inline: false },
    ]),
    addon: {
      files: new Map([
        ["manifest.json", Buffer.from(JSON.stringify(MANIFEST), "utf8")],
        ["bg.js", Buffer.from(BG, "utf8")],
      ]),
      manifest: MANIFEST,
      bundled: { nonAuthored: new Set() },
    },
  };
  withManifest(ctx);
  const registry = loadRegistry();
  const fake = fakeReviewTransport(raw);
  ctx.llm = createLlmClient({
    ctx,
    token: "t",
    systemIntro: "intro",
    callReview: fake.callReview,
  });
  const summarizer = buildAddonSummarizer(ctx, registry);
  assert.ok(summarizer, "the summarizer must build with a handed recheck item");
  const review = await summarizer.run();
  ctx.recheckVerdicts = review.recheck;
  const check = [...(await loadChecks(registry)).values()]
    .flat()
    .find((c) => c.id === "unused-permission-recheck");
  return {
    out: resolvePermissionRecheck(ctx, check),
    prompt: fake.calls[0],
    review,
  };
}

// A raw review verdicting the compose#1 site.
const siteVerdict = (verdict) => ({
  summary: "s",
  recheck: [{ check: "unused-permission-recheck", item: "compose#1", verdict }],
});

test("the assembled prompt carries the numbered corpus and the per-occurrence rubric", async () => {
  const { prompt } = await drive({ summary: "s", recheck: [] });
  // numberLines prefixed each corpus line (user message).
  assert.match(prompt.prompt, /1: tabs\.executeScript\(tabId\);/);
  assert.match(prompt.prompt, /- compose#1/); // the site id is the item to judge
  // The candidate framing and the rendered site line (system message).
  assert.match(prompt.system, /genuine CANDIDATE - do not dismiss it/);
  assert.match(prompt.system, /pass = this site meets the criteria/);
  assert.match(
    prompt.system,
    /compose#1: "compose" token "executeScript" at bg\.js:1/
  );
  // No leftover citation language.
  assert.doesNotMatch(prompt.system, /usages/);
  assert.doesNotMatch(prompt.system, /Accepted tokens/);
});

test("a pass at the site drops the permission", async () => {
  const { out } = await drive(siteVerdict("pass"));
  assert.equal(out.findings.length, 0);
  assert.equal(out.escalations.length, 0); // exercised there -> justified, dropped
});

test("a fail at the site flags the permission as unused", async () => {
  const { out } = await drive(siteVerdict("fail"));
  assert.deepEqual(
    out.findings.map((f) => f.item),
    ["compose"]
  );
  assert.equal(out.escalations.length, 0);
});

test("an uncertain or missing site verdict falls to manual review", async () => {
  const cases = {
    unsure: siteVerdict("unsure"),
    "no verdict for the site": { summary: "s", recheck: [] },
    "verdict for an invented site id": {
      summary: "s",
      recheck: [
        {
          check: "unused-permission-recheck",
          item: "ghost#9",
          verdict: "pass",
        },
      ],
    },
  };
  for (const [name, raw] of Object.entries(cases)) {
    const { out } = await drive(raw);
    assert.equal(out.findings.length, 0, `${name}: no finding`);
    assert.deepEqual(
      out.escalations.map((e) => e.item),
      ["compose"],
      `${name}: falls to manual`
    );
  }
});
