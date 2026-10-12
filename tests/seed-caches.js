// Builds a pre-seeded cache directory from the committed test fixtures so the
// offline test suite drives runPipeline through the same fetch+cache+load code
// paths a real run uses - schema channel auto-detection, the experiments allow-list
// and the library-hash DB all read from disk, so the suite touches no network. Pass
// the returned dir as schemaCache / experimentsCache / libraryHashesCache.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

import { allSchemaBranches, cachedZipPath } from "../src/schema/fetch.js";
import { cachedExperimentsPath } from "../src/experiments/fetch.js";
import { cachedHashesPath } from "../src/lib/library-hashes.js";
import { runCache } from "../src/util/dest.js";
import {
  bytesKey,
  listingKey,
  withSourceCache,
} from "../src/vendor/source-cache.js";
import { withRunCache } from "../src/vendor/run-cache.js";
import { defaultNet } from "../src/vendor/verify.js";
import { makeTgz } from "./unit/tarball-fixture.js";
import {
  osvBatchKey,
  osvQueryKey,
  osvVulnKey,
} from "../src/vendor/osv-cache.js";
import { popularityKey } from "../src/vendor/popularity-cache.js";
import {
  EXPERIMENTS_BRANCH,
  VENDOR_GITHUB_REPOS_API,
  VENDOR_NPM_DOWNLOADS_API,
} from "../src/config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FIXTURE = path.join(here, "schema-fixture");
const EXPERIMENTS_FIXTURE = path.join(here, "experiments-fixture");
const LIBRARY_HASHES_FIXTURE = path.join(here, "library-hashes-fixture.txt");

/** The marker `seeded` puts on a response, so the entry helpers write it as one. */
const SEEDED = Symbol("seeded response");

/** The host's 404, as a seeded response. */
const NOT_FOUND = { status: 404 };

/**
 * A response for a cache's entry helpers to seed instead of an answer: what the host does
 * with the request (src/util/net.js SeededResponse), played by the real transport in place of
 * the host, and only while the network is off.
 * @param {import("../src/util/net.js").SeededResponse} response
 * @returns {object}
 */
export const seeded = (response) => ({ [SEEDED]: response });

/**
 * The cache entry for a value an entry helper is given: a `seeded` response, or an answer.
 * @param {unknown} value
 * @returns {{answer: unknown}|{fake: object}}
 */
const entryOf = (value) =>
  value?.[SEEDED] ? { fake: value[SEEDED] } : { answer: value };

/**
 * Seed the response the download kept at `cachedFile` gets (src/util/download.js
 * seededDownload): the cached file itself holds `{fake: response}` in place of a copy.
 * @param {string} cachedFile
 * @param {import("../src/util/net.js").SeededResponse|import("../src/util/net.js").SeededResponse[]} response
 */
export function seedDownload(cachedFile, response) {
  fs.writeFileSync(cachedFile, JSON.stringify({ fake: response }));
}

/**
 * Recursively list POSIX-relative file paths under a directory.
 * @param {string} root @param {string} [prefix]
 * @returns {string[]}
 */
