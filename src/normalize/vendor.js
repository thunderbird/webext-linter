// Parses the add-on's VENDOR file (developers list every bundled third-party
// library there so reviewers can verify it matches upstream). Those files must
// stay byte-for-byte identical to the release they came from, so the normalizer
// skips any path listed here, and vendor verification fetches the declared
// source to confirm it (src/vendor/verify.js).
//
// Real submissions write this file in many styles, so the parser works in blocks
// (delimited by headings or blank lines) rather than per line. In each block it
// pairs a LIBRARY-LIKE packaged file (the library signal - bundled.js - is the
// primary identifier, so the add-on's own modules and the package name are ignored)
// with the block's source URL (the first URL that points to a file; a bare
// repository link is not a source). Tokens may be Markdown code-spans. This reads
// the "File:"/"Source:", "path:" + "- URL:", "name.js : <url>", and `## Lib` block
// styles alike. Deterministic extraction is best-effort - the LLM fallback
// (src/vendor/resolve.js) covers a free-form file the scan cannot map.
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
import { classify as librarySignal } from "../checks/lib/bundled.js";

/** @typedef {import("../addon/load.js").Addon} Addon */
/** @typedef {{path: string, sourceUrl: ?string}} VendorEntry */

// VENDOR filenames developers use (matched case-insensitively).
const VENDOR_NAMES = new Set(["vendor", "vendor.md", "vendors", "vendors.md"]);

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
    .replace(/^["'`]+|["'`]+$/g, "") // strip surrounding quotes / Markdown backticks
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

// Code-hosting roots: github.com/owner/repo (<= 2 path segments) is a repository,
// not a file, even when the repo name ends in ".js" - so it is never a source URL.
const REPO_HOSTS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
  "sourceforge.net",
]);

// All http(s) URLs on a line (so a Source: line and an Upstream-repository: line
// are both seen, and the file one wins).
const URLS_RE = /https?:\/\/\S+/gi;

/**
 * Whether a URL points to a fetchable FILE (so a bare repository link is not a
 * source): its last path segment has a file extension, and it is not a code-host
 * repository root. CDN / registry / raw URLs pass; an untrusted-but-file URL also
 * passes (so resolve.js can still flag it "untrusted host").
 * @param {string} url
 * @returns {boolean}
 */
function pointsToFile(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const segs = u.pathname.split("/").filter(Boolean);
  const last = segs[segs.length - 1] ?? "";
  if (!LOOSE_EXT.test(last)) {
    return false; // no filename/extension - a page or repo root
  }
  return !(REPO_HOSTS.has(u.hostname.toLowerCase()) && segs.length <= 2);
}

/** Whether a packaged file's CONTENT/name marks it a third-party library. */
function isLibraryFile(addon, path) {
  const buf = addon.files.get(path);
  return buf ? librarySignal(buf.toString("utf8"), path).library : false;
}

/**
 * Split the VENDOR text into blocks: a blank line ends a block, and a Markdown
 * heading starts a new one (belonging to it). Multiple blank lines just yield
 * separate (sub-)blocks.
 * @param {string} text
 * @returns {string[][]}
 */
function splitBlocks(text) {
  const blocks = [];
  let cur = [];
  const flush = () => {
    if (cur.length) {
      blocks.push(cur);
      cur = [];
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*$/.test(line)) {
      flush();
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      flush();
    }
    cur.push(line);
  }
  flush();
  return blocks;
}

/**
 * Scan the VENDOR file into one record per declaration: a LIBRARY-LIKE packaged
 * file (the path) paired with the block's source URL - a URL that points to a file
 * (a bare repository link is ignored). The library signal is the primary
 * identifier, so the add-on's own modules and the package name in a block are
 * ignored. A block whose only file-like token is ABSENT yields a missing record
 * (path null) instead. A block with no file source yields nothing (the VENDOR file
 * is "unparseable" when no block yields a record - see resolveVendor).
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
  for (const block of splitBlocks(vendor.text)) {
    const urls = [];
    const present = new Set(); // present library-like packaged paths
    const absent = []; // absent strong-file-like tokens (missing candidates)
    for (const line of block) {
      const lineUrls = line.match(URLS_RE) || [];
      urls.push(...lineUrls);
      let remainder = line;
      for (const u of lineUrls) {
        remainder = remainder.replace(u, " ");
      }
      for (const token of remainder.split(/\s+/)) {
        const info = classify(token);
        if (info.path) {
          if (isLibraryFile(addon, info.path)) {
            present.add(info.path);
          }
        } else if (info.strongFileLike && !info.exists) {
          absent.push(info.norm);
        }
      }
    }
    const source = urls
      .map((u) => u.replace(/[).,;'"]+$/, ""))
      .find(pointsToFile);
    if (!source) {
      continue; // no file source -> nothing verifiable in this block
    }
    if (present.size) {
      for (const path of present) {
        records.push({ token: path, path, sourceUrl: source });
      }
    } else if (absent.length) {
      records.push({ token: absent[0], path: null, sourceUrl: source });
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
