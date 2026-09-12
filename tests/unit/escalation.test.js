// Unit tests for the escalation orchestration: manualEscalations turns a check's
// cases straight into manual refs.

import { test } from "node:test";
import assert from "node:assert/strict";

import { manualEscalations } from "../../src/checks/escalation.js";

const check = {
  id: "unused-files",
  title: "Unused",
  severity: "error",
};

// A deterministic check's escalations route straight to manual refs, carrying
// any per-case data (e.g. a reason) and locus (file/loc) through to the report.
// The third case carries `manualReview`: the ref is what the report layer reads to
// pick the wording, so dropping the flag here would render a case no judgement can
// change as though it were an open question.
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
    { item: "d.js", manualReview: true },
  ]);
  assert.deepEqual(out.findings, []);
  assert.deepEqual(out.manualItems, [
    {
      ruleId: "unused-files",
      item: "x.js",
      hint: "fetch()",
      file: "manifest.json",
      loc: { line: 3 },
      manualReview: false,
      data: { reason: "why" },
      occurrences: null,
    },
    {
      ruleId: "unused-files",
      item: null,
      hint: null,
      file: null,
      loc: null,
      manualReview: false,
      data: null,
      occurrences: null,
    },
    {
      ruleId: "unused-files",
      item: "d.js",
      hint: null,
      file: null,
      loc: null,
      manualReview: true,
      data: null,
      occurrences: null,
    },
  ]);
});
