// The pinned library sources a review downloads, kept for every later review. A VENDOR entry
// or a lock install names its source exactly - an npm release, a GitHub commit, tag or
// release asset - and only such a pinned source is ever fetched (./verify.js), so the same
// source is the same bytes the next time it is named. The same releases of the same
// libraries come up again and again across submissions, and each is downloaded once. A tag
// moved upstream after its bytes were kept can only make a review stricter: the kept bytes
// no longer match a shipped file that follows the moved tag.
//
// Kept in one folder (--cache-sources-dir): `sources.json` maps `bytes:<url>` to the sha256
// of the body, kept beside it under that name, and `meta:<url>` to unpkg's `?meta` listing.
// A body is used only when its bytes still hash to that name.
//
// Belongs here: wrapping a VendorNet so source downloads and unpkg listings are answered from
// the folder, and the files it keeps there. Does NOT belong here: what a source is or how it
// is verified (-> ./verify.js), or where the folder is (-> src/config.js, src/cli.js).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../util/atomic.js";
import { parseJson } from "../util/json.js";
import { debug } from "../util/log.js";
import { rethrowIfFatal } from "../lib/errors.js";
import { httpError, networkSwitchedOff } from "../util/net.js";

/** @typedef {import("./verify.js").VendorNet} VendorNet */

/** The index file in the folder. */
const INDEX = "sources.json";

/**
 * The cache key of a listing, or null for a URL this cache does not answer: unpkg's `?meta`
 * listing of a release's files.
 * @param {string} url
 * @returns {?string}
 */
export function listingKey(url) {
  const u = String(url);
  return u.startsWith("https://unpkg.com/") && u.endsWith("?meta")
    ? `meta:${u}`
    : null;
}

/**
 * The cache key of a source download. Every fetchBytes a review makes is one.
 * @param {string} url
 * @returns {string}
 */
export function bytesKey(url) {
  return `bytes:${String(url)}`;
}

/**
 * `net`, with source downloads and unpkg listings answered from the cache folder `dir`. Only
 * an answer is kept. A failure passes up and is not kept, and neither is a 404, which reads
 * as a source that cannot be fetched (./verify.js): no download writes one, so a pre-filled
 * `{fake404: true}` entry is a test's offline stand-in for it, read only with the network
 * switched off (src/util/net.js networkSwitchedOff) and thrown as the host's 404 would be.
 * In a real run such an entry is asked again. Every other request goes to `net` untouched.
 * @param {VendorNet} net
 * @param {string} dir  The cache folder.
 * @returns {VendorNet}
 */
export function withSourceCache(net, dir) {
  const file = path.join(dir, INDEX);
  const index = load(file);
  const entryOf = (key) => (Object.hasOwn(index, key) ? index[key] : undefined);
  const missing = (entry) => entry?.fake404 === true && networkSwitchedOff();
  return {
    ...net,
    async fetchBytes(url) {
      const key = bytesKey(url);
      const entry = entryOf(key);
      const kept = keptBody(dir, entry?.sha256);
      if (kept) {
        return kept;
      }
      if (missing(entry)) {
        throw httpError({ status: 404 });
      }
      const bytes = await net.fetchBytes(url);
      const sha256 = hashOf(bytes);
      if (keep(path.join(dir, sha256), bytes)) {
        index[key] = { sha256 };
        keep(file, JSON.stringify(index));
      }
      return bytes;
    },
    async fetchJson(url) {
      const key = listingKey(url);
      if (key === null) {
        return net.fetchJson(url);
      }
      const entry = entryOf(key);
      if (Object.hasOwn(entry ?? {}, "answer")) {
        return entry.answer;
      }
      if (missing(entry)) {
        throw httpError({ status: 404 });
      }
      const answer = await net.fetchJson(url);
      index[key] = { answer };
      keep(file, JSON.stringify(index));
      return answer;
    },
  };
}

/**
 * The sha256 of `bytes`, as hex.
 * @param {Buffer} bytes
 * @returns {string}
 */
function hashOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The kept body named `sha256`, or null when there is none, or its bytes no longer hash to
 * its name.
 * @param {string} dir
 * @param {unknown} sha256
 * @returns {?Buffer}
 */
function keptBody(dir, sha256) {
  // A name the index holds is only ever a hash this module wrote, never a path.
  if (
    typeof sha256 !== "string" ||
    sha256.length !== 64 ||
    ![...sha256].every((c) => "0123456789abcdef".includes(c))
  ) {
    return null;
  }
  try {
    const bytes = fs.readFileSync(path.join(dir, sha256));
    return hashOf(bytes) === sha256 ? bytes : null;
  } catch (err) {
    rethrowIfFatal(err);
    return null;
  }
}

/**
 * The folder's index, or none when it is absent or unreadable.
 * @param {string} file
 * @returns {Record<string, {sha256?: string, answer?: unknown, fake404?: true}>}
 */
function load(file) {
  try {
    const index = parseJson(fs.readFileSync(file, "utf8"));
    return index && typeof index === "object" && !Array.isArray(index)
      ? index
      : {};
  } catch (err) {
    rethrowIfFatal(err);
    return {};
  }
}

/**
 * Write one of the folder's files. Best-effort: a write that fails only means a later review
 * downloads the source again.
 * @param {string} file
 * @param {string|Buffer} data
 * @returns {boolean}  Whether it was written.
 */
function keep(file, data) {
  try {
    writeFileAtomic(file, data);
    return true;
  } catch (err) {
    debug(
      `Could not write the sources cache ${path.basename(file)}: ${err.message}`
    );
    return false;
  }
}
