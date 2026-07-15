// Unit tests for the obfuscation seam (src/lib/obfuscation.js): obfuscationVerdict is
// FAIL only for the AST STRUCTURE of a recognized STRONG obfuscator family; PASS for
// readable code, plain-minified-but-clean code, and unparseable input; and UNSURE for a
// weak-family-only match (a structure ordinary readable code also has, so it is deferred
// to the obfuscated-code check's LLM/manual adjudication rather than decided outright).
// The family mechanics are private to the module - only the verdict is observable. This
// is the property that keeps legitimate libraries (readable pdf.js, minified JSZip) and
// module-pattern first-party code from being mislabeled: obfuscation is recognized by
// structure, not token presence, and only by structures readable code cannot have.

import { test } from "node:test";
import assert from "node:assert/strict";

import { obfuscationVerdict } from "../../src/lib/obfuscation.js";

// A string array dereferenced through an accessor - the array_replacements STRONG family.
const ARRAY_REPLACEMENT =
  `var _0xarr = [${Array.from({ length: 40 }, (_, i) => `"s${i}"`).join(", ")}];\n` +
  "function _0xget(i) { return _0xarr[i]; }\n" +
  Array.from({ length: 20 }, (_, i) => `console["log"](_0xget(${i}));`).join(
    "\n"
  );

// An obfuscator.io-style rotated string array - a STRONG family.
const OBFUSCATOR_IO =
  "var _0x12=['\\x68\\x69','\\x62\\x79\\x65','\\x6c\\x6f\\x67'];" +
  "(function(a,b){var c=function(d){while(--d){a['push'](a['shift']());}};c(++b);}(_0x12,0x1));" +
  "var _0x34=function(a){return _0x12[a-0x0];};" +
  "console[_0x34(0x2)](_0x34(0x0));console[_0x34(0x2)](_0x34(0x1));";

// Readable, meaningful names - no obfuscator structure.
const READABLE =
  "export function add(a, b) {\n  return a + b;\n}\n".repeat(30) +
  "const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];\n" +
  "export function weekday(i) { return days[i % days.length]; }\n";

// Dense one-liner: minified by geometry, no obfuscator structure (minified-code's job).
const MINIFIED_CLEAN = `var s=0;${"s=s+1;".repeat(250)}`;

// The revealing module pattern - an IIFE-initialized const referenced only as a
// member-expression object - which structurally matches the WEAK
// function_to_array_replacements family (the detector applies no density guards there).
const MODULE_PATTERN =
  "const NCEmailSignature = (() => {\n" +
  "  function normalizeEmail(value) {\n" +
  '    const email = String(value || "").trim().toLowerCase();\n' +
  '    return email.includes("@") ? email : "";\n' +
  "  }\n" +
  "  function init() {\n" +
  "    return normalizeEmail('user@example.com');\n" +
  "  }\n" +
  "  return { init };\n" +
  "})();\n" +
  "NCEmailSignature.init();\n";

test("a strong array-replacement match is FAIL", () => {
  assert.ok(obfuscationVerdict(ARRAY_REPLACEMENT).fail);
});

test("a strong obfuscator.io-style match is FAIL", () => {
  assert.ok(obfuscationVerdict(OBFUSCATOR_IO).fail);
});

test("readable code is PASS (not obfuscated)", () => {
  assert.ok(obfuscationVerdict(READABLE).pass);
});

test("plain-minified-but-clean code is PASS (that is minified-code's job)", () => {
  assert.ok(obfuscationVerdict(MINIFIED_CLEAN).pass);
});

test("unparseable input is PASS, not obfuscated (the catch path)", () => {
  assert.ok(obfuscationVerdict("function (").pass);
});

// A weak-family-only match is not decided outright: it is the UNSURE verdict, deferred to
// the obfuscated-code check's LLM/manual adjudication - never a FAIL on its own.
test("a weak-family-only match (the revealing module) is UNSURE", () => {
  assert.ok(obfuscationVerdict(MODULE_PATTERN).unsure);
});

// A strong family present alongside the weak one still decides: FAIL, not UNSURE.
test("a strong family alongside the weak one is FAIL", () => {
  assert.ok(obfuscationVerdict(`${MODULE_PATTERN}\n${ARRAY_REPLACEMENT}`).fail);
});
