// Unit tests for the new deterministic rule modules and the yaml-driven loader.

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
import nonExperimentMax from "../../src/checks/rules/non-experiment-strict-max-version.js";
import experimentNotAllowed from "../../src/checks/rules/experiment-not-allowed.js";
import missingLibrary from "../../src/checks/rules/missing-library.js";
import obfuscatedCode from "../../src/checks/rules/obfuscated-code.js";
import apiCoverage from "../../src/checks/rules/api-coverage.js";
import strictMaxBumpOnly from "../../src/checks/rules/strict-max-version-bump-only.js";
import trademarkViolation from "../../src/checks/rules/trademark-violation.js";
import coreSymbolInWebext from "../../src/checks/rules/core-symbol-in-webext.js";
import missingEnglish from "../../src/checks/rules/missing-english-localization.js";
import disguisedResource from "../../src/checks/rules/disguised-resource.js";
import disguisedStylesheet from "../../src/checks/rules/disguised-stylesheet.js";
import unparsableFile from "../../src/checks/rules/unparsable-file.js";
import dataExfiltration from "../../src/checks/rules/data-exfiltration.js";
import cleartextTransmission from "../../src/checks/rules/cleartext-transmission.js";
import privacyPolicy from "../../src/checks/rules/privacy-policy.js";
import nativeMessaging from "../../src/checks/rules/native-messaging.js";
import defaultLocaleMissing from "../../src/checks/rules/default-locale-missing.js";
import defaultLocaleUnused from "../../src/checks/rules/default-locale-unused.js";
import addonIconMissing from "../../src/checks/rules/addon-icon-missing.js";
import backgroundModule from "../../src/checks/rules/background-module.js";
import unusedPermission from "../../src/checks/rules/unused-permission.js";
import unusedPermissionManual from "../../src/checks/rules/unused-permission-manual.js";
import unusedPermissionManualPre from "../../src/checks/rules/unused-permission-manual-pre-d308076.js";
import { scanNetworkSinks } from "../../src/parse/network-sinks.js";
import { getPermissionAnalysis } from "../../src/checks/lib/permissions.js";
import {
  loadChecks,
  loadRegistry,
  runOneCheck,
} from "../../src/checks/registry.js";
import { finding } from "../../src/report/finding.js";
import unknownApi from "../../src/checks/rules/unknown-api.js";
import strictMaxVersionApi from "../../src/checks/rules/strict-max-version-api.js";
import strictMinVersionApi from "../../src/checks/rules/strict-min-version-api.js";
import { loadSchemaFiles } from "../../src/schema/load.js";
import { buildSchemaIndex, SchemaIndex } from "../../src/schema/index.js";
import { parseVendorManifest } from "../../src/normalize/vendor.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = buildSchemaIndex(
  loadSchemaFiles(path.join(here, "..", "schema-fixture"))
);

const jsCtx = (code, manifest = {}) => ({
  jsSources: [{ file: "f.js", code, lineOffset: 0, inline: false }],
  addon: { files: new Map(), manifest },
  options: {},
});

// ctx whose addon.files is a path->content map (for the file-level bundled /
// obfuscated checks, which read raw file bytes rather than parsed sources). The
// vendored set is resolved deterministically, as the pipeline does once up front.
const filesCtx = (files) => {
  const addon = {
    files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
  };
  const manifest = parseVendorManifest(addon);
  addon.vendor = { set: new Set(manifest.map((e) => e.path)), manifest };
  return { addon };
};

// Run a check with a fake ctx.note collector and return the recorded activity.
function notesFrom(check, ctx) {
  const notes = [];
  ctx.note = (file, loc, item, verdict) => notes.push({ file, item, verdict });
  check.run(ctx);
  return notes;
}

// ---- sync-xhr ----
// Only the explicit async=false third arg to open() is a synchronous XHR;
// async=true and an omitted third arg (defaults to async) must not flag.
test("sync-xhr flags open(..., false), not async/omitted", () => {
  assert.equal(syncXhr.run(jsCtx(`x.open("GET", "/u", false);`)).length, 1);
  assert.equal(syncXhr.run(jsCtx(`x.open("GET", "/u", true);`)).length, 0);
  assert.equal(syncXhr.run(jsCtx(`x.open("GET", "/u");`)).length, 0);
});

