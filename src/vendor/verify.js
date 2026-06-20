// The network half of vendor resolution, run ONCE before normalize and review.
// resolveVendor (offline) settled the no-url / untrusted / unpinned cases into
// addon.vendor.results. This step does the work that needs the network and
// writes its results into the same shared store, so the review-phase checks
// only read it (nothing is fetched twice).
//
// Two sources are verified:
//   - VENDOR entries that are trusted-host + pinned: fetch the declared URL and
//     EOL-tolerant compare against the packaged bytes (verified / modified),
//     then gate on popularity (verified / not-popular) - except a github source
//     from a first-party trusted org (e.g. github.com/thunderbird/...) is
//     accepted by provenance, skipping the popularity bar. An unfetchable URL is
//     escalated to manual review.
//   - package.json dependencies pinned to a version: fetch the published file
//     listing from unpkg ONCE (it carries a per-file sha256 integrity) and mark
//     vendored any packaged file whose content hash matches a published file's
//     integrity - matched locally, no file bytes downloaded, so it scales to a
//     large package. A file that does not hash-match is left alone, as it may be
//     the author's own code or a modified copy. The same pinned name@version is
//     also audited against OSV (auditNpm); known advisories are recorded for
//     the vendor-vulnerable check. npm-sourced VENDOR entries are audited too.
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
  VENDOR_TRUSTED_GITHUB_ORGS,
  VENDOR_FETCH_TIMEOUT_MS,
  VENDOR_FETCH_MAX_BYTES,
  VENDOR_OSV_API,
} from "../config.js";

/** @typedef {import("../addon/load.js").Addon} Addon */
/** @typedef {import("./resolve.js").VendorStore} VendorStore */
/** @typedef {import("./sources.js").VendorSource} VendorSource */
/**
 * @typedef {{fetchBytes: (url: string) => Promise<Buffer>,
 *   fetchJson: (url: string) => Promise<object>,
 *   postJson: (url: string, body: object) => Promise<object>}} VendorNet
 */
/**
 * @typedef {object} VendorVuln  One vulnerable pinned npm package (OSV audit) -
 * a package.json dependency or an npm-sourced VENDOR entry.
 * @property {string} name  npm package name.
 * @property {string} version  The bundled (pinned) version audited.
 * @property {string[]} ids  Advisory ids (CVE preferred, else OSV/GHSA).
 * @property {string} severity  Highest reported severity, or "unknown".
 * @property {string[]} fixed  Versions the advisories were fixed in (may be empty).
 * @property {string} file  Where the finding anchors (package.json or the VENDOR file).
 * @property {string} token  The string locating the declaration line in `file`.
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
      // An npm-sourced VENDOR lib is also audited for known vulnerabilities (the
      // same OSV query as a package.json dep), anchored at its VENDOR-file line.
      // A github source has no npm identity, so the vendor-vuln-unknown check
      // flags it as unaudited instead of guessing.
      const src = classifySource(entry.sourceUrl);
      if (src.kind === "npm") {
        await auditNpm(
          src.pkg,
          src.version,
          vendor.vendorFile,
          entry.sourceUrl,
          vendor,
          net
        );
      }
    }
  }
  for (const pkg of vendor.packages) {
    await verifyPackage(pkg, addon, vendor, net);
    await auditNpm(
      pkg.name,
      pkg.version,
      "package.json",
      pkg.name,
      vendor,
      net
    );
  }
}

/**
 * Audit a pinned npm package@version against the OSV vulnerability database.
 * Best-effort: a package with known advisories is recorded on
 * `vendor.vulnerabilities` (one entry aggregating its advisories, anchored at
 * `file`/`token`) for the vendor-vulnerable check; any network or parse error - or
 * an injected net without `postJson` (offline runs, the golden harness) - records
 * nothing. Drives both package.json deps and npm-sourced VENDOR entries.
 * @param {string} name  npm package name.
 * @param {string} version  The bundled (pinned) version.
 * @param {string} file  Where the finding anchors (package.json / the VENDOR file).
 * @param {string} token  The string locating the declaration line in `file`.
 * @param {VendorStore} vendor @param {VendorNet} net
 * @returns {Promise<void>}
 */
