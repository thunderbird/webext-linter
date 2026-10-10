// Unit tests for the early exit (src/report/early-exit.js): whether a review was aborted,
// and what an aborted review withholds. The registry decides WHICH checks abort one, so these
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

/** The reason TEXTS a review of these findings is aborted for, or [] when it is not. */
const reasonsFor = (findings, answers = {}) =>
  (
    earlyExitOf(orderReview(findings, []), answers, registry)?.reasons ?? []
  ).map((r) => r.text);

// The case the feature exists for, at its simplest: a high/critical advisory reported
// against the shipped tree settles the submission, and the report says which kind of
// problem aborted it.
test("an error from a blocking check aborts the review", () => {
  assert.deepEqual(reasonsFor([finding("vendor-vulnerable")]), [
    "Known security vulnerabilities",
  ]);
});

// The threshold is the SEVERITY and nothing else. vendor-vulnerable is severity:auto, so
// a moderate advisory reaches the report as a warning - worth telling the developer, not
// worth aborting a review over. Restating the band here would be a second threshold to
// keep in step with the one in vuln-findings.js.
test("a warning or info from a blocking check aborts nothing", () => {
  assert.deepEqual(
    reasonsFor([finding("vendor-vulnerable", SEVERITY.WARNING)]),
    []
  );
  assert.deepEqual(
    reasonsFor([finding("vendor-vulnerable", SEVERITY.INFO)]),
    []
  );
});

// The threshold reads a SETTLED band, which is why the run's own policy reaches it without
// this file knowing about the flag: under --warnings-as-errors the same moderate advisory
// is published as an error (src/checks/registry.js bandUnder), and an error from a blocking
// check is what aborts a review. Under that policy the submission is rejected, so not asking
// a reviewer to reproduce its build is the whole point of aborting.
//
// Three checks can reach here this way, and only three: no check declared `warning` may
// declare `review-early-exit` at all (assertEarlyExit refuses it), so the ones that do are
// the severity:auto pair plus banned-library, whose band is their own.
test("--warnings-as-errors makes a moderate advisory abort the review", () => {
  const strict = registry.withPolicy({ warningsAsErrors: true });
  const moderate = finding("vendor-vulnerable", SEVERITY.WARNING);
  // The band the check publishes it at under this policy - the value runOneCheck stamps.
  moderate.severity = strict.bandOf(moderate.severity);
  assert.deepEqual(
    (earlyExitOf(orderReview([moderate], []), {}, strict)?.reasons ?? []).map(
      (r) => r.text
    ),
    ["Known security vulnerabilities"]
  );
});

// Blocking is a property of the CHECK, not of the severity. Plenty of checks reject a
// submission without making it dangerous to build or install.
test("an error from a check that does not block aborts nothing", () => {
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
  const { reasons } = registry.earlyExitProse();
  const ids = Object.keys(reasons);
  assert.ok(
    ids.indexOf("known-vulnerabilities") <
      ids.indexOf("disallowed-library-versions")
  );
  const both = [finding("banned-library"), finding("vendor-vulnerable")];
  assert.deepEqual(reasonsFor(both), [
    reasons["known-vulnerabilities"],
    reasons["disallowed-library-versions"],
  ]);
  // The same two the other way round give the same answer.
  assert.deepEqual(reasonsFor([...both].reverse()), reasonsFor(both));
});

// A finding that aborts the review is never put to anyone to verify - an aborted review
// hands out no such phase - so what decides it is the band it was reported at, and only
// that: no recorded answer takes it back.
test("a finding aborts the review at the band it was reported at", () => {
  const findings = [finding("vendor-vulnerable")];
  const ordered = orderReview(findings, []);
  const index = String(ordered[0].index);
  for (const answers of [{}, { [index]: "withdrawn" }]) {
    assert.deepEqual(
      earlyExitOf(ordered, answers, registry).reasons.map((r) => r.text),
      ["Known security vulnerabilities"]
    );
  }
});

// An ESCALATING check aborts a review too, but only from the far side of a verdict: it
// reports nothing itself, so its case weighs nothing until someone has judged it. This is
// build-lifecycle-hook, which raises an install hook for a reviewer to read - a hook that
// only runs local build steps settles nothing, and one that fetches code aborts the review
// before anyone is asked to install it.
test("an escalated case aborts the review once it is reported, and not before", () => {
  const todo = [
    {
      ruleId: "build-lifecycle-hook",
      title: "Build install hook",
      instructions: "read the command",
      section: SECTION.CODE_REVIEW,
      file: "package.json",
    },
  ];
  const ordered = orderReview([], todo);
  const index = String(ordered[0].index);
  // Nobody has judged it: a plain review with no agent in it aborts nothing.
  assert.equal(earlyExitOf(ordered, {}, registry), null);
  assert.equal(earlyExitOf(ordered, { [index]: "cleared" }, registry), null);
  assert.deepEqual(
    earlyExitOf(ordered, { [index]: "reported" }, registry).reasons.map(
      (r) => r.text
    ),
    ["Build process issues"]
  );
});

// A build question is escalated like any case, so it weighs nothing until a reviewer has
// answered it - a review with nobody to ask aborts on nothing - and a "no" aborts it.
test("a build question aborts the review once it is reported, and not before", () => {
  for (const ruleId of ["build-succeeds", "build-reproduces-xpi"]) {
    const ordered = orderReview(
      [],
      [
        {
          ruleId,
          title: ruleId,
          instructions: "did it",
          section: SECTION.MANUAL_REVIEW,
          extended: true,
          file: null,
        },
      ]
    );
    const index = String(ordered[0].index);
    assert.equal(earlyExitOf(ordered, {}, registry), null, ruleId);
    assert.equal(
      earlyExitOf(ordered, { [index]: "cleared" }, registry),
      null,
      ruleId
    );
    assert.deepEqual(
      earlyExitOf(ordered, { [index]: "reported" }, registry).reasons.map(
        (r) => r.text
      ),
      ["Build process issues"],
      ruleId
    );
  }
});

// The verb alone is not the trigger. Every to-do item in a review is answered, and all but
// a handful of checks name no reason at all - reporting one of those is ordinary review
// work, not a submission that settles itself.
test("a reported to-do aborts nothing when its check names no reason", () => {
  const ordered = orderReview(
    [],
    [
      {
        ruleId: "experiment-manual-review",
        title: "Experiment",
        instructions: "read it",
        section: SECTION.CODE_REVIEW,
        file: "manifest.json",
      },
    ]
  );
  const index = String(ordered[0].index);
  assert.equal(earlyExitOf(ordered, { [index]: "reported" }, registry), null);
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
test("an aborted review keeps the code-review items and drops the questions", () => {
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
  // Routed onward, it goes - the case carries where it is asked, which is what the phase
  // machine reads too.
  punted.askedIn = "ask";
  assert.deepEqual(withoutQuestions(ordered), []);
});

test("withoutQuestions survives an empty review", () => {
  assert.deepEqual(withoutQuestions([]), []);
});

// A review that ran to the end renders nothing, which is what lets every caller append
// the block unconditionally.
test("a review that was not aborted renders no closing block", () => {
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
      intro: "Aborted because:",
      reasons: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
    }),
    ["", "Aborted because:", "- A", "- B"]
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
