// Unit tests for the bundled-JS classification "check memory": classifyBundled
// (the one-shot, addon-keyed pre-step), the build/lint correctness fix (the
// classification is computed before normalize, so a reformatted minified file is
// still caught), and the per-review memoization the readers share.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyBundled,
  classifyAddonJs,
  classifyInlineScripts,
  classifyInlineSources,
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
        .findings.map((f) => f.file),
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
    minifiedCode.run(ctx).findings.map((f) => f.file),
    ["blob.js"]
  );
  assert.deepEqual(
    missingLibrary.run(ctx).findings.map((f) => f.file),
    ["jquery.min.js"]
  );
  assert.deepEqual(
    obfuscatedCode.run(ctx).findings.map((f) => f.file),
    ["packed.js"]
  );
});

// A weak-family-only match is not a verdict: the file stays readable authored code
// (scanned, reviewable), and obfuscated-code turns it into ONE escalation judged
// from the file's own content - with no hint of what the detector matched, so the
// reviewer cannot be steered into confirming a detector claim. The escalation names the
// verdict 1:1: fail -> finding, pass -> drop, unsure -> manual review (also the
// no-token default).
test("a weak-family-only file is not obfuscated: authored, one escalation", () => {
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

  // No finding: a weak-only match is not proof. The reviewer is asked instead, and
  // the entry names the file and NOTHING about what the detector matched.
  const out = obfuscatedCode.run({ addon: { ...addon, bundled } });
  assert.deepEqual(out.findings, []);
  assert.deepEqual(
    out.escalations.map((e) => e.file),
    [file]
  );
  assert.ok(
    !JSON.stringify(out.escalations).includes("function_to_array"),
    "the escalation carries no detector hint"
  );
});

test("classification done before normalize survives reformatting (the fix)", () => {
  const addon = addonWith({ "lib/blob.js": MINIFIED });
  // Pipeline pre-step: classify BEFORE normalize.
  addon.bundled = classifyBundled(addon);
  // Normalize reformats the file in place (build/lint mode).
  addon.files.set("lib/blob.js", Buffer.from(PRETTY));
  // The check reads the pre-step store, so the minified file is still flagged.
  const flagged = minifiedCode.run({ addon }).findings.map((f) => f.file);
  assert.deepEqual(flagged, ["lib/blob.js"]);
});

