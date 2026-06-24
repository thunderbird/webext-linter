// Unit tests for vendor verification: source classification (pure), the network
// batch verifyVendor (fetch + EOL-tolerant compare + popularity + package.json
// file matching, with the network injected), and each of the four vendor checks
// reading the precomputed addon.vendor store. No real network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { classifySource } from "../../src/vendor/sources.js";
import { VENDOR_TRUSTED_HOSTS } from "../../src/config.js";
import { verifyVendor } from "../../src/vendor/verify.js";
import unpinnedDependency from "../../src/checks/rules/unpinned-dependency.js";
import unpinnedVendorSource from "../../src/checks/rules/unpinned-vendor-source.js";
import vendorModified from "../../src/checks/rules/vendor-modified.js";
import vendorUnverified from "../../src/checks/rules/vendor-unverified.js";
import missingVendorFile from "../../src/checks/rules/missing-vendor-file.js";
import vendorVulnerable from "../../src/checks/rules/vendor-vulnerable.js";
import vendorVulnUnknown from "../../src/checks/rules/vendor-vuln-unknown.js";
import { normalizedSha256 } from "../../src/normalize/hash.js";
import { makeTgz } from "./tarball-fixture.js";

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
    [gh.trusted, gh.pinned, gh.kind, gh.repo, gh.ref],
    [true, true, "github", "javve/list.js", "v2.3.1"]
  );
  // A raw.githubusercontent URL also exposes the ref (the audit derives the
  // version from it).
  const raw = classifySource(
    "https://raw.githubusercontent.com/moment/moment/2.29.1/min/moment.min.js"
  );
  assert.deepEqual([raw.repo, raw.ref], ["moment/moment", "2.29.1"]);
});

