// Unit tests for the jsDelivr CDN hash-lookup identifier (resolveCdnLibraries): a
// hit promotes an unrecognized bundle - minified, or a large readable one - into the
// vendored family (library + libraryId + cdn + nonAuthored), a miss/offline leaves it
// as classified, and results are cached on disk so a second run makes no request. All
// via an injected `net` - no real network.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifyBundled } from "../../src/lib/bundled.js";
import { VERDICT } from "../../src/lib/enum.js";
import { resolveCdnLibraries, cdnUrl } from "../../src/lib/cdn-lookup.js";
import { NetworkGoneError } from "../../src/util/net.js";
import findLibOnCdn from "../../src/checks/rules/find-lib-on-cdn.js";
import missingLibrary from "../../src/checks/rules/missing-library.js";
import minifiedCode from "../../src/checks/rules/minified-code.js";
import untrustedLibrary from "../../src/checks/rules/untrusted-library.js";
import untrustedMinifiedLibrary from "../../src/checks/rules/untrusted-minified-library.js";

// One long line packing many statements -> minified (same fixture style as
// bundled.test.js). >= 1024 bytes so it is classified, not skipped.
const MINIFIED = `var a=0;${"a=a+1;".repeat(250)}`;

const addonWith = (files) => ({
  files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
});

// A net that answers the jsDelivr hash lookup for known hashes AND the popularity
// trust-bar lookups (npm last-month downloads / GitHub stars) resolveCdnLibraries
// now makes for each hit. `downloads`/`stars` default well above the bars
// (VENDOR_NPM_MIN_DOWNLOADS=1000 / VENDOR_GITHUB_MIN_STARS=100) so a hit is popular
// unless a test overrides them. Records every URL it was asked.
function netFor(map, { downloads = 5000, stars = 500 } = {}) {
  const calls = [];
  return {
    calls,
    // Hash-lookup calls only (excludes the popularity endpoints), so a test can
    // assert the jsDelivr lookup was cached while popularity is re-checked.
    get lookupCalls() {
      return calls.filter(
        (u) => !u.includes("api.npmjs.org") && !u.includes("api.github.com")
      );
    },
    async fetchJson(url) {
      calls.push(url);
      if (url.includes("api.npmjs.org/downloads/point/last-month/")) {
        return { downloads };
      }
      if (url.includes("api.github.com/repos/")) {
        return { stargazers_count: stars };
      }
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
    findLibOnCdn.run(ctx).findings.map((f) => [f.file, f.item, f.hint]),
    [
      [
        "app/fuse.min.js",
        "fuse.js 7.0.0",
        "https://cdn.jsdelivr.net/npm/fuse.js@7.0.0/dist/fuse.min.js",
      ],
    ]
  );
  assert.equal(minifiedCode.run(ctx).findings.length, 0);
  assert.equal(missingLibrary.run(ctx).findings.length, 0);
});

test("a NOT-popular hit is identified but untrusted (authored code), not the vendored family", async () => {
  const addon = classify(addonWith({ "app/obscure.min.js": MINIFIED }));
  addon.vendor = { results: [] };
  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const hash = rawSha256(addon.files.get("app/obscure.min.js"));
  const net = netFor(
    new Map([
      [
        hash,
        {
          type: "npm",
          name: "@me/obscure",
          version: "1.0.0",
          file: "/dist/obscure.min.js",
        },
      ],
    ]),
    { downloads: 50 } // below VENDOR_NPM_MIN_DOWNLOADS (1000)
  );

  await resolveCdnLibraries(addon, { net, cacheDir: tmpCacheDir() });

  const tag = addon.bundled.classified.find(
    (c) => c.file === "app/obscure.min.js"
  );
  // Identified (libraryId + cdn kept for OSV / the source URL) but NOT promoted to
  // the trusted vendored family: untrusted, not library.
  assert.equal(tag.untrusted, true);
  assert.equal(tag.library, false);
  assert.equal(tag.cdn.popular, false);
  assert.deepEqual(tag.libraryId, { name: "@me/obscure", version: "1.0.0" });
  // Minified -> unreadable -> stays in the non-authored skip set (the reject asks
  // for a readable build), and is recorded on the untrusted list - not vendor.results.
  assert.ok(addon.bundled.nonAuthored.has("app/obscure.min.js"));
  assert.deepEqual(addon.bundled.untrusted, [
    {
      file: "app/obscure.min.js",
      source:
        "https://cdn.jsdelivr.net/npm/@me/obscure@1.0.0/dist/obscure.min.js",
      name: "@me/obscure 1.0.0",
      unreadable: true,
    },
  ]);
  assert.deepEqual(addon.vendor.results, []);

  const ctx = { addon };
  // find-lib-on-cdn + minified-code stay silent; untrusted-minified-library rejects
  // it; untrusted-library stays silent because it reports only READABLE ones.
  assert.equal(findLibOnCdn.run(ctx).findings.length, 0);
  assert.equal(minifiedCode.run(ctx).findings.length, 0);
  assert.equal(untrustedLibrary.run(ctx).findings.length, 0);
  const rejects = untrustedMinifiedLibrary.run(ctx).findings;
  assert.equal(rejects.length, 1);
  assert.match(rejects[0].item, /@me\/obscure 1\.0\.0/);
});

