// Tests for settling WHICH folder is the package root (src/addon/package-root.js).
//
// The root is named by someone who has not looked inside the archive yet, so a root holding
// no package.json is a near miss to be corrected rather than a submission to reject. These
// pin how far that correction reaches, and - as much - where it stops.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ScaFoldersRejected,
  approveScaFolders,
  settlePackageRoot,
} from "../../src/addon/package-root.js";

/** A tree from a {relative path: contents} map, returning its absolute root. */
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wl-scaroot-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

const PKG = '{"name":"x","version":"1.0.0"}';
const LOCK = '{"lockfileVersion":3}';

// The overwhelmingly common case, and the one every existing fixture is: the folder named
// holds the build files, so there is nothing to settle and nothing is touched.
test("a root that holds a package.json is left alone", () => {
  const root = tree({ "package.json": PKG, "sub/package.json": PKG });
  const out = settlePackageRoot(root, {});
  assert.equal(out.folders.packageRoot, root);
  assert.equal(out.moved, null);
});

// The case this exists for: an archive that carries its contents in a directory of its own.
// The lock is not required - a submission that forgot one is still re-rooted, so the review
// reports the missing lock it has rather than the missing build it does not.
test("a lone subfolder with a package.json becomes the root, lock or not", () => {
  for (const extra of [{}, { "wrap/package-lock.json": LOCK }]) {
    const root = tree({ "wrap/package.json": PKG, "README.md": "x", ...extra });
    const out = settlePackageRoot(root, {});
    assert.equal(out.folders.packageRoot, path.join(root, "wrap"));
    assert.deepEqual(out.moved, { from: "", to: "wrap" });
  }
});

// Two package.json files and no way to tell them apart is not a root anyone can pick, so nothing is
// picked: the review reads the folder it was given and the build checks report what is there.
test("two bare package.json files leave the root alone", () => {
  const root = tree({ "a/package.json": PKG, "b/package.json": PKG });
  assert.equal(settlePackageRoot(root, {}).moved, null);
});

// The lock breaks the tie, because the root is where the install runs: a `tools/` or
// `examples/` folder carries a package.json of its own and never a lock for the whole tree.
test("the lock decides between several package.json files", () => {
  const root = tree({
    "wrap/package.json": PKG,
    "wrap/pnpm-lock.yaml": "lockfileVersion: '9.0'",
    "tools/package.json": PKG,
  });
  const out = settlePackageRoot(root, {});
  assert.equal(out.folders.packageRoot, path.join(root, "wrap"));

  // ... and two that both carry one are ambiguous again.
  const two = tree({
    "a/package.json": PKG,
    "a/package-lock.json": LOCK,
    "b/package.json": PKG,
    "b/package-lock.json": LOCK,
  });
  assert.equal(settlePackageRoot(two, {}).moved, null);
});

// node_modules holds a package.json per installed package - hundreds of candidates, none of them
// this submission - and a dotfolder is not where a build runs.
test("node_modules and dotfolders are not candidates", () => {
  const root = tree({
    "node_modules/left-pad/package.json": PKG,
    ".github/package.json": PKG,
  });
  assert.equal(settlePackageRoot(root, {}).moved, null);
});

// How many directories an archive wraps its contents in is an accident of how it was packed,
// so the walk follows a chain of single folders as far as it goes. A folder holding nothing
// but another folder is packaging, not a place a build could run.
test("a chain of single folders is followed to the package.json", () => {
  const root = tree({ "a/b/c/package.json": PKG, "a/b/c/src/main.js": "" });
  const out = settlePackageRoot(root, {});
  assert.equal(out.folders.packageRoot, path.join(root, "a", "b", "c"));
  assert.deepEqual(out.moved, { from: "", to: path.join("a", "b", "c") });
});

// The walk ends the moment it reaches one, rather than descending past it into a package the
// build installs.
test("a package.json on the way down ends the walk", () => {
  const root = tree({ "a/package.json": PKG, "a/b/package.json": PKG });
  assert.equal(
    settlePackageRoot(root, {}).folders.packageRoot,
    path.join(root, "a")
  );
});

