// Shared network-cache IO for the two GitHub-branch fetchers (src/schema/fetch.js
// and src/experiments/fetch.js): the codeload zip URL and an atomic
// download-into-cache. Each fetcher keeps its own cache-path and error wording;
// only the URL shape and the truncation-safe write are shared here.

import fs from "node:fs";

import { debug } from "./log.js";
import { writeFileAtomic } from "./atomic.js";
import { parseJson } from "./json.js";
import { rethrowIfFatal } from "../lib/errors.js";
import {
  fetchWithTimeout,
  networkSwitchedOff,
  seededResponse,
  withHttpStatus,
} from "./net.js";

/**
 * The response a test seeded for the download kept at `dest`: the cached file itself, holding
 * `{fake: SeededResponse}` in place of a copy (src/util/net.js seededResponse). Such a file is
 * no copy: the download is made, with the response played, and a success is written as the
 * copy, as a live one is. Read only with the network switched off. No download writes one.
 * @param {string} dest  The cache path.
 * @returns {import("./net.js").SeededResponse|undefined}
 */
export function seededDownload(dest) {
  if (!networkSwitchedOff()) {
    return undefined;
  }
  try {
    return seededResponse(parseJson(fs.readFileSync(dest, "utf8")));
  } catch (err) {
    rethrowIfFatal(err);
    return undefined;
  }
}

/**
 * The codeload zip URL for a whole GitHub branch (one request for the tree).
 * @param {string} repo  "owner/name".
 * @param {string} branch
 * @returns {string}
 */
export function codeloadZipUrl(repo, branch) {
  return `https://codeload.github.com/${repo}/zip/refs/heads/${encodeURIComponent(branch)}`;
}

/**
 * Download `url` to `dest` atomically - write a temp file then rename it into
 * place - so an interrupted download can't leave a truncated cache that later
 * fails with an opaque unzip error. On a 404, throws the message `describeError(res)`
 * builds (each caller words its own); any other non-ok status is no answer
 * (src/util/net.js).
 * @param {string} url
 * @param {string} dest  The final cache path.
 * @param {(res: Response) => string} describeError
 * @returns {Promise<void>}
 */
export async function downloadToCache(url, dest, describeError) {
  const buf = await fetchWithTimeout(
    url,
    async (res) => {
      if (!res.ok) {
        // The caller's wording says WHICH download failed, which is the useful half;
        // the status is stamped on so the rate gate can tell a refusal from an answer
        // and retry it (src/util/net.js).
        throw withHttpStatus(new Error(describeError(res)), res);
      }
      return Buffer.from(await res.arrayBuffer());
    },
    undefined,
    undefined,
    seededDownload(dest)
  );
  writeFileAtomic(dest, buf);
  debug(`Wrote ${buf.length} bytes to ${dest}`);
}
