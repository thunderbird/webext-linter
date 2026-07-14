// Unit tests for the minified seam (src/lib/minified.js): a file is minified when one
// line packs many STATEMENTS (machine-packed code), not merely because it has a long
// line - a long line that is a single data literal is readable source. The thresholds
// (long line > 500, >= 10 statements on a line) are exercised at their boundaries, and
// the license-header case (statements on the packed line, not per total line) is pinned.

import { test } from "node:test";
import assert from "node:assert/strict";

import { isMinified } from "../../src/lib/minified.js";

test("packed code (many statements on one line) is minified", () => {
  assert.equal(
    isMinified(`var a=0;${"a=a+1;".repeat(250)}`, "bundle.js"),
    true
  );
});

test("a long line that is a single data literal is NOT minified", () => {
  // A big array, an inline data: URI, and an i18n string table: all one expression.
  const array = `var data=[${"1,".repeat(700)}1];`;
  const dataUri = `var ICON="data:image/png;base64,${"A".repeat(2000)}";`;
  const i18n = `export const W=["${Array.from({ length: 300 }, (_, i) => `w${i}`).join('","')}"];`;
  for (const src of [array, dataUri, i18n]) {
    assert.equal(isMinified(src, "x.js"), false, src.slice(0, 40));
  }
});

test("no long line -> not minified, whatever the density", () => {
  // Readable code: one statement per line, short lines.
  assert.equal(isMinified("const a = 1;\n".repeat(200), "x.js"), false);
});

test("a preserved license header does not dilute the packed line", () => {
  // 12 comment lines + one packed code line: statements-per-TOTAL-line would be ~1, but
  // the packed line itself carries them. This is the imurmurhash.min shape.
  const license = "/**\n" + " * preserve\n".repeat(11) + " */\n";
  const packed = `var a=0;${"a=a+1;".repeat(100)}`;
  assert.equal(isMinified(license + packed, "lib.min.js"), true);
});

test("unparseable long-lined source fails open to minified", () => {
  // Past the long-line gate but not valid JS: kept minified rather than waved through.
  assert.equal(isMinified("var x = {{{{" + "a".repeat(600), "broken.js"), true);
});

test("CSS: packed rules are minified; a single data: font payload is not", () => {
  const packedRules = `.x{color:#fff}${".y{margin:0}".repeat(120)}`;
  const dataFont = `@font-face{src:url("data:font/woff2;base64,${"A".repeat(2000)}")}\n.a{color:red}`;
  assert.equal(isMinified(packedRules, "app.css"), true);
  assert.equal(isMinified(dataFont, "fonts.css"), false);
});
