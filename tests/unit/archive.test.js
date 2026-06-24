// Unit tests for zipHashesUnder: reading a GitHub repo ZIP archive into the
// EOL-normalized content hashes of the files under a declared subpath.

import { test } from "node:test";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";

import { zipHashesUnder } from "../../src/vendor/archive.js";
import { normalizedSha256 } from "../../src/normalize/hash.js";

// A github archive has a single top-level `<repo>-<ref>/` directory, stripped
// before the subpath match; only files under <subpath> are included.
test("zipHashesUnder hashes only files under the subpath", () => {
  const zip = new AdmZip();
  zip.addFile("repo-ref/sub/a.js", Buffer.from("AAA\n"));
  zip.addFile("repo-ref/sub/nested/b.js", Buffer.from("BBB\n"));
  zip.addFile("repo-ref/other/c.js", Buffer.from("CCC\n"));
  const hashes = zipHashesUnder(zip.toBuffer(), "sub");
  assert.equal(hashes.size, 2);
  assert.ok(hashes.has(normalizedSha256(Buffer.from("AAA\n"))));
  assert.ok(hashes.has(normalizedSha256(Buffer.from("BBB\n"))));
  assert.ok(!hashes.has(normalizedSha256(Buffer.from("CCC\n"))));
});

// EOL-tolerant: a CRLF copy upstream still matches an LF local file (and vice
// versa), the same normalization the tarball matcher uses.
test("zipHashesUnder is EOL-tolerant", () => {
  const zip = new AdmZip();
  zip.addFile("repo-ref/sub/a.js", Buffer.from("line1\r\nline2\r\n"));
  const hashes = zipHashesUnder(zip.toBuffer(), "sub");
  assert.ok(hashes.has(normalizedSha256(Buffer.from("line1\nline2\n"))));
});

// An empty subpath includes every file in the archive (the whole repo).
test("zipHashesUnder with empty subpath includes the whole repo", () => {
  const zip = new AdmZip();
  zip.addFile("repo-ref/a.js", Buffer.from("A\n"));
  zip.addFile("repo-ref/d/b.js", Buffer.from("B\n"));
  assert.equal(zipHashesUnder(zip.toBuffer(), "").size, 2);
});
