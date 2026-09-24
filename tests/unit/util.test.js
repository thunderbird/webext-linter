// Unit tests for small shared helpers: src/lib/util.js and src/util/files.js.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseVersion,
  cmpVersion,
  utf8ComparisonSigns,
} from "../../src/lib/util.js";
import { extname, basename } from "../../src/util/files.js";

// Version parsing: numeric tuples per component, leading non-digits dropped, and
// null for nothing-numeric or the "≤"/"<"-prefixed pre-WebExtension marker.
test("parseVersion reads numeric component tuples", () => {
  assert.deepEqual(parseVersion("115.0"), [115, 0]);
  assert.deepEqual(parseVersion("140.4.1"), [140, 4, 1]);
  assert.deepEqual(parseVersion(" 154 "), [154]);
  assert.deepEqual(parseVersion("0a1"), [0]);
  assert.equal(parseVersion("≤59"), null);
  assert.equal(parseVersion("<60"), null);
  assert.equal(parseVersion("abc"), null);
  assert.equal(parseVersion(undefined), null);
});

// Component-wise compare, missing components treated as 0.
test("cmpVersion compares component-wise", () => {
  assert.equal(cmpVersion([154], [154, 0]), 0);
  assert.equal(cmpVersion([153, 9], [154]), -1);
  assert.equal(cmpVersion([200], [154]), 1);
  assert.equal(cmpVersion([140, 4, 1], [140, 4]), 1);
});

// The two-character replacements must run before the single-character ones, or "<="
// would become "＜=" instead of "≤" - the exact math symbol, not a lookalike.
test("utf8ComparisonSigns turns <=/>= into the exact math symbols first", () => {
  assert.equal(utf8ComparisonSigns("<=4.17.0"), "≤4.17.0");
  assert.equal(utf8ComparisonSigns(">=4.17.0"), "≥4.17.0");
  assert.equal(utf8ComparisonSigns(">=4.17.0 <5.0.0"), "≥4.17.0 ＜5.0.0");
});

// Whatever bare < or > remains (not part of <=/>=) becomes its fullwidth lookalike -
// still not the literal character a renderer would act on.
test("utf8ComparisonSigns turns a bare < or > into its fullwidth lookalike", () => {
  assert.equal(utf8ComparisonSigns("<5.0.0"), "＜5.0.0");
  assert.equal(utf8ComparisonSigns(">5.0.0"), "＞5.0.0");
  assert.equal(utf8ComparisonSigns("<script>"), "＜script＞");
});

test("utf8ComparisonSigns replaces every occurrence, and leaves other text alone", () => {
  assert.equal(utf8ComparisonSigns("<1.0.0 || <2.0.0"), "＜1.0.0 || ＜2.0.0");
  assert.equal(utf8ComparisonSigns("lodash (^4.17.21)"), "lodash (^4.17.21)");
  assert.equal(utf8ComparisonSigns(""), "");
});

// Only a file carries an extension, so the dot that names one has to be in the
// BASENAME. A versioned vendor directory (lib/jquery-3.6.0/LICENSE) holds a dot of
// its own, and lending it to the file would make an extensionless LICENSE look like
// it had an extension no rule can recognise - and cost it the documentation
// exemption that keeps a shipped licence out of the unused-files report. A leading
// dot still reads as an extension (.DS_Store), which is how junk is matched.
test("extname reads the extension from the basename, not the path", () => {
  assert.equal(extname("lib/jquery-3.6.0/LICENSE"), "");
  assert.equal(extname("vendor/pdf-lib-1.17.1/LICENSE"), "");
  assert.equal(extname("x/y.z/Dockerfile"), "");
  assert.equal(extname("assets/i18n.v2/messages"), "");
  // A real extension is still read, dotted directory or not.
  assert.equal(extname("lib/v1.2/script.js"), ".js");
  assert.equal(extname("README.de.md"), ".md");
  assert.equal(extname("icons/16x16/icon.png"), ".png");
  assert.equal(extname("LICENSE"), "");
  assert.equal(extname(".DS_Store"), ".ds_store");
  assert.equal(basename("lib/jquery-3.6.0/LICENSE"), "LICENSE");
});