// ---- debugger ----
// A debugger that always runs (top level, in a function body, or inside a loop)
// is flagged, but one guarded by any if/else branch is treated as intentional.
test("debugger-statement flags unconditional debugger, allows if-guarded", () => {
  const n = (code) => debuggerStatement.run(jsCtx(code)).length;
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
      jsCtx(`browser.runtime.onMessage.addListener(async (m) => {});`)
    ).length,
    1
  );
  assert.equal(
    asyncOnMessage.run(
      jsCtx(`messenger.runtime.onMessage.addListener((m) => {});`)
    ).length,
    0
  );
  assert.equal(
    asyncOnMessage.run(jsCtx(`el.addEventListener("click", async () => {});`))
      .length,
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
  const ctxFor = (file) => ({
    jsSources: [{ file, code, lineOffset: 0 }],
    addon: { files: new Map([[file, Buffer.from(code)]]), manifest: {} },
    options: {},
  });
  // ".min.js" -> classified a library -> all three checks skip it.
  const lib = ctxFor("vendor/lib.min.js");
  assert.equal(syncXhr.run(lib).length, 0);
  assert.equal(debuggerStatement.run(lib).length, 0);
  assert.equal(asyncOnMessage.run(lib).length, 0);
  // The same code under an authored name is still flagged by each.
  const app = ctxFor("src/app.js");
  assert.equal(syncXhr.run(app).length, 1);
  assert.equal(debuggerStatement.run(app).length, 1);
  assert.equal(asyncOnMessage.run(app).length, 1);
});

// ---- minimize host permissions ----
// Broad required host patterns (<all_urls> and *://*/*) are flagged, while a
// specific scoped origin like https://example.com/* is left alone.
test("minimize-host-permissions flags broad required host patterns only", () => {
  const out = minimizeHostPermissions.run(
    jsCtx("", {
      host_permissions: ["<all_urls>", "*://*/*", "https://example.com/*"],
    })
  );
  assert.equal(out.length, 2); // all_urls + *://*/* ; example.com is scoped
});

// ---- code sanity (ESLint) ----
// prefer-const is a style/fixable rule, not a review concern, so it is never
// flagged. no-undef is off too, so browser/messenger globals are never flagged.
test("code-sanity does not flag prefer-const or globals", () => {
  const neverReassigned = `let x = 1;\nconsole.log(x);`;
  assert.equal(codeSanity.run(jsCtx(neverReassigned)).length, 0);

  // browser/messenger are not flagged as undefined (no-undef is disabled).
  const clean = codeSanity.run(
    jsCtx(`const y = browser.runtime.id;\nmessenger.tabs.query({});`)
  );
  assert.equal(clean.length, 0);
});

// no-empty flags an empty block (e.g. an error-swallowing empty catch), but not
// an empty function body (which is no-empty-function's concern, not enabled). The
// rule runs whenever code-sanity runs - the --eslint gate is applied upstream at
// check selection (pipeline.js), not in the rule.
test("code-sanity flags an empty block, not an empty function body", () => {
  const out = codeSanity.run(jsCtx(`try { risky(); } catch (e) {}`));
  assert.equal(out.length, 1);
  assert.match(out[0].item, /no-empty/);
  assert.equal(codeSanity.run(jsCtx(`const f = () => {};`)).length, 0);
});

// Third-party / minified / obfuscated / VENDOR.md code is not linted (its
// findings are noise); the same code under an authored filename is.
test("code-sanity skips non-authored code, lints authored code", () => {
  const redecl = "var a = 1;\n".repeat(200); // ~2KB, trips no-redeclare, short lines
  const ctxFor = (file) => ({
    jsSources: [{ file, code: redecl, lineOffset: 0 }],
    addon: { files: new Map([[file, Buffer.from(redecl)]]), manifest: {} },
    options: {},
  });
  // ".min.js" name -> classified as a library -> skipped entirely.
  assert.equal(codeSanity.run(ctxFor("vendor/lib.min.js")).length, 0);
  // Authored source of the same code is linted.
  assert.ok(codeSanity.run(ctxFor("src/app.js")).length > 0);
});

// ---- missing-library / obfuscated-code (shared bundled.js classifier) ----
// missing-library flags JS that looks like a distributed library (banner, UMD,
// *.min.js, known name), skipping readable code and VENDOR.md-declared files.
test("missing-library flags library-looking JS, not readable/VENDORed files", () => {
  const banner =
    "/*! demolib v1.0.0 | (c) Demo */\n" +
    "export const lib = { run() { return 1; } };\n".repeat(40); // >1 KB
  assert.equal(
    missingLibrary.run(filesCtx({ "lib/demo.js": banner })).length,
    1
  );
  // *.min.js name alone is enough.
  assert.equal(
    missingLibrary.run(filesCtx({ "vendor/x.min.js": "a;".repeat(600) }))
      .length,
    1
  );
  // Readable code, no library signal -> not flagged.
  const readable = "function f(a) {\n  return a + 1;\n}\n".repeat(40);
  assert.equal(missingLibrary.run(filesCtx({ "bg.js": readable })).length, 0);
  // Declared in VENDOR.md -> skipped even with a banner.
  const vendor =
    "lib/demo.js:\n - Version: 1.0\n - URL: https://unpkg.com/demolib@1.0.0/dist/demo.js\n";
  assert.equal(
    missingLibrary.run(filesCtx({ "VENDOR.md": vendor, "lib/demo.js": banner }))
      .length,
    0
  );
});

