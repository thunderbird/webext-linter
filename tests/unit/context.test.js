// Unit tests for the sibling-ctx builders' assembly contract: they NEVER parse. The pipeline's
// extraction pass parses each source once and hands the results over already parsed; these
// builders only derive ctx.apiUsages from them, project the shared review env, and swap the
// per-artifact fields. What the pass itself extracts (and which files it skips) is tested in
// extract.test.js.

import { test } from "node:test";
import { REVIEW_MODE } from "../../src/lib/enum.js";
import assert from "node:assert/strict";

import { buildXpiCtx, buildScaCtx } from "../../src/checks/context.js";
import { collectJsSources } from "../../src/addon/sources.js";
import { runExtractionPass } from "../../src/checks/extract.js";
import { SYMLINK_CAUSE } from "../../src/lib/enum.js";
import { addonOf, noManifest } from "./manifest-ctx.js";

const addonWith = (files, nonAuthored = []) => ({
  ...addonOf(files),
  bundled: { nonAuthored: new Set(nonAuthored), classified: [] },
});

// The shared review env the pipeline builds ONCE and hands to both builders. A test overrides
// only what it exercises; the rest are the review-level defaults.
const envWith = (over = {}) => ({
  schema: { s: 1 },
  options: {},
  mode: REVIEW_MODE.XPI,
  scaExpSource: undefined,
  invalidExperiment: false,
  manifest: noManifest(),
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
// extraction pass, or the builder throws (no files would mean "no code" and pass every
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

// The fail-open this closes: no files MEANS "this add-on has no code", so every code
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
  // ctx.artifact IS the XPI, so its files Map is the XPI's by identity.
  assert.equal(inSca.artifact.files, xpi.files);
  assert.equal(inSca.jsSources, xpiParsed);
  assert.equal(inSca.apiUsages.length, xpiParsed.length); // the XPI's OWN api-usage
  assert.equal(inSca.apiUsages[0].file, "app.js");
  assert.equal(inSca.isShippedView, true); // gates reachability's SCA fallback

  // The two SCA paths reach a check AS GIVEN, absolute - never a prefix derived from them.
  // The --sca-* paths are NOT on the ctx: where the source and the Experiment sit is
  // settled once, when the archive is split into views (src/addon/load.js scaViews), and a
  // check reads the files it was routed rather than a path on disk. They stay on `meta`,
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

// The Experiment implementation reaches a check. ctx.artifact.files deliberately EXCLUDES it,
// so the WebExtension API/permission/eval checks never false-positive on Services or
// ChromeUtils - but a check that reviews a file for what it IS (minified, obfuscated, a
// known library) must still see it: privileged code shipped unreadable is worse, not
// better. Such a check reads ctx.artifact.files and ctx.artifact.experiment as one set of files, us, which
// is only possible because both are allowlisted and, for an Experiment inside the add-on,
// keyed in the same frame.
test("a check can merge the source and Experiment views off ctx.artifact", () => {
  const source = addonWith({ "app.js": "export const x = 1;" });
  const experiment = new Map([
    ["experiment/exp.js", Buffer.from("ChromeUtils.import('x');")],
  ]);
  source.experiment = experiment;
  const env = envWith({ mode: REVIEW_MODE.SCA });

  const scaCtx = buildScaCtx(source, parsed(source), env);

  // Apart: the WebExtension checks see the add-on's code and nothing privileged.
  assert.ok(scaCtx.artifact.files.has("app.js"));
  assert.ok(!scaCtx.artifact.files.has("experiment/exp.js"));
  // Reachable by identity, so a check that needs the privileged files reads the real one.
  assert.equal(scaCtx.artifact.experiment, experiment);

  // Together: the files a what-is-this-file check reviews.
  const merged = new Map([
    ...scaCtx.artifact.files,
    ...scaCtx.artifact.experiment,
  ]);
  assert.deepEqual(
    [...merged.keys()].sort(),
    ["app.js", "experiment/exp.js"],
    "both artifacts' files, read as one"
  );
  assert.match(merged.get("experiment/exp.js").toString("utf8"), /ChromeUtils/);

  // In an XPI review there is no Experiment view to merge - the shipped artifact carries
  // its experiment code like any other file, so the field is simply absent.
  const xpiOnly = buildScaCtx(
    addonWith({ "app.js": "1;" }),
    parsed(addonWith({ "app.js": "1;" })),
    env
  );
  assert.equal(xpiOnly.artifact.experiment, undefined);
});

// buildScaCtx routes the archive onto ctx.artifact - the seam both the input: sca checks
// and, as the review target, the input: source ones read - and shares the review env. The
// artifact is linked like every other ctx.artifact, so a build check can never read
// ctx.artifact.manifest against another artifact's files.
test("buildScaCtx puts the archive on ctx.artifact, with its sources", () => {
  const source = addonWith({ "src/app.js": "export const x = 1;" });
  const env = envWith({
    mode: REVIEW_MODE.SCA,
    manifest: shippedRecord,
  });
  // ONE ctx over the archive: the build checks and the code checks read the same object,
  // and what separates them is the route each declared. Everything the archive carries is
  // reachable, buildReview (what setup found in the build) included - the input:sca checks
  // read it.
  const archive = {
    ...source,
    nodeModules: ["node_modules"],
    archives: ["dist.zip"],
    symlinks: [{ path: "libs/out", cause: SYMLINK_CAUSE.OUTSIDE }],
    directories: ["libs"],
    buildReview: { unresolved: [], anchor: "package.json" },
  };

  const scaCtx = buildScaCtx(archive, parsed(source), env);
  // The artifact IS the archive - one object, not a projection of some of its fields.
  assert.equal(scaCtx.artifact, archive);
  assert.deepEqual(scaCtx.artifact.nodeModules, ["node_modules"]); // committed-node-modules reads it
  assert.deepEqual(scaCtx.artifact.archives, ["dist.zip"]); // committed-build-artifact reads it
  // sca-invalid-symlink reads it
  assert.equal(scaCtx.artifact.symlinks.length, 1);
  assert.equal(scaCtx.artifact.symlinks[0].path, "libs/out");
  assert.equal(scaCtx.artifact.symlinks[0].cause, SYMLINK_CAUSE.OUTSIDE);
  // the file:/link: walk a lock check runs reads it
  assert.deepEqual(scaCtx.artifact.directories, ["libs"]);
  assert.deepEqual(scaCtx.artifact.buildReview, {
    unresolved: [],
    anchor: "package.json",
  }); // build-review checks read it
  // And it carries the parsed source: one ctx serves both routes, so the build checks and
  // the code checks cannot disagree about what the archive holds.
  assert.equal(scaCtx.jsSources.length, 1);
  assert.ok(scaCtx.apiUsages);
  assert.equal(scaCtx.schema, env.schema); // shared review env
  assert.equal(scaCtx.manifest, env.manifest); // shipped manifest stays for framing

  // An artifact with no files is still a valid, readable ctx - an input: sca check skips cleanly on it
  // rather than crashing.
  const empty = buildScaCtx(
    { ...source, files: new Map() },
    parsed(source),
    env
  );
  assert.equal(empty.artifact.files.size, 0);
});

// Symmetric to buildXpiCtx: the readable source MUST arrive parsed (the pipeline parses it in
// Phase 3). No files would review a clean add-on whose source was never read.
test("buildScaCtx throws when the source arrives with no parsed sources", () => {
  const source = addonWith({ "src/app.js": "eval('danger');" });
  assert.throws(
    () => buildScaCtx(source, undefined, envWith()),
    /no parsed sources/
  );
});

// ctx.artifact IS the loaded artifact, linked by pointer - not a copy of some of its fields.
// That is what makes provenance readable: ctx.artifact.files are demonstrably THAT artifact's
// files. What keeps a check away from the artifact it was not routed to is the routing, not a
// projection. The shipped answers still arrive from the env rather than off the artifact, and
// no credentials are on the ctx: the token stays in the pipeline (it builds the client).
test("ctx.artifact is the loaded artifact itself; the shipped answers come from env", () => {
  const xpi = addonWith({ "app.js": "export const x = 1;" });
  const env = envWith({
    options: { allowExperiments: true },
    manifest: shippedRecord,
  });
  const xpiCtx = buildXpiCtx(xpi, parsed(xpi), env);
  assert.equal(xpiCtx.artifact, xpi, "the same object the loader produced");
  // The two shipped-authoritative answers are asked of the XPI once and shared, so they sit
  // on the ctx rather than on whichever artifact a check was routed to.
  assert.equal(xpiCtx.manifest, env.manifest);
  assert.equal(xpiCtx.experiments, env.experiments);
  // And what a review DERIVES has its own home, empty until something asks.
  assert.deepEqual(xpiCtx.cache, {});
  // No secret token anywhere on the check-facing ctx (the builder never receives one).
  assert.equal("apiKey" in xpiCtx.options, false);
  assert.equal(xpiCtx.options.allowExperiments, true); // a real option stays
});

// A manifest.json check's verdict comes from the RECORD, not from the files it is routed to:
// ctx.manifest is the shipped answer, projected from the review env, so the check reads the
// same thing whichever artifact the review target is. That is why these checks need no files
// of their own - they ask ctx.manifest and nothing else.
test("a manifest.json check reads the record, not the routed files", async () => {
  const xpi = addonWith({ "a.js": "export const x = 1;" });
  // An artifact that ships no manifest.json still carries a record; `present` says so.
  const env = envWith({ manifest: noManifest() });
  const xpiCtx = buildXpiCtx(xpi, parsed(xpi), env);
  assert.ok(
    xpiCtx.artifact.files.size > 0,
    "the routed artifact does have files"
  );
  const check = (await import("../../src/checks/rules/manifest-missing.js"))
    .default;
  // The artifact has files and holds no manifest.json either way: the finding comes from
  // the record saying it is not present, which is the shipped artifact's answer.
  assert.ok(check.run(xpiCtx).findings.length > 0);
});
