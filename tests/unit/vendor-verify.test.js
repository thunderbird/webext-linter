// Unit tests for vendor verification: source classification (pure), the network
// batch verifyVendor (fetch + EOL-tolerant compare + popularity + package.json
// file matching, with the network injected), and each of the four vendor checks
// reading the precomputed addon.vendor store. No real network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { classifySource } from "../../src/vendor/sources.js";
import { verifyVendor } from "../../src/vendor/verify.js";
import unpinnedDependency from "../../src/checks/rules/unpinned-dependency.js";
import unpinnedVendorSource from "../../src/checks/rules/unpinned-vendor-source.js";
import vendorModified from "../../src/checks/rules/vendor-modified.js";
import vendorUnverified from "../../src/checks/rules/vendor-unverified.js";
import missingVendorFile from "../../src/checks/rules/missing-vendor-file.js";
import vendorVulnerable from "../../src/checks/rules/vendor-vulnerable.js";

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
// answers the "?meta" tree; `downloads` drives the npm popularity lookup; `osv`
// answers the OSV audit postJson (an object, or a function of the request body),
// and `throwOnPost` makes the audit POST fail (the offline case).
function net({
  bytes,
  files,
  listing,
  downloads = 99999,
  throwOnFetch,
  osv,
  throwOnPost,
} = {}) {
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
    postJson: async (_url, body) => {
      if (throwOnPost) {
        throw new Error("offline");
      }
      return (typeof osv === "function" ? osv(body) : osv) ?? { vulns: [] };
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
  vulnerabilities: [],
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

test("verifyVendor: a github source from a trusted org verifies despite low stars, no popularity lookup", async () => {
  const url =
    "https://github.com/thunderbird/webext-support/blob/" +
    "6bbbf8ac2105d04c1b59083e8bd52e0046448ec7/modules/i18n/i18n.mjs";
  const addon = addonWith(
    { "vendor/i18n.mjs": "BODY\n" },
    store({
      set: new Set(["vendor/i18n.mjs"]),
      manifest: [pinnedEntry("vendor/i18n.mjs", url)],
    })
  );
  // The raw bytes match; fetchJson throws to prove the stars lookup is skipped
  // (a trusted org is accepted by provenance).
  const net = {
    fetchBytes: async () => Buffer.from("BODY\n"),
    fetchJson: async () => {
      throw new Error("no popularity lookup expected for a trusted org");
    },
  };
  await verifyVendor(addon, net);
  assert.equal(addon.vendor.results[0].outcome, "verified");
});

test("verifyVendor: a github source from a non-trusted org is still star-gated", async () => {
  const url =
    "https://github.com/someone/repo/blob/" +
    "6bbbf8ac2105d04c1b59083e8bd52e0046448ec7/lib.js";
  const addon = addonWith(
    { "vendor/lib.js": "BODY\n" },
    store({
      set: new Set(["vendor/lib.js"]),
      manifest: [pinnedEntry("vendor/lib.js", url)],
    })
  );
  const net = {
    fetchBytes: async () => Buffer.from("BODY\n"),
    fetchJson: async () => ({ stargazers_count: 5 }), // below VENDOR_GITHUB_MIN_STARS
  };
  await verifyVendor(addon, net);
  assert.equal(addon.vendor.results[0].outcome, "not-popular");
});

test("verifyVendor: a file that does not hash-match any published file is not claimed", async () => {
  const sri = `sha256-${createHash("sha256").update("UPSTREAM").digest("base64")}`;
  const addon = addonWith(
    { "lib/jszip.min.js": "MY OWN CODE" }, // same basename, different bytes
    store({ packages: [{ name: "jszip", version: "3.10.1" }] })
  );
  const listing = { files: [{ path: "/dist/jszip.min.js", integrity: sri }] };
  await verifyVendor(addon, net({ listing, throwOnFetch: true }));
  assert.deepEqual(addon.vendor.results, []);
  assert.equal(addon.vendor.set.has("lib/jszip.min.js"), false);
});

test("verifyVendor: a renamed verbatim copy is matched by hash (basename-independent)", async () => {
  const body = "LIB\n";
  const sri = `sha256-${createHash("sha256").update(body).digest("base64")}`;
  const addon = addonWith(
    { "vendor/renamed.js": body }, // a different name than the published file
    store({ packages: [{ name: "pkg", version: "2.0.0" }] })
  );
  const listing = { files: [{ path: "/dist/foo.js", integrity: sri }] };
  const base = "https://unpkg.com/pkg@2.0.0";
  await verifyVendor(addon, net({ listing, throwOnFetch: true }));
  assert.deepEqual(addon.vendor.results, [
    {
      path: "vendor/renamed.js",
      source: `${base}/dist/foo.js`,
      outcome: "verified",
    },
  ]);
});

test("verifyVendor: a hash match for a niche package is not-popular", async () => {
  const body = "LIB\n";
  const sri = `sha256-${createHash("sha256").update(body).digest("base64")}`;
  const addon = addonWith(
    { "vendor/lib.js": body },
    store({ packages: [{ name: "niche", version: "1.0.0" }] })
  );
  const listing = { files: [{ path: "/lib.js", integrity: sri }] };
  await verifyVendor(addon, net({ listing, downloads: 3, throwOnFetch: true }));
  assert.equal(addon.vendor.results[0].outcome, "not-popular");
});

// unpkg's real "?meta" is a FLAT files array whose entries carry the MIME type in
// `type` (not the literal "file") plus a per-file sha256 `integrity`. A packaged
// file is matched by hashing it locally and comparing to that integrity - no
// bytes are fetched (`throwOnFetch` proves it). (Regression: keying off
// type === "file" extracted zero files, so vendored copies were never
// whitelisted; and fetching every file made a big package hang.)
test("verifyVendor: a flat ?meta file is matched by sha256 integrity, no download", async () => {
  const body = "WA\n";
  const sri = `sha256-${createHash("sha256").update(body).digest("base64")}`;
  const addon = addonWith(
    { "vendor/webawesome/webawesome.js": body },
    store({ packages: [{ name: "@awesome.me/webawesome", version: "3.3.1" }] })
  );
  const listing = {
    package: "@awesome.me/webawesome",
    version: "3.3.1",
    prefix: "/",
    files: [
      {
        path: "/dist/webawesome.js",
        type: "application/javascript",
        integrity: sri,
      },
      {
        path: "/dist-cdn/webawesome.js",
        type: "application/javascript",
        integrity: sri,
      },
    ],
  };
  const base = "https://unpkg.com/@awesome.me/webawesome@3.3.1";
  await verifyVendor(addon, net({ listing, throwOnFetch: true }));
  assert.ok(addon.vendor.set.has("vendor/webawesome/webawesome.js"));
  assert.deepEqual(addon.vendor.results, [
    {
      path: "vendor/webawesome/webawesome.js",
      source: `${base}/dist/webawesome.js`,
      outcome: "verified",
    },
  ]);
});

// ---- OSV vulnerability audit (network injected) ----

// A package OSV reports an advisory for is recorded on vendor.vulnerabilities,
// aggregated per package: a CVE alias is preferred over the OSV id, the severity
// is the database-specific label, and the fixed versions come from the matching
// npm `affected` ranges. `throwOnFetch` proves the ?meta path is independent.
test("verifyVendor: the OSV audit records a vulnerable pinned package", async () => {
  const addon = addonWith(
    {},
    store({ packages: [{ name: "lodash", version: "4.17.20" }] })
  );
  const osv = {
    vulns: [
      {
        id: "GHSA-35jh-r3h4-6jhm",
        aliases: ["CVE-2021-23337"],
        database_specific: { severity: "HIGH" },
        affected: [
          {
            package: { ecosystem: "npm", name: "lodash" },
            ranges: [
              {
                type: "SEMVER",
                events: [{ introduced: "0" }, { fixed: "4.17.21" }],
              },
            ],
          },
        ],
      },
    ],
  };
  await verifyVendor(addon, net({ listing: { files: [] }, osv }));
  assert.deepEqual(addon.vendor.vulnerabilities, [
    {
      name: "lodash",
      version: "4.17.20",
      ids: ["CVE-2021-23337"],
      severity: "high",
      fixed: ["4.17.21"],
    },
  ]);
});

test("verifyVendor: a clean package records no vulnerability", async () => {
  const addon = addonWith(
    {},
    store({ packages: [{ name: "left-pad", version: "1.3.0" }] })
  );
  await verifyVendor(
    addon,
    net({ listing: { files: [] }, osv: { vulns: [] } })
  );
  assert.deepEqual(addon.vendor.vulnerabilities, []);
});

test("verifyVendor: a failed OSV lookup records nothing (best-effort)", async () => {
  const addon = addonWith(
    {},
    store({ packages: [{ name: "lodash", version: "4.17.20" }] })
  );
  await verifyVendor(addon, net({ listing: { files: [] }, throwOnPost: true }));
  assert.deepEqual(addon.vendor.vulnerabilities, []);
});

// ---- the four checks (pure readers of addon.vendor) ----

test("vendor-vulnerable: a recorded vulnerability becomes a finding at the package.json line", () => {
  const pkg = '{\n  "dependencies": {\n    "lodash": "4.17.20"\n  }\n}';
  const ctx = {
    addon: {
      files: new Map([["package.json", Buffer.from(pkg)]]),
      vendor: store({
        vulnerabilities: [
          {
            name: "lodash",
            version: "4.17.20",
            ids: ["CVE-2021-23337"],
            severity: "high",
            fixed: ["4.17.21"],
          },
        ],
      }),
    },
  };
  const out = vendorVulnerable.run(ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "package.json");
  assert.equal(out[0].loc.line, 3);
  assert.equal(out[0].item, "lodash");
  assert.deepEqual(out[0].data, {
    version: "4.17.20",
    ids: "CVE-2021-23337",
    severity: "high",
    fixed: "4.17.21",
  });
});

test("vendor-vulnerable: no recorded vulnerabilities -> no findings", () => {
  const ctx = {
    addon: { files: new Map(), vendor: store() },
  };
  assert.deepEqual(vendorVulnerable.run(ctx), []);
});

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
  // Each escalation is located by the VENDOR file; the item lists the declared
  // file, the source URL (when there is one), and the URL-free reason.
  assert.ok(out.escalations.every((e) => e.file === "VENDOR"));
  assert.equal(out.escalations[0].item, "a.js - no source URL declared");
  assert.equal(
    out.escalations[1].item,
    "b.js - http://evil/x.js - source not on a trusted host"
  );
});

test("missing-vendor-file: one warning per missing entry, listing the path", () => {
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
  // The missing path is the location; the VENDOR filename rides {{item}}.
  assert.equal(out[0].file, "lib/gone.js");
  assert.equal(out[0].item, "VENDORS.md");
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
  // The VENDOR file is the location; the item is just the reason.
  assert.equal(out.escalations[0].file, "VENDOR");
  assert.equal(out.escalations[0].item, "could not be parsed");
});