// obfuscated-code flags minified or obfuscated NON-library code (the dev's own
// blob); a library-looking file is deferred to missing-library instead.
test("obfuscated-code flags minified/obfuscated non-library JS only", () => {
  // Minified line geometry: one long, dense line.
  const minified = "var a=1;b=2;c=3;d=4;".repeat(100) + "\n";
  assert.equal(
    obfuscatedCode.run(filesCtx({ "bundle.js": minified })).length,
    1
  );
  // "_0x" obfuscator identifiers (short lines, so obfuscation - not minification
  // - is what fires).
  const obf =
    "const _0xa1b2=1;\nconst _0xc3d4=2;\nconst _0xe5f6=3;\n" +
    "const _0x7890=4;\nconst _0xabcd=5;\n".repeat(40);
  assert.equal(obfuscatedCode.run(filesCtx({ "o.js": obf })).length, 1);
  // A minified file with a library name is missing-library's job, not this one.
  assert.equal(
    obfuscatedCode.run(filesCtx({ "x.min.js": minified })).length,
    0
  );
  // Readable code -> not flagged.
  const readable = "function f(a) {\n  return a + 1;\n}\n".repeat(40);
  assert.equal(obfuscatedCode.run(filesCtx({ "bg.js": readable })).length, 0);
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
  const cov = apiCoverage.run({
    apiUsages,
    addon: {
      manifest: { background: { scripts: ["dyn.js"] } },
      files: new Map([["dyn.js", Buffer.from("")]]),
    },
  });
  assert.equal(cov.length, 1);
  const dyn = cov[0];
  assert.equal(dyn.file, "dyn.js");
  assert.equal(dyn.severity, null);
  assert.equal(dyn.item, "dynamic browser[x] access"); // reason passed through
  assert.equal(dyn.loc.line, 7); // carries the source location

  const unparsable = unparsableFile.run({ apiUsages });
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
  const run = (addon, previous) => strictMaxBumpOnly.run({ addon, previous });

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
  const checks = await loadChecks(loadRegistry());
  const c = checks.find((x) => x.id === "strict-max-version-bump-only");
  assert.equal(c?.diff, true);
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

// ---- unused-permission-manual (producer of permissions to vet) ----
// It always enumerates the declared NAMED permissions a reachable API call does
// not provably require, one escalation each (anchored to the manifest line); host
// match patterns are skipped. When --full-summary runs the orchestrator hands
// these to the unused-permission recheck consumer; otherwise they auto-group into
// the by-hand reminder.
test("unused-permission-manual lists the unprovable declared named permissions", () => {
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
  const out = unusedPermissionManual.run(ctx);
  assert.equal(out.findings.length, 0);
  assert.deepEqual(out.escalations.map((e) => e.item).sort(), [
    "storage",
    "tabs",
  ]);
  assert.ok(out.escalations.every((e) => e.file === "manifest.json"));
});

// The deterministic analysis is authoritative: a permission a reachable API call
// provably requires (here messagesRead, via messages.get) is dropped here, so it
// never reaches the reviewer or the recheck consumer. Only the unprovable rest
// (messagesUpdate) is escalated.
test("unused-permission-manual drops permissions proved used by static analysis", () => {
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
  const out = unusedPermissionManual.run(ctx);
  assert.deepEqual(
    out.escalations.map((e) => e.item),
    ["messagesUpdate"] // messagesRead is gated out (provably used)
  );
  // The override is recorded as a pass note, so the feed shows it was dropped.
  assert.deepEqual(
    notes.find((n) => n.item === "messagesRead"),
    { item: "messagesRead", verdict: "pass" }
  );
});

// A permission that gates no callable API (unlimitedStorage) can never be proved
// used by static analysis, but it is justified by its mere presence - so it is
// exempt: dropped here (noted pass), never escalated as unused.
test("unused-permission-manual exempts unlimitedStorage (gates no API)", () => {
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
  const out = unusedPermissionManual.run(ctx);
  // tabs is still escalated; unlimitedStorage is exempt.
  assert.deepEqual(
    out.escalations.map((e) => e.item),
    ["tabs"]
  );
  assert.deepEqual(
    notes.find((n) => n.item === "unlimitedStorage"),
    {
      item: "unlimitedStorage",
      verdict: "pass",
    }
  );
});

// ---- unused-permission (recheck consumer) ----
// Given the items handed to it (ctx.recheck) and the summary's verdicts
// (ctx.addon.recheck), it maps each: fail -> a warning finding carrying the reason
// on the permission's manifest line, pass -> dropped, unsure -> a manual-review
// escalation. The mapping itself is resolveRecheck (see recheck.test.js); this
// confirms the module is wired to it.
test("unused-permission maps the summary's recheck verdicts to findings + escalations", () => {
  const check = { id: "unused-permission" };
  const ctx = {
    recheck: new Map([
      [
        "unused-permission",
        [
          {
            ruleId: "unused-permission-manual",
            item: "tabs",
            file: "manifest.json",
            loc: { line: 4 },
          },
          {
            ruleId: "unused-permission-manual",
            item: "downloads",
            file: "manifest.json",
            loc: { line: 5 },
          },
          {
            ruleId: "unused-permission-manual",
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
          check: "unused-permission",
          item: "tabs",
          verdict: "fail",
          reason: "no tab property read",
        },
        {
          check: "unused-permission",
          item: "downloads",
          verdict: "unsure",
          reason: "cannot tell",
        },
        {
          check: "unused-permission",
          item: "storage",
          verdict: "pass",
          reason: "used by storage.local",
        },
      ],
    },
  };
  const out = unusedPermission.run(ctx, check);
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].item, "tabs"); // fail -> finding
  assert.equal(out.findings[0].data.reason, "no tab property read");
  assert.equal(out.findings[0].loc.line, 4); // the permission's manifest line
  assert.deepEqual(
    out.escalations.map((e) => e.item),
    ["downloads"] // unsure -> manual; storage (pass) is dropped
  );
  assert.equal(out.escalations[0].data.reason, "cannot tell");
});

test("unused-permission is a no-op with nothing handed over", () => {
  assert.deepEqual(unusedPermission.run({}, { id: "unused-permission" }), {
    findings: [],
    escalations: [],
  });
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
  const out = deprecatedApi.run(ctx);
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
  const out = unknownApi.run(ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].item, "browser.t.gone");
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
    maxCtx("250.*", [
      {
        root: "messenger",
        segments: ["messages", "future"],
        line: 1,
        column: 0,
      }, // 200 <= 250
    ])
  );
  assert.equal(out.length, 0);
});

