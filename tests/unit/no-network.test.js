// The tests run with the network switched off (tests/offline.js): a request that would reach
// another machine fails the run, named, rather than quietly answering. These pin that the
// switch holds - in this process, and in a verify.js a test spawns - and that no caller that
// tolerates a failed request can swallow it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchWithTimeout } from "../../src/util/net.js";
import { addonOutsideRepo, seedFixtureCache } from "../seed-caches.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");

test("the tests run with the network switched off", () => {
  assert.equal(process.env.WEBEXT_LINTER_NO_NETWORK, "1");
});

test("a request to another machine is refused, in this process", async () => {
  await assert.rejects(
    () => fetchWithTimeout("https://example.com/", (r) => r.text()),
    /network request in a test: https:\/\/example\.com\//
  );
});

// The CDN lookup tolerates one failed lookup, so a refusal it could swallow would let the
// review finish on a request it was never allowed to make. Given a cache with no answer for
// the shipped file, the lookup has to ask, and the run has to fail naming the request.
test("a request a spawned review makes is refused, and ends the run", () => {
  const fixture = addonOutsideRepo(
    path.join(ROOT, "tests", "addons", "build-hygiene-sca")
  );
  const cache = seedFixtureCache();
  const emptyCdn = fs.mkdtempSync(path.join(path.dirname(fixture), "cdn-"));
  const r = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "verify.js"),
      path.join(fixture, "xpi"),
      "--sca-root",
      path.join(fixture, "src"),
      "--cache-schema-dir",
      cache,
      "--cache-hash-db-dir",
      cache,
      "--cache-experiments-dir",
      cache,
      "--cache-npm-registry-dir",
      cache,
      "--cache-cdn-lookup-dir",
      emptyCdn,
      "--cdn-lib-lookup",
      "true",
    ],
    { encoding: "utf8" }
  );
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(
    r.stderr,
    /network request in a test: https:\/\/data\.jsdelivr\.com\//
  );
});
