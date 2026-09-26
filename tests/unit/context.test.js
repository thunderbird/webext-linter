// Unit tests for the sibling-ctx builders' assembly contract: they NEVER parse. The pipeline's
// extraction pass parses each source once and hands the results over already parsed; these
// builders only derive ctx.apiUsages from them, project the shared review env, and swap the
// per-artifact fields. What the pass itself extracts (and which files it skips) is tested in
// extract.test.js.

import { test } from "node:test";
import { REVIEW_MODE } from "../../src/lib/enum.js";
import assert from "node:assert/strict";

import { buildXpiCtx, buildScaCtxs } from "../../src/checks/context.js";
import { collectJsSources } from "../../src/addon/sources.js";
import { runExtractionPass } from "../../src/checks/extract.js";
import { SYMLINK_CAUSE } from "../../src/lib/enum.js";

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
  experiments: null,
  previous: null,
  nonce: "0123456789abcdef",
  ...over,
});

// The shipped manifest.json as the artifact carries it: one record, which is what the env holds
// and every sibling ctx is handed by reference.
const shippedRecord = {
  json: { name: "shipped" },
  text: '{ "name": "shipped" }',
  error: null,
  loc: null,
};

// The builders never parse: a REVIEWABLE add-on's sources must arrive already through the
// extraction pass, or the builder throws (an empty corpus would mean "no code" and pass every
// code check vacuously). The pipeline parses in Phase 2/3; a test not about the sources
// satisfies the contract with this.
const parsed = (addon) => {
  const jsSources = collectJsSources(addon);
  runExtractionPass(jsSources, { schema: {} });
  return jsSources;
};

test("buildXpiCtx assembles the sources it is handed, and parses nothing itself", () => {
  const xpi = addonWith({ "app.js": "export const x = 1;" });
  const jsSources = parsed(xpi);
  const xpiCtx = buildXpiCtx(xpi, jsSources, envWith());
  // The pass's per-file results are carried through, and ctx.apiUsages is derived from them.
  assert.equal(xpiCtx.jsSources, jsSources);
  assert.ok(xpiCtx.jsSources[0].extracted.remoteJs);
  assert.equal(xpiCtx.apiUsages.length, 1);
  assert.equal(xpiCtx.apiUsages[0].file, "app.js");
});

