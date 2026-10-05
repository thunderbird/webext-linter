// Test helper: the checks read the SHIPPED manifest.json record from ctx.manifest (+ siblings),
// resolved by the ctx builders (buildXpiCtx) in production. Unit tests build a ctx inline with a
// single artifact, so this derives that field from ctx.artifact (mutating and
// returning the SAME ctx, so tests that inspect the ctx after a run still observe it).

import { locusMinter, manifestRecord } from "../../src/addon/load.js";
import { ARTIFACT_XPI } from "../../src/lib/artifacts.js";
import { collectJsSources } from "../../src/addon/sources.js";
import { runExtractionPass } from "../../src/checks/extract.js";
import { classifyBundled } from "../../src/lib/bundled.js";
import { isExperiment } from "../../src/lib/util.js";
import { experimentApiNamespaces } from "../../src/lib/experiments.js";

/**
 * The add-on's JS sources, through the extraction pass - the state a check may read them in.
 * A CHECK IS A PURE READER: the accessors in src/checks/extract.js throw on a source that
 * never went through a pass, so a hand-built ctx must run it exactly as setup does (the
 * pipeline does this in Phase 3). Use this instead of handing raw collectJsSources()
 * output to a ctx.
 * @param {object} addon
 * @param {object} [opts]
 * @param {object} [opts.schema]  The same schema the ctx carries (the loader-ref walk reads
 *   it, so passing a different one here would precompute refs the check cannot reproduce).
 * @returns {import("../../src/addon/sources.js").JsSource[]}
 */
export function parsedSources(addon, { schema } = {}) {
  const jsSources = collectJsSources(addon);
  runExtractionPass(jsSources, {
    schema,
    nonAuthored: addon.bundled?.nonAuthored,
    experimentNamespaces: isExperiment(addon.manifest?.json)
      ? experimentApiNamespaces(addon.manifest?.json, addon.files)
      : null,
  });
  return jsSources;
}

/**
 * The same, for a test that hand-builds its JsSource objects inline instead of collecting
 * them from an addon. Runs the pass over them in place and returns them.
 * @param {import("../../src/addon/sources.js").JsSource[]} jsSources
 * @param {object} [opts]
 * @param {object} [opts.schema]
 * @param {Set<string>} [opts.nonAuthored]
 * @returns {import("../../src/addon/sources.js").JsSource[]}
 */
export function parsed(jsSources, { schema, nonAuthored } = {}) {
  runExtractionPass(jsSources, { schema, nonAuthored });
  return jsSources;
}

/**
 * The manifest.json record a loaded artifact carries, built the way manifestRecord does
 * (src/addon/load.js) - so a hand-built fixture hands the checks the shape production hands
 * them. Give it the parsed object; the text is derived unless a test needs particular bytes
 * (a token's line, a trailing comma, a duplicate key).
 * @param {?object} json  The parsed manifest.json.
 * @param {string} [text]  The raw manifest.json bytes, when they matter.
 * @returns {object} The record, for `artifact: { manifest: manifestOf(...) }`.
 */
export function manifestOf(json, text = JSON.stringify(json, null, 2)) {
  // The shape comes from the PRODUCTION builder, so a test record cannot go out of step
  // with the real one the next time it gains a field - it now carries `at`, which mints
  // a locus inside the shipped manifest.json. The parsed `json` is then overridden,
  // because a test may deliberately pair an object with text that does not match it (a
  // fixed text for line lookups, a varying object for the case under test).
  return { ...manifestRecord(text), json };
}

/**
 * The record an artifact that ships NO manifest.json carries. There is always a record -
 * `present` is what says there was no file (src/addon/load.js) - so a test standing in for
 * that case builds one here rather than passing null, which is a shape production never
 * produces and no check is written against.
 * @returns {object}
 */
export function noManifest() {
  return manifestRecord(null);
}

/**
 * An ADDON-shaped object for a test that builds its files in memory rather than on disk.
 *
 * Built here rather than inline so a test artifact has the shape production gives one -
 * it carries its `kind` and mints loci with `at`, which is how a finding says which
 * artifact its path is in (src/addon/load.js). A hand-built literal missing those reads
 * as an artifact that does not know what it is, which no real one is.
 * @param {Record<string, string>} files  path -> contents.
 * @param {string} [kind]  Which artifact this stands for (src/lib/artifacts.js).
 * @returns {object}
 */
