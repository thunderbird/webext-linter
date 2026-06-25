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
import obfuscatedCode from "../../src/checks/rules/obfuscated-code.js";
import missingLibrary from "../../src/checks/rules/missing-library.js";

// One long, dense line (no newline): minified by geometry, not by name, so it
// exercises the heuristic rather than the ".min.js" / library-name shortcut.
const MINIFIED = `var data=[${"1,".repeat(700)}1];`;
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
  const flagged = obfuscatedCode.run({ addon }).map((f) => f.file);
  assert.deepEqual(flagged, ["lib/blob.js"]);
});

test("without the pre-step, classifying the reformatted bytes misses it", () => {
  // No addon.bundled: the reader recomputes over the already-pretty bytes, which
  // no longer look minified - the build/lint false negative the pre-step fixes.
  const flagged = obfuscatedCode
    .run({ addon: addonWith({ "lib/blob.js": PRETTY }) })
    .map((f) => f.file);
  assert.deepEqual(flagged, []);
});

test("the classification is memoized: readers share one computation", () => {
  const ctx = { addon: addonWith({ "lib/blob.js": MINIFIED }) };
  assert.strictEqual(classifyAddonJs(ctx), classifyAddonJs(ctx));
});

// A vendored CSS distribution: recognized by its name (.min.css + "bootstrap"
// stem) and a "/*!" banner, exactly like a bundled JS library. >= 1024 bytes so
// it is classified, not skipped.
const LIB_CSS = `/*! Bootstrap v5 */\n${".navbar{display:flex}".repeat(80)}`;
// Minified-by-geometry CSS under a plain name (no .min. / library / banner
// signal): one long, dense line -> minified, but NOT a recognized library.
const MINIFIED_CSS = `.x{color:#fff}${".y{margin:0}".repeat(120)}`;

test("classifyBundled tags an undeclared vendored CSS as a library", () => {
  const file = "vendor/bootstrap/bootstrap.min.css";
  const { classified, nonAuthored } = classifyBundled(
    addonWith({ [file]: LIB_CSS })
  );
  const tag = classified.find((c) => c.file === file);
  assert.equal(tag.library, true);
  assert.equal(tag.obfuscated, false); // obfuscation is a JS-only concept
  assert.ok(nonAuthored.has(file)); // joins the non-authored skip set
});

test("missing-library reports an undeclared vendored CSS file", () => {
  const file = "vendor/bootstrap/bootstrap.min.css";
  const flagged = missingLibrary
    .run({ addon: addonWith({ [file]: LIB_CSS }) })
    .map((f) => f.file);
  assert.deepEqual(flagged, [file]);
});

// A "/*!" license banner is NOT a library signal (it was a weak, fragile proxy -
// it both missed real banners and tripped on a developer's own "/*!"). A bundled
// library is recognized by its .min name / known stem / UMD wrapper / minified
// geometry / VENDOR.md declaration instead; a banner-bearing file with none of
// those is the developer's own code (scanned, not skipped).
test("a /*! banner alone does not classify a file as a library", () => {
  const banner = (file, body) =>
    classifyBundled(addonWith({ [file]: body })).classified.find(
      (c) => c.file === file
    )?.library;
  // Neither a mid-file nor a leading "/*!" makes a plain-named file a library.
  assert.equal(
    banner("css/reports.css", `.mainDiv{color:#fff}\n/*! note */\n`.repeat(60)),
    false
  );
  assert.equal(
    banner("css/app.css", `/*! Bootstrap v5 */\n${".x{a:1}".repeat(200)}`),
    false
  );
  // The strong signals still classify: a .min name (banner or not).
  assert.equal(
    banner("vendor/x.min.css", `/*! lib */\n${".x{a:1}".repeat(200)}`),
    true
  );
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
