// Unit tests for the code-text atom scanner (scanCodeText): the identifier /
// string / template / regex text of a source, each with its line - and NOT its
// comments, so a token scan sees code the same way the AST-based scanners do.

import { test } from "node:test";
import assert from "node:assert/strict";

import { scanCodeText } from "../../src/parse/code-tokens.js";

const values = (code, lineOffset, parsed) =>
  scanCodeText(code, lineOffset, parsed).atoms.map((a) => a.value);

test("collects identifiers, strings, template text and regex; never comments", () => {
  const code = [
    "// executeScript in a line comment must not appear",
    "/* insertCSS in a block comment must not appear */",
    "const cookieStoreId = obj['getComposeDetails'];",
    "const t = `folder ${x}`;",
    "const re = /displayedFolder/;",
    "messenger.tabs.query({ url });",
  ].join("\n");
  const atoms = values(code);
  // Code atoms are present...
  for (const atom of [
    "cookieStoreId",
    "getComposeDetails", // a computed string key
    "folder ", // template text (cooked, with its trailing space)
    "displayedFolder", // regex pattern
    "query",
    "url",
  ]) {
    assert.ok(atoms.includes(atom), atom);
  }
  // ...but comment text is not (the whole point).
  const joined = atoms.join("\n");
  assert.ok(!joined.includes("executeScript"));
  assert.ok(!joined.includes("insertCSS"));
  assert.ok(!joined.includes("must not appear"));
});

// A token that lives ONLY in a string literal still counts (dynamic access like
// obj["executeScript"] spells the API name in a string).
test("a token only in a string literal is present", () => {
  assert.ok(
    values('const m = api["executeScript"];').includes("executeScript")
  );
});

// A fatal parse yields no atoms (the caller treats an unparsable authored source
// as blind via the apiUsage.parseError guard, so it never relies on this).
test("a fatal parse yields no atoms without throwing", () => {
  const { atoms, parseError } = scanCodeText("const = // not js");
  assert.deepEqual(atoms, []);
  assert.ok(parseError);
});

// Reuses a supplied parse instead of re-parsing.
test("reuses a provided ParseResult", () => {
  const parsed = { ast: null, parseError: "boom" };
  assert.deepEqual(scanCodeText("whatever", 0, parsed), {
    atoms: [],
    parseError: "boom",
  });
});

// Each atom carries its 1-based source line, with lineOffset applied - so the
// recheck can point the model at a token's real location.
test("atoms carry their source line (lineOffset applied)", () => {
  const code = ["const a = 1;", "messenger.tabs.executeScript(t);"].join("\n");
  const { atoms } = scanCodeText(code, 10);
  const exec = atoms.find((x) => x.value === "executeScript");
  assert.ok(exec);
  assert.equal(exec.line, 12); // line 2 in the source + offset 10
});
