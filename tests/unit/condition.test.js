// Unit tests for the step condition language (src/checks/condition.js): parsing AND / OR /
// NOT with parentheses and value(phase, id), the names and calls a condition reads, evaluating it against the facts true
// now, and refusing anything else with where it went wrong.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  callsOf,
  holds,
  namesOf,
  parseCondition,
} from "../../src/checks/condition.js";

const evaluate = (text, facts) => holds(parseCondition(text), new Set(facts));

// NOT binds tightest, then AND, then OR - the order the conditions in the registry are
// written to be read in, so `a OR b AND c` needs no parentheses to mean a OR (b AND c).
test("NOT binds tightest, then AND, then OR", () => {
  assert.deepEqual(parseCondition("a OR b AND c"), {
    or: [{ name: "a" }, { and: [{ name: "b" }, { name: "c" }] }],
  });
  assert.deepEqual(parseCondition("NOT a AND b"), {
    and: [{ not: { name: "a" } }, { name: "b" }],
  });
  assert.deepEqual(parseCondition("(a OR b) AND c"), {
    and: [{ or: [{ name: "a" }, { name: "b" }] }, { name: "c" }],
  });
  assert.deepEqual(parseCondition("NOT NOT a"), {
    not: { not: { name: "a" } },
  });
});

test("a condition holds over the facts true now", () => {
  const mixed = "NOT aborted AND (sca OR NOT llm-skip-manual)";
  assert.equal(evaluate(mixed, []), true);
  assert.equal(evaluate(mixed, ["llm-skip-manual"]), false);
  assert.equal(evaluate(mixed, ["llm-skip-manual", "sca"]), true);
  assert.equal(evaluate(mixed, ["aborted", "sca"]), false);
  assert.equal(evaluate("a OR b AND c", ["b"]), false);
  assert.equal(evaluate("a OR b AND c", ["b", "c"]), true);
  assert.equal(evaluate("NOT NOT a", ["a"]), true);
});

test("namesOf lists every name a condition reads, once", () => {
  assert.deepEqual(namesOf(parseCondition("a AND (NOT b OR a) AND c")), [
    "a",
    "b",
    "c",
  ]);
});

// Every refusal says what was expected and where (1-based), so a drafting error in the
// registry is found where it was made rather than as a step printed in the wrong runs.
test("anything outside the grammar is refused with where it went wrong", () => {
  for (const [text, refusal] of [
    ["", /expected a name at the end/],
    ["a AND", /expected a name at the end/],
    ["AND a", /expected a name at 1, found "AND"/],
    ["(a", /expected "\)" at the end/],
    ["a)", /unexpected "\)" at 2/],
    ["a b", /unexpected "b" at 3/],
    ["a and b", /unexpected "and" at 3/],
    ["a & b", /unexpected "&" at 3/],
    ["Sca", /expected a name at 1, found "Sca"/],
    ["()", /expected a name at 2, found "\)"/],
  ]) {
    assert.throws(() => parseCondition(text), refusal, JSON.stringify(text));
  }
});

// value(phase, id) reads a process value: it holds once that phase returned that id, and it
// mixes with the facts like any name. Its arguments are not facts, so namesOf leaves them
// out and callsOf names them for the registry to check.
test("value(phase, id) holds once the phase returned that id", () => {
  const text =
    "sca AND NOT aborted AND (value(choice, llm) OR value(unsafe, llm))";
  const tree = parseCondition(text);
  assert.deepEqual(namesOf(tree), ["sca", "aborted"]);
  assert.deepEqual(callsOf(tree), [
    { call: "value", args: ["choice", "llm"] },
    { call: "value", args: ["unsafe", "llm"] },
  ]);
  const sca = new Set(["sca"]);
  assert.equal(holds(tree, sca, { unsafe: "llm" }), true);
  assert.equal(holds(tree, sca, { choice: "user" }), false);
  assert.equal(holds(tree, sca), false, "no value returned yet");
  assert.equal(
    holds(tree, new Set(["sca", "aborted"]), { choice: "llm" }),
    false
  );
  assert.equal(
    holds(parseCondition("NOT value(safety, safe)"), new Set(), {}),
    true
  );
});

test("a call outside the grammar is refused with where it went wrong", () => {
  for (const [text, refusal] of [
    ["value(a)", /value\(\) takes two names, given 1/],
    ["value(a, b, c)", /value\(\) takes two names, given 3/],
    ["issued(a, b)", /"issued" is not a function at 7/],
    ["value(a, b", /expected "\)" at the end/],
    ["value(A, b)", /expected a name at 7/],
    ["value(a,, b)", /expected a name at 9/],
    ["a, b", /unexpected "," at 2/],
  ]) {
    assert.throws(() => parseCondition(text), refusal, JSON.stringify(text));
  }
});
