// Unit tests for vendor verification: source classification (pure), the network
// batch verifyVendor (fetch + EOL-tolerant compare + popularity + package.json
// file matching, with the network injected), and each of the vendor checks
// reading the precomputed addon.vendor store. No real network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";

import { classifySource } from "../../src/vendor/sources.js";
import {
  VENDOR_TRUSTED_HOSTS,
  VENDOR_POPULARITY_RETRIES,
} from "../../src/config.js";
import {
  verifyVendor,
  verifyVendorDeclarations,
  verifyScaDependencies,
  auditIdentifiedLibraries,
  isPopular,
  setPopularityPacing,
} from "../../src/vendor/verify.js";
import { NetworkGoneError } from "../../src/util/net.js";
import { parseLibraryBlocks } from "../../src/lib/library-blocks.js";
import unpinnedDependency from "../../src/checks/rules/unpinned-dependency.js";
import unpinnedVendorSource from "../../src/checks/rules/unpinned-vendor-source.js";
import vendorModified from "../../src/checks/rules/vendor-modified.js";
import missingVendorFile from "../../src/checks/rules/missing-vendor-file.js";
import vendorVulnerable from "../../src/checks/rules/vendor-vulnerable.js";
import vendorVulnUnknown from "../../src/checks/rules/vendor-vuln-unknown.js";
import vendorUnparseable from "../../src/checks/rules/vendor-unparseable.js";
import { applyUnverifiedVendor } from "../../src/lib/bundled.js";
import { normalizedSha256 } from "../../src/normalize/hash.js";
import { makeTgz } from "./tarball-fixture.js";

// Every request here is answered by an injected transport, so the gate that spaces
// real popularity requests has nothing to protect and would only spend real seconds.
// The gate's own behaviour is asserted by driving the knobs deliberately below.
setPopularityPacing({ intervalMs: 0, backoffMs: 0 });

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

// GitHub also serves raw files with a fully-qualified refs/(tags|heads)/<ref>
// path; the real ref must be read from it (not the literal "refs") so a version
// tag is recognized as pinned.
test("classifySource reads the ref from a refs/tags raw.githubusercontent URL", () => {
  const tag = classifySource(
    "https://raw.githubusercontent.com/Stuk/jszip/refs/tags/v3.10.1/dist/jszip.js"
  );
  assert.deepEqual(
    [tag.repo, tag.ref, tag.pinned],
    ["Stuk/jszip", "v3.10.1", true]
  );
  // A refs/heads/<branch> URL exposes the branch name and stays unpinned.
  const branch = classifySource(
    "https://raw.githubusercontent.com/o/r/refs/heads/main/x.js"
  );
  assert.deepEqual([branch.ref, branch.pinned], ["main", false]);
});

test("classifySource rejects untrusted hosts, non-https, and mutable refs", () => {
  assert.equal(classifySource("https://evil.example.com/x.js").trusted, false);
  // cdnjs is not an accepted source (a cdnjs lib is always on npm/github); such a
  // URL is untrusted and routes to manual review.
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
  // A bundled store so verifyVendor's post-pass can record not-popular files as
  // untrusted (markUntrusted). The auditIdentifiedLibraries tests overwrite it.
  return {
    files: map,
    vendor,
    bundled: { classified: [], nonAuthored: new Set(), untrusted: [] },
  };
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
  stars = 99999,
  throwOnFetch,
  osv,
  throwOnPost,
  // The tree audit's two endpoints, kept separate from the single-package ones:
  // `batch` answers /v1/querybatch (positionally, one result per query) and
  // `advisories` maps an advisory id to the record /v1/vulns/<id> serves.
  batch,
  advisories,
  throwOnBatch,
  throwOnHydrate,
  // `popularityStatus` refuses the next popularity request(s) with those HTTP
  // statuses, one per entry, before the normal answer - the way a host that is
  // rate-limiting us behaves. `retryAfter` rides along on each refusal (seconds).
  popularityStatus,
  retryAfter,
  calls,
} = {}) {
  const refusals = [...(popularityStatus ?? [])];
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
      if (url.includes("/v1/vulns/")) {
        calls?.hydrate?.push(url);
        if (throwOnHydrate) {
          throw new Error("offline");
        }
        const id = url.slice(url.lastIndexOf("/") + 1);
        if (!(id in (advisories ?? {}))) {
          throw new Error("404");
        }
        return advisories[id];
      }
      if (url.includes("?meta")) {
        return listing ?? { type: "directory", files: [] };
      }
      const popularityUrl =
        url.includes("api.github.com/repos/") ||
        url.includes("api.npmjs.org/downloads/");
      if (popularityUrl) {
        calls?.popularity?.push(url);
        if (refusals.length) {
          const err = new Error(`HTTP ${refusals[0]}`);
          err.status = refusals.shift();
          if (retryAfter) {
            err.retryAfterMs = retryAfter * 1000;
          }
          throw err;
        }
      }
      if (url.includes("api.github.com/repos/")) {
        return { stargazers_count: stars };
      }
      return { downloads };
    },
    postJson: async (url, body) => {
      if (url.includes("querybatch")) {
        calls?.batch?.push(body);
        if (throwOnBatch) {
          throw new Error("offline");
        }
        return typeof batch === "function"
          ? batch(body)
          : (batch ?? { results: [] });
      }
      calls?.query?.push(body);
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
  githubDeps: [],
  unsupportedDeps: [],
  missing: [],
  unparsedVendor: false,
  vendorFile: null,
  vulnerabilities: [],
  devPackages: [],
  devVulnerabilities: [],
  unaudited: [],
  unpopularDeps: [],
  blocked: [],
  lockPackages: [],
  treeVulnerabilities: [],
  treeDevVulnerabilities: [],
  popularity: new Map(),
  ...over,
});

const pinnedEntry = (path, sourceUrl) => ({
  path,
  sourceUrl,
  trusted: true,
  pinned: true,
});

// ---- missing-vendor-file ----
// A declaration naming a file the submission does not ship. The check only reads
// addon.vendor.missing (resolveVendor decides what is missing), so this pins the
// shape it reports: the MISSING PATH is the location a reviewer is sent to, and the
// VENDOR file's own name rides on {{item}} - the two are easy to swap, and swapping
// them points the reviewer at a file that exists instead of the one that does not.
test("missing-vendor-file: one warning per missing entry, listing the path", () => {
  const ctx = {
    addon: {
      files: new Map([["VENDORS.md", Buffer.from("file: lib/gone.js")]]),
      vendor: {
        missing: [
          {
            path: "lib/gone.js",
            sourceUrl: "https://unpkg.com/b@2.0.0/gone.js",
          },
        ],
      },
    },
  };
  const out = missingVendorFile.run(ctx).findings;
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "lib/gone.js");
  assert.equal(out[0].item, "VENDORS.md");
});

// Nothing declared missing is silence, not an empty finding.
test("missing-vendor-file: says nothing when every declared file is shipped", () => {
  const ctx = { addon: { files: new Map(), vendor: { missing: [] } } };
  assert.deepEqual(missingVendorFile.run(ctx).findings, []);
});

// ---- verifyScaDependencies (SCA mode dependency audit) ----

test("verifyScaDependencies: a non-popular declared dep is recorded as unreviewable", async () => {
  const addon = addonWith(
    { "package.json": '{"dependencies":{"niche":"1.0.0"}}' },
    store({ packages: [{ name: "niche", version: "1.0.0" }] })
  );
  await verifyScaDependencies(
    addon,
    net({ downloads: 30, osv: { vulns: [] } })
  );
  assert.deepEqual(addon.vendor.unpopularDeps, [
    { name: "niche", version: "1.0.0", file: "package.json", token: "niche" },
  ]);
});

test("verifyScaDependencies: a POPULAR declared dep is allowed (not recorded)", async () => {
  const addon = addonWith(
    { "package.json": "{}" },
    store({ packages: [{ name: "react", version: "18.0.0" }] })
  );
  await verifyScaDependencies(addon, net({ downloads: 5000 }));
  assert.deepEqual(addon.vendor.unpopularDeps, []);
});

