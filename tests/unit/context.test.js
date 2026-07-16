// Unit tests for buildRunContext's assembly contract: it NEVER parses. The pipeline's
// extraction pass parses each source once and hands the results over as
// preParsedJsSources; this assembler only derives ctx.apiUsages from them and swaps the
// artifact-specific fields for the sibling contexts. What the pass itself extracts (and
// which files it skips) is tested in extract.test.js.

import { test } from "node:test";
import { REVIEW_MODE } from "../../src/lib/enum.js";
import assert from "node:assert/strict";

import {
  buildRunContext,
  buildShippedCtx,
  buildScaBuildCtx,
  buildManifestCtx,
} from "../../src/checks/context.js";
import { collectJsSources } from "../../src/addon/sources.js";
import { runExtractionPass } from "../../src/checks/extract.js";

const addonWith = (files, nonAuthored = []) => ({
  files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
  bundled: { nonAuthored: new Set(nonAuthored), classified: [] },
});

// buildRunContext never parses: a REVIEWABLE add-on's sources must arrive already through
// the extraction pass, or it throws (an empty corpus would mean "no code" and pass every
// code check vacuously). The pipeline does this in Phase 3; a test not about the sources
// satisfies the contract with this.
const parsed = (addon) => {
  const jsSources = collectJsSources(addon);
  runExtractionPass(jsSources, { schema: {} });
  return jsSources;
};

test("buildRunContext assembles the sources it is handed, and parses nothing itself", () => {
  const addon = addonWith({ "app.js": "export const x = 1;" });
  const jsSources = collectJsSources(addon);
  runExtractionPass(jsSources, { schema: {} });
  const ctx = buildRunContext({
    addon,
    schema: {},
    options: {},
    preParsedJsSources: jsSources,
  });
  // The pass's per-file results are carried through, and ctx.apiUsages is derived from them.
  assert.equal(ctx.jsSources, jsSources);
  assert.ok(ctx.jsSources[0].extracted.remoteJs);
  assert.equal(ctx.apiUsages.length, 1);
  assert.equal(ctx.apiUsages[0].file, "app.js");
});

test("buildRunContext has no sources when the pipeline parsed none (a rejected Experiment)", () => {
  // The single reject check reads the manifest, the experiment classification and the
  // schema - never a line of code - so the pipeline hands no sources over. The add-on's
  // files are NOT parsed as a fallback.
  const addon = addonWith({ "app.js": "export const x = 1;" });
  const ctx = buildRunContext({
    addon,
    schema: {},
    options: {},
    invalidExperiment: true,
  });
  assert.deepEqual(ctx.jsSources, []);
  assert.deepEqual(ctx.apiUsages, []);
});

// The fail-open this closes: an empty corpus MEANS "this add-on has no code", so every code
// check would pass vacuously and the review would report a clean add-on whose JavaScript it
// never read - exit 1, no crash, no warning. Only a rejected Experiment may have no sources.
test("buildRunContext throws when a reviewable add-on arrives with no parsed sources", () => {
  const addon = addonWith({ "app.js": "eval('danger');" });
  assert.throws(
    () => buildRunContext({ addon, schema: {}, options: {} }),
    /no parsed sources/
  );
});

// buildShippedCtx swaps the artifact-specific fields to the built XPI's (files, jsSources,
// and the XPI's OWN apiUsages), shares the run-state, and marks itself the shipped view. When
// the XPI IS the review target (an XPI review) it is a no-op - the same ctx object - so
// callers route unconditionally through it.
test("buildShippedCtx swaps the artifact fields and is a no-op in an XPI review", () => {
  const source = addonWith({ "src/app.js": "export const x = 1;" });
  const xpi = addonWith({ "app.js": "export const x = 1;" });
  const ctx = buildRunContext({
    addon: source,
    schema: { s: 1 },
    options: {},
    mode: REVIEW_MODE.SCA,
    preParsedJsSources: parsed(source),
  });

  // The XPI is a SECOND artifact here, so the pipeline hands over its sources - already
  // through the full extraction pass (Phase 2), because a check never parses.
  const xpiParsedSources = parsed(xpi);
  const shipped = buildShippedCtx(ctx, xpi, xpiParsedSources);
  // ctx.addon is a reviewView (a shallow copy without manifest/experiments), so the
  // shipped view's addon carries the XPI's files Map by reference, not the XPI object.
  assert.equal(shipped.addon.files, xpi.files);
  assert.equal(shipped.jsSources, xpiParsedSources); // the XPI's own, not the source's
  assert.equal(shipped.jsSources[0].file, "app.js");
  // The XPI's OWN per-source api-usage (from its full pass), NOT the source's.
  assert.equal(shipped.apiUsages.length, xpiParsedSources.length);
  assert.equal(shipped.apiUsages[0].file, "app.js");
  assert.equal(shipped.schema, ctx.schema); // shared run-state
  assert.equal(shipped.isShippedView, true); // gates reachability's SCA fallback

  // ...and it REFUSES to build a shipped view over unparsed sources: its input:xpi checks
  // read the load graph off them, and a check never parses.
  assert.throws(
    () => buildShippedCtx(ctx, xpi),
    /have not been through the extraction pass/
  );

  // XPI review: the built XPI IS the review target -> the same ctx object, no copy,
  // and NOT marked a shipped view (there is only one artifact).
  const same = buildShippedCtx(ctx, ctx.addon);
  assert.equal(same, ctx);
  assert.equal(same.isShippedView, undefined);
});

