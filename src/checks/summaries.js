// The LLM-authored advisory summaries (post-review, text-only, gated on an
// Anthropic token). Each reduces the add-on to a self-contained prompt and
// returns a DEFERRED { bytes, run } so the orchestrator can show the review
// report first, print a status line with the transmitted size, then run the LLM
// call. Neither is a check - they emit no finding and never affect the verdict.
// buildSummarizer is the "Summary of changes" (ctx.previous vs ctx.addon as a
// changed-files diff, --diff-to). buildAddonSummarizer is the "Summary of
// add-on" (the almost-full current authored add-on, minus vendored and unused
// files, --full-summary).
//
// The diff summary is free-form prose; the add-on summary is structured (prose
// plus the machine-readable unused-permission list, via the forced
// report_addon_review tool), since the unused-permission check consumes that
// list to raise Issues.
//
// Belongs here: buildDiffText / buildAddonText (the deterministic payloads) and
// the two summarizer builders. Does NOT belong here: the prompt text ->
// assets/registry.yaml (via registry.prompt). The transport -> the provider
// adapters (callText / callReview, selected by src/llm/provider.js) through
// src/checks/llm-client.js (summarize / reviewAddon). The unused-file set ->
// derived from review findings in src/pipeline.js. Displaying the summaries ->
// src/cli.js. The unused-permission list -> the unused-permission check
// (src/checks/rules/unused-permission.js). File classification ->
// src/checks/lib/bundled.js and src/util/files.js.

import { extname, JS_EXTENSIONS, HTML_EXTENSIONS } from "../util/files.js";
import { canonicalJson } from "../util/json.js";
import { nonAuthoredJs } from "./lib/bundled.js";
import { declaredPermissions } from "./lib/permissions.js";

/** @typedef {import("./registry.js").RunContext} RunContext */
/** @typedef {import("./registry.js").Registry} Registry */
/** @typedef {import("../addon/load.js").Manifest} Manifest */
/** @typedef {import("../llm/schema.js").AddonReview} AddonReview */
/** @typedef {{bytes: number, run: () => Promise<?string>}} DeferredSummary */
/**
 * @typedef {{bytes: number, run: () => Promise<?AddonReview>}} DeferredReview
 */

// Authored text file types whose full contents are worth quoting to the model.
const TEXT_EXTS = new Set([
  ...JS_EXTENSIONS,
  ...HTML_EXTENSIONS,
  ".json",
  ".css",
  ".txt",
  ".md",
  ".yaml",
  ".yml",
]);

/**
 * Whether a file's contents are worth quoting: an authored text file that is not
 * a non-authored bundle (library / minified / obfuscated / vendored).
 * @param {string} file
 * @param {Set<string>} skip  The nonAuthoredJs set for the current add-on.
 * @returns {boolean}
 */
function isAuthoredText(file, skip) {
  return TEXT_EXTS.has(extname(file)) && !skip.has(file);
}

/**
 * The utf8 text of a file in a files map, or "".
 * @param {string} file
 * @param {Map<string, Buffer>} files
 * @returns {string}
 */
function fileText(file, files) {
  return files.get(file)?.toString("utf8") ?? "";
}

/**
 * Push a header line then `s` between ``` fences onto `out`.
 * @param {string[]} out
 * @param {string} h
 * @param {string} s
 */
function fenced(out, h, s) {
  out.push(h, "```", s, "```");
}

/**
 * Wrap a self-contained prompt message as a deferred summary: its UTF-8 size
 * (for the status line) plus a run() that performs the LLM call and yields the
 * prose. run() may THROW on an LLM error; the caller (the pipeline) catches it,
 * narrates the failure at the step, and keeps the review going - an advisory
 * summary must never abort the review.
 * @param {RunContext} ctx
 * @param {string} message  The full text sent to the model.
 * @returns {DeferredSummary}
 */