test("strict-max-version-api is skipped without strict_max_version", () => {
  const out = strictMaxVersionApi.run(
    maxCtx(null, [
      {
        root: "messenger",
        segments: ["messages", "future"],
        line: 1,
        column: 0,
      },
    ])
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
    minCtx("128.0", [
      { root: "messenger", segments: ["messages", "list"], line: 1, column: 0 }, // 66 <= 128
    ])
  );
  assert.equal(out.findings.length, 0);
});

test("strict-min-version-api is skipped without strict_min_version", () => {
  const out = strictMinVersionApi.run(
    minCtx(null, [
      {
        root: "messenger",
        segments: ["messages", "future"],
        line: 1,
        column: 0,
      },
    ])
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
    strictMinVersionApi.run({
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
    });
  assert.equal(run("140.4.0").findings.length, 1); // 140.4.1 > 140.4.0 -> flag
  assert.equal(run("140.4.1").findings.length, 0); // equal -> not flagged
  assert.equal(run("140.5.0").findings.length, 0); // 140.4.1 < 140.5.0 -> not flagged
});

// A too-new API carrying a guard signal (usage.guarded, set by api-usage.js for
// optional chaining / a feature-detection or version gate) is not a hard error: it
// becomes one LLM candidate, judged from the call's file. resolve maps the verdict.
test("strict-min-version-api defers a guarded too-new API to the LLM", () => {
  const out = strictMinVersionApi.run(
    minCtx("60.0", [
      {
        root: "messenger",
        segments: ["messages", "future"],
        line: 5,
        column: 2,
        guarded: true,
      }, // va 200, guarded
    ])
  );
  assert.equal(out.findings.length, 0); // not a deterministic finding
  assert.equal(out.llm.candidates.length, 1);
  const c = out.llm.candidates[0];
  assert.equal(c.file, "bg.js");
  assert.deepEqual(c.corpus, ["bg.js"]); // local judgement: just the call's file
  assert.match(c.note, /messenger\.messages\.future/);
  // fail -> finding, pass -> drop, unsure (no verdict) -> manual.
  const fail = out.llm.resolve(new Map([[c.id, { verdict: "fail" }]]));
  assert.equal(fail.findings.length, 1);
  assert.equal(fail.findings[0].item, "messenger.messages.future()");
  assert.equal(fail.findings[0].data.min, "60.0");
  const pass = out.llm.resolve(new Map([[c.id, { verdict: "pass" }]]));
  assert.equal(pass.findings.length, 0);
  assert.equal(pass.manual.length, 0);
  const unsure = out.llm.resolve(new Map()); // no token / no verdict -> manual
  assert.equal(unsure.manual.length, 1);
});

// An API used UNGUARDED anywhere is a hard error, even if another site is guarded:
// the unguarded site wins and there is no LLM candidate for it.
test("strict-min-version-api: an unguarded site wins over a guarded one", () => {
  const out = strictMinVersionApi.run(
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
  );
  assert.equal(out.llm, undefined); // no candidate - it is a hard finding
  assert.equal(out.findings.length, 1);
  assert.deepEqual(out.findings[0].loc, { line: 9, column: 0 });
});

// Scope guard: feature detection does NOT launder a non-existent API. A guarded
// call to an API absent from the schema is ignored here (it never becomes a
// candidate) and stays unknown-api's concern, which still flags it.
test("strict-min-version-api ignores a guarded non-existent API (unknown-api owns it)", () => {
  const usages = [
    {
      root: "messenger",
      segments: ["fake", "nope"],
      line: 1,
      column: 0,
      guarded: true,
    },
  ];
  const out = strictMinVersionApi.run(minCtx("60.0", usages));
  assert.equal(out.findings.length, 0);
  assert.equal(out.llm, undefined); // never a candidate

  const flagged = unknownApi.run({
    schema,
    addon: {
      manifest: { background: { scripts: ["bg.js"] } },
      files: new Map([["bg.js", Buffer.from("")]]),
    },
    apiUsages: [{ file: "bg.js", usages }],
  });
  assert.equal(flagged.length, 1);
  assert.match(flagged[0].item, /^messenger\.fake/); // unknown at the namespace
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
  const live = missingPermission.run(ctx("bg.js"));
  assert.ok(live.some((f) => f.item === "messagesRead"));
  // Dead: dead.js is never referenced by the manifest -> no missing finding.
  assert.equal(missingPermission.run(ctx("dead.js")).length, 0);
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
    getPermissionAnalysis(ctx("bg.js")).usedPermissions.has("messagesRead")
  );
  assert.ok(
    !getPermissionAnalysis(ctx("dead.js")).usedPermissions.has("messagesRead")
  );
});