// buildScaBuildCtx routes the SCA build corpus onto ctx.addon (the input: build seam),
// shares run-state, and empties the source-only jsSources/apiUsages. The corpus is
// projected through reviewView like every other ctx.addon, so a build check can never
// read ctx.addon.manifest against another artifact's files.
test("buildScaBuildCtx puts the build corpus on ctx.addon and strips manifest/sources", () => {
  const source = addonWith({ "src/app.js": "export const x = 1;" });
  const ctx = buildRunContext({
    addon: source,
    schema: { s: 1 },
    options: {},
    mode: REVIEW_MODE.SCA,
    preParsedJsSources: parsed(source),
  });
  const buildFiles = new Map([["build.sh", Buffer.from("echo hi")]]);
  // A full-addon shape (manifest present) must NOT leak through: reviewView allowlists.
  // buildReview (the setup build classification) MUST survive - the input:build checks read it.
  const buildAddon = {
    files: buildFiles,
    manifest: { name: "leak" },
    nodeModules: ["node_modules"],
    archives: ["dist.zip"],
    buildReview: { category: "npm", analyzed: true },
  };

  const build = buildScaBuildCtx(ctx, buildAddon);
  assert.equal(build.addon.files, buildFiles); // the build corpus is the artifact
  assert.equal(build.addon.manifest, undefined); // not allowlisted (no leak)
  assert.deepEqual(build.addon.nodeModules, ["node_modules"]); // committed-node-modules reads it
  assert.deepEqual(build.addon.archives, ["dist.zip"]); // committed-build-artifact reads it
  assert.deepEqual(build.addon.buildReview, {
    category: "npm",
    analyzed: true,
  }); // build-review checks read it
  assert.deepEqual(build.jsSources, []); // source-only, emptied
  assert.equal(build.apiUsages, undefined);
  assert.equal(build.schema, ctx.schema); // shared run-state
  assert.equal(build.manifest, ctx.manifest); // shipped manifest stays for framing

  // An empty build corpus is still a valid, readable ctx - an input: build check skips
  // cleanly on it rather than crashing.
  const empty = buildScaBuildCtx(ctx, { files: new Map() });
  assert.equal(empty.addon.files.size, 0);
});

// reviewView is an ALLOWLIST: ctx.addon carries ONLY the intrinsic fields a check reads, so a
// field on the underlying Addon (manifest, experiments, and crucially buildFiles - the SCA
// build tree) can never leak onto the check-facing surface. And the LLM credentials are NEVER
// on ctx.options - the secret token must not sit where a check could read it (a check reaches
// the model only through ctx.llm).
test("ctx.addon allowlists intrinsic fields; no manifest/experiments/buildFiles/creds leak", () => {
  const addon = addonWith({ "app.js": "export const x = 1;" });
  addon.manifest = { name: "m" };
  addon.experiments = { groups: [] };
  addon.buildFiles = { files: new Map([["build/x.sh", Buffer.from("x")]]) };
  const ctx = buildRunContext({
    addon,
    schema: {},
    options: { allowExperiments: true },
    preParsedJsSources: parsed(addon),
    llmApiKey: "sk-SECRET",
    llmApiType: "claude",
    llmApiUrl: "http://x",
    llmVerified: false,
  });
  // The build tree / shipped-authoritative fields are NOT reachable through ctx.addon.
  assert.equal(ctx.addon.buildFiles, undefined);
  assert.equal(ctx.addon.manifest, undefined);
  assert.equal(ctx.addon.experiments, undefined);
  assert.ok(ctx.addon.files); // the intrinsic corpus IS there
  // The secret token is NOT on the check-facing options.
  assert.equal("llmApiKey" in ctx.options, false);
  assert.equal(ctx.options.allowExperiments, true); // a real option stays
});

// buildManifestCtx gives an input: manifest check the shipped manifest but NO file
// corpus - ctx.addon.files is empty, so it is impossible to reach a file artifact,
// while the shipped manifest/schema are inherited from the review ctx.
test("buildManifestCtx has an empty file corpus and keeps the shipped manifest", () => {
  const manifestAddon = addonWith({ "src/app.js": "export const x = 1;" });
  const ctx = buildRunContext({
    addon: manifestAddon,
    schema: { s: 1 },
    options: {},
    mode: REVIEW_MODE.SCA,
    preParsedJsSources: parsed(manifestAddon),
  });
  const man = buildManifestCtx(ctx);
  assert.equal(man.addon.files.size, 0); // no file corpus - cannot read a file artifact
  assert.equal(man.addon.manifest, undefined); // reviewView stripped it
  assert.deepEqual(man.jsSources, []);
  assert.equal(man.apiUsages, undefined);
  assert.equal(man.manifest, ctx.manifest); // shipped manifest inherited
  assert.equal(man.schema, ctx.schema); // shared run-state
});

// End-to-end: an input: manifest check runs on the empty-corpus ctx and yields the SAME
// result as on the full ctx - it reads only the shipped manifest, so the missing file
// corpus cannot change its verdict (and it does not crash reading an empty ctx.addon).
test("an input: manifest check reads only the manifest (same result on the no-corpus ctx)", async () => {
  const full = {
    addon: { files: new Map([["a.js", Buffer.from("x")]]) },
    manifest: null, // a missing manifest is what manifest-missing flags
    manifestError: null,
    jsSources: [],
    apiUsages: [],
  };
  const man = buildManifestCtx(full);
  assert.equal(man.addon.files.size, 0); // enforced: no file corpus
  const check = (await import("../../src/checks/rules/manifest-missing.js"))
    .default;
  const onFull = check.run(full);
  const onManifest = check.run(man);
  assert.ok(onFull.length > 0); // the manifest is missing -> a finding
  assert.deepEqual(onManifest, onFull); // identical - the empty corpus is irrelevant
});
