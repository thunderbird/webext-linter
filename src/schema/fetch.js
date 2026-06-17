// Obtains the annotated-schema set as a local zip file. Either:
//   - returns the user-supplied --schema-zip path as-is, or
//   - downloads the requested branch from GitHub (codeload) into the cache dir.
//
// We deliberately use the codeload zip endpoint (one request for the whole
// branch) instead of fetching each raw file individually.
//
// Belongs here: network and on-disk cache IO that resolves a schema source to a
// local zip path - branch -> codeload URL, atomic download-into-cache, and
// reuse of a cached or user-supplied zip.
//
// Does NOT belong here: reading or parsing the schema files out of that zip
// (src/schema/load.js), merging fragments (src/schema/merge.js), or any query
// API (src/schema/index.js). This file knows nothing about schema contents.

import fs from "node:fs";
import path from "node:path";
import { debug, info } from "../util/log.js";

const REPO = "thunderbird/webext-annotated-schemas";

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
  const cached = path.join(cacheDir, `webext-annotated-schemas-${branch}.zip`);

  if (fs.existsSync(cached) && !refresh) {
    debug(`Using cached schema zip: ${cached}`);
    return { zipPath: cached, source: `cache:${branch}` };
  }

  const url = codeloadUrl(branch);
  info(`Downloading annotated schemas (${branch}) from ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to download schema branch "${branch}": HTTP ${res.status} ${res.statusText}. ` +
        "Check the branch name (e.g. release-mv3, release-mv2, beta-mv3, esr-mv3, daily-mv3)."
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
