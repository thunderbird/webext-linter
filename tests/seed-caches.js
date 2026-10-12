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
 *   cdnLookupCache: string, npmRegistryCache: string}}
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
 * the host's 404, pre-filled (`{fake404: true}`), so the lookup reads that the CDN has none
 * of them and asks no host. The lookup never writes such an entry, and reads one only with
 * the network switched off, as every test runs (src/lib/cdn-lookup.js).
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
      misses[hash] = { fake404: true };
    }
  }
  fs.writeFileSync(
    path.join(dir, "jsdelivr-hash-lookup.json"),
    JSON.stringify(misses)
  );
  return dir;
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
    entries[osvQueryKey(npmQuery(release))] = { answer };
  }
  for (const [release, answer] of Object.entries(batch)) {
    entries[osvBatchKey(npmQuery(release))] = { answer };
  }
  for (const [id, answer] of Object.entries(advisories)) {
    entries[osvVulnKey(id)] = { answer };
  }
  return entries;
}

/**
 * The popularity readings as the run's popularity cache keeps them
 * (src/vendor/popularity-cache.js). Each is what the host itself answers, or null where it
 * answers 404 for a package it does not know, kept as the offline stand-in for that 404.
 * @param {{npm?: Record<string, ?object>, github?: Record<string, ?object>}} readings
 *   `npm`: package name -> npm's downloads reply, `{downloads: n}`.
 *   `github`: "owner/repo" -> GitHub's repository reply, `{stargazers_count: n}`.
 * @returns {Record<string, {answer: object}|{fake404: true}>}
 */
export function popularityEntries({ npm = {}, github = {} } = {}) {
  const entries = {};
  const keep = (url, answer) => {
    entries[popularityKey(url)] =
      answer === null ? { fake404: true } : { answer };
  };
  for (const [name, answer] of Object.entries(npm)) {
    keep(`${VENDOR_NPM_DOWNLOADS_API}${name}`, answer);
  }
  for (const [repo, answer] of Object.entries(github)) {
    keep(`${VENDOR_GITHUB_REPOS_API}${repo}`, answer);
  }
  return entries;
}
