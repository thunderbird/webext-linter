// Resolves the add-on's vendored declarations ONCE, at the top of the pipeline,
// before anything reformats or reviews files. This is the OFFLINE half: it
// parses the VENDOR file (with an LLM fallback) and the package.json dependency
// manifest (pinning each via an exact spec or a lock file), classifies each
// declared source, and builds the shared `addon.vendor` store. The network half
// (fetch + compare + popularity) is verifyVendor (src/vendor/verify.js), which
// fills in the per-file results. The review-phase checks only read the store.
//
// Belongs here: combining the VENDOR + package.json declarations into the
// offline `addon.vendor` (set, manifest, packages, unpinned, offline results).
// Does NOT belong here: the network verification (-> verify.js), the
// deterministic VENDOR parse (-> src/normalize/vendor.js), lock parsing (->
// src/vendor/locks.js), URL classification (-> src/vendor/sources.js), and the
// LLM wire protocol (-> src/llm/claude.js).

import {
  parseVendorManifest,
  missingVendorEntries,
  readVendorFile,
  buildFileMatcher,
} from "../normalize/vendor.js";
import { classifySource } from "./sources.js";
import { lockedVersion } from "./locks.js";
import { callClaudeText } from "../llm/claude.js";
import { DEFAULT_MODEL } from "../config.js";
import { debug } from "../util/log.js";

/** @typedef {import("../addon/load.js").Addon} Addon */
/** @typedef {import("../normalize/vendor.js").VendorEntry} VendorEntry */
/**
 * @typedef {object} VendorStore
 * @property {Set<string>} set  Vendored paths (skip-set).
 * @property {{path: string, source: ?string, outcome: string}[]} results
 *   Per-file outcomes (offline ones now, network ones added by verifyVendor).
 * @property {(VendorEntry & {trusted: boolean, pinned: boolean})[]} manifest
 *   Classified VENDOR-file entries.
 * @property {{name: string, version: string}[]} packages  Pinned deps.
 * @property {{name: string, spec: string}[]} unpinned  Deps with no pin.
 * @property {VendorEntry[]} missing  VENDOR entries whose file is absent.
 * @property {boolean} unparsedVendor  A VENDOR file exists but yielded nothing.
 */

// An exact semver (no range operators) - a concrete pinned version.
const EXACT = /^v?\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;

/**
 * Resolve the offline vendored declarations into `addon.vendor`.
 * @param {object} params
 * @param {Addon} params.addon
 * @param {?string} [params.parsePrompt]  The registry prompts.vendor-parse text.
 * @param {?string} [params.token]  Anthropic token, else deterministic only.
 * @param {string} [params.model]
 * @param {typeof callClaudeText} [params.callText]  Injectable transport.
 * @param {import("../llm/budget.js").LlmBudget} [params.budget]  Run-wide model
 *   request cap; the parse fallback is skipped once it is exhausted.
 * @returns {Promise<VendorStore>}
 */
