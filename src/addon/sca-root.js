// WHICH FOLDER IS THE SOURCE ROOT - settled once, before the archive is read.
//
// A source archive's root is the folder the build runs in: the one holding package.json and
// the lock the reviewer installs from. Everything downstream reads those from the TOP LEVEL
// of --sca-root and nowhere else (src/build/corpus.js, src/vendor/locks.js), which is what
// makes "the root" mean something. This decides which folder that is. It does not soften
// that rule - it runs before it.
//
// It exists because the root is NAMED by someone who has not looked inside yet. A source
// archive is extracted by the reader of the --llm-sca-review prompt, into a destination this
// tool worked out by path math alone, and an archive that carries its contents in one
// directory of its own leaves the build files one level below that destination. The review
// then reads a root holding nothing, reports a build it cannot reproduce, and never audits
// the dependency tree sitting just below it - a submission with critical advisories reviewed
// as though it declared none.
//
// DOWN ONLY. The folder ABOVE --sca-root is the reviewer's submission folder, holding the .xpi
// and the archive itself, and nothing there was submitted as source: a root found by stepping
// out of the one named is a root nobody pointed at. How FAR down is not fixed, because the
// number of directories an archive wraps its contents in is an accident of how it was packed -
// the walk follows a chain of single folders as far as it goes and stops at the first fork.
//
// Belongs here: which folder the review treats as --sca-root, and keeping
// --sca-exp-source inside it. Does NOT belong here: what is read once it is settled (the build
// corpus, the lock), the keyspace the source view is built in (scaViews in ./load.js), or
// how the root is reported (src/report/format.js).

import fs from "node:fs";
import path from "node:path";

import { relativeInside } from "./load.js";
import { PACKAGE_FILE } from "../vendor/package-file.js";
import { TREE_LOCKS } from "../vendor/locks.js";

/**
 * Whether `dir` holds a package file at its top level.
 * @param {string} dir
 * @returns {boolean}
 */
function hasPackageFile(dir) {
  return fs.existsSync(path.join(dir, PACKAGE_FILE));
}

/**
 * Whether `dir` holds one of the locks an installer reads (TREE_LOCKS), at its top level.
 * @param {string} dir
 * @returns {boolean}
 */
function hasLock(dir) {
  return TREE_LOCKS.some((lock) => fs.existsSync(path.join(dir, lock)));
}

/**
 * The folders directly inside `dir` that could hold a build.
 *
 * `node_modules` is left out because it is an installed tree rather than part of the source -
 * it is also the one folder that would offer hundreds of package files - and a dotfolder because
 * a build does not run from one. A symlink is not a folder here: `isDirectory()` and
 * `isSymbolicLink()` are exclusive (src/addon/load.js walks them as separate branches, and
 * says why following one could loop), which is also what keeps the walk below finite.
 * @param {string} dir  Absolute.
 * @returns {string[]}  Absolute paths, in the order the filesystem lists them.
 */
function subfolders(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Unreadable is not this function's error to raise: the run already validated the folder
    // (src/cli.js folderProblem), and the loader is about to read it and say so properly.
    return [];
  }
  return entries
    .filter(
      (e) =>
        e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")
    )
    .map((e) => path.join(dir, e.name));
}

/**
 * The folder below `root` that holds the build, or null where none can be named.
 *
 * Walks DOWN while there is exactly one way down, because a folder that holds nothing but
 * another folder is not a place a build could run - it is packaging, and how many layers of it
 * an archive carries is an accident of how it was made rather than anything about the
 * submission. A package file reached on the way ends the walk: that folder is the root.
 *
 * At the first fork the walk stops and sweeps THOSE siblings, and no deeper. A fork is the
 * archive's own shape - src beside docs beside tests - so a package file below one of them is a
 * package within the build rather than the build, and rooting there would review a dependency
 * as the submission.
 *
 * Finite by construction: every pass moves strictly deeper into a finite tree, and symlinks are
 * not folders here, so there is no cycle to fall into and no depth limit to invent.
 * @param {string} root  Absolute, and known not to hold a package file itself.
 * @returns {?string}
 */
function buildRootBelow(root) {
  let dir = root;
  for (;;) {
    const subs = subfolders(dir);
    if (subs.length !== 1) {
      // A fork, or nowhere left to go. One package file among them is the root, several are
      // decided by the lock beside it - that is the pair an install reads, and what tells a
      // wrapper from a `tools/` or `examples/` folder carrying a package file of its own. Anything
      // still ambiguous is not guessed at.
      const found = subs.filter(hasPackageFile);
      const narrowed = found.length > 1 ? found.filter(hasLock) : found;
      return narrowed.length === 1 ? narrowed[0] : null;
    }
    dir = subs[0];
    if (hasPackageFile(dir)) {
      return dir;
    }
  }
}

/**
 * Settle which folder this review treats as --sca-root, and --sca-exp-source with it.
 *
 * Returns the pair to use, corrected or not. The caller applies it wholesale rather than
 * reading the flags again, so `scaRoot` and `scaExpSource` can never be read from two
 * different answers.
 *
 * The root moves only when it holds no package file itself AND exactly one folder below it can be
 * meant (buildRootBelow walks that down). A lock is never required for the move, only ever
 * used to choose between several: a submission that forgot one is still re-rooted, so the
 * review reports the missing lock it has rather than the missing build it does not.
 *
 * CONTAINMENT IS NOT NEGOTIABLE, so it decides too. --sca-exp-source names a folder inside
 * the source root - enforced at the CLI (src/cli.js folderProblem) and again when the views
 * are built (scaRootRelative in ./load.js, which throws) - and a correction that put it
 * outside would swap a wrong root for a failed run. Where that is what the move would do,
 * there is no move. It is not re-derived: it is already absolute, and one inside the
 * candidate stays where it is.
 * @param {{scaRoot?: string, scaExpSource?: string}} opts  Absolute paths, as the CLI
 *   resolved them.
 * @returns {{scaRoot?: string, scaExpSource?: string, movedFrom: ?string}}
 *   The pair to review with. `movedFrom` is the root that was given when it was corrected,
 *   and null when it stands - the run narrates the difference rather than changing it silently.
 */
export function settleScaRoot(opts) {
  const given = {
    scaRoot: opts.scaRoot,
    scaExpSource: opts.scaExpSource,
    movedFrom: null,
  };
  if (!opts.scaRoot || hasPackageFile(opts.scaRoot)) {
    return given;
  }
  const scaRoot = buildRootBelow(opts.scaRoot);
  if (!scaRoot) {
    return given;
  }
  if (
    opts.scaExpSource &&
    relativeInside(opts.scaExpSource, scaRoot) === null
  ) {
    return given;
  }
  return { ...given, scaRoot, movedFrom: opts.scaRoot };
}
