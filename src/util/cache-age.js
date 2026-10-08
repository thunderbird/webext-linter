// How old a cached download is allowed to get. Every download is written fresh through
// writeFileAtomic (src/util/atomic.js), so a cache file's modification time is when it was
// downloaded - and that is all a staleness check needs.
//
// Belongs here: the one age rule every cached download is held to (CACHE_MAX_AGE_DAYS).
// Does NOT belong here: what is downloaded, or what a stale cache triggers - each resolver
// decides that (src/schema/fetch.js, src/experiments/fetch.js, src/lib/library-hashes.js),
// and the per-entry ages inside the CDN lookup cache (src/lib/cdn-lookup.js).

import fs from "node:fs";
import { CACHE_MAX_AGE_DAYS } from "../config.js";
import { rethrowIfFatal } from "../lib/errors.js";

/** One day, in milliseconds. */
export const DAY_MS = 86400000;

/**
 * Whether a cached file must be downloaded again: it is missing, or older than
 * CACHE_MAX_AGE_DAYS. A file dated in the future counts as fresh only up to that same
 * margin - an mtime that cannot be trusted is no reason to keep a cache forever.
 * @param {string} file
 * @param {number} [now]  The current time, in ms.
 * @returns {boolean}
 */
export function cacheIsStale(file, now = Date.now()) {
  let mtime;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch (err) {
    rethrowIfFatal(err);
    return true;
  }
  return Math.abs(now - mtime) > CACHE_MAX_AGE_DAYS * DAY_MS;
}

/**
 * A cached file's age in hours, for the --verbose narration, or null when it is missing.
 * @param {string} file
 * @param {number} [now]
 * @returns {?number}
 */
export function cacheAgeHours(file, now = Date.now()) {
  try {
    return Math.round((now - fs.statSync(file).mtimeMs) / 3600000);
  } catch (err) {
    rethrowIfFatal(err);
    return null;
  }
}
