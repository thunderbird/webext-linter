// Unit tests for the bundled-JS classification "check memory": classifyBundled
// (the one-shot, addon-keyed pre-step), the build/lint correctness fix (the
// classification is computed before normalize, so a reformatted minified file is
// still caught), and the per-review memoization the readers share.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyBundled,
  classifyAddonJs,
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
// A real array-replacement obfuscation: a string array dereferenced through an accessor,
// the AST structure obfuscation-detector recognizes. Multi-line and low-density, so it is
// obfuscated but NOT minified-by-geometry. >= 1024 bytes so it is classified, not skipped.
const OBFUSCATED =
  `var _0xarr = [${Array.from({ length: 60 }, (_, i) => `"item_${i}"`).join(", ")}];\n` +
  "function _0xget(i) { return _0xarr[i]; }\n" +
  Array.from({ length: 20 }, (_, i) => `console["log"](_0xget(${i}));`).join(
    "\n"
  );
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

// A minified-by-geometry file (an unidentifiable webpack/tsc bundle) is non-authored
// in every mode and artifact: it joins the skip set and minified-code REJECTS it -
// never scanned as authored (a source-code submission's promise is readable source, so
// a minified file there is rejected too). A hash-identified library is real third-party
// code and stays excluded (driving missing-library, not minified-code); obfuscated and
// VENDOR-declared files likewise stay excluded.
test("a minified non-library is non-authored and rejected; identified libraries stay excluded", () => {
  const LIB_JS = `${MINIFIED}\n//jq`; // minified geometry + distinct bytes
  const addon = addonWith({
    "blob.js": MINIFIED, // minified by geometry, not a known library
    "jquery.min.js": LIB_JS, // a known library (hash match below)
    "packed.js": OBFUSCATED, // obfuscated
    "vendor/dep.min.js": MINIFIED, // VENDOR.md-declared (authoritative)
  });
  // VENDOR.md declaration is authoritative, not a heuristic, so it stays excluded.
  addon.vendor = { set: new Set(["vendor/dep.min.js"]) };
  const { classified, nonAuthored } = classifyBundled(addon, {
    libraryHashes: libHashes(addon, "jquery.min.js"),
  });
  const tag = (f) => classified.find((c) => c.file === f);
  // The minified non-library is non-authored (skipped by the scanners, then rejected).
  assert.equal(tag("blob.js").minified, true);
  assert.ok(nonAuthored.has("blob.js"));
  // The identified library KEEPS its tag + identity and stays non-authored.
  assert.equal(tag("jquery.min.js").library, true);
  assert.deepEqual(tag("jquery.min.js").libraryId, {
    name: "demolib",
    version: "1.0.0",
  });
  assert.ok(nonAuthored.has("jquery.min.js"));
  // Obfuscated and VENDOR-declared files stay non-authored.
  assert.equal(tag("packed.js").obfuscated, true);
  assert.ok(nonAuthored.has("packed.js"));
  assert.ok(nonAuthored.has("vendor/dep.min.js"));

  // The bundled checks read the tags: minified-code REJECTS the unidentified bundle,
  // the identified library drives missing-library, and obfuscated-code fires.
  const ctx = { addon: { ...addon, bundled: { classified, nonAuthored } } };
  assert.deepEqual(
    minifiedCode.run(ctx).map((f) => f.file),
    ["blob.js"]
  );
  assert.deepEqual(
    missingLibrary.run(ctx).map((f) => f.file),
    ["jquery.min.js"]
  );
  assert.deepEqual(
    obfuscatedCode.run(ctx).map((f) => f.file),
    ["packed.js"]
  );
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