// The no-LLM checklist drops a declared permission a reachable call provably
// needs (messages.get -> messagesRead), escalating only the unproven ones.
test("unused-permission-manual omits permissions a reachable call requires", () => {
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
  const out = unusedPermissionManual.run(ctx);
  // messagesRead is proven used -> not escalated; tabs has no proven need -> kept.
  assert.deepEqual(
    out.escalations.map((e) => e.item),
    ["tabs"]
  );
});

// ---- the two version-gated producers (D308076) ----
// unused-permission-manual and unused-permission-manual-pre-d308076 share one
// enumeration; the strict_min_version gate decides which fires. >= 154 -> the
// post-fix producer; below 154 or absent/unparsable -> the pre-D308076 producer.
// Exactly one enumerates per add-on, so exactly one consumer prompt is appended.
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

test("post-D308076 producer fires only for strict_min_version >= 154", () => {
  for (const min of ["154", "154.0", "200"]) {
    assert.deepEqual(
      unusedPermissionManual
        .run(permProducerCtx(min))
        .escalations.map((e) => e.item),
      ["tabs"],
      `min=${min}`
    );
  }
  for (const min of ["153.9", "128", undefined, "abc", "≤59"]) {
    assert.deepEqual(
      unusedPermissionManual.run(permProducerCtx(min)).escalations,
      [],
      `min=${String(min)}`
    );
  }
});