function walk(root, prefix = "") {
  const out = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push(...walk(path.join(root, e.name), rel));
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

// A schema branch zip built from the schema-fixture, matching the real codeload
// layout: files nest under `webext-annotated-schemas-<branch>/schema-files/` so the
// loader (and peekApplicationVersion) exercise the same paths a downloaded zip has,
// keeping the fixture's applicationVersion stamp that drives channel auto-detection.
function schemaBranchZipBuffer(branch) {
  const root = `webext-annotated-schemas-${branch}/schema-files`;
  const zip = new AdmZip();
  for (const name of fs.readdirSync(SCHEMA_FIXTURE)) {
    if (name.endsWith(".json")) {
      zip.addFile(
        `${root}/${name}`,
        fs.readFileSync(path.join(SCHEMA_FIXTURE, name))
      );
    }
  }
  return zip.toBuffer();
}

// The experiments allow-list cache zip: the fixture files at their relative paths.
// The allow-list is content-hashed, so identical files -> identical allow-list; the
// fixture layout already carries the ".../experiments/<name>/..." path loadAllowList
// keys off.
function experimentsZipBuffer() {
  const zip = new AdmZip();
  for (const rel of walk(EXPERIMENTS_FIXTURE)) {
    zip.addFile(rel, fs.readFileSync(path.join(EXPERIMENTS_FIXTURE, rel)));
  }
  return zip.toBuffer();
}

let cached = null;

/**
 * Build (once per process) a cache dir holding every fetchable source the pipeline
 * needs, so runPipeline runs fully offline. The same dir serves as schemaCache,
 * experimentsCache and libraryHashesCache (the filenames don't collide).
 * @returns {string} The cache directory path.
 */
export function seedFixtureCache() {
  if (!cached) {
    cached = freshFixtureCache();
  }
  return cached;
}

/**
 * A seeded cache dir of its own, as seedFixtureCache builds, for a test that must not share
 * one: a run given --cache-clear empties the dir it names. Removed when the process exits.
 * @returns {string} The cache directory path.
 */
export function freshFixtureCache() {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "webext-linter-fixture-cache-")
  );
  for (const branch of allSchemaBranches()) {
    fs.writeFileSync(cachedZipPath(dir, branch), schemaBranchZipBuffer(branch));
  }
  fs.writeFileSync(
    cachedExperimentsPath(dir, EXPERIMENTS_BRANCH),
    experimentsZipBuffer()
  );
  fs.copyFileSync(LIBRARY_HASHES_FIXTURE, cachedHashesPath(dir));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * The seeded cache as runPipeline opts - the same dir pointed at every fetchable
 * source, so a review runs offline. Spread into a runPipeline() call.
 * @returns {{schemaCache: string, experimentsCache: string, libraryHashesCache: string,
 *   cdnLookupCache: string, npmRegistryCache: string, sourcesCache: string}}
 */
export function fixtureCacheOpts() {
  const dir = seedFixtureCache();
  // cdnLookupCache points at the same throwaway dir, NOT at the repo's real one. The CDN
  // identifier writes its results back, so a fixture that exercises it would otherwise
  // pollute the real CDN lookup cache - and then PASS from that cache on the next run, which
  // hides a defect in the lookup itself: a mutation that discarded every hit would
  // still pass, served from the poisoned cache.
  return {
    schemaCache: dir,
    experimentsCache: dir,
    libraryHashesCache: dir,
    cdnLookupCache: dir,
    // Empty: no fixture's lock is off the registry's tarball path, so nothing is asked,
    // and the network switch names any request that slips through.
    npmRegistryCache: dir,
    // Empty: a review that is given no sources asks for one, and the network switch names
    // it, rather than the user's own kept sources answering it.
    sourcesCache: dir,
  };
}

/** Every temporary parent freshWorkFolder and addonOutsideRepo made in this process,
 *  removed by one exit listener rather than one listener each - a suite makes hundreds. */
const workFolders = [];

/** A fresh, empty temporary folder, removed when the process exits. */
function freshParent() {
  if (!workFolders.length) {
    process.on("exit", () => {
      for (const dir of workFolders) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
  const parent = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "webext-linter-work-"))
  );
  workFolders.push(parent);
  return parent;
}

/**
 * A fresh work folder for one review run through runPipeline (its `workFolder`), removed
 * when the process exits. The folder itself does not exist yet, as a work folder a review
 * starts in must not: the review creates it. Its parent is a fresh temporary folder of its
 * own, so the path is free.
 * @returns {string} The folder's absolute path.
 */
export function freshWorkFolder() {
  return path.join(freshParent(), "work");
}

/**
 * A copy of an add-on - a file or a folder - in a fresh temporary folder of its own, under
 * the same name, removed when the process exits. A command-line review creates its work
 * folder beside the add-on, so a review of a fixture as it stands would write into
 * tests/addons, where the harness reads every folder as a fixture.
 * @param {string} addon
 * @returns {string} The copy's absolute path.
 */
export function addonOutsideRepo(addon) {
  const copy = path.join(freshParent(), path.basename(addon));
  fs.cpSync(addon, copy, { recursive: true, verbatimSymlinks: true });
  return copy;
}