// A not-popular package can contain the exact bytes of a well-known library it merely
// vendors (e.g. a pdf-lib.min.js republished inside some SDK package). Naming that
// package as the file's upstream would misattribute the file, so a not-popular hit
// whose package name does not match the file name is discarded entirely - the file is
// handled exactly like a lookup miss (falls through to minified-code).
test("a NOT-popular hit whose package name does not match the file is discarded", async () => {
  const addon = classify(addonWith({ "pdf-lib.min.js": MINIFIED }));
  addon.vendor = { results: [] };
  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const hash = rawSha256(addon.files.get("pdf-lib.min.js"));
  const net = netFor(
    new Map([
      [
        hash,
        {
          type: "npm",
          name: "cw_office_sdk",
          version: "1.3.5",
          file: "/components/cw-pdf-editor/util/pdf-lib.min.js",
        },
      ],
    ]),
    { downloads: 50 } // below VENDOR_NPM_MIN_DOWNLOADS (1000)
  );

  await resolveCdnLibraries(addon, { net, cacheDir: tmpCacheDir() });

  const tag = addon.bundled.classified.find((c) => c.file === "pdf-lib.min.js");
  // No identification at all: no libraryId (nothing to OSV-audit under the wrong
  // package), no cdn marker, not untrusted - just an unidentified minified bundle.
  assert.equal(tag.library, false);
  assert.equal(tag.libraryId, undefined);
  assert.equal(tag.cdn, undefined);
  assert.notEqual(tag.untrusted, true);
  assert.deepEqual(addon.bundled.untrusted, []);

  const ctx = { addon };
  assert.equal(untrustedMinifiedLibrary.run(ctx).findings.length, 0);
  assert.equal(untrustedLibrary.run(ctx).findings.length, 0);
  assert.equal(findLibOnCdn.run(ctx).findings.length, 0);
  assert.deepEqual(
    minifiedCode.run(ctx).findings.map((f) => f.file),
    ["pdf-lib.min.js"]
  );
});

// The discard is policy, applied AFTER the cache: the raw hit stays cached, so a
// second run makes no new hash lookup - and if the package later clears the
// popularity bar, the same cached hit promotes the file into the vendored family.
test("a discarded hit stays cached; a later popularity flip promotes it from cache", async () => {
  const cacheDir = tmpCacheDir();
  const hit = {
    type: "npm",
    name: "cw_office_sdk",
    version: "1.3.5",
    file: "/components/cw-pdf-editor/util/pdf-lib.min.js",
  };

  // Run 1: not popular + name mismatch -> discarded, but the hash lookup is cached.
  const first = classify(addonWith({ "pdf-lib.min.js": MINIFIED }));
  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const hash = rawSha256(first.files.get("pdf-lib.min.js"));
  const net1 = netFor(new Map([[hash, hit]]), { downloads: 50 });
  await resolveCdnLibraries(first, { net: net1, cacheDir });
  assert.equal(net1.lookupCalls.length, 1);
  assert.equal(
    first.bundled.classified.find((c) => c.file === "pdf-lib.min.js").cdn,
    undefined
  );

  // Run 2: same cache, the package is popular this time -> promoted, no new lookup.
  const second = classify(addonWith({ "pdf-lib.min.js": MINIFIED }));
  const net2 = netFor(new Map(), { downloads: 5000 });
  await resolveCdnLibraries(second, { net: net2, cacheDir });
  assert.equal(net2.lookupCalls.length, 0, "served from cache");
  const tag = second.bundled.classified.find(
    (c) => c.file === "pdf-lib.min.js"
  );
  assert.equal(tag.library, true);
  assert.deepEqual(tag.libraryId, { name: "cw_office_sdk", version: "1.3.5" });
});