export async function resolveVendor({
  addon,
  parsePrompt,
  token,
  model = DEFAULT_MODEL,
  callText = callClaudeText,
  budget,
}) {
  const vendorFile = readVendorFile(addon);
  const manifest = dedupeByPath(parseVendorManifest(addon));
  // The LLM parse fallback is one model request; count it against the run-wide
  // cap and skip it (deterministic only) once that is spent.
  const wantLlmParse =
    Boolean(vendorFile) && manifest.length === 0 && token && parsePrompt;
  if (wantLlmParse && (!budget || (await budget.consume()))) {
    try {
      manifest.push(
        ...(await llmExtract({
          text: vendorFile.text,
          addon,
          parsePrompt,
          token,
          model,
          callText,
        }))
      );
    } catch (err) {
      debug(`[vendor] LLM parse fallback failed: ${err?.message ?? err}`);
    }
  }

  const set = new Set();
  const results = [];
  for (const entry of manifest) {
    const src = classifySource(entry.sourceUrl);
    entry.trusted = src.trusted;
    entry.pinned = src.pinned;
    set.add(entry.path); // a declared file is vendored regardless of its outcome
    if (!entry.sourceUrl) {
      results.push({ path: entry.path, source: null, outcome: "no-url" });
    } else if (!src.trusted) {
      results.push({
        path: entry.path,
        source: entry.sourceUrl,
        outcome: "untrusted",
      });
    } else if (!src.pinned) {
      results.push({
        path: entry.path,
        source: entry.sourceUrl,
        outcome: "unpinned-source",
      });
    }
    // Trusted + pinned entries are left for verifyVendor to fetch.
  }

  const { packages, unpinned } = resolvePackages(addon);
  // VENDOR entries (file + source URL) naming a file the package does not
  // contain. Drives the missing-vendor-file check. Deterministic - the LLM
  // fallback only adds files that resolve, so it never affects this set.
  const missing = missingVendorEntries(addon);

  return {
    set,
    results,
    manifest,
    packages,
    unpinned,
    missing,
    // "Unparsed" only when we extracted nothing at all - neither a matched entry
    // nor a missing-file declaration. A parseable-but-missing VENDOR goes to the
    // missing-vendor-file check instead of a "could not be parsed" manual item.
    unparsedVendor:
      Boolean(vendorFile) && manifest.length === 0 && missing.length === 0,
  };
}

/**
 * Read package.json `dependencies` and split into pinned (an exact spec or a
 * lock entry) and unpinned (a range with no lock). Non-registry specs
 * (git/url/etc.) are skipped.
 * @param {Addon} addon
 * @returns {{packages: {name: string, version: string}[],
 *   unpinned: {name: string, spec: string}[]}}
 */
function resolvePackages(addon) {
  const packages = [];
  const unpinned = [];
  let deps;
  try {
    deps = JSON.parse(
      addon.files.get("package.json").toString("utf8")
    ).dependencies;
  } catch {
    return { packages, unpinned };
  }
  for (const [name, rawSpec] of Object.entries(deps ?? {})) {
    const spec = String(rawSpec).trim();
    if (EXACT.test(spec)) {
      packages.push({ name, version: spec.replace(/^v/, "") });
    } else if (/[:/]/.test(spec)) {
      continue; // git/url/file/workspace/alias - not verifiable via npm
    } else {
      const version = lockedVersion(addon, name);
      if (version) {
        packages.push({ name, version });
      } else {
        unpinned.push({ name, spec });
      }
    }
  }
  return { packages, unpinned };
}

/**
 * Extract {path, sourceUrl} from a free-form VENDOR file via the LLM, keeping
 * only paths that resolve to a real packaged file.
 * @param {object} params
 * @param {string} params.text @param {Addon} params.addon
 * @param {string} params.parsePrompt @param {string} params.token
 * @param {string} params.model @param {typeof callClaudeText} params.callText
 * @returns {Promise<VendorEntry[]>}
 */
async function llmExtract({
  text,
  addon,
  parsePrompt,
  token,
  model,
  callText,
}) {
  const reply = await callText({
    token,
    model,
    prompt: `${parsePrompt}\n\nVENDOR file:\n${text}`,
  });
  const match = buildFileMatcher(addon);
  const out = [];
  const seen = new Set();
  for (const item of parseJsonArray(reply)) {
    const path =
      item && typeof item.file === "string" ? match(item.file) : null;
    if (path && !seen.has(path)) {
      seen.add(path);
      out.push({
        path,
        sourceUrl: typeof item.url === "string" ? item.url : null,
      });
    }
  }
  return out;
}

/** @param {VendorEntry[]} entries @returns {VendorEntry[]} */
function dedupeByPath(entries) {
  const seen = new Set();
  return entries.filter((e) => !seen.has(e.path) && seen.add(e.path));
}

/** @param {string} reply @returns {Array<{file?: string, url?: string}>} */
function parseJsonArray(reply) {
  const m = String(reply).match(/\[[\s\S]*\]/);
  if (!m) {
    return [];
  }
  try {
    const value = JSON.parse(m[0]);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
