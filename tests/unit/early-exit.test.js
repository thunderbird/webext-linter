// Unit tests for the early exit (src/report/early-exit.js): whether a review stopped, and
// what a stopped review withholds. The registry decides WHICH checks stop one, so these
// run against the shipped registry rather than a fixture - a check losing its
// `review-early-exit` is exactly the regression worth catching.

import { test } from "node:test";
import assert from "node:assert/strict";

import { earlyExitOf, withoutQuestions } from "../../src/report/early-exit.js";
import { earlyExitLines } from "../../src/report/format.js";
import { orderReview } from "../../src/report/order.js";
import { loadRegistry } from "../../src/checks/registry.js";
import { SECTION, SEVERITY } from "../../src/report/finding.js";

const registry = loadRegistry();

/** A finding as the ordered review carries one. */
const finding = (ruleId, severity = SEVERITY.ERROR) => ({
  ruleId,
  severity,
  file: "package.json",
  message: "x",
});

/** The reason TEXTS a review of these findings stops for, or [] when it does not. */
const reasonsFor = (findings, answers = {}) =>
  (
    earlyExitOf(orderReview(findings, []), answers, registry)?.reasons ?? []
  ).map((r) => r.text);

// The case the feature exists for, at its simplest: a high/critical advisory reported
// against the shipped tree settles the submission, and the report says which kind of
// problem stopped it.
test("an error from a blocking check stops the review", () => {
  assert.deepEqual(reasonsFor([finding("vendor-vulnerable")]), [
    "Known security vulnerabilities",
  ]);
});

// The threshold is the SEVERITY and nothing else. vendor-vulnerable is severity:auto, so
// a moderate advisory reaches the report as a warning - worth telling the developer, not
// worth stopping a review over. Restating the band here would be a second threshold to
// keep in step with the one in vuln-findings.js.
test("a warning or info from a blocking check stops nothing", () => {
  assert.deepEqual(
    reasonsFor([finding("vendor-vulnerable", SEVERITY.WARNING)]),
    []
  );
  assert.deepEqual(
    reasonsFor([finding("vendor-vulnerable", SEVERITY.INFO)]),
    []
  );
});

// Blocking is a property of the CHECK, not of the severity. Plenty of checks reject a
// submission without making it dangerous to build or install.
test("an error from a check that does not block stops nothing", () => {
  assert.deepEqual(reasonsFor([finding("eval-call")]), []);
});

// Four checks name one reason, so a submission failing all four is not told the same
// thing four times.
test("several findings for one reason produce one line", () => {
  assert.deepEqual(
    reasonsFor([
      finding("vendor-vulnerable"),
      finding("vendor-vulnerable-dev"),
      finding("vendor-vulnerable-indirect"),
      finding("vendor-vulnerable-indirect-dev"),
    ]),
    ["Known security vulnerabilities"]
  );
});

// Two causes produce two lines - which is why a check names a REASON rather than setting
// a flag - and in the registry's order, never the order the add-on happened to trip them.
test("two reasons produce two lines, in the order the registry authors them", () => {
  const ids = Object.keys(registry.earlyExitProse().reasons);
  const both = [finding("banned-library"), finding("vendor-vulnerable")];
  assert.deepEqual(reasonsFor(both), [
    registry.earlyExitProse().reasons[ids[0]],
    registry.earlyExitProse().reasons[ids[1]],
  ]);
  // The same two the other way round give the same answer.
  assert.deepEqual(reasonsFor([...both].reverse()), reasonsFor(both));
});

// A finding the agent withdrew is not a finding. The review loop asks this again after
// every pass for exactly this reason: a withdrawal puts the question block back.
test("a withdrawn finding stops nothing", () => {
  const findings = [finding("vendor-vulnerable")];
  const ordered = orderReview(findings, []);
  const index = String(ordered[0].index);
  assert.equal(earlyExitOf(ordered, { [index]: "withdrawn" }, registry), null);
  // ...while any other verdict leaves it standing.
  assert.deepEqual(
    earlyExitOf(ordered, { [index]: "reported" }, registry).reasons.map(
      (r) => r.text
    ),
    ["Known security vulnerabilities"]
  );
});

/** A to-do item as the report's manual list carries one. */
const item = (title, { extended, section }) => ({
  title,
  instructions: "do the thing",
  extended,
  section,
});

// What is withheld is every item a REVIEWER would have been asked, and nothing else. The
// code-review items stay: reading code is safe, and what it turns up is the evidence for
// the halt rather than work the halt makes pointless.
test("a stopped review keeps the code-review items and drops the questions", () => {
  const kept = item("Read this code", {
    extended: true,
    section: SECTION.CODE_REVIEW,
  });
  const manual = [
    kept,
    item("Reproduce the build", {
      extended: true,
      section: SECTION.MANUAL_REVIEW,
    }),
    item("Test it in a profile", { extended: false, section: null }),
  ];
  assert.deepEqual(withoutQuestions(orderReview([], manual)), [kept]);
});

// The case the section alone cannot answer: an agent that could not settle a code-review
// case sends it ON to a reviewer, and it keeps the section it was filed under. Nobody is
// asked it under a halt, so leaving it listed would put reviewer work under a closing
// line saying the review was never finished.
test("a case the agent routed to a reviewer is dropped too", () => {
  const punted = item("Agent gave up on this", {
    extended: true,
    section: SECTION.CODE_REVIEW,
  });
  const ordered = orderReview([], [punted]);
  // Filed under code review, so without the route it stays.
  assert.deepEqual(withoutQuestions(ordered), [punted]);
  // Routed onward, it goes - the same answer the phase machine gives.
  const state = { route: { [String(ordered[0].index)]: "ask" } };
  assert.deepEqual(withoutQuestions(ordered, state), []);
});

test("withoutQuestions survives an empty review", () => {
  assert.deepEqual(withoutQuestions([]), []);
});

// A review that ran to the end renders nothing, which is what lets every caller append
// the block unconditionally.
test("a review that did not stop renders no closing block", () => {
  assert.deepEqual(earlyExitLines(null), []);
  assert.deepEqual(earlyExitLines({ intro: "x", reasons: [] }), []);
  // No intro is no sentence: a bullet list under a blank line says nothing.
  assert.deepEqual(
    earlyExitLines({ intro: "", reasons: [{ id: "a", text: "A" }] }),
    []
  );
});

// A person reads the texts. The ids are carried for the JSON report's readers and never
// printed - a wording edit must not change what a machine matches on.
test("the closing block is the intro and one bullet per reason", () => {
  assert.deepEqual(
    earlyExitLines({
      intro: "Stopped because:",
      reasons: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
    }),
    ["", "Stopped because:", "- A", "- B"]
  );
});

// The ids reach the JSON report, where a consumer that auto-rejects can match on
// something a wording edit does not change.
test("each reason carries the id that named it", () => {
  const exit = earlyExitOf(
    orderReview([finding("banned-library")], []),
    {},
    registry
  );
  assert.deepEqual(exit.reasons, [
    { id: "disallowed-library-versions", text: "Disallowed library versions" },
  ]);
});
