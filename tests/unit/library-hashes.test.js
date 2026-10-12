// Unit tests for the known-library hash DB module: parsing dispensary's
// hashes.txt into a sha256 -> {name, version} map, and the cache-read branch of
// the resolver (a pre-seeded cache, no network).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { seedDownload } from "../seed-caches.js";
import { DAY_MS } from "../../src/util/cache-age.js";
import { LIBRARY_HASHES_URL } from "../../src/config.js";
import { NoAnswerError } from "../../src/util/net.js";
import {
  parseLibraryHashes,
  resolveLibraryHashes,
  npmNameForLibrary,
  isCompleteHashDb,
  cachedHashesPath,
} from "../../src/lib/library-hashes.js";

/** The switched-off network's refusal of a request to `url`. @param {string} url */
const refused = (url) => (err) =>
  err.message.includes(`network request in a test: ${url}`);

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

// The DB gains library releases upstream, so a copy older than a day is not used but
// downloaded again. Nothing is seeded at first, so the switched-off network refuses the
// refresh, naming the request that proves it was asked. With the host's 200 seeded in the
// cached file, the download replaces it, and the new copy is what the next run reads.
test("resolveLibraryHashes downloads a cache older than a day again", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libhash-old-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cached = cachedHashesPath(dir);
  fs.writeFileSync(cached, `${H} lib.1.0.0.lib.js\n`);
  const old = new Date(Date.now() - 2 * DAY_MS);
  fs.utimesSync(cached, old, old);

  await assert.rejects(
    resolveLibraryHashes({ cacheDir: dir }),
    refused(LIBRARY_HASHES_URL)
  );

  seedDownload(cached, { status: 200, body: `${H} lib.2.0.0.lib.js\n` });
  fs.utimesSync(cached, old, old);
  const { text, source } = await resolveLibraryHashes({ cacheDir: dir });
  assert.equal(source, "download");
  assert.match(text, /lib\.2\.0\.0/);
  assert.match(
    fs.readFileSync(cached, "utf8"),
    /lib\.2\.0\.0/,
    "cache rewritten"
  );
  const again = await resolveLibraryHashes({ cacheDir: dir });
  assert.equal(again.source, "cache");
  assert.match(again.text, /lib\.2\.0\.0/);
});

// A refresh that gets no answer ends the review: the cached file holds the host's 503,
// seeded in place of a copy.
test("a stale hash DB whose refresh gets no answer is not used", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libhash-noans-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  seedDownload(cachedHashesPath(dir), { status: 503 });
  await assert.rejects(resolveLibraryHashes({ cacheDir: dir }), NoAnswerError);
});

// A fresh cache is used without a request: nothing is seeded, so the switched-off network
// refuses any request here, which fails the test.
test("a fresh hash DB is used without a request", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libhash-fresh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, "dispensary-hashes.txt"),
    `${H} lib.1.0.0.lib.js\n`
  );
  const { source } = await resolveLibraryHashes({ cacheDir: dir });
  assert.equal(source, "cache");
});

// A partial/corrupt cached DB must not be used: it would silently review a real
// library as authored code. isCompleteHashDb is the gate - a complete file ends with
// a newline and parses to >= 1 entry; a mid-line truncation or an error/empty body
// fails it, so resolveLibraryHashes falls through to a re-download.
test("isCompleteHashDb rejects a truncated or empty hash DB", () => {
  const complete = `${H} lib.1.0.0.lib.js\n`;
  assert.equal(isCompleteHashDb(complete), true);
  assert.equal(isCompleteHashDb(complete.slice(0, complete.length - 5)), false); // cut mid-line (no newline)
  assert.equal(isCompleteHashDb("404: Not Found"), false); // an error body: no entries
  assert.equal(isCompleteHashDb(""), false);
  assert.equal(isCompleteHashDb("# only a comment\n"), false); // newline but zero entries
});

// The gate is applied, not just defined: a fresh cache cut mid-line is not used but
// downloaded again, which the switched-off network refuses, naming the request. With the
// host's 200 seeded in the cached file, the complete copy replaces it.
test("a fresh but truncated hash DB is downloaded again", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libhash-cut-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cached = cachedHashesPath(dir);
  fs.writeFileSync(cached, `${H} lib.1.0.0.lib.js\n${"b".repeat(64)} li`);

  await assert.rejects(
    resolveLibraryHashes({ cacheDir: dir }),
    refused(LIBRARY_HASHES_URL)
  );

  seedDownload(cached, { status: 200, body: `${H} lib.2.0.0.lib.js\n` });
  const { text, source } = await resolveLibraryHashes({ cacheDir: dir });
  assert.equal(source, "download");
  assert.match(text, /lib\.2\.0\.0/);
  assert.match(fs.readFileSync(cached, "utf8"), /lib\.2\.0\.0/);
  const again = await resolveLibraryHashes({ cacheDir: dir });
  assert.equal(again.source, "cache");
  assert.match(again.text, /lib\.2\.0\.0/);
});

// A download that is not a complete DB (an error page served with a 200) ends the review
// and is never cached, so the next run does not review against it either: the cached file
// still holds the seeded response, not the page.
test("an incomplete download is refused and not cached", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libhash-bad-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cached = cachedHashesPath(dir);
  seedDownload(cached, { status: 200, body: "<html>maintenance</html>" });
  const seededFile = fs.readFileSync(cached, "utf8");
  await assert.rejects(resolveLibraryHashes({ cacheDir: dir }), /incomplete/);
  assert.equal(fs.readFileSync(cached, "utf8"), seededFile, "nothing cached");
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

// The whole cycle for the hash DB download: the host's seeded success is played through the
// transport and written as the cached DB, which the next resolve reads without a request
// (nothing is seeded then, so a request would be refused). A seeded failure is played on
// every resolve and never written.
test("hash DB: a played success is kept and read back, a played failure is never kept", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libhash-cycle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cached = cachedHashesPath(dir);
  const db = `${H} lib.2.0.0.lib.js\n`;

  seedDownload(cached, { status: 200, body: db });
  assert.deepEqual(await resolveLibraryHashes({ cacheDir: dir }), {
    text: db,
    source: "download",
  });
  assert.equal(fs.readFileSync(cached, "utf8"), db, "the copy");
  assert.deepEqual(await resolveLibraryHashes({ cacheDir: dir }), {
    text: db,
    source: "cache",
  });

  seedDownload(cached, { status: 503 });
  const seeded = fs.readFileSync(cached, "utf8");
  for (let run = 0; run < 2; run++) {
    await assert.rejects(
      resolveLibraryHashes({ cacheDir: dir }),
      (err) => err instanceof NoAnswerError && /HTTP 503/.test(err.message)
    );
    assert.equal(fs.readFileSync(cached, "utf8"), seeded, "nothing written");
  }
});
