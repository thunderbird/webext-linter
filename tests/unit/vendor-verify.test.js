// Unit tests for vendor verification: source classification (pure), the network
// batch verifyVendor (fetch + EOL-tolerant compare + popularity + package.json
// file matching, with the network injected), and each of the four vendor checks
// reading the precomputed addon.vendor store. No real network.

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifySource } from "../../src/vendor/sources.js";
import { verifyVendor } from "../../src/vendor/verify.js";
import unpinnedDependency from "../../src/checks/rules/unpinned-dependency.js";
import unpinnedVendorSource from "../../src/checks/rules/unpinned-vendor-source.js";
import vendorModified from "../../src/checks/rules/vendor-modified.js";
import vendorUnverified from "../../src/checks/rules/vendor-unverified.js";
import missingVendorFile from "../../src/checks/rules/missing-vendor-file.js";

// ---- classifySource (no network) ----
test("classifySource recognizes the trusted hosts and pinned refs", () => {
  const npm = classifySource(
    "https://unpkg.com/jszip@3.10.1/dist/jszip.min.js"
  );
  assert.deepEqual(
    [npm.trusted, npm.pinned, npm.kind, npm.pkg],
    [true, true, "npm", "jszip"]
  );
  const gh = classifySource(
    "https://cdn.jsdelivr.net/gh/javve/list.js@v2.3.1/dist/list.js"
  );
  assert.deepEqual(
    [gh.trusted, gh.pinned, gh.kind, gh.repo],
    [true, true, "github", "javve/list.js"]
  );
  const cdnjs = classifySource(
    "https://cdnjs.cloudflare.com/ajax/libs/jsdiff/7.0.0/diff.js"
  );
  assert.deepEqual(
    [cdnjs.trusted, cdnjs.pinned, cdnjs.kind, cdnjs.lib],
    [true, true, "cdnjs", "jsdiff"]
  );
});

test("classifySource rejects untrusted hosts, non-https, and mutable refs", () => {
  assert.equal(classifySource("https://evil.example.com/x.js").trusted, false);
  assert.equal(
    classifySource("http://unpkg.com/jszip@1.0.0/x.js").trusted,
    false
  );
  assert.equal(
    classifySource("https://raw.githubusercontent.com/o/r/main/x.js").pinned,
    false
  );
  assert.equal(classifySource("https://unpkg.com/foo/x.js").pinned, false);
});

// ---- verifyVendor (network injected) ----

// Build an addon with files, plus a vendor store as resolveVendor would leave it.
function addonWith(files, vendor) {
  const map = new Map(
    Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])
  );
  return { files: map, vendor };
}

// An injectable transport. `bytes` answers every fetchBytes (the VENDOR case);
// `files` answers per-URL (the package case, a missing URL is a 404); `listing`
// answers the "?meta" tree; `downloads` drives the npm popularity lookup.
function net({ bytes, files, listing, downloads = 99999, throwOnFetch } = {}) {
  return {
    fetchBytes: async (url) => {
      if (throwOnFetch) {
        throw new Error("boom");
      }
      if (files) {
        if (!(url in files)) {
          throw new Error("404");
        }
        return Buffer.from(files[url]);
      }
      return Buffer.from(bytes ?? "");
    },
    fetchJson: async (url) => {
      if (url.includes("?meta")) {
        return listing ?? { type: "directory", files: [] };
      }
      return { downloads };
    },
  };
}

const store = (over = {}) => ({
  set: new Set(),
  results: [],
  manifest: [],
  packages: [],
  unpinned: [],
  missing: [],
  unparsedVendor: false,
  ...over,
});

const pinnedEntry = (path, sourceUrl) => ({
  path,
  sourceUrl,
  trusted: true,
  pinned: true,
});

