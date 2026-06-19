// The network half of vendor resolution, run ONCE before normalize and review.
// resolveVendor (offline) settled the no-url / untrusted / unpinned cases into
// addon.vendor.results. This step does the work that needs the network and
// writes its results into the same shared store, so the review-phase checks
// only read it (nothing is fetched twice).
//
// Two sources are verified:
//   - VENDOR entries that are trusted-host + pinned: fetch the declared URL and
//     EOL-tolerant compare against the packaged bytes (verified / modified),
//     then gate on popularity (verified / not-popular). An unfetchable URL is
//     escalated to manual review.
//   - package.json dependencies pinned to a version: fetch the published file
//     listing from unpkg ONCE (it carries a per-file sha256 integrity) and mark
//     vendored any packaged file whose content hash matches a published file's
//     integrity - matched locally, no file bytes downloaded, so it scales to a
//     large package. A file that does not hash-match is left alone, as it may be
//     the author's own code or a modified copy.
//
// Belongs here: verifyVendor (the batch), the per-source compare, the popularity
// lookup, and the default network transport. Does NOT belong here: URL
// classification (-> sources.js), the offline parse (-> resolve.js), the host
// allowlist + thresholds (-> config.js), and the finding/manual routing (-> the
// four vendor checks + registry).

import { createHash } from "node:crypto";

import { classifySource } from "./sources.js";
import {
  VENDOR_NPM_MIN_DOWNLOADS,
  VENDOR_GITHUB_MIN_STARS,
  VENDOR_FETCH_TIMEOUT_MS,
  VENDOR_FETCH_MAX_BYTES,
} from "../config.js";

/** @typedef {import("../addon/load.js").Addon} Addon */
/** @typedef {import("./resolve.js").VendorStore} VendorStore */
/** @typedef {import("./sources.js").VendorSource} VendorSource */
/**
 * @typedef {{fetchBytes: (url: string) => Promise<Buffer>,
 *   fetchJson: (url: string) => Promise<object>}} VendorNet
 */
/**
 * @typedef {object} MetaNode  A node in an unpkg "?meta" listing. unpkg returns a
 * flat `files` array whose entries each carry a `path` and a `type` that is the
 * file's MIME type (e.g. "application/javascript") - NOT the literal "file". The
 * listing root (and any directory node in the older nested form) instead carries
 * a `files` child array, so a node is a FILE when it has a `path` and no `files`.
 * @property {string} [path]  The published path.
 * @property {string} [type]  A file's MIME type, or "directory" (nested form).
 * @property {string} [integrity]  A file's Subresource-Integrity hash, e.g.
 *   "sha256-<base64>" (used to match without downloading the bytes).
 * @property {MetaNode[]} [files]  Child nodes (the listing root / a directory).
 */

/**
 * Verify the resolved vendor declarations over the network, appending per-file
 * results to (and extending the skip-set of) the shared `addon.vendor` store.
 * @param {Addon} addon  Must already carry `addon.vendor` from resolveVendor.
 * @param {VendorNet} [net]
 * @returns {Promise<void>}
 */
export async function verifyVendor(addon, net = defaultNet) {
  const vendor = addon?.vendor;
  if (!vendor) {
    return;
  }
  // VENDOR entries known trusted + pinned (the rest were settled offline).
  for (const entry of vendor.manifest) {
    if (entry.trusted && entry.pinned) {
      const outcome = await verifyUrl(entry, addon, net);
      vendor.results.push({
        path: entry.path,
        source: entry.sourceUrl,
        outcome,
      });
    }
  }
  for (const pkg of vendor.packages) {
    await verifyPackage(pkg, addon, vendor, net);
  }
}

/**
 * Compare a packaged file against its declared trusted+pinned URL.
 * @param {{path: string, sourceUrl: string}} entry
 * @param {Addon} addon @param {VendorNet} net
 * @returns {Promise<"verified"|"modified"|"not-popular"|"unfetchable">}
 */
async function verifyUrl(entry, addon, net) {
  const src = classifySource(entry.sourceUrl);
  const mine = addon.files.get(entry.path) ?? Buffer.alloc(0);
  let fetched;
  try {
    fetched = await net.fetchBytes(src.rawUrl);
  } catch {
    return "unfetchable";
  }
  if (!eolEqual(mine, fetched)) {
    return "modified";
  }
  return (await isPopular(src, net)) ? "verified" : "not-popular";
}

/**
 * Match packaged files against a pinned npm package's published files by
 * Subresource-Integrity hash (the per-file sha256 in the "?meta" listing),
 * recording each match as vendored. The match is purely local - the listing is
 * the only fetch; no file bytes are downloaded - so it scales to large packages.
 * @param {{name: string, version: string}} pkg
 * @param {Addon} addon @param {VendorStore} vendor @param {VendorNet} net
 * @returns {Promise<void>}
 */
