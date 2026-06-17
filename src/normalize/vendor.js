// Parses the add-on's VENDOR file (developers list every bundled third-party
// library there so reviewers can verify it matches upstream). Those files must
// stay byte-for-byte identical to the release they came from, so the normalizer
// skips any path listed here, and vendor verification fetches the declared
// source to confirm it (src/vendor/verify.js).
//
// Real submissions write this file in many styles, so the parser is forgiving:
// it accepts the filename VENDOR / VENDOR.md / VENDORS / VENDORS.md (any case),
// and on each line matches any token that resolves to a packaged file (by full
// posix path or an unambiguous basename, normalizing Windows "\" separators),
// pairing it with an http(s) source URL found on the same or a following line.
// This reads "File: x.js" / "Source: <url>", "file: a\b\c.js" / "source: <url>",
// "name.js : <url>", and the older "path:" + "- URL:" forms alike. Deterministic
// extraction is best-effort - the LLM fallback (src/vendor/resolve.js) covers a
// free-form file the scan cannot map.
//
// Belongs here: the deterministic VENDOR parse only - locating the file
// (readVendorFile), the packaged-file matcher (buildFileMatcher), the
// {path, sourceUrl} extraction (parseVendorManifest), and the entries whose
// declared file is absent (missingVendorEntries). It is LLM-free and pure.
//
// Does NOT belong here: the LLM parse fallback and the canonical resolved set
// (-> src/vendor/resolve.js). The consumers of the set: prettyprint.js skips
// vendored files from reformatting, bundled.js skips them from scanning, and
// unused-files exempts them. Fetching/verifying the declared source is the
// vendor verification pre-step + the vendor checks. This file makes no verdict.

import { basename } from "../util/files.js";

/** @typedef {import("../addon/load.js").Addon} Addon */
/** @typedef {{path: string, sourceUrl: ?string}} VendorEntry */

// VENDOR filenames developers use (matched case-insensitively).
const VENDOR_NAMES = new Set(["vendor", "vendor.md", "vendors", "vendors.md"]);

// First http(s) URL on a line (its source link).
const URL_RE = /https?:\/\/\S+/i;

/**
 * The add-on's VENDOR file, or null when there is none.
 * @param {Addon} addon
 * @returns {?{name: string, text: string}}
 */
export function readVendorFile(addon) {
  const files = addon?.files;
  if (!files) {
    return null;
  }
  const name = [...files.keys()].find((f) => VENDOR_NAMES.has(f.toLowerCase()));
  return name ? { name, text: files.get(name).toString("utf8") } : null;
}

/**
 * Normalize a free-form token: trim, strip surrounding quotes and trailing
 * punctuation, fold Windows "\" separators, drop a leading "./".
 * @param {string} token
 * @returns {string}
 */
function normalizeToken(token) {
  return String(token)
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/[,;:]+$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "");
}

// Any extension - a loose "could name a file" gate (so a real ".7z" still
// matches). A letter-led extension (.js, .css, .min.js) is the stricter gate for
// picking a MISSING candidate, so a version token like "2.2.1" is not mistaken
// for a filename.
const LOOSE_EXT = /\.[a-z0-9]+$/i;
const STRONG_EXT = /\.[a-z][a-z0-9]*$/i;

/**
 * @typedef {object} TokenInfo
 * @property {string} norm  The normalized token.
 * @property {?string} path  Resolved packaged path (exact or unambiguous
 *   basename), else null.
 * @property {boolean} exists  The package has this path or its basename.
 * @property {boolean} strongFileLike  Has a letter-led extension.
 */

/**
 * Build a token classifier over the add-on's files (maps built once, shared by
 * buildFileMatcher and the VENDOR record scan).
 * @param {Addon} addon
 * @returns {(token: string) => TokenInfo}
 */
