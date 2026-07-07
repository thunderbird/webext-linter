// Tests for add-on loading edge cases.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadAddon,
  loadScsAddon,
  loadScsBuildFiles,
  scsRootRelative,
  scsExpSourceRelative,
} from "../../src/addon/load.js";

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
  // The skip is collected as a notice (not printed) for the pipeline to narrate.
  assert.deepEqual(addon.skipped, ["Skipping symlink (not packaged): link.js"]);

  fs.rmSync(dir, { recursive: true, force: true });
});

// A symlink named node_modules is still a committed dependency tree: it is recorded
// (so committed-node-modules fires) but never followed - its target is not read.
test("directory load records a symlinked node_modules without following it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-nmsym-"));
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    '{"manifest_version":3,"name":"x","version":"1"}'
  );
  // Point node_modules at an out-of-tree target: it must be recorded, never followed.
  fs.symlinkSync(
    path.join(os.tmpdir(), "wrr-nm-target"),
    path.join(dir, "node_modules"),
    "dir"
  );

  const addon = loadAddon(dir);
  assert.deepEqual(addon.nodeModules, ["node_modules"]);
  // A node_modules symlink is a recorded dependency tree, not a skipped-entry notice.
  assert.deepEqual(addon.skipped, []);
  assert.ok(
    ![...addon.files.keys()].some((k) => k.startsWith("node_modules")),
    "symlink target not read"
  );

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

  // The pipeline reads the --scs-root archive ONCE and shares it with both the review
  // loader and the build-corpus loader, so the tree is never walked twice.
  const archive = loadAddon(root);
  const addon = loadScsAddon(archive, "src", root);

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

  // --scs-source accepts an absolute path too: it resolves to the same subtree.
  const abs = loadScsAddon(archive, path.join(root, "src"), root);
  assert.deepEqual(
    [...abs.files.keys()].sort(),
    [...addon.files.keys()].sort()
  );

  fs.rmSync(root, { recursive: true, force: true });
});

