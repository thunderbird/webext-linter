// Unit tests for src/vendor/tarball.js: reading an npm-registry .tgz into the set
// of EOL-normalized content hashes of its regular files.

import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import { tarballHashes } from "../../src/vendor/tarball.js";
import { normalizedSha256 } from "../../src/normalize/hash.js";
import { makeTgz } from "./tarball-fixture.js";

// Every regular file is hashed; the in-archive path is irrelevant (membership is by
// content), so a `package/`-prefixed entry hashes to the bare bundled file's hash.
test("tarballHashes hashes each regular file by content", () => {
  const tgz = makeTgz({
    "package/dist/ical.js": "AAA\nBBB\n",
    "package/package.json": "{}\n",
  });
  const hashes = tarballHashes(tgz);
  assert.equal(hashes.size, 2);
  assert.ok(hashes.has(normalizedSha256(Buffer.from("AAA\nBBB\n"))));
  assert.ok(hashes.has(normalizedSha256(Buffer.from("{}\n"))));
});

// The hash is EOL-normalized on both sides, so a CRLF-published file matches an
// LF-bundled copy (and vice versa) - the developer's "allow EOL diffs".
test("tarballHashes is EOL-tolerant", () => {
  const tgz = makeTgz({ "package/a.js": "x\r\ny\r\n" });
  const hashes = tarballHashes(tgz);
  assert.ok(hashes.has(normalizedSha256(Buffer.from("x\ny")))); // LF, no trailing
});

// A non-regular entry (here a directory, and a PAX 'x' metadata block carrying
// data) is skipped, and its data block is stepped over so the following regular
// file is still found - proving the offset stays aligned past metadata.
test("tarballHashes skips directories/metadata but still reads the next file", () => {
  const tgz = makeTgz([
    { name: "package/", type: 0x35 }, // directory '5'
    { name: "package/PaxHeader", content: "path=ignored\n", type: 0x78 }, // PAX 'x'
    { name: "package/lib.js", content: "REAL\n" },
  ]);
  const hashes = tarballHashes(tgz);
  assert.equal(hashes.size, 1);
  assert.ok(hashes.has(normalizedSha256(Buffer.from("REAL\n"))));
});

// A non-gzip payload cannot be read - the caller treats the throw as unfetchable.
test("tarballHashes throws on a non-gzip payload", () => {
  assert.throws(() => tarballHashes(Buffer.from("not a gzip stream")));
});

// The unpacked-size guard (zlib maxOutputLength) aborts a decompression bomb.
test("tarballHashes enforces the unpacked-size cap", () => {
  // A single file larger than VENDOR_TARBALL_MAX_UNPACKED_BYTES (64 MB).
  const big = makeTgz({ "package/big.bin": Buffer.alloc(65 * 1024 * 1024) });
  assert.throws(() => tarballHashes(big));
  // Sanity: the same content unzips fine without the cap.
  assert.ok(zlib.gunzipSync(big).length > 64 * 1024 * 1024);
});
