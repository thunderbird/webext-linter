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

// Stand-in content for a bundled third-party library file; OWN is the add-on's
// own code. (These VENDOR-resolution tests key off declared paths, not the
// classifier, so the content is just realistic.)
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

// Regression (cardbook): several declarations in ONE block with NO blank lines
// between them - each a `bundled file`/`source file` pair - must keep their OWN
// url. The old block-pooling stamped the block's FIRST file URL onto every file
// (so jsep/zip wrongly "did not match" d3-dsv's url). The library-name and licence
// bullets carry no file/url token and are inert.
test("an unindented list with no blank lines pairs each file with its own url", () => {
  const files = {
    "VENDOR.md":
      "Third-Party Libraries\n" +
      "  - [d3-dsv]\n" +
      "    - bundled file : vendor/d3-dsv/d3-dsv.js\n" +
      "    - source file : https://unpkg.com/d3-dsv@3.0.1/dist/d3-dsv.js\n" +
      "  - [jsep]\n" +
      "    - bundled file : vendor/jsep/jsep.min.js\n" +
      "    - source file : https://cdn.jsdelivr.net/npm/jsep@1.4.0/dist/jsep.min.js\n" +
      "  - [zip]\n" +
      "    - bundled file : vendor/zip/zip-full.js\n" +
      "    - source file : https://raw.githubusercontent.com/gildas-lormeau/zip.js/abc/dist/zip-full.js\n",
    "vendor/d3-dsv/d3-dsv.js": LIB,
    "vendor/jsep/jsep.min.js": LIB,
    "vendor/zip/zip-full.js": LIB,
  };
  assert.deepEqual(entries(files), [
    [
      "vendor/d3-dsv/d3-dsv.js",
      "https://unpkg.com/d3-dsv@3.0.1/dist/d3-dsv.js",
    ],
    [
      "vendor/jsep/jsep.min.js",
      "https://cdn.jsdelivr.net/npm/jsep@1.4.0/dist/jsep.min.js",
    ],
    [
      "vendor/zip/zip-full.js",
      "https://raw.githubusercontent.com/gildas-lormeau/zip.js/abc/dist/zip-full.js",
    ],
  ]);
});

// Regression (cardbook, the real shape): some declarations name a file the library
// heuristic does NOT recognize (a small readable .mjs). We TRUST the declaration, so
// that file is its own entry with its own source - and, crucially, it does not leak
// its URL onto the NEXT file (the off-by-one). Every declared file keeps its own URL.
test("every declared file is an entry with its own url (no shift)", () => {
  const files = {
    "VENDOR.md":
      "  - [a]\n" +
      "    - bundled file : vendor/a.min.js\n" +
      "    - source file : https://cdn.example.com/a/a.min.js\n" +
      "  - [mod]\n" +
      "    - bundled file : vendor/mod.mjs\n" +
      "    - source file : https://cdn.example.com/mod/mod.mjs\n" +
      "  - [b]\n" +
      "    - bundled file : vendor/b.min.js\n" +
      "    - source file : https://cdn.example.com/b/b.min.js\n",
    "vendor/a.min.js": "x", // .min name -> library-ish
    "vendor/mod.mjs": OWN, // not library-recognized, but declared -> trusted
    "vendor/b.min.js": "x",
  };
  assert.deepEqual(entries(files), [
    ["vendor/a.min.js", "https://cdn.example.com/a/a.min.js"],
    ["vendor/mod.mjs", "https://cdn.example.com/mod/mod.mjs"],
    ["vendor/b.min.js", "https://cdn.example.com/b/b.min.js"],
  ]);
});

