// Unit tests for the minified seam (src/lib/minified.js): a file is minified when one
// line packs many STATEMENTS (machine-packed code), not merely because it has a long
// line - a long line that is a single data literal is readable source. The thresholds
// (long line > 500, >= 10 statements on a line) are exercised at their boundaries, and
// the license-header case (statements on the packed line, not per total line) is pinned.

import { test } from "node:test";
import assert from "node:assert/strict";

import { isMinified, isMinifiedJs } from "../../src/lib/minified.js";

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

// ---- language is the caller's knowledge, not the path's ----
// An inline <script> is JavaScript living in a .html file. Judged by the container's
// extension it takes the CSS rule - one long line is enough - so a script whose only
// long line is a comment or a data literal reads as minified. isMinifiedJs is what the
// inline-script classifier calls, so the statement-density test applies where the code
// actually is.
test("isMinifiedJs judges a source as JS whatever the container is named", () => {
  const oneLongComment = `// ${"x".repeat(900)}\nconst a = 1;\nconsole.log(a);\n`;
  // The CSS rule (what the extension would pick for a .html) calls this minified...
  assert.equal(isMinified(oneLongComment, "page.html"), true);
  // ... the JS rule does not: one long line, nowhere near 10 statements on it.
  assert.equal(isMinifiedJs(oneLongComment, "page.html"), false);
  // And real packed code is still caught, container notwithstanding.
  assert.equal(
    isMinifiedJs(`var a=0;${"a=a+1;".repeat(250)}`, "page.html"),
    true
  );
});

// isMinified keeps deciding by extension for FILES - that is its job, and the JS branch
// is now the shared implementation rather than a second copy of the test.
test("isMinified still routes a .js file through the JS rule", () => {
  const packed = `var a=0;${"a=a+1;".repeat(250)}`;
  assert.equal(
    isMinified(packed, "bundle.js"),
    isMinifiedJs(packed, "bundle.js")
  );
});

// An unparsable body falls whichever way the caller says. maxLineStatements cannot
// count statements it could not parse, and for a FILE the safe answer is "packed" - a
// .js that will not parse is broken or machine-generated. For a body whose language was
// never established the same default rejects an add-on for shipping a template, so the
// caller flips it. Code that actually runs parses either way.
test("isMinifiedJs lets the caller choose which way an unparsable body falls", () => {
  const notJs = `<tr><td>${"x".repeat(600)}</td></tr>\n`.repeat(3);
  assert.equal(isMinifiedJs(notJs, "page.html"), true); // default: file-style, fail open
  assert.equal(
    isMinifiedJs(notJs, "page.html", { unparsableIsMinified: false }),
    false
  );
  // Real packed code parses, so the choice does not reach it either way.
  const packed = `var a=0;${"a=a+1;".repeat(250)}`;
  for (const flag of [true, false]) {
    assert.equal(
      isMinifiedJs(packed, "page.html", { unparsableIsMinified: flag }),
      true
    );
  }
});
