// npm's and GitHub's popularity readings, kept for one RUN of a review. A source review is
// one run spread over several linter invocations - the preparation's hand-backs and the
// review - and each asks the same two hosts about the same packages, hosts that answer a
// burst by refusing. The run keeps what they answered in its cache folder (src/util/dest.js
// runCache), and each invocation reads it before it asks. No age limit: the cache lives as
// long as the run, and a new run starts with none, so a reading is never older than the
// review it decides.
//
// Kept by the package asked about: `npm:<name>` as npm spells it, `gh:<owner>/<repo>`
// lowercased, since GitHub reads a repository's name without case.
//
// Belongs here: wrapping a VendorNet so the two popularity endpoints are answered from the
// run's cache, and the file it lives in. Does NOT belong here: what a reading means
// (-> ./verify.js isPopular), or where the run's cache folder is (-> src/util/dest.js).

import fs from "node:fs";
import path from "node:path";

import {
  VENDOR_NPM_DOWNLOADS_API,
  VENDOR_GITHUB_REPOS_API,
} from "../config.js";
import { writeFileAtomic } from "../util/atomic.js";
import { parseJson } from "../util/json.js";
import { debug } from "../util/log.js";
import { rethrowIfFatal } from "../lib/errors.js";
import { seededResponse } from "../util/net.js";

/** @typedef {import("./verify.js").VendorNet} VendorNet */

/**
 * The cache key of a popularity lookup, or null for a URL this cache does not answer.
 * @param {string} url
 * @returns {?string}
 */
export function popularityKey(url) {
  const u = String(url);
  if (u.startsWith(VENDOR_NPM_DOWNLOADS_API)) {
    return `npm:${u.slice(VENDOR_NPM_DOWNLOADS_API.length)}`;
  }
  if (u.startsWith(VENDOR_GITHUB_REPOS_API)) {
    return `gh:${u.slice(VENDOR_GITHUB_REPOS_API.length).toLowerCase()}`;
  }
  return null;
}

/**
 * `net`, with the popularity lookups answered from the run's cache in `file`. Only an answer
 * is kept. A failure passes up and is not kept: the run ends on it and is handed back in the
 * same work folder once the host answers again, so a kept failure would be replayed on every
 * retry. A 404, which reads as no reading for the package (./verify.js), is not kept either.
 * An entry seeding a response (`{fake: ...}`, src/util/net.js seededResponse) is a test's
 * stand-in for what the host does: the request is made with it played in place of the host,
 * and what it gives is taken as the host's: a success is kept, a failure is not. Every other
 * request goes to `net` untouched.
 * @param {VendorNet} net
 * @param {string} file  The run's popularity cache file.
 * @returns {VendorNet}
 */
export function withPopularityCache(net, file) {
  const cache = load(file);
  return {
    ...net,
    async fetchJson(url, seeded) {
      const key = popularityKey(url);
      if (key === null) {
        return net.fetchJson(url, seeded);
      }
      const entry = Object.hasOwn(cache, key) ? cache[key] : undefined;
      if (Object.hasOwn(entry ?? {}, "answer")) {
        return entry.answer;
      }
      const answer = await net.fetchJson(url, seededResponse(entry));
      cache[key] = { answer };
      save(file, cache);
      return answer;
    },
  };
}

/**
 * The run's cached readings, or none when the file is absent or unreadable.
 * @param {string} file
 * @returns {Record<string, {answer?: unknown, fake?: object}>}
 */
function load(file) {
  try {
    const cache = parseJson(fs.readFileSync(file, "utf8"));
    return cache && typeof cache === "object" && !Array.isArray(cache)
      ? cache
      : {};
  } catch (err) {
    rethrowIfFatal(err);
    return {};
  }
}

/**
 * Persist the cache. Best-effort: a write that fails only means a later invocation of the
 * run asks again.
 * @param {string} file
 * @param {object} cache
 */
function save(file, cache) {
  try {
    writeFileAtomic(file, JSON.stringify(cache));
  } catch (err) {
    debug(
      `Could not write the popularity cache ${path.basename(file)}: ${err.message}`
    );
  }
}
