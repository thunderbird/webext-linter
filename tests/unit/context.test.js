// Unit tests for the sibling-ctx builders' assembly contract: they NEVER parse. The pipeline's
// extraction pass parses each source once and hands the results over already parsed; these
// builders only derive ctx.apiUsages from them, project the shared review env, and swap the
// per-artifact fields. What the pass itself extracts (and which files it skips) is tested in
// extract.test.js.

import { test } from "node:test";
import { REVIEW_MODE } from "../../src/lib/enum.js";
import assert from "node:assert/strict";

import { buildXpiCtxs, buildScaCtxs } from "../../src/checks/context.js";
import { collectJsSources } from "../../src/addon/sources.js";
import { runExtractionPass } from "../../src/checks/extract.js";

const addonWith = (files, nonAuthored = []) => ({
  files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
  bundled: { nonAuthored: new Set(nonAuthored), classified: [] },
});

// The shared review env the pipeline builds ONCE and hands to both builders. A test overrides
// only what it exercises; the rest are the review-level defaults.
const envWith = (over = {}) => ({
  schema: { s: 1 },
  options: {},
  mode: REVIEW_MODE.XPI,
  scaExpSource: undefined,
  scaNotRequired: false,
  invalidExperiment: false,
  manifest: null,
  manifestError: null,
  manifestLoc: null,
  manifestText: "",
  experiments: null,
  previous: null,
  llm: undefined,
  nonce: "0123456789abcdef",
  ...over,
});

// The builders never parse: a REVIEWABLE add-on's sources must arrive already through the
// extraction pass, or the builder throws (an empty corpus would mean "no code" and pass every
// code check vacuously). The pipeline parses in Phase 2/3; a test not about the sources
// satisfies the contract with this.
const parsed = (addon) => {
  const jsSources = collectJsSources(addon);
  runExtractionPass(jsSources, { schema: {} });
  return jsSources;
};

test("buildXpiCtxs assembles the sources it is handed, and parses nothing itself", () => {
  const xpi = addonWith({ "app.js": "export const x = 1;" });
  const jsSources = parsed(xpi);
  const { xpiCtx } = buildXpiCtxs(xpi, jsSources, envWith());
  // The pass's per-file results are carried through, and ctx.apiUsages is derived from them.
  assert.equal(xpiCtx.jsSources, jsSources);
  assert.ok(xpiCtx.jsSources[0].extracted.remoteJs);
  assert.equal(xpiCtx.apiUsages.length, 1);
  assert.equal(xpiCtx.apiUsages[0].file, "app.js");
});

test("buildXpiCtxs has no sources when the pipeline parsed none (a rejected Experiment)", () => {
  // The single reject check reads the manifest, the experiment classification and the schema -
  // never a line of code - so the pipeline hands no sources over. The XPI's files are NOT
  // parsed as a fallback.
  const xpi = addonWith({ "app.js": "export const x = 1;" });
  const { xpiCtx } = buildXpiCtxs(
    xpi,
    undefined,
    envWith({ invalidExperiment: true })
  );
  assert.deepEqual(xpiCtx.jsSources, []);
  assert.deepEqual(xpiCtx.apiUsages, []);
});

// The fail-open this closes: an empty corpus MEANS "this add-on has no code", so every code
// check would pass vacuously and the review would report a clean add-on whose JavaScript it
// never read - exit 1, no crash, no warning. Only a rejected Experiment may have no sources.
test("buildXpiCtxs throws when a reviewable built XPI arrives with no parsed sources", () => {
  const xpi = addonWith({ "app.js": "eval('danger');" });
  assert.throws(
    () => buildXpiCtxs(xpi, undefined, envWith()),
    /no parsed sources/
  );
});