test("pre-D308076 producer fires for below-154 / absent / unparsable", () => {
  for (const min of ["153.9", "128", undefined, "abc", "≤59"]) {
    assert.deepEqual(
      unusedPermissionManualPre
        .run(permProducerCtx(min))
        .escalations.map((e) => e.item),
      ["tabs"],
      `min=${String(min)}`
    );
  }
  for (const min of ["154", "154.0", "200"]) {
    assert.deepEqual(
      unusedPermissionManualPre.run(permProducerCtx(min)).escalations,
      [],
      `min=${min}`
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
    trademarkViolation.run(ctx(name, files)).length;
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
  const withManifest = (name, files) => ({
    addon: {
      manifest: { manifest_version: 3, name, version: "1" },
      files: new Map(
        Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])
      ),
    },
  });
  // A literal name: the line of the `name` property, and the name as the item.
  const literal = trademarkViolation.run(
    withManifest("Firefox Helper", {
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
    withManifest("__MSG_extName__", {
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
  // background script and include it in the packaged files (the check now gates on
  // pureWebExtensionReachable, not "every authored file").
  const run = (code) =>
    coreSymbolInWebext.run({
      jsSources: [{ file: "bg.js", code, lineOffset: 0 }],
      addon: {
        manifest: { manifest_version: 3, background: { scripts: ["bg.js"] } },
        files: new Map([["bg.js", Buffer.from(code)]]),
      },
      options: {},
    });
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
    experimentMissingMax.run({
      addon: { manifest },
      options: { allowExperiments: true },
    });
  assert.equal(run({ experiment_apis: { a: {} } }).length, 1); // experiment, no max
  assert.equal(
    run({
      experiment_apis: { a: {} },
      browser_specific_settings: { gecko: { strict_max_version: "128.0" } },
    }).length,
    0 // experiment WITH a max -> ok
  );
  assert.equal(run({ name: "x" }).length, 0); // not an experiment -> silent
  // The check no longer gates on allowExperiments: whether it runs at all is the
  // orchestrator's job (phase: default runs only for a VALID experiment - allowed
  // via the flag or a pristine upstream copy). Reached directly without the flag,
  // it still flags an experiment lacking a max.
  assert.equal(
    experimentMissingMax.run({
      addon: { manifest: { experiment_apis: { a: {} } } },
      options: {},
    }).length,
    1
  );
});

// Every Experiment submission escalates one whole-add-on manual review (a
// locus-less reminder, no findings); a non-Experiment escalates nothing.
test("experiment-manual-review escalates one reminder for an Experiment only", () => {
  const run = (manifest) => experimentManualReview.run({ addon: { manifest } });
  const exp = run({ experiment_apis: { a: {} } });
  assert.deepEqual(exp.findings, []);
  assert.equal(exp.escalations.length, 1);
  assert.deepEqual(exp.escalations[0], {}); // whole-add-on, no locus
  assert.deepEqual(run({ name: "x" }).escalations, []); // not an experiment
});

// A non-Experiment that pins strict_max_version warns and surfaces the value;
// the legacy applications.gecko key counts too, and an Experiment or a missing
// max stays silent.
test("non-experiment-strict-max-version flags only a non-Experiment that pins a max", () => {
  const run = (manifest) => nonExperimentMax.run({ addon: { manifest } });
  const out = run({
    browser_specific_settings: { gecko: { strict_max_version: "128.0" } },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].item, "128.0"); // value surfaced for the {{item}} response
  // The finding anchors on the strict_max_version line of the manifest text.
  const located = nonExperimentMax.run({
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
  });
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
    ctx({ experiment_apis: { x: {} } }, false)
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].loc.line, 2); // attached to the experiment_apis line
  // --allow-experiments silences it.
  assert.equal(
    experimentNotAllowed.run(ctx({ experiment_apis: { x: {} } }, true)).length,
    0
  );
  // Not an Experiment -> silent regardless.
  assert.equal(experimentNotAllowed.run(ctx({ name: "x" }, false)).length, 0);
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
    ["fail", "pass"]
  );
});

test("debugger-statement notes guarded (pass) and unconditional (fail)", () => {
  const notes = notesFrom(
    debuggerStatement,
    jsCtx(`debugger;\nif (D) debugger;`)
  );
  assert.deepEqual(notes.map((n) => n.verdict).sort(), ["fail", "pass"]);
});

test("minimize-host-permissions notes broad (fail) and scoped (pass) hosts", () => {
  const notes = notesFrom(
    minimizeHostPermissions,
    jsCtx("", { host_permissions: ["<all_urls>", "https://example.com/*"] })
  );
  assert.deepEqual(notes, [
    { file: "manifest.json", item: "<all_urls>", verdict: "fail" },
    { file: "manifest.json", item: "https://example.com/*", verdict: "pass" },
  ]);
});

test("missing-library / obfuscated-code note a verdict per classified file", () => {
  const banner =
    "/*! demolib v1.0.0 */\n" +
    "export const lib = { run() { return 1; } };\n".repeat(40);
  const readable = "function f(a) {\n  return a + 1;\n}\n".repeat(40);
  const libNotes = notesFrom(
    missingLibrary,
    filesCtx({ "lib.js": banner, "app.js": readable })
  );
  assert.equal(libNotes.find((n) => n.file === "lib.js").verdict, "fail");
  assert.equal(libNotes.find((n) => n.file === "app.js").verdict, "pass");
  // obfuscated-code defers libraries to missing-library, so it notes only app.js.
  const obfNotes = notesFrom(
    obfuscatedCode,
    filesCtx({ "lib.js": banner, "app.js": readable })
  );
  assert.deepEqual(
    obfNotes.map((n) => n.file),
    ["app.js"]
  );
  assert.equal(obfNotes[0].verdict, "pass");
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
  assert.equal(v({ name: "x" }, false)[0].verdict, "pass"); // not an Experiment
  assert.equal(v({ experiment_apis: { a: {} } }, false)[0].verdict, "fail");
  assert.equal(v({ experiment_apis: { a: {} } }, true)[0].verdict, "skipped");
});

test("experiment-missing-strict-max-version notes pass / fail / skipped", () => {
  const v = (manifest) =>
    notesFrom(experimentMissingMax, {
      addon: { manifest },
      options: { allowExperiments: true },
    });
  assert.equal(v({ experiment_apis: { a: {} } })[0].verdict, "fail"); // no max
  assert.equal(
    v({
      experiment_apis: { a: {} },
      browser_specific_settings: { gecko: { strict_max_version: "128.0" } },
    })[0].verdict,
    "pass"
  );
  assert.equal(v({ name: "x" })[0].verdict, "skipped"); // not an Experiment
});

test("non-experiment-strict-max-version notes pass / fail / skipped", () => {
  const v = (manifest) => notesFrom(nonExperimentMax, { addon: { manifest } });
  assert.equal(v({ name: "x" })[0].verdict, "pass"); // no max
  assert.equal(
    v({
      browser_specific_settings: { gecko: { strict_max_version: "128.0" } },
    })[0].verdict,
    "fail"
  );
  assert.equal(
    v({
      experiment_apis: { a: {} },
      browser_specific_settings: { gecko: { strict_max_version: "128.0" } },
    })[0].verdict,
    "skipped" // an Experiment is the other check's concern
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
    "fail"
  );
  assert.equal(
    v(ver(m("128.0", "1.1"), { "bg.js": "console.log(2);\n" }), prev)[0]
      .verdict,
    "pass" // a code file also changed
  );
});

test("trademark-violation notes pass / fail / skipped", () => {
  const ctxFor = (name) => ({
    addon: { manifest: name == null ? {} : { name }, files: new Map() },
  });
  const v = (name) => notesFrom(trademarkViolation, ctxFor(name));
  assert.equal(v("Calendar for Thunderbird")[0].verdict, "pass");
  assert.equal(v("Firefox Helper")[0].verdict, "fail");
  assert.equal(v(null)[0].verdict, "skipped"); // no name
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
  assert.equal(v({ "_locales/en/messages.json": "{}" })[0].verdict, "pass");
  assert.equal(v({ "_locales/de/messages.json": "{}" })[0].verdict, "fail");
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
    missingEnglish.run({
      addon: {
        manifest,
        files: new Map(
          Object.entries(files).map(([k, val]) => [k, Buffer.from(val)])
        ),
      },
    });

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
  const checks = await loadChecks(registry);
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
    "deterministic-checks:\n- title: Bogus\n  check: __does_not_exist__.js\n"
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
      "deterministic-checks:\n- title: P\n  check: producer-x\n  post-summary-recheck: nope\n"
    );
    await assert.rejects(() => loadChecks(loadRegistry(tmp)), /is not a check/);
    // Target is a real check, but it carries no summary-prompt.
    write(
      "deterministic-checks:\n" +
        "- title: P\n  check: producer-x\n  post-summary-recheck: consumer-x\n" +
        "- title: C\n  check: consumer-x\n"
    );
    await assert.rejects(() => loadChecks(loadRegistry(tmp)), /summary-prompt/);
  } finally {
    fs.rmSync(tmp);
  }
});

