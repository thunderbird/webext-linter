// Tests for add-on loading edge cases.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadAddon } from "../../src/addon/load.js";

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
