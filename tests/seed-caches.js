// Builds a pre-seeded cache directory from the committed test fixtures so the
// offline test suite drives runPipeline through the same fetch+cache+load code
// paths a real run uses - schema channel auto-detection, the experiments allow-list
// and the library-hash DB all read from disk, so the suite touches no network. Pass
// the returned dir as schemaCache / experimentsCache / libraryHashesCache.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

import { allSchemaBranches, cachedZipPath } from "../src/schema/fetch.js";
import { cachedExperimentsPath } from "../src/experiments/fetch.js";
import { cachedHashesPath } from "../src/lib/library-hashes.js";
import { EXPERIMENTS_BRANCH } from "../src/config.js";

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
  if (cached) {
    return cached;
  }
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
  cached = dir;
  return dir;
}

/**
 * The seeded cache as runPipeline opts - the same dir pointed at every fetchable
 * source, so a review runs offline. Spread into a runPipeline() call.
 * @returns {{schemaCache: string, experimentsCache: string, libraryHashesCache: string}}
 */
export function fixtureCacheOpts() {
  const dir = seedFixtureCache();
  return { schemaCache: dir, experimentsCache: dir, libraryHashesCache: dir };
}
