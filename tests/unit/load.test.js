// Tests for add-on loading edge cases.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadAddon, loadScsAddon } from "../../src/addon/load.js";

// Loading a directory keeps a real .js file but drops a symlink pointing at it,
// preventing duplicate or out-of-tree content from entering addon.files.
test("directory load skips symlinks but keeps real files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-sym-"));
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    '{"manifest_version":3,"name":"x","version":"1"}'
  );
  fs.writeFileSync(path.join(dir, "real.js"), "browser.runtime.id;\n");
  fs.symlinkSync(path.join(dir, "real.js"), path.join(dir, "link.js"));

  const addon = loadAddon(dir);
  assert.ok(addon.files.has("real.js"), "real file is loaded");
  assert.ok(!addon.files.has("link.js"), "symlink is skipped");

  fs.rmSync(dir, { recursive: true, force: true });
});

// A source-code submission: the add-on code is at <root>/src, package.json/lock at
// the root. loadScsAddon partitions the src subtree (prefix stripped) and brings the
// root package.json along (for the dependency audit). The source corpus stays PURE -
// its own manifest.json is kept, never overwritten. The authoritative (shipped)
// manifest is the built XPI's, resolved separately into ctx.manifest (context.js);
// loadScsAddon does not touch the source manifest.
test("loadScsAddon partitions scsSource, keeps root package.json + the source's own manifest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-scs-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    '{"dependencies":{"left-pad":"1.3.0"}}'
  );
  const srcManifest =
    '{"manifest_version":3,"name":"FROM-SOURCE","version":"1"}';
  fs.writeFileSync(path.join(root, "src", "manifest.json"), srcManifest);
  fs.writeFileSync(
    path.join(root, "src", "background.js"),
    "browser.runtime.id;\n"
  );

  const addon = loadScsAddon(root, "src");

  assert.ok(addon.files.has("background.js"), "src file, prefix stripped");
  assert.ok(!addon.files.has("src/background.js"), "prefix not retained");
  assert.ok(addon.files.has("package.json"), "root package.json brought along");
  // Pure source: the source's own manifest.json is kept, not injected/overwritten.
  assert.equal(
    addon.manifest.name,
    "FROM-SOURCE",
    "source's own manifest kept"
  );
  assert.equal(addon.files.get("manifest.json").toString(), srcManifest);

  fs.rmSync(root, { recursive: true, force: true });
});