test("verifyVendor: VENDOR entry that matches a popular pinned source -> verified", async () => {
  const url = "https://unpkg.com/foo@1.0.0/a.js";
  const addon = addonWith(
    { "a.js": "BODY\n" },
    store({ set: new Set(["a.js"]), manifest: [pinnedEntry("a.js", url)] })
  );
  await verifyVendor(addon, net({ bytes: "BODY\n" }));
  assert.deepEqual(addon.vendor.results, [
    { path: "a.js", source: url, outcome: "verified" },
  ]);
});

test("verifyVendor: an EOL-only difference still verifies", async () => {
  const url = "https://unpkg.com/foo@1.0.0/a.js";
  const addon = addonWith(
    { "a.js": "line1\r\nline2\r\n" }, // CRLF + trailing newline
    store({ set: new Set(["a.js"]), manifest: [pinnedEntry("a.js", url)] })
  );
  await verifyVendor(addon, net({ bytes: "line1\nline2" })); // LF, no trailing
  assert.equal(addon.vendor.results[0].outcome, "verified");
});

test("verifyVendor: a real byte difference is modified, a niche lib not-popular", async () => {
  const url = "https://unpkg.com/foo@1.0.0/a.js";
  const modified = addonWith(
    { "a.js": "MINE" },
    store({ set: new Set(["a.js"]), manifest: [pinnedEntry("a.js", url)] })
  );
  await verifyVendor(modified, net({ bytes: "UPSTREAM" }));
  assert.equal(modified.vendor.results[0].outcome, "modified");

  const niche = addonWith(
    { "a.js": "BODY" },
    store({ set: new Set(["a.js"]), manifest: [pinnedEntry("a.js", url)] })
  );
  await verifyVendor(niche, net({ bytes: "BODY", downloads: 3 }));
  assert.equal(niche.vendor.results[0].outcome, "not-popular");
});

test("verifyVendor: an unfetchable source -> unfetchable", async () => {
  const url = "https://unpkg.com/foo@1.0.0/a.js";
  const addon = addonWith(
    { "a.js": "BODY" },
    store({ set: new Set(["a.js"]), manifest: [pinnedEntry("a.js", url)] })
  );
  await verifyVendor(addon, net({ throwOnFetch: true }));
  assert.equal(addon.vendor.results[0].outcome, "unfetchable");
});

test("verifyVendor: a package.json file matches a published file by basename", async () => {
  const addon = addonWith(
    { "lib/jszip.min.js": "ZIP\n" },
    store({ packages: [{ name: "jszip", version: "3.10.1" }] })
  );
  const listing = {
    type: "directory",
    files: [
      { type: "file", path: "/dist/jszip.min.js" },
      { type: "file", path: "/package.json" },
    ],
  };
  const fileUrl = "https://unpkg.com/jszip@3.10.1/dist/jszip.min.js";
  await verifyVendor(addon, net({ listing, files: { [fileUrl]: "ZIP\n" } }));
  assert.deepEqual(addon.vendor.results, [
    { path: "lib/jszip.min.js", source: fileUrl, outcome: "verified" },
  ]);
  assert.ok(addon.vendor.set.has("lib/jszip.min.js"));
});

test("verifyVendor: a same-basename file that differs is NOT claimed as vendored", async () => {
  const addon = addonWith(
    { "lib/jszip.min.js": "MY OWN CODE" },
    store({ packages: [{ name: "jszip", version: "3.10.1" }] })
  );
  const listing = {
    type: "directory",
    files: [{ type: "file", path: "/dist/jszip.min.js" }],
  };
  const fileUrl = "https://unpkg.com/jszip@3.10.1/dist/jszip.min.js";
  await verifyVendor(addon, net({ listing, files: { [fileUrl]: "UPSTREAM" } }));
  assert.deepEqual(addon.vendor.results, []);
  assert.equal(addon.vendor.set.has("lib/jszip.min.js"), false);
});