// A fork is the archive's own shape - src beside docs beside tests - so the sweep reads those
// siblings and no deeper: a package.json below one of them is a package WITHIN the build, and
// rooting there would review a dependency as the submission.
test("the walk stops at the first fork, and sweeps no deeper", () => {
  const root = tree({ "docs/readme.md": "x", "src/inner/package.json": PKG });
  assert.equal(settlePackageRoot(root, {}).moved, null);

  // At that fork the sweep is the rule already pinned above: one package.json among the siblings
  // wins, wherever the fork turned up.
  const wins = tree({ "a/docs/readme.md": "x", "a/src/package.json": PKG });
  assert.equal(
    settlePackageRoot(wins, {}).folders.packageRoot,
    path.join(wins, "a", "src")
  );
});

// A chain that leads nowhere leaves the root exactly as it was given.
test("a chain with no package.json anywhere leaves the root alone", () => {
  const root = tree({ "a/b/c/main.js": "" });
  assert.equal(settlePackageRoot(root, {}).moved, null);
});

// The exclusions hold at every level, not only the first: a wrapper that ships an installed
// tree beside it is still the one way down.
test("node_modules and dotfolders are skipped at every level", () => {
  const root = tree({
    "wrap/node_modules/left-pad/package.json": PKG,
    "wrap/.github/workflows/ci.yml": "",
    "wrap/inner/package.json": PKG,
  });
  assert.equal(
    settlePackageRoot(root, {}).folders.packageRoot,
    path.join(root, "wrap", "inner")
  );
});

// A symbolic link is not a folder of the submission: the walk never follows one, so the
// root cannot settle on a package.json the link reaches outside the archive.
test("a lone symlinked subfolder is not followed out of the root", () => {
  const outside = tree({ "package.json": PKG });
  const root = tree({ "README.md": "x" });
  fs.symlinkSync(outside, path.join(root, "wrap"), "dir");
  const out = settlePackageRoot(root, {});
  assert.equal(out.folders.packageRoot, root);
  assert.equal(out.moved, null);
});

// The Experiment folder may lie anywhere in the extracted archive, so it does not hold the
// package root in place: the package root moves wherever its package file is, beside the
// Experiment folder or above it. A folder found inside the Experiment folder is no build
// folder, so the folder given stands, as where none is found.
test("the Experiment folder does not hold the move", () => {
  const root = tree({
    "wrap/package.json": PKG,
    "wrap/addon/x.js": "",
    "other/y.js": "",
  });
  const wrap = path.join(root, "wrap");
  // Inside the new package root: it moves, and the flag is untouched.
  const inside = settlePackageRoot(root, {
    experiments: path.join("wrap", "addon"),
  });
  assert.equal(inside.folders.packageRoot, wrap);
  assert.equal(inside.folders.experiments, path.join(wrap, "addon"));
  // Beside it: it moves all the same.
  const beside = settlePackageRoot(root, { experiments: "other" });
  assert.equal(beside.folders.packageRoot, wrap);
  // Holding it: the folder found is the Experiment's, so the folder given stands.
  const held = settlePackageRoot(root, { experiments: "wrap" });
  assert.equal(held.folders.packageRoot, root);
  assert.equal(held.moved, null);
  // Nothing to place: the move stands on the package root alone.
  assert.equal(settlePackageRoot(root, {}).folders.packageRoot, wrap);
});

// "approve the sca folders" holds the named folders against the source before anything is
// copied: each must lie inside it and be a folder. What is wrong is thrown, which folder and
// why, and each caller says it in its own words.
test("an sca folder outside the source, or no folder, is rejected", () => {
  const root = tree({ "package.json": PKG, "README.md": "x" });
  const outside = tree({ "x.js": "" });
  const rejected = (named, which, problem) =>
    assert.throws(
      () => approveScaFolders(root, named),
      (err) =>
        err instanceof ScaFoldersRejected &&
        err.which === which &&
        err.problem === problem,
      JSON.stringify(named)
    );
  rejected({ packageRoot: outside }, "packageRoot", "outside");
  rejected({ experiments: path.join(root, "..") }, "experiments", "outside");
  rejected(
    { packageRoot: path.join(root, "README.md") },
    "packageRoot",
    "not-folder"
  );
  rejected(
    { experiments: path.join(root, "gone") },
    "experiments",
    "not-folder"
  );
  // What is approved comes back relative to the source, so it names the same folder in a
  // copy of it.
  fs.mkdirSync(path.join(root, "exp"));
  fs.writeFileSync(path.join(root, "exp", "api.js"), "1;");
  assert.deepEqual(
    approveScaFolders(root, { experiments: path.join(root, "exp") }),
    {
      experiments: "exp",
    }
  );
  assert.deepEqual(approveScaFolders(root, {}), {});
});