test("verifyScaDependencies: offline (every lookup throws) records nothing", async () => {
  const addon = addonWith(
    { "package.json": "{}" },
    store({ packages: [{ name: "niche", version: "1.0.0" }] })
  );
  const offline = {
    fetchBytes: async () => {
      throw new Error("offline");
    },
    fetchJson: async () => {
      throw new Error("offline");
    },
    postJson: async () => {
      throw new Error("offline");
    },
  };
  await verifyScaDependencies(addon, offline);
  assert.deepEqual(addon.vendor.unpopularDeps, []);
});

// GitHub-sourced deps are gated by stars (the same bar as a VENDOR.md github
// source), needing no bundled file - so it works for an SCA submission.
test("verifyScaDependencies: a low-star GitHub dep is recorded as unreviewable", async () => {
  const addon = addonWith(
    { "package.json": "{}" },
    store({
      githubDeps: [
        { name: "widget", spec: "u/widget", repo: "u/widget", ref: null },
      ],
    })
  );
  await verifyScaDependencies(addon, net({ stars: 5 }));
  assert.deepEqual(addon.vendor.unpopularDeps, [
    {
      name: "widget",
      version: "u/widget",
      file: "package.json",
      token: "widget",
    },
  ]);
});

test("verifyScaDependencies: a popular (high-star) GitHub dep is allowed", async () => {
  const addon = addonWith(
    { "package.json": "{}" },
    store({
      githubDeps: [
        { name: "widget", spec: "u/widget", repo: "u/widget", ref: null },
      ],
    })
  );
  await verifyScaDependencies(addon, net({ stars: 5000 }));
  assert.deepEqual(addon.vendor.unpopularDeps, []);
});

test("verifyScaDependencies: a trusted-org (thunderbird) GitHub dep is a free pass", async () => {
  const addon = addonWith(
    { "package.json": "{}" },
    store({
      githubDeps: [
        {
          name: "helper",
          spec: "thunderbird/helper",
          repo: "thunderbird/helper",
          ref: null,
        },
      ],
    })
  );
  // stars:0 would fail the bar, but the trusted org never triggers the lookup.
  await verifyScaDependencies(addon, net({ stars: 0 }));
  assert.deepEqual(addon.vendor.unpopularDeps, []);
});

test("verifyScaDependencies: a GitHub stars lookup failure records nothing", async () => {
  const addon = addonWith(
    { "package.json": "{}" },
    store({
      githubDeps: [
        { name: "widget", spec: "u/widget", repo: "u/widget", ref: null },
      ],
    })
  );
  const offline = {
    fetchBytes: async () => {
      throw new Error("offline");
    },
    fetchJson: async () => {
      throw new Error("offline");
    },
    postJson: async () => {
      throw new Error("offline");
    },
  };
  await verifyScaDependencies(addon, offline);
  assert.deepEqual(addon.vendor.unpopularDeps, []);
});

