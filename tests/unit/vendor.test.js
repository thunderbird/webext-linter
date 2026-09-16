// Unit tests for the deterministic VENDOR parser (parseVendorManifest /
// missingVendorEntries): the shapes it accepts, and - just as much - the shapes it
// refuses rather than guesses at.
//
// A declaration is a packaged file paired with a source URL that points to a FILE,
// where the developer MARKED the two as a pair: a colon, a key, or Markdown link
// syntax. Adjacency marks nothing. A block is one declaration and may not contain a
// blank line.
//
// The file is read whole: any fault - half a declaration, two sources, a source URL
// no declaration claimed - discards ALL of it, so the developer is told the file is
// unparseable instead of the review running on a manifest that is quietly missing
// entries. The "pinned failures" section below is that half of the contract, and it
// is the half that matters: a wrong entry that looks right is worse than none.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseVendorManifest,
  missingVendorEntries,
  vendorFileNames,
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

// ---- valid: the Markdown block style (the case that drove this) ----
// A `## <library>` block lists the package name, a Source: file URL, an Upstream
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

// A declared path is a path from the package ROOT. A bare filename means that file
// at the root, and the parser does not go hunting for it by basename elsewhere - so
// an add-on that ships `lib/js/popper.min.js` and declares `popper.min.js` is told
// the file is not there, rather than the declaration being quietly rebound.
//
// Every spelling reports it the same way, because the parse never consults the
// submission: a miss cannot depend on which spelling the developer chose.
test("a bare filename means the package ROOT, in every spelling", () => {
  const U = "https://unpkg.com/popper@2.11.8/dist/popper.min.js";
  const shipped = { "lib/js/popper.min.js": LIB };
  for (const text of [
    `file: popper.min.js\nsource: ${U}\n`,
    `popper.min.js: ${U}\n`,
    `popper.min.js ${U}\n`,
    `[popper.min.js](${U})\n`,
    `popper.min.js:\n  source: ${U}\n`,
  ]) {
    assert.deepEqual(entries({ "VENDOR.md": text, ...shipped }), [], text);
    assert.deepEqual(
      missing({ "VENDOR.md": text, ...shipped }),
      [["popper.min.js", U]],
      text
    );
  }
  // Declared at its real path, it resolves.
  assert.deepEqual(
    entries({
      "VENDOR.md": `file: lib/js/popper.min.js\nsource: ${U}\n`,
      ...shipped,
    }),
    [["lib/js/popper.min.js", U]]
  );
});

// Several declarations in ONE block with NO blank lines
// between them - each a `bundled file`/`source file` pair - must keep their OWN
// url. Pooling a block's URLs would stamp its FIRST onto every file, so jsep and zip
// would each "not match" d3-dsv's url. The library-name and licence
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

// Some declarations name a file the library
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

// A source may PRECEDE its file inside one block - the two are keyed, so neither
// has to come first. The bare repository URL in between is not a source and is
// ignored, and it does not count against the file either.
test("a keyed source before its keyed file pairs correctly", () => {
  const files = {
    "VENDOR.md":
      "- Source: https://registry.npmjs.org/alpha/-/alpha-3.4.7.tgz\n" +
      "- Upstream repository: https://github.com/example/alpha\n" +
      "- Included file: `vendor/alpha.js`\n",
    "vendor/alpha.js": LIB,
  };
  assert.deepEqual(entries(files), [
    ["vendor/alpha.js", "https://registry.npmjs.org/alpha/-/alpha-3.4.7.tgz"],
  ]);
});

// TWO declarations crammed into ONE block, with no blank line and no indent to tell
// them apart, is not two declarations - it is a block naming two sources, and which
// file belongs to which is a guess, and guessing by position is not reading. Separate them
// with a blank line (or a heading) and both parse.
test("pinned failure: two sources in one block discards the file", () => {
  const crammed = {
    "VENDOR.md":
      "- Source: https://registry.npmjs.org/alpha/-/alpha-3.4.7.tgz\n" +
      "- Included file: `vendor/alpha.js`\n" +
      "- Source: https://unpkg.com/beta@9.0.0/beta.min.js\n" +
      "- Included file: `vendor/beta.min.js`\n",
    "vendor/alpha.js": LIB,
    "vendor/beta.min.js": LIB,
  };
  assert.deepEqual(entries(crammed), []);
  // The same two declarations, separated, are read in full.
  const separated = {
    ...crammed,
    "VENDOR.md":
      "- Source: https://registry.npmjs.org/alpha/-/alpha-3.4.7.tgz\n" +
      "- Included file: `vendor/alpha.js`\n" +
      "\n" +
      "- Source: https://unpkg.com/beta@9.0.0/beta.min.js\n" +
      "- Included file: `vendor/beta.min.js`\n",
  };
  assert.deepEqual(entries(separated), [
    ["vendor/alpha.js", "https://registry.npmjs.org/alpha/-/alpha-3.4.7.tgz"],
    ["vendor/beta.min.js", "https://unpkg.com/beta@9.0.0/beta.min.js"],
  ]);
});