function buildClassifier(addon) {
  const paths = new Set(addon.files.keys());
  const byBase = new Map();
  for (const p of addon.files.keys()) {
    const b = basename(p);
    const list = byBase.get(b);
    if (list) {
      list.push(p);
    } else {
      byBase.set(b, [p]);
    }
  }
  return (token) => {
    const norm = normalizeToken(token);
    if (!LOOSE_EXT.test(norm)) {
      return { norm, path: null, exists: false, strongFileLike: false };
    }
    const hits = byBase.get(basename(norm));
    return {
      norm,
      path: paths.has(norm) ? norm : hits && hits.length === 1 ? hits[0] : null,
      exists: paths.has(norm) || Boolean(hits && hits.length),
      strongFileLike: STRONG_EXT.test(norm),
    };
  };
}

/**
 * A matcher resolving a free-form token to a packaged add-on path, or null: by
 * exact posix path or an unambiguous basename, normalizing "\" separators,
 * surrounding quotes, and trailing punctuation. Used by the deterministic parse
 * and to validate LLM-suggested paths (so a hallucinated file is dropped).
 * @param {Addon} addon
 * @returns {(token: string) => ?string}
 */
export function buildFileMatcher(addon) {
  const classify = buildClassifier(addon);
  return (token) => classify(token).path;
}

/**
 * Walk the VENDOR file into one record per declaration block: the chosen file
 * token, its resolved path (null when absent), and the http(s) source URL paired
 * with it. A line prefers a token that resolves to a packaged file (so a present
 * file always wins); only when none resolves does it fall back to the first
 * strongly file-like token that the package does NOT contain - a candidate
 * missing file. The URL on the same or a following line attaches to the record.
 * @param {Addon} addon
 * @returns {{token: string, path: ?string, sourceUrl: ?string}[]}
 */
function scanVendorRecords(addon) {
  const vendor = readVendorFile(addon);
  if (!vendor) {
    return [];
  }
  const classify = buildClassifier(addon);
  const records = [];
  let pending = null;
  for (const line of vendor.text.split(/\r?\n/)) {
    const url = (line.match(URL_RE) || [null])[0];
    const remainder = url ? line.replace(url, " ") : line;
    let chosen = null;
    for (const token of remainder.split(/\s+/)) {
      const info = classify(token);
      if (info.path) {
        chosen = info; // a present file always wins
        break;
      }
      if (!chosen && info.strongFileLike && !info.exists) {
        chosen = info; // first genuinely-absent file-like token
      }
    }
    if (chosen) {
      pending = { token: chosen.norm, path: chosen.path, sourceUrl: null };
      records.push(pending);
    }
    if (url && pending && !pending.sourceUrl) {
      pending.sourceUrl = url.replace(/[).,;'"]+$/, "");
    }
  }
  return records;
}

/**
 * Parse the add-on's VENDOR file into the third-party entries it declares: each
 * a packaged-file path and (when present) the http(s) source URL paired with it.
 * Deterministic and pure; returns [] when there is no VENDOR file.
 * @param {Addon} addon
 * @returns {VendorEntry[]}
 */
export function parseVendorManifest(addon) {
  const seen = new Set();
  const entries = [];
  for (const r of scanVendorRecords(addon)) {
    if (r.path && !seen.has(r.path)) {
      seen.add(r.path);
      entries.push({ path: r.path, sourceUrl: r.sourceUrl });
    }
  }
  return entries;
}

/**
 * The VENDOR entries whose declared file is NOT in the submission: a strongly
 * file-like token paired with an http(s) source URL that resolves to no packaged
 * file. The URL anchor keeps prose from being mistaken for a declaration.
 * Deterministic and pure; returns [] when there is no VENDOR file.
 * @param {Addon} addon
 * @returns {VendorEntry[]}
 */
export function missingVendorEntries(addon) {
  const seen = new Set();
  const entries = [];
  for (const r of scanVendorRecords(addon)) {
    if (!r.path && r.sourceUrl && !seen.has(r.token)) {
      seen.add(r.token);
      entries.push({ path: r.token, sourceUrl: r.sourceUrl });
    }
  }
  return entries;
}
