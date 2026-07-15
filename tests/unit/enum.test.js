// Unit tests for the guarded enum (src/lib/enum.js): the VERDICT value/container
// split by case, and the invariants that make the type safe. A value is opaque (no
// string form, its name hidden from reflection); comparison is by reference; the two
// cross-case accesses (VERDICT.fail, v.FAIL) throw; and - the load-bearing one - a
// verdict can NEVER be string-compared (`v == "fail"`, String(v), `${v}` all throw),
// so code cannot silently regress to string checks. Also covers the container's
// strictness, the console.log debug rendering, and the wire boundary wireVerdict
// (string -> VERDICT, hostile input -> UNSURE).

import { test } from "node:test";
import assert from "node:assert/strict";
import util from "node:util";

import { VERDICT } from "../../src/lib/enum.js";
import { wireVerdict } from "../../src/llm/schema.js";

// VERDICT.<NAME> hands back the SAME reference every time - that stable identity is
// what makes reference comparison (and `switch`) work.
test("VERDICT.<NAME> is a stable singleton value", () => {
  assert.ok(VERDICT.FAIL === VERDICT.FAIL);
  assert.ok(VERDICT.FAIL !== VERDICT.PASS);
  assert.ok(VERDICT.FAIL); // a value is truthy
});

// A held value tests itself via its LOWERCASE booleans.
test("a value's lowercase booleans report its state", () => {
  const v = VERDICT.PASS;
  assert.equal(v.pass, true);
  assert.equal(v.fail, false);
  assert.equal(VERDICT.SKIPPED.skipped, true);
});

// The casing split: the container is UPPERCASE-keyed, a value lowercase-keyed, so
// every cross-access throws - `if (VERDICT.fail)` is a loud error, not silent-true.
test("cross-case and unknown access throws", () => {
  assert.throws(() => VERDICT.fail, ReferenceError); // container has no lowercase key
  assert.throws(() => VERDICT.PASS.FAIL, ReferenceError); // value has no uppercase accessor
  assert.throws(() => VERDICT.BAD, ReferenceError); // unknown key
  assert.throws(() => VERDICT.FAIL.nope, ReferenceError); // unknown accessor
});

// THE load-bearing invariant: a verdict has no string form, so it can never be
// string-compared or serialized. Every coercion path throws - String(), template,
// JSON, `.state`, and (the subtle one) loose equality. If this regresses, code could
// drift back to `v == "fail"`; this test is the tripwire.
test("a verdict cannot be string-compared or serialized", () => {
  const v = VERDICT.FAIL;
  assert.throws(() => v == "fail", ReferenceError);
  assert.throws(() => String(v), ReferenceError);
  assert.throws(() => `${v}`, ReferenceError);
  assert.throws(() => JSON.stringify(v), ReferenceError);
  assert.throws(() => v.state, ReferenceError);
});

// The value is opaque: its name is unreachable by reflection or spread, so no code
// can extract it. (Its only own property is the non-enumerable inspect hook below.)
test("a value's name is hidden from reflection and spread", () => {
  const v = VERDICT.FAIL;
  assert.deepEqual(Object.getOwnPropertyNames(v), []);
  assert.deepEqual({ ...v }, {});
  assert.equal(Object.getOwnPropertyDescriptor(v, "state"), undefined);
});

// Immutable - the set trap throws on both the value and the container.
test("verdicts are immutable", () => {
  assert.throws(() => (VERDICT.FAIL.fail = true), TypeError);
  assert.throws(() => (VERDICT.FAIL = 1), TypeError);
});

// The container is as strict as the values: it does not leak Object.prototype
// members, so String(VERDICT) / VERDICT.toString throw too (own-property lookup).
test("the container does not leak prototype members", () => {
  assert.throws(() => VERDICT.toString, ReferenceError);
  assert.throws(() => VERDICT.hasOwnProperty, ReferenceError);
  assert.throws(() => String(VERDICT), ReferenceError);
});

// console.log/util.inspect shows a debug rendering via a symbol hook, so a verdict
// is legible in a debugger WITHOUT giving code a string to compare (String()/`==`
// still throw, per the invariant above).
test("console.log renders a debug label", () => {
  assert.equal(util.inspect(VERDICT.FAIL), "<ENUM(verdict) = FAIL>");
  assert.equal(util.inspect(VERDICT.SKIPPED), "<ENUM(verdict) = SKIPPED>");
});

// wireVerdict is the ONE string -> VERDICT boundary (the model's raw JSON string).
// Valid lowercase wire values map to their verdict; anything off-protocol - an
// unknown string, an uppercase spelling, a note-only status, a non-string, or
// absent - defaults to the safe UNSURE. It never throws and never admits a
// note-only status (skipped/info) from the wire.
test("wireVerdict maps wire strings and defaults hostile input to UNSURE", () => {
  assert.equal(wireVerdict("fail"), VERDICT.FAIL);
  assert.equal(wireVerdict("pass"), VERDICT.PASS);
  assert.equal(wireVerdict("unsure"), VERDICT.UNSURE);
  for (const bad of [
    "maybe",
    "FAIL",
    "skipped",
    "info",
    "",
    5,
    null,
    undefined,
    {},
    NaN,
  ]) {
    assert.equal(
      wireVerdict(bad),
      VERDICT.UNSURE,
      `wireVerdict(${util.inspect(bad)})`
    );
  }
});