function deferredSummary(ctx, message) {
  return {
    bytes: Buffer.byteLength(message, "utf8"),
    run: () => ctx.llm.summarize(message),
  };
}

/**
 * Like deferredSummary, but for the add-on review: run() yields the structured
 * { summary, unusedPermissions } via ctx.llm.reviewAddon (the forced
 * report_addon_review tool) rather than free-form prose, since the add-on
 * summary also returns the machine-readable unused-permission list. run() may
 * THROW on an LLM error; the pipeline catches it and narrates the failure - an
 * advisory summary must never abort the review.
 * @param {RunContext} ctx
 * @param {string} message  The full text sent to the model.
 * @returns {DeferredReview}
 */
function deferredReview(ctx, message) {
  return {
    bytes: Buffer.byteLength(message, "utf8"),
    run: () => ctx.llm.reviewAddon(message),
  };
}

/**
 * The deterministic diff fed to the model: which files were added/removed/
 * changed, the before+after of changed authored text files (binaries and
 * bundles are named with byte sizes only), and the manifest's canonical diff.
 * Returns null when nothing changed or there is no baseline.
 * @param {RunContext} ctx
 * @returns {?string}
 */
export function buildDiffText(ctx) {
  const cur = ctx.addon?.files;
  const prev = ctx.previous?.files;
  if (!cur || !prev) {
    return null;
  }
  const skip = nonAuthoredJs(ctx);

  const added = [];
  const removed = [];
  const changed = [];
  for (const [file, buf] of cur) {
    if (file === "manifest.json") {
      continue;
    }
    const before = prev.get(file);
    if (!before) {
      added.push(file);
    } else if (!before.equals(buf)) {
      changed.push(file);
    }
  }
  for (const file of prev.keys()) {
    if (file !== "manifest.json" && !cur.has(file)) {
      removed.push(file);
    }
  }
  const manifestDiffers =
    canonicalJson(ctx.previous.manifest ?? null) !==
    canonicalJson(ctx.addon.manifest ?? null);
  if (!added.length && !removed.length && !changed.length && !manifestDiffers) {
    return null;
  }
  added.sort();
  removed.sort();
  changed.sort();

  const out = [];
  if (manifestDiffers) {
    out.push("manifest.json changed:");
    fenced(
      out,
      "--- previous manifest ---",
      canonicalJson(ctx.previous.manifest ?? null)
    );
    fenced(
      out,
      "--- current manifest ---",
      canonicalJson(ctx.addon.manifest ?? null)
    );
    out.push("");
  }
  out.push(`Added files: ${added.join(", ") || "(none)"}`);
  out.push(`Removed files: ${removed.join(", ") || "(none)"}`);
  out.push(`Changed files: ${changed.join(", ") || "(none)"}`, "");

  for (const file of added) {
    if (isAuthoredText(file, skip)) {
      fenced(out, `=== ${file} (added) ===`, fileText(file, cur));
    }
  }
  for (const file of changed) {
    if (isAuthoredText(file, skip)) {
      out.push(`=== ${file} (changed) ===`);
      fenced(out, "--- previous ---", fileText(file, prev));
      fenced(out, "--- current ---", fileText(file, cur));
    } else {
      const a = prev.get(file)?.length ?? 0;
      const b = cur.get(file)?.length ?? 0;
      out.push(`${file}: changed (${a} -> ${b} bytes)`);
    }
  }
  return out.join("\n");
}

/**
 * The declared permission set, split for the summary's permission review: the
 * required permissions (manifest.permissions), the optional ones
 * (optional_permissions), and the host match patterns. An explicit anchor so the
 * LLM judges every declared permission even though the manifest is also quoted.
 * A final line names the declared permissions the deterministic analysis already
 * proved used (`used`). The prompt tells the model to treat those as justified
 * and not assess them, so it spends its judgment only on the unsettled rest.
 * @param {Manifest} manifest
 * @param {Set<string>} [used]  Permissions a reachable API call provably
 *   requires.
 * @returns {string}
 */
