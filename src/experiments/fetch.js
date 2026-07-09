// Obtains the upstream allowed-Experiments repo as a local zip: downloads the
// branch from GitHub (codeload) into the cache dir, or reuses the cached copy.
// Mirrors src/schema/fetch.js (one request for the whole branch, atomic
// download-into-cache, reuse of a cached source).
//
// Belongs here: network and on-disk cache IO that resolves the experiments
// source to a local zip path. Does NOT belong here: reading the files out of it
// or hashing them (src/experiments/verify.js).

import fs from "node:fs";
import path from "node:path";

import { debug } from "../util/log.js";
import { EXPERIMENTS_REPO, EXPERIMENTS_BRANCH } from "../config.js";

/** @param {string} branch @returns {string} Codeload zip URL for the branch. */
function codeloadUrl(branch) {
  return `https://codeload.github.com/${EXPERIMENTS_REPO}/zip/refs/heads/${encodeURIComponent(branch)}`;
}

/**
 * @param {string} cacheDir  The experiments cache directory.
 * @param {string} branch    Branch name.
 * @returns {string} Path of the branch's cached zip.
 */
export function cachedExperimentsPath(cacheDir, branch) {
  return path.join(cacheDir, `webext-experiments-${branch}.zip`);
}

/**
 * @typedef {object} ResolveExperimentsZipOpts
 * @property {string} [branch]  Branch to download (default EXPERIMENTS_BRANCH).
 * @property {string} [cacheDir]  Where to store the downloaded zip.
 * @property {boolean} [refresh]  Re-download even if a cached copy exists.
 */

/**
 * Resolve the experiments allow-list source to a local cached zip path,
 * downloading if needed. Throws on a download failure (the caller turns an
 * unavailable allow-list into a hard exit, never a review verdict).
 *
 * @param {ResolveExperimentsZipOpts} opts
 * @returns {Promise<{zipPath: string, source: string}>}
 */
export async function resolveExperimentsZip({
  branch = EXPERIMENTS_BRANCH,
  cacheDir,
  refresh = false,
} = {}) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const cached = cachedExperimentsPath(cacheDir, branch);

  if (fs.existsSync(cached) && !refresh) {
    debug(`Using cached experiments zip: ${cached}`);
    return { zipPath: cached, source: `cache:${branch}` };
  }

  const url = codeloadUrl(branch);
  debug(`Downloading allowed experiments (${branch}) from ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to download the allowed-experiments list "${branch}": HTTP ${res.status} ${res.statusText}. ` +
        `Source: ${url}`
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // Write atomically so an interrupted download can't leave a truncated cache.
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