async function auditNpm(name, version, file, token, vendor, net) {
  let vulns;
  try {
    const res = await net.postJson(VENDOR_OSV_API, {
      // OSV npm versions carry no "v" prefix; a vendored URL may (e.g. "@v1.2.3").
      version: String(version).replace(/^v/i, ""),
      package: { name, ecosystem: "npm" },
    });
    vulns = Array.isArray(res?.vulns) ? res.vulns : [];
  } catch {
    return; // offline / no postJson / OSV unreachable - skip silently
  }
  if (!vulns.length) {
    return;
  }
  const ids = new Set();
  const fixed = new Set();
  let severity = "unknown";
  for (const v of vulns) {
    ids.add(advisoryId(v));
    for (const f of fixedVersions(v, name)) {
      fixed.add(f);
    }
    severity = worseSeverity(severity, vulnSeverity(v));
  }
  vendor.vulnerabilities.push({
    name,
    version,
    ids: [...ids],
    severity,
    fixed: [...fixed],
    file,
    token,
  });
}

/**
 * The advisory's preferred id: a CVE alias if present, else the OSV/GHSA id.
 * @param {object} v  An OSV vuln record.
 * @returns {string}
 */
function advisoryId(v) {
  const cve = (v?.aliases ?? []).find((a) => /^CVE-/i.test(String(a)));
  return cve || v?.id || "unknown";
}

/**
 * The fixed versions OSV lists for `name` (npm) in this advisory: the `fixed`
 * events of every matching `affected` range.
 * @param {object} v  An OSV vuln record. @param {string} name
 * @returns {string[]}
 */
function fixedVersions(v, name) {
  const out = [];
  for (const a of v?.affected ?? []) {
    if (a?.package?.ecosystem !== "npm" || a?.package?.name !== name) {
      continue;
    }
    for (const range of a?.ranges ?? []) {
      for (const ev of range?.events ?? []) {
        if (ev?.fixed) {
          out.push(String(ev.fixed));
        }
      }
    }
  }
  return out;
}

// OSV / GitHub Advisory severity labels, low to high. Unknown sorts lowest.
const SEVERITY_RANK = [
  "unknown",
  "low",
  "moderate",
  "medium",
  "high",
  "critical",
];

/**
 * A human severity label for an OSV vuln: the database-specific label (GHSA's
 * LOW/MODERATE/HIGH/CRITICAL) when present, else derived coarsely from a CVSS
 * vector, else "unknown".
 * @param {object} v  An OSV vuln record.
 * @returns {string}
 */
function vulnSeverity(v) {
  const ds = v?.database_specific?.severity;
  if (typeof ds === "string" && ds) {
    return ds.toLowerCase();
  }
  // A CVSS vector string under severity[]: map its base score band if present.
  const score = (v?.severity ?? []).find((s) => s?.score)?.score;
  if (typeof score === "string" && /^CVSS:/i.test(score)) {
    return "unknown"; // a vector without a numeric base - leave unlabelled
  }
  return "unknown";
}

/** The higher of two severity labels. @param {string} a @param {string} b */
function worseSeverity(a, b) {
  return SEVERITY_RANK.indexOf(b) > SEVERITY_RANK.indexOf(a) ? b : a;
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
 * Whether the source clears the trust bar: a broadly-used library (npm monthly
 * downloads or GitHub stars over the configured bar)
 * OR a github source from a first-party trusted org (VENDOR_TRUSTED_GITHUB_ORGS,
 * e.g. Thunderbird), which is accepted by provenance regardless of stars and
 * without a popularity lookup. A lookup error counts as "not popular" (the case
 * then goes to manual review).
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
      const owner = String(src.repo ?? "")
        .split("/")[0]
        .toLowerCase();
      if (VENDOR_TRUSTED_GITHUB_ORGS.includes(owner)) {
        return true; // first-party org (e.g. Thunderbird) - trusted by provenance
      }
      const j = await net.fetchJson(`https://api.github.com/repos/${src.repo}`);
      return Number(j?.stargazers_count) >= VENDOR_GITHUB_MIN_STARS;
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
    return readJson(await timedFetch(url));
  },
  async postJson(url, body) {
    return readJson(
      await timedFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    );
  },
};

/**
 * Read a fetch Response as JSON, enforcing the size cap. Shared by fetchJson and
 * postJson.
 * @param {Response} res
 * @returns {Promise<object>}
 */
async function readJson(res) {
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const declared = Number(res.headers.get("content-length"));
  if (declared && declared > VENDOR_FETCH_MAX_BYTES) {
    throw new Error("response exceeds size cap");
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > VENDOR_FETCH_MAX_BYTES) {
    throw new Error("response exceeds size cap");
  }
  return JSON.parse(buf.toString("utf8"));
}

/**
 * fetch() with an abort timeout. Redirects are followed - the trust is that the
 * allowlisted CDNs only redirect within their own canonical URLs.
 * @param {string} url @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
async function timedFetch(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VENDOR_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}