/**
 * A CDN lookup cache that already holds the lookup's answer for every file under `folders`:
 * the host's 404, seeded (`{fake: {status: 404}}`), so the lookup reads that the CDN has none
 * of them and asks no host. The lookup never writes such an entry, and reads one only with
 * the network switched off, as every test runs (src/util/net.js seededResponse).
 * For a review of files a test wrote itself, which no seeded cache can know in advance.
 * Removed when the process exits.
 * @param {...string} folders
 * @returns {string} The cache directory path.
 */
export function cdnMissCache(...folders) {
  const dir = freshParent();
  const misses = {};
  for (const folder of folders) {
    for (const rel of walk(folder)) {
      const hash = createHash("sha256")
        .update(fs.readFileSync(path.join(folder, rel)))
        .digest("hex");
      misses[hash] = { fake: NOT_FOUND };
    }
  }
  fs.writeFileSync(
    path.join(dir, "jsdelivr-hash-lookup.json"),
    JSON.stringify(misses)
  );
  return dir;
}

/**
 * Add jsDelivr's hits to a CDN lookup cache (cdnMissCache), each the lookup's answer for a
 * file it knows, keyed by the file's sha256.
 * @param {string} cache  The cache directory.
 * @param {Record<string, object>} hits  sha256 -> jsDelivr's answer, or a `seeded` response.
 * @returns {string} The cache directory.
 */
export function seedCdnHits(cache, hits) {
  const file = path.join(cache, "jsdelivr-hash-lookup.json");
  const entries = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const [hash, hit] of Object.entries(hits)) {
    entries[hash] = hit?.[SEEDED] ? { fake: hit[SEEDED] } : hit;
  }
  fs.writeFileSync(file, JSON.stringify(entries));
  return cache;
}

/**
 * An npm registry cache folder (the lock check's `cacheDir`, src/vendor/locks.js) holding the
 * registry's answers given. Removed when the process exits.
 * @param {Record<string, string|object>} answers  "name@version" -> the tarball URL the
 *   registry names for that release, or a `seeded` response.
 * @returns {string} The folder's absolute path.
 */
export function seedRegistryCache(answers) {
  const dir = freshParent();
  const entries = {};
  for (const [release, answer] of Object.entries(answers)) {
    entries[release] = answer?.[SEEDED] ? { fake: answer[SEEDED] } : answer;
  }
  fs.writeFileSync(
    path.join(dir, "npm-registry.json"),
    JSON.stringify(entries)
  );
  return dir;
}

/**
 * A sources cache folder (--cache-sources-dir, the review's `sourcesCache`) holding the
 * library sources given, as src/vendor/source-cache.js keeps them. Removed when the process
 * exits.
 * @param {{bytes?: Record<string, Buffer|string>, meta?: Record<string, object>,
 *   missing?: string[]}} [sources]
 *   `bytes`: a source URL -> the body its host serves. `meta`: an unpkg `?meta` URL -> the
 *   listing. Either may be a `seeded` response instead. `missing`: URLs the host answers 404.
 * @returns {string} The folder's absolute path.
 */
export function seedSourcesCache({ bytes = {}, meta = {}, missing = [] } = {}) {
  const dir = freshParent();
  const index = {};
  for (const [url, body] of Object.entries(bytes)) {
    if (body?.[SEEDED]) {
      index[bytesKey(url)] = { fake: body[SEEDED] };
      continue;
    }
    const buf = Buffer.from(body);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    fs.writeFileSync(path.join(dir, sha256), buf);
    index[bytesKey(url)] = { sha256 };
  }
  for (const [url, answer] of Object.entries(meta)) {
    index[listingKey(url)] = entryOf(answer);
  }
  for (const url of missing) {
    index[listingKey(url) ?? bytesKey(url)] = { fake: NOT_FOUND };
  }
  fs.writeFileSync(path.join(dir, "sources.json"), JSON.stringify(index));
  return dir;
}

