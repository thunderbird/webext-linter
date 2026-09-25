// Test helper: the checks read the SHIPPED manifest.json record from ctx.manifest (+ siblings),
// resolved by the ctx builders (buildXpiCtxs) in production. Unit tests build a ctx inline with a
// single artifact, so this derives that field from ctx.addon (mutating and
// returning the SAME ctx, so tests that inspect the ctx after a run still observe it).

import JSON5 from "json5";

import { buildManifestLoc } from "../../src/addon/manifest-loc.js";
import { collectJsSources } from "../../src/addon/sources.js";
import { runExtractionPass } from "../../src/checks/extract.js";
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
 * @returns {object} The record, for `addon: { manifest: manifestOf(...) }`.
 */
export function manifestOf(json, text = JSON.stringify(json, null, 2)) {
  return { json, text, error: null, loc: buildManifestLoc(text) };
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
  const addon = ctx?.addon ?? {};
  // A loaded artifact's record is read FROM the corpus, so its text IS those bytes and a
  // line a finding carries is a line of the file the reviewer opens. A fixture that lets
  // the two drift asserts a line the submission does not have, and passes by coincidence.
  const bytes = addon.files?.get?.("manifest.json")?.toString("utf8");
  if (bytes !== undefined && addon.manifest && addon.manifest.text !== bytes) {
    throw new Error(
      "manifest record text differs from the corpus manifest.json - pass those bytes " +
        "as manifestOf()'s second argument"
    );
  }
  ctx.manifest = addon.manifest ?? null;
  // The other shipped-authoritative field the pipeline attaches to the review addon and
  // the ctx builders hoist onto ctx: the Experiment classification. Mirror that hoist here
  // for a hand-built ctx (don't clobber a value a test set directly on ctx).
  if (ctx.experiments === undefined) {
    ctx.experiments = addon.experiments ?? null;
  }
  return ctx;
}
