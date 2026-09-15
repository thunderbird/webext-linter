// Tests for add-on loading edge cases.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadAddon,
  loadScaAddon,
  selectScaBuildFiles,
  scaRootRelative,
  relativeInside,
  expExcludePrefix,
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

// A source code archive: the add-on code is at <root>/src, package.json/lock at
// the root. loadScaAddon partitions the src subtree (prefix stripped) and brings the
// root package.json along (for the dependency audit). The source's own manifest.json is
// parsed (not overwritten by a root one) and, like any manifest, lifted off the corpus
// onto the addon. The authoritative (shipped) manifest is the built XPI's, resolved
// separately into ctx.manifest (context.js); loadScaAddon does not touch the source manifest.
test("loadScaAddon partitions scaSource, keeps root package.json + parses the source's own manifest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-sca-"));
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

  // The pipeline reads the --sca-root archive ONCE and shares it with both the review
  // loader and the build-corpus loader, so the tree is never walked twice.
  const archive = loadAddon(root);
  const addon = loadScaAddon(archive, path.join(root, "src"), root);

  assert.ok(addon.files.has("background.js"), "src file, prefix stripped");
  assert.ok(!addon.files.has("src/background.js"), "prefix not retained");
  assert.ok(addon.files.has("package.json"), "root package.json brought along");
  // Pure source: the source's own manifest.json is parsed, not injected/overwritten.
  assert.equal(
    addon.manifest.name,
    "FROM-SOURCE",
    "source's own manifest kept"
  );
  // The manifest is lifted off the corpus into manifestText and the key dropped, so a
  // corpus lookup can never return the source's pre-build manifest.
  assert.ok(
    !addon.files.has("manifest.json"),
    "manifest.json removed from corpus"
  );
  assert.equal(addon.manifestText, srcManifest);

  fs.rmSync(root, { recursive: true, force: true });
});

// selectScaBuildFiles is the COMPLEMENT of loadScaAddon: the archive minus the review
// source (scaSource), the Experiment source (scaExpSource), node_modules, and
// dotfiles/dotfolders - the build scripts / config the review otherwise drops. Keys
// keep their real archive paths (unstripped); the root package.json/lock stay, and a
// plain .npmrc is kept (the one dotfile exception the build-tooling checks read).
test("selectScaBuildFiles returns the build files outside scaSource + scaExpSource", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-scab-"));
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

  const { files, nodeModules } = selectScaBuildFiles(
    loadAddon(root),
    path.join(root, "src"),
    root,
    path.join(root, "src", "experiment")
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

// A flat layout: scaSource IS the archive root, so there is no source subtree to
// exclude - every file becomes a build candidate, and selectBuildCorpus (called by
// analyzeBuild) still traces the build off the root package.json.
test("selectScaBuildFiles with scaSource at the archive root keeps the root as build candidates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-scab0-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    '{"scripts":{"build":"x"}}'
  );
  fs.writeFileSync(path.join(root, "background.js"), "1;\n");
  const { files } = selectScaBuildFiles(loadAddon(root), root, root, "");
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

// Both SCA source flags name a folder WITHIN --sca-root, and this is the ONE function that
// says WHERE inside - src/cli.js asks it before the filesystem, the loader asks it for the
// archive key, so the folder the guard finds is the folder the review reads. Both paths are
// absolute by now (the arg-array reader resolved them), so this asks about the filesystem
// rather than about spelling: a dot in a NAME survives because nothing here strips prefixes.
test("scaRootRelative keys a path inside the root, and refuses one outside", () => {
  const root = "/tmp/wrr-root";
  for (const [given, key] of [
    [`${root}/addon`, "addon"],
    [`${root}/a/b`, "a/b"],
    [`${root}/a/./b`, "a/b"],
    [`${root}//a`, "a"],
    [root, ""],
    [`${root}/`, ""],
    [`${root}/.src`, ".src"],
    [`${root}/..src`, "..src"],
    [`${root}/.hidden/x`, ".hidden/x"],
    // A backslash is a separator on Windows and an ordinary character in a POSIX file
    // name, so which it is here is the platform's answer, never ours to rewrite.
    [`${root}${path.sep}sub${path.sep}dir`, "sub/dir"],
  ]) {
    assert.equal(scaRootRelative(given, root), key, given);
  }
  // Outside the root is refused, however it got there: another tree, the root's own parent,
  // or a way back out of it. What it names is not part of the submission.
  for (const outside of [
    "/elsewhere/x",
    `${root}/../sibling`,
    path.dirname(root),
    `${root}/a/../..`,
  ]) {
    assert.throws(
      () => scaRootRelative(outside, root, "--sca-source"),
      /is not inside --sca-root/,
      outside
    );
    // The same question without the throw, which is what the CLI guard asks.
    assert.equal(relativeInside(outside, root), null, outside);
  }
});

// --sca-exp-source shares the --sca-root base. When it lives INSIDE the review source
// it is re-based to a source-relative path (the --sca-source prefix stripped) for
// scaWebExtensionFiles. When it lives anywhere ELSE under --sca-root it is outside the
// reviewed source set, so "" is returned (nothing to exclude here - the build-file
// selection excludes it via its scaRoot-relative path).
test("expExcludePrefix re-bases an in-source exp path, else returns ''", () => {
  const root = "/tmp/wrr-root";
  assert.equal(
    expExcludePrefix(
      path.join(root, "addon/experiment-api"),
      path.join(root, "addon"),
      root
    ),
    "experiment-api"
  );
  assert.equal(
    expExcludePrefix(
      path.join(root, "addon/experiment-api/x"),
      path.join(root, "addon"),
      root
    ),
    "experiment-api/x"
  );
  assert.equal(expExcludePrefix(undefined, path.join(root, "addon"), root), ""); // unset
  // Outside the review source (but under --sca-root): not in the reviewed set -> "".
  assert.equal(
    expExcludePrefix(
      path.join(root, "experiment"),
      path.join(root, "src"),
      root
    ),
    ""
  ); // sibling of the source
  assert.equal(
    expExcludePrefix(
      path.join(root, "experiment-api"),
      path.join(root, "addon"),
      root
    ),
    ""
  );
  assert.equal(
    expExcludePrefix(
      path.join(root, "other/exp"),
      path.join(root, "addon"),
      root
    ),
    ""
  );
});
