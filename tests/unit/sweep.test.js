// Unit tests for --llm-sweep-results: taking what a sweep found and routing each result
// to the section its check's cases go to. The agent that swept classifies nothing, so
// every guard here exists because a result routed by anything other than the check's own
// `escalation` would land a case in front of whoever cannot settle it - which is the
// defect this path was built to end.

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

function merge(results, manual = []) {
  return mergeSweepResults({
    results,
    manual,
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

// The whole point of this file. `escalation: manual-review` says the check's cases cannot
// be settled from the package, so a swept one cannot be either: it goes to the reviewer.
// Everything else is settled by reading the add-on, which is what Extended Code Review is.
test("a result goes where its check's own cases go", () => {
  const { manual, applied } = merge([
    result("privacy-policy", "providers/Gravatar.js", 23, "gravatar.com"),
    result("data-exfiltration", "bg.js", 40, "<a ping> carries the digest"),
  ]);
  assert.deepEqual(applied, [
    "privacy-policy (providers/Gravatar.js:23) -> question",
    "data-exfiltration (bg.js:40) -> code review",
  ]);

  const question = manual.find((m) => m.ruleId === "privacy-policy");
  assert.equal(question.section, "manual-review");
  assert.equal(question.extended, true);
  assert.deepEqual(
    [question.file, question.loc.line],
    ["providers/Gravatar.js", 23]
  );
  // The question's wording is the check's, filled by renderManualItems - not the sweep's.
  assert.match(question.instructions, /privacy policy/i);

  const code = manual.find((m) => m.ruleId === "data-exfiltration");
  assert.equal(code.section, "code-review");
  // A check that files findings authors no `instructions`, so the instruction is its own
  // `sweep-instruction`: the text the agent was sent after says what confirming it means.
  assert.equal(
    code.instructions,
    registry.sweepInstruction("data-exfiltration")
  );
  // The band a reported case lands in is the registry's, never the sweep's.
  assert.equal(code.verdict, registry.suggestedVerdict("data-exfiltration"));
  assert.equal(code.hint, "<a ping> carries the digest");
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
test("a location already listed for that check is merged once", () => {
  const twice = merge([
    result("privacy-policy", "a.js", 1),
    result("privacy-policy", "a.js", 1),
  ]);
  assert.equal(twice.applied.length, 1);

  // Already raised by the deterministic pass, at the same locus.
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
});
