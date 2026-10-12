// Unit tests for the jsDelivr CDN hash-lookup identifier (resolveCdnLibraries): a
// hit promotes an unrecognized bundle - minified, or a large readable one - into the
// vendored family (library + libraryId + cdn + nonAuthored), a miss leaves it
// as classified, and a hit is cached on disk so a second run makes no request. Every
// answer comes from a seeded cache read through the production network path, and the
// switched-off network refuses any request not seeded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { withManifest } from "./manifest-ctx.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifyBundled } from "../../src/lib/bundled.js";
import { VERDICT } from "../../src/lib/enum.js";
import { resolveCdnLibraries, cdnUrl } from "../../src/lib/cdn-lookup.js";
import { CDN_LOOKUP_URL } from "../../src/config.js";
import { defaultNet } from "../../src/vendor/verify.js";
import {
  NetworkGoneError,
  NoAnswerError,
  setNetworkPacing,
} from "../../src/util/net.js";
import findLibOnCdn from "../../src/checks/rules/find-lib-on-cdn.js";
import missingLibrary from "../../src/checks/rules/missing-library.js";
import minifiedCode from "../../src/checks/rules/minified-code.js";
import untrustedLibrary from "../../src/checks/rules/untrusted-library.js";
import untrustedMinifiedLibrary from "../../src/checks/rules/untrusted-minified-library.js";
import {
  cdnMissCache,
  observed,
  seedCdnHits,
  seeded,
  seededNet,
} from "../seed-caches.js";

// One long line packing many statements -> minified (same fixture style as
// bundled.test.js). >= 1024 bytes so it is classified, not skipped.
const MINIFIED = `var a=0;${"a=a+1;".repeat(250)}`;

const addonWith = (files) => ({
  files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
});

// A CDN lookup cache holding jsDelivr's answers: sha256 -> its hit, or a `seeded` response.
const cdnCache = (answers) => seedCdnHits(cdnMissCache(), answers);

// The hash lookups among the requests a review sent (observed).
const lookupsIn = (sent) =>
  sent.filter((r) => r.url.startsWith(CDN_LOOKUP_URL));

// No network: jsDelivr fails before any response, and so does the host the review reached
// before it, when one was.
const GONE = { fail: "ENOTFOUND", probe: { fail: "ENOTFOUND" } };

// A request that never reaches a host: a URL that does not parse, which stays the caller's
// own failure.
const OWN_FAULT = { fail: "ERR_INVALID_URL" };
const ownFault = (err) =>
  !(err instanceof NoAnswerError) && err.cause?.code === "ERR_INVALID_URL";

function tmpCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cdn-cache-"));
}

// Classify an addon so resolveCdnLibraries has tags to promote.
function classify(addon) {
  addon.bundled = classifyBundled(addon);
  return addon;
}

// The rate gate spaces real requests against a host's budget; no request here reaches a
// host, so waiting would only cost the suite real seconds.
setNetworkPacing({ intervalMs: 0, backoffMs: 0 });

// The identifier asks about popularity per FILE, and the vendor step asks per
// DECLARATION - against the same host, which answers a burst by refusing. Sharing
// the run's memo is what makes a package cost one request per REVIEW rather than one
// per asker; two files from one package here would otherwise be two lookups.
test("the popularity memo is shared, so one package costs one lookup", async () => {
  const addon = classify(
    addonWith({ "app/a.min.js": MINIFIED, "app/b.min.js": `${MINIFIED}a=2;` })
  );
  addon.vendor = { popularity: new Map() };
  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const hit = (file) => ({
    type: "npm",
    name: "fuse.js",
    version: "7.0.0",
    file,
  });
  const cacheDir = cdnCache({
    [rawSha256(addon.files.get("app/a.min.js"))]: hit("/dist/a.min.js"),
    [rawSha256(addon.files.get("app/b.min.js"))]: hit("/dist/b.min.js"),
  });
  const { net, sent } = observed(
    seededNet({ popularity: { npm: { "fuse.js": { downloads: 5000 } } } })
  );

  await resolveCdnLibraries(addon, { net, cacheDir });

  const asked = sent.filter((r) => r.url.includes("api.npmjs.org"));
  assert.equal(asked.length, 1, "one reading for the one package");
  assert.equal(
    addon.bundled.classified.filter((c) => c.libraryId).length,
    2,
    "both files still identified"
  );
});

