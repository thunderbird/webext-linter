// Unit tests for the escalation orchestration: manualEscalations turns a check's
// cases straight into manual refs.

import { test } from "node:test";
import assert from "node:assert/strict";

import { manualEscalations } from "../../src/checks/escalation.js";

const check = {
  id: "unused-files",
  title: "Unused",
  severity: "error",
  section: "code-review",
};

// A deterministic check's escalations route straight to manual refs, carrying any
// per-case data (e.g. a reason) and locus (file/loc) through to the report. The SECTION
// is stamped from the check, not read off the case: every case a check raises asks the
// same question, so a check needing two questions is two checks.
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
      section: "code-review",
      data: { reason: "why" },
      occurrences: null,
    },
    {
      ruleId: "unused-files",
      item: null,
      hint: null,
      file: null,
      loc: null,
      section: "code-review",
      data: null,
      occurrences: null,
    },
  ]);
});

// The section follows the check: the same cases from a manual-review check land there.
test("manualEscalations stamps the section from the check", () => {
  const { manualItems } = manualEscalations(
    { ...check, id: "privacy-policy", section: "manual-review" },
    [{ item: "example.com" }]
  );
  assert.equal(manualItems[0].section, "manual-review");
});
