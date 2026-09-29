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
// Every case names the artifact its locus is in, the way the holder minted it - there is
// nothing to thread in from the orchestrator, and a case without one is refused.
const XPI = "XPI";

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
      artifact: XPI,
      data: { reason: "why" },
    },
    { item: null, file: null, loc: null, artifact: XPI },
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
      artifact: "XPI",
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
      artifact: "XPI",
    },
  ]);
});

// The section follows the check: the same cases from a manual-review check land there.
test("manualEscalations stamps the section from the check", () => {
  const { manualItems } = manualEscalations(
    { ...check, id: "privacy-policy", section: "manual-review" },
    [{ item: "example.com", file: null, loc: null, artifact: XPI }]
  );
  assert.equal(manualItems[0].section, "manual-review");
});

// The third producer is held to the same contract as the other two. A case reaches a
// reader with a tree to look in (src/report/handback.js gives it a root from this field),
// and on the one route carrying two artifacts there is nothing to fall back to - which is
// how a case once reached the hand-back with no root and stopped the review dead.
test("an escalation that cannot say which artifact it is in is refused", () => {
  for (const bad of [
    { item: "x", file: "a.js" },
    { item: "x", file: "a.js", artifact: null },
    { item: "x", file: null, loc: null },
  ]) {
    assert.throws(
      () => manualEscalations(check, [bad]),
      /an escalation from unused-files needs a locus/,
      `expected ${JSON.stringify(bad)} to be refused`
    );
  }
});
