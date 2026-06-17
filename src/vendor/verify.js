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
//     listing from unpkg, and for each packaged file whose basename a published
//     file shares, fetch and EOL-compare. A match marks that file vendored
//     (verified / not-popular). A non-match is left alone - a same-basename
//     file is not assumed to be a modified copy, as it may be the author's own.
//
// Belongs here: verifyVendor (the batch), the per-source compare, the popularity
// lookup, and the default network transport. Does NOT belong here: URL
// classification (-> sources.js), the offline parse (-> resolve.js), the host
// allowlist + thresholds (-> config.js), and the finding/manual routing (-> the
// four vendor checks + registry).

import { classifySource } from "./sources.js";
import { basename } from "../util/files.js";
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
 * @typedef {object} MetaNode  A node in an unpkg "?meta" listing tree.
 * @property {"file"|"directory"} [type]  The node kind.
 * @property {string} [path]  The published path (for a file).
 * @property {MetaNode[]} [files]  Child nodes (for a directory).
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
 * Match packaged files against a pinned npm package's published files (by
 * basename + EOL-tolerant byte compare), recording each match as vendored.
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
  const byBase = new Map();
  for (const p of flattenMeta(listing)) {
    const b = basename(p);
    if (!byBase.has(b)) {
      byBase.set(b, []);
    }
    byBase.get(b).push(p);
  }
  let popular = null; // looked up once, lazily, only if a file actually matches
  for (const [addonPath, mine] of addon.files) {
    if (vendor.set.has(addonPath)) {
      continue; // already vendored (a VENDOR entry)
    }
    const url = await matchPublished(
      base,
      byBase.get(basename(addonPath)),
      mine,
      net
    );
    if (!url) {
      continue;
    }
    if (popular === null) {
      popular = await isPopular({ kind: "npm", pkg: pkg.name }, net);
    }
    vendor.set.add(addonPath);
    vendor.results.push({
      path: addonPath,
      source: url,
      outcome: popular ? "verified" : "not-popular",
    });
  }
}

/**
 * The published file URL whose bytes EOL-match `mine`, or null. Tries every
 * same-basename candidate in turn, and the first match wins.
 * @param {string} base  "https://unpkg.com/<name>@<version>"
 * @param {string[]|undefined} candidates  Published paths sharing the basename.
 * @param {Buffer} mine @param {VendorNet} net
 * @returns {Promise<?string>}
 */
async function matchPublished(base, candidates, mine, net) {
  for (const cand of candidates ?? []) {
    let bytes;
    try {
      bytes = await net.fetchBytes(`${base}${cand}`);
    } catch {
      continue;
    }
    if (eolEqual(mine, bytes)) {
      return `${base}${cand}`;
    }
  }
  return null;
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
 * Flatten an unpkg "?meta" listing tree into the file paths it contains (each
 * like "/dist/jszip.min.js").
 * @param {MetaNode} node @param {string[]} [out]
 * @returns {string[]}
 */
function flattenMeta(node, out = []) {
  if (!node || typeof node !== "object") {
    return out;
  }
  if (node.type === "file" && typeof node.path === "string") {
    out.push(node.path);
  }
  for (const child of node.files ?? []) {
    flattenMeta(child, out);
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
    return res.json();
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
