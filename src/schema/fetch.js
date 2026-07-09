// Obtains the annotated-schema set as local zip files. Either:
//   - returns the user-supplied --schema-zip path as-is, or
//   - downloads the requested branch from GitHub (codeload) into the cache dir.
//
// We deliberately use the codeload zip endpoint (one request for the whole
// branch) instead of fetching each raw file individually.
//
// Belongs here: the branch namespace (channels × manifest versions, the canonical
// SIX-branch set the cache must hold) and the network + on-disk cache IO that
// resolves a schema source to a local zip path - branch -> codeload URL, atomic
// download-into-cache, cache-completeness checks, whole-set (re)download, and
// reuse of a cached or user-supplied zip.
//
// Does NOT belong here: reading or parsing the schema files out of that zip
// (src/schema/load.js), merging fragments (src/schema/merge.js), or any query
// API (src/schema/index.js). This file knows nothing about schema contents.

import fs from "node:fs";
import path from "node:path";
import { debug } from "../util/log.js";

const REPO = "thunderbird/webext-annotated-schemas";

// The channels we auto-detect between, in tie-break priority: when two channels
// share a major, the earlier one wins (release is the stable default, beta last).
// Each channel exists for both manifest versions, so the cache holds SIX branches.
export const SCHEMA_CHANNELS = ["release", "esr", "beta"];
const SCHEMA_MVS = [2, 3];

/**
 * @param {string} channel  A SCHEMA_CHANNELS entry.
 * @param {number} mv       Manifest version (2 or 3).
 * @returns {string} The branch name, e.g. "esr-mv3".
 */
export function schemaBranch(channel, mv) {
  return `${channel}-mv${mv}`;
}

/**
 * The canonical set of branches the cache must hold: every channel × manifest
 * version. Auto-population and --schema-force-refresh both operate on this whole
 * set, so the anchors stay mutually fresh (all from the same schema train).
 * @returns {string[]}
 */
export function allSchemaBranches() {
  return SCHEMA_CHANNELS.flatMap((c) =>
    SCHEMA_MVS.map((mv) => schemaBranch(c, mv))
  );
}

/**
 * @param {string} cacheDir  The schema cache directory.
 * @param {string} branch    Branch name.
 * @returns {string} Path of the branch's cached zip.
 */
export function cachedZipPath(cacheDir, branch) {
  return path.join(cacheDir, `webext-annotated-schemas-${branch}.zip`);
}

/**
 * Whether every canonical branch is already cached. A single missing branch
 * means the set is stale/incomplete and a full refresh is due.
 * @param {string} cacheDir
 * @returns {boolean}
 */
export function hasAllCachedSchemas(cacheDir) {
  return allSchemaBranches().every((b) =>
    fs.existsSync(cachedZipPath(cacheDir, b))
  );
}

/**
 * (Re)download the whole canonical branch set into the cache. Used both to
 * populate an empty/partial cache and to service --schema-force-refresh, so the
 * six branches are always fetched together (same train).
 * @param {{cacheDir?: string}} opts
 * @returns {Promise<void>}
 */
export async function refreshAllSchemas({ cacheDir = ".schema-cache" } = {}) {
  for (const branch of allSchemaBranches()) {
    await resolveSchemaZip({ branch, cacheDir, refresh: true });
  }
}

/**
 * @param {string} branch  Branch name to build a download URL for.
 * @returns {string} Codeload zip URL for the given branch.
 */
function codeloadUrl(branch) {
  return `https://codeload.github.com/${REPO}/zip/refs/heads/${encodeURIComponent(branch)}`;
}

/**
 * @typedef {object} ResolveSchemaZipOpts
 * @property {string} [schemaZip]  Explicit local zip path; skips network access.
 * @property {string} [branch]     Branch to download (default "release-mv2").
 * @property {string} [cacheDir]   Where to store downloaded zips.
 * @property {boolean} [refresh]   Re-download even if a cached copy exists.
 */

/**
 * Resolve a schema source to a local zip path, downloading if needed.
 *
 * @param {ResolveSchemaZipOpts} opts
 * @returns {Promise<{zipPath: string, source: string}>}
 */
export async function resolveSchemaZip({
  schemaZip,
  branch = "release-mv2",
  cacheDir = ".schema-cache",
  refresh = false,
} = {}) {
  if (schemaZip) {
    const resolved = path.resolve(schemaZip);
    if (!fs.existsSync(resolved)) {
      throw new Error(`--schema-zip not found: ${resolved}`);
    }
    return { zipPath: resolved, source: `local:${resolved}` };
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const cached = cachedZipPath(cacheDir, branch);

  if (fs.existsSync(cached) && !refresh) {
    debug(`Using cached schema zip: ${cached}`);
    return { zipPath: cached, source: `cache:${branch}` };
  }

  const url = codeloadUrl(branch);
  // The on-screen narration is the "Setup" feed entry (src/pipeline.js); this line
  // logs only the URL detail, under --verbose.
  debug(`Downloading annotated schemas (${branch}) from ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to download schema branch "${branch}": HTTP ${res.status} ${res.statusText}. ` +
        `Expected one of the canonical branches: ${allSchemaBranches().join(", ")}.`
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // Write atomically: a truncated cache file (e.g. an interrupted download)
  // would otherwise be reused on the next run and fail with an opaque unzip
  // error. Write to a temp file, then rename it into place.
  const tmp = `${cached}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, cached);
  } finally {
    if (fs.existsSync(tmp)) {
      fs.rmSync(tmp, { force: true });
    }
  }
  debug(`Wrote ${buf.length} bytes to ${cached}`);
  return { zipPath: cached, source: `download:${branch}` };
}