// Order-agnostic: a declaration whose source URL PRECEDES its file (with a bare
// repo URL in between, which is ignored) still pairs correctly - even sharing a
// block with the next declaration and no blank line between them.
test("source-before-file declarations in one block pair correctly", () => {
  const files = {
    "VENDOR.md":
      "- Source: https://registry.npmjs.org/dompurify/-/dompurify-3.4.7.tgz\n" +
      "- Upstream repository: https://github.com/cure53/DOMPurify\n" +
      "- Included file: `vendor/purify.js`\n" +
      "- Source: https://unpkg.com/marked@9.0.0/marked.min.js\n" +
      "- Included file: `vendor/marked.min.js`\n",
    "vendor/purify.js": LIB,
    "vendor/marked.min.js": LIB,
  };
  assert.deepEqual(entries(files), [
    [
      "vendor/purify.js",
      "https://registry.npmjs.org/dompurify/-/dompurify-3.4.7.tgz",
    ],
    ["vendor/marked.min.js", "https://unpkg.com/marked@9.0.0/marked.min.js"],
  ]);
});

// Two bundled files declared under ONE source: the PARSER reports both faithfully
// (each pairs with that URL); resolveVendor then flags it as vendor-ambiguous-source
// and pulls them out (see vendor-resolve.test.js) - a file source can verify only one
// file, so a multi-file source must be declared as a folder.
test("two files under one source are both parsed (resolve flags ambiguous)", () => {
  const files = {
    "VENDOR.md":
      "## Bundle\n" +
      "- bundled file: `vendor/a.min.js`\n" +
      "- bundled file: `vendor/b.min.js`\n" +
      "- source: https://unpkg.com/bundle@1.0.0/dist/bundle.js\n",
    "vendor/a.min.js": LIB,
    "vendor/b.min.js": LIB,
  };
  assert.deepEqual(entries(files), [
    ["vendor/a.min.js", "https://unpkg.com/bundle@1.0.0/dist/bundle.js"],
    ["vendor/b.min.js", "https://unpkg.com/bundle@1.0.0/dist/bundle.js"],
  ]);
});

// A `bundled directory` token (a directory prefix of packaged files) paired with a
// github tree URL is a FOLDER entry (kind:"folder"); the directory itself is the
// path. Verification (verifyFolder) later checks every file under it.
test("a bundled directory + a github tree URL is a folder entry", () => {
  const TREE =
    "https://github.com/o/r/tree/0123456789012345678901234567890123456789/dist/lib";
  const m = parseVendorManifest(
    fakeAddon({
      "VENDOR.md":
        "- bundled directory : vendor/lib\n" + `- source : ${TREE}\n`,
      "vendor/lib/a.js": LIB,
      "vendor/lib/b.js": LIB,
    })
  );
  assert.deepEqual(
    m.map((e) => [e.path, e.kind, e.sourceUrl]),
    [["vendor/lib", "folder", TREE]]
  );
});

// ---- trusted: a declared file + a source URL is an entry, even when the library
// heuristic would not recognize the file (we ride along; verification decides) ----

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

// A packaged file paired with a source URL is an entry even when the file is not
// library-recognized (here the add-on's own `modules/own.js`): we trust the
// declaration and let verification decide. (Old policy: this yielded no entry.)
test("trusted: a declared own-file paired with a source URL is an entry", () => {
  const files = {
    "VENDOR.md":
      "## Helpers\n" +
      "- Source: https://unpkg.com/x@1.0.0/dist/x.js\n" +
      "- Used by `modules/own.js`\n",
    "modules/own.js": OWN,
  };
  assert.deepEqual(entries(files), [
    ["modules/own.js", "https://unpkg.com/x@1.0.0/dist/x.js"],
  ]);
  assert.deepEqual(missing(files), []);
});

// File + URL where the file is the add-on's own code: still trusted (ride along),
// so it is an entry and verification (not the parser) decides if it matches.
test("trusted: a non-library file with file + URL is an entry", () => {
  const files = {
    "VENDOR.md":
      "File: modules/own.js\nSource: https://unpkg.com/x@1.0.0/own.js\n",
    "modules/own.js": OWN,
  };
  assert.deepEqual(entries(files), [
    ["modules/own.js", "https://unpkg.com/x@1.0.0/own.js"],
  ]);
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
