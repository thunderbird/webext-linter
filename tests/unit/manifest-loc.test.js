// Unit tests for position-aware manifest line attribution (buildManifestLoc)
// and its use by a migrated check. Covers the two failure modes of the old
// substring search: \uXXXX escaping and a value that appears more than once.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildManifestLoc } from "../../src/addon/manifest-loc.js";
import { manifestTokenLine } from "../../src/checks/lib/util.js";
import minimizeHostPermissions from "../../src/checks/rules/minimize-host-permissions.js";

// A manifest where "<all_urls>" is JSON-escaped AND appears twice: once in a
// web_accessible_resources match (line 4) and once in host_permissions (line 6).
const TEXT = [
  /* 1 */ "{",
  /* 2 */ '  "manifest_version": 3,',
  /* 3 */ '  "web_accessible_resources": [',
  /* 4 */ '    { "resources": ["x.png"], "matches": ["\\u003call_urls\\u003e"] }',
  /* 5 */ "  ],",
  /* 6 */ '  "host_permissions": ["\\u003call_urls\\u003e"]',
  /* 7 */ "}",
].join("\n");

// The path resolves to the exact line of each occurrence, despite the escaping.
test("buildManifestLoc resolves the exact line for an escaped, repeated value", () => {
  const loc = buildManifestLoc(TEXT);
  assert.equal(loc.lineAt(["host_permissions", 0]), 6);
  assert.equal(loc.lineAt(["web_accessible_resources", 0, "matches", 0]), 4);
  // The old substring search misses entirely (the value is \u-escaped) - the
  // reason we switched to path lookup.
  assert.equal(manifestTokenLine(TEXT, "<all_urls>"), null);
});

// An absent path and an unparseable manifest both degrade to null, never throw.
test("buildManifestLoc returns null for missing paths and unparseable text", () => {
  const loc = buildManifestLoc(TEXT);
  assert.equal(loc.lineAt(["nope"]), null);
  assert.equal(loc.lineAt(["host_permissions", 9]), null);
  const broken = buildManifestLoc("{ this is : not json");
  assert.equal(broken.lineAt(["anything"]), null);
});

// End-to-end: the minimize-host-permissions finding for <all_urls> carries the
// real host_permissions line (6), not the first textual occurrence (4).
test("minimize-host-permissions anchors <all_urls> on its host_permissions line", () => {
  const addon = {
    manifest: JSON.parse(TEXT), // decodes the escapes to "<all_urls>"
    files: new Map([["manifest.json", Buffer.from(TEXT)]]),
    manifestLoc: buildManifestLoc(TEXT),
  };
  const out = minimizeHostPermissions.run({ addon });
  const f = out.find((x) => x.item === "<all_urls>");
  assert.ok(f, "expected an <all_urls> finding");
  assert.equal(f.loc?.line, 6);
});
