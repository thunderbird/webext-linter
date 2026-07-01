// Unit tests for resolveVendor: the deterministic parse plus the token-gated LLM
// parse fallback (transport injected, so no network).

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveVendor } from "../../src/vendor/resolve.js";

function fakeAddon(files) {
  const map = new Map();
  for (const [k, v] of Object.entries(files)) {
    map.set(k, Buffer.from(v));
  }
  return { files: map };
}

// With a token, a VENDOR file the deterministic scan can't map is parsed by the
// LLM; every returned path is re-validated, so a hallucinated file is dropped.
test("resolveVendor uses the LLM fallback and drops hallucinated paths", async () => {
  const addon = fakeAddon({
    VENDOR: "We bundle the Foo library; see our docs for details.",
    "app.js": "x",
  });
  let called = 0;
  const callText = async () => {
    called++;
    return '[{"file":"app.js","url":"https://unpkg.com/foo@1/app.js"},{"file":"ghost.js","url":"y"}]';
  };
  const { set, manifest, vulnerabilities, unaudited } = await resolveVendor({
    addon,
    parsePrompt: "PARSE",
    enabled: true,
    token: "t",
    model: "m",
    callText,
  });
  assert.equal(called, 1);
  assert.deepEqual(
    manifest.map((e) => [e.path, e.sourceUrl]),
    [["app.js", "https://unpkg.com/foo@1/app.js"]]
  );
  assert.deepEqual([...set], ["app.js"]);
  // The network step fills these; resolveVendor leaves them empty.
  assert.deepEqual([vulnerabilities, unaudited], [[], []]);
});

// Without a token the fallback never runs (deterministic only); an unmappable
// VENDOR file yields an empty set and the transport is not called.
test("resolveVendor stays deterministic with no token", async () => {
  const addon = fakeAddon({
    VENDOR: "We bundle the Foo library; see our docs for details.",
    "app.js": "x",
  });
  const callText = async () => {
    throw new Error("must not be called");
  };
  const { set, manifest } = await resolveVendor({
    addon,
    parsePrompt: "PARSE",
    token: undefined,
    callText,
  });
  assert.equal(manifest.length, 0);
  assert.equal(set.size, 0);
});

// When the deterministic parse already maps the file, the fallback is skipped
// even with a token (no wasted call). The declared file is library-like (.min), as
// the accepted format requires.
test("resolveVendor skips the fallback when the deterministic parse succeeds", async () => {
  const addon = fakeAddon({
    "VENDOR.md":
      "File: vendor/jszip.min.js\nSource: https://unpkg.com/jszip@3.10.1/dist/jszip.min.js\n",
    "vendor/jszip.min.js": "x",
  });
  let called = 0;
  const { manifest } = await resolveVendor({
    addon,
    parsePrompt: "PARSE",
    enabled: true,
    token: "t",
    callText: async () => {
      called++;
      return "[]";
    },
  });
  assert.equal(called, 0);
  assert.deepEqual(
    manifest.map((e) => [e.path, e.sourceUrl]),
    [
      [
        "vendor/jszip.min.js",
        "https://unpkg.com/jszip@3.10.1/dist/jszip.min.js",
      ],
    ]
  );
});

// A VENDOR entry (file + URL) naming an absent file is surfaced as `missing`, and
// is NOT treated as "unparsed" (so it routes to missing-vendor-file, not manual).
test("resolveVendor surfaces a missing declared file, not 'unparsed'", async () => {
  const addon = fakeAddon({
    VENDOR: "File: lib/ghost.js\nSource: https://unpkg.com/x@1.0.0/ghost.js\n",
    "bg.js": "x",
  });
  const { manifest, missing, unparsedVendor } = await resolveVendor({
    addon,
    token: undefined,
  });
  assert.equal(manifest.length, 0);
  assert.deepEqual(
    missing.map((e) => e.path),
    ["lib/ghost.js"]
  );
  assert.equal(unparsedVendor, false);
});