test("buildXpiCtx has no sources when the pipeline parsed none (a rejected Experiment)", () => {
  // The single reject check reads the manifest.json, the experiment classification and the schema -
  // never a line of code - so the pipeline hands no sources over. The XPI's files are NOT
  // parsed as a fallback.
  const xpi = addonWith({ "app.js": "export const x = 1;" });
  const xpiCtx = buildXpiCtx(
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
test("buildXpiCtx throws when a reviewable built XPI arrives with no parsed sources", () => {
  const xpi = addonWith({ "app.js": "eval('danger');" });
  assert.throws(
    () => buildXpiCtx(xpi, undefined, envWith()),
    /no parsed sources/
  );
});

// buildXpiCtx builds the shipped ctx (siblings.xpi) from the XPI's OWN sources + api-usage, and
// marks it the shipped view ONLY in SCA - where the XPI is a distinct artifact from the review
// source. In an XPI review the XPI IS the review target (the pipeline aliases siblings.source to
// it), so it must NOT set the shipped-view reachability flag.
test("buildXpiCtx carries the XPI's own sources; isShippedView only in SCA", () => {
  const xpi = addonWith({ "app.js": "export const x = 1;" });
  const xpiParsed = parsed(xpi);

  const inSca = buildXpiCtx(xpi, xpiParsed, envWith({ mode: REVIEW_MODE.SCA }));
  // ctx.addon is a reviewView (a shallow copy without manifest.json/experiments); it carries the
  // XPI's files Map by reference, not the XPI object.
  assert.equal(inSca.addon.files, xpi.files);
  assert.equal(inSca.jsSources, xpiParsed);
  assert.equal(inSca.apiUsages.length, xpiParsed.length); // the XPI's OWN api-usage
  assert.equal(inSca.apiUsages[0].file, "app.js");
  assert.equal(inSca.isShippedView, true); // gates reachability's SCA fallback

  // The two SCA paths reach a check AS GIVEN, absolute - never a prefix derived from them.
  // The --sca-* paths are NOT on the ctx: where the source and the Experiment sit is
  // settled once, when the archive is split into views (src/addon/load.js scaViews), and a
  // check reads the corpus it was routed rather than a path on disk. They stay on `meta`,
  // for the report.
  const withPaths = buildXpiCtx(
    xpi,
    xpiParsed,
    envWith({
      mode: REVIEW_MODE.SCA,
      scaExpSource: "/r/src/experiments",
    })
  );
  assert.equal(withPaths.scaExpSource, undefined);

  const inXpi = buildXpiCtx(xpi, xpiParsed, envWith({ mode: REVIEW_MODE.XPI }));
  assert.equal(inXpi.isShippedView, undefined); // one artifact - not a distinct shipped view
});

// The Experiment implementation reaches a check. ctx.addon.files deliberately EXCLUDES it,
// so the WebExtension API/permission/eval checks never false-positive on Services or
// ChromeUtils - but a check that reviews a file for what it IS (minified, obfuscated, a
// known library) must still see it: privileged code shipped unreadable is worse, not
// better. Such a check reads ctx.addon.files and ctx.addon.experiment as one corpus, which
// is only possible because both are allowlisted and, for an Experiment inside the add-on,
// keyed in the same frame.
test("a check can merge the source and Experiment corpora off ctx.addon", () => {
  const source = addonWith({ "app.js": "export const x = 1;" });
  const experiment = new Map([
    ["experiment/exp.js", Buffer.from("ChromeUtils.import('x');")],
  ]);
  source.experiment = experiment;
  const env = envWith({ mode: REVIEW_MODE.SCA });

  const { sourceCtx } = buildScaCtxs(source, parsed(source), env);

  // Apart: the WebExtension checks see the add-on's code and nothing privileged.
  assert.ok(sourceCtx.addon.files.has("app.js"));
  assert.ok(!sourceCtx.addon.files.has("experiment/exp.js"));
  // Allowlisted, so a check that needs it can reach it at all (reviewView is a whitelist -
  // an un-named field would silently read undefined here).
  assert.equal(sourceCtx.addon.experiment, experiment);

  // Together: the corpus a what-is-this-file check reviews.
  const merged = new Map([
    ...sourceCtx.addon.files,
    ...sourceCtx.addon.experiment,
  ]);
  assert.deepEqual(
    [...merged.keys()].sort(),
    ["app.js", "experiment/exp.js"],
    "both artifacts' files, one corpus"
  );
  assert.match(merged.get("experiment/exp.js").toString("utf8"), /ChromeUtils/);

  // In an XPI review there is no Experiment view to merge - the shipped artifact carries
  // its experiment code like any other file, so the field is simply absent.
  const xpiOnly = buildScaCtxs(
    addonWith({ "app.js": "1;" }),
    parsed(addonWith({ "app.js": "1;" })),
    env
  ).sourceCtx;
  assert.equal(xpiOnly.addon.experiment, undefined);
});

// buildScaCtxs.scaCtx routes the SCA archive onto ctx.addon (the input: sca seam),
// shares the review env, and empties the source-only jsSources/apiUsages. The corpus is
// projected through reviewView like every other ctx.addon, so a build check can never read
// ctx.addon.manifest against another artifact's files.
test("buildScaCtxs.scaCtx puts the archive on ctx.addon and strips manifest/sources", () => {
  const source = addonWith({ "src/app.js": "export const x = 1;" });
  const env = envWith({
    mode: REVIEW_MODE.SCA,
    manifest: shippedRecord,
  });
  // The source ctx and the build ctx are over the ONE corpus the archive carries, so what
  // distinguishes them is the parsed source, not the files. A full-addon shape (manifest.json
  // present) must NOT leak through: reviewView allowlists. buildReview (what setup found in
  // the build) MUST survive - the input:sca checks read it.
  const archive = {
    ...source,
    manifest: { json: { name: "leak" }, text: "{}", error: null, loc: null },
    nodeModules: ["node_modules"],
    archives: ["dist.zip"],
    symlinks: [{ path: "libs/out", cause: SYMLINK_CAUSE.OUTSIDE }],
    directories: ["libs"],
    buildReview: { unresolved: [], anchor: "package.json" },
  };

  const { sourceCtx, scaCtx } = buildScaCtxs(archive, parsed(source), env);
  assert.equal(scaCtx.addon.files, archive.files); // the archive's one corpus
  assert.equal(scaCtx.addon.files, sourceCtx.addon.files); // the same one both routes read
  assert.equal(scaCtx.addon.manifest, undefined); // not allowlisted (no leak)
  assert.deepEqual(scaCtx.addon.nodeModules, ["node_modules"]); // committed-node-modules reads it
  assert.deepEqual(scaCtx.addon.archives, ["dist.zip"]); // committed-build-artifact reads it
  // sca-invalid-symlink reads it
  assert.equal(scaCtx.addon.symlinks.length, 1);
  assert.equal(scaCtx.addon.symlinks[0].path, "libs/out");
  assert.equal(scaCtx.addon.symlinks[0].cause, SYMLINK_CAUSE.OUTSIDE);
  // the file:/link: walk a lock check runs reads it
  assert.deepEqual(scaCtx.addon.directories, ["libs"]);
  assert.deepEqual(scaCtx.addon.buildReview, {
    unresolved: [],
    anchor: "package.json",
  }); // build-review checks read it
  assert.deepEqual(scaCtx.jsSources, []); // source-only, emptied
  assert.equal(scaCtx.apiUsages, undefined);
  assert.equal(scaCtx.schema, env.schema); // shared review env
  assert.equal(scaCtx.manifest, env.manifest); // shipped manifest stays for framing

  // An empty corpus is still a valid, readable ctx - an input: sca check skips cleanly on it
  // rather than crashing.
  const empty = buildScaCtxs(
    { ...source, files: new Map() },
    parsed(source),
    env
  ).scaCtx;
  assert.equal(empty.addon.files.size, 0);
});

// Symmetric to buildXpiCtx: the readable source MUST arrive parsed (the pipeline parses it in
// Phase 3). An empty corpus would review a clean add-on whose source was never read.
test("buildScaCtxs throws when the source arrives with no parsed sources", () => {
  const source = addonWith({ "src/app.js": "eval('danger');" });
  assert.throws(
    () => buildScaCtxs(source, undefined, envWith()),
    /no parsed sources/
  );
});

// reviewView is an ALLOWLIST: ctx.addon carries ONLY the intrinsic fields a check reads, so a
// field on the underlying Addon (manifest.json, experiments, and `skipped` - load-time
// narration no check answers) can never leak onto the check-facing surface. And no credentials
// are on the ctx: the token stays in the pipeline (it builds the client); env carries only the
// review-level and the check-facing options.
test("ctx.addon allowlists intrinsic fields; no manifest/experiments/skipped/creds leak", () => {
  const xpi = addonWith({ "app.js": "export const x = 1;" });
  xpi.manifest = { name: "m" };
  xpi.experiments = { groups: [] };
  xpi.skipped = ["Skipping symlink (not packaged): link.js"];
  const xpiCtx = buildXpiCtx(
    xpi,
    parsed(xpi),
    envWith({ options: { allowExperiments: true } })
  );
  // The load-narration / shipped-authoritative fields are NOT reachable through ctx.addon.
  assert.equal(xpiCtx.addon.skipped, undefined);
  assert.equal(xpiCtx.addon.manifest, undefined);
  assert.equal(xpiCtx.addon.experiments, undefined);
  assert.ok(xpiCtx.addon.files); // the intrinsic corpus IS there
  // No secret token anywhere on the check-facing ctx (the builder never receives one).
  assert.equal("apiKey" in xpiCtx.options, false);
  assert.equal(xpiCtx.options.allowExperiments, true); // a real option stays
});

// A manifest.json check's verdict comes from the RECORD, not from the corpus it is routed to:
// ctx.manifest is the shipped answer, projected from the review env, so the check reads the
// same thing whichever artifact the review target is. That is why these checks need no corpus
// of their own - they ask ctx.manifest and nothing else.
test("a manifest.json check reads the record, not the routed corpus", async () => {
  const xpi = addonWith({ "a.js": "export const x = 1;" });
  const env = envWith({ manifest: null }); // a missing manifest is what manifest-missing flags
  const xpiCtx = buildXpiCtx(xpi, parsed(xpi), env);
  assert.ok(xpiCtx.addon.files.size > 0, "the routed artifact does have files");
  const check = (await import("../../src/checks/rules/manifest-missing.js"))
    .default;
  // The corpus is non-empty and holds no manifest.json either way: the finding comes from
  // ctx.manifest being null, which is the shipped artifact's answer.
  assert.ok(check.run(xpiCtx).findings.length > 0);
});
