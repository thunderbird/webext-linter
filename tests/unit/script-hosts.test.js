// Unit tests for script-hosts: mapping each script to the host-page directories
// Gecko uses to resolve a relative tabs.executeScript/insertCSS/removeCSS {file}
// path, and resolving such a path against them.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  scriptHostDirs,
  resolvePageRelative,
} from "../../src/checks/lib/script-hosts.js";
import { collectJsSources } from "../../src/addon/sources.js";

// Build a review ctx from a {path: content} map + manifest object.
function ctxFrom(files, manifest) {
  const addon = {
    files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
    manifest,
  };
  return { addon, jsSources: collectJsSources(addon) };
}

const dirs = (map, file) => [...(map.get(file) ?? [])];

// background.page is an HTML page in a subdirectory: it hosts its <script src>
// child at the page's own directory, and that base flows to the modules the
// child imports (document.baseURI is the page's, not the imported module's). So
// a page-relative `file` resolves under the page dir - the isabelle shape.
test("background.page in a subdir hosts its scripts (and imports) at the page dir", () => {
  const manifest = {
    manifest_version: 2,
    background: { page: "src/background.html" },
  };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "src/background.html": `<script type="module" src="background.js"></script>`,
    "src/background.js": `import "./helper.js";\nbrowser.tabs.executeScript(id, { file: "message-unescape.js" });`,
    "src/helper.js": `export const x = 1;`,
    "src/message-unescape.js": ``,
  };
  const ctx = ctxFrom(files, manifest);
  const hd = scriptHostDirs(ctx);
  assert.deepEqual(dirs(hd, "src/background.js"), ["src"]);
  assert.deepEqual(dirs(hd, "src/helper.js"), ["src"]); // imported module inherits the page dir
  assert.equal(
    resolvePageRelative(
      ctx.addon.files,
      hd,
      "src/background.js",
      "message-unescape.js"
    ),
    "src/message-unescape.js"
  );
});

// background.scripts has no HTML page; Gecko generates one at the extension ROOT,
// so the script's base is root even when the script itself lives in a subdir -
// the page-vs-script distinction. "inject.js" resolves at the root, NOT next to
// the script.
test("background.scripts get the generated root page's base", () => {
  const manifest = {
    manifest_version: 3,
    background: { scripts: ["src/bg.js"] },
  };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "src/bg.js": `console.log(1);`,
    "inject.js": ``, // at root
    "src/inject.js": ``, // next to the script
  };
  const ctx = ctxFrom(files, manifest);
  const hd = scriptHostDirs(ctx);
  const f = ctx.addon.files;
  assert.deepEqual(dirs(hd, "src/bg.js"), [""]); // root
  assert.equal(
    resolvePageRelative(f, hd, "src/bg.js", "inject.js"),
    "inject.js"
  );
});

// A script no declared page loads has no known host context, so a page-relative
// path falls back to root-relative resolution - behavior never regresses below
// the old root-only rule.
test("a script with no declared host page falls back to root-relative", () => {
  const manifest = { manifest_version: 2 };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "lib/util.js": ``,
    "lib/x.js": ``,
    "x.js": ``,
  };
  const ctx = ctxFrom(files, manifest);
  const hd = scriptHostDirs(ctx);
  const f = ctx.addon.files;
  assert.equal(hd.get("lib/util.js"), undefined); // no host page
  assert.equal(resolvePageRelative(f, hd, "lib/util.js", "x.js"), "x.js"); // root
  assert.equal(
    resolvePageRelative(f, hd, "lib/util.js", "lib/x.js"),
    "lib/x.js"
  );
});

// A popup page hosts the script it loads at the popup's directory.
test("an action popup page hosts its script at the popup dir", () => {
  const manifest = {
    manifest_version: 3,
    action: { default_popup: "ui/popup.html" },
  };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "ui/popup.html": `<script src="popup.js"></script>`,
    "ui/popup.js": `console.log(1);`,
  };
  const hd = scriptHostDirs(ctxFrom(files, manifest));
  assert.deepEqual(dirs(hd, "ui/popup.js"), ["ui"]);
});

// A page that is NOT in any manifest key - here opened at runtime via
// tabs.create - is still a host context, because being included by an HTML page
// (not how the page is opened) is what lets a script run in it. So its script's
// page-relative executeScript path resolves under the page dir, not root.
test("a dynamically-opened page (no manifest key) still hosts its script", () => {
  const manifest = { manifest_version: 2, background: { scripts: ["bg.js"] } };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "bg.js": `browser.tabs.create({ url: "dash/dashboard.html" });`,
    "dash/dashboard.html": `<script src="dashboard.js"></script>`,
    "dash/dashboard.js": `browser.tabs.executeScript(id, { file: "inject.js" });`,
    "dash/inject.js": ``,
  };
  const ctx = ctxFrom(files, manifest);
  const hd = scriptHostDirs(ctx);
  assert.deepEqual(dirs(hd, "dash/dashboard.js"), ["dash"]);
  assert.equal(
    resolvePageRelative(ctx.addon.files, hd, "dash/dashboard.js", "inject.js"),
    "dash/inject.js"
  );
});