// A VENDOR file we could extract nothing from (pure prose) is still "unparsed".
test("resolveVendor marks a pure-prose VENDOR as 'unparsed'", async () => {
  const addon = fakeAddon({
    VENDOR: "We bundle some stuff, see our docs.",
    "bg.js": "x",
  });
  const { manifest, missing, unparsedVendor } = await resolveVendor({
    addon,
    token: undefined,
  });
  assert.equal(manifest.length, 0);
  assert.equal(missing.length, 0);
  assert.equal(unparsedVendor, true);
});

const LIB = "/*! Lib v1 | (c) authors | MIT */\n(function () {})();\n";

// A block that names a library file but only a bare repository URL (not a file
// source) has no valid entry -> "unparsed" (a parse-error finding, not silently
// dropped).
test("resolveVendor marks a library + repo-only-URL block as 'unparsed'", async () => {
  const addon = fakeAddon({
    "VENDOR.md":
      "## DOMPurify\n" +
      "- Included file: `vendor/purify.js`\n" +
      "- Upstream repository: https://github.com/cure53/DOMPurify\n",
    "vendor/purify.js": LIB,
  });
  const { manifest, missing, unparsedVendor } = await resolveVendor({
    addon,
    token: undefined,
  });
  assert.equal(manifest.length, 0);
  assert.equal(missing.length, 0);
  assert.equal(unparsedVendor, true);
});

// A packaged file paired with a source URL is trusted as a vendor entry even when
// it is the add-on's own (non-library) code - verification, not the parser, decides.
test("resolveVendor trusts a declared file + source URL", async () => {
  const addon = fakeAddon({
    "VENDOR.md":
      "File: modules/own.js\nSource: https://unpkg.com/x@1.0.0/own.js\n",
    "modules/own.js": "export function f() {}\n",
  });
  const { manifest, unparsedVendor } = await resolveVendor({
    addon,
    token: undefined,
  });
  assert.deepEqual(
    manifest.map((e) => [e.path, e.sourceUrl]),
    [["modules/own.js", "https://unpkg.com/x@1.0.0/own.js"]]
  );
  assert.equal(unparsedVendor, false);
});

// A single source URL paired with more than one bundled FILE is ambiguous:
// resolveVendor pulls those entries out of the manifest (not verified) and records
// them on ambiguousSources, while keeping their paths vendored (skip-set).
test("resolveVendor flags >1 file per source URL as ambiguous", async () => {
  const addon = fakeAddon({
    "VENDOR.md":
      "## Bundle\n" +
      "- bundled file: vendor/a.min.js\n" +
      "- bundled file: vendor/b.min.js\n" +
      "- source: https://unpkg.com/bundle@1.0.0/dist/bundle.js\n",
    "vendor/a.min.js": "x",
    "vendor/b.min.js": "x",
  });
  const { manifest, ambiguousSources, set } = await resolveVendor({
    addon,
    token: undefined,
  });
  assert.deepEqual(manifest, []); // not verified - ambiguous pairing
  assert.equal(ambiguousSources.length, 1);
  assert.equal(
    ambiguousSources[0].source,
    "https://unpkg.com/bundle@1.0.0/dist/bundle.js"
  );
  assert.deepEqual([...ambiguousSources[0].paths].sort(), [
    "vendor/a.min.js",
    "vendor/b.min.js",
  ]);
  assert.deepEqual([...set].sort(), ["vendor/a.min.js", "vendor/b.min.js"]);
});

// A `bundled directory` + a github tree URL is a folder entry: its path goes to
// `folders` (prefix skip-set), not the exact-path `set`, and it is never ambiguous.
test("resolveVendor records a folder declaration", async () => {
  const TREE =
    "https://github.com/o/r/tree/0123456789012345678901234567890123456789/dist/lib";
  const addon = fakeAddon({
    "VENDOR.md": `- bundled directory : vendor/lib\n- source : ${TREE}\n`,
    "vendor/lib/a.js": "x",
  });
  const { manifest, folders, set, ambiguousSources } = await resolveVendor({
    addon,
    token: undefined,
  });
  assert.deepEqual(
    manifest.map((e) => [e.path, e.kind]),
    [["vendor/lib", "folder"]]
  );
  assert.deepEqual([...folders], ["vendor/lib"]);
  assert.deepEqual([...set], []); // a folder is a prefix, not an exact path
  assert.deepEqual(ambiguousSources, []);
});

