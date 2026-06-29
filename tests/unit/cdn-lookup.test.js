// Unit tests for the jsDelivr CDN hash-lookup identifier (resolveCdnLibraries): a
// hit promotes an unrecognized minified bundle into the vendored family
// (library + libraryId + cdn + nonAuthored), a miss/offline leaves it minified, and
// results are cached on disk so a second run makes no request. All via an injected
// `net` - no real network.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifyBundled } from "../../src/checks/lib/bundled.js";
import {
  resolveCdnLibraries,
  cdnUrl,
} from "../../src/checks/lib/cdn-lookup.js";
import findLibOnCdn from "../../src/checks/rules/find-lib-on-cdn.js";
import missingLibrary from "../../src/checks/rules/missing-library.js";
import minifiedCode from "../../src/checks/rules/minified-code.js";

// One long, dense line -> minified by geometry (same fixture style as bundled.test.js).
const MINIFIED = `var data=[${"1,".repeat(700)}1];`;

const addonWith = (files) => ({
  files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
});

// A net that answers the lookup for known hashes; records the URLs it was asked.
function netFor(map) {
  const calls = [];
  return {
    calls,
    async fetchJson(url) {
      calls.push(url);
      const hash = url.split("/").pop();
      if (map.has(hash)) {
        return map.get(hash);
      }
      throw new Error("HTTP 404"); // jsDelivr 404 surfaces as a throw via fetchJson
    },
  };
}

function tmpCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cdn-cache-"));
}

// Classify an addon so resolveCdnLibraries has tags to promote.
function classify(addon) {
  addon.bundled = classifyBundled(addon);
  return addon;
}

test("a hit promotes the bundle into the vendored family (library + libraryId + cdn)", async () => {
  const addon = classify(addonWith({ "app/fuse.min.js": MINIFIED }));
  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const hash = rawSha256(addon.files.get("app/fuse.min.js"));
  const net = netFor(
    new Map([
      [
        hash,
        {
          type: "npm",
          name: "fuse.js",
          version: "7.0.0",
          file: "/dist/fuse.min.js",
        },
      ],
    ])
  );

  await resolveCdnLibraries(addon, { net, cacheDir: tmpCacheDir() });

  const tag = addon.bundled.classified.find(
    (c) => c.file === "app/fuse.min.js"
  );
  assert.equal(tag.library, true);
  assert.deepEqual(tag.libraryId, { name: "fuse.js", version: "7.0.0" });
  assert.equal(
    tag.cdn.url,
    "https://cdn.jsdelivr.net/npm/fuse.js@7.0.0/dist/fuse.min.js"
  );
  assert.ok(addon.bundled.nonAuthored.has("app/fuse.min.js"));

  // The new check reports it; minified-code and missing-library do NOT.
  const ctx = { addon };
  assert.deepEqual(
    findLibOnCdn.run(ctx).map((f) => [f.file, f.item, f.hint]),
    [
      [
        "app/fuse.min.js",
        "fuse.js 7.0.0",
        "https://cdn.jsdelivr.net/npm/fuse.js@7.0.0/dist/fuse.min.js",
      ],
    ]
  );
  assert.equal(minifiedCode.run(ctx).length, 0);
  assert.equal(missingLibrary.run(ctx).length, 0);
});

test("--scan-minified still identifies a known library on the CDN", async () => {
  // scanMinified clears tag.minified (the bundle would be scanned as authored),
  // but a real library must still be recognised - keyed on minifiedGeometry.
  const addon = addonWith({ "app/fuse.min.js": MINIFIED });
  addon.bundled = classifyBundled(addon, { scanMinified: true });
  const tag0 = addon.bundled.classified.find(
    (c) => c.file === "app/fuse.min.js"
  );
  assert.equal(tag0.minified, false, "scanMinified cleared the minified flag");
  assert.equal(tag0.minifiedGeometry, true, "but the geometry signal is kept");

  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const hash = rawSha256(addon.files.get("app/fuse.min.js"));
  const net = netFor(
    new Map([
      [
        hash,
        {
          type: "npm",
          name: "fuse.js",
          version: "7.0.0",
          file: "/dist/fuse.min.js",
        },
      ],
    ])
  );
  await resolveCdnLibraries(addon, { net, cacheDir: tmpCacheDir() });

  const tag = addon.bundled.classified.find(
    (c) => c.file === "app/fuse.min.js"
  );
  assert.equal(tag.library, true);
  assert.equal(tag.cdn.type, "npm");
  assert.ok(addon.bundled.nonAuthored.has("app/fuse.min.js"));
  assert.equal(findLibOnCdn.run({ addon }).length, 1);
});

