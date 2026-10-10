// OSV's answers, kept for one RUN of a review. A source review is one run spread over several
// linter invocations - the preparation's hand-backs audit the original's lock and then a
// rescued copy's, and the review audits again - and every one of them asks OSV the same
// questions. The run keeps what OSV answered in its root work folder (src/util/dest.js
// runCache), and each invocation reads it before it asks.
//
// Kept by what OSV was ASKED, never by a request's body: a batch over the same packages, put
// together differently by another invocation, is still answered from here, and only the
// queries no invocation asked yet are sent. No age limit: the cache lives as long as the run,
// and a new run starts with none, so a verdict still reflects the advisories of the day it was
// made.
//
// Belongs here: wrapping a VendorNet so the three OSV endpoints are answered from the run's
// cache, and the file it lives in. Does NOT belong here: what an answer means (-> ./verify.js),
// or where the run's root is (-> src/util/dest.js).

import fs from "node:fs";
import path from "node:path";

import {
  VENDOR_OSV_API,
  VENDOR_OSV_BATCH_API,
  VENDOR_OSV_VULN_API,
} from "../config.js";
import { writeFileAtomic } from "../util/atomic.js";
import { parseJson } from "../util/json.js";
import { debug } from "../util/log.js";
import { rethrowIfFatal } from "../lib/errors.js";

/** @typedef {import("./verify.js").VendorNet} VendorNet */

/**
 * The OSV key of one package query: its ecosystem, name and version.
 * @param {{version?: string, package?: {name?: string, ecosystem?: string}}} query
 * @returns {string}
 */
function queryKey(query) {
  return `${query?.package?.ecosystem}:${query?.package?.name}@${query?.version}`;
}

/**
 * `net`, with OSV answered from the run's cache in `file`. Only what OSV answered is kept. A
 * failure - a 404 included, which is no answer from OSV (src/vendor/verify.js askOsv) - passes
 * up and is not kept: the run ends on it, and is handed back in this same work folder once OSV
 * answers again, so a kept failure would be replayed on every retry. Every other request goes
 * to `net` untouched.
 * @param {VendorNet} net
 * @param {string} file  The run's OSV cache file.
 * @returns {VendorNet}
 */
export function withOsvCache(net, file) {
  const cache = load(file);
  const remember = (key, value) => {
    cache[key] = value;
    save(file, cache);
  };
  // Whether OSV's answer to `key` is kept. An entry without one is not, and is asked again.
  const kept = (key) => Object.hasOwn(cache[key] ?? {}, "answer");
  // Asked once, then kept.
  const once = async (key, ask) => {
    if (kept(key)) {
      return cache[key].answer;
    }
    const answer = await ask();
    remember(key, { answer });
    return answer;
  };
  return {
    ...net,
    fetchJson(url) {
      if (!String(url).startsWith(VENDOR_OSV_VULN_API)) {
        return net.fetchJson(url);
      }
      return once(`vuln:${url.slice(VENDOR_OSV_VULN_API.length)}`, () =>
        net.fetchJson(url)
      );
    },
    async postJson(url, body) {
      if (url === VENDOR_OSV_API) {
        return once(`query:${queryKey(body)}`, () => net.postJson(url, body));
      }
      if (url !== VENDOR_OSV_BATCH_API) {
        return net.postJson(url, body);
      }
      const queries = Array.isArray(body?.queries) ? body.queries : [];
      const keys = queries.map((q) => `batch:${queryKey(q)}`);
      const missing = queries.filter((_, i) => !kept(keys[i]));
      if (missing.length > 0) {
        const res = await net.postJson(url, { ...body, queries: missing });
        const results = Array.isArray(res?.results) ? res.results : [];
        // The endpoint answers positionally, one result per query sent.
        let at = 0;
        for (const [i, q] of queries.entries()) {
          if (!kept(keys[i]) && q === missing[at]) {
            cache[keys[i]] = { answer: results[at] ?? {} };
            at++;
          }
        }
        save(file, cache);
      }
      return { results: keys.map((key) => cache[key].answer) };
    },
  };
}

/**
 * The run's cached answers, or none when the file is absent or unreadable.
 * @param {string} file
 * @returns {Record<string, {answer?: unknown}>}
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
      `Could not write the OSV cache ${path.basename(file)}: ${err.message}`
    );
  }
}