/**
 * The library sources a fixture's "network" map declares, as seedSourcesCache takes them:
 * each answer as the cache keeps it, and a declared status as the `seeded` response the host
 * gives instead. Each entry is what the host serves at that URL:
 *   { "sameAs": "<path>" }  the bytes of a file in the fixture, read from disk. The way to
 *                           express "this declaration checks out": a `verified` outcome
 *                           needs the upstream bytes to equal the packaged ones EXACTLY,
 *                           and an inline copy would rot the day the fixture file is edited.
 *   { "body": "<text>" }    literal bytes - the way to express "modified".
 *   { "tgz": {"<in-package path>": "<fixture path>"} }
 *                           an npm registry tarball PUBLISHING those fixture files, built
 *                           from their own bytes, each at the in-package path named, which
 *                           is what the verification checks. A committed binary would rot
 *                           the day a file is edited, and could not be read in a diff.
 *   { "meta": {"<published path>": "<fixture path>"} }
 *                           an unpkg "?meta" listing PUBLISHING those fixture files, each
 *                           entry's `integrity` computed from the file's own bytes: the way
 *                           to express "the add-on is carrying this release", which a
 *                           content hash decides. A listing whose files are meant NOT to
 *                           match is a plain `json` instead.
 *   { "json": <value> }     an unpkg "?meta" listing as written.
 *   { "status": <code> }    the host's status instead: a 404 for no such source, or a
 *                           failure.
 * @param {string} dir  The fixture directory; every fixture path resolves against it.
 * @param {Record<string, object>} specs  URL -> its entry.
 * @returns {{bytes: Record<string, Buffer|object>, meta: Record<string, object>,
 *   missing: string[]}}
 */
export function fixtureSources(dir, specs) {
  const sources = { bytes: {}, meta: {}, missing: [] };
  const read = (file, encoding) =>
    fs.readFileSync(path.join(dir, file), encoding);
  for (const [url, spec] of Object.entries(specs)) {
    const into = listingKey(url) === null ? sources.bytes : sources.meta;
    if (spec.status !== undefined && spec.status !== 200) {
      into[url] = seeded({ status: spec.status });
    } else if (spec.meta !== undefined) {
      into[url] = {
        type: "directory",
        files: Object.entries(spec.meta).map(([published, file]) => ({
          path: published,
          type: "application/javascript",
          integrity: `sha256-${createHash("sha256").update(read(file)).digest("base64")}`,
        })),
      };
    } else if (spec.json !== undefined) {
      into[url] = spec.json;
    } else if (spec.tgz !== undefined) {
      into[url] = makeTgz(
        Object.fromEntries(
          Object.entries(spec.tgz).map(([inPackage, file]) => [
            `package/${inPackage}`,
            read(file, "latin1"),
          ])
        )
      );
    } else if (spec.sameAs !== undefined) {
      into[url] = read(spec.sameAs);
    } else {
      into[url] = Buffer.from(spec.body ?? "");
    }
  }
  return sources;
}

/**
 * A run cache folder holding the answers given, for a review to read through
 * --cache-work-dir (the run's `workCache`). Removed when the process exits.
 * @param {{osv?: Record<string, object>, popularity?: Record<string, object>}} entries
 *   Built by osvEntries and popularityEntries.
 * @returns {string} The folder's absolute path.
 */
export function seedWorkCache({ osv = {}, popularity = {} } = {}) {
  const dir = freshParent();
  const files = runCache(dir, dir);
  fs.writeFileSync(files.osv, JSON.stringify(osv));
  fs.writeFileSync(files.popularity, JSON.stringify(popularity));
  return dir;
}

/**
 * The npm query OSV is sent for a "name@version" release.
 * @param {string} release
 * @returns {{version: string, package: {name: string, ecosystem: string}}}
 */
function npmQuery(release) {
  const at = release.lastIndexOf("@");
  return {
    version: release.slice(at + 1),
    package: { name: release.slice(0, at), ecosystem: "npm" },
  };
}

