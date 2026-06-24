// Unit tests for the deterministic VENDOR parser (parseVendorManifest /
// missingVendorEntries), covering the accepted VENDOR-entry format and the styles
// seen in real submissions.
//
// Accepted format: an entry is a LIBRARY-LIKE packaged file (the path) paired with
// a source URL that points to a FILE, both inside a block (delimited by headings or
// blank lines). The library signal is the primary identifier - other local paths in
// a block (the add-on's own modules, the package name) are ignored - and a bare
// repository URL (github.com/owner/repo, no file) is not a source. A VENDOR file
// that yields no entry is "unparseable" (surfaced as a finding elsewhere).
//
// NOTE: several of these assert the accepted format and only pass once the block
// scan lands (Task 2); they are the spec for that rewrite.

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

// A minifier banner makes a file library-like (so does a .min name / UMD wrapper);
// plain content is the add-on's own code.
const LIB = "/*! Lib v1 | (c) authors | MIT */\n(function () {})();\n";
const OWN = "export function f() {}\n";

// ---- valid: the NC-style Markdown block (the case that drove this) ----
// A `## DOMPurify` block lists the package name, a Source: file URL, an Upstream
// repository: repo URL, and the Included file path in a backtick code-span, then a
// Usage section citing the add-on's own module. Only the library file + the file
// URL are extracted: the repo URL (not a file), the package name, and the module
// path are all ignored.
test("parses a Markdown block: library file + file Source URL only", () => {
  assert.deepEqual(
    entries({
      "VENDOR.md":
        "# Third-Party Dependencies\n\n" +
        "## DOMPurify\n" +
        "- Package: `dompurify`\n" +
        "- Version: `3.4.7`\n" +
        "- Source: https://registry.npmjs.org/dompurify/-/dompurify-3.4.7.tgz\n" +
        "- Upstream repository: https://github.com/cure53/DOMPurify\n" +
        "- Included file: `vendor/purify.js` (browser build from `dist/purify.js`)\n" +
        "- Usage:\n  - sanitizing in `modules/htmlSanitizer.js`\n",
      "vendor/purify.js": LIB,
      "modules/htmlSanitizer.js": OWN,
    }),
    [
      [
        "vendor/purify.js",
        "https://registry.npmjs.org/dompurify/-/dompurify-3.4.7.tgz",
      ],
    ]
  );
});

// Two `##` blocks -> two entries; each pairs the library file with its own URL.
test("parses multiple Markdown blocks into one entry each", () => {
  assert.deepEqual(
    entries({
      "VENDOR.md":
        "## ical.js\n" +
        "- Source: https://registry.npmjs.org/ical.js/-/ical.js-2.2.1.tgz\n" +
        "- Included file: `vendor/ical.js`\n\n" +
        "## DOMPurify\n" +
        "- Source: https://cdn.jsdelivr.net/npm/dompurify@3.4.7/dist/purify.js\n" +
        "- Included file: `vendor/purify.js`\n",
      "vendor/ical.js": LIB,
      "vendor/purify.js": LIB,
    }),
    [
      [
        "vendor/ical.js",
        "https://registry.npmjs.org/ical.js/-/ical.js-2.2.1.tgz",
      ],
      [
        "vendor/purify.js",
        "https://cdn.jsdelivr.net/npm/dompurify@3.4.7/dist/purify.js",
      ],
    ]
  );
});

// The plain "File:" / "Source:" form, with a .min library file.
test("parses the File:/Source: form (library file)", () => {
  assert.deepEqual(
    entries({
      VENDOR:
        "JSZip (v3.10.1)\n" +
        "File: vendor/jszip.min.js\n" +
        "Source: https://unpkg.com/jszip@3.10.1/dist/jszip.min.js\n",
      "vendor/jszip.min.js": "x", // .min name -> library regardless of content
    }),
    [
      [
        "vendor/jszip.min.js",
        "https://unpkg.com/jszip@3.10.1/dist/jszip.min.js",
      ],
    ]
  );
});

// A single "path : url" line, library file.
test("parses the one-line path : url form (library file)", () => {
  assert.deepEqual(
    entries({
      "VENDORS.md":
        "vendor/jspdf.umd.js : https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.js\n",
      "vendor/jspdf.umd.js": LIB,
    }),
    [
      [
        "vendor/jspdf.umd.js",
        "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.js",
      ],
    ]
  );
});

