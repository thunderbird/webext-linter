// Unit tests for the bundled-JS classification "check memory": classifyBundled
// (the one-shot, addon-keyed pre-step), the build/lint correctness fix (the
// classification is computed before normalize, so a reformatted minified file is
// still caught), and the per-review memoization the readers share.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyBundled,
  classifyAddonJs,
  detectObfuscationAst,
} from "../../src/checks/lib/bundled.js";
import minifiedCode from "../../src/checks/rules/minified-code.js";
import obfuscatedCode from "../../src/checks/rules/obfuscated-code.js";
import missingLibrary from "../../src/checks/rules/missing-library.js";
import { rawSha256 } from "../../src/normalize/hash.js";

// Build a known-library hash map from file keys, so the classifier tags those
// files `library` (a true content-hash match - the library signal, as opposed to a
// name/UMD-shape guess).
const libHashes = (addon, ...keys) =>
  new Map(
    keys.map((k) => [
      rawSha256(addon.files.get(k)),
      { name: "demolib", version: "1.0.0" },
    ])
  );

// One long, dense line (no newline): minified by geometry, not by name, so it
// exercises the heuristic rather than the ".min.js" / library-name shortcut.
const MINIFIED = `var data=[${"1,".repeat(700)}1];`;
// javascript-obfuscator "_0x" identifiers in bulk -> obfuscated, not minified.
const OBFUSCATED =
  "const _0xa1b2=1;\nconst _0xc3d4=2;\nconst _0xe5f6=3;\n" +
  "const _0x7890=4;\nconst _0xabcd=5;\n".repeat(40);
// Readable, multi-line, still >= 1024 bytes so it is classified (not skipped):
// short lines, low density -> NOT minified. This is what prettier would produce.
const PRETTY = "const x = 1;\n".repeat(120);

const addonWith = (files) => ({
  files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
});

test("classifyBundled flags an undeclared minified-by-geometry file", () => {
  const { classified, nonAuthored } = classifyBundled(
    addonWith({ "lib/blob.js": MINIFIED })
  );
  const tag = classified.find((c) => c.file === "lib/blob.js");
  assert.deepEqual(
    [tag.minified, tag.library, tag.obfuscated],
    [true, false, false]
  );
  assert.ok(nonAuthored.has("lib/blob.js"));
});

// scanMinified treats ONLY a minified-by-geometry file (an unidentifiable
// webpack/tsc bundle) as authored: it leaves the non-authored set and minified-code
// goes silent. A hash-identified library is real third-party code (vendored-family),
// so it stays excluded and still drives missing-library regardless of the flag.
// Obfuscated and VENDOR-declared files likewise stay excluded.
test("scanMinified scans a minified non-library, but keeps identified libraries excluded", () => {
  const LIB_JS = `${MINIFIED}\n//jq`; // minified geometry + distinct bytes
  const addon = addonWith({
    "blob.js": MINIFIED, // minified by geometry, not a known library
    "jquery.min.js": LIB_JS, // a known library (hash match below)
    "packed.js": OBFUSCATED, // obfuscated
    "vendor/dep.min.js": MINIFIED, // VENDOR.md-declared (authoritative)
  });
  // VENDOR.md declaration is authoritative, not a heuristic, so it must stay
  // excluded even under scanMinified.
  addon.vendor = { set: new Set(["vendor/dep.min.js"]) };
  const { classified, nonAuthored } = classifyBundled(addon, {
    scanMinified: true,
    libraryHashes: libHashes(addon, "jquery.min.js"),
  });
  const tag = (f) => classified.find((c) => c.file === f);
  // The minified non-library is now authored (scanned), its minified tag cleared.
  assert.equal(tag("blob.js").minified, false);
  assert.ok(!nonAuthored.has("blob.js"));
  // The identified library KEEPS its tag + identity and stays non-authored.
  assert.equal(tag("jquery.min.js").library, true);
  assert.deepEqual(tag("jquery.min.js").libraryId, {
    name: "demolib",
    version: "1.0.0",
  });
  assert.ok(nonAuthored.has("jquery.min.js"));
  // Obfuscated and VENDOR-declared files stay non-authored regardless of the flag.
  assert.equal(tag("packed.js").obfuscated, true);
  assert.ok(nonAuthored.has("packed.js"));
  assert.ok(nonAuthored.has("vendor/dep.min.js"));

  // The bundled checks read the tags: minified-code goes silent, but the identified
  // library still drives missing-library, and obfuscated-code still fires.
  const ctx = { addon: { ...addon, bundled: { classified, nonAuthored } } };
  assert.equal(minifiedCode.run(ctx).length, 0);
  assert.deepEqual(
    missingLibrary.run(ctx).map((f) => f.file),
    ["jquery.min.js"]
  );
  assert.deepEqual(
    obfuscatedCode.run(ctx).map((f) => f.file),
    ["packed.js"]
  );
});

