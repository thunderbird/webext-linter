// Unit tests for the known-library hash DB module: parsing dispensary's
// hashes.txt into a sha256 -> {name, version} map, and the cache-read branch of
// the resolver (a pre-seeded cache, no network).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parseLibraryHashes,
  resolveLibraryHashes,
  npmNameForLibrary,
} from "../../src/checks/lib/library-hashes.js";

const H = "a".repeat(64); // a syntactically valid (if fake) sha256

test("parseLibraryHashes maps each hash to its identified name@version", () => {
  const map = parseLibraryHashes(
    `${"a".repeat(64)} jquery.3.6.0.jquery.min.js\n` +
      `${"b".repeat(64)} angularjs.1.0.2.angular.min.js\n`
  );
  assert.equal(map.size, 2);
  assert.deepEqual(map.get("a".repeat(64)), {
    name: "jquery",
    version: "3.6.0",
  });
  // Multi-segment version is kept whole; the filename tail is dropped.
  assert.deepEqual(map.get("b".repeat(64)), {
    name: "angularjs",
    version: "1.0.2",
  });
});

test("parseLibraryHashes skips blanks, comments, and malformed lines", () => {
  const map = parseLibraryHashes(
    "# a comment\n" +
      "\n" +
      "   \n" +
      "notahash jquery.1.0.0.x.js\n" + // hash not 64 hex chars
      "deadbeef\n" + // no spec at all
      `${H} bootstrap.5.3.0.bootstrap.min.css\n`
  );
  assert.equal(map.size, 1);
  assert.deepEqual(map.get(H), { name: "bootstrap", version: "5.3.0" });
});

test("parseLibraryHashes lowercases the hash key", () => {
  const upper = "A".repeat(64);
  const map = parseLibraryHashes(`${upper} lib.2.0.0.lib.js\n`);
  assert.ok(map.has("a".repeat(64)));
});

test("resolveLibraryHashes reads a pre-seeded cache without touching the network", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libhash-"));
  fs.writeFileSync(
    path.join(dir, "dispensary-hashes.txt"),
    `${H} lib.1.0.0.lib.js\n`
  );
  const { text, source } = await resolveLibraryHashes({ cacheDir: dir });
  assert.match(text, /lib\.1\.0\.0/);
  assert.equal(source, "cache");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("npmNameForLibrary maps dispensary aliases and passes others through", () => {
  // Aliases where the dispensary name differs from the npm package.
  assert.equal(npmNameForLibrary("angularjs"), "angular");
  assert.equal(npmNameForLibrary("jquery-slim"), "jquery");
  assert.equal(npmNameForLibrary("react16"), "react");
  assert.equal(npmNameForLibrary("react-dom16"), "react-dom");
  // Names that already match their npm package pass through unchanged.
  assert.equal(npmNameForLibrary("jquery"), "jquery");
  assert.equal(npmNameForLibrary("bootstrap"), "bootstrap");
  assert.equal(npmNameForLibrary("dompurify"), "dompurify");
});