function declaredPermissionsBlock(manifest, used = new Set()) {
  const { required, named, hosts } = declaredPermissions(manifest);
  const optional = [...named].filter((p) => !required.has(p));
  const confirmed = [...named].filter((p) => used.has(p));
  /**
   * Render one labeled list line, or "(none)" when the list is empty.
   * @param {string} label
   * @param {string[]} items
   * @returns {string}
   */
  const line = (label, items) =>
    `${label}: ${items.length ? [...items].join(", ") : "(none)"}`;
  return [
    line("required permissions", [...required]),
    line("optional permissions", optional),
    line("host permissions", [...hosts]),
    line(
      "confirmed used by static analysis (do not assess, treat as justified)",
      confirmed
    ),
  ].join("\n");
}

/**
 * The (almost) full current add-on for the add-on summary: the canonical
 * manifest, an explicit declared-permission list, plus every authored text file
 * (isAuthoredText - i.e. not a vendored/minified/obfuscated bundle) that is not
 * in `unused`, each fenced under "=== file ===". No byte cap - a large add-on
 * may approach the context window.
 * @param {RunContext} ctx
 * @param {{unused?: Set<string>, used?: Set<string>}} [opts]  unused = files the
 *   review found unreachable; used = permissions provably required by a
 *   reachable API call (annotated in the declared-permissions block).
 * @returns {?string}
 */
export function buildAddonText(
  ctx,
  { unused = new Set(), used = new Set() } = {}
) {
  const files = ctx.addon?.files;
  if (!files) {
    return null;
  }
  const skip = nonAuthoredJs(ctx);
  const out = [];
  fenced(
    out,
    "=== manifest.json ===",
    canonicalJson(ctx.addon.manifest ?? null)
  );
  if (ctx.addon.manifest) {
    fenced(
      out,
      "=== declared permissions ===",
      declaredPermissionsBlock(ctx.addon.manifest, used)
    );
  }
  for (const file of [...files.keys()].sort()) {
    if (
      file === "manifest.json" ||
      unused.has(file) ||
      !isAuthoredText(file, skip)
    ) {
      continue;
    }
    fenced(out, `=== ${file} ===`, fileText(file, files));
  }
  return out.join("\n");
}

/**
 * Prepare the deferred "Summary of changes" (--diff-to): the diff text handed to
 * the LLM with the registry "change-summary" prompt. Returns null when there is
 * no baseline, no token, nothing changed, or no prompt.
 * @param {RunContext} ctx
 * @param {Registry} registry
 * @returns {?DeferredSummary}
 */
export function buildSummarizer(ctx, registry) {
  if (!ctx?.previous || !ctx?.llm) {
    return null;
  }
  const diff = buildDiffText(ctx);
  const prompt = registry.prompt("change-summary");
  if (!diff || !prompt) {
    return null;
  }
  return deferredSummary(ctx, `${prompt}\n\n${diff}`);
}

/**
 * Prepare the deferred "Summary of add-on" (--full-summary): the (almost) full
 * current add-on handed to the LLM with the registry "add-on-summary" prompt.
 * The model returns prose plus the structured unused-permission list (the
 * unused-permission check consumes the latter). Returns null when there is no
 * token or no prompt.
 * @param {RunContext} ctx
 * @param {Registry} registry
 * @param {{unused?: Set<string>, used?: Set<string>}} [opts]  unused = files the
 *   review found unreachable; used = permissions a reachable API call provably
 *   requires (so the prompt can mark them settled).
 * @returns {?DeferredReview}
 */
export function buildAddonSummarizer(
  ctx,
  registry,
  { unused = new Set(), used = new Set() } = {}
) {
  if (!ctx?.llm) {
    return null;
  }
  const text = buildAddonText(ctx, { unused, used });
  const prompt = registry.prompt("add-on-summary");
  if (!text || !prompt) {
    return null;
  }
  return deferredReview(ctx, `${prompt}\n\n${text}`);
}