// The on-disk cache is foreign-tolerant: an entry whose name/version is not a
// non-empty string (corrupt, or written by something else) is treated as a miss -
// it must never reach the name test or the tag promotion, let alone throw.
test("a corrupt cache entry with a non-string name is treated as a miss", async () => {
  const cacheDir = tmpCacheDir();
  const addon = classify(addonWith({ "x.min.js": MINIFIED }));
  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const hash = rawSha256(addon.files.get("x.min.js"));
  fs.writeFileSync(
    path.join(cacheDir, "jsdelivr-hash-lookup.json"),
    JSON.stringify({
      [hash]: { type: "npm", name: 123, version: "1.0.0", file: "/x.min.js" },
    })
  );

  await resolveCdnLibraries(addon, { net: netFor(new Map()), cacheDir });

  const tag = addon.bundled.classified.find((c) => c.file === "x.min.js");
  assert.equal(tag.library, false);
  assert.equal(tag.libraryId, undefined);
  assert.equal(tag.cdn, undefined);
});

test("a gh-type hit uses GitHub stars for the popularity bar; a popular hit adds no vendor result", async () => {
  const addon = classify(addonWith({ "app/widget.min.js": MINIFIED }));
  addon.vendor = { results: [] };
  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const hash = rawSha256(addon.files.get("app/widget.min.js"));
  const net = netFor(
    new Map([
      [
        hash,
        {
          type: "gh",
          name: "owner/widget",
          version: "v1.2.3",
          file: "/widget.min.js",
        },
      ],
    ]),
    { stars: 500 } // above VENDOR_GITHUB_MIN_STARS (100)
  );

  await resolveCdnLibraries(addon, { net, cacheDir: tmpCacheDir() });

  const tag = addon.bundled.classified.find(
    (c) => c.file === "app/widget.min.js"
  );
  assert.equal(tag.cdn.type, "gh");
  assert.equal(tag.cdn.popular, true);
  // Popular -> the "declare it" finding fires and nothing is escalated.
  assert.equal(findLibOnCdn.run({ addon }).findings.length, 1);
  assert.deepEqual(addon.vendor.results, []);
  // The popularity lookup queried the GitHub stars API for the repo.
  assert.ok(
    net.calls.some((u) => u.includes("api.github.com/repos/owner/widget"))
  );
});

test("a minified bundle is identified as a known library on the CDN", async () => {
  // An unidentified minified bundle (tag.minified) is offered to the CDN identifier
  // before minified-code would reject it - a hit recognises it as a real library.
  const addon = addonWith({ "app/fuse.min.js": MINIFIED });
  addon.bundled = classifyBundled(addon);
  const tag0 = addon.bundled.classified.find(
    (c) => c.file === "app/fuse.min.js"
  );
  assert.equal(tag0.minified, true, "the bundle is tagged minified");

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
  assert.equal(findLibOnCdn.run({ addon }).findings.length, 1);
});