// Dev dependencies never ship, but the SCA reviewer builds from source, so a
// pinned npm dev dep is OSV-audited too - recorded on devVulnerabilities (a set
// distinct from the prod/vendored `vulnerabilities`), and NOT popularity-gated (a
// low-download build tool is fine, so nothing is recorded on unpopularDeps).
test("verifyScaDependencies: a vulnerable dev dependency lands on devVulnerabilities, no popularity gate", async () => {
  const addon = addonWith(
    { "package.json": '{"devDependencies":{"build-tool":"1.0.0"}}' },
    store({ devPackages: [{ name: "build-tool", version: "1.0.0" }] })
  );
  await verifyScaDependencies(
    addon,
    net({
      downloads: 5, // low - but dev deps are not popularity-gated
      osv: {
        vulns: [
          {
            id: "GHSA-dev0-0000-0000",
            aliases: ["CVE-2021-0001"],
            database_specific: { severity: "HIGH" },
            affected: [
              {
                package: { ecosystem: "npm", name: "build-tool" },
                ranges: [
                  {
                    type: "SEMVER",
                    events: [{ introduced: "0" }, { fixed: "2.0.0" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    })
  );
  assert.deepEqual(addon.vendor.devVulnerabilities, [
    {
      name: "build-tool",
      version: "1.0.0",
      ids: ["CVE-2021-0001"],
      severity: "high",
      fixed: ["2.0.0"],
      file: "package.json",
      token: "build-tool",
    },
  ]);
  // The prod/vendored set is untouched, and a low-download dev dep is not flagged.
  assert.deepEqual(addon.vendor.vulnerabilities, []);
  assert.deepEqual(addon.vendor.unpopularDeps, []);
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

// A folder entry resolves its github tree -> repo ZIP and verifies EACH file under
// the directory against the archive's subpath: a file present upstream verifies, a
// file that is not is `modified` (-> a vendor-modified finding).
test("verifyVendor: a folder verifies each file against the repo archive subpath", async () => {
  const SHA = "0123456789012345678901234567890123456789";
  const TREE = `https://github.com/o/r/tree/${SHA}/modules/vfs`;
  const zip = new AdmZip();
  zip.addFile(`r-${SHA}/modules/vfs/a.js`, Buffer.from("AAA\n"));
  zip.addFile(`r-${SHA}/modules/vfs/sub/c.js`, Buffer.from("CCC\n"));
  zip.addFile(`r-${SHA}/other/d.js`, Buffer.from("DDD\n")); // outside the subpath
  const addon = addonWith(
    {
      "vendor/lib/a.js": "AAA\n", // matches upstream
      "vendor/lib/c.js": "CCC\n", // matches upstream (nested)
      "vendor/lib/b.js": "LOCAL ONLY\n", // not upstream -> modified
    },
    store({
      folders: new Set(["vendor/lib"]),
      manifest: [
        {
          path: "vendor/lib",
          sourceUrl: TREE,
          trusted: true,
          pinned: true,
          kind: "folder",
        },
      ],
    })
  );
  await verifyVendor(addon, net({ bytes: zip.toBuffer() }));
  const byPath = Object.fromEntries(
    addon.vendor.results.map((r) => [r.path, r.outcome])
  );
  assert.equal(addon.vendor.results.length, 3); // one per file under the folder
  assert.notEqual(byPath["vendor/lib/a.js"], "modified");
  assert.notEqual(byPath["vendor/lib/c.js"], "modified");
  assert.equal(byPath["vendor/lib/b.js"], "modified");
  // the modified file becomes a vendor-modified finding
  assert.ok(
    vendorModified
      .run({ addon })
      .findings.some((f) => f.file === "vendor/lib/b.js")
  );
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
  // A readable not-popular VENDOR file was skipped as vendored - prove it leaves
  // the non-authored set so the source-level checks scan it as authored code.
  niche.bundled.nonAuthored.add("a.js");
  await verifyVendor(niche, net({ bytes: "BODY", downloads: 3 }));
  applyUnverifiedVendor(niche); // the pipeline's post-classifyBundled reconciliation
  // not-popular is not a manual-review result; it is dropped from results and
  // recorded as an untrusted (here readable) library, reviewed as authored code.
  assert.deepEqual(niche.vendor.results, []);
  assert.equal(niche.bundled.untrusted.length, 1);
  assert.equal(niche.bundled.untrusted[0].file, "a.js");
  assert.equal(niche.bundled.untrusted[0].unreadable, false);
  assert.equal(niche.bundled.nonAuthored.has("a.js"), false); // scanned as authored
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
  applyUnverifiedVendor(addon);
  // star-gated -> not-popular -> untrusted (authored code), dropped from results.
  assert.deepEqual(addon.vendor.results, []);
  assert.equal(addon.bundled.untrusted[0].file, "vendor/lib.js");
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
  applyUnverifiedVendor(addon);
  // niche npm dep -> not-popular -> untrusted (authored code), dropped from results.
  assert.deepEqual(addon.vendor.results, []);
  assert.equal(addon.bundled.untrusted[0].file, "vendor/lib.js");
});

// unpkg's real "?meta" is a FLAT files array whose entries carry the MIME type in
// `type` (not the literal "file") plus a per-file sha256 `integrity`. A packaged
// file is matched by hashing it locally and comparing to that integrity - no
// bytes are fetched (`throwOnFetch` proves it). Matching on a literal type === "file"
// would extract nothing from this listing and leave every vendored copy unrecognized;
// downloading each file instead of hashing locally would hang on a big package.
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

// auditIdentifiedLibraries OSV-audits the libraries the hash classifier recognized
// (bundled.classified entries with a libraryId), so an UNDECLARED vulnerable bundle
// is recorded just like a declared dep. The dispensary name is mapped to its npm
// package (angularjs -> angular) and the vuln anchors at the bundled file with an
// empty token (no declaration line). A classified entry without a libraryId is not
// a library and is skipped.
test("auditIdentifiedLibraries: an undeclared identified library is OSV-audited", async () => {
  const addon = addonWith({ "vendor/lib.min.js": "LIBBYTES" }, store());
  addon.bundled = {
    classified: [
      {
        file: "vendor/lib.min.js",
        library: true,
        libraryId: { name: "angularjs", version: "1.0.2" },
      },
      { file: "app.js", library: false }, // not a library -> skipped
    ],
  };
  const osv = {
    vulns: [
      {
        id: "GHSA-aaaa-bbbb-cccc",
        aliases: ["CVE-2024-9999"],
        database_specific: { severity: "CRITICAL" },
        affected: [
          {
            package: { ecosystem: "npm", name: "angular" },
            ranges: [
              {
                type: "SEMVER",
                events: [{ introduced: "0" }, { fixed: "1.8.0" }],
              },
            ],
          },
        ],
      },
    ],
  };
  await auditIdentifiedLibraries(addon, net({ osv }));
  assert.deepEqual(addon.vendor.vulnerabilities, [
    {
      name: "angular", // dispensary "angularjs" mapped to its npm package
      version: "1.0.2",
      ids: ["CVE-2024-9999"],
      severity: "critical",
      fixed: ["1.8.0"],
      file: "vendor/lib.min.js", // anchors at the bundled file
      token: "", // no declaration line for an undeclared library
    },
  ]);
});

// Each release is audited at most once: the same library bundled in two files, or
// one already flagged by verifyVendor as a declared dep / VENDOR entry, is neither
// re-queried (a counted postJson) nor double-reported.
test("auditIdentifiedLibraries: dedupes by release across files and prior audits", async () => {
  const addon = addonWith(
    { "a/jquery.min.js": "A", "b/jquery.min.js": "B", "c/moment.min.js": "C" },
    store({
      // moment 2.0.0 was already recorded as a declared dependency.
      vulnerabilities: [
        {
          name: "moment",
          version: "2.0.0",
          ids: ["CVE-2017-0001"],
          severity: "high",
          fixed: [],
          file: "package.json",
          token: "moment",
        },
      ],
    })
  );
  addon.bundled = {
    classified: [
      {
        file: "a/jquery.min.js",
        libraryId: { name: "jquery", version: "1.7.2" },
      },
      {
        file: "b/jquery.min.js",
        libraryId: { name: "jquery", version: "1.7.2" },
      },
      {
        file: "c/moment.min.js",
        libraryId: { name: "moment", version: "2.0.0" },
      },
    ],
  };
  let queries = 0;
  const osv = (body) => {
    queries += 1;
    return body.package.name === "jquery"
      ? {
          vulns: [
            { id: "CVE-2020-11022", database_specific: { severity: "MEDIUM" } },
          ],
        }
      : { vulns: [] };
  };
  await auditIdentifiedLibraries(addon, net({ osv }));
  // jquery queried once (not twice), moment skipped (already recorded).
  assert.equal(queries, 1);
  assert.deepEqual(
    addon.vendor.vulnerabilities.map((v) => `${v.name}@${v.version}`),
    ["moment@2.0.0", "jquery@1.7.2"] // the prior moment entry + one jquery entry
  );
});

test("auditIdentifiedLibraries: records nothing offline (no postJson)", async () => {
  const addon = addonWith({ "vendor/lib.min.js": "X" }, store());
  addon.bundled = {
    classified: [
      {
        file: "vendor/lib.min.js",
        library: true,
        libraryId: { name: "jquery", version: "1.7.2" },
      },
    ],
  };
  await auditIdentifiedLibraries(addon, net({ throwOnPost: true }));
  assert.deepEqual(addon.vendor.vulnerabilities, []);
});

// ---- the Mozilla policy blocklist short-circuit (auditNpm consults the `blocks` policy) ----

const JQUERY_BLOCK = parseLibraryBlocks(
  `- name: jquery\n  banned_below: "3.0.0"\n  reason: "old jquery"`
);
// A net whose OSV POST bumps a counter, so a test can prove OSV was / was not queried.
const countingNet = (counter) =>
  net({
    downloads: 99999,
    osv: () => {
      counter.n++;
      return { vulns: [] };
    },
  });

// A banned identified library is recorded on vendor.blocked and SKIPS the OSV query
// (auditNpm returns before postJson), so a disallowed library costs no OSV request.
// The policy is passed to the audit (a parameter, like the hash DB) - not on the store.
test("blocklist: a banned identified library is recorded and skips the OSV query", async () => {
  const addon = addonWith({ "vendor/jquery.min.js": "X" }, store());
  addon.bundled = {
    classified: [
      {
        file: "vendor/jquery.min.js",
        library: true,
        libraryId: { name: "jquery", version: "1.7.2" },
      },
    ],
  };
  const c = { n: 0 };
  await auditIdentifiedLibraries(addon, countingNet(c), JQUERY_BLOCK);
  assert.equal(c.n, 0); // OSV never queried for a banned library
  assert.deepEqual(addon.vendor.blocked, [
    {
      name: "jquery",
      version: "1.7.2",
      status: "banned",
      reason: "old jquery",
      file: "vendor/jquery.min.js",
      token: "",
    },
  ]);
  assert.deepEqual(addon.vendor.vulnerabilities, []);
});

// An unadvised library is still ALLOWED, so it is recorded but still OSV-audited: a
// live CVE on an old-but-permitted library must still surface.
test("blocklist: an unadvised identified library is recorded but still OSV-audited", async () => {
  const blocks = parseLibraryBlocks(
    `- name: dompurify\n  unadvised_below: "2.4.0"\n  reason: "old dompurify"`
  );
  const addon = addonWith({ "vendor/dompurify.js": "X" }, store());
  addon.bundled = {
    classified: [
      {
        file: "vendor/dompurify.js",
        library: true,
        libraryId: { name: "dompurify", version: "2.0.0" },
      },
    ],
  };
  const c = { n: 0 };
  await auditIdentifiedLibraries(addon, countingNet(c), blocks);
  assert.equal(c.n, 1); // unadvised is still audited
  assert.equal(addon.vendor.blocked.length, 1);
  assert.equal(addon.vendor.blocked[0].status, "unadvised");
});

// A banned library that is BOTH a declared dep (already on vendor.blocked from
// verifyVendor) AND hash-identified must NOT be recorded twice -
// auditIdentifiedLibraries seeds its `seen` dedup from vendor.blocked as well as
// vendor.vulnerabilities.
test("blocklist: a declared-AND-bundled banned library is recorded once, not twice", async () => {
  const addon = addonWith({ "vendor/jquery.min.js": "X" }, store());
  addon.vendor.blocked.push({
    name: "jquery",
    version: "1.7.2",
    status: "banned",
    reason: "old jquery",
    file: "package.json",
    token: "jquery",
  });
  addon.bundled = {
    classified: [
      {
        file: "vendor/jquery.min.js",
        libraryId: { name: "jquery", version: "1.7.2" },
      },
    ],
  };
  const c = { n: 0 };
  await auditIdentifiedLibraries(addon, countingNet(c), JQUERY_BLOCK);
  assert.equal(c.n, 0); // banned -> no OSV
  assert.equal(addon.vendor.blocked.length, 1); // not double-recorded
});

// A banned SCA devDependency is never shipped, so it must NOT be recorded
// as a banned-library, and it must STILL be OSV-audited (into devVulnerabilities) -
// verifyScaDependencies passes no `blocks` for the dev-dep audit.
test("blocklist: a banned SCA devDependency is not blocked and is still OSV-audited", async () => {
  const addon = addonWith(
    { "package.json": '{"devDependencies":{"jquery":"1.7.2"}}' },
    store({ devPackages: [{ name: "jquery", version: "1.7.2" }] })
  );
  const c = { n: 0 };
  await verifyScaDependencies(addon, countingNet(c), JQUERY_BLOCK);
  assert.deepEqual(addon.vendor.blocked, []); // dev dep NOT policy-blocked
  assert.equal(c.n, 1); // still OSV-audited (into devVulnerabilities)
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

// ---- the vendor checks (pure readers of addon.vendor) ----

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
  const out = vendorVulnerable.run(ctx).findings;
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
    const out = vendorVulnerable.run(ctx).findings;
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
  assert.deepEqual(vendorVulnerable.run(ctx).findings, []);
});

// vendor-vuln-unknown is a pure reader of vendor.unaudited (verify.js does
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
  const out = vendorVulnUnknown.run(ctx).findings;
  assert.equal(out.length, 1);
  assert.equal(out[0].item, ghUrl); // the source URL surfaces on the locus line
  assert.equal(out[0].file, "VENDOR.md");
  assert.equal(out[0].loc.line, 2); // the source URL line
});

test("vendor-vuln-unknown: no unaudited entries -> no findings", () => {
  const ctx = { addon: { files: new Map(), vendor: store() } };
  assert.deepEqual(vendorVulnUnknown.run(ctx).findings, []);
});

test("unpinned-dependency: one finding per unpinned dep, anchored in package.json", () => {
  const pkg = '{\n  "dependencies": {\n    "lodash": "^4.17.21"\n  }\n}';
  const ctx = {
    addon: {
      files: new Map([["package.json", Buffer.from(pkg)]]),
      vendor: store({ unpinned: [{ name: "lodash", spec: "^4.17.21" }] }),
    },
  };
  const out = unpinnedDependency.run(ctx).findings;
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "package.json");
  assert.equal(out[0].loc.line, 3);
  // Collapsed response: name + spec render together on the location line.
  assert.equal(out[0].item, "lodash (^4.17.21)");
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
  const out = unpinnedVendorSource.run(ctx).findings;
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
  const out = vendorModified.run(ctx).findings;
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "b.js");
  assert.equal(out[0].item, "b.js");
  assert.deepEqual(out[0].data, { url: "u2" });
});

test("vendor-unparseable: an unparsable VENDOR file is an error finding", () => {
  const out = vendorUnparseable.run({
    addon: {
      files: new Map([["VENDOR", Buffer.from("we bundle stuff, see docs")]]),
      vendor: store({ unparsedVendor: true, vendorFile: "VENDOR" }),
    },
  }).findings;
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "VENDOR");
  // No finding when the VENDOR parsed (or is absent).
  assert.equal(
    vendorUnparseable.run({
      addon: { files: new Map(), vendor: store({ unparsedVendor: false }) },
    }).findings.length,
    0
  );
});

// A bundled file is exempt from review because we fetched its declared source and
// the bytes matched. Nothing else earns it - so every way that can fail says the same
// thing, and all of them land in the untrusted family rather than in a manual step
// asking a reviewer to vouch for provenance they cannot check.
//
// markUntrusted then routes by readability, which is the whole point: a readable file
// can be reviewed as the developer's own code, an unreadable one cannot be reviewed at
// all and is rejected with a request for source.
test("every unverified outcome becomes untrusted, routed by readability", () => {
  const MIN = "!function(e){return e}(1);".repeat(60);
  const READ = "export function hello() {\n  return 1;\n}\n";
  const build = (outcome, file, body) => ({
    files: new Map([[file, Buffer.from(body)]]),
    bundled: { classified: [], nonAuthored: new Set([file]), untrusted: [] },
    vendor: { results: [{ path: file, source: "https://x/y.js", outcome }] },
  });

  for (const outcome of ["untrusted", "unfetchable", "no-url", "not-popular"]) {
    const addon = build(outcome, "lib/read.js", READ);
    applyUnverifiedVendor(addon);
    assert.equal(addon.bundled.untrusted.length, 1, outcome);
    assert.equal(addon.bundled.untrusted[0].unreadable, false, outcome);
    // Readable: taken OUT of the skip set, so it is reviewed as authored code.
    assert.ok(!addon.bundled.nonAuthored.has("lib/read.js"), outcome);
    // The result is spent - it is nobody's manual review any more.
    assert.deepEqual(addon.vendor.results, [], outcome);
  }

  // Unreadable: nothing can review it, so it stays skipped and is rejected instead.
  const min = build("unfetchable", "lib/min.js", MIN);
  applyUnverifiedVendor(min);
  assert.equal(min.bundled.untrusted[0].unreadable, true);
  assert.ok(min.bundled.nonAuthored.has("lib/min.js"));

  // A verdict that already rejects keeps its own result - its check owns the file.
  const kept = build("modified", "lib/read.js", READ);
  applyUnverifiedVendor(kept);
  assert.equal(kept.bundled.untrusted.length, 0);
  assert.equal(kept.vendor.results.length, 1);
});

// ---- a dead network aborts, one dead load does not ----
// Every catch in the vendor and CDN paths turns a fetch failure into a benign value:
// "not popular", "unfetchable", no CDN match. That is right for ONE load failing and
// wrong for a dead route - it would silently reclassify a popular library as the
// developer's own code, and the report would look like a clean review of a different
// add-on. assertNetwork already tells the two apart with a control-point probe, so each
// swallow site only has to not eat the answer (rethrowIfNetworkGone).
//
// This is the guard against a NEW swallow site forgetting the rule: it asserts at the
// public entry points, not at the catches.
const goneNet = () => {
  const boom = () => {
    throw new NetworkGoneError("https://registry.example/x", true);
  };
  return {
    fetchBytes: async () => boom(),
    fetchJson: async () => boom(),
    postJson: async () => boom(),
  };
};

test("a NetworkGoneError propagates out of every vendor entry point", async () => {
  const vendorStore = () => ({
    manifest: [
      {
        path: "lib/x.js",
        sourceUrl: "https://unpkg.com/x@1.0.0/x.js",
        trusted: true,
        pinned: true,
        kind: "file",
      },
    ],
    packages: [{ name: "x", version: "1.0.0" }],
    devPackages: [],
    githubDeps: [],
    results: [],
    vulnerabilities: [],
    devVulnerabilities: [],
    unpopularDeps: [],
    unaudited: [],
    set: new Set(),
    folders: new Set(),
    vendorFile: "VENDOR.md",
  });

  await assert.rejects(
    () =>
      verifyVendor(addonWith({ "lib/x.js": "x" }, vendorStore()), goneNet()),
    NetworkGoneError,
    "verifyVendor"
  );
  await assert.rejects(
    () =>
      verifyVendorDeclarations(
        addonWith({ "lib/x.js": "x" }, vendorStore()),
        goneNet()
      ),
    NetworkGoneError,
    "verifyVendorDeclarations"
  );
  await assert.rejects(
    () =>
      verifyScaDependencies(
        addonWith({ "lib/x.js": "x" }, vendorStore()),
        goneNet()
      ),
    NetworkGoneError,
    "verifyScaDependencies"
  );
  await assert.rejects(
    () => isPopular({ kind: "npm", pkg: "x" }, goneNet()),
    NetworkGoneError,
    "isPopular - the reclassification this protects"
  );
});

// ---- grouping the entries that share one npm package ----
// A bundled library is many files from one release, declared one line each. Verified
// a file at a time, the release was fetched, asked about and audited once PER FILE:
// the add-on that prompted this shipped 34 files of one package and made 102 requests
// for what three answer. The group is the unit of network work and nothing else -
// every entry still reports on its own, and still answers for its own declared path.

const GROUP_BASE = "https://cdn.jsdelivr.net/npm/@scope/widget@1.2.3/dist";
const GROUP_TGZ = "https://registry.npmjs.org/@scope/widget/-/widget-1.2.3.tgz";

// Two entries on one package, the shape every grouped test starts from.
const groupAddon = (files = { "lib/a.js": "A\n", "lib/b.js": "B\n" }) =>
  addonWith(
    files,
    store({
      set: new Set(Object.keys(files)),
      manifest: [
        pinnedEntry("lib/a.js", `${GROUP_BASE}/a.js`),
        pinnedEntry("lib/b.js", `${GROUP_BASE}/b.js`),
      ],
    })
  );

// The whole point: one request for the package, and none for the files. If the file
// URLs were still fetched the grouping would be pure overhead, so they are absent
// from `files` here and would 404 if asked for.
test("vendor grouping: two entries on one package fetch the tarball once, and no file URLs", async () => {
  const addon = groupAddon();
  const tgz = makeTgz({
    "package/dist/a.js": "A\n",
    "package/dist/b.js": "B\n",
  });
  let fetched = [];
  const n = {
    fetchBytes: async (url) => {
      fetched.push(url);
      if (url !== GROUP_TGZ) {
        throw new Error("HTTP 404");
      }
      return tgz;
    },
    fetchJson: async () => ({ downloads: 250000 }),
    postJson: async () => ({ vulns: [] }),
  };
  await verifyVendorDeclarations(addon, n);
  assert.deepEqual(fetched, [GROUP_TGZ], "the package, and nothing else");
  assert.deepEqual(addon.vendor.results, [
    { path: "lib/a.js", source: `${GROUP_BASE}/a.js`, outcome: "verified" },
    { path: "lib/b.js", source: `${GROUP_BASE}/b.js`, outcome: "verified" },
  ]);
});

// Grouping must not be visible in the report. Each row keeps its own path and its own
// declared URL, because vendor-modified narrates "verified against <url>" per row and
// markUntrusted needs a path that is a packaged file - a row naming the package would
// be neither.
test("vendor grouping: each grouped entry keeps its own row and source URL", async () => {
  const addon = groupAddon({ "lib/a.js": "A\n", "lib/b.js": "DIFFERENT\n" });
  const tgz = makeTgz({
    "package/dist/a.js": "A\n",
    "package/dist/b.js": "B\n",
  });
  await verifyVendorDeclarations(addon, net({ bytes: tgz, downloads: 250000 }));
  assert.deepEqual(addon.vendor.results, [
    { path: "lib/a.js", source: `${GROUP_BASE}/a.js`, outcome: "verified" },
    { path: "lib/b.js", source: `${GROUP_BASE}/b.js`, outcome: "modified" },
  ]);
});

// auditNpm appends a record per call, so a package declared 34 times was recorded 34
// times - the same advisory, 34 findings. The audit belongs to the package now.
test("vendor grouping: a package two entries share is OSV-audited once", async () => {
  const calls = { query: [] };
  const addon = groupAddon();
  const tgz = makeTgz({
    "package/dist/a.js": "A\n",
    "package/dist/b.js": "B\n",
  });
  await verifyVendorDeclarations(
    addon,
    net({ bytes: tgz, downloads: 250000, calls })
  );
  assert.equal(calls.query.length, 1, "one audit for the one package");
  assert.deepEqual(calls.query[0].package, {
    name: "@scope/widget",
    ecosystem: "npm",
  });
});

// The invariant that makes grouping free: the claim is still "these are the bytes
// published at THIS path", not the weaker "these bytes are somewhere in the package".
// Without it a declaration could name any file of the package and pass.
test("vendor grouping: bytes published elsewhere in the package are still modified", async () => {
  const addon = groupAddon({ "lib/a.js": "A\n", "lib/b.js": "A\n" });
  const tgz = makeTgz({
    "package/dist/a.js": "A\n",
    "package/dist/b.js": "B\n",
  });
  await verifyVendorDeclarations(addon, net({ bytes: tgz, downloads: 250000 }));
  assert.equal(
    addon.vendor.results.find((r) => r.path === "lib/b.js").outcome,
    "modified",
    "b.js holds a.js's bytes, which is not what it declared"
  );
});

// A path the package does not publish is not evidence the file was modified - a CDN
// may spell a path differently. Ask that entry's own URL rather than reject it over
// the shape of a URL.
test("vendor grouping: a path the package does not publish falls back to its own URL", async () => {
  const addon = groupAddon();
  const tgz = makeTgz({ "package/dist/a.js": "A\n" }); // no b.js
  const n = {
    fetchBytes: async (url) => {
      if (url === GROUP_TGZ) {
        return tgz;
      }
      if (url === `${GROUP_BASE}/b.js`) {
        return Buffer.from("B\n");
      }
      throw new Error("HTTP 404");
    },
    fetchJson: async () => ({ downloads: 250000 }),
    postJson: async () => ({ vulns: [] }),
  };
  await verifyVendorDeclarations(addon, n);
  assert.deepEqual(
    addon.vendor.results.map((r) => r.outcome),
    ["verified", "verified"],
    "b.js verified against the URL it declared"
  );
});

// A failed grouping must cost the OLD number of requests and the OLD verdict, never a
// worse one: the files are simply verified the way they were before.
test("vendor grouping: an unfetchable package falls back to per-file verification", async () => {
  const addon = groupAddon();
  await verifyVendorDeclarations(
    addon,
    net({
      files: { [`${GROUP_BASE}/a.js`]: "A\n", [`${GROUP_BASE}/b.js`]: "B\n" },
      downloads: 250000,
    })
  );
  assert.deepEqual(
    addon.vendor.results.map((r) => r.outcome),
    ["verified", "verified"]
  );
});

// One file is not worth a whole package, so a lone entry behaves exactly as it always
// did. If this stops holding, every single-file declaration starts downloading a
// package to check one file.
test("vendor grouping: a lone entry is fetched from its own URL, never via the package", async () => {
  const url = `${GROUP_BASE}/a.js`;
  const addon = addonWith(
    { "lib/a.js": "A\n" },
    store({
      set: new Set(["lib/a.js"]),
      manifest: [pinnedEntry("lib/a.js", url)],
    })
  );
  const n = {
    fetchBytes: async (got) => {
      if (got !== url) {
        throw new Error(`no package fetch expected, got ${got}`);
      }
      return Buffer.from("A\n");
    },
    fetchJson: async () => ({ downloads: 250000 }),
    postJson: async () => ({ vulns: [] }),
  };
  await verifyVendorDeclarations(addon, n);
  assert.deepEqual(addon.vendor.results, [
    { path: "lib/a.js", source: url, outcome: "verified" },
  ]);
});

// The tarball URL is constructed rather than looked up, so the construction has to be
// held to the same parser every declared source goes through - an unparseable one
// would be fetched from a host nobody vetted.
test("vendor grouping: the constructed package URL classifies as a pinned tarball", () => {
  const src = classifySource(GROUP_TGZ);
  assert.equal(src.trusted, true);
  assert.equal(src.tarball, true);
  assert.equal(src.pkg, "@scope/widget");
  assert.equal(src.version, "1.2.3");
});

// Only file entries on a pinned npm source are grouped. A folder is verified as a
// folder, a declared .tgz already fetches the package, and a github source has no
// package to group by - each keeps its own path, and its own audit.
test("vendor grouping: folder, github and unpinned entries are left alone", async () => {
  const ghUrl = "https://raw.githubusercontent.com/o/r/v1.0.0/x.js";
  const addon = addonWith(
    { "lib/x.js": "X\n", "lib/y.js": "Y\n" },
    store({
      set: new Set(["lib/x.js", "lib/y.js"]),
      manifest: [
        pinnedEntry("lib/x.js", ghUrl),
        {
          path: "lib/y.js",
          sourceUrl: "https://unpkg.com/widget/dist/y.js", // no version: unpinned
          trusted: true,
          pinned: false,
        },
      ],
    })
  );
  await verifyVendorDeclarations(
    addon,
    net({ files: { [ghUrl]: "X\n" }, stars: 5000 })
  );
  assert.deepEqual(addon.vendor.results, [
    { path: "lib/x.js", source: ghUrl, outcome: "verified" },
  ]);
});

// ---- the popularity lookup's request budget ----
// The bug these pin: api.npmjs.org answers a burst with 429, isPopular swallowed
// every failure into `false`, and `false` means "not widely used" - so an add-on
// declaring one package across 34 files demoted its own library, differently on
// every run. A refusal is not a reading, and must be waited out rather than
// believed.

// A 429 says nothing about the package, so the answer is still out there. If this
// stops holding, a popular library is reported as unknown-origin the moment the
// host is busy - and a minified one is REJECTED for it.
test("isPopular: a 429 is retried and the retried answer is used", async () => {
  const calls = { popularity: [] };
  const n = net({ popularityStatus: [429], downloads: 250000, calls });
  assert.equal(await isPopular({ kind: "npm", pkg: "widget" }, n), true);
  assert.equal(calls.popularity.length, 2, "asked again after the refusal");
});

// The same reasoning for the other two shapes a refusal takes. A timeout carries no
// status at all, so it has to be recognised from the message fetchWithTimeout throws.
test("isPopular: a 503 and a timeout are refusals too, not readings", async () => {
  assert.equal(
    await isPopular(
      { kind: "npm", pkg: "widget" },
      net({ popularityStatus: [503], downloads: 250000 })
    ),
    true,
    "503"
  );
  let asked = 0;
  const timingOut = {
    fetchJson: async (url) => {
      if (++asked === 1) {
        throw new Error(`request to ${url} timed out after 10000ms`);
      }
      return { downloads: 250000 };
    },
  };
  assert.equal(
    await isPopular({ kind: "npm", pkg: "widget" }, timingOut),
    true,
    "timeout"
  );
});

// The line that keeps this from becoming "retry everything": npm really does answer
// 404 for a package it has no download data for. Retrying it would multiply our load
// to re-learn the same thing, and it is the shape the offline fixture harness serves
// for every URL it was not told about.
test("isPopular: a 404 is an answer, not a refusal, and is never retried", async () => {
  const calls = { popularity: [] };
  const n = net({ popularityStatus: [404], calls });
  assert.equal(await isPopular({ kind: "npm", pkg: "widget" }, n), false);
  assert.equal(calls.popularity.length, 1, "asked once");
});

// Retrying cannot become waiting forever, and when the host never answers the file
// keeps its old meaning. Trusting it instead would be the dangerous direction: an
// add-on's own entries are what spend the budget, so a submission could pad its
// VENDOR file until the package it cares about goes unasked.
test("isPopular: retries are bounded, and a package still refused is not popular", async () => {
  const calls = { popularity: [] };
  const n = net({
    popularityStatus: [429, 429, 429, 429, 429, 429],
    downloads: 250000,
    calls,
  });
  assert.equal(await isPopular({ kind: "npm", pkg: "widget" }, n), false);
  assert.equal(
    calls.popularity.length,
    VENDOR_POPULARITY_RETRIES + 1,
    "the first ask plus its retries, and no more"
  );
});

// A Retry-After the host actually names is worth more than our guess. npm sends
// "retry-after: 0" with every 429, which names nothing - hence the fallback.
test("isPopular: a Retry-After that names a delay is waited out", async () => {
  const n = net({
    popularityStatus: [429],
    retryAfter: 0.01,
    downloads: 250000,
  });
  setPopularityPacing({ backoffMs: 60000 }); // would hang the suite if preferred
  try {
    assert.equal(await isPopular({ kind: "npm", pkg: "widget" }, n), true);
  } finally {
    setPopularityPacing({ backoffMs: 0 });
  }
});

// The memo is the fix that matters most, because it removes the requests rather than
// spacing them: the add-on that exposed this declared ONE package across 34 files.
test("isPopular: the memo answers once for a package two entries share", async () => {
  const calls = { popularity: [] };
  const n = net({ downloads: 250000, calls });
  const memo = new Map();
  assert.equal(await isPopular({ kind: "npm", pkg: "widget" }, n, memo), true);
  assert.equal(await isPopular({ kind: "npm", pkg: "widget" }, n, memo), true);
  assert.equal(calls.popularity.length, 1, "asked once for the two entries");
});

// Without a memo nothing is remembered, which is what keeps every caller that does
// not pass one behaving exactly as it did.
test("isPopular: with no memo every ask reaches the host", async () => {
  const calls = { popularity: [] };
  const n = net({ downloads: 250000, calls });
  await isPopular({ kind: "npm", pkg: "widget" }, n);
  await isPopular({ kind: "npm", pkg: "widget" }, n);
  assert.equal(calls.popularity.length, 2);
});

// Provenance still short-circuits the whole thing, so a first-party source costs no
// request at all - and therefore none of the budget the rest of the run needs.
test("isPopular: a trusted github org is never asked about", async () => {
  const askless = {
    fetchJson: async () => {
      throw new Error("no popularity lookup expected for a trusted org");
    },
  };
  assert.equal(
    await isPopular(
      { kind: "github", repo: "thunderbird/webext-support" },
      askless
    ),
    true
  );
});

// The declarations a review verifies go through the store's memo, so one package
// declared across several files is one request no matter how many files there are.
test("verifyVendorDeclarations: a package two entries share is looked up once", async () => {
  const calls = { popularity: [] };
  const base = "https://unpkg.com/widget@1.2.3/dist";
  const addon = addonWith(
    { "lib/a.js": "A\n", "lib/b.js": "B\n" },
    store({
      set: new Set(["lib/a.js", "lib/b.js"]),
      manifest: [
        pinnedEntry("lib/a.js", `${base}/a.js`),
        pinnedEntry("lib/b.js", `${base}/b.js`),
      ],
    })
  );
  await verifyVendorDeclarations(
    addon,
    net({
      files: { [`${base}/a.js`]: "A\n", [`${base}/b.js`]: "B\n" },
      downloads: 250000,
      calls,
    })
  );
  assert.deepEqual(addon.vendor.results, [
    { path: "lib/a.js", source: `${base}/a.js`, outcome: "verified" },
    { path: "lib/b.js", source: `${base}/b.js`, outcome: "verified" },
  ]);
  assert.equal(calls.popularity.length, 1, "one reading for the one package");
});

// The regression the whole change must not cause: a package that really is below the
// bar is still not popular, and the file is still demoted.
test("verifyVendorDeclarations: a below-bar reading still records not-popular", async () => {
  const url = "https://unpkg.com/widget@1.2.3/a.js";
  const addon = addonWith(
    { "a.js": "BODY\n" },
    store({ set: new Set(["a.js"]), manifest: [pinnedEntry("a.js", url)] })
  );
  await verifyVendorDeclarations(
    addon,
    net({ bytes: "BODY\n", downloads: 12 })
  );
  assert.deepEqual(addon.vendor.results, [
    { path: "a.js", source: url, outcome: "not-popular" },
  ]);
});

// The other half, and the one every golden rests on: an ORDINARY failure is still
// swallowed. The offline harness throws plain Errors, so a fixture run must stay a
// clean review with no matches - never an abort.
test("an ordinary fetch failure is still swallowed, not fatal", async () => {
  // A transport that fails every request with an ORDINARY error - what the offline
  // fixture harness injects.
  const deadLoad = {
    fetchBytes: async () => {
      throw new Error("offline");
    },
    fetchJson: async () => {
      throw new Error("offline");
    },
    postJson: async () => {
      throw new Error("offline");
    },
  };
  assert.equal(await isPopular({ kind: "npm", pkg: "x" }, deadLoad), false);
  const addon = addonWith(
    { "lib/x.js": "x" },
    {
      manifest: [
        {
          path: "lib/x.js",
          sourceUrl: "https://unpkg.com/x@1.0.0/x.js",
          trusted: true,
          pinned: true,
          kind: "file",
        },
      ],
      packages: [],
      devPackages: [],
      githubDeps: [],
      results: [],
      vulnerabilities: [],
      devVulnerabilities: [],
      unpopularDeps: [],
      unaudited: [],
      set: new Set(),
      folders: new Set(),
      vendorFile: "VENDOR.md",
    }
  );
  await verifyVendorDeclarations(addon, deadLoad);
  assert.deepEqual(
    addon.vendor.results.map((r) => r.outcome),
    ["unfetchable"]
  );
});

// ---- auditLockedPackages (the lock-file tree audit) ----

/** An OSV advisory record as /v1/vulns/<id> serves it. */
const advisory = (id, severity, fixed, name) => ({
  id,
  database_specific: { severity },
  affected: [
    {
      package: { ecosystem: "npm", name },
      ranges: [{ events: [{ fixed }] }],
    },
  ],
});

/** A lock entry as lockedPackages produces one. */
const locked = (name, version, dev = false, direct = false) => ({
  name,
  version,
  dev,
  direct,
  file: "package-lock.json",
  token: `node_modules/${name}`,
});

// The whole reason the tree audit exists: the advisory is on a package the
// submission never declared, so nothing in package.json could have found it. It
// anchors at the lock file, where the reviewer can actually see the entry.
test("auditLockedPackages: an undeclared HIGH is recorded with its lock anchor", async () => {
  const addon = addonWith(
    { "package.json": "{}", "package-lock.json": "{}" },
    store({ lockPackages: [locked("nth-check", "2.0.0")] })
  );
  await verifyScaDependencies(
    addon,
    net({
      batch: { results: [{ vulns: [{ id: "GHSA-tree" }] }] },
      advisories: {
        "GHSA-tree": advisory("GHSA-tree", "HIGH", "2.0.1", "nth-check"),
      },
    })
  );
  assert.deepEqual(addon.vendor.treeVulnerabilities, [
    {
      name: "nth-check",
      version: "2.0.0",
      ids: ["GHSA-tree"],
      severity: "high",
      fixed: ["2.0.1"],
      file: "package-lock.json",
      token: "node_modules/nth-check",
    },
  ]);
  assert.deepEqual(addon.vendor.treeDevVulnerabilities, []);
});

// A package nobody chose is worth the developer's attention when it fails the
// review, not when it merely appears in one - so anything under high produces
// nothing at all, rather than an info finding buried in a list of hundreds.
test("auditLockedPackages: a moderate or low advisory is not recorded", async () => {
  const addon = addonWith(
    { "package.json": "{}" },
    store({
      lockPackages: [locked("mid", "1.0.0"), locked("small", "1.0.0")],
    })
  );
  await verifyScaDependencies(
    addon,
    net({
      batch: {
        results: [
          { vulns: [{ id: "GHSA-mid" }] },
          { vulns: [{ id: "GHSA-low" }] },
        ],
      },
      advisories: {
        "GHSA-mid": advisory("GHSA-mid", "MODERATE", "1.0.1", "mid"),
        "GHSA-low": advisory("GHSA-low", "LOW", "1.0.1", "small"),
      },
    })
  );
  assert.deepEqual(addon.vendor.treeVulnerabilities, []);
  assert.deepEqual(addon.vendor.treeDevVulnerabilities, []);
});

// The two halves ask the developer different things - one about shipped code,
// one about what runs on the reviewer's machine - so the lock's dev flag decides
// which check reports it.
test("auditLockedPackages: a build-time package routes to the dev set", async () => {
  const addon = addonWith(
    { "package.json": "{}" },
    store({ lockPackages: [locked("serialize-javascript", "6.0.2", true)] })
  );
  await verifyScaDependencies(
    addon,
    net({
      batch: { results: [{ vulns: [{ id: "GHSA-dev" }] }] },
      advisories: {
        "GHSA-dev": advisory(
          "GHSA-dev",
          "HIGH",
          "6.0.3",
          "serialize-javascript"
        ),
      },
    })
  );
  assert.deepEqual(addon.vendor.treeVulnerabilities, []);
  assert.equal(addon.vendor.treeDevVulnerabilities.length, 1);
  assert.equal(
    addon.vendor.treeDevVulnerabilities[0].name,
    "serialize-javascript"
  );
});

// A declared dependency is already audited by name, at every severity, anchored
// at its package.json line. Sending it again would report it twice - the second
// time as something nobody declared - so it never reaches the batch at all.
test("auditLockedPackages: a declared package is not re-queried", async () => {
  const calls = { batch: [], query: [] };
  const addon = addonWith(
    { "package.json": '{"dependencies":{"marked":"4.0.0"}}' },
    store({
      packages: [{ name: "marked", version: "4.0.0" }],
      devPackages: [{ name: "webpack", version: "5.0.0" }],
      lockPackages: [
        locked("marked", "4.0.0"),
        locked("webpack", "5.0.0", true),
        locked("deep", "1.0.0"),
      ],
    })
  );
  await verifyScaDependencies(
    addon,
    net({
      calls,
      osv: { vulns: [] },
      batch: { results: [{ vulns: [] }] },
    })
  );
  assert.deepEqual(
    calls.batch[0].queries.map((q) => q.package.name),
    ["deep"]
  );
  // The declared half still went through the single-package endpoint, once each.
  assert.deepEqual(
    calls.query.map((q) => q.package.name),
    ["marked", "webpack"]
  );
});

// One request carrying a whole large tree is refused by the endpoint, so the
// queue is chunked - and the chunks must together cover every package exactly
// once, in order, because the answers come back positionally.
test("auditLockedPackages: the queue is chunked, covering every package once", async () => {
  const calls = { batch: [] };
  const lockPackages = Array.from({ length: 250 }, (_, i) =>
    locked(`pkg-${String(i).padStart(3, "0")}`, "1.0.0")
  );
  const addon = addonWith({ "package.json": "{}" }, store({ lockPackages }));
  await verifyScaDependencies(addon, net({ calls, batch: { results: [] } }));
  assert.deepEqual(
    calls.batch.map((b) => b.queries.length),
    [200, 50]
  );
  assert.deepEqual(
    calls.batch.flatMap((b) => b.queries.map((q) => q.package.name)),
    lockPackages.map((p) => p.name)
  );
});

// The endpoint says nothing about which package each answer is for - only its
// position - so a short or empty results array must leave the rest unreported
// rather than shifting every answer onto the wrong package.
test("auditLockedPackages: a short results array reports only what it covers", async () => {
  const addon = addonWith(
    { "package.json": "{}" },
    store({
      lockPackages: [locked("first", "1.0.0"), locked("second", "1.0.0")],
    })
  );
  await verifyScaDependencies(
    addon,
    net({
      batch: { results: [{ vulns: [{ id: "GHSA-one" }] }] },
      advisories: {
        "GHSA-one": advisory("GHSA-one", "CRITICAL", "1.0.1", "first"),
      },
    })
  );
  assert.deepEqual(
    addon.vendor.treeVulnerabilities.map((v) => v.name),
    ["first"]
  );
});

// One advisory routinely affects several packages in the same tree. Fetching it
// once per package would multiply the requests for no new information.
test("auditLockedPackages: an advisory affecting two packages is fetched once", async () => {
  const calls = { hydrate: [] };
  const addon = addonWith(
    { "package.json": "{}" },
    store({ lockPackages: [locked("a", "1.0.0"), locked("b", "1.0.0")] })
  );
  await verifyScaDependencies(
    addon,
    net({
      calls,
      batch: {
        results: [
          { vulns: [{ id: "GHSA-shared" }] },
          { vulns: [{ id: "GHSA-shared" }] },
        ],
      },
      advisories: {
        "GHSA-shared": advisory("GHSA-shared", "HIGH", "1.0.1", "a"),
      },
    })
  );
  assert.equal(calls.hydrate.length, 1);
  assert.deepEqual(
    addon.vendor.treeVulnerabilities.map((v) => v.name),
    ["a", "b"]
  );
});

// A partial scan would make the report depend on how far the network got, so a
// failure anywhere abandons the whole thing and records nothing - the same
// silence an offline run gets everywhere else.
test("auditLockedPackages: a failing batch or hydration records nothing", async () => {
  const batchDown = addonWith(
    { "package.json": "{}" },
    store({ lockPackages: [locked("x", "1.0.0")] })
  );
  await verifyScaDependencies(batchDown, net({ throwOnBatch: true }));
  assert.deepEqual(batchDown.vendor.treeVulnerabilities, []);

  const hydrationDown = addonWith(
    { "package.json": "{}" },
    store({ lockPackages: [locked("x", "1.0.0")] })
  );
  await verifyScaDependencies(
    hydrationDown,
    net({
      throwOnHydrate: true,
      batch: { results: [{ vulns: [{ id: "GHSA-x" }] }] },
    })
  );
  assert.deepEqual(hydrationDown.vendor.treeVulnerabilities, []);
});

// The case the test above cannot reach: enough packages to need a SECOND chunk,
// with the failure after the first has already answered. A scan that kept those
// answers would publish a partial tree that reads exactly like a clean one.
test("auditLockedPackages: an answered chunk is discarded when a later one fails", async () => {
  const lockPackages = Array.from({ length: 250 }, (_, i) =>
    locked(`pkg-${String(i).padStart(3, "0")}`, "1.0.0")
  );
  const addon = addonWith({ "package.json": "{}" }, store({ lockPackages }));
  let chunks = 0;
  const flaky = net({
    advisories: {
      "GHSA-everywhere": advisory("GHSA-everywhere", "HIGH", "2.0.0", "pkg"),
    },
  });
  const answer = flaky.postJson;
  flaky.postJson = async (url, body) => {
    if (url.includes("querybatch") && ++chunks === 2) {
      throw new Error("the network went away mid-scan");
    }
    return url.includes("querybatch")
      ? {
          results: body.queries.map(() => ({
            vulns: [{ id: "GHSA-everywhere" }],
          })),
        }
      : answer(url, body);
  };
  await verifyScaDependencies(addon, flaky);
  assert.equal(chunks, 2, "the first chunk must really have answered");
  assert.deepEqual(addon.vendor.treeVulnerabilities, []);
  assert.deepEqual(addon.vendor.treeDevVulnerabilities, []);
});

// OSV's malicious-package records state no severity at all, so a band rule alone
// discards them - and "this package is malicious" is the strongest thing the
// advisory database can say about a package nobody chose to install.
test("auditLockedPackages: a malicious-package advisory is kept at any band", async () => {
  const addon = addonWith(
    { "package.json": "{}" },
    store({ lockPackages: [locked("evil-pkg", "1.0.0")] })
  );
  await verifyScaDependencies(
    addon,
    net({
      batch: { results: [{ vulns: [{ id: "MAL-2023-462" }] }] },
      // As OSV really serves one: no database_specific.severity, no severity[].
      advisories: {
        "MAL-2023-462": {
          id: "MAL-2023-462",
          summary: "Malicious code in evil-pkg",
        },
      },
    })
  );
  assert.deepEqual(
    addon.vendor.treeVulnerabilities.map((v) => [v.name, v.severity, v.ids]),
    [["evil-pkg", "unknown", ["MAL-2023-462"]]]
  );
});

// `results` is checked for being an array; each entry's `vulns` must be too, or
// a malformed answer throws out of the audit and takes the whole review with it.
test("auditLockedPackages: a non-array vulns field does not abort the review", async () => {
  const addon = addonWith(
    { "package.json": "{}" },
    store({ lockPackages: [locked("x", "1.0.0")] })
  );
  await verifyScaDependencies(
    addon,
    net({ batch: { results: [{ vulns: 5 }] } })
  );
  assert.deepEqual(addon.vendor.treeVulnerabilities, []);
});

// Telling a developer their add-on "does not declare" a package they wrote down
// is a false statement in a rejection. The lock records the declaration forms the
// root package.json parse misses, so the enumeration's own `direct` flag settles
// it - including when package.json and the lock disagree about the version, which
// is what keeps the name@version comparison from being enough.
test("auditLockedPackages: a package the lock says was declared is left alone", async () => {
  const calls = { batch: [] };
  const addon = addonWith(
    { "package.json": '{"devDependencies":{"adm-zip":"0.5.17"}}' },
    store({
      // package.json pins 0.5.17; the lock installed 0.5.18.
      devPackages: [{ name: "adm-zip", version: "0.5.17" }],
      lockPackages: [
        locked("adm-zip", "0.5.18", true, true),
        locked("workspace-dep", "1.0.0", false, true),
        locked("genuinely-pulled-in", "1.0.0"),
      ],
    })
  );
  await verifyScaDependencies(
    addon,
    net({ calls, osv: { vulns: [] }, batch: { results: [{ vulns: [] }] } })
  );
  assert.deepEqual(
    calls.batch[0].queries.map((q) => q.package.name),
    ["genuinely-pulled-in"]
  );
});

// NetworkGoneError is not a flaky endpoint, it is the run having no network at
// all - which stops the review rather than quietly reporting a clean tree.
test("auditLockedPackages: NetworkGoneError propagates from both endpoints", async () => {
  const gone = new NetworkGoneError("https://api.osv.dev/", false);
  const fromBatch = addonWith(
    { "package.json": "{}" },
    store({ lockPackages: [locked("x", "1.0.0")] })
  );
  const batchNet = net({ batch: { results: [] } });
  batchNet.postJson = async () => {
    throw gone;
  };
  await assert.rejects(
    () => verifyScaDependencies(fromBatch, batchNet),
    NetworkGoneError
  );

  const fromHydrate = addonWith(
    { "package.json": "{}" },
    store({ lockPackages: [locked("x", "1.0.0")] })
  );
  const hydrateNet = net({
    batch: { results: [{ vulns: [{ id: "GHSA-x" }] }] },
  });
  hydrateNet.fetchJson = async () => {
    throw gone;
  };
  await assert.rejects(
    () => verifyScaDependencies(fromHydrate, hydrateNet),
    NetworkGoneError
  );
});

// The blocklist's wording is about the library versions an add-on SHIPS, chosen
// by its developer. A package pulled in three levels down was chosen by nobody,
// so it is audited for advisories but never policy-blocked.
test("auditLockedPackages: the policy blocklist is not applied to the tree", async () => {
  const addon = addonWith(
    { "package.json": "{}" },
    store({ lockPackages: [locked("jquery", "1.7.1")] })
  );
  const blocks = parseLibraryBlocks(
    "jquery:\n  - versions: '<3.0.0'\n    status: banned\n    reason: Too old.\n"
  );
  await verifyScaDependencies(
    addon,
    net({ batch: { results: [{ vulns: [] }] } }),
    blocks
  );
  assert.deepEqual(addon.vendor.blocked, []);
});

// Nothing to audit must cost nothing: an XPI review, and every submission with
// no committed lock, must not reach the endpoint at all.
test("auditLockedPackages: an empty tree sends no request", async () => {
  const calls = { batch: [] };
  const addon = addonWith({ "package.json": "{}" }, store());
  await verifyScaDependencies(addon, net({ calls }));
  assert.deepEqual(calls.batch, []);
});