export function addonOf(files, kind = ARTIFACT_XPI) {
  const map = new Map(
    Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])
  );
  return {
    kind,
    at: locusMinter(kind),
    files: map,
    store: map,
  };
}

/**
 * A single-artifact siblings map for a hand-built ctx: every input routes to the one ctx,
 * mirroring production's routing when a review has one artifact (in an XPI review the
 * source and xpi siblings are the same ctx). runChecks reads its review-level state
 * (the base feed note) off siblings.source, so a test that inspects the ctx after a
 * run still observes it.
 * @param {object} ctx
 * @returns {Record<string, object>}
 */
export function siblingsOf(ctx) {
  return { source: ctx, xpi: ctx, sca: ctx, manifest: ctx };
}

/**
 * @param {object} ctx
 * @returns {object} the same ctx, carrying the shipped manifest.json record.
 */
export function withManifest(ctx) {
  const addon = ctx?.artifact ?? {};
  // A loaded artifact's record is read FROM its files, so its text IS those bytes and a
  // line a finding carries is a line of the file the reviewer opens. A fixture that lets
  // the two drift asserts a line the submission does not have, and passes by coincidence.
  const bytes = addon.files?.get?.("manifest.json")?.toString("utf8");
  if (bytes !== undefined && addon.manifest && addon.manifest.text !== bytes) {
    throw new Error(
      "manifest record text differs from the artifact's manifest.json - pass those bytes " +
        "as manifestOf()'s second argument"
    );
  }
  ctx.manifest = addon.manifest ?? noManifest();
  // Every routed ctx carries an artifact, and every artifact knows which one it is and
  // mints loci in itself (src/addon/load.js) - which is where a finding's and a note's
  // artifact comes from. A fixture that named no artifact, or built one as a bare bag of
  // files, models no ctx a check can be handed, so fill in what production guarantees:
  // the XPI, unless the test said otherwise. (The `all` route carries no `artifact` and
  // is not built here - a check on it names ctx.xpi or ctx.sca.)
  ctx.artifact ??= { files: new Map() };
  if (typeof ctx.artifact.at !== "function") {
    const kind = ctx.artifact.kind ?? ARTIFACT_XPI;
    ctx.artifact.kind = kind;
    ctx.artifact.at = locusMinter(kind);
  }
  // Setup classifies every artifact a check can be routed to (classifyReview); a test that
  // set no classification of its own gets the one setup would compute without known
  // library hashes or a vendor audit. Asked of the descriptor, so a sealed artifact's
  // throwing getter is never read.
  const set = Object.getOwnPropertyDescriptor(ctx.artifact, "bundled");
  if (ctx.artifact.files && (!set || (!set.get && set.value === undefined))) {
    ctx.artifact.bundled = classifyBundled(ctx.artifact);
  }
  // The other shipped-authoritative field the pipeline attaches to the review addon and
  // the ctx builders hoist onto ctx: the Experiment classification. Mirror that hoist here
  // for a hand-built ctx (don't clobber a value a test set directly on ctx).
  if (ctx.experiments === undefined) {
    ctx.experiments = addon.experiments ?? null;
  }
  // projectCtx puts the review options on every sibling, so they are never absent when a
  // check runs. A hand-built ctx that omitted them used to work only because the readers
  // guarded the field's existence; they no longer do, because a check cannot legitimately
  // be missing one.
  if (ctx.options === undefined) {
    ctx.options = {};
  }
  return ctx;
}

/**
 * The `input: all` shape over single-artifact ctxs: the two named, as buildAllCtx names
 * them. The note goes on the OUTER ctx, which is where runChecks binds it in a real
 * review - perArtifact copies it onto each artifact ctx, so a note set on an inner one
 * would be overwritten.
 *
 * @param {object|object[]} ctxs  The XPI's ctx, or both as [xpi, sca].
 * @param {Function} [note]  The feed note, if the test asserts on it.
 * @returns {object} an `all` ctx naming them.
 */
export function allOf(ctxs, note) {
  const [xpi, sca = null] = [].concat(ctxs);
  return { xpi, sca, note };
}
