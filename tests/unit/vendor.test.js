// Unit tests for the deterministic VENDOR parser (parseVendorManifest), covering
// the real-world styles seen in submissions.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseVendorManifest,
  missingVendorEntries,
} from "../../src/normalize/vendor.js";

function fakeAddon(files) {
  const map = new Map();
  for (const [k, v] of Object.entries(files)) {
    map.set(k, Buffer.from(v));
  }
  return { files: map };
}
const entries = (files) =>
  parseVendorManifest(fakeAddon(files)).map((e) => [e.path, e.sourceUrl]);
const missing = (files) =>
  missingVendorEntries(fakeAddon(files)).map((e) => [e.path, e.sourceUrl]);

// The documented "path:" header + "- URL:" detail line.
test("parses the documented path: + URL: form", () => {
  assert.deepEqual(
    entries({
      "VENDOR.md":
        "# Third-party\n\nlib/ical.min.js:\n - Version: 2.2.1\n" +
        " - URL: https://example.com/ical.min.js\n",
      "lib/ical.min.js": "x",
    }),
    [["lib/ical.min.js", "https://example.com/ical.min.js"]]
  );
});

// Prose + numbered list with "File:" / "Source:" on separate lines, under the
// singular filename VENDOR.
test("parses the File:/Source: form (VENDOR)", () => {
  assert.deepEqual(
    entries({
      VENDOR:
        "This add-on uses:\n\n1. JSZip (v3.10.1)\nFile: jszip.min.js\n" +
        "Source: https://unpkg.com/jszip@3.10.1/dist/jszip.min.js\n",
      "jszip.min.js": "x",
    }),
    [["jszip.min.js", "https://unpkg.com/jszip@3.10.1/dist/jszip.min.js"]]
  );
});

// "file:"/"source:" with Windows backslash paths, under the plural VENDORS.md.
test("parses file:/source: with backslash paths (VENDORS.md)", () => {
  assert.deepEqual(
    entries({
      "VENDORS.md":
        "file: pages\\_lib\\list.js\n" +
        "source: https://cdn.jsdelivr.net/npm/list.js@2.3.1/dist/list.js\n",
      "pages/_lib/list.js": "x",
    }),
    [
      [
        "pages/_lib/list.js",
        "https://cdn.jsdelivr.net/npm/list.js@2.3.1/dist/list.js",
      ],
    ]
  );
});

// A single "name : url" line.
test("parses the one-line name : url form", () => {
  assert.deepEqual(
    entries({
      "VENDORS.md":
        "jspdf.umd.js : https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.js\n",
      "jspdf.umd.js": "y",
    }),
    [
      [
        "jspdf.umd.js",
        "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.js",
      ],
    ]
  );
});

// A basename declared without its full path matches an unambiguous packaged file.
test("matches an unambiguous basename to its packaged path", () => {
  assert.deepEqual(
    entries({ VENDOR: "File: jszip.min.js\n", "vendor/jszip.min.js": "x" }),
    [["vendor/jszip.min.js", null]]
  );
});

// Prose and references to non-packaged files are dropped; no VENDOR file -> [].
test("drops prose and unmatched files; empty without a VENDOR file", () => {
  assert.deepEqual(
    entries({ "VENDOR.md": "Libraries:\nmissing/file.js:\n", "real.js": "z" }),
    []
  );
  assert.deepEqual(entries({ "a.js": "1" }), []);
});

// A declared file (file + source URL) that the package does not contain.
test("missingVendorEntries flags a declared file absent from the package", () => {
  assert.deepEqual(
    missing({
      VENDOR:
        "File: lib/ghost.js\nSource: https://unpkg.com/x@1.0.0/ghost.js\n",
      "bg.js": "x",
    }),
    [["lib/ghost.js", "https://unpkg.com/x@1.0.0/ghost.js"]]
  );
});

// No http(s) source URL -> not treated as a declaration (could be prose).
test("missingVendorEntries ignores a declaration with no source URL", () => {
  assert.deepEqual(
    missing({ VENDOR: "File: lib/ghost.js\n", "bg.js": "x" }),
    []
  );
});

// A version token ("2.2.1") looks loosely file-like but is not a real filename,
// and a present file resolves - neither is reported missing.
test("missingVendorEntries ignores version tokens and present files", () => {
  assert.deepEqual(
    missing({
      "VENDOR.md":
        "lib/ical.min.js:\n - Version: 2.2.1\n" +
        " - URL: https://example.com/ical.min.js\n",
      "lib/ical.min.js": "x",
    }),
    []
  );
});

// Present and missing entries coexist; the matched output stays unchanged.
test("missingVendorEntries: present and missing coexist, parse unaffected", () => {
  const files = {
    "VENDORS.md":
      "file: lib/here.js\nsource: https://unpkg.com/a@1.0.0/here.js\n\n" +
      "file: lib/gone.js\nsource: https://unpkg.com/b@2.0.0/gone.js\n",
    "lib/here.js": "x",
  };
  assert.deepEqual(missing(files), [
    ["lib/gone.js", "https://unpkg.com/b@2.0.0/gone.js"],
  ]);
  assert.deepEqual(entries(files), [
    ["lib/here.js", "https://unpkg.com/a@1.0.0/here.js"],
  ]);
});