// A library shipped UN-minified (e.g. pdf.mjs) - readable, so the Mozilla hash DB
// would only recognise it if listed, and it is not minified - is still offered to the
// CDN identifier (any classified file at/above CDN_LOOKUP_READABLE_MIN_BYTES), so a
// hit excludes it from content analysis instead of scanning it as the developer's code.
test("a large readable file is CDN-identified as a library (not scanned as authored)", async () => {
  // Multi-line, low density -> readable; >= CDN_LOOKUP_READABLE_MIN_BYTES (16KB) -> eligible.
  const READABLE = "export const x = 1;\n".repeat(1000);
  const addon = classify(addonWith({ "libs/pdf.mjs": READABLE }));
  const tag0 = addon.bundled.classified.find((c) => c.file === "libs/pdf.mjs");
  assert.equal(tag0.minified, false, "the file is readable, not minified");
  assert.equal(tag0.obfuscation, VERDICT.PASS);
  assert.equal(tag0.library, false, "not yet identified");

  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const hash = rawSha256(addon.files.get("libs/pdf.mjs"));
  const net = netFor(
    new Map([
      [
        hash,
        {
          type: "npm",
          name: "pdfjs-dist",
          version: "5.6.205",
          file: "/build/pdf.mjs",
        },
      ],
    ])
  );

  await resolveCdnLibraries(addon, { net, cacheDir: tmpCacheDir() });

  const tag = addon.bundled.classified.find((c) => c.file === "libs/pdf.mjs");
  assert.equal(tag.library, true);
  assert.deepEqual(tag.libraryId, { name: "pdfjs-dist", version: "5.6.205" });
  assert.ok(
    addon.bundled.nonAuthored.has("libs/pdf.mjs"),
    "excluded from content analysis"
  );
  assert.equal(findLibOnCdn.run({ addon }).findings.length, 1);
});

// A small readable file is the developer's own source, not a bundled library: below the
// size threshold it is not looked up, so authored files are not fingerprinted to the CDN.
test("a small readable file is below the threshold and not CDN-identified", async () => {
  const SMALL = "export const y = 2;\n".repeat(80); // ~1.6KB: classified (>=1KB) but < 16KB
  const addon = classify(addonWith({ "app/util.js": SMALL }));
  assert.equal(
    addon.bundled.classified.find((c) => c.file === "app/util.js").minified,
    false
  );

  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const hash = rawSha256(addon.files.get("app/util.js"));
  const net = netFor(
    new Map([
      [
        hash,
        { type: "npm", name: "whatever", version: "1.0.0", file: "/x.js" },
      ],
    ])
  );

  await resolveCdnLibraries(addon, { net, cacheDir: tmpCacheDir() });

  const tag = addon.bundled.classified.find((c) => c.file === "app/util.js");
  assert.equal(tag.library, false, "a small readable file is not looked up");
  assert.equal(net.lookupCalls.length, 0, "not sent to the CDN");
});

// The obfuscation veto holds for readable files too: an obfuscated file is never sent
// to the CDN, so identification can never launder obfuscated code into the trusted family.
test("a readable obfuscated file is NOT CDN-identified (obfuscation is never laundered)", async () => {
  const OBFUSCATED =
    `var _0xarr = [${Array.from({ length: 60 }, (_, i) => `"item_${i}"`).join(", ")}];\n` +
    "function _0xget(i) { return _0xarr[i]; }\n" +
    Array.from({ length: 20 }, (_, i) => `console["log"](_0xget(${i}));`).join(
      "\n"
    );
  const addon = classify(addonWith({ "libs/packed.js": OBFUSCATED }));
  const tag0 = addon.bundled.classified.find(
    (c) => c.file === "libs/packed.js"
  );
  assert.equal(tag0.obfuscation, VERDICT.FAIL);
  assert.equal(tag0.minified, false);

  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const hash = rawSha256(addon.files.get("libs/packed.js"));
  const net = netFor(
    new Map([
      [hash, { type: "npm", name: "somelib", version: "1.0.0", file: "/x.js" }],
    ])
  );

  await resolveCdnLibraries(addon, { net, cacheDir: tmpCacheDir() });

  const tag = addon.bundled.classified.find((c) => c.file === "libs/packed.js");
  assert.equal(tag.library, false, "obfuscated file is not promoted");
  assert.equal(tag.cdn, undefined, "not even looked up");
  assert.equal(
    net.lookupCalls.length,
    0,
    "the obfuscated file is never sent to the CDN"
  );
});

