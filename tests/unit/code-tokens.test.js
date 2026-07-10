// Unit tests for the code-text atom scanner (scanCodeText): the identifier /
// string / template / regex text of a source, joined - and NOT its comments, so
// a token-presence test sees code the same way the AST-based scanners do.

import { test } from "node:test";
import assert from "node:assert/strict";

import { scanCodeText } from "../../src/parse/code-tokens.js";

test("collects identifiers, strings, template text and regex; never comments", () => {
  const code = [
    "// executeScript in a line comment must not appear",
    "/* insertCSS in a block comment must not appear */",
    "const cookieStoreId = obj['getComposeDetails'];",
    "const t = `folder ${x}`;",
    "const re = /displayedFolder/;",
    "messenger.tabs.query({ url });",
  ].join("\n");
  const { text } = scanCodeText(code);
  // Code atoms are present...
  for (const atom of [
    "cookieStoreId",
    "getComposeDetails", // a computed string key
    "folder", // template text
    "displayedFolder", // regex pattern
    "query",
    "url",
  ]) {
    assert.ok(text.includes(atom), atom);
  }
  // ...but comment text is not (the whole point).
  assert.ok(!text.includes("executeScript"));
  assert.ok(!text.includes("insertCSS"));
  assert.ok(!text.includes("must not appear"));
});

// A token that lives ONLY in a string literal still counts (dynamic access like
// obj["executeScript"] spells the API name in a string).
test("a token only in a string literal is present", () => {
  const { text } = scanCodeText('const m = api["executeScript"];');
  assert.ok(text.includes("executeScript"));
});

// A fatal parse yields empty text (the caller treats an unparsable authored
// source as blind via the apiUsage.parseError guard, so it never relies on this).
test("a fatal parse yields empty text without throwing", () => {
  const { text, parseError } = scanCodeText("const = // not js");
  assert.equal(text, "");
  assert.ok(parseError);
});

// Reuses a supplied parse instead of re-parsing.
test("reuses a provided ParseResult", () => {
  const parsed = { ast: null, parseError: "boom" };
  assert.deepEqual(scanCodeText("whatever", parsed), {
    text: "",
    parseError: "boom",
  });
});