// loadScsBuildFiles is the COMPLEMENT of loadScsAddon: the archive minus the review
// source (scsSource), the Experiment source (scsExpSource), node_modules, and
// dotfiles/dotfolders - the build scripts / config the review otherwise drops. Keys
// keep their real archive paths (unstripped); the root package.json/lock stay, and a
// plain .npmrc is kept (the one dotfile exception the build-tooling checks read).
test("loadScsBuildFiles returns the build files outside scsSource + scsExpSource", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-scsb-"));
  fs.mkdirSync(path.join(root, "src", "experiment"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"));
  // node_modules is skipped at LOAD (never read) and reported: a nested one (any depth)
  // and one INSIDE the review source are both recorded, neither read.
  fs.mkdirSync(path.join(root, "sub", "node_modules", "dep"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(root, "src", "node_modules"), { recursive: true });
  // Dotfolders (.github CI) are excluded; a plain .npmrc is KEPT; a .npmrc buried in a
  // dotfolder is still excluded.
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
  fs.writeFileSync(path.join(root, "webpack.config.js"), "module.exports={}");
  fs.writeFileSync(path.join(root, "scripts", "build.sh"), "echo build");
  fs.writeFileSync(path.join(root, ".npmrc"), "registry=https://evil");
  fs.writeFileSync(path.join(root, ".github", ".npmrc"), "registry=https://x");
  fs.writeFileSync(
    path.join(root, ".github", "workflows", "ci.yml"),
    "on: push"
  );
  fs.writeFileSync(path.join(root, "src", "background.js"), "1;\n");
  fs.writeFileSync(path.join(root, "src", "experiment", "exp.js"), "1;\n");
  fs.writeFileSync(
    path.join(root, "sub", "node_modules", "dep", "webpack.config.js"),
    ""
  );
  fs.writeFileSync(path.join(root, "src", "node_modules", "pkg.js"), "1;\n");

  const { files, nodeModules } = loadScsBuildFiles(
    loadAddon(root),
    "src",
    root,
    "src/experiment"
  );
  assert.deepEqual([...files.keys()].sort(), [
    ".npmrc",
    "package-lock.json",
    "package.json",
    "scripts/build.sh",
    "webpack.config.js",
  ]);
  // The review source (src/*), the Experiment source, node_modules at any depth, and
  // dotfiles/dotfolders are excluded; a plain .npmrc is kept; kept keys are unstripped.
  assert.ok(files.has(".npmrc"));
  assert.ok(!files.has("background.js") && !files.has("src/background.js"));
  assert.ok(!files.has("src/experiment/exp.js"));
  assert.ok(!files.has("sub/node_modules/dep/webpack.config.js"));
  assert.ok(!files.has(".github/.npmrc")); // a .npmrc buried in a dotfolder is dropped
  assert.ok(!files.has(".github/workflows/ci.yml"));
  // node_modules is never read (no node_modules file in the corpus) but IS reported for
  // the committed-node-modules check - anywhere, including inside the review source.
  assert.deepEqual(nodeModules.sort(), [
    "src/node_modules",
    "sub/node_modules",
  ]);
  assert.ok(![...files.keys()].some((k) => k.includes("node_modules")));

  fs.rmSync(root, { recursive: true, force: true });
});

// A flat layout: scsSource IS the archive root, so there is no source subtree to
// exclude - every file becomes a build candidate, and selectBuildCorpus (called by
// analyzeBuild) still traces the build off the root package.json.
test("loadScsBuildFiles with scsSource at the archive root keeps the root as build candidates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-scsb0-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    '{"scripts":{"build":"x"}}'
  );
  fs.writeFileSync(path.join(root, "background.js"), "1;\n");
  const { files } = loadScsBuildFiles(loadAddon(root), ".", root, "");
  assert.ok(
    files.has("package.json"),
    "the root package.json is a build candidate"
  );
  assert.ok(
    files.has("background.js"),
    "root files are build candidates in a flat layout"
  );
  fs.rmSync(root, { recursive: true, force: true });
});

// Both SCS source flags resolve relative to --scs-root, or accept an absolute path
// (made relative to the root). An absolute path outside the root is rejected.
test("scsRootRelative resolves relative + absolute paths, rejects escapes", () => {
  const root = "/tmp/wrr-root";
  assert.equal(scsRootRelative("addon", root), "addon");
  assert.equal(scsRootRelative("./addon/", root), "addon"); // normalized
  assert.equal(scsRootRelative(`${root}/addon`, root), "addon"); // absolute -> relative
  assert.equal(scsRootRelative(root, root), ""); // the root itself
  assert.throws(
    () => scsRootRelative("/elsewhere/x", root),
    /outside --scs-root/
  );
});

// --scs-exp-source shares the --scs-root base and is re-based to a source-relative
// path (the --scs-source prefix stripped) for scsWebExtensionFiles. It must be within
// --scs-source; the OLD source-relative form (no scsSource prefix) is now an error.
test("scsExpSourceRelative re-bases the scsRoot-relative exp path onto the source", () => {
  const root = "/tmp/wrr-root";
  assert.equal(
    scsExpSourceRelative("addon/experiment-api", "addon", root),
    "experiment-api"
  );
  assert.equal(
    scsExpSourceRelative("addon/experiment-api/x", "addon", root),
    "experiment-api/x"
  );
  assert.equal(
    scsExpSourceRelative(`${root}/addon/experiment-api`, "addon", root),
    "experiment-api"
  ); // absolute exp path
  assert.equal(scsExpSourceRelative(undefined, "addon", root), ""); // unset
  assert.throws(
    () => scsExpSourceRelative("experiment-api", "addon", root),
    /within --scs-source/
  ); // the old source-relative form
  assert.throws(
    () => scsExpSourceRelative("other/exp", "addon", root),
    /within --scs-source/
  );
});
