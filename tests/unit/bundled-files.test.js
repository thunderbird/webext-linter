// Unit tests for bundled-files: malformed-manifest robustness and the
// schema-directed / bridge "referenced file not bundled" detection.

import { test } from "node:test";
import { withManifest } from "./manifest-ctx.js";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import bundledFiles from "../../src/checks/rules/bundled-files.js";
import {
  resolveInDirStatus,
  resolveRefStatus,
} from "../../src/checks/lib/manifest-refs.js";
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
  return withManifest({ addon: { files: map, manifest }, jsSources: [] });
}

// Build a ctx whose single JS source carries `code`, with the fixture schema so
// derived loaders (messageDisplayScripts.register) are type-walked. bg.js is
// declared as a background script (and present in files) so it is LIVE - the
// loader-ref check skips scripts no entry point reaches.
function ctxWithJs(code, files = {}) {
  const ctx = ctxWith(
    { manifest_version: 3, background: { scripts: ["bg.js"] } },
    { "bg.js": code, ...files }
  );
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

// A tabs.executeScript({file}) path is resolved against the calling SCRIPT's own
// page (Gecko's "current page URL"), not the script's own directory. A
// background.scripts script's host page is the generated one at the extension
// ROOT, so a bare `file` resolves at root: present there -> no finding; only
// next to the script in a subdir -> flagged.
test("executeScript {file} is checked against the host page (root for background.scripts)", () => {
  const manifest = {
    manifest_version: 2,
    background: { scripts: ["src/background.js"] },
  };
  const call = `browser.tabs.executeScript(id, { file: "message-unescape.js" });`;

  const present = ctxWith(manifest, {
    "src/background.js": call,
    "message-unescape.js": "", // at root, where the host page resolves it
  });
  present.jsSources = [
    { file: "src/background.js", code: call, lineOffset: 0 },
  ];
  assert.equal(bundledFiles.run(present).length, 0); // resolves to root message-unescape.js

  const missing = ctxWith(manifest, {
    "src/background.js": call,
    "src/message-unescape.js": "", // only next to the script, not at root
  });
  missing.jsSources = [
    { file: "src/background.js", code: call, lineOffset: 0 },
  ];
  const out = bundledFiles.run(missing);
  assert.equal(out.length, 1);
  assert.match(out[0].item, /message-unescape\.js/);
});

// resolveInDirStatus distinguishes a bundled file (ok) from an absent one
// (missing) and from a ".." that climbs ABOVE the package root (escapes) - the
// signal the check uses to tell "not bundled" from "wrong path". A ".." that
// stays inside the package (a subdir going up to a sibling) is NOT an escape.
test("resolveInDirStatus reports ok / missing / escapes", () => {
  const files = new Map([
    ["skin/x.svg", Buffer.from("")],
    ["a/b.html", Buffer.from("")],
  ]);
  assert.deepEqual(resolveInDirStatus(files, null, "skin/x.svg"), {
    kind: "ok",
    key: "skin/x.svg",
  });
  assert.equal(
    resolveInDirStatus(files, null, "skin/none.svg").kind,
    "missing"
  );
  // root-relative leading ".." climbs above the root -> escapes
  assert.equal(
    resolveInDirStatus(files, null, "../skin/x.svg").kind,
    "escapes"
  );
  // from subdir "a", ".." pops "a" (stays in root) and resolves the sibling
  assert.deepEqual(resolveInDirStatus(files, "a", "../skin/x.svg"), {
    kind: "ok",
    key: "skin/x.svg",
  });
  // two levels up from a one-level dir escapes the root
  assert.equal(
    resolveInDirStatus(files, "a", "../../skin/x.svg").kind,
    "escapes"
  );
});

// resolveRefStatus derives the base directory from the referring file: a file at
// the root resolves a leading ".." as an escape, while a file in a subdirectory
// can reach a sibling tree.
test("resolveRefStatus resolves relative to the referring file's directory", () => {
  const files = new Map([["skin/x.svg", Buffer.from("")]]);
  assert.equal(
    resolveRefStatus(files, "bg.js", "../skin/x.svg").kind,
    "escapes"
  );
  assert.equal(
    resolveRefStatus(files, "ui/page.js", "../skin/x.svg").kind,
    "ok"
  );
  assert.equal(resolveRefStatus(files, null, "skin/x.svg").kind, "ok");
});

// A tabs.create({url}) is resolved against the calling SCRIPT's own directory, so
// "../target/target.html" from a script in a SUBDIRECTORY climbs out to a bundled
// sibling -> no finding (the thunderbird_conversations options/ case).
test("tabs.create {url} resolves against the script's dir (subdir climbs out)", () => {
  const manifest = {
    manifest_version: 2,
    options_ui: { page: "options/options.html" },
  };
  const call = `browser.tabs.create({ url: "../target/target.html" });`;
  const ctx = ctxWith(manifest, {
    "options/options.html": `<script src="options.js"></script>`,
    "options/options.js": call,
    "target/target.html": "",
  });
  ctx.jsSources = [{ file: "options/options.js", code: call, lineOffset: 0 }];
  assert.equal(bundledFiles.run(ctx).length, 0); // options/../target/target.html
});

// The gmail-conversation-view case: a background.scripts module in a subdirectory
// whose tabs.create url uses "..". The host page is the generated root page, so
// "../assistant/assistant.html" CLAMPS at root to the bundled assistant/ file.
test("background.scripts: a climbing tabs.create url clamps to a bundled file - not flagged", () => {
  const manifest = {
    manifest_version: 2,
    background: { scripts: ["background/bg.mjs"] },
  };
  const call = `browser.tabs.create({ url: "../assistant/assistant.html" });`;
  const ctx = ctxWith(manifest, {
    "background/bg.mjs": call,
    "assistant/assistant.html": "",
  });
  ctx.jsSources = [{ file: "background/bg.mjs", code: call, lineOffset: 0 }];
  assert.equal(bundledFiles.run(ctx).length, 0); // clamps to assistant/assistant.html
});

// A leading ".." is CLAMPED at the package root (Gecko's URL resolution can't
// climb above the origin), so "../target/target.html" from a root host page
// resolves to the bundled "target/target.html" - not flagged. Only a clamped
// path with no file behind it is flagged.
test("tabs.create {url} with a leading .. clamps at root", () => {
  const manifest = { manifest_version: 2, background: { scripts: ["bg.js"] } };

  const present = ctxWith(manifest, {
    "bg.js": `browser.tabs.create({ url: "../target/target.html" });`,
    "target/target.html": "",
  });
  present.jsSources = [
    {
      file: "bg.js",
      code: present.addon.files.get("bg.js").toString(),
      lineOffset: 0,
    },
  ];
  assert.equal(bundledFiles.run(present).length, 0); // clamps to target/target.html

  const missing = ctxWith(manifest, {
    "bg.js": `browser.tabs.create({ url: "../nope/missing.html" });`,
  });
  missing.jsSources = [
    {
      file: "bg.js",
      code: missing.addon.files.get("bg.js").toString(),
      lineOffset: 0,
    },
  ];
  const out = bundledFiles.run(missing);
  assert.equal(out.length, 1);
  assert.match(out[0].item, /missing\.html/);
});

// A script reached from no entry point never runs, so its loader references are
// not checked - that is an unused-files matter, not a missing bundled file. The
// identical call from a live (declared) script IS flagged. (expression-search-ng
// shape: an orphan page script whose tabs.create url never fires.)
test("loader refs in a non-live (orphan) script are skipped", () => {
  const call = `browser.tabs.create({ url: "missing.html" });`;

  // Orphan: no manifest entry and no page loads it -> not live -> skipped.
  const orphan = ctxWith({ manifest_version: 2 }, { "orphan.js": call });
  orphan.jsSources = [{ file: "orphan.js", code: call, lineOffset: 0 }];
  assert.equal(bundledFiles.run(orphan).length, 0);

  // Live: declared as the background script -> checked -> the missing url flagged.
  const live = ctxWith(
    { manifest_version: 2, background: { scripts: ["bg.js"] } },
    { "bg.js": call }
  );
  live.jsSources = [{ file: "bg.js", code: call, lineOffset: 0 }];
  const out = bundledFiles.run(live);
  assert.equal(out.length, 1);
  assert.match(out[0].item, /missing\.html/);
});
