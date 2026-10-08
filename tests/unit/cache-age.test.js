// Unit tests for the one age rule every cached download is held to
// (src/util/cache-age.js): a cache is used while it is no older than
// CACHE_MAX_AGE_DAYS, and downloaded again once it is older, or missing.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cacheIsStale, DAY_MS } from "../../src/util/cache-age.js";
import { CACHE_MAX_AGE_DAYS } from "../../src/config.js";

test("a cache is stale when it is missing, or older than the limit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-age-"));
  try {
    const file = path.join(dir, "cached.bin");
    const now = Date.now();
    assert.equal(cacheIsStale(file, now), true, "missing");

    fs.writeFileSync(file, "x");
    assert.equal(cacheIsStale(file, now), false, "just written");

    const old = new Date(now - (CACHE_MAX_AGE_DAYS + 1) * DAY_MS);
    fs.utimesSync(file, old, old);
    assert.equal(cacheIsStale(file, now), true, "older than the limit");

    // A timestamp far in the future is not trusted to be recent either.
    const future = new Date(now + (CACHE_MAX_AGE_DAYS + 1) * DAY_MS);
    fs.utimesSync(file, future, future);
    assert.equal(cacheIsStale(file, now), true, "dated in the future");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