test("without the pre-step, classifying the reformatted bytes misses it", () => {
  // No addon.bundled: the reader recomputes over the already-pretty bytes, which
  // do not look minified - the build/lint false negative the pre-step fixes.
  const flagged = minifiedCode
    .run({ addon: addonWith({ "lib/blob.js": PRETTY }) })
    .findings.map((f) => f.file);
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
  const findings = missingLibrary.run({ addon }).findings;
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

// ---- inline <script> bodies ----
// classifyFiles tags FILES, so the same bytes that are rejected beside a page went
// unasked inside it: minified-code and obfuscated-code both read per-file tags, and an
// inline script has none. classifyInlineScripts asks both questions of the extracted
// source. `ctx` here is the shape a check sees - jsSources, as collectJsSources builds
// them, where an inline body carries the HTML path and inline: true.
const inlineCtx = (code, file = "page.html", extra = {}) => ({
  addon: { files: new Map(), ...extra.addon },
  jsSources: [
    { file, code, lineOffset: 4, inline: true, declaredJs: true, ...extra.src },
  ],
  ...extra,
});

test("classifyInlineScripts judges a minified inline script", () => {
  const [site] = classifyInlineScripts(inlineCtx(MINIFIED));
  assert.equal(site.file, "page.html");
  // lineOffset + 1: the reviewer is sent to the <script>, not the top of the page.
  assert.deepEqual(site.loc, { line: 5, column: 0 });
  assert.equal(site.minified, true);
  assert.equal(site.obfuscation, VERDICT.PASS);
});

test("classifyInlineScripts judges an obfuscated inline script", () => {
  const [site] = classifyInlineScripts(inlineCtx(OBFUSCATED));
  assert.equal(site.obfuscation, VERDICT.FAIL);
  // Multi-line and low-density: obfuscated, and not minified by geometry.
  assert.equal(site.minified, false);
});

// The container is a .html, so judging by extension would apply the CSS rule - one long
// line is enough. A script whose only long line is a data literal is readable source.
test("classifyInlineScripts judges the body as JS, not by the .html it sits in", () => {
  const [site] = classifyInlineScripts(inlineCtx(DATA_BLOB));
  assert.equal(site.minified, false);
});

// The floor bounds the OBFUSCATION detector, not the minified question - so a body
// under it is still asked whether it is packed, and a bundle cannot be cut into
// sub-floor <script> blocks to hide. A non-authored page is skipped outright.
test("classifyInlineScripts asks about a short body, but not for obfuscation", () => {
  const short = `var a=0;${"a=a+1;".repeat(120)}`; // packed, ~730 bytes: under the floor
  assert.ok(Buffer.byteLength(short, "utf8") < 1024);
  const [site] = classifyInlineScripts(inlineCtx(short));
  assert.equal(site.minified, true);
  assert.equal(site.obfuscation, VERDICT.PASS); // not asked at this size
  const ctx = inlineCtx(MINIFIED, "lib/vendor.html");
  ctx.addon.bundled = {
    classified: [],
    nonAuthored: new Set(["lib/vendor.html"]),
    untrusted: [],
  };
  assert.deepEqual(classifyInlineScripts(ctx), []);
});

// The same split for FILES: a sub-floor packed build chunk is minified (real ones ship -
// a Vite modulepreload polyfill, a webpack chunk), while the obfuscation detector is
// still bounded to the sizes where it is precise.
test("classifyBundled asks about a short file, but not for obfuscation", () => {
  const short = `var a=0;${"a=a+1;".repeat(120)}`;
  const { classified } = classifyBundled(addonWith({ "chunk.js": short }));
  const tag = classified.find((c) => c.file === "chunk.js");
  assert.equal(tag.minified, true);
  assert.equal(tag.obfuscation, VERDICT.PASS);
  assert.equal(tag.library, false);
});

// ... but only for JS. The size-independence argument is about statement density, and
// only the JS branch measures it: for CSS isMinified is pure geometry, so a small
// one-line generated stylesheet - a design-token file - would read as packed.
test("a short stylesheet keeps the floor, a short script does not", () => {
  const tokens = `:root{${Array.from(
    { length: 40 },
    (_, i) => `--tk-color-${i}:#ff00${i % 10}${i % 10}`
  ).join(";")}}`;
  assert.ok(Buffer.byteLength(tokens, "utf8") < 1024);
  const { classified } = classifyBundled(
    addonWith({
      "tokens.css": tokens,
      "chunk.js": `var a=0;${"a=a+1;".repeat(120)}`,
    })
  );
  assert.equal(
    classified.find((c) => c.file === "tokens.css"),
    undefined
  );
  assert.equal(classified.find((c) => c.file === "chunk.js").minified, true);
});

// A script with a src= attribute is a separate file and is classified as one; only
// bodies reach here, and a page with none yields nothing.
test("classifyInlineScripts yields nothing for a page with no inline body", () => {
  assert.deepEqual(
    classifyInlineScripts({ addon: { files: new Map() }, jsSources: [] }),
    []
  );
});

// We read an inline body if its type is one a browser RUNS, and also whenever it
// parses. So the type list can never hide code - packed JavaScript in a
// <script type="text/template"> still parses, and is still caught - while a template
// or a JSON blob, which never parses, is not rejected for not being JavaScript.
test("an inline body is read when its type declares JS, or when it parses", () => {
  const packed = `var a=0;${"a=a+1;".repeat(250)}`;
  const markup = `<tr><td>${"x".repeat(600)}</td></tr>\n`.repeat(4);
  const of = (code, declaredJs) =>
    classifyInlineScripts(
      inlineCtx(code, "page.html", { src: { declaredJs } })
    );
  // declared JS: read whether or not it parses.
  assert.equal(of(packed, true)[0].minified, true);
  assert.equal(of(markup, true)[0].minified, true);
  // not declared JS: read it anyway when it parses...
  assert.equal(of(packed, false)[0].minified, true);
  // ... and do not call unparsable markup "packed code".
  assert.equal(of(markup, false)[0].minified, false);
});

// The parse hint is the SOURCE's, never the container's path. A Vue <script lang="ts">
// lives in a .vue; parsed as plain JS it fails, maxLineStatements gives up, and an
// ordinary component is reported as packed code.
test("classifyInlineScripts parses a .vue block by its lang, not the .vue path", () => {
  const ts =
    "export default defineComponent({\n" +
    "  data(): { n: number } { return { n: 0 }; },\n" +
    `  computed: { label(): string { return "${"x".repeat(560)}"; } },\n` +
    "});\n" +
    `// ${"pad ".repeat(200)}\n`;
  const ctx = inlineCtx(ts, "App.vue", { src: { parseAs: ".ts" } });
  assert.equal(classifyInlineScripts(ctx)[0].minified, false);
  // Without the hint the same block is misparsed and called minified.
  const noHint = inlineCtx(ts, "App.vue");
  assert.equal(classifyInlineScripts(noHint)[0].minified, true);
});