// A check carrying a summary-prompt is classified post-summary without an explicit
// phase (it is re-judged by the add-on summary, which runs then); a producer
// (post-summary-recheck but no summary-prompt) stays in the main loop.
test("loadChecks classifies a summary-prompt check as post-summary", async () => {
  const checks = await loadChecks(loadRegistry());
  assert.equal(
    checks.find((c) => c.id === "unused-permission")?.phase,
    "post-summary"
  );
  assert.equal(
    checks.find((c) => c.id === "unused-permission-manual")?.phase,
    undefined
  );
});

// loadChecks validates the severity token: error/warning/info/auto are allowed,
// anything else is a loud config error (the module exists; only the severity is
// bad - so this is distinct from the missing-module failure above).
test("loadChecks accepts severity: auto", async () => {
  const tmp = path.join(os.tmpdir(), `auto-registry-${process.pid}.yaml`);
  fs.writeFileSync(
    tmp,
    "deterministic-checks:\n- title: Ok\n  severity: auto\n  check: sync-xhr.js\n"
  );
  try {
    const checks = await loadChecks(loadRegistry(tmp));
    assert.equal(checks[0].severity, "auto");
  } finally {
    fs.rmSync(tmp);
  }
});

test("loadChecks rejects an invalid severity token", async () => {
  const tmp = path.join(os.tmpdir(), `bad-sev-registry-${process.pid}.yaml`);
  fs.writeFileSync(
    tmp,
    "deterministic-checks:\n- title: Bad\n  severity: nope\n  check: sync-xhr.js\n"
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

// ---- disguised-transmission (covert) + data-exfiltration (overt) ----
// Covert channels (data appended to an image/CSS/resource URL) are a flat
// error; a normal fetch to a remote host escalates for an options-page consent
// check. Local destinations and data-free covert loads are ignored.
test("disguised checks flag covert URLs built with appended data", () => {
  const res = (code) => disguisedResource.run(jsCtx(code)).length;
  const sty = (code) => disguisedStylesheet.run(jsCtx(code)).length;
  assert.equal(res('img.src = "https://x/?d=" + body;'), 1); // resource sink
  assert.equal(
    sty('el.style.backgroundImage = "url(https://x/?d=" + v + ")";'),
    1
  ); // stylesheet sink
  assert.equal(res('img.src = "./logo.png";'), 0); // local
  assert.equal(res('img.src = "https://x/logo.png";'), 0); // static, no data
  assert.equal(res('fetch("https://x/?d=" + body);'), 0); // overt, not covert
});

test("data-exfiltration makes a candidate per overt remote transmission only", () => {
  const candidates = (code) => {
    const out = dataExfiltration.run(jsCtx(code));
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
    jsCtx('fetch("https://api.example.com/", { body });')
  );
  const { findings } = out.llm.resolve(new Map([["X1", { verdict: "fail" }]]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].hint, "fetch()");
  assert.equal(findings[0].item, null);
});

test("scanNetworkSinks classifies channel, destination, appended data", () => {
  const one = (code) => scanNetworkSinks(code).hits[0];
  const img = one('img.src = "https://x/?d=" + v;');
  assert.equal(img.type, "element-src");
  assert.equal(img.channel, "covert");
  assert.equal(img.destClass, "remote");
  assert.equal(img.dataAppended, true);
  const beacon = one('navigator.sendBeacon("https://x", d);');
  assert.equal(beacon.channel, "overt");
  assert.equal(beacon.destClass, "remote");
  assert.equal(
    one("fetch(u, { body: messenger.messages.getFull(id) });").carriesData,
    true
  );
});

// ---- cleartext-transmission ----
// Any overt transmission to a remote host over a non-TLS scheme is an error,
// with or without a payload; encrypted (https/wss) and local destinations are
// fine, and covert channels are disguised-transmission's job.
test("cleartext-transmission flags overt http/ws/ftp remote sends only", () => {
  const n = (code) => cleartextTransmission.run(jsCtx(code)).length;
  assert.equal(n('fetch("http://api.example.com/x");'), 1); // GET, no payload
  assert.equal(n('new WebSocket("ws://x.example.com/feed");'), 1);
  assert.equal(n('fetch("ftp://files.example.com/x");'), 1);
  assert.equal(n('fetch("https://api.example.com/x");'), 0); // encrypted
  assert.equal(n('new WebSocket("wss://x.example.com/feed");'), 0); // encrypted
  assert.equal(n('fetch("/local.json");'), 0); // local
  assert.equal(n('img.src = "http://x/?d=" + body;'), 0); // covert, not overt
  const hit = cleartextTransmission.run(
    jsCtx('fetch("http://api.example.com/x");')
  )[0];
  assert.equal(hit.item, "api.example.com");
});

// ---- privacy-policy ----
// One manual-review escalation per distinct remote host of every overt
// transmission (the hosts list as the "where"); covert and local destinations
// do not trigger it.
test("privacy-policy escalates one entry per distinct remote host", () => {
  const esc = (code) => privacyPolicy.run(jsCtx(code)).escalations;
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
    nativeMessaging.run({ addon: { manifest } }).escalations;
  const declared = esc({ permissions: ["nativeMessaging"] });
  assert.equal(declared.length, 1);
  // A single whole-add-on reminder: no item to list (instructions name it).
  assert.equal(declared[0].item, undefined);
  assert.equal(esc({ optional_permissions: ["nativeMessaging"] }).length, 1);
  assert.equal(esc({ permissions: ["storage"] }).length, 0);
  assert.equal(esc({}).length, 0);
  assert.equal(nativeMessaging.run({ addon: {} }).escalations.length, 0);
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
  assert.equal(defaultLocaleMissing.run(ctx(locales, {})).length, 1);
  assert.equal(
    defaultLocaleMissing.run(ctx(locales, { default_locale: "en" })).length,
    0
  );
  assert.equal(defaultLocaleMissing.run(ctx({}, {})).length, 0);
  // unused: default_locale set, no _locales.
  assert.equal(
    defaultLocaleUnused.run(ctx({}, { default_locale: "en" })).length,
    1
  );
  assert.equal(
    defaultLocaleUnused.run(ctx(locales, { default_locale: "en" })).length,
    0
  );
  assert.equal(defaultLocaleUnused.run(ctx({}, {})).length, 0);
});

// ---- addon-icon-missing ----
// No defined add-on icon (absent `icons`, empty/blank values, or a malformed
// non-object) gets one advisory with no location; a declared icon passes; themes
// and dictionaries are exempt; an unparsed manifest is skipped.
test("addon-icon-missing flags an extension with no defined add-on icon", () => {
  const ctx = (manifest) => ({ addon: { manifest } });
  const out = addonIconMissing.run(ctx({ manifest_version: 3, name: "x" }));
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "manifest.json");
  assert.equal(out[0].loc, null);
  assert.equal(
    addonIconMissing.run(ctx({ icons: { 16: "icon-16.png" } })).length,
    0
  );
  assert.equal(addonIconMissing.run(ctx({ icons: {} })).length, 1);
  assert.equal(addonIconMissing.run(ctx({ icons: { 16: "  " } })).length, 1);
  assert.equal(addonIconMissing.run(ctx({ icons: "icon.png" })).length, 1);
  assert.equal(addonIconMissing.run(ctx({ theme: { colors: {} } })).length, 0);
  assert.equal(
    addonIconMissing.run(ctx({ dictionaries: { en: "x.dic" } })).length,
    0
  );
  assert.equal(addonIconMissing.run({ addon: { manifest: null } }).length, 0);
});

// ---- background-module ----
// A background script using static import/export needs the background declared
// "type": "module"; module syntax in a non-background file is ignored.
test("background-module flags module syntax without type: module", () => {
  const n = (code, background) =>
    backgroundModule.run(jsCtx(code, { background })).length;
  assert.equal(n('import x from "./y.js";', { scripts: ["f.js"] }), 1);
  assert.equal(n("export const a = 1;", { scripts: ["f.js"] }), 1);
  assert.equal(
    n('import x from "./y.js";', { scripts: ["f.js"], type: "module" }),
    0
  );
  assert.equal(n("console.log(1);", { scripts: ["f.js"] }), 0);
  assert.equal(n('import x from "./y.js";', { scripts: ["other.js"] }), 0);
});