// A NOT-popular readable hit is identified but untrusted, and - being readable - is
// reviewed as authored code (removed from the skip set) and flagged info by
// untrusted-library, NOT rejected as an unreadable bundle.
test("a NOT-popular readable hit is untrusted and reviewed as authored (info)", async () => {
  const READABLE = "export const z = 3;\n".repeat(1000); // >= 16KB, readable
  const addon = classify(addonWith({ "libs/obscure.js": READABLE }));
  addon.vendor = { results: [] };
  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const hash = rawSha256(addon.files.get("libs/obscure.js"));
  const net = netFor(
    new Map([
      [
        hash,
        {
          type: "npm",
          name: "@me/obscure",
          version: "1.0.0",
          file: "/index.js",
        },
      ],
    ]),
    { downloads: 50 } // below the popularity bar
  );

  await resolveCdnLibraries(addon, { net, cacheDir: tmpCacheDir() });

  const tag = addon.bundled.classified.find(
    (c) => c.file === "libs/obscure.js"
  );
  assert.equal(tag.untrusted, true);
  assert.equal(tag.library, false);
  assert.equal(tag.cdn.popular, false);
  // Readable -> NOT unreadable -> removed from the skip set (reviewed as authored code).
  assert.equal(addon.bundled.nonAuthored.has("libs/obscure.js"), false);
  assert.equal(addon.bundled.untrusted[0].unreadable, false);

  const ctx = { addon };
  assert.equal(
    untrustedLibrary.run(ctx).findings.length,
    1,
    "readable untrusted -> info"
  );
  assert.equal(
    untrustedMinifiedLibrary.run(ctx).findings.length,
    0,
    "not rejected as unreadable"
  );
  assert.equal(
    findLibOnCdn.run(ctx).findings.length,
    0,
    "not-popular -> no declare-it"
  );
});

test("a miss leaves the bundle minified (falls through to minified-code)", async () => {
  const addon = classify(addonWith({ "app/blob.js": MINIFIED }));
  const net = netFor(new Map()); // nothing matches -> 404

  await resolveCdnLibraries(addon, { net, cacheDir: tmpCacheDir() });

  const tag = addon.bundled.classified.find((c) => c.file === "app/blob.js");
  assert.equal(tag.library, false);
  assert.equal(tag.cdn, undefined);
  const ctx = { addon };
  assert.equal(findLibOnCdn.run(ctx).findings.length, 0);
  assert.deepEqual(
    minifiedCode.run(ctx).findings.map((f) => f.file),
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

  // First run populates the cache (one hash lookup for the hit).
  await resolveCdnLibraries(hitAddon, { net, cacheDir });
  const firstLookups = net.lookupCalls.length;
  assert.ok(firstLookups >= 1);

  // Second run over a freshly classified copy: same hashes -> the jsDelivr HASH
  // lookup is served from cache (no new lookup). Popularity is intentionally NOT
  // cached (it is time-varying), so it is re-checked - that is fine.
  const again = classify(addonWith({ "a.js": MINIFIED }));
  await resolveCdnLibraries(again, { net, cacheDir });
  assert.equal(
    net.lookupCalls.length,
    firstLookups,
    "no new jsDelivr hash lookups on the cached run"
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

// A dead network aborts here too. The CDN identifier's catch turns a lookup failure into
// "no match", which for a dead route would mean a shipped jQuery is reviewed as the
// developer's own code and the report reads like a clean review of a different add-on.
// One dead LOOKUP still means no match - that is what an offline fixture run relies on.
test("resolveCdnLibraries propagates a dead network but swallows one dead lookup", async () => {
  const addon = classify(addonWith({ "app/lib.min.js": MINIFIED }));
  const gone = {
    fetchJson: async () => {
      throw new NetworkGoneError("https://data.jsdelivr.com/x", true);
    },
  };
  await assert.rejects(
    () => resolveCdnLibraries(addon, { net: gone, cacheDir: tmpCacheDir() }),
    NetworkGoneError
  );

  const ordinary = {
    fetchJson: async () => {
      throw new Error("offline");
    },
  };
  const other = classify(addonWith({ "app/lib.min.js": MINIFIED }));
  await resolveCdnLibraries(other, { net: ordinary, cacheDir: tmpCacheDir() });
  const tag = other.bundled.classified.find((c) => c.file === "app/lib.min.js");
  assert.equal(tag?.cdn ?? null, null); // no match, no abort
});