test("a hit promotes the bundle into the vendored family (library + libraryId + cdn)", async () => {
  const addon = classify(addonWith({ "app/fuse.min.js": MINIFIED }));
  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const hash = rawSha256(addon.files.get("app/fuse.min.js"));
  const cacheDir = cdnCache({
    [hash]: {
      type: "npm",
      name: "fuse.js",
      version: "7.0.0",
      file: "/dist/fuse.min.js",
    },
  });
  const net = seededNet({
    popularity: { npm: { "fuse.js": { downloads: 5000 } } },
  });

  await resolveCdnLibraries(addon, { net, cacheDir });

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

  // find-lib-on-cdn reports it; minified-code and missing-library do NOT.
  const ctx = { artifact: addon };
  assert.deepEqual(
    (await findLibOnCdn.run(withManifest(ctx))).findings.map((f) => [
      f.file,
      f.item,
      f.hint,
    ]),
    [
      [
        "app/fuse.min.js",
        "fuse.js 7.0.0",
        "https://cdn.jsdelivr.net/npm/fuse.js@7.0.0/dist/fuse.min.js",
      ],
    ]
  );
  assert.equal((await minifiedCode.run(withManifest(ctx))).findings.length, 0);
  assert.equal(
    (await missingLibrary.run(withManifest(ctx))).findings.length,
    0
  );
});

test("a NOT-popular hit is identified but untrusted (authored code), not the vendored family", async () => {
  const addon = classify(addonWith({ "app/obscure.min.js": MINIFIED }));
  addon.vendor = { results: [] };
  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const hash = rawSha256(addon.files.get("app/obscure.min.js"));
  const cacheDir = cdnCache({
    [hash]: {
      type: "npm",
      name: "@me/obscure",
      version: "1.0.0",
      file: "/dist/obscure.min.js",
    },
  });
  // Downloads below VENDOR_NPM_MIN_DOWNLOADS (1000).
  const net = seededNet({
    popularity: { npm: { "@me/obscure": { downloads: 50 } } },
  });

  await resolveCdnLibraries(addon, { net, cacheDir });

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

  const ctx = { artifact: addon };
  // find-lib-on-cdn + minified-code stay silent; untrusted-minified-library rejects
  // it; untrusted-library stays silent because it reports only READABLE ones.
  assert.equal((await findLibOnCdn.run(withManifest(ctx))).findings.length, 0);
  assert.equal((await minifiedCode.run(withManifest(ctx))).findings.length, 0);
  assert.equal(
    (await untrustedLibrary.run(withManifest(ctx))).findings.length,
    0
  );
  const rejects = (await untrustedMinifiedLibrary.run(withManifest(ctx)))
    .findings;
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
  const cacheDir = cdnCache({
    [hash]: {
      type: "npm",
      name: "cw_office_sdk",
      version: "1.3.5",
      file: "/components/cw-pdf-editor/util/pdf-lib.min.js",
    },
  });
  // Downloads below VENDOR_NPM_MIN_DOWNLOADS (1000).
  const net = seededNet({
    popularity: { npm: { cw_office_sdk: { downloads: 50 } } },
  });

  await resolveCdnLibraries(addon, { net, cacheDir });

  const tag = addon.bundled.classified.find((c) => c.file === "pdf-lib.min.js");
  // No identification at all: no libraryId (nothing to OSV-audit under the wrong
  // package), no cdn marker, not untrusted - just an unidentified minified bundle.
  assert.equal(tag.library, false);
  assert.equal(tag.libraryId, undefined);
  assert.equal(tag.cdn, undefined);
  assert.notEqual(tag.untrusted, true);
  assert.deepEqual(addon.bundled.untrusted, []);

  const ctx = { artifact: addon };
  assert.equal(
    (await untrustedMinifiedLibrary.run(withManifest(ctx))).findings.length,
    0
  );
  assert.equal(
    (await untrustedLibrary.run(withManifest(ctx))).findings.length,
    0
  );
  assert.equal((await findLibOnCdn.run(withManifest(ctx))).findings.length, 0);
  assert.deepEqual(
    (await minifiedCode.run(withManifest(ctx))).findings.map((f) => f.file),
    ["pdf-lib.min.js"]
  );
});

