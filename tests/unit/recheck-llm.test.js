// End-to-end citation coverage over the REAL --llm-review path: assemble the add-on
// summary prompt (framing + rubric + numbered corpus), run it through the real
// reviewAddon -> coerceReview boundary via a fake transport, feed the coerced verdicts
// to resolveRecheck, and assert an ungrounded pass never silently drops. This is the
// path the "compose incident" slipped through - a green unit suite alone would not
// have caught it. The verdict TRANSPORT onto ctx.recheckVerdicts (keepVerdicts, the
// SCA split) is covered by summaries.test.js; here it is assigned directly so the test
// stays on the citation seam.

import { test } from "node:test";
import assert from "node:assert/strict";

import { withManifest, parsed } from "./manifest-ctx.js";
import { createLlmClient } from "../../src/checks/llm-client.js";
import { buildAddonSummarizer } from "../../src/checks/summaries.js";
import { loadRegistry, loadChecks } from "../../src/checks/registry.js";
import { resolveRecheck } from "../../src/lib/recheck.js";
import { fakeReviewTransport } from "./fake-llm.js";

const BG = "tabs.executeScript(tabId);\nconst other = 1;\n";
const MANIFEST = {
  manifest_version: 3,
  name: "x",
  version: "1",
  permissions: ["compose"],
};

// Drive the real path once: assemble via buildAddonSummarizer, run reviewAddon through
// the fake transport (which applies coerceReview to `raw`), then resolveRecheck the
// handed "compose" permission. Returns the resolveRecheck output, the recorded prompt,
// and the coerced review.
async function drive(raw) {
  const ctx = {
    recheck: new Map([
      [
        "unused-permission-recheck",
        [
          {
            ruleId: "producer",
            item: "compose",
            file: "manifest.json",
            loc: { line: 3 },
            kind: "escalation",
            data: null,
          },
        ],
      ],
    ]),
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
  return { out: resolveRecheck(ctx, check), prompt: fake.calls[0], review };
}

const passWith = (usages) => ({
  summary: "s",
  recheck: [
    {
      check: "unused-permission-recheck",
      item: "compose",
      verdict: "pass",
      usages,
    },
  ],
});

test("the assembled prompt carries the numbered corpus and the citation rubric", async () => {
  const { prompt } = await drive({ summary: "s", recheck: [] });
  // numberLines prefixed each corpus line (user message).
  assert.match(prompt.prompt, /1: tabs\.executeScript\(tabId\);/);
  assert.match(prompt.prompt, /- compose/); // the handed recheck item
  // The rewritten framing + rendered vocabulary (system message).
  assert.match(prompt.system, /Return pass ONLY with cited evidence/);
  assert.match(prompt.system, /Accepted tokens \(cite the one that appears/);
  assert.doesNotMatch(prompt.system, /must not be ignored/); // shouting is gone
});

test("a pass with a verifying citation drops the permission", async () => {
  const { out } = await drive(
    passWith([{ file: "bg.js", lines: "1", token: "executeScript" }])
  );
  assert.equal(out.findings.length, 0);
  assert.equal(out.escalations.length, 0); // verified -> dropped
});

test("every hostile ungrounded pass falls to manual review", async () => {
  const hostile = {
    "no usages field": undefined,
    "nonexistent file": [
      { file: "ghost.js", lines: "1", token: "executeScript" },
    ],
    "token outside the vocabulary": [
      { file: "bg.js", lines: "1", token: "query" },
    ],
    "token at the wrong line": [
      { file: "bg.js", lines: "2", token: "executeScript" },
    ],
    "junk-typed usages": "not-an-array",
  };
  for (const [name, usages] of Object.entries(hostile)) {
    const { out } = await drive(passWith(usages));
    assert.equal(out.findings.length, 0, `${name}: no finding`);
    assert.deepEqual(
      out.escalations.map((e) => e.item),
      ["compose"],
      `${name}: falls to manual`
    );
  }
});