// package.json dependencies are classified by spec into the only two supported
// sources - a pinned npm package and a GitHub URL - plus the two rejected cases:
// an unpinned range, and an unsupported source (file:/alias/non-github git).
test("resolveVendor classifies package.json deps by source", async () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: {
        pinned: "1.2.3", // npm, exact
        ranged: "^2.0.0", // unpinned (no lock)
        ghshort: "github:o/r#v1.0.0", // github
        ghbare: "owner/repo", // github bare shorthand
        ghurl: "git+https://github.com/a/b.git", // github url
        ghscp: "git@github.com:scp/repo.git#v3", // github SCP-style git URL
        local: "file:../x", // unsupported
        aliased: "npm:other@1.0.0", // unsupported (npm alias)
        gitlab: "git+https://gitlab.com/o/r.git", // unsupported (non-github git)
      },
    }),
  });
  const v = await resolveVendor({ addon, enabled: false });
  assert.deepEqual(v.packages, [{ name: "pinned", version: "1.2.3" }]);
  assert.deepEqual(
    v.unpinned.map((u) => u.name),
    ["ranged"]
  );
  assert.deepEqual(
    v.githubDeps.map((g) => `${g.name}:${g.repo}`),
    ["ghshort:o/r", "ghbare:owner/repo", "ghurl:a/b", "ghscp:scp/repo"]
  );
  assert.equal(
    v.githubDeps.find((g) => g.name === "ghshort").ref,
    "v1.0.0" // the #ref is captured
  );
  assert.equal(v.githubDeps.find((g) => g.name === "ghscp").ref, "v3");
  assert.deepEqual(
    v.unsupportedDeps.map((u) => u.name),
    ["local", "aliased", "gitlab"]
  );
});

// devDependencies never ship, but the SCS reviewer builds from source, so their
// pinned npm packages are OSV-audited too. Only the pinned-npm bucket lands in
// devPackages: an exact spec, or a range a lock file pins. A range with no lock, a
// github source, and an unsupported source are dropped - and never leak into the
// prod buckets.
test("resolveVendor collects pinned npm devDependencies in devPackages", async () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { prod: "1.0.0" },
      devDependencies: {
        esbuild: "0.19.0", // npm, exact -> devPackages
        webpack: "^5.0.0", // range, pinned by the lock -> devPackages
        ranged: "^2.0.0", // range, no lock -> dropped
        ghdev: "github:o/r#v1.0.0", // github -> dropped
        localdev: "file:../x", // unsupported -> dropped
      },
    }),
    "package-lock.json": JSON.stringify({
      packages: { "node_modules/webpack": { version: "5.88.0" } },
    }),
  });
  const v = await resolveVendor({ addon, enabled: false });
  assert.deepEqual(v.devPackages, [
    { name: "esbuild", version: "0.19.0" },
    { name: "webpack", version: "5.88.0" },
  ]);
  // Prod deps are unaffected, and no dev dep leaks into the prod buckets.
  assert.deepEqual(v.packages, [{ name: "prod", version: "1.0.0" }]);
  assert.deepEqual(
    v.githubDeps.map((g) => g.name),
    []
  );
  assert.deepEqual(
    v.unsupportedDeps.map((u) => u.name),
    []
  );
});

// A package listed in BOTH dependencies and devDependencies (legal npm - the
// dependencies copy wins) is a production dependency: it is classified once as
// prod and dropped from devPackages, so it is audited + reported once (not by both
// vendor-vulnerable and vendor-vulnerable-dev at the same line).
test("resolveVendor treats a dep in both dependencies and devDependencies as prod-only", async () => {
  const addon = fakeAddon({
    "package.json": JSON.stringify({
      dependencies: { shared: "1.0.0", prodonly: "2.0.0" },
      devDependencies: { shared: "1.0.0", devonly: "3.0.0" },
    }),
  });
  const v = await resolveVendor({ addon, enabled: false });
  assert.deepEqual(v.packages, [
    { name: "shared", version: "1.0.0" },
    { name: "prodonly", version: "2.0.0" },
  ]);
  // "shared" is NOT in devPackages - only the genuinely dev-only package is.
  assert.deepEqual(v.devPackages, [{ name: "devonly", version: "3.0.0" }]);
});
