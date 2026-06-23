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
// even with a token (no wasted call).
test("resolveVendor skips the fallback when the deterministic parse succeeds", async () => {
  const addon = fakeAddon({
    "VENDOR.md": "File: app.js\nSource: https://unpkg.com/foo@1/app.js\n",
    "app.js": "x",
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
    [["app.js", "https://unpkg.com/foo@1/app.js"]]
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