// One source covering several files is written as one block per file, each citing
// that URL. The PARSER reports both faithfully; resolveVendor then flags it as
// vendor-ambiguous-source and pulls them out (see vendor-resolve.test.js) - a file
// source can verify only one file, so a multi-file source must be a folder.
test("two blocks citing one source are both parsed (resolve flags ambiguous)", () => {
  const files = {
    "VENDOR.md":
      "## Bundle\n" +
      "- bundled file: `vendor/a.min.js`\n" +
      "- source: https://unpkg.com/bundle@1.0.0/dist/bundle.js\n" +
      "\n" +
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

// A block declares ONE item. Two file keys, or a file key beside a "path:" header,
// is the developer saying two things in one place. Keeping whichever came last would
// drop the other with no fault raised.
test("pinned failure: a block may not declare two items", () => {
  const files = {
    "vendor/a.min.js": LIB,
    "vendor/b.min.js": LIB,
  };
  const U = "https://unpkg.com/bundle@1.0.0/dist/bundle.js";
  for (const text of [
    `- bundled file: \`vendor/a.min.js\`\n- bundled file: \`vendor/b.min.js\`\n- source: ${U}\n`,
    `vendor/a.min.js:\nvendor/b.min.js:\n  source: ${U}\n`,
  ]) {
    assert.deepEqual(entries({ "VENDOR.md": text, ...files }), [], text);
  }
});

// The exception, and the standard shape it comes from: a block heads itself with the
// library's name, which often looks like a filename - with or without a trailing
// colon. That line is a LABEL. When exactly one file key sits beside it, the KEY
// defines the file and the two are one declaration, not two competing ones.
test("a label line beside one file key is one declaration, the key wins", () => {
  const U = "https://unpkg.com/bundle@1.0.0/dist/bundle.js";
  const files = { "vendor/a.min.js": LIB, "vendor/b.min.js": LIB };
  // The label happens to name a DIFFERENT packaged file, so it is visible which one
  // won: the key, every time.
  for (const label of ["vendor/a.min.js:", "vendor/a.min.js"]) {
    assert.deepEqual(
      entries({
        "VENDOR.md": `${label}\n  file: vendor/b.min.js\n  source: ${U}\n`,
        ...files,
      }),
      [["vendor/b.min.js", U]],
      label
    );
  }
  // The label is not a licence to declare twice: a second file key is still two
  // items in one block.
  assert.deepEqual(
    entries({
      "VENDOR.md":
        `vendor/a.min.js:\n  file: vendor/a.min.js\n` +
        `  file: vendor/b.min.js\n  source: ${U}\n`,
      ...files,
    }),
    []
  );
});

// One file, one source. Declaring a path twice with two different URLs is a
// contradiction the developer must settle - keeping either one would leave the other
// unverified with nothing said about it. Repeating the SAME source is not a
// contradiction, so it collapses to one entry.
test("a path declared with two different sources refuses the file", () => {
  const A = "https://unpkg.com/x@1.0.0/dist/a.js";
  const B = "https://unpkg.com/y@2.0.0/dist/a.js";
  const files = { "lib/a.js": LIB };
  assert.deepEqual(
    entries({
      "VENDOR.md": `file: lib/a.js\nsource: ${A}\n\nfile: lib/a.js\nsource: ${B}\n`,
      ...files,
    }),
    []
  );
  // Same source twice: one origin stated twice, nothing to resolve.
  assert.deepEqual(
    entries({
      "VENDOR.md": `file: lib/a.js\nsource: ${A}\n\nfile: lib/a.js\nsource: ${A}\n`,
      ...files,
    }),
    [["lib/a.js", A]]
  );
});

// ---- the bare label ----

// A block may head itself with the library's name and no colon. That label is the
// file when the block names no other, and the lines under it must be key:value
// pairs - so it never takes its source from a URL on a line of its own.
test("a bare label on the first line is the block's file", () => {
  const files = {
    "vendor/purify.min.js": LIB,
    "vendor/lighterhtml.min.js": LIB,
  };
  assert.deepEqual(
    entries({
      "VENDOR.md":
        "vendor/purify.min.js\n" +
        " - Version: 3.4.11\n" +
        " - URL: https://cdn.jsdelivr.net/npm/dompurify@3.4.11/dist/purify.min.js\n" +
        "\n" +
        "vendor/lighterhtml.min.js\n" +
        " - Version: 4.2.0\n" +
        " - URL: https://cdn.jsdelivr.net/npm/lighterhtml@4.2.0/min.js\n",
      ...files,
    }),
    [
      [
        "vendor/purify.min.js",
        "https://cdn.jsdelivr.net/npm/dompurify@3.4.11/dist/purify.min.js",
      ],
      [
        "vendor/lighterhtml.min.js",
        "https://cdn.jsdelivr.net/npm/lighterhtml@4.2.0/min.js",
      ],
    ]
  );
});

// A label promises key:value lines beneath it, so a URL standing on its own line
// never pairs with it - the trailing colon decides nothing either way. The bare-URL
// fallback survives only where the file came from a KEY, which promised nothing.
test("pinned failure: a labelled block does not pair with a bare URL line", () => {
  const U = "https://cdn.jsdelivr.net/npm/jquery@3.6.0/dist/jquery.min.js";
  const files = { "lib/a.min.js": LIB };
  for (const label of ["lib/a.min.js", "lib/a.min.js:"]) {
    assert.deepEqual(
      entries({ "VENDOR.md": `${label}\n${U}\n`, ...files }),
      [],
      label
    );
  }
  // Named by a key instead: nothing was promised, so the fallback applies.
  assert.deepEqual(
    entries({ "VENDOR.md": `- file: lib/a.min.js\n${U}\n`, ...files }),
    [["lib/a.min.js", U]]
  );
});

// ONLY the first line. Elsewhere a lone path is prose - a consumer list names files
// the library is used BY, and reading those as declarations would declare the
// add-on's own modules third-party code.
test("pinned failure: a lone path below the first line is prose", () => {
  const U = "https://unpkg.com/alpha@1.0.0/dist/alpha.min.js";
  assert.deepEqual(
    entries({
      "VENDOR.md":
        `- Source: ${U}\n- Included file: \`lib/a.min.js\`\n` +
        "- Runtime consumers:\n  bg.js\n",
      "lib/a.min.js": LIB,
      "bg.js": OWN,
    }),
    [["lib/a.min.js", U]]
  );
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

// A path inside a SENTENCE is a sentence. "Used by `modules/own.js`" names a
// consumer of the library, not the vendored file - pulling the path out of prose
// would declare the add-on's own module third-party code. Nothing
// marks it as the pair of that source, so the block is half a declaration and the
// file is discarded.
test("pinned failure: a path named in prose is not a declaration", () => {
  const files = {
    "VENDOR.md":
      "## Helpers\n" +
      "- Source: https://unpkg.com/alpha@1.0.0/dist/alpha.js\n" +
      "- Used by `modules/own.js`\n",
    "modules/own.js": OWN,
  };
  assert.deepEqual(entries(files), []);
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

// ---- the one-line spellings ----

// A path and a URL become a pair through a colon, a space, or Markdown link syntax.
// Matched decoration comes off either side, and only the first two tokens are read -
// a trailing note is prose about the declaration, not part of it.
test("the one-line spellings all read the same declaration", () => {
  const U = "https://unpkg.com/alpha@1.0.0/dist/alpha.min.js";
  for (const line of [
    `lib/alpha.min.js: ${U}`,
    `lib/alpha.min.js  :  ${U}`,
    `lib/alpha.min.js ${U}`,
    `[lib/alpha.min.js](${U})`,
    `[lib/alpha.min.js](<${U}>)`,
    // A trailing note is prose about the declaration in EVERY spelling - the link
    // form must not require the link to be the whole line, or a note silently
    // yields nothing at all.
    `[lib/alpha.min.js](${U}) (unmodified)`,
    `[lib/alpha.min.js](${U}), built from Release 1.0.0`,
    `lib/alpha.min.js: <${U}>.`,
    `\`lib/alpha.min.js\`: ${U}`,
    `**lib/alpha.min.js**: ${U}`,
    `[lib/alpha.min.js]: ${U}`,
    `[lib/alpha.min.js] ${U}`,
    `<lib/alpha.min.js> ${U}`,
    `lib/alpha.min.js ${U} (unmodified)`,
  ]) {
    assert.deepEqual(
      entries({ "VENDOR.md": `${line}\n`, "lib/alpha.min.js": LIB }),
      [["lib/alpha.min.js", U]],
      line
    );
  }
});

// A bold key may carry its colon inside the markers or outside; both read alike.
test("a bold key reads with the colon inside or outside the markers", () => {
  const U = "https://unpkg.com/alpha@1.0.0/dist/alpha.min.js";
  for (const key of [
    "**File:** lib/alpha.min.js",
    "**File**: lib/alpha.min.js",
  ]) {
    assert.deepEqual(
      entries({
        "VENDOR.md": `${key}\n**Source**: ${U}\n`,
        "lib/alpha.min.js": LIB,
      }),
      [["lib/alpha.min.js", U]],
      key
    );
  }
});

// ---- what the file may and may not carry ----

// A leading BOM is how the file was SAVED, not part of what it says. It has to come
// off before the character rule below, since U+FEFF is itself a format character -
// otherwise every file a Windows editor wrote would be refused.
test("a leading BOM is not content", () => {
  const U = "https://unpkg.com/alpha@1.0.0/dist/alpha.min.js";
  const body = `- File: lib/alpha.min.js\n- Source: ${U}\n`;
  const files = { "lib/alpha.min.js": LIB };
  const BOM = "\u{FEFF}";
  assert.deepEqual(entries({ "VENDOR.md": body, ...files }), [
    ["lib/alpha.min.js", U],
  ]);
  assert.deepEqual(entries({ "VENDOR.md": `${BOM}${body}`, ...files }), [
    ["lib/alpha.min.js", U],
  ]);
  // Anywhere else it is not a BOM, it is a zero-width no-break space in the text.
  assert.deepEqual(entries({ "VENDOR.md": `${body}${BOM}`, ...files }), []);
});

// A plain list of files and URLs has no use for control or format characters. Tab,
// CR and LF are the only three that belong in a text file; the rest are invisible or
// are instructions to a terminal - an escape sequence can repaint the report around a
// finding, a bidi override can make a path read as something it is not. The file is
// not the text it appears to be, so none of it is read.
test("a control or format character refuses the file", () => {
  const U = "https://unpkg.com/alpha@1.0.0/dist/alpha.min.js";
  const files = { "lib/alpha.min.js": LIB };
  const good = `- File: lib/alpha.min.js\n- Source: ${U}\n`;
  for (const ch of [
    "\u{1B}", // escape - repaints the terminal
    "\u{0}", // NUL
    "\u{8}", // backspace
    "\u{C}", // form feed
    "\u{202E}", // right-to-left override
    "\u{200B}", // zero-width space
  ]) {
    assert.deepEqual(
      entries({ "VENDOR.md": good + ch, ...files }),
      [],
      JSON.stringify(ch)
    );
  }
  // The escape must not survive into a source URL either - that is the shape that
  // erases the line above the finding in the report.
  assert.deepEqual(
    entries({
      "VENDOR.md": `- File: lib/alpha.min.js\n- Source: https://x/\u{1B}[2Ka.js\n`,
      ...files,
    }),
    []
  );
  // Tab, CR and LF are ordinary.
  assert.deepEqual(
    entries({
      "VENDOR.md": `- File: lib/alpha.min.js\r\n\t- Source: ${U}\r\n`,
      ...files,
    }),
    [["lib/alpha.min.js", U]]
  );
});

// One declaration does not run to a hundred lines. Past that the block is not a
// declaration with notes under it - and reading it as one lets a single block hold
// enough one-line declarations to overflow the stack.
test("a block longer than a hundred lines is refused", () => {
  const U = "https://unpkg.com/alpha@1.0.0/dist/alpha.min.js";
  const files = { "lib/alpha.min.js": LIB };
  const line = `lib/alpha.min.js: ${U}\n`;
  assert.deepEqual(entries({ "VENDOR.md": line.repeat(100), ...files }), [
    ["lib/alpha.min.js", U],
  ]);
  assert.deepEqual(entries({ "VENDOR.md": line.repeat(101), ...files }), []);
});

// ---- decoration and normalization ----

// A trailing slash spells a directory, it does not name a different one. Every
// consumer prefix-matches with `<path>/`, so the slash comes off once, here, rather
// than being stripped again by each of them.
test("a folder resolves however its path is spelled", () => {
  const TREE =
    "https://github.com/o/r/tree/0123456789012345678901234567890123456789/lib";
  const files = { "lib/vendor/a.js": LIB, "lib/vendor/b.js": LIB };
  for (const spelling of [
    "lib/vendor",
    "lib/vendor/",
    "./lib/vendor/",
    "lib\\vendor\\",
  ]) {
    const m = parseVendorManifest(
      fakeAddon({
        "VENDOR.md": `- Folder: ${spelling}\n- Source: ${TREE}\n`,
        ...files,
      })
    );
    assert.deepEqual(
      m.map((e) => [e.path, e.kind]),
      [["lib/vendor", "folder"]],
      spelling
    );
  }
});

// Decoration comes off in matched pairs, and the KEY is undecorated like every other
// token - so all six pairs read alike rather than the two a pattern could describe
// inline. A key wearing decoration must not kill the declaration silently.
test("a key reads the same however it is decorated", () => {
  const U = "https://unpkg.com/alpha@1.0.0/dist/alpha.min.js";
  const files = { "lib/alpha.min.js": LIB };
  for (const [k, v] of [
    ["File", "Source"],
    ["`File`", "`Source`"],
    ["**File**", "**Source**"],
    ["[File]", "[Source]"],
    ['"File"', '"Source"'],
    ["<File>", "<Source>"],
  ]) {
    assert.deepEqual(
      entries({
        "VENDOR.md": `- ${k}: lib/alpha.min.js\n- ${v}: ${U}\n`,
        ...files,
      }),
      [["lib/alpha.min.js", U]],
      k
    );
  }
});

// Nested bold is the one decoration that can repeat - the other pairs' inner classes
// exclude their own closer. Every layer comes off, at any depth.
test("nested bold decoration comes off at any depth", () => {
  const U = "https://unpkg.com/alpha@1.0.0/dist/alpha.min.js";
  const files = { "lib/alpha.min.js": LIB };
  for (const d of [1, 2, 5, 20]) {
    const wrap = "*".repeat(2 * d);
    assert.deepEqual(
      entries({
        "VENDOR.md": `${wrap}lib/alpha.min.js${wrap}: ${U}\n`,
        ...files,
      }),
      [["lib/alpha.min.js", U]],
      `depth ${d}`
    );
  }
});

// ---- pinned failures ----
//
// Each of these is a VENDOR file the grammar refuses. Refusing is the POINT: the
// developer is told the file could not be read, instead of the review running on a
// manifest that is quietly missing entries or pairing the wrong two things. A test
// here failing because something now parses is not automatically progress - check
// first that what it parsed is what the developer meant.

// A refusal has two observable halves - no entries AND no missing records. Pinning
// only the first would let a future change start emitting half-read declarations out
// of a file the parser refused, with nothing to notice.
const NOTHING = (text, extra = {}) => {
  const files = { "VENDOR.md": text, "lib/alpha.min.js": LIB, ...extra };
  assert.deepEqual(missing(files), [], `${text} (missing)`);
  return entries(files);
};

const CDN = "https://unpkg.com/alpha@1.0.0/dist/alpha.min.js";

// A block is one declaration and may not contain a blank line. Fields written as
// separate paragraphs are separate blocks, so each holds half a declaration.
test("pinned failure: a blank line splits a declaration in half", () => {
  assert.deepEqual(
    NOTHING(`**Source**: ${CDN}\n\n**File**: lib/alpha.min.js\n`),
    []
  );
});

// Half a declaration, either half.
test("pinned failure: a file with no source, or a source with no file", () => {
  assert.deepEqual(NOTHING("file: lib/alpha.min.js\n"), []);
  assert.deepEqual(NOTHING(`source: ${CDN}\n`), []);
});

// A table is not a supported shape. It reads as prose, and the URL it carries is then
// unclaimed, which discards the file rather than leaving it half read.
test("pinned failure: a Markdown table is not a declaration", () => {
  assert.deepEqual(
    NOTHING(
      "| File | Version | Source |\n" +
        "| --- | --- | --- |\n" +
        `| \`lib/alpha.min.js\` | 1.0.0 | ${CDN} |\n`
    ),
    []
  );
});

// A repository link is not a source, even when the repo's own name ends in ".js" -
// the link text then looks exactly like a path.
test("pinned failure: a repository link is not a source", () => {
  assert.deepEqual(
    NOTHING("[example/alpha.js](https://github.com/example/alpha.js)\n"),
    []
  );
});

// A path standing on its own line marks nothing. Bold is decoration, not a pairing.
test("pinned failure: a standalone path line is not a declaration", () => {
  assert.deepEqual(
    NOTHING(`**lib/alpha.min.js**\n\n- Direct link: ${CDN}\n`),
    []
  );
  assert.deepEqual(NOTHING(`lib/alpha.min.js\n${CDN}\n`), []);
});

// Decoration comes off in MATCHED pairs, so a leftover bracket means the token was
// never a path. It matters because the packaged-file lookup falls back to the
// basename and would otherwise resolve "[lib/alpha.min.js" to the real file.
test("pinned failure: an unmatched bracket is not a path", () => {
  assert.deepEqual(NOTHING(`[lib/alpha.min.js ${CDN}\n`), []);
});

// A block that says everything on one line and ALSO carries a keyed half is not
// saying one thing.
test("pinned failure: one-liners mixed with a keyed half", () => {
  assert.deepEqual(NOTHING(`lib/alpha.min.js: ${CDN}\nsource: ${CDN}\n`), []);
});

// The load-bearing rule: a source URL the parse recognised but no declaration
// claimed discards the WHOLE file. Without it the good declaration below would be
// reported as the complete manifest, and the library whose declaration could not be
// read would come back to the developer as an undeclared bundle - blaming them for
// something they did declare.
test("pinned failure: an unclaimed source URL discards the whole file", () => {
  const BETA = "https://unpkg.com/beta@2.0.0/dist/beta.min.js";
  const files = {
    "lib/alpha.min.js": LIB,
    "lib/beta.min.js": LIB,
  };
  // Alone, the first declaration parses.
  assert.deepEqual(
    entries({ "VENDOR.md": `lib/alpha.min.js: ${CDN}\n`, ...files }),
    [["lib/alpha.min.js", CDN]]
  );
  // With a second source the grammar could not attach to a file, nothing is kept.
  assert.deepEqual(
    entries({
      "VENDOR.md": `lib/alpha.min.js: ${CDN}\n\nsource: ${BETA}\n`,
      ...files,
    }),
    []
  );
});

// A bare repository link is NOT a source, so it is not something a declaration has
// to claim - a project citation beside a real declaration is harmless.
test("a repository citation does not discard the file", () => {
  assert.deepEqual(
    entries({
      "VENDOR.md":
        "## alpha\n" +
        "- Upstream repository: https://github.com/example/alpha\n" +
        `- Source: ${CDN}\n` +
        "- Included file: `lib/alpha.min.js`\n",
      "lib/alpha.min.js": LIB,
    }),
    [["lib/alpha.min.js", CDN]]
  );
});

// ---- more than one VENDOR file ----

// The manifest may be named VENDOR, VENDOR.md, VENDORS or VENDORS.md. Two of them is
// a contradiction the developer must settle: which one the review reads would
// otherwise depend on the order the archive lists its entries in. While it is
// ambiguous NEITHER is read, so nothing from either file is trusted.
test("more than one VENDOR file is not read at all", () => {
  const A = "https://unpkg.com/alpha@1.0.0/dist/alpha.min.js";
  const B = "https://cdn.jsdelivr.net/npm/alpha@2.0.0/dist/alpha.min.js";
  const one = {
    "VENDOR.md": `lib/alpha.min.js: ${A}\n`,
    "lib/alpha.min.js": LIB,
  };
  assert.deepEqual(entries(one), [["lib/alpha.min.js", A]]);
  assert.deepEqual(vendorFileNames(fakeAddon(one)), ["VENDOR.md"]);

  const two = { ...one, "VENDORS.md": `lib/alpha.min.js: ${B}\n` };
  assert.deepEqual(entries(two), []);
  assert.deepEqual(missing(two), []);
  // Sorted, so the answer does not depend on the order the archive lists them in.
  assert.deepEqual(vendorFileNames(fakeAddon(two)), [
    "VENDOR.md",
    "VENDORS.md",
  ]);
  assert.deepEqual(
    vendorFileNames(fakeAddon({ "VENDORS.md": "x", "VENDOR.md": "y" })),
    ["VENDOR.md", "VENDORS.md"]
  );
});
