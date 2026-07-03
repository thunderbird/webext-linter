// Unit tests for the escalation orchestration: runLlmCheck (gather one verdict
// per candidate id, then hand them to the check's resolve) and manualEscalations
// (a deterministic check's cases straight to manual refs). No network: ctx.llm
// is faked, returning a per-id verdict Map.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runLlmCheck, manualEscalations } from "../../src/checks/escalation.js";

const check = {
  id: "unused-files",
  title: "Unused",
  severity: "error",
  prompt: "PROMPT",
};

// With no token, every candidate defaults to "unsure"; the check's resolve
// decides what that means (here, a manual note). The model is never called.
test("runLlmCheck with no token defaults every candidate to unsure", async () => {
  const seen = [];
  const step = {
    candidates: [
      { id: "U1", file: "a.js" },
      { id: "U2", file: "b.js" },
    ],
    resolve: (verdicts) => {
      for (const [id, v] of verdicts) {
        seen.push(`${id}:${v.verdict}`);
      }
      return { findings: [], manual: [{ item: "a.js" }] };
    },
  };
  const out = await runLlmCheck({}, check, step);
  assert.deepEqual(seen.sort(), ["U1:unsure", "U2:unsure"]);
  assert.deepEqual(out.findings, []);
  assert.deepEqual(out.manualItems, [
    {
      ruleId: "unused-files",
      item: "a.js",
      hint: null,
      file: null,
      loc: null,
      kind: "escalation",
      data: null,
      recheckEligible: true,
    },
  ]);
});

// With a token, the per-id verdicts from evaluate reach resolve unchanged, and
// the rubric sent to the model is the check's prompt plus its candidates.
test("runLlmCheck sends prompt + candidates + the routed addon to evaluate", async () => {
  let sent;
  // ctx is the ROUTED context; runLlmCheck must hand ctx.addon to evaluate so the
  // model reads the artifact this check runs over (not a captured one).
  const routedAddon = { files: new Map(), manifest: {} };
  const ctx = {
    addon: routedAddon,
    llm: {
      evaluate: async (req) => {
        sent = req;
        return new Map([["U1", { verdict: "fail", reason: "r" }]]);
      },
    },
  };
  const step = {
    candidates: [{ id: "U1", file: "a.js" }],
    resolve: (verdicts) => ({
      findings: verdicts.get("U1").verdict === "fail" ? [{ file: "a.js" }] : [],
      manual: [],
    }),
  };
  const out = await runLlmCheck(ctx, check, step);
  assert.equal(sent.rubric, "PROMPT");
  assert.deepEqual(sent.candidates, [{ id: "U1", file: "a.js" }]);
  assert.equal(sent.addon, routedAddon); // the routed artifact reached evaluate
  assert.equal(out.findings.length, 1);
  assert.deepEqual(out.manualItems, []);
});

// A deterministic check's escalations route straight to manual refs, carrying
// any per-case data (e.g. a reason) and locus (file/loc) through to the report.
test("manualEscalations maps each escalation to a manual ref", () => {
  const out = manualEscalations(check, [
    {
      item: "x.js",
      hint: "fetch()",
      file: "manifest.json",
      loc: { line: 3 },
      data: { reason: "why" },
    },
    { item: null },
  ]);
  assert.deepEqual(out.findings, []);
  assert.deepEqual(out.manualItems, [
    {
      ruleId: "unused-files",
      item: "x.js",
      hint: "fetch()",
      file: "manifest.json",
      loc: { line: 3 },
      kind: "escalation",
      data: { reason: "why" },
      // Neither escalation opts out, so both default to recheck-eligible.
      recheckEligible: true,
    },
    {
      ruleId: "unused-files",
      item: null,
      hint: null,
      file: null,
      loc: null,
      kind: "escalation",
      data: null,
      recheckEligible: true,
    },
  ]);
});
