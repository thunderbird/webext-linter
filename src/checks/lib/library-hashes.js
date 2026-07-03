// Obtains the known-library hash database (Mozilla dispensary's hashes.txt) as
// text and parses it into a sha256 -> {name, version} map. The library classifier
// (src/checks/lib/bundled.js) identifies a bundled third-party library by the raw
// SHA-256 of its bytes against this map - a true content lookup, not a name/UMD
// guess. Either:
//   - reads the user-supplied --lib-mozilla-hash-db path as-is (offline/tests), or
//   - downloads the upstream hashes.txt into the cache dir (reused next run).
//
// Belongs here: the fetch/cache IO and the line parser. Does NOT belong here: the
// raw hashing of add-on files (src/normalize/hash.js rawSha256) or the library
// tag decision and its non-authored consequences (src/checks/lib/bundled.js).

import fs from "node:fs";
import path from "node:path";

import { debug } from "../../util/log.js";
import { LIBRARY_HASHES_URL, LIBRARY_HASHES_CACHE } from "../../config.js";

/**
 * @typedef {object} ResolveLibraryHashesOpts
 * @property {string} [source]    Explicit local hashes.txt path; skips network.
 * @property {string} [url]       Upstream hashes.txt URL (default from config).
 * @property {string} [cacheDir]  Where to cache the downloaded file.
 * @property {boolean} [refresh]  Re-download even if a cached copy exists.
 */

/**
 * Resolve the library-hashes source to text, downloading + caching if needed -
 * the same override/cache/fetch shape as resolveSchemaZip / resolveExperimentsZip.
 * Cache-first: a previously downloaded copy is reused without a request, so only a
 * first-ever run with no network (and no --lib-mozilla-hash-db override) reaches the
 * fetch. Throws on a download failure rather than degrading to an empty DB: a
 * partial library DB would silently change the review (a known library would go
 * unrecognized and be scanned as authored), so - like the schema and experiments
 * sources - an unavailable DB is a hard, fixable error (supply --lib-mozilla-hash-db
 * for an offline copy), never a quietly different verdict.
 * @param {ResolveLibraryHashesOpts} opts
 * @returns {Promise<{text: string, source: string}>}
 */
export async function resolveLibraryHashes({
  source,
  url = LIBRARY_HASHES_URL,
  cacheDir = LIBRARY_HASHES_CACHE,
  refresh = false,
} = {}) {
  if (source) {
    const resolved = path.resolve(source);
    if (!fs.existsSync(resolved)) {
      throw new Error(`--lib-mozilla-hash-db not found: ${resolved}`);
    }
    return {
      text: fs.readFileSync(resolved, "utf8"),
      source: `local:${resolved}`,
    };
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const cached = path.join(cacheDir, "dispensary-hashes.txt");
  if (fs.existsSync(cached) && !refresh) {
    debug(`Using cached library hashes: ${cached}`);
    return { text: fs.readFileSync(cached, "utf8"), source: "cache" };
  }

  debug(`Downloading library hashes from ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to download library hashes: HTTP ${res.status} ${res.statusText} (${url}).`
    );
  }
  const text = await res.text();
  // Atomic write, so an interrupted download is not reused as a truncated cache.
  const tmp = `${cached}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, cached);
  } finally {
    if (fs.existsSync(tmp)) {
      fs.rmSync(tmp, { force: true });
    }
  }
  debug(`Wrote ${text.length} bytes to ${cached}`);
  return { text, source: "download" };
}

/**
 * Split a dispensary spec "<name>.<version>.<filename>" (e.g.
 * "angularjs.1.0.2.angular.min.js") into {name, version}: the name is the first
 * dotted segment, the version is the following run of version-looking segments
 * (each starting with a digit), and the filename tail is dropped. Best-effort -
 * the value is only for the report; the hash match is what decides library-ness.
 * @param {string} spec
 * @returns {{name: string, version: string}}
 */
function identify(spec) {
  const parts = spec.split(".");
  const name = parts[0] || spec;
  const ver = [];
  let i = 1;
  while (i < parts.length && /^[0-9][0-9a-z-]*$/i.test(parts[i])) {
    ver.push(parts[i]);
    i += 1;
  }
  return { name, version: ver.join(".") || "?" };
}

/**
 * Parse dispensary hashes.txt into a `sha256 -> {name, version}` map. Each line
 * is "<sha256> <name>.<version>.<filename>". A bare `map.has(hash)` answers
 * library-or-not; the value names the matched release for the finding.
 * @param {string} text
 * @returns {Map<string, {name: string, version: string}>}
 */
export function parseLibraryHashes(text) {
  const map = new Map();
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const sp = trimmed.indexOf(" ");
    if (sp < 0) {
      continue;
    }
    const hash = trimmed.slice(0, sp).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      continue;
    }
    map.set(hash, identify(trimmed.slice(sp + 1).trim()));
  }
  return map;
}

// Dispensary library names that differ from their npm package name, so the OSV
// vulnerability audit (npm ecosystem) queries the right package. Every other
// dispensary name is already its npm name (jquery, bootstrap, react, react-dom,
// moment, dompurify, underscore, backbone, webextension-polyfill, mootools, dojo).
const NPM_ALIASES = new Map([
  ["angularjs", "angular"], // the AngularJS 1.x line is published as "angular"
  ["jquery-slim", "jquery"], // slim is a build of jquery - same advisories
  ["react16", "react"], // dispensary's React-16 family alias
  ["react-dom16", "react-dom"],
]);

/**
 * Map a dispensary library name to its npm package name for the OSV audit.
 * Best-effort: an unmapped name is returned unchanged - a name OSV does not know
 * simply yields no advisories, never a false positive.
 * @param {string} name  The dispensary library name (a libraryId.name).
 * @returns {string}  The npm package name to query.
 */
export function npmNameForLibrary(name) {
  return NPM_ALIASES.get(name) ?? name;
}
