// Unit tests for the sources cache (src/vendor/source-cache.js): every review downloads a
// pinned library source through it, so a source one review downloaded is read from the cache
// folder by the next. Each test seeds the hosts' answers as the cache's content, or a host's
// response as a `{fake: ...}` entry, and runs the cache over the real transport, which
// refuses any request nothing was seeded for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  bytesKey,
  listingKey,
  withSourceCache,
} from "../../src/vendor/source-cache.js";
import { defaultNet } from "../../src/vendor/verify.js";
import { NoAnswerError } from "../../src/util/net.js";
import { observed, seeded, seedSourcesCache } from "../seed-caches.js";

const FILE = "https://unpkg.com/leftpad@1.0.0/dist/leftpad.js";
const META = "https://unpkg.com/leftpad@1.0.0/?meta";
const LISTING = { type: "directory", files: [] };

/** The refusal of a request no cache entry seeded anything for. */
const refused = (url) => (err) =>
  err.message.includes(`network request in a test: ${url}`);

/** A fresh, empty cache folder of the test's own. */
const cacheDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "wl-source-cache-"));

const readIndex = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, "sources.json"), "utf8"));

test("a download and a listing are kept, and a repeat in another review sends nothing", async () => {
  const dir = seedSourcesCache({
    bytes: { [FILE]: "the source" },
    meta: { [META]: LISTING },
  });
  const { net: host, sent } = observed(defaultNet);
  for (let review = 0; review < 2; review++) {
    const net = withSourceCache(host, dir);
    assert.equal((await net.fetchBytes(FILE)).toString(), "the source");
    assert.deepEqual(await net.fetchJson(META), LISTING);
  }
  assert.deepEqual(sent, []);
});

// A failure is never kept, and neither is a 404: no download writes one.
test("a 404 and a failure are not kept", async () => {
  const gone = "https://unpkg.com/x@1.0.0/gone.js";
  const down = "https://unpkg.com/x@1.0.0/down.js";
  const dir = seedSourcesCache({
    bytes: {
      [gone]: seeded({ status: 404 }),
      [down]: seeded({ status: 503 }),
    },
  });
  const index = readIndex(dir);
  const { net: host, sent } = observed(defaultNet);
  for (let review = 0; review < 2; review++) {
    const net = withSourceCache(host, dir);
    await assert.rejects(net.fetchBytes(gone), (err) => err.status === 404);
    await assert.rejects(
      net.fetchBytes(down),
      (err) => err instanceof NoAnswerError && /HTTP 503/.test(err.message)
    );
  }
  assert.equal(sent.length, 4, "asked each time");
  assert.deepEqual(fs.readdirSync(dir), ["sources.json"], "nothing kept");
  assert.deepEqual(readIndex(dir), index, "nothing kept");
});

// A body is read back only while its bytes still hash to the name the index gives it: one
// changed or lost on disk is asked for again, never served.
test("a kept body that no longer matches its hash is asked for again", async () => {
  const dir = seedSourcesCache({ bytes: { [FILE]: "the source" } });
  const body = path.join(dir, readIndex(dir)[bytesKey(FILE)].sha256);
  const { net: host, sent } = observed(defaultNet);
  fs.writeFileSync(body, "tampered");
  await assert.rejects(
    withSourceCache(host, dir).fetchBytes(FILE),
    refused(FILE)
  );
  fs.rmSync(body);
  await assert.rejects(
    withSourceCache(host, dir).fetchBytes(FILE),
    refused(FILE)
  );
  assert.deepEqual(
    sent.map((s) => s.url),
    [FILE, FILE]
  );
});

// The index names a body by its hash and nothing else, so an entry naming any other file is
// not read.
test("an index entry that names no hash is not read", async () => {
  const dir = cacheDir();
  const outside = path.join(cacheDir(), "secret");
  fs.writeFileSync(outside, "secret");
  fs.writeFileSync(
    path.join(dir, "sources.json"),
    JSON.stringify({ [bytesKey(FILE)]: { sha256: outside } })
  );
  const { net: host, sent } = observed(defaultNet);
  await assert.rejects(
    withSourceCache(host, dir).fetchBytes(FILE),
    refused(FILE)
  );
  assert.deepEqual(
    sent.map((s) => s.url),
    [FILE]
  );
});

test("every other request goes to the network untouched", async () => {
  const dir = cacheDir();
  const { net: host, sent } = observed(defaultNet);
  const net = withSourceCache(host, dir);
  const registry = "https://registry.npmjs.org/x/1.0.0";
  const manifest = "https://unpkg.com/x@1.0.0/package.json";
  const post = "https://example.invalid/post";
  await assert.rejects(net.fetchJson(registry), refused(registry));
  await assert.rejects(net.fetchJson(manifest), refused(manifest));
  await assert.rejects(net.postJson(post, {}), refused(post));
  assert.deepEqual(
    sent.map((s) => s.url),
    [registry, manifest, post]
  );
  assert.deepEqual(fs.readdirSync(dir), [], "nothing kept");
  assert.equal(listingKey(manifest), null);
  assert.equal(listingKey(META), `meta:${META}`);
});

test("an unreadable index reads as empty", async () => {
  const dir = cacheDir();
  fs.writeFileSync(path.join(dir, "sources.json"), "{ not json");
  await assert.rejects(
    withSourceCache(defaultNet, dir).fetchBytes(FILE),
    refused(FILE)
  );
  assert.deepEqual(fs.readdirSync(dir), ["sources.json"], "nothing kept");
});

// The body is kept under its sha256, so the same bytes named by two URLs are kept once.
test("the same bytes from two sources are kept once", async () => {
  const a = "https://unpkg.com/a@1.0.0/x.js";
  const b = "https://unpkg.com/b@1.0.0/x.js";
  const dir = seedSourcesCache({
    bytes: {
      [a]: seeded({ status: 200, body: "same" }),
      [b]: seeded({ status: 200, body: "same" }),
    },
  });
  const net = withSourceCache(defaultNet, dir);
  await net.fetchBytes(a);
  await net.fetchBytes(b);
  const sha = createHash("sha256").update("same").digest("hex");
  assert.deepEqual(fs.readdirSync(dir).sort(), [sha, "sources.json"].sort());
});

// A seeded response is played by the real transport in place of the host, and what it gives
// is the host's answer: kept like any other, while the seeded entry itself is never written.
test("a seeded download is played through the transport and kept as an answer", async () => {
  const dir = seedSourcesCache({
    bytes: { [FILE]: seeded({ status: 200, body: "seeded body" }) },
    meta: { [META]: seeded({ status: 200, json: LISTING }) },
  });
  const net = withSourceCache(defaultNet, dir);
  assert.equal((await net.fetchBytes(FILE)).toString(), "seeded body");
  assert.deepEqual(await net.fetchJson(META), LISTING);
  const index = readIndex(dir);
  assert.deepEqual(Object.keys(index[bytesKey(FILE)]), ["sha256"]);
  assert.deepEqual(index[listingKey(META)], { answer: LISTING });
  // Kept, so it is read back without the transport.
  const { net: host, sent } = observed(defaultNet);
  const again = withSourceCache(host, dir);
  assert.equal((await again.fetchBytes(FILE)).toString(), "seeded body");
  assert.deepEqual(await again.fetchJson(META), LISTING);
  assert.deepEqual(sent, []);
});
