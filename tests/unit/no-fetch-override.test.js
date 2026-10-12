// No test reaches a host's place by the side door. A test that needs what a host does seeds
// the response in the cache of the request, and the real transport plays it, only while the
// network is switched off (src/util/net.js). Replacing fetch, or answering on a socket of its
// own, would put a test-only path under the transport and hide the one the review takes. So
// would a network a test builds of its own, an object answering fetchJson, fetchBytes or
// postJson. The one such object is tests/seed-caches.js observed, which answers nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const TESTS = path.resolve(here, "..");

/** What a test may not write: replacing fetch, or serving a socket of its own. */
const FORBIDDEN = [
  "globalThis.fetch =",
  'mock.method(globalThis, "fetch"',
  "createServer",
];

/** What a test may not write either: an object defining a network method. */
const NET_METHODS = ["fetchJson", "fetchBytes", "postJson"];

/** The one file allowed to define them: observed, a recorder that answers nothing. */
const SEED_CACHES = path.join(TESTS, "seed-caches.js");

/** Every .js file under tests/, but the add-on fixtures, which are reviewed, not run. */
function testFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      return e.name === "addons" ? [] : testFiles(full);
    }
    return e.name.endsWith(".js") ? [full] : [];
  });
}

test("no test replaces fetch or opens a socket", () => {
  const found = [];
  for (const file of testFiles(TESTS)) {
    if (file === fileURLToPath(import.meta.url)) {
      continue;
    }
    fs.readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        for (const needle of FORBIDDEN) {
          if (line.includes(needle)) {
            found.push(`${path.relative(TESTS, file)}:${i + 1}: ${needle}`);
          }
        }
      });
  }
  assert.deepEqual(found, []);
});

test("no test builds a network of its own", () => {
  const found = [];
  for (const file of testFiles(TESTS)) {
    if (file === fileURLToPath(import.meta.url) || file === SEED_CACHES) {
      continue;
    }
    fs.readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        const code = line.trimStart();
        for (const name of NET_METHODS) {
          if (
            line.includes(`${name}:`) ||
            line.includes(`async ${name}(`) ||
            code.startsWith(`${name}(`)
          ) {
            found.push(`${path.relative(TESTS, file)}:${i + 1}: ${name}`);
          }
        }
      });
  }
  assert.deepEqual(found, []);
});