// buildXpiCtxs builds the shipped ctx (siblings.xpi) from the XPI's OWN sources + api-usage, and
// marks it the shipped view ONLY in SCA - where the XPI is a distinct artifact from the review
// source. In an XPI review the XPI IS the review target (the pipeline aliases siblings.source to
// it), so it must NOT set the shipped-view reachability flag.
test("buildXpiCtxs carries the XPI's own sources; isShippedView only in SCA", () => {
  const xpi = addonWith({ "app.js": "export const x = 1;" });
  const xpiParsed = parsed(xpi);

  const inSca = buildXpiCtxs(
    xpi,
    xpiParsed,
    envWith({ mode: REVIEW_MODE.SCA })
  ).xpiCtx;
  // ctx.addon is a reviewView (a shallow copy without manifest/experiments); it carries the
  // XPI's files Map by reference, not the XPI object.
  assert.equal(inSca.addon.files, xpi.files);
  assert.equal(inSca.jsSources, xpiParsed);
  assert.equal(inSca.apiUsages.length, xpiParsed.length); // the XPI's OWN api-usage
  assert.equal(inSca.apiUsages[0].file, "app.js");
  assert.equal(inSca.isShippedView, true); // gates reachability's SCA fallback

  const inXpi = buildXpiCtxs(
    xpi,
    xpiParsed,
    envWith({ mode: REVIEW_MODE.XPI })
  ).xpiCtx;
  assert.equal(inXpi.isShippedView, undefined); // one artifact - not a distinct shipped view
});

// buildScaCtxs.buildCtx routes the SCA build corpus onto ctx.addon (the input: build seam),
// shares the review env, and empties the source-only jsSources/apiUsages. The corpus is
// projected through reviewView like every other ctx.addon, so a build check can never read
// ctx.addon.manifest against another artifact's files.
test("buildScaCtxs.buildCtx puts the build corpus on ctx.addon and strips manifest/sources", () => {
  const source = addonWith({ "src/app.js": "export const x = 1;" });
  const env = envWith({ mode: REVIEW_MODE.SCA, manifest: { name: "shipped" } });
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

  const { buildCtx } = buildScaCtxs(source, parsed(source), buildAddon, env);
  assert.equal(buildCtx.addon.files, buildFiles); // the build corpus is the artifact
  assert.equal(buildCtx.addon.manifest, undefined); // not allowlisted (no leak)
  assert.deepEqual(buildCtx.addon.nodeModules, ["node_modules"]); // committed-node-modules reads it
  assert.deepEqual(buildCtx.addon.archives, ["dist.zip"]); // committed-build-artifact reads it
  assert.deepEqual(buildCtx.addon.buildReview, {
    category: "npm",
    analyzed: true,
  }); // build-review checks read it
  assert.deepEqual(buildCtx.jsSources, []); // source-only, emptied
  assert.equal(buildCtx.apiUsages, undefined);
  assert.equal(buildCtx.schema, env.schema); // shared review env
  assert.equal(buildCtx.manifest, env.manifest); // shipped manifest stays for framing

  // An empty build corpus is still a valid, readable ctx - an input: build check skips cleanly
  // on it rather than crashing.
  const empty = buildScaCtxs(
    source,
    parsed(source),
    { files: new Map() },
    env
  ).buildCtx;
  assert.equal(empty.addon.files.size, 0);
});

// Symmetric to buildXpiCtxs: the readable source MUST arrive parsed (the pipeline parses it in
// Phase 3). An empty corpus would review a clean add-on whose source was never read.
test("buildScaCtxs throws when the source arrives with no parsed sources", () => {
  const source = addonWith({ "src/app.js": "eval('danger');" });
  assert.throws(
    () => buildScaCtxs(source, undefined, { files: new Map() }, envWith()),
    /no parsed sources/
  );
});

// The load-bearing invariant of building the client ONCE up front: every sibling ctx carries the
// SAME untrusted-content nonce (env.nonce), which the pipeline also built the LLM client with. If
// two siblings could mint their own, a summary's wrapped content and the client's framing would
// disagree and the injection guard would break.
test("every sibling ctx shares the one review nonce", () => {
  const source = addonWith({ "src/app.js": "export const x = 1;" });
  const xpi = addonWith({ "app.js": "export const x = 1;" });
  const env = envWith({ mode: REVIEW_MODE.SCA, nonce: "deadbeefdeadbeef" });
  const { xpiCtx, manifestCtx } = buildXpiCtxs(xpi, parsed(xpi), env);
  const { scaCtx, buildCtx } = buildScaCtxs(
    source,
    parsed(source),
    { files: new Map() },
    env
  );
  for (const ctx of [xpiCtx, manifestCtx, scaCtx, buildCtx]) {
    assert.equal(ctx.__nonce, env.nonce);
  }
});