test("verifyVendor: multiple same-basename candidates - the matching one wins", async () => {
  const addon = addonWith(
    { "vendor/util.js": "RIGHT\n" },
    store({ packages: [{ name: "pkg", version: "2.0.0" }] })
  );
  const listing = {
    type: "directory",
    files: [
      { type: "file", path: "/util.js" },
      { type: "file", path: "/esm/util.js" },
    ],
  };
  const base = "https://unpkg.com/pkg@2.0.0";
  await verifyVendor(
    addon,
    net({
      listing,
      files: {
        [`${base}/util.js`]: "WRONG",
        [`${base}/esm/util.js`]: "RIGHT\n",
      },
    })
  );
  assert.deepEqual(addon.vendor.results, [
    {
      path: "vendor/util.js",
      source: `${base}/esm/util.js`,
      outcome: "verified",
    },
  ]);
});

// ---- the four checks (pure readers of addon.vendor) ----

test("unpinned-dependency: one finding per unpinned dep, anchored in package.json", () => {
  const pkg = '{\n  "dependencies": {\n    "lodash": "^4.17.21"\n  }\n}';
  const ctx = {
    addon: {
      files: new Map([["package.json", Buffer.from(pkg)]]),
      vendor: store({ unpinned: [{ name: "lodash", spec: "^4.17.21" }] }),
    },
  };
  const out = unpinnedDependency.run(ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "package.json");
  assert.equal(out[0].loc.line, 3);
  assert.equal(out[0].item, "lodash");
  assert.deepEqual(out[0].data, { spec: "^4.17.21" });
});

test("unpinned-vendor-source: one finding per unpinned-source result", () => {
  const url = "https://unpkg.com/x/x.js";
  const ctx = {
    addon: {
      vendor: store({
        results: [
          { path: "lib/x.js", source: url, outcome: "unpinned-source" },
        ],
      }),
    },
  };
  const out = unpinnedVendorSource.run(ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "lib/x.js");
  assert.equal(out[0].item, "lib/x.js");
  assert.deepEqual(out[0].data, { url });
});

test("vendor-modified: a modified result is a finding; verified passes silently", () => {
  const ctx = {
    addon: {
      vendor: store({
        results: [
          { path: "a.js", source: "u1", outcome: "verified" },
          { path: "b.js", source: "u2", outcome: "modified" },
        ],
      }),
    },
  };
  const out = vendorModified.run(ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "b.js");
  assert.equal(out[0].item, "b.js");
  assert.deepEqual(out[0].data, { url: "u2" });
});

test("vendor-unverified: every unverifiable result escalates; verified does not", () => {
  const ctx = {
    addon: {
      vendor: store({
        results: [
          { path: "a.js", source: null, outcome: "no-url" },
          { path: "b.js", source: "http://evil/x.js", outcome: "untrusted" },
          { path: "c.js", source: "u", outcome: "not-popular" },
          { path: "d.js", source: "u", outcome: "unfetchable" },
          { path: "e.js", source: "u", outcome: "verified" },
        ],
      }),
    },
  };
  const out = vendorUnverified.run(ctx);
  assert.deepEqual(out.findings, []);
  assert.equal(out.escalations.length, 4);
  assert.match(out.escalations[1].item, /trusted host/);
});

test("missing-vendor-file: one warning per missing entry, anchored to VENDOR", () => {
  const ctx = {
    addon: {
      files: new Map([["VENDORS.md", Buffer.from("file: lib/gone.js")]]),
      vendor: store({
        missing: [
          {
            path: "lib/gone.js",
            sourceUrl: "https://unpkg.com/b@2.0.0/gone.js",
          },
        ],
      }),
    },
  };
  const out = missingVendorFile.run(ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "VENDORS.md");
  assert.equal(out[0].item, "lib/gone.js");
});

test("vendor-unverified: an unparsable VENDOR file escalates to manual", () => {
  const ctx = {
    addon: {
      files: new Map([["VENDOR", Buffer.from("we bundle stuff, see docs")]]),
      vendor: store({ unparsedVendor: true }),
    },
  };
  const out = vendorUnverified.run(ctx);
  assert.equal(out.escalations.length, 1);
  assert.match(out.escalations[0].item, /VENDOR - could not be parsed/);
});
