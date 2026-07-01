// Test helper: the checks read the SHIPPED manifest from ctx.manifest (+ siblings),
// resolved by buildRunContext in production. Unit tests build a ctx inline with a
// single artifact, so this derives those fields from ctx.addon (mutating and
// returning the SAME ctx, so tests that inspect the ctx after a run still observe it).

import { buildManifestLoc } from "../../src/addon/manifest-loc.js";

/**
 * @param {object} ctx
 * @returns {object} the same ctx, with manifest/manifestError/manifestLoc/manifestText.
 */
export function withManifest(ctx) {
  const addon = ctx?.addon ?? {};
  const text = addon.files?.get?.("manifest.json")?.toString("utf8") ?? "";
  ctx.manifest = addon.manifest ?? null;
  ctx.manifestError = addon.manifestError ?? null;
  ctx.manifestLoc = addon.manifestLoc ?? (text ? buildManifestLoc(text) : null);
  ctx.manifestText = text;
  // Other shipped-authoritative fields the pipeline attaches to the review addon and
  // buildRunContext hoists onto ctx: the Experiment classification and the summary's
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