// The "path:" header + "- URL:" detail line, with a .min library file.
test("parses the path: + URL: form (library file)", () => {
  assert.deepEqual(
    entries({
      "VENDOR.md":
        "# Third-party\n\nvendor/list.min.js:\n - Version: 2.3.1\n" +
        " - URL: https://cdn.jsdelivr.net/npm/list.js@2.3.1/dist/list.min.js\n",
      "vendor/list.min.js": "x",
    }),
    [
      [
        "vendor/list.min.js",
        "https://cdn.jsdelivr.net/npm/list.js@2.3.1/dist/list.min.js",
      ],
    ]
  );
});

// "file:"/"source:" with Windows backslash path, .min library file.
test("parses file:/source: with backslash paths (library file)", () => {
  assert.deepEqual(
    entries({
      "VENDORS.md":
        "file: vendor\\lib\\foo.min.js\n" +
        "source: https://unpkg.com/foo@1.0.0/dist/foo.min.js\n",
      "vendor/lib/foo.min.js": "x",
    }),
    [["vendor/lib/foo.min.js", "https://unpkg.com/foo@1.0.0/dist/foo.min.js"]]
  );
});

// Present and missing library entries coexist (blank-line-separated blocks): the
// matched one is an entry, the absent one is a missing-vendor-file declaration.
test("present and missing library entries coexist", () => {
  const files = {
    "VENDORS.md":
      "file: vendor/here.min.js\nsource: https://unpkg.com/a@1.0.0/here.min.js\n\n" +
      "file: vendor/gone.min.js\nsource: https://unpkg.com/b@2.0.0/gone.min.js\n",
    "vendor/here.min.js": "x",
  };
  assert.deepEqual(entries(files), [
    ["vendor/here.min.js", "https://unpkg.com/a@1.0.0/here.min.js"],
  ]);
  assert.deepEqual(missing(files), [
    ["vendor/gone.min.js", "https://unpkg.com/b@2.0.0/gone.min.js"],
  ]);
});

// ---- invalid: yield no entry (Task 2 surfaces these as a parse-error finding) ----

// Pure prose with no file/URL declaration.
test("invalid: pure prose yields no entry", () => {
  const files = {
    "VENDOR.md": "We bundle a few libraries; see our docs for details.\n",
    "bg.js": "x",
  };
  assert.deepEqual(entries(files), []);
  assert.deepEqual(missing(files), []);
});

// A library file but the only URL is a bare repository (not a file): no source.
test("invalid: library file with only a repository URL (no file URL)", () => {
  const files = {
    "VENDOR.md":
      "## DOMPurify\n" +
      "- Included file: `vendor/purify.js`\n" +
      "- Upstream repository: https://github.com/cure53/DOMPurify\n",
    "vendor/purify.js": LIB,
  };
  assert.deepEqual(entries(files), []);
  assert.deepEqual(missing(files), []);
});

// A file Source URL but no library file in the block (only the add-on's own code).
test("invalid: file URL but no library file in the block", () => {
  const files = {
    "VENDOR.md":
      "## Helpers\n" +
      "- Source: https://unpkg.com/x@1.0.0/dist/x.js\n" +
      "- Used by `modules/own.js`\n",
    "modules/own.js": OWN,
  };
  assert.deepEqual(entries(files), []);
  assert.deepEqual(missing(files), []);
});

// A non-library file declared with file + URL: the library signal is the
// identifier, so a non-library local file is not a vendor entry.
test("invalid: a non-library file is not a vendor entry", () => {
  const files = {
    "VENDOR.md":
      "File: modules/own.js\nSource: https://unpkg.com/x@1.0.0/own.js\n",
    "modules/own.js": OWN,
  };
  assert.deepEqual(entries(files), []);
  assert.deepEqual(missing(files), []);
});

// A version token ("2.2.1") is loosely file-like but is not a filename, and is
// never mistaken for the entry path.
test("a version token is not mistaken for a file", () => {
  assert.deepEqual(
    entries({
      "VENDOR.md":
        "## ical\n- Version: 2.2.1\n" +
        "- Source: https://unpkg.com/ical.js@2.2.1/dist/ical.min.js\n" +
        "- Included file: `vendor/ical.min.js`\n",
      "vendor/ical.min.js": "x",
    }),
    [["vendor/ical.min.js", "https://unpkg.com/ical.js@2.2.1/dist/ical.min.js"]]
  );
});

// A missing declaration with no source URL is not a declaration at all.
test("missingVendorEntries ignores a declaration with no source URL", () => {
  assert.deepEqual(
    missing({ VENDOR: "File: vendor/ghost.min.js\n", "bg.js": "x" }),
    []
  );
});