// The discard is policy, applied AFTER the cache: the raw hit stays cached, so a second run
// makes no new hash lookup - and if the package later clears the popularity bar, the same
// cached hit promotes the file into the vendored family.
test("a discarded hit stays cached; a later popularity flip promotes it from cache", async () => {
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
  // jsDelivr's hit, played in place of the host and kept like a live answer.
  const cacheDir = cdnCache({ [hash]: seeded({ status: 200, json: hit }) });
  const run1 = observed(
    seededNet({ popularity: { npm: { cw_office_sdk: { downloads: 50 } } } })
  );
  await resolveCdnLibraries(first, { net: run1.net, cacheDir });
  assert.equal(lookupsIn(run1.sent).length, 1);
  assert.equal(
    first.bundled.classified.find((c) => c.file === "pdf-lib.min.js").cdn,
    undefined
  );
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(cacheDir, "jsdelivr-hash-lookup.json"), "utf8")
    )[hash],
    hit,
    "the discarded hit stays cached"
  );

  // Run 2: same cache, the package is popular this time -> promoted, no new lookup.
  const second = classify(addonWith({ "pdf-lib.min.js": MINIFIED }));
  const run2 = observed(
    seededNet({ popularity: { npm: { cw_office_sdk: { downloads: 5000 } } } })
  );
  await resolveCdnLibraries(second, { net: run2.net, cacheDir });
  assert.equal(lookupsIn(run2.sent).length, 0, "served from cache");
  const tag = second.bundled.classified.find(
    (c) => c.file === "pdf-lib.min.js"
  );
  assert.equal(tag.library, true);
  assert.deepEqual(tag.libraryId, { name: "cw_office_sdk", version: "1.3.5" });
});

