// Taking what a sweep found and routing each result the way its own check routes its own
// cases. The agent that swept classifies nothing, so every guard here exists because a
// result routed by anything other than what that check already does would land a case in
// front of whoever cannot settle it - which is the defect this path was built to end.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkedResult, mergeSweepResults } from "../../src/report/sweep.js";
import { loadRegistry } from "../../src/checks/registry.js";

const registry = loadRegistry();

/** What this run asked to be swept, as preSweepOf builds it. */
const asked = {
  items: [
    { check: "privacy-policy" },
    { check: "data-exfiltration" },
    { check: "cleartext-transmission" },
  ],
};

/** One result, with the fields a sweep hands back. */
function result(check, file, line, hint = null) {
  return { check, file, line, hint };
}

function merge(results, manual = [], findings = []) {
  return mergeSweepResults({
    results,
    manual,
    findings,
    preSweep: asked,
    registry,
    file: "/s.json",
  });
}

// ---- what an agent may write ----
// The agent AUTHORS these rows - the linter cannot, since a sweep exists for what its
// detectors miss - so each is held to a shape at the one point it enters the review.
// Refused rather than repaired: a result nothing can be done with is a sweep half applied.

test("a malformed sweep result is rejected with a reason", () => {
  const bad = (entry, re) =>
    assert.throws(() => checkedResult("row 1", entry), re);
  bad("nope", /must be an object/);
  bad({ check: "privacy-policy" }, /names no "file"/);
  bad({ check: "x", file: "a.js", line: 0 }, /has line 0/);
  bad({ check: "x", file: "a.js", hint: "" }, /has hint ""/);
  bad(
    { check: "x", file: "a.js", hint: "x".repeat(201) },
    /201-character hint/
  );
  // Where it lands and how it reads are the linter's, so a result that tries to say is
  // refused rather than quietly stripped - that would be an agent wording the report.
  bad(
    { check: "x", file: "a.js", severity: "error" },
    /may only set "check", "file", "line", "hint"/
  );

  assert.deepEqual(
    checkedResult("row 1", { check: "privacy-policy", file: "a.js" }),
    { check: "privacy-policy", file: "a.js", line: null, hint: null }
  );
});

// ---- the routing ----

// The whole point of this file. A sweep is a DETECTOR: what comes back is a hint its
// check's own detectors missed, and from that point it is one of that check's cases,
// handled the way that check already handles them. Three routes, one rule.
test("a result goes where its check's own cases go", () => {
  const { manual, findings, applied } = merge([
    result("privacy-policy", "providers/Gravatar.js", 23, "gravatar.com"),
    result("data-exfiltration", "bg.js", 40, "<a ping> carries the digest"),
    result("cleartext-transmission", "sync.js", 12, "posts over http://"),
  ]);
  assert.deepEqual(applied, [
    "privacy-policy (providers/Gravatar.js:23) -> code-review",
    "data-exfiltration (bg.js:40) -> code-review",
    "cleartext-transmission (sync.js:12) -> finding",
  ]);

  // This check asks its two readers two different questions, so a swept case is screened
  // first, exactly as a detected one is. Both wordings ride on the item: the agent reads
  // one, and the reviewer whatever survives reads the other.
  const screened = manual.find((m) => m.ruleId === "privacy-policy");
  assert.equal(screened.section, "code-review");
  assert.equal(screened.extended, true);
  assert.deepEqual(
    [screened.file, screened.loc.line],
    ["providers/Gravatar.js", 23]
  );
  assert.match(screened.instructions, /privacy policy/i);
  assert.match(screened.llmInstructions, /fixed in the\s+shipped code/);
  assert.deepEqual(screened.settleVerbs, ["cleared", "ask"]);

  // This one escalates to code review, so a swept case asks the SAME question a detected
  // one asks - the check's own `instructions`, never the text the sweep agent was sent.
  const code = manual.find((m) => m.ruleId === "data-exfiltration");
  assert.equal(code.section, "code-review");
  assert.equal(
    code.instructions,
    registry.instructionsFor("data-exfiltration")
  );
  assert.notEqual(
    code.instructions,
    registry.sweepInstruction("data-exfiltration"),
    "the sweep's own text settles nothing"
  );
  assert.equal(code.hint, "<a ping> carries the digest");

  // This one does not escalate at all: it settles its cases as findings, so a swept one is
  // a finding - which the verify phase audits like every other claim.
  assert.equal(
    manual.some((m) => m.ruleId === "cleartext-transmission"),
    false,
    "not a to-do item"
  );
  assert.equal(findings.length, 1);
  const [swept] = findings;
  assert.equal(swept.ruleId, "cleartext-transmission");
  assert.equal(
    swept.severity,
    registry.suggestedVerdict("cleartext-transmission")
  );
  assert.deepEqual([swept.file, swept.loc.line], ["sync.js", 12]);
  assert.equal(swept.hint, "posts over http://");
});

// A result nothing can be done with is a sweep half applied, so it fails the run rather
// than being skipped into silence.
test("a result for a check nobody swept refuses the run", () => {
  // Authors no sweep instruction at all: this review asked nobody to look.
  assert.throws(
    () => merge([result("eval-call", "a.js", 1)]),
    /authors no `sweep-instruction`/
  );
  // Authors one, but this run never asked - the check did not run here.
  assert.throws(
    () => merge([result("disguised-window", "a.js", 1)]),
    /did not ask to be swept/
  );
});

// Deduplication is the linter's, not the reader's: a sweep escalation is passed through
// untouched, so the agent must not be the one deciding that two of its lines are one case.
//
// Asked of BOTH lists, because which one the deterministic pass used depends on whether
// that check escalates - and a sweep naming a location either already holds is naming what
// is already in the review.
test("a location already covered for that check is merged once", () => {
  const twice = merge([
    result("privacy-policy", "a.js", 1),
    result("privacy-policy", "a.js", 1),
  ]);
  assert.equal(twice.applied.length, 1);

  // Already raised by the deterministic pass as a to-do item, at the same locus.
  const already = [
    {
      ruleId: "privacy-policy",
      file: "a.js",
      loc: { line: 1 },
      section: "manual-review",
      extended: true,
    },
  ];
  const again = merge([result("privacy-policy", "a.js", 1)], already);
  assert.deepEqual(again.applied, []);
  assert.equal(again.manual.length, 1, "nothing was added beside it");

  // A different line of the same file is a different case, and is kept.
  const other = merge([result("privacy-policy", "a.js", 2)], already);
  assert.equal(other.applied.length, 1);
  assert.equal(other.manual.length, 2);

  // And already FILED by the deterministic pass, which is what a check with no escalation
  // does with its cases. Without this the sweep would file the finding a second time.
  const filed = [
    { ruleId: "cleartext-transmission", file: "sync.js", loc: { line: 12 } },
  ];
  const dup = merge(
    [result("cleartext-transmission", "sync.js", 12)],
    [],
    filed
  );
  assert.deepEqual(dup.applied, []);
  assert.equal(dup.findings.length, 1, "the one the pass filed, and no second");

  const elsewhere = merge(
    [result("cleartext-transmission", "sync.js", 99)],
    [],
    filed
  );
  assert.equal(elsewhere.applied.length, 1);
  assert.equal(elsewhere.findings.length, 2);
});