// The Experiment folder names the Experiment implementation, a folder of its own, so it can
// neither BE the source nor hold the package root: scaViews partitions on a prefix, the prefix
// for the source itself is the empty string, and nothing is under nothing - so the privileged
// code would be reviewed as WebExtension code, which is the one thing the folder exists to
// prevent. Asked before the settle, so the settle cannot move the root into it.
test("an Experiment folder that IS the source, or holds the package root, is rejected", () => {
  const root = tree({ "package.json": PKG, "exp/api.js": "1;" });
  const rejected = (source, named, problem) =>
    assert.throws(
      () => approveScaFolders(source, named),
      (err) =>
        err instanceof ScaFoldersRejected &&
        err.which === "experiments" &&
        err.problem === problem,
      JSON.stringify(named)
    );
  rejected(root, { experiments: root }, "is-source");
  // Written with a trailing separator, which resolves to the same folder - the test is on
  // the folder it really is, so a second spelling cannot answer differently.
  rejected(root, { experiments: root + path.sep }, "is-source");
  // A folder holding the package-root hint takes the WebExtension source out with it.
  const wrapped = tree({ "pkg/package.json": PKG });
  rejected(
    wrapped,
    {
      packageRoot: path.join(wrapped, "pkg"),
      experiments: path.join(wrapped, "pkg"),
    },
    "holds-root"
  );
  // A real subfolder is what the folder is for, and still settles.
  const ok = settlePackageRoot(
    root,
    approveScaFolders(root, { experiments: path.join(root, "exp") })
  );
  assert.equal(ok.folders.packageRoot, root);
  assert.equal(ok.moved, null);
});

// An Experiment folder with no file in it excludes nothing from the WebExtension checks, so a
// mistyped or still empty folder is refused rather than taken as a folder that excludes
// nothing. A file reached only through a link does not count, since the load skips links.
test("an Experiment folder that holds no file is rejected", () => {
  const root = tree({ "package.json": PKG, "deep/a/b/api.js": "1;" });
  fs.mkdirSync(path.join(root, "empty"));
  fs.mkdirSync(path.join(root, "nested/only/folders"), { recursive: true });
  fs.mkdirSync(path.join(root, "linked"));
  fs.symlinkSync(
    path.join(root, "deep", "a", "b", "api.js"),
    path.join(root, "linked", "api.js")
  );
  for (const name of ["empty", "nested", "linked"]) {
    assert.throws(
      () => approveScaFolders(root, { experiments: path.join(root, name) }),
      (err) =>
        err instanceof ScaFoldersRejected &&
        err.which === "experiments" &&
        err.problem === "empty",
      name
    );
  }
  // A file anywhere below it is enough.
  assert.deepEqual(
    approveScaFolders(root, { experiments: path.join(root, "deep") }),
    { experiments: "deep" }
  );
});

// A package root the walk would find inside the Experiment folder the reviewer named is not
// taken: the folder given stands, as where the walk finds none, and the review reports what
// that folder lacks.
test("a package root found inside the Experiment folder is not taken", () => {
  const root = tree({ "inner/package.json": PKG, "inner/lock.json": LOCK });
  const out = settlePackageRoot(root, { experiments: "inner" });
  assert.equal(out.folders.packageRoot, root);
  assert.equal(out.moved, null);
  // An Experiment folder inside the found package root still lets it move.
  const fits = tree({ "inner/package.json": PKG, "inner/exp/api.js": "1;" });
  const moved = settlePackageRoot(fits, {
    experiments: path.join("inner", "exp"),
  });
  assert.equal(moved.folders.packageRoot, path.join(fits, "inner"));
  assert.deepEqual(moved.moved, { from: "", to: "inner" });
});