// The on-disk cache is foreign-tolerant: an entry whose name/version is not a
// non-empty string (corrupt, or written by something else) is asked again, never read as
// a hit - it must never reach the name test or the tag promotion, let alone throw.
test("a corrupt cache entry with a non-string name is treated as a miss", async () => {
  const cacheDir = tmpCacheDir();
  const addon = classify(addonWith({ "x.min.js": MINIFIED }));
  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const hash = rawSha256(addon.files.get("x.min.js"));
  // The corrupt entry also seeds jsDelivr's 404 for the lookup asked in its place.
  fs.writeFileSync(
    path.join(cacheDir, "jsdelivr-hash-lookup.json"),
    JSON.stringify({
      [hash]: {
        type: "npm",
        name: 123,
        version: "1.0.0",
        file: "/x.min.js",
        fake: { status: 404 },
      },
    })
  );

  const { net, sent } = observed(defaultNet);
  await resolveCdnLibraries(addon, { net, cacheDir });
  assert.equal(lookupsIn(sent).length, 1, "asked again");

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
  const cacheDir = cdnCache({
    [hash]: {
      type: "gh",
      name: "owner/widget",
      version: "v1.2.3",
      file: "/widget.min.js",
    },
  });
  // Stars above VENDOR_GITHUB_MIN_STARS (100).
  const { net, sent } = observed(
    seededNet({
      popularity: { github: { "owner/widget": { stargazers_count: 500 } } },
    })
  );

  await resolveCdnLibraries(addon, { net, cacheDir });

  const tag = addon.bundled.classified.find(
    (c) => c.file === "app/widget.min.js"
  );
  assert.equal(tag.cdn.type, "gh");
  assert.equal(tag.cdn.popular, true);
  // Popular -> the "declare it" finding fires and nothing is escalated.
  assert.equal(
    (await findLibOnCdn.run(withManifest({ artifact: addon }))).findings.length,
    1
  );
  assert.deepEqual(addon.vendor.results, []);
  // The popularity lookup queried the GitHub stars API for the repo.
  assert.ok(
    sent.some((r) => r.url.includes("api.github.com/repos/owner/widget"))
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
  const cacheDir = cdnCache({
    [hash]: {
      type: "npm",
      name: "fuse.js",
      version: "7.0.0",
      file: "/dist/fuse.min.js",
    },
  });
  const net = seededNet({
    popularity: { npm: { "fuse.js": { downloads: 5000 } } },
  });
  await resolveCdnLibraries(addon, { net, cacheDir });

  const tag = addon.bundled.classified.find(
    (c) => c.file === "app/fuse.min.js"
  );
  assert.equal(tag.library, true);
  assert.equal(tag.cdn.type, "npm");
  assert.ok(addon.bundled.nonAuthored.has("app/fuse.min.js"));
  assert.equal(
    (await findLibOnCdn.run(withManifest({ artifact: addon }))).findings.length,
    1
  );
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
  const cacheDir = cdnCache({
    [hash]: {
      type: "npm",
      name: "pdfjs-dist",
      version: "5.6.205",
      file: "/build/pdf.mjs",
    },
  });
  const net = seededNet({
    popularity: { npm: { "pdfjs-dist": { downloads: 5000 } } },
  });

  await resolveCdnLibraries(addon, { net, cacheDir });

  const tag = addon.bundled.classified.find((c) => c.file === "libs/pdf.mjs");
  assert.equal(tag.library, true);
  assert.deepEqual(tag.libraryId, { name: "pdfjs-dist", version: "5.6.205" });
  assert.ok(
    addon.bundled.nonAuthored.has("libs/pdf.mjs"),
    "excluded from content analysis"
  );
  assert.equal(
    (await findLibOnCdn.run(withManifest({ artifact: addon }))).findings.length,
    1
  );
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

  // Nothing is seeded: a lookup would be refused by the switched-off network.
  const { net, sent } = observed(defaultNet);

  await resolveCdnLibraries(addon, { net, cacheDir: tmpCacheDir() });

  const tag = addon.bundled.classified.find((c) => c.file === "app/util.js");
  assert.equal(tag.library, false, "a small readable file is not looked up");
  assert.equal(sent.length, 0, "not sent to the CDN");
});

// Being minified waives the readable floor, not the classification floor: a packed chunk
// too small to be a library release is never hashed to the CDN, at any density.
test("a minified file below the classification floor is not sent to the CDN", async () => {
  const TINY = `var a=0;${"a=a+1;".repeat(100)}`; // ~600 bytes, under 1KB
  const addon = classify(addonWith({ "app/chunk.js": TINY }));
  assert.equal(
    addon.bundled.classified.find((c) => c.file === "app/chunk.js").minified,
    true
  );
  // Nothing is seeded: a lookup would be refused by the switched-off network.
  const { net, sent } = observed(defaultNet);

  await resolveCdnLibraries(addon, { net, cacheDir: tmpCacheDir() });

  assert.equal(sent.length, 0, "not sent to the CDN");
  assert.equal(
    addon.bundled.classified.find((c) => c.file === "app/chunk.js").libraryId,
    undefined
  );
});

// A file the Mozilla hash DB already named is never asked of the CDN: that would hash a
// known library to a third party for nothing, and a hit would rename the release the OSV
// audit queries.
test("a file the hash DB identified is not looked up again", async () => {
  const addon = addonWith({ "lib/jquery.min.js": MINIFIED });
  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const hash = rawSha256(addon.files.get("lib/jquery.min.js"));
  addon.bundled = classifyBundled(addon, {
    libraryHashes: new Map([[hash, { name: "jquery", version: "3.6.0" }]]),
  });
  // Nothing is seeded: a request would be refused by the switched-off network.
  const { net, sent } = observed(defaultNet);

  await resolveCdnLibraries(addon, { net, cacheDir: tmpCacheDir() });

  assert.equal(sent.length, 0, "no request at all");
  const tag = addon.bundled.classified.find(
    (c) => c.file === "lib/jquery.min.js"
  );
  assert.deepEqual(tag.libraryId, { name: "jquery", version: "3.6.0" });
  assert.equal(tag.cdn, undefined);
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

  // Nothing is seeded: a lookup would be refused by the switched-off network.
  const { net, sent } = observed(defaultNet);

  await resolveCdnLibraries(addon, { net, cacheDir: tmpCacheDir() });

  const tag = addon.bundled.classified.find((c) => c.file === "libs/packed.js");
  assert.equal(tag.library, false, "obfuscated file is not promoted");
  assert.equal(tag.cdn, undefined, "not even looked up");
  assert.equal(sent.length, 0, "the obfuscated file is never sent to the CDN");
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
  const cacheDir = cdnCache({
    [hash]: {
      type: "npm",
      name: "@me/obscure",
      version: "1.0.0",
      file: "/index.js",
    },
  });
  // Downloads below the popularity bar.
  const net = seededNet({
    popularity: { npm: { "@me/obscure": { downloads: 50 } } },
  });

  await resolveCdnLibraries(addon, { net, cacheDir });

  const tag = addon.bundled.classified.find(
    (c) => c.file === "libs/obscure.js"
  );
  assert.equal(tag.untrusted, true);
  assert.equal(tag.library, false);
  assert.equal(tag.cdn.popular, false);
  // Readable -> NOT unreadable -> removed from the skip set (reviewed as authored code).
  assert.equal(addon.bundled.nonAuthored.has("libs/obscure.js"), false);
  assert.equal(addon.bundled.untrusted[0].unreadable, false);

  const ctx = { artifact: addon };
  assert.equal(
    (await untrustedLibrary.run(withManifest(ctx))).findings.length,
    1,
    "readable untrusted -> info"
  );
  assert.equal(
    (await untrustedMinifiedLibrary.run(withManifest(ctx))).findings.length,
    0,
    "not rejected as unreadable"
  );
  assert.equal(
    (await findLibOnCdn.run(withManifest(ctx))).findings.length,
    0,
    "not-popular -> no declare-it"
  );
});

test("a miss leaves the bundle minified (falls through to minified-code)", async () => {
  const addon = classify(addonWith({ "app/blob.js": MINIFIED }));
  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const hash = rawSha256(addon.files.get("app/blob.js"));
  const cacheDir = cdnCache({ [hash]: seeded({ status: 404 }) }); // jsDelivr's 404

  await resolveCdnLibraries(addon, { net: defaultNet, cacheDir });

  const tag = addon.bundled.classified.find((c) => c.file === "app/blob.js");
  assert.equal(tag.library, false);
  assert.equal(tag.cdn, undefined);
  const ctx = { artifact: addon };
  assert.equal((await findLibOnCdn.run(withManifest(ctx))).findings.length, 0);
  assert.deepEqual(
    (await minifiedCode.run(withManifest(ctx))).findings.map((f) => f.file),
    ["app/blob.js"]
  );
});

// Only a 404 is jsDelivr's answer that it has no such file. Any other failure reaching the
// lookup is a fault of our own (no answer is already fatal in src/util/net.js), and must not
// read as "not on the CDN", which would review a library as the developer's own code.
test("a lookup failure short of a 404 propagates", async () => {
  const addon = classify(addonWith({ "app/blob.js": MINIFIED }));
  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const hash = rawSha256(addon.files.get("app/blob.js"));
  await assert.rejects(
    resolveCdnLibraries(addon, {
      net: defaultNet,
      cacheDir: cdnCache({ [hash]: seeded(OWN_FAULT) }),
    }),
    ownFault
  );
});

// Only a hit is kept. No answer at all ends the review rather than leaving the file
// unidentified, and a 404 - a passing fault of the host as well as "no such file" - is asked
// again on the next run. Neither is written.
test("neither no answer nor a 404 is cached", async () => {
  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const hash = rawSha256(Buffer.from(MINIFIED));
  const file = (dir) => path.join(dir, "jsdelivr-hash-lookup.json");
  const asked = async (cacheDir) => {
    const { net, sent } = observed(defaultNet);
    await resolveCdnLibraries(classify(addonWith({ "x.js": MINIFIED })), {
      cacheDir,
      net,
    });
    return lookupsIn(sent).length;
  };

  // No answer: the review stops, and nothing is cached.
  const cacheDir = cdnCache({ [hash]: seeded({ status: 503 }) });
  const seededFile = fs.readFileSync(file(cacheDir), "utf8");
  await assert.rejects(asked(cacheDir), NoAnswerError);
  assert.equal(
    fs.readFileSync(file(cacheDir), "utf8"),
    seededFile,
    "nothing kept of no answer"
  );

  // Nothing was cached for the run that got no answer, so this one asks (jsDelivr's 404).
  seedCdnHits(cacheDir, { [hash]: seeded({ status: 404 }) });
  const missFile = fs.readFileSync(file(cacheDir), "utf8");
  assert.equal(await asked(cacheDir), 1, "asked again after no answer");

  // The 404 was not kept either -> asked again, and nothing was written.
  assert.equal(await asked(cacheDir), 1, "the 404 was asked again");
  assert.equal(
    fs.readFileSync(file(cacheDir), "utf8"),
    missFile,
    "nothing was answered to keep"
  );
});

test("disabled is a no-op (offline-safe)", async () => {
  const addon = classify(addonWith({ "app/blob.js": MINIFIED }));
  // enabled:false -> never touches the net, which the switched-off network would refuse.
  const { net, sent } = observed(defaultNet);
  await resolveCdnLibraries(addon, {
    net,
    cacheDir: tmpCacheDir(),
    enabled: false,
  });
  assert.equal(sent.length, 0);
});

test("results are cached on disk: a second run makes no request (hits + misses)", async () => {
  const hitAddon = classify(addonWith({ "a.js": MINIFIED }));
  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const hitHash = rawSha256(hitAddon.files.get("a.js"));
  // jsDelivr's hit, played in place of the host and kept like a live answer.
  const cacheDir = cdnCache({
    [hitHash]: seeded({
      status: 200,
      json: { type: "npm", name: "lib", version: "1.0.0", file: "/lib.min.js" },
    }),
  });
  const { net, sent } = observed(
    seededNet({ popularity: { npm: { lib: { downloads: 5000 } } } })
  );

  // First run populates the cache (one hash lookup for the hit).
  await resolveCdnLibraries(hitAddon, { net, cacheDir });
  const firstLookups = lookupsIn(sent).length;
  assert.ok(firstLookups >= 1);

  // Second run over a freshly classified copy: same hashes -> the jsDelivr HASH
  // lookup is served from cache (no new lookup). Popularity is intentionally NOT
  // cached (it is time-varying), so it is re-checked - that is fine.
  const again = classify(addonWith({ "a.js": MINIFIED }));
  await resolveCdnLibraries(again, { net, cacheDir });
  assert.equal(
    lookupsIn(sent).length,
    firstLookups,
    "no new jsDelivr hash lookups on the cached run"
  );
  assert.equal(
    again.bundled.classified.find((c) => c.file === "a.js").libraryId.name,
    "lib"
  );
});

test("cdnUrl builds npm and gh source URLs", async () => {
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

// A dead network aborts here too. Read as "no match", a dead route would review a shipped
// jQuery as the developer's own code, and the report would read like a clean review of a
// different add-on. A dead network, a host that gave no answer and any other failure stop
// the review: only a 404 means no match.
test("resolveCdnLibraries propagates every failure but a 404", async () => {
  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const hash = rawSha256(Buffer.from(MINIFIED));
  const lookup = (response) =>
    resolveCdnLibraries(classify(addonWith({ "app/lib.min.js": MINIFIED })), {
      net: defaultNet,
      cacheDir: cdnCache({ [hash]: seeded(response) }),
    });
  await assert.rejects(() => lookup(GONE), NetworkGoneError);
  await assert.rejects(() => lookup({ status: 503 }), NoAnswerError);
  await assert.rejects(() => lookup(OWN_FAULT), ownFault);
});

// A hit is kept for good, since a file hash names one release. A miss is never kept, so the
// only miss a cache holds is one a test seeded (`{fake: {status: 404}}`), played in place of
// the host with the network switched off as every test runs. Anything else - an older
// version's miss included - is asked of the host again.
test("a cached hit is never asked again; only a seeded 404 stands in for a miss", async () => {
  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const lookups = async (entry) => {
    const cacheDir = tmpCacheDir();
    const addon = classify(addonWith({ "x.min.js": MINIFIED }));
    const hash = rawSha256(addon.files.get("x.min.js"));
    fs.writeFileSync(
      path.join(cacheDir, "jsdelivr-hash-lookup.json"),
      JSON.stringify({ [hash]: entry })
    );
    const { net, sent } = observed(
      seededNet({ popularity: { npm: { lib: { downloads: 5000 } } } })
    );
    await resolveCdnLibraries(addon, { net, cacheDir });
    return lookupsIn(sent).length;
  };
  assert.equal(
    await lookups({ fake: { status: 404 } }),
    1,
    "a seeded 404 is played"
  );
  // Any other entry is asked of jsDelivr, which the switched-off network refuses.
  const askedOfHost = /network request in a test/;
  await assert.rejects(
    lookups({ missedAt: Date.now() }),
    askedOfHost,
    "an older version's miss is asked again"
  );
  await assert.rejects(
    lookups(null),
    askedOfHost,
    "a legacy bare miss is asked again"
  );
  const hit = { type: "npm", name: "lib", version: "1.0.0", file: "/x.min.js" };
  assert.equal(await lookups(hit), 0, "a hit is never asked again");
});

// The whole cycle for a hash lookup: jsDelivr's seeded hit is played through the transport
// and kept as the hit, which the next review reads without a request. A seeded failure, or
// a 404 (a miss), is played on every review and never written. The run's popularity memo
// already knows the package, so the hash lookup is the only request a review makes.
test("CDN lookup: a played success is kept and read back, a played failure is never kept", async () => {
  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const hash = rawSha256(Buffer.from(MINIFIED));
  const file = (dir) => path.join(dir, "jsdelivr-hash-lookup.json");
  const hit = {
    type: "npm",
    name: "lib",
    version: "1.0.0",
    file: "/lib.min.js",
  };
  const review = async (cacheDir, net = defaultNet) => {
    const addon = classify(addonWith({ "app/lib.min.js": MINIFIED }));
    addon.vendor = { popularity: new Map([["npm:lib", true]]) };
    await resolveCdnLibraries(addon, { net, cacheDir });
    return addon.bundled.classified.find((c) => c.file === "app/lib.min.js");
  };

  const cacheDir = cdnCache({ [hash]: seeded({ status: 200, json: hit }) });
  assert.deepEqual((await review(cacheDir)).libraryId, {
    name: "lib",
    version: "1.0.0",
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(file(cacheDir), "utf8")), {
    [hash]: hit,
  });
  const { net, sent } = observed(defaultNet);
  assert.deepEqual((await review(cacheDir, net)).libraryId, {
    name: "lib",
    version: "1.0.0",
  });
  assert.deepEqual(sent, [], "read back without a request");

  const down = cdnCache({ [hash]: seeded({ status: 503 }) });
  const gone = cdnCache({ [hash]: seeded({ status: 404 }) });
  const seededDown = fs.readFileSync(file(down), "utf8");
  const seededGone = fs.readFileSync(file(gone), "utf8");
  const { net: again, sent: asked } = observed(defaultNet);
  for (let run = 0; run < 2; run++) {
    await assert.rejects(review(down, again), NoAnswerError);
    assert.equal(
      fs.readFileSync(file(down), "utf8"),
      seededDown,
      "nothing written"
    );
    const missed = await review(gone, again);
    assert.equal(missed.libraryId, undefined, "a miss");
    assert.equal(missed.cdn, undefined, "a miss");
    assert.equal(
      fs.readFileSync(file(gone), "utf8"),
      seededGone,
      "nothing written"
    );
  }
  assert.equal(lookupsIn(asked).length, 4, "played on every review");
});
