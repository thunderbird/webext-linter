// Unit tests for the bundled-JS classification "check memory": classifyBundled
// (the one-shot, addon-keyed pre-step), the build/lint correctness fix (the
// classification is computed before normalize, so a reformatted minified file is
// still caught), and the per-review memoization the readers share.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyBundled,
  classifyAddonJs,
  hasUnreviewableCode,
  isMinifiedFirstParty,
  isObfuscatedFirstParty,
} from "../../src/lib/bundled.js";
import minifiedCode from "../../src/checks/rules/minified-code.js";
import obfuscatedCode from "../../src/checks/rules/obfuscated-code.js";
import missingLibrary from "../../src/checks/rules/missing-library.js";
import { rawSha256 } from "../../src/normalize/hash.js";
import { VERDICT } from "../../src/lib/enum.js";

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

// One long line packing many statements (no newline): minified by density, not by
// name, so it exercises the heuristic rather than the ".min.js" / library-name
// shortcut. >= 1024 bytes so it is classified, not skipped.
const MINIFIED = `var a=0;${"a=a+1;".repeat(250)}`;
// The SAME geometry (one long line, >= 1024 bytes) but a single DATA literal, not code:
// one statement, so it is readable data, NOT minified. This is the false positive the
// statement-density signal fixes (the old geometry flagged it).
const DATA_BLOB = `var data=[${"1,".repeat(700)}1];`;
// A readable file whose one long line is a single string payload (an inline icon): also
// one statement -> not minified, and it must stay scannable authored code.
const DATA_URI = `var ICON="data:image/png;base64,${"A".repeat(2000)}";\nexport function icon(){return ICON}`;
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
// The revealing module pattern: an IIFE-initialized const whose only reference is a
// member call - readable first-party code that nevertheless matches the WEAK
// function_to_array_replacements structure (see src/lib/obfuscation.js). >= 1024
// bytes so it is classified, not skipped.
const MODULE_PATTERN =
  "const EmailSignature = (() => {\n" +
  Array.from(
    { length: 20 },
    (_, i) =>
      `  function helper${i}(value) {\n    return String(value || "").trim() + "-${i}";\n  }\n`
  ).join("") +
  "  function init() {\n    return helper0('user@example.com');\n  }\n" +
  "  return { init };\n" +
  "})();\n" +
  "EmailSignature.init();\n";

const addonWith = (files) => ({
  files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
});

test("classifyBundled flags an undeclared statement-dense file", () => {
  const { classified, nonAuthored } = classifyBundled(
    addonWith({ "lib/blob.js": MINIFIED })
  );
  const tag = classified.find((c) => c.file === "lib/blob.js");
  assert.deepEqual(
    [tag.minified, tag.library, tag.obfuscation],
    [true, false, VERDICT.PASS]
  );
  assert.ok(nonAuthored.has("lib/blob.js"));
});

// A file whose one long line is a single data literal (a big array, an inline data:
// URI) is readable data, not packed code: NOT minified, so it stays authored source -
// it is scanned by the content checks, not rejected with "provide the original source".
test("a long-line file that is a single data literal is not minified", () => {
  for (const [name, body] of [
    ["lib/blob.js", DATA_BLOB],
    ["src/icon.js", DATA_URI],
  ]) {
    const { classified, nonAuthored } = classifyBundled(
      addonWith({ [name]: body })
    );
    const tag = classified.find((c) => c.file === name);
    assert.equal(tag.minified, false, `${name} must not be minified`);
    assert.ok(!nonAuthored.has(name), `${name} must stay authored (scanned)`);
    assert.deepEqual(
      minifiedCode
        .run({
          addon: {
            ...addonWith({ [name]: body }),
            bundled: { classified, nonAuthored },
          },
        })
        .map((f) => f.file),
      [],
      `${name} must not be reported as minified-code`
    );
  }
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
  assert.equal(tag("packed.js").obfuscation, VERDICT.FAIL);
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
    obfuscatedCode.run(ctx).findings.map((f) => f.file),
    ["packed.js"]
  );
});

