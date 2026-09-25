// Tests for settling WHICH folder is the source root (src/addon/sca-root.js).
//
// The root is named by someone who has not looked inside the archive yet, so a root holding
// no package.json is a near miss to be corrected rather than a submission to reject. These
// pin how far that correction reaches, and - as much - where it stops.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { settleScaRoot } from "../../src/addon/sca-root.js";

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
  const out = settleScaRoot({ scaRoot: root });
  assert.equal(out.scaRoot, root);
  assert.equal(out.movedFrom, null);
});

// The case this exists for: an archive that carries its contents in a directory of its own.
// The lock is not required - a submission that forgot one is still re-rooted, so the review
// reports the missing lock it has rather than the missing build it does not.
test("a lone subfolder with a package.json becomes the root, lock or not", () => {
  for (const extra of [{}, { "wrap/package-lock.json": LOCK }]) {
    const root = tree({ "wrap/package.json": PKG, "README.md": "x", ...extra });
    const out = settleScaRoot({ scaRoot: root });
    assert.equal(out.scaRoot, path.join(root, "wrap"));
    assert.equal(out.movedFrom, root);
  }
});

// Two package.json files and no way to tell them apart is not a root anyone can pick, so nothing is
// picked: the review reads the folder it was given and the build checks report what is there.
test("two bare package.json files leave the root alone", () => {
  const root = tree({ "a/package.json": PKG, "b/package.json": PKG });
  assert.equal(settleScaRoot({ scaRoot: root }).movedFrom, null);
});

// The lock breaks the tie, because the root is where the install runs: a `tools/` or
// `examples/` folder carries a package.json of its own and never a lock for the whole tree.
test("the lock decides between several package.json files", () => {
  const root = tree({
    "wrap/package.json": PKG,
    "wrap/pnpm-lock.yaml": "lockfileVersion: '9.0'",
    "tools/package.json": PKG,
  });
  const out = settleScaRoot({ scaRoot: root });
  assert.equal(out.scaRoot, path.join(root, "wrap"));

  // ... and two that both carry one are ambiguous again.
  const two = tree({
    "a/package.json": PKG,
    "a/package-lock.json": LOCK,
    "b/package.json": PKG,
    "b/package-lock.json": LOCK,
  });
  assert.equal(settleScaRoot({ scaRoot: two }).movedFrom, null);
});

// node_modules holds a package.json per installed package - hundreds of candidates, none of them
// this submission - and a dotfolder is not where a build runs.
test("node_modules and dotfolders are not candidates", () => {
  const root = tree({
    "node_modules/left-pad/package.json": PKG,
    ".github/package.json": PKG,
  });
  assert.equal(settleScaRoot({ scaRoot: root }).movedFrom, null);
});

// How many directories an archive wraps its contents in is an accident of how it was packed,
// so the walk follows a chain of single folders as far as it goes. A folder holding nothing
// but another folder is packaging, not a place a build could run.
test("a chain of single folders is followed to the package.json", () => {
  const root = tree({ "a/b/c/package.json": PKG, "a/b/c/src/main.js": "" });
  const out = settleScaRoot({ scaRoot: root });
  assert.equal(out.scaRoot, path.join(root, "a", "b", "c"));
  assert.equal(out.movedFrom, root);
});

// The walk ends the moment it reaches one, rather than descending past it into a package the
// build installs.
test("a package.json on the way down ends the walk", () => {
  const root = tree({ "a/package.json": PKG, "a/b/package.json": PKG });
  assert.equal(settleScaRoot({ scaRoot: root }).scaRoot, path.join(root, "a"));
});

// A fork is the archive's own shape - src beside docs beside tests - so the sweep reads those
// siblings and no deeper: a package.json below one of them is a package WITHIN the build, and
// rooting there would review a dependency as the submission.
test("the walk stops at the first fork, and sweeps no deeper", () => {
  const root = tree({ "docs/readme.md": "x", "src/inner/package.json": PKG });
  assert.equal(settleScaRoot({ scaRoot: root }).movedFrom, null);

  // At that fork the sweep is the rule already pinned above: one package.json among the siblings
  // wins, wherever the fork turned up.
  const wins = tree({ "a/docs/readme.md": "x", "a/src/package.json": PKG });
  assert.equal(
    settleScaRoot({ scaRoot: wins }).scaRoot,
    path.join(wins, "a", "src")
  );
});

// A chain that leads nowhere leaves the root exactly as it was given.
test("a chain with no package.json anywhere leaves the root alone", () => {
  const root = tree({ "a/b/c/main.js": "" });
  assert.equal(settleScaRoot({ scaRoot: root }).movedFrom, null);
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
    settleScaRoot({ scaRoot: root }).scaRoot,
    path.join(root, "wrap", "inner")
  );
});

// Containment is an invariant of every source code review, so it decides here too: a move
// that put --sca-exp-source outside the root would trade a wrong root for a failed run.
test("the move is abandoned where the Experiment folder would fall outside", () => {
  const root = tree({
    "wrap/package.json": PKG,
    "wrap/addon/x.js": "",
    "other/y.js": "",
  });
  const wrap = path.join(root, "wrap");

  // Inside the candidate: it moves, and the flag is untouched.
  const inside = settleScaRoot({
    scaRoot: root,
    scaExpSource: path.join(wrap, "addon"),
  });
  assert.equal(inside.scaRoot, wrap);
  assert.equal(inside.scaExpSource, path.join(wrap, "addon"));

  // The candidate ITSELF: the root contains itself.
  assert.equal(
    settleScaRoot({ scaRoot: root, scaExpSource: wrap }).scaRoot,
    wrap
  );

  // A sibling of the candidate, and the old root itself: both outside, so neither moves.
  for (const scaExpSource of [path.join(root, "other"), root]) {
    assert.equal(
      settleScaRoot({ scaRoot: root, scaExpSource }).movedFrom,
      null
    );
  }

  // Nothing to contain: the move stands on the root alone.
  assert.equal(settleScaRoot({ scaRoot: root }).scaRoot, wrap);
});

// An XPI review names no root at all, and nothing here may invent one.
test("no --sca-root is nothing to settle", () => {
  assert.deepEqual(settleScaRoot({}), {
    scaRoot: undefined,
    scaExpSource: undefined,
    movedFrom: null,
  });
});