async function verifyPackage(pkg, addon, vendor, net) {
  // A declared dependency whose files match nothing in the package is silently
  // ignored, by design: dependencies are installed/bundled at build time, so a
  // not-yet-built submission legitimately omits them (unlike a VENDOR entry,
  // whose file must be present - see missing-vendor-file.js). We only record the
  // files that DO match.
  const base = `https://unpkg.com/${pkg.name}@${pkg.version}`;
  let listing;
  try {
    listing = await net.fetchJson(`${base}/?meta`);
  } catch {
    return; // can't list the package - its files (if shipped) are scanned as-is
  }
  // Index the published files by their SRI hash. unpkg emits standard padded
  // base64 (e.g. "sha256-<base64>"), which matches Node's digest("base64").
  const byHash = new Map(); // "<algo>-<base64>" -> published path
  for (const f of metaFiles(listing)) {
    for (const sri of String(f.integrity ?? "")
      .trim()
      .split(/\s+/)) {
      if (/^sha\d+-./.test(sri) && !byHash.has(sri)) {
        byHash.set(sri, f.path);
      }
    }
  }
  const algos = [...new Set([...byHash.keys()].map((k) => k.split("-")[0]))];
  let popular = null; // looked up once, lazily, only if a file actually matches
  for (const [addonPath, mine] of addon.files) {
    if (vendor.set.has(addonPath)) {
      continue; // already vendored (a VENDOR entry)
    }
    // A packaged file is vendored when its exact content hash matches a
    // published file (basename-independent - a renamed verbatim copy still
    // matches). A file that does not hash-match is left alone (it may be the
    // author's own code, or a modified copy).
    let path = null;
    for (const algo of algos) {
      const sri = `${algo}-${createHash(algo).update(mine).digest("base64")}`;
      if (byHash.has(sri)) {
        path = byHash.get(sri);
        break;
      }
    }
    if (!path) {
      continue;
    }
    if (popular === null) {
      popular = await isPopular({ kind: "npm", pkg: pkg.name }, net);
    }
    vendor.set.add(addonPath);
    vendor.results.push({
      path: addonPath,
      source: `${base}${path}`,
      outcome: popular ? "verified" : "not-popular",
    });
  }
}

/**
 * Whether two buffers are equal once end-of-line differences are normalized:
 * CRLF / CR collapse to LF and trailing newlines are ignored (the developer's
 * "allow EOL diffs"). Compared via latin1, which is byte-preserving.
 * @param {Buffer} a @param {Buffer} b
 * @returns {boolean}
 */
function eolEqual(a, b) {
  return eolNormalize(a) === eolNormalize(b);
}

/** @param {Buffer} buf @returns {string} */
function eolNormalize(buf) {
  return Buffer.isBuffer(buf)
    ? buf.toString("latin1").replace(/\r\n?/g, "\n").replace(/\n+$/, "")
    : "";
}

/**
 * The published file nodes (each `{path, integrity, ...}`) an unpkg "?meta"
 * listing contains. A node is a file when it has a `path` and no `files` child of
 * its own - which covers both unpkg's flat listing (every entry is a file, its
 * `type` a MIME type) and the older nested tree (directories carry a `files`
 * array). Keying off `type === "file"` would miss the flat form, whose entries
 * carry a MIME type instead.
 * @param {MetaNode} node @param {MetaNode[]} [out]
 * @returns {MetaNode[]}
 */
function metaFiles(node, out = []) {
  if (!node || typeof node !== "object") {
    return out;
  }
  if (typeof node.path === "string" && node.files === undefined) {
    out.push(node);
  }
  for (const child of node.files ?? []) {
    metaFiles(child, out);
  }
  return out;
}

/**
 * Whether the source is a broadly-used library: npm monthly downloads, GitHub
 * stars, or cdnjs catalog membership over the configured bar. A lookup error
 * counts as "not popular" (the case then goes to manual review).
 * @param {VendorSource} src @param {VendorNet} net
 * @returns {Promise<boolean>}
 */
async function isPopular(src, net) {
  try {
    if (src.kind === "npm") {
      const j = await net.fetchJson(
        `https://api.npmjs.org/downloads/point/last-month/${src.pkg}`
      );
      return Number(j?.downloads) >= VENDOR_NPM_MIN_DOWNLOADS;
    }
    if (src.kind === "github") {
      const j = await net.fetchJson(`https://api.github.com/repos/${src.repo}`);
      return Number(j?.stargazers_count) >= VENDOR_GITHUB_MIN_STARS;
    }
    if (src.kind === "cdnjs") {
      const j = await net.fetchJson(
        `https://api.cdnjs.com/libraries/${src.lib}?fields=name`
      );
      return Boolean(j?.name);
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * The default network transport: a timeout- and size-capped HTTPS fetch. The
 * caller only ever passes an already trusted-host URL.
 * @type {VendorNet}
 */
export const defaultNet = {
  async fetchBytes(url) {
    const res = await timedFetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get("content-length"));
    if (declared && declared > VENDOR_FETCH_MAX_BYTES) {
      throw new Error("source exceeds size cap");
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > VENDOR_FETCH_MAX_BYTES) {
      throw new Error("source exceeds size cap");
    }
    return buf;
  },
  async fetchJson(url) {
    const res = await timedFetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get("content-length"));
    if (declared && declared > VENDOR_FETCH_MAX_BYTES) {
      throw new Error("listing exceeds size cap");
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > VENDOR_FETCH_MAX_BYTES) {
      throw new Error("listing exceeds size cap");
    }
    return JSON.parse(buf.toString("utf8"));
  },
};

/**
 * fetch() with an abort timeout. Redirects are followed - the trust is that the
 * allowlisted CDNs only redirect within their own canonical URLs.
 * @param {string} url
 * @returns {Promise<Response>}
 */
async function timedFetch(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VENDOR_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}