// A weak-family-only match is not a verdict: the file stays readable authored code
// (scanned, reviewable), and obfuscated-code turns it into ONE LLM candidate judged
// from the file's own content - with no hint of what the detector matched, so the
// model cannot be steered into confirming a detector claim. The resolve maps the
// verdict 1:1: fail -> finding, pass -> drop, unsure -> manual review (also the
// no-token default).
test("a weak-family-only file is not obfuscated: authored, one LLM candidate", () => {
  const file = "modules/signature.js";
  const addon = addonWith({ [file]: MODULE_PATTERN });
  const bundled = classifyBundled(addon);
  const tag = bundled.classified.find((c) => c.file === file);
  assert.deepEqual(
    [tag.minified, tag.library, tag.obfuscation],
    [false, false, VERDICT.UNSURE]
  );
  assert.ok(!bundled.nonAuthored.has(file), "stays authored (scanned)");
  assert.equal(
    hasUnreviewableCode(bundled),
    false,
    "a weak-only match does not force a source review"
  );

  const out = obfuscatedCode.run({ addon: { ...addon, bundled } });
  assert.deepEqual(out.findings, []);
  assert.equal(out.llm.candidates.length, 1);
  const cand = out.llm.candidates[0];
  assert.equal(cand.file, file);
  assert.deepEqual(cand.corpus, [file]); // the model reads that single file
  assert.ok(
    !JSON.stringify(out.llm.candidates).includes("function_to_array"),
    "the candidate carries no detector hint"
  );

  const resolveWith = (verdict) =>
    out.llm.resolve(new Map([[cand.id, { verdict, reason: null }]]));
  assert.deepEqual(
    resolveWith(VERDICT.FAIL).findings.map((f) => f.file),
    [file]
  );
  assert.deepEqual(resolveWith(VERDICT.PASS), { findings: [], manual: [] });
  assert.deepEqual(
    resolveWith(VERDICT.UNSURE).manual.map((m) => m.file),
    [file]
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
// Minified CSS NOT in the hash DB: one long line of packed rules -> minified, but NOT
// a recognized library.
const MINIFIED_CSS = `.x{color:#fff}${".y{margin:0}".repeat(120)}`;
// A readable stylesheet whose one long line is a single `data:` font payload: after the
// payload is stripped it is short, so it is NOT minified (the CSS false positive).
const DATA_FONT_CSS = `@font-face{font-family:x;src:url("data:font/woff2;base64,${"A".repeat(2000)}")}\n.a{color:red}`;

test("classifyBundled tags an undeclared vendored CSS as a library", () => {
  const file = "vendor/bootstrap/bootstrap.min.css";
  const addon = addonWith({ [file]: LIB_CSS });
  const { classified, nonAuthored } = classifyBundled(addon, {
    libraryHashes: libHashes(addon, file),
  });
  const tag = classified.find((c) => c.file === file);
  assert.equal(tag.library, true);
  assert.deepEqual(tag.libraryId, { name: "demolib", version: "1.0.0" }); // named
  assert.equal(tag.obfuscation, VERDICT.PASS); // obfuscation is a JS-only concept
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

test("a minified CSS is minified but not a library or obfuscated", () => {
  const { classified } = classifyBundled(
    addonWith({ "popup/app.css": MINIFIED_CSS })
  );
  const tag = classified.find((c) => c.file === "popup/app.css");
  assert.deepEqual(
    [tag.minified, tag.library, tag.obfuscation],
    [true, false, VERDICT.PASS]
  );
});

test("a CSS whose one long line is a single data: payload is not minified", () => {
  const { classified, nonAuthored } = classifyBundled(
    addonWith({ "popup/fonts.css": DATA_FONT_CSS })
  );
  const tag = classified.find((c) => c.file === "popup/fonts.css");
  assert.equal(tag.minified, false);
  assert.ok(!nonAuthored.has("popup/fonts.css"));
});

// hasUnreviewableCode is the single definition of "code we cannot review" shared by the
// pipeline's SCA-downgrade decision and the minified-code / obfuscated-code /
// untrusted-minified-library checks: minified or obfuscated FIRST-PARTY code (recognized
// libraries excluded), or an identified-but-untrusted unreadable library.
test("hasUnreviewableCode: minified/obfuscated first-party -> true; library/readable -> false", () => {
  const min = classifyBundled(addonWith({ "bundle.js": MINIFIED }));
  assert.equal(
    hasUnreviewableCode(min),
    true,
    "minified first-party is unreviewable"
  );
  assert.equal(
    isMinifiedFirstParty(min.classified.find((c) => c.file === "bundle.js")),
    true
  );

  const obf = classifyBundled(addonWith({ "o.js": OBFUSCATED }));
  assert.equal(
    hasUnreviewableCode(obf),
    true,
    "obfuscated first-party is unreviewable"
  );
  assert.equal(
    isObfuscatedFirstParty(obf.classified.find((c) => c.file === "o.js")),
    true
  );

  const readable = classifyBundled(addonWith({ "app.js": PRETTY }));
  assert.equal(
    hasUnreviewableCode(readable),
    false,
    "readable code is reviewable"
  );

  // A recognized (hash-matched) minified library does NOT make the add-on unreviewable -
  // it is excluded, so an otherwise-readable add-on that merely bundles it stays reviewable.
  const addon = addonWith({ "jq.min.js": MINIFIED, "app.js": PRETTY });
  const withLib = classifyBundled(addon, {
    libraryHashes: libHashes(addon, "jq.min.js"),
  });
  assert.equal(
    hasUnreviewableCode(withLib),
    false,
    "a recognized minified library alone does not force a source review"
  );
  assert.equal(
    isMinifiedFirstParty(
      withLib.classified.find((c) => c.file === "jq.min.js")
    ),
    false
  );

  // The untrusted-unreadable clause (the CDN/vendor pass fills `untrusted` later).
  const base = { classified: [], nonAuthored: new Set() };
  assert.equal(
    hasUnreviewableCode({
      ...base,
      untrusted: [{ file: "x.js", unreadable: true }],
    }),
    true
  );
  assert.equal(
    hasUnreviewableCode({
      ...base,
      untrusted: [{ file: "x.js", unreadable: false }],
    }),
    false
  );
  assert.equal(hasUnreviewableCode({ ...base, untrusted: [] }), false);
  assert.equal(hasUnreviewableCode(null), false);
});