/**
 * OSV's answers as the run's OSV cache keeps them (src/vendor/osv-cache.js). Each is what
 * OSV itself answers, so a review reads it exactly as it reads a live reply.
 * @param {{query?: Record<string, object>, batch?: Record<string, object>,
 *   advisories?: Record<string, object>}} answers
 *   `query`: "name@version" (npm) -> the reply to that query sent alone, `{}` for a package
 *   OSV has no record of, or `{vulns: [...]}` with full advisory records.
 *   `batch`: "name@version" -> that query's result in a batch, `{}` or `{vulns: [{id}]}`,
 *   which the review hydrates through `advisories`.
 *   `advisories`: advisory id -> the record /v1/vulns/<id> serves.
 * @returns {Record<string, {answer: object}>}
 */
export function osvEntries({ query = {}, batch = {}, advisories = {} } = {}) {
  const entries = {};
  for (const [release, answer] of Object.entries(query)) {
    entries[osvQueryKey(npmQuery(release))] = entryOf(answer);
  }
  for (const [release, answer] of Object.entries(batch)) {
    entries[osvBatchKey(npmQuery(release))] = entryOf(answer);
  }
  for (const [id, answer] of Object.entries(advisories)) {
    entries[osvVulnKey(id)] = entryOf(answer);
  }
  return entries;
}

/**
 * The popularity readings as the run's popularity cache keeps them
 * (src/vendor/popularity-cache.js). Each is what the host itself answers, null where it
 * answers 404 for a package it does not know, or any other `seeded` response.
 * @param {{npm?: Record<string, ?object>, github?: Record<string, ?object>}} readings
 *   `npm`: package name -> npm's downloads reply, `{downloads: n}`.
 *   `github`: "owner/repo" -> GitHub's repository reply, `{stargazers_count: n}`.
 * @returns {Record<string, {answer: object}|{fake: object}>}
 */
export function popularityEntries({ npm = {}, github = {} } = {}) {
  const entries = {};
  const keep = (url, answer) => {
    entries[popularityKey(url)] =
      answer === null ? { fake: NOT_FOUND } : entryOf(answer);
  };
  for (const [name, answer] of Object.entries(npm)) {
    keep(`${VENDOR_NPM_DOWNLOADS_API}${name}`, answer);
  }
  for (const [repo, answer] of Object.entries(github)) {
    keep(`${VENDOR_GITHUB_REPOS_API}${repo}`, answer);
  }
  return entries;
}

/**
 * The network a review asks, as src/pipeline.js composes it, answered only from what is
 * seeded: `osv` and `popularity` into a run cache of its own (seedWorkCache), `sources` into a
 * sources cache of its own (seedSourcesCache). Anything not seeded goes on to the real
 * network, which the switched-off test network refuses.
 * @param {{osv?: object, popularity?: object, sources?: object}} [answers]  As osvEntries,
 *   popularityEntries and seedSourcesCache take them.
 * @returns {import("../src/vendor/verify.js").VendorNet}
 */
export function seededNet({ osv = {}, popularity = {}, sources = {} } = {}) {
  const dir = seedWorkCache({
    osv: osvEntries(osv),
    popularity: popularityEntries(popularity),
  });
  return withRunCache(
    withSourceCache(defaultNet, seedSourcesCache(sources)),
    runCache(dir, dir)
  );
}

/**
 * `net`, with every request it is asked recorded in `sent` and passed on untouched, with the
 * response a cache seeded for it: for a test about how often, in what order or in what
 * batches the review asks. It answers nothing itself, so every answer still comes from what
 * `net` reads.
 * @param {import("../src/vendor/verify.js").VendorNet} net
 * @returns {{net: import("../src/vendor/verify.js").VendorNet,
 *   sent: {kind: "bytes"|"json"|"post", url: string, body?: object}[]}}
 */
export function observed(net) {
  const sent = [];
  return {
    sent,
    net: {
      fetchBytes(url, seed) {
        sent.push({ kind: "bytes", url });
        return net.fetchBytes(url, seed);
      },
      fetchJson(url, seed) {
        sent.push({ kind: "json", url });
        return net.fetchJson(url, seed);
      },
      postJson(url, body, seed) {
        sent.push({ kind: "post", url, body });
        return net.postJson(url, body, seed);
      },
    },
  };
}
