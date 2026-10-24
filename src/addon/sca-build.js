// WHICH FOLDER IS THE BUILD FOLDER - settled once, before the archive is read.
//
// The build folder is the folder of the extracted source archive the build runs in: the one
// holding package.json and the lock the reviewer installs from. Everything downstream reads
// those from the TOP LEVEL of --sca-build and nowhere else (src/vendor/locks.js, the
// package.json readers, through the build folder's view of the archive), which is what makes
// "the build folder" mean something. This decides which folder that is. It does not soften
// that rule - it runs before it. The review itself reads the whole extracted archive.
//
// It exists because the build folder is NAMED by someone who has not looked inside yet. A
// source archive is extracted by whoever prepares the review, into a destination this tool
// worked out by path math alone, and an archive that carries its contents in one directory of
// its own leaves the build files one level below that destination. The review then reads a
// build folder holding nothing, reports a build it cannot reproduce, and never audits the
// dependency tree sitting just below it - a submission with critical advisories reviewed as
// though it declared none.
//
// DOWN ONLY. The folder ABOVE --sca-extracted is the reviewer's submission folder, holding the
// .xpi and the archive itself, and nothing there was submitted as source: a build folder found
// by stepping out of the one named is one nobody pointed at. How FAR down is not fixed,
// because the number of directories an archive wraps its contents in is an accident of how it
// was packed - the walk follows a chain of single folders as far as it goes and stops at the
// first fork.
//
// Belongs here: which folder the review treats as --sca-build, and holding --sca-experiments
// to what it may name. Does NOT belong here: what is read once it is settled (the build files,
// the lock), the keyspace the source view is built in (scaViews in ./load.js), or how the
// folders are reported (src/report/format.js).

import fs from "node:fs";
import path from "node:path";

import { relativeInside } from "./load.js";
import { PACKAGE_FILE } from "../vendor/package-file.js";
import { TREE_LOCKS } from "../vendor/locks.js";
import { rethrowIfFatal } from "../lib/errors.js";

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
  } catch (err) {
    rethrowIfFatal(err);
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
 * submission. A package file reached on the way ends the walk: that is the build folder.
 *
 * At the first fork the walk stops and sweeps THOSE siblings, and no deeper. A fork is the
 * archive's own shape - src beside docs beside tests - so a package file below one of them is a
 * package within the build rather than the build, and building there would review a dependency
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
      // A fork, or nowhere left to go. One package file among them is the build, several are
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
 * Settle which folder this review treats as --sca-build, and --sca-experiments with it.
 *
 * Returns the pair to use, corrected or not. The caller applies it wholesale rather than
 * reading the flags again, so `scaBuild` and `scaExperiments` can never be read from two
 * different answers.
 *
 * The build folder moves only when it holds no package file AND exactly one folder below can be
 * meant (buildRootBelow walks that down). A lock is never required for the move, only ever
 * used to choose between several: a submission that forgot one is still moved, so the
 * review reports the missing lock it has rather than the missing build it does not.
 *
 * The Experiment folder (--sca-experiments) does not move with it: it may lie anywhere in the
 * extracted source archive. A folder found inside it is no build folder, so the folder given
 * stands, as where none is found. Once the build folder stands, the pair is held to what the
 * Experiment folder may be (settled).
 * @param {{scaExtracted?: string, scaBuild?: string, scaExperiments?: string}} opts  Absolute
 *   paths, as the CLI resolved them. The extracted folder is the build folder where none is
 *   named.
 * @returns {{scaBuild?: string, scaExperiments?: string, movedFrom: ?string}}
 *   The pair to review with. `movedFrom` is the build folder given when it was corrected,
 *   and null when it stands - the run narrates the difference rather than changing it silently.
 */
export function settleScaBuild(opts) {
  const given = {
    scaBuild: opts.scaBuild,
    scaExperiments: opts.scaExperiments,
    movedFrom: null,
  };
  const base = opts.scaExtracted ?? opts.scaBuild;
  if (!opts.scaBuild || hasPackageFile(opts.scaBuild)) {
    return settled(given, base);
  }
  const scaBuild = buildRootBelow(opts.scaBuild);
  if (
    !scaBuild ||
    (opts.scaExperiments &&
      relativeInside(scaBuild, opts.scaExperiments) !== null)
  ) {
    return settled(given, base);
  }
  return settled({ ...given, scaBuild, movedFrom: opts.scaBuild }, base);
}

/**
 * The pair, once nothing else can change it: --sca-experiments names the Experiment
 * implementation, so it may neither BE the extracted folder nor HOLD the build folder.
 *
 * Either excludes the wrong code. `scaViews` partitions on a prefix: the prefix of the
 * extracted folder itself is the empty string, which is under nothing, so the Experiment's
 * privileged code would be reviewed as WebExtension code and the report would fill with
 * Services/ChromeUtils errors against a submission that did nothing wrong. A folder holding
 * the build folder would take the WebExtension source and its package file out of the
 * WebExtension review instead. Preventing exactly that is what the flag is for, so it ends the
 * run rather than warning.
 *
 * Asked HERE because this is where the pair stops moving.
 * @param {{scaBuild?: string, scaExperiments?: string, movedFrom: ?string}} pair
 * @param {?string} base  The extracted source archive, absolute.
 * @returns {{scaBuild?: string, scaExperiments?: string, movedFrom: ?string}} The same pair.
 */
function settled(pair, base) {
  if (!pair.scaExperiments) {
    return pair;
  }
  const isBase = base && relativeInside(pair.scaExperiments, base) === "";
  const holdsBuild =
    pair.scaBuild &&
    relativeInside(pair.scaBuild, pair.scaExperiments) !== null;
  if (!isBase && !holdsBuild) {
    return pair;
  }
  const because = isBase
    ? `--sca-experiments "${pair.scaExperiments}" is the extracted source archive itself`
    : `--sca-experiments "${pair.scaExperiments}" holds the build folder "${pair.scaBuild}"`;
  throw new Error(
    `${because}. It names the Experiment implementation, a folder of its own inside the ` +
      "extracted source archive beside or below the WebExtension code, so it cannot be the " +
      "whole archive or hold the build folder: the wrong code would be excluded, and the " +
      "Experiment's privileged code would be reviewed as WebExtension code. Name the " +
      "subfolder holding it."
  );
}
