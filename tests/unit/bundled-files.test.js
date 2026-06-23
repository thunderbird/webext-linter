// Unit tests for bundled-files: malformed-manifest robustness and the
// schema-directed / bridge "referenced file not bundled" detection.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import bundledFiles from "../../src/checks/rules/bundled-files.js";
import { loadSchemaFiles } from "../../src/schema/load.js";
import { buildSchemaIndex } from "../../src/schema/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureSchema = buildSchemaIndex(
  loadSchemaFiles(path.join(here, "..", "schema-fixture"))
);

function ctxWith(manifest, files = {}) {
  const map = new Map();
  for (const [k, v] of Object.entries(files)) {
    map.set(k, Buffer.from(v));
  }
  return { addon: { files: map, manifest }, jsSources: [] };
}

// Build a ctx whose single JS source carries `code`, with the fixture schema so
// derived loaders (messageDisplayScripts.register) are type-walked.
function ctxWithJs(code, files = {}) {
  const ctx = ctxWith({ manifest_version: 3 }, files);
  ctx.jsSources = [{ file: "bg.js", code, lineOffset: 0 }];
  ctx.schema = fixtureSchema;
  return ctx;
}

// Defensively handles manifests that violate the schema (non-array
// content_scripts, null entries, string js, string background) without
// crashing the rule.
test("does not throw on malformed content_scripts shapes", () => {
  // object instead of array, null entry, string-typed js array.
  for (const manifest of [
    { content_scripts: {} },
    { content_scripts: [null, { js: ["a.js"] }] },
    { content_scripts: [{ js: "content.js" }] },
    { background: "oops.js" },
  ]) {
    assert.doesNotThrow(() => bundledFiles.run(ctxWith(manifest)));
  }
});

// Guards against iterating a string js value character by character, which
// would wrongly report each letter as a missing file. Expects zero findings.
test("a string-typed `js` does not produce per-character findings", () => {
  // Malformed: js is a string, not an array. Must not iterate characters.
  const out = bundledFiles.run(ctxWith({ content_scripts: [{ js: "x.js" }] }));
  assert.equal(out.length, 0);
});

// With one referenced file present and one absent, exactly one finding is
// produced and it names the missing file, confirming present files are skipped.
test("flags a genuinely missing content script, not a present one", () => {
  const out = bundledFiles.run(
    ctxWith(
      { content_scripts: [{ js: ["present.js", "missing.js"] }] },
      { "present.js": "" }
    )
  );
  assert.equal(out.length, 1);
  assert.match(out[0].item, /missing\.js/);
});

// A missing manifest reference anchors at the manifest.json line that cites it
// (located by the quoted path), not just the file with no location.
test("anchors a missing manifest reference at its manifest.json line", () => {
  const manifestText = [
    "{",
    '  "manifest_version": 3,',
    '  "background": {',
    '    "page": "chrome/content/dummy.html"',
    "  }",
    "}",
  ].join("\n");
  const out = bundledFiles.run(
    ctxWith(
      {
        manifest_version: 3,
        background: { page: "chrome/content/dummy.html" },
      },
      { "manifest.json": manifestText }
    )
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "manifest.json");
  assert.equal(out[0].item, "chrome/content/dummy.html");
  assert.equal(out[0].loc.line, 4); // the line citing the path
});

// Without a packaged manifest.json text to locate the path in, the finding still
// names the file but carries no line (graceful fallback to the prior behavior).
test("missing manifest reference falls back to no line when manifest.json text is absent", () => {
  const out = bundledFiles.run(
    ctxWith({ content_scripts: [{ js: ["missing.js"] }] })
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "manifest.json");
  assert.equal(out[0].loc, null);
});

// A file registered via a schema-derived loader (messageDisplayScripts.register)
// must be bundled: an absent one is flagged, a present one is not.
test("flags a missing file referenced by a schema-derived loader", () => {
  const call = `messenger.messageDisplayScripts.register({ js: [{ file: "inject.js" }] });`;
  const missing = bundledFiles.run(ctxWithJs(call));
  assert.equal(missing.length, 1);
  assert.match(missing[0].item, /inject\.js/);

  const present = bundledFiles.run(ctxWithJs(call, { "inject.js": "" }));
  assert.equal(present.length, 0);
});

// Bridge loaders are checked too (scripting.executeScript), but only for
// packaged-file references: a remote or pseudo-scheme tabs.create url is not a
// missing file.
test("checks bridge loaders but ignores remote / scheme urls", () => {
  const inject = bundledFiles.run(
    ctxWithJs(`browser.scripting.executeScript({ files: ["content.js"] });`)
  );
  assert.equal(inject.length, 1);
  assert.match(inject[0].item, /content\.js/);

  const remote = bundledFiles.run(
    ctxWithJs(`
    browser.tabs.create({ url: "https://example.com/x" });
    browser.tabs.create({ url: "about:blank" });
  `)
  );
  assert.equal(remote.length, 0);
});

// A tabs.executeScript({file}) path is page-relative (Gecko): present-ness is
// checked against the calling script's host PAGE directory, not the extension
// root. background.js (loaded by src/background.html) injects a sibling file:
// present under the page dir -> no finding; absent there -> still flagged.
test("page-relative executeScript file is checked against the host page dir", () => {
  const manifest = {
    manifest_version: 2,
    background: { page: "src/background.html" },
  };
  const call = `browser.tabs.executeScript(id, { file: "message-unescape.js" });`;
  const page = `<script src="background.js"></script>`;

  const present = ctxWith(manifest, {
    "src/background.html": page,
    "src/background.js": call,
    "src/message-unescape.js": "",
  });
  present.jsSources = [
    { file: "src/background.js", code: call, lineOffset: 0 },
  ];
  assert.equal(bundledFiles.run(present).length, 0); // resolves to src/message-unescape.js

  const missing = ctxWith(manifest, {
    "src/background.html": page,
    "src/background.js": call,
  });
  missing.jsSources = [
    { file: "src/background.js", code: call, lineOffset: 0 },
  ];
  const out = bundledFiles.run(missing);
  assert.equal(out.length, 1);
  assert.match(out[0].item, /message-unescape\.js/);
});