// The obfuscation signal is read off the parsed AST, not raw bytes, so a comment
// or string that merely mentions eval(/Function(/atob(/fromCharCode does not count
// (the byte heuristic's false positive) - only a real call/identifier does.
test("detectObfuscationAst ignores eval/decode tokens in comments and strings", () => {
  // Mentioned only in a comment / a string literal -> NOT obfuscated.
  assert.equal(
    detectObfuscationAst(
      "// once: eval(x), String.fromCharCode(0x41), new Function(c)\nexport const ok = 1;"
    ),
    false
  );
  assert.equal(
    detectObfuscationAst('const help = "use eval( and String.fromCharCode";'),
    false
  );
  // A real eval-of-decoded-string packer, the same sink through a global-object
  // receiver (window.eval / self.atob), and bulk _0x identifiers -> obfuscated.
  assert.equal(detectObfuscationAst('const d = eval(atob("Zm9v"));'), true);
  assert.equal(
    detectObfuscationAst("globalThis.run = window.eval(self.atob(p));"),
    true
  );
  assert.equal(
    detectObfuscationAst(
      "var _0xa1b2=1,_0xc3d4=2,_0xe5f6=3,_0x7890=4,_0xabcd=5;"
    ),
    true
  );
  // An unparseable file is undecidable -> null (caller keeps the byte heuristic).
  assert.equal(detectObfuscationAst("function ("), null);
});

test("classification done before normalize survives reformatting (the fix)", () => {
  const addon = addonWith({ "lib/blob.js": MINIFIED });
  // Pipeline pre-step: classify BEFORE normalize.
  addon.bundled = classifyBundled(addon);
  // Normalize reformats the file in place (build/lint mode).
  addon.files.set("lib/blob.js", Buffer.from(PRETTY));
  // The check reads the pre-step store, so the minified file is still flagged.
  const flagged = minifiedCode.run({ addon }).map((f) => f.file);
  assert.deepEqual(flagged, ["lib/blob.js"]);
});

test("without the pre-step, classifying the reformatted bytes misses it", () => {
  // No addon.bundled: the reader recomputes over the already-pretty bytes, which
  // do not look minified - the build/lint false negative the pre-step fixes.
  const flagged = minifiedCode
    .run({ addon: addonWith({ "lib/blob.js": PRETTY }) })
    .map((f) => f.file);
  assert.deepEqual(flagged, []);
});

test("the classification is memoized: readers share one computation", () => {
  const ctx = { addon: addonWith({ "lib/blob.js": MINIFIED }) };
  assert.strictEqual(classifyAddonJs(ctx), classifyAddonJs(ctx));
});

// A vendored CSS distribution: recognized as a library by a CONTENT-HASH match,
// exactly like a bundled JS library (CSS releases are in the hash DB too). >= 1024
// bytes so it is classified, not skipped.
const LIB_CSS = `/*! Bootstrap v5 */\n${".navbar{display:flex}".repeat(80)}`;
// Minified-by-geometry CSS NOT in the hash DB: one long, dense line -> minified,
// but NOT a recognized library.
const MINIFIED_CSS = `.x{color:#fff}${".y{margin:0}".repeat(120)}`;

test("classifyBundled tags an undeclared vendored CSS as a library", () => {
  const file = "vendor/bootstrap/bootstrap.min.css";
  const addon = addonWith({ [file]: LIB_CSS });
  const { classified, nonAuthored } = classifyBundled(addon, {
    libraryHashes: libHashes(addon, file),
  });
  const tag = classified.find((c) => c.file === file);
  assert.equal(tag.library, true);
  assert.deepEqual(tag.libraryId, { name: "demolib", version: "1.0.0" }); // named
  assert.equal(tag.obfuscated, false); // obfuscation is a JS-only concept
  assert.ok(nonAuthored.has(file)); // joins the non-authored skip set
});

test("missing-library reports an undeclared vendored CSS file", () => {
  const file = "vendor/bootstrap/bootstrap.min.css";
  const addon = addonWith({ [file]: LIB_CSS });
  addon.bundled = classifyBundled(addon, {
    libraryHashes: libHashes(addon, file),
  });
  const findings = missingLibrary.run({ addon });
  assert.deepEqual(
    findings.map((f) => f.file),
    [file]
  );
  assert.equal(findings[0].item, "demolib 1.0.0"); // names the library@version
});

// `library` is a true content-hash match - NOT a .min name, a known stem, a UMD
// wrapper, or a "/*!" banner (none of which are a library signal on their own). The
// same bytes are a library only when their hash is in the known-library DB.
test("library is a content-hash match, not a .min name or banner", () => {
  const tagOf = (file, body, known = false) => {
    const addon = addonWith({ [file]: body });
    return classifyBundled(addon, {
      libraryHashes: known ? libHashes(addon, file) : new Map(),
    }).classified.find((c) => c.file === file)?.library;
  };
  const minCss = `/*! lib */\n${".x{a:1}".repeat(200)}`;
  // A .min name or a banner whose hash is NOT in the DB -> not a library.
  assert.equal(tagOf("vendor/x.min.css", minCss), false);
  assert.equal(
    tagOf("css/app.css", `/*! Bootstrap v5 */\n${".x{a:1}".repeat(200)}`),
    false
  );
  // The same .min file, its hash now in the DB -> a library.
  assert.equal(tagOf("vendor/x.min.css", minCss, true), true);
});

test("a minified-by-geometry CSS is minified but not a library or obfuscated", () => {
  const { classified } = classifyBundled(
    addonWith({ "popup/app.css": MINIFIED_CSS })
  );
  const tag = classified.find((c) => c.file === "popup/app.css");
  assert.deepEqual(
    [tag.minified, tag.library, tag.obfuscated],
    [true, false, false]
  );
});
