// Unit tests for the obfuscation seam (src/lib/obfuscation.js): isObfuscated
// returns true only for the AST STRUCTURE of a recognized obfuscator family, and false
// for readable code, plain-minified-but-clean code, and unparseable input. This is the
// property that keeps legitimate libraries (readable pdf.js, minified JSZip) from being
// mislabeled - obfuscation is recognized by structure, not by token presence.

import { test } from "node:test";
import assert from "node:assert/strict";

import { isObfuscated } from "../../src/lib/obfuscation.js";

test("recognizes array-replacement obfuscation (string array via an accessor)", () => {
  const obf =
    `var _0xarr = [${Array.from({ length: 40 }, (_, i) => `"s${i}"`).join(", ")}];\n` +
    "function _0xget(i) { return _0xarr[i]; }\n" +
    Array.from({ length: 20 }, (_, i) => `console["log"](_0xget(${i}));`).join(
      "\n"
    );
  assert.equal(isObfuscated(obf), true);
});

test("recognizes an obfuscator.io-style rotated string array", () => {
  const obf =
    "var _0x12=['\\x68\\x69','\\x62\\x79\\x65','\\x6c\\x6f\\x67'];" +
    "(function(a,b){var c=function(d){while(--d){a['push'](a['shift']());}};c(++b);}(_0x12,0x1));" +
    "var _0x34=function(a){return _0x12[a-0x0];};" +
    "console[_0x34(0x2)](_0x34(0x0));console[_0x34(0x2)](_0x34(0x1));";
  assert.equal(isObfuscated(obf), true);
});

test("readable code is not obfuscated", () => {
  const readable =
    "export function add(a, b) {\n  return a + b;\n}\n".repeat(30) +
    "const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];\n" +
    "export function weekday(i) { return days[i % days.length]; }\n";
  assert.equal(isObfuscated(readable), false);
});

test("plain-minified but clean code is not obfuscated (that is minified-code's job)", () => {
  // Dense one-liner, no obfuscator structure: minified geometry, not obfuscation.
  const minified = `var data=[${"1,".repeat(700)}1];function sum(a){return a.reduce((x,y)=>x+y,0);}sum(data);`;
  assert.equal(isObfuscated(minified), false);
});

test("unparseable input is not reported as obfuscated (the catch path)", () => {
  assert.equal(isObfuscated("function ("), false);
});