test("classifySource rejects untrusted hosts, non-https, and mutable refs", () => {
  assert.equal(classifySource("https://evil.example.com/x.js").trusted, false);
  // cdnjs is no longer an accepted source (a cdnjs lib is always on npm/github);
  // such a URL is now untrusted and routes to manual review.
  assert.equal(
    classifySource(
      "https://cdnjs.cloudflare.com/ajax/libs/jsdiff/7.0.0/diff.js"
    ).trusted,
    false
  );
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

test("classifySource recognizes an npm-registry tarball (whole-package source)", () => {
  const t = classifySource(
    "https://registry.npmjs.org/ical.js/-/ical.js-2.2.1.tgz"
  );
  assert.deepEqual(
    [t.trusted, t.pinned, t.tarball, t.kind, t.pkg, t.version],
    [true, true, true, "npm", "ical.js", "2.2.1"]
  );
  // Scoped package: /@scope/name/-/name-<ver>.tgz.
  const s = classifySource("https://registry.npmjs.org/@a/b/-/b-1.2.3.tgz");
  assert.deepEqual([s.tarball, s.pkg, s.version], [true, "@a/b", "1.2.3"]);
  // A non-tarball registry URL (e.g. the packument) is not a usable source.
  assert.equal(
    classifySource("https://registry.npmjs.org/ical.js").trusted,
    false
  );
});

// A github.com/.../blob/<ref>/... URL is an accepted INPUT host: it is rewritten
// to a raw.githubusercontent.com URL (the real fetch host) and classified github.
test("classifySource accepts a github.com blob URL, rewriting it to raw", () => {
  const gh = classifySource(
    "https://github.com/moment/moment/blob/2.29.1/min/moment.min.js"
  );
  assert.deepEqual(
    [gh.trusted, gh.pinned, gh.kind, gh.repo, gh.ref],
    [true, true, "github", "moment/moment", "2.29.1"]
  );
  assert.equal(
    gh.rawUrl,
    "https://raw.githubusercontent.com/moment/moment/2.29.1/min/moment.min.js"
  );
  // A non-blob github.com URL is not a usable source.
  assert.equal(
    classifySource("https://github.com/moment/moment").trusted,
    false
  );
});

// Every fetch host in the config allowlist has a parser, so classifySource and
// config.js VENDOR_TRUSTED_HOSTS cannot silently drift apart.
test("every VENDOR_TRUSTED_HOSTS host classifies a pinned URL as trusted", () => {
  const sample = {
    "unpkg.com": "https://unpkg.com/jszip@3.10.1/dist/jszip.min.js",
    "cdn.jsdelivr.net":
      "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js",
    "raw.githubusercontent.com":
      "https://raw.githubusercontent.com/moment/moment/2.29.1/min/moment.min.js",
    "registry.npmjs.org":
      "https://registry.npmjs.org/ical.js/-/ical.js-2.2.1.tgz",
  };
  for (const host of VENDOR_TRUSTED_HOSTS) {
    assert.ok(sample[host], `add a sample URL for new trusted host ${host}`);
    assert.equal(classifySource(sample[host]).trusted, true, host);
  }
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
  vendorFile: null,
  vulnerabilities: [],
  unaudited: [],
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

// An npm-registry tarball source is verified by extracting the whole package and
// matching the bundled file's content hash against any file inside (EOL-tolerant).
const TGZ_URL = "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz";
const tgzEntry = () => ({
  set: new Set(["vendor/foo.js"]),
  manifest: [pinnedEntry("vendor/foo.js", TGZ_URL)],
});

test("verifyVendor: a file matching an npm-registry tarball -> verified", async () => {
  const tgz = makeTgz({
    "package/dist/foo.js": "BODY\n",
    "package/package.json": "{}\n",
  });
  const addon = addonWith({ "vendor/foo.js": "BODY\n" }, store(tgzEntry()));
  await verifyVendor(addon, net({ bytes: tgz }));
  assert.deepEqual(addon.vendor.results, [
    { path: "vendor/foo.js", source: TGZ_URL, outcome: "verified" },
  ]);
});

test("verifyVendor: an EOL-only diff against a tarball entry still verifies", async () => {
  const tgz = makeTgz({ "package/dist/foo.js": "a\r\nb\r\n" }); // CRLF upstream
  const addon = addonWith({ "vendor/foo.js": "a\nb" }, store(tgzEntry())); // LF
  await verifyVendor(addon, net({ bytes: tgz }));
  assert.equal(addon.vendor.results[0].outcome, "verified");
});

test("verifyVendor: a tarball with no matching file -> modified", async () => {
  const tgz = makeTgz({ "package/dist/foo.js": "UPSTREAM\n" });
  const addon = addonWith(
    { "vendor/foo.js": "LOCALLY CHANGED\n" },
    store(tgzEntry())
  );
  await verifyVendor(addon, net({ bytes: tgz }));
  assert.equal(addon.vendor.results[0].outcome, "modified");
});

test("verifyVendor: an unfetchable tarball -> unfetchable", async () => {
  const addon = addonWith({ "vendor/foo.js": "BODY\n" }, store(tgzEntry()));
  await verifyVendor(addon, net({ throwOnFetch: true }));
  assert.equal(addon.vendor.results[0].outcome, "unfetchable");
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
      file: "package.json", // a package.json dep anchors there, by its name
      token: "lodash",
    },
  ]);
});

// An npm-sourced VENDOR entry is audited the same way as a package.json dep, but
// the vuln anchors at the VENDOR file by its source URL (not a quoted dep name).
test("verifyVendor: the OSV audit records a vulnerable npm VENDOR library", async () => {
  const url = "https://unpkg.com/lodash@4.17.20/lodash.js";
  const addon = addonWith(
    { "VENDOR.md": `lib/lodash.js\n${url}\n`, "lib/lodash.js": "BODY\n" },
    store({
      vendorFile: "VENDOR.md",
      set: new Set(["lib/lodash.js"]),
      manifest: [
        { path: "lib/lodash.js", sourceUrl: url, trusted: true, pinned: true },
      ],
    })
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
  await verifyVendor(addon, net({ bytes: "BODY\n", osv }));
  assert.deepEqual(addon.vendor.vulnerabilities, [
    {
      name: "lodash",
      version: "4.17.20",
      ids: ["CVE-2021-23337"],
      severity: "high",
      fixed: ["4.17.21"],
      file: "VENDOR.md",
      token: url,
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

// ---- github -> npm resolution + audit (auditGithub, network injected) ----

// The SRI a ?meta listing carries for a body the bundled file should match.
const sriOf = (body) =>
  `sha256-${createHash("sha256").update(body).digest("base64")}`;

// An OSV response with one advisory affecting `name`, fixed in `fixed`.
const osvFor = (name, fixed) => ({
  vulns: [
    {
      id: "GHSA-xxxx-yyyy-zzzz",
      aliases: ["CVE-2022-24785"],
      database_specific: { severity: "HIGH" },
      affected: [
        {
          package: { ecosystem: "npm", name },
          ranges: [
            { type: "SEMVER", events: [{ introduced: "0" }, { fixed }] },
          ],
        },
      ],
    },
  ],
});

test("auditGithub: a github source whose npm twin matches by hash is OSV-audited", async () => {
  const url =
    "https://raw.githubusercontent.com/moment/moment/2.29.1/min/moment.min.js";
  const body = "MOMENT\n";
  const addon = addonWith(
    { "VENDOR.md": `lib/moment.min.js\n${url}\n`, "lib/moment.min.js": body },
    store({
      vendorFile: "VENDOR.md",
      set: new Set(["lib/moment.min.js"]),
      manifest: [pinnedEntry("lib/moment.min.js", url)],
    })
  );
  // The deterministic candidate (repo name "moment" @ "2.29.1") serves a listing
  // whose SRI matches the bundled bytes, so the npm identity is proven.
  const listing = {
    files: [{ path: "/min/moment.min.js", integrity: sriOf(body) }],
  };
  await verifyVendor(
    addon,
    net({ bytes: body, listing, osv: osvFor("moment", "2.29.2") })
  );
  assert.deepEqual(addon.vendor.vulnerabilities, [
    {
      name: "moment",
      version: "2.29.1",
      ids: ["CVE-2022-24785"],
      severity: "high",
      fixed: ["2.29.2"],
      file: "VENDOR.md", // anchored at the declared github URL, not the npm one
      token: url,
    },
  ]);
  assert.deepEqual(addon.vendor.unaudited, []);
});

test("auditGithub: a resolved+clean github twin records nothing (no vuln, not unaudited)", async () => {
  const url =
    "https://raw.githubusercontent.com/moment/moment/2.29.1/min/moment.min.js";
  const body = "MOMENT\n";
  const addon = addonWith(
    { "VENDOR.md": `lib/moment.min.js\n${url}\n`, "lib/moment.min.js": body },
    store({
      vendorFile: "VENDOR.md",
      manifest: [pinnedEntry("lib/moment.min.js", url)],
    })
  );
  const listing = {
    files: [{ path: "/min/moment.min.js", integrity: sriOf(body) }],
  };
  await verifyVendor(addon, net({ bytes: body, listing, osv: { vulns: [] } }));
  assert.deepEqual(addon.vendor.vulnerabilities, []);
  assert.deepEqual(addon.vendor.unaudited, []);
});

test("auditGithub: a github source with no npm hash-match (no LLM) is recorded unaudited", async () => {
  const url = "https://raw.githubusercontent.com/who/what/1.0.0/lib.js";
  const addon = addonWith(
    { "VENDOR.md": `lib.js\n${url}\n`, "vendor/lib.js": "BODY\n" },
    store({
      vendorFile: "VENDOR.md",
      manifest: [pinnedEntry("vendor/lib.js", url)],
    })
  );
  // The candidate package serves a listing that matches nothing.
  await verifyVendor(addon, net({ bytes: "BODY\n", listing: { files: [] } }));
  assert.deepEqual(addon.vendor.unaudited, [
    { path: "vendor/lib.js", source: url, repo: "who/what" },
  ]);
  assert.deepEqual(addon.vendor.vulnerabilities, []);
});

test("auditGithub: a first-party trusted org stays silent (no audit, not unaudited)", async () => {
  const url =
    "https://raw.githubusercontent.com/thunderbird/webext-support/" +
    "6bbbf8ac2105d04c1b59083e8bd52e0046448ec7/modules/i18n/i18n.mjs";
  const body = "BODY\n";
  const addon = addonWith(
    { "VENDOR.md": `i18n.mjs\n${url}\n`, "vendor/i18n.mjs": body },
    store({
      vendorFile: "VENDOR.md",
      manifest: [pinnedEntry("vendor/i18n.mjs", url)],
    })
  );
  await verifyVendor(addon, net({ bytes: body }));
  assert.deepEqual(addon.vendor.vulnerabilities, []);
  assert.deepEqual(addon.vendor.unaudited, []);
});

test("auditGithub: an LLM-proposed npm name is audited only after a hash match", async () => {
  // The repo name "thing" is not the npm package; the deterministic candidate
  // misses, the LLM proposes the real name "realpkg", which hash-matches.
  const url =
    "https://raw.githubusercontent.com/someuser/thing/1.0.0/dist/thing.js";
  const body = "REAL\n";
  const addon = addonWith(
    { "VENDOR.md": `thing.js\n${url}\n`, "vendor/thing.js": body },
    store({
      vendorFile: "VENDOR.md",
      manifest: [pinnedEntry("vendor/thing.js", url)],
    })
  );
  const match = { files: [{ path: "/dist/thing.js", integrity: sriOf(body) }] };
  const customNet = {
    fetchBytes: async () => Buffer.from(body),
    fetchJson: async (u) =>
      u.includes("?meta")
        ? u.includes("realpkg@1.0.0") // only the proposed package matches
          ? match
          : { files: [] }
        : { downloads: 99999 },
    postJson: async (_u, b) =>
      b.package.name === "realpkg" ? osvFor("realpkg", "1.0.1") : { vulns: [] },
  };
  let asked = 0;
  const llm = {
    enabled: true,
    resolvePrompt: "PROMPT",
    callText: async () => {
      asked++;
      return '{"name":"realpkg","version":"1.0.0"}';
    },
  };
  await verifyVendor(addon, customNet, llm);
  assert.equal(asked, 1);
  assert.equal(addon.vendor.vulnerabilities.length, 1);
  assert.equal(addon.vendor.vulnerabilities[0].name, "realpkg");
  assert.deepEqual(addon.vendor.unaudited, []);
});

test("auditGithub: an LLM proposal that does not hash-match is rejected -> unaudited", async () => {
  const url =
    "https://raw.githubusercontent.com/someuser/thing/1.0.0/dist/thing.js";
  const body = "REAL\n";
  const addon = addonWith(
    { "VENDOR.md": `thing.js\n${url}\n`, "vendor/thing.js": body },
    store({
      vendorFile: "VENDOR.md",
      manifest: [pinnedEntry("vendor/thing.js", url)],
    })
  );
  const customNet = {
    fetchBytes: async () => Buffer.from(body),
    fetchJson: async (u) =>
      u.includes("?meta") ? { files: [] } : { downloads: 99999 },
    postJson: async () => ({ vulns: [] }),
  };
  const llm = {
    enabled: true,
    resolvePrompt: "PROMPT",
    callText: async () => '{"name":"wrongpkg","version":"1.0.0"}',
  };
  await verifyVendor(addon, customNet, llm);
  assert.deepEqual(addon.vendor.vulnerabilities, []);
  assert.deepEqual(addon.vendor.unaudited, [
    { path: "vendor/thing.js", source: url, repo: "someuser/thing" },
  ]);
});

test("auditGithub: the LLM fallback is skipped when the budget is exhausted", async () => {
  const url =
    "https://raw.githubusercontent.com/someuser/thing/1.0.0/dist/thing.js";
  const body = "REAL\n";
  const addon = addonWith(
    { "VENDOR.md": `thing.js\n${url}\n`, "vendor/thing.js": body },
    store({
      vendorFile: "VENDOR.md",
      manifest: [pinnedEntry("vendor/thing.js", url)],
    })
  );
  const customNet = {
    fetchBytes: async () => Buffer.from(body),
    fetchJson: async (u) =>
      u.includes("?meta") ? { files: [] } : { downloads: 99999 },
    postJson: async () => ({ vulns: [] }),
  };
  let asked = 0;
  const llm = {
    enabled: true,
    resolvePrompt: "PROMPT",
    budget: { consume: async () => false },
    callText: async () => {
      asked++;
      return '{"name":"realpkg"}';
    },
  };
  await verifyVendor(addon, customNet, llm);
  assert.equal(asked, 0); // budget gate closed -> never asked
  assert.deepEqual(addon.vendor.unaudited, [
    { path: "vendor/thing.js", source: url, repo: "someuser/thing" },
  ]);
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
            file: "package.json",
            token: "lodash",
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
  assert.equal(out[0].severity, "error"); // "high" band -> error
  assert.deepEqual(out[0].data, {
    version: "4.17.20",
    ids: "CVE-2021-23337",
    severity: "high", // the raw band still fills the {{severity}} slot
    fixed: "4.17.21",
  });
});

// severity:auto - the check derives each finding's severity from the advisory's
// OSV band. high/critical -> error, moderate/medium -> warning, everything else
// (low, unknown) -> info. Nothing is skipped: every band yields one finding.
test("vendor-vulnerable: maps the OSV band to the finding severity", () => {
  const severityFor = (band) => {
    const pkg = '{\n  "dependencies": {\n    "lodash": "1.0.0"\n  }\n}';
    const ctx = {
      addon: {
        files: new Map([["package.json", Buffer.from(pkg)]]),
        vendor: store({
          vulnerabilities: [
            {
              name: "lodash",
              version: "1.0.0",
              ids: ["X"],
              severity: band,
              fixed: [],
              file: "package.json",
              token: "lodash",
            },
          ],
        }),
      },
    };
    const out = vendorVulnerable.run(ctx);
    assert.equal(out.length, 1); // reported, never dropped
    return out[0].severity;
  };
  assert.equal(severityFor("critical"), "error");
  assert.equal(severityFor("high"), "error");
  assert.equal(severityFor("moderate"), "warning");
  assert.equal(severityFor("medium"), "warning");
  assert.equal(severityFor("low"), "info");
  assert.equal(severityFor("unknown"), "info");
});

test("vendor-vulnerable: no recorded vulnerabilities -> no findings", () => {
  const ctx = {
    addon: { files: new Map(), vendor: store() },
  };
  assert.deepEqual(vendorVulnerable.run(ctx), []);
});

// vendor-vuln-unknown is now a pure reader of vendor.unaudited (verify.js does
// the github->npm resolution and decides what lands there). It emits one info per
// entry, anchored at its VENDOR source line.
test("vendor-vuln-unknown: one info per unaudited entry, at its VENDOR source line", () => {
  const ghUrl = "https://cdn.jsdelivr.net/gh/javve/list.js@v2.3.1/dist/list.js";
  const vendorMd = `list.js\n${ghUrl}\n`;
  const ctx = {
    addon: {
      files: new Map([["VENDOR.md", Buffer.from(vendorMd)]]),
      vendor: store({
        vendorFile: "VENDOR.md",
        unaudited: [
          { path: "vendor/list.js", source: ghUrl, repo: "javve/list.js" },
        ],
      }),
    },
  };
  const out = vendorVulnUnknown.run(ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].item, ghUrl); // the source URL surfaces on the locus line
  assert.equal(out[0].file, "VENDOR.md");
  assert.equal(out[0].loc.line, 2); // the source URL line
});

test("vendor-vuln-unknown: no unaudited entries -> no findings", () => {
  const ctx = { addon: { files: new Map(), vendor: store() } };
  assert.deepEqual(vendorVulnUnknown.run(ctx), []);
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

test("unpinned-vendor-source: anchored on the VENDOR line, URL as the hint", () => {
  const url = "https://unpkg.com/x/x.js";
  const ctx = {
    addon: {
      files: new Map([["VENDOR", Buffer.from(`lib/x.js\n${url}\n`)]]),
      vendor: store({
        vendorFile: "VENDOR",
        results: [
          { path: "lib/x.js", source: url, outcome: "unpinned-source" },
        ],
      }),
    },
  };
  const out = unpinnedVendorSource.run(ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "VENDOR"); // anchored on the VENDOR declaration
  assert.equal(out[0].loc.line, 2); // the line citing the source
  assert.equal(out[0].item, "lib/x.js"); // the vendored file -> {{item}}
  assert.equal(out[0].hint, url); // URL rides the locus line
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
  const trustedHosts = VENDOR_TRUSTED_HOSTS.map((h) => `https://${h}`).join(
    ", "
  );
  assert.equal(
    out.escalations[1].item,
    `b.js - http://evil/x.js - source not on a trusted host (use ${trustedHosts})`
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