// The reviewability decision must see the same verdicts the checks do. Otherwise one
// report tells the developer to send the readable original while another tells them the
// source archive was not needed - and the archive they sent is discarded.
test("hasUnreviewableCode counts code shipped inside a page", () => {
  const page = `<html><body><script>\nvar a=0;${"a=a+1;".repeat(250)}\n</script></body></html>`;
  const addon = addonWith({ "page.html": page });
  const bundled = classifyBundled(addon);
  assert.equal(hasUnreviewableCode(bundled), false); // files alone: nothing to see
  assert.equal(hasUnreviewableCode(bundled, addon), true);
});

// classifyInlineSources answers "is this body the developer ships reviewable", so it
// reads only shipped <script> bodies. A source without `inline` - a lifted Vue template
// binding - is code the scanner synthesized and is not the add-on's to answer for.
test("classifyInlineSources ignores a source that is not a script body", () => {
  const packed = `()=>{${"a=a+1; ".repeat(200)}}`;
  const asBinding = [
    { file: "Comp.vue", code: packed, lineOffset: 1, parseAs: ".js" },
  ];
  const asBody = [{ ...asBinding[0], inline: true, declaredJs: true }];
  assert.deepEqual(classifyInlineSources(asBinding), []);
  assert.equal(classifyInlineSources(asBody).length, 1);
});

// A weak-family-only body: obfuscation UNSURE, so obfuscated-code escalates rather
// than deciding. Repeated helpers with a shared accessor - the shape the detector
// half-recognises. >= 1024 bytes so it clears the floor.
const WEAK_FAMILY =
  "const M = (() => {\n" +
  Array.from(
    { length: 14 },
    (_, i) =>
      `  function assist${i}(v) { return String(v || "").trim() + " assist ${i}"; }\n`
  ).join("") +
  `  const table = [${Array.from({ length: 14 }, (_, i) => `assist${i}`).join(", ")}];\n` +
  '  return { run: (i, v) => table[i](v) };\n})();\nM.run(0, "x");\n';

// Two unsure scripts in ONE page are two questions. The candidate must carry the line:
// the entry renders `file:line`, so without it the reviewer sees one subject named
// twice, and a verdict can be attached to the wrong body.
test("an inline obfuscation candidate names its site, not just its page", async () => {
  const obfuscated = (await import("../../src/checks/rules/obfuscated-code.js"))
    .default;
  assert.equal(
    classifyInlineSources([
      { file: "p.html", code: WEAK_FAMILY, lineOffset: 0, inline: true },
    ])[0].obfuscation.unsure,
    true,
    "fixture must be UNSURE, else there is nothing to escalate"
  );
  const jsSources = [
    { file: "p.html", code: WEAK_FAMILY, lineOffset: 1, inline: true },
    { file: "p.html", code: WEAK_FAMILY, lineOffset: 40, inline: true },
  ];
  const out = obfuscated.run({ addon: { files: new Map() }, jsSources });
  assert.deepEqual(
    out.escalations.map((e) => `${e.file}:${e.loc.line}`),
    ["p.html:2", "p.html:41"]
  );
});
