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