test("a miss leaves the bundle minified (falls through to minified-code)", async () => {
  const addon = classify(addonWith({ "app/blob.js": MINIFIED }));
  const net = netFor(new Map()); // nothing matches -> 404

  await resolveCdnLibraries(addon, { net, cacheDir: tmpCacheDir() });

  const tag = addon.bundled.classified.find((c) => c.file === "app/blob.js");
  assert.equal(tag.library, false);
  assert.equal(tag.cdn, undefined);
  const ctx = { addon };
  assert.equal(findLibOnCdn.run(ctx).length, 0);
  assert.deepEqual(
    minifiedCode.run(ctx).map((f) => f.file),
    ["app/blob.js"]
  );
});

test("a thrown network error is swallowed and leaves the bundle minified", async () => {
  const addon = classify(addonWith({ "app/blob.js": MINIFIED }));
  const net = {
    async fetchJson() {
      throw new Error("ENOTFOUND data.jsdelivr.com");
    },
  };
  await resolveCdnLibraries(addon, { net, cacheDir: tmpCacheDir() });
  const tag = addon.bundled.classified.find((c) => c.file === "app/blob.js");
  assert.equal(tag.library, false);
});

// A transient failure (offline / 5xx / DNS) must NOT be cached as a permanent
// miss: a later online run has to retry. A genuine 404 IS a stable, content-
// addressed negative, so it is cached and not re-queried.
test("a transient error is retried next run; a 404 is cached", async () => {
  const cacheDir = tmpCacheDir();

  // Run 1: the network is down (no "404" in the message) -> not cached.
  let calls = 0;
  const downAddon = classify(addonWith({ "x.js": MINIFIED }));
  await resolveCdnLibraries(downAddon, {
    cacheDir,
    net: {
      async fetchJson() {
        calls += 1;
        throw new Error("fetch failed");
      },
    },
  });
  assert.equal(calls, 1);

  // Run 2: still nothing cached, so it asks again (this time a real 404).
  const again = classify(addonWith({ "x.js": MINIFIED }));
  let secondAsked = 0;
  await resolveCdnLibraries(again, {
    cacheDir,
    net: {
      async fetchJson() {
        secondAsked += 1;
        throw new Error("HTTP 404");
      },
    },
  });
  assert.equal(secondAsked, 1, "retried after the transient failure");

  // Run 3: the 404 is now cached -> no request.
  const third = classify(addonWith({ "x.js": MINIFIED }));
  let thirdAsked = 0;
  await resolveCdnLibraries(third, {
    cacheDir,
    net: {
      async fetchJson() {
        thirdAsked += 1;
        throw new Error("HTTP 404");
      },
    },
  });
  assert.equal(thirdAsked, 0, "the 404 miss was cached");
});

test("disabled or a net without fetchJson is a no-op (offline-safe)", async () => {
  const addon = classify(addonWith({ "app/blob.js": MINIFIED }));
  // enabled:false -> never touches the net.
  let called = false;
  const spy = {
    async fetchJson() {
      called = true;
      throw new Error("should not be called");
    },
  };
  await resolveCdnLibraries(addon, {
    net: spy,
    cacheDir: tmpCacheDir(),
    enabled: false,
  });
  assert.equal(called, false);
  // a net with no fetchJson (the golden harness shape) is skipped entirely.
  await resolveCdnLibraries(addon, { net: {}, cacheDir: tmpCacheDir() });
  assert.equal(
    addon.bundled.classified.find((c) => c.file === "app/blob.js").library,
    false
  );
});

test("results are cached on disk: a second run makes no request (hits + misses)", async () => {
  const cacheDir = tmpCacheDir();
  const hitAddon = classify(addonWith({ "a.js": MINIFIED }));
  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const hitHash = rawSha256(hitAddon.files.get("a.js"));
  const net = netFor(
    new Map([
      [
        hitHash,
        { type: "npm", name: "lib", version: "1.0.0", file: "/lib.min.js" },
      ],
    ])
  );

  // First run populates the cache (one request for the hit).
  await resolveCdnLibraries(hitAddon, { net, cacheDir });
  const firstCalls = net.calls.length;
  assert.ok(firstCalls >= 1);

  // Second run over a freshly classified copy: same hashes -> served from cache,
  // no new requests.
  const again = classify(addonWith({ "a.js": MINIFIED }));
  await resolveCdnLibraries(again, { net, cacheDir });
  assert.equal(
    net.calls.length,
    firstCalls,
    "no new lookups on the cached run"
  );
  assert.equal(
    again.bundled.classified.find((c) => c.file === "a.js").libraryId.name,
    "lib"
  );
});

test("cdnUrl builds npm and gh source URLs", () => {
  assert.equal(
    cdnUrl({
      type: "npm",
      name: "fuse.js",
      version: "7.0.0",
      file: "/dist/fuse.min.js",
    }),
    "https://cdn.jsdelivr.net/npm/fuse.js@7.0.0/dist/fuse.min.js"
  );
  assert.equal(
    cdnUrl({
      type: "gh",
      name: "owner/repo",
      version: "v1.2.3",
      file: "/x.js",
    }),
    "https://cdn.jsdelivr.net/gh/owner/repo@v1.2.3/x.js"
  );
});
