// Test helper: the checks read the SHIPPED manifest from ctx.manifest (+ siblings),
// resolved by the ctx builders (buildXpiCtxs) in production. Unit tests build a ctx inline with a
// single artifact, so this derives those fields from ctx.addon (mutating and
// returning the SAME ctx, so tests that inspect the ctx after a run still observe it).

import { buildManifestLoc } from "../../src/addon/manifest-loc.js";
import { collectJsSources } from "../../src/addon/sources.js";
import { runExtractionPass } from "../../src/checks/extract.js";
import { isExperiment } from "../../src/lib/util.js";
import { experimentApiNamespaces } from "../../src/lib/experiments.js";

/**
 * The add-on's JS sources, through the extraction pass - the state a check may read them in.
 * A CHECK IS A PURE READER: the accessors in src/checks/extract.js throw on a source that
 * never went through a pass, so a hand-built ctx must run it exactly as setup does (the
 * pipeline does this in Phase 3). Use this wherever a test used to hand raw
 * collectJsSources() output to a ctx.
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
    experimentNamespaces: isExperiment(addon.manifest)
      ? experimentApiNamespaces(addon.manifest, addon.files)
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

// Mirror the loader (assembleAddon): lift manifest.json off a hand-built corpus onto the
// addon (manifestText) and drop the key, so ctx.addon.files matches production - manifest-free.
// Idempotent: reruns keep the stored text even though the key is already gone.
function liftManifest(addon) {
  if (addon.manifestText === undefined) {
    addon.manifestText =
      addon.files?.get?.("manifest.json")?.toString("utf8") ?? "";
  }
  addon.files?.delete?.("manifest.json");
}

/**
 * A single-artifact siblings map for a hand-built ctx: every input routes to the one ctx,
 * mirroring production's routing when a review has one artifact (in an XPI review the
 * source and xpi siblings are the same ctx). runChecks reads its review-level state
 * (recheck / recheckVerdicts / the base feed note) off siblings.source, so a test that
 * inspects ctx.recheck after a run still observes it.
 * @param {object} ctx
 * @returns {Record<string, object>}
 */
export function siblingsOf(ctx) {
  return { source: ctx, xpi: ctx, build: ctx, manifest: ctx };
}

/**
 * @param {object} ctx
 * @returns {object} the same ctx, with manifest/manifestError/manifestLoc/manifestText.
 */
export function withManifest(ctx) {
  const addon = ctx?.addon ?? {};
  liftManifest(addon);
  ctx.manifest = addon.manifest ?? null;
  ctx.manifestError = addon.manifestError ?? null;
  ctx.manifestLoc =
    addon.manifestLoc ??
    (addon.manifestText ? buildManifestLoc(addon.manifestText) : null);
  ctx.manifestText = addon.manifestText;
  // The diff baseline also arrives manifest-free from the loader; mirror that so the diff
  // checks compare manifest-free corpora and read the baseline manifest off ctx.previous.
  if (ctx?.previous) {
    liftManifest(ctx.previous);
  }
  // Other shipped-authoritative fields the pipeline attaches to the review addon and
  // the ctx builders hoist onto ctx: the Experiment classification and the summary's
  // recheck verdicts. Mirror that hoist here for a hand-built ctx (don't clobber a
  // value a test set directly on ctx).
  if (ctx.experiments === undefined) {
    ctx.experiments = addon.experiments ?? null;
  }
  if (ctx.recheckVerdicts === undefined && addon.recheck !== undefined) {
    ctx.recheckVerdicts = addon.recheck;
  }
  return ctx;
}