// reviewView is an ALLOWLIST: ctx.addon carries ONLY the intrinsic fields a check reads, so a
// field on the underlying Addon (manifest, experiments, and crucially buildFiles - the SCA build
// tree) can never leak onto the check-facing surface. And the LLM credentials are NEVER on the
// ctx: the token stays in the pipeline (it builds the client); env carries only the built llm
// and the check-facing options.
test("ctx.addon allowlists intrinsic fields; no manifest/experiments/buildFiles/creds leak", () => {
  const xpi = addonWith({ "app.js": "export const x = 1;" });
  xpi.manifest = { name: "m" };
  xpi.experiments = { groups: [] };
  xpi.buildFiles = { files: new Map([["build/x.sh", Buffer.from("x")]]) };
  const { xpiCtx } = buildXpiCtxs(
    xpi,
    parsed(xpi),
    envWith({ options: { allowExperiments: true } })
  );
  // The build tree / shipped-authoritative fields are NOT reachable through ctx.addon.
  assert.equal(xpiCtx.addon.buildFiles, undefined);
  assert.equal(xpiCtx.addon.manifest, undefined);
  assert.equal(xpiCtx.addon.experiments, undefined);
  assert.ok(xpiCtx.addon.files); // the intrinsic corpus IS there
  // No secret token anywhere on the check-facing ctx (the builder never receives one).
  assert.equal("llmApiKey" in xpiCtx.options, false);
  assert.equal(xpiCtx.options.allowExperiments, true); // a real option stays
});

// buildXpiCtxs.manifestCtx gives an input: manifest check the shipped manifest but NO file
// corpus - ctx.addon.files is empty, so it is impossible to reach a file artifact, while the
// shipped manifest/schema come from the review env.
test("buildXpiCtxs.manifestCtx has an empty file corpus and keeps the shipped manifest", () => {
  const xpi = addonWith({ "app.js": "export const x = 1;" });
  const env = envWith({ manifest: { name: "shipped" } });
  const { manifestCtx } = buildXpiCtxs(xpi, parsed(xpi), env);
  assert.equal(manifestCtx.addon.files.size, 0); // no file corpus - cannot read a file artifact
  assert.equal(manifestCtx.addon.manifest, undefined); // reviewView stripped it
  assert.deepEqual(manifestCtx.jsSources, []);
  assert.equal(manifestCtx.apiUsages, undefined);
  assert.equal(manifestCtx.manifest, env.manifest); // shipped manifest from the env
  assert.equal(manifestCtx.schema, env.schema); // shared review env
});

// End-to-end: an input: manifest check runs on the empty-corpus manifestCtx and yields the SAME
// result as on the full xpiCtx - it reads only the shipped manifest, so the missing file corpus
// cannot change its verdict (and it does not crash reading an empty ctx.addon).
test("an input: manifest check reads only the manifest (same result on the no-corpus ctx)", async () => {
  const xpi = addonWith({ "a.js": "export const x = 1;" });
  const env = envWith({ manifest: null }); // a missing manifest is what manifest-missing flags
  const { xpiCtx, manifestCtx } = buildXpiCtxs(xpi, parsed(xpi), env);
  assert.equal(manifestCtx.addon.files.size, 0); // enforced: no file corpus
  const check = (await import("../../src/checks/rules/manifest-missing.js"))
    .default;
  const onFull = check.run(xpiCtx);
  const onManifest = check.run(manifestCtx);
  assert.ok(onFull.length > 0); // the manifest is missing -> a finding
  assert.deepEqual(onManifest, onFull); // identical - the empty corpus is irrelevant
});
