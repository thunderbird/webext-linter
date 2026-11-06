// WHICH FOLDER IS THE PACKAGE ROOT, and which folders of a source may be named at all.
//
// The package root is the folder of the extracted source archive the build runs in: the one
// holding package.json and the lock the reviewer installs from. Everything downstream reads
// those from the TOP LEVEL of the package root and nowhere else (src/vendor/locks.js, the
// package.json readers, through the package root's view of the archive), which is what makes
// "the package root" mean something. This decides which folder that is. It does not soften
// that rule - it runs before it. The review itself reads the whole extracted archive.
//
// It exists because the package root is NAMED by someone who has not looked inside yet. A
// source archive is extracted by whoever extracts it for the review, into a destination this tool
// worked out by path math alone, and an archive that carries its contents in one directory of
// its own leaves the build files one level below that destination. The review then reads a
// package root holding nothing, reports a build it cannot reproduce, and never audits the
// dependency tree sitting just below it - a submission with critical advisories reviewed as
// though it declared none. So the package root a reviewer names is a HINT, and the
// Experiment folder is taken as it is named.
//
// DOWN ONLY. The folder ABOVE the source is the reviewer's submission folder, holding the
// .xpi and the archive itself, and nothing there was submitted as source: a package root found
// by stepping out of the one named is one nobody pointed at. How FAR down is not fixed,
// because the number of directories an archive wraps its contents in is an accident of how it
// was packed - the walk follows a chain of single folders as far as it goes and stops at the
// first fork.
//
// Two steps, each with one consumer of the other's answer. "Approve the sca folders" holds the
// folders named to what they may be, against the source they are named in, and returns them
// relative to it, so they name the same folders in any copy of it. "Settle the package root"
// then finds the package root in the work folder's `sca/` from the hint, and throws nothing:
// whether the Experiment folder fits the package root was decided by the approval.
//
// Belongs here: which folder the review treats as the package root, and holding the named
// folders to what they may name. Does NOT belong here: what is read once it is settled (the
// build files, the lock), the keyspace the source view is built in (scaViews in ./load.js),
// how the folders are reported (src/report/format.js), or how a problem is worded for the
// command line or the agent (src/cli.js).

import fs from "node:fs";
import path from "node:path";

import { relativeInside } from "./load.js";
import { PACKAGE_FILE } from "../vendor/package-file.js";
import { TREE_LOCKS } from "../vendor/locks.js";
import { rethrowIfFatal, wiringError } from "../lib/errors.js";

/**
 * The sca folders: the package-root hint and the Experiment folder, each optional and each
 * relative to the source they are named in ("" for the source itself), so they name the same
 * folders in the source and in its copy in `sca/`.
 * @typedef {{packageRoot?: string, experiments?: string}} ScaHints
 */

/**
 * The source folders a review reads, all in its work folder: the copy of the submitted
 * source (`source`, its `sca/`), the tree the review reads (`used`: that copy, or its rescued
 * copy `rescued/`), and the package root and the Experiment folder inside `used`, the
 * Experiment folder exactly when the add-on declares Experiments. Absolute.
 * @typedef {{source: string, used: string, packageRoot: string, experiments?: string}}
 *   ScaFolders
 */

/**
 * Assert that `folders` holds exactly `keys`, each an absolute folder, `experiments` only
 * where it is there. Checked, never filled in: a folder a caller did not hand over is a
 * caller that forgot it.
 * @param {*} folders
 * @param {string[]} keys  The keys it takes, `experiments` among them.
 * @param {string} who  The reader asking, named in the error.
 * @returns {*}  `folders`.
 * @throws {import("../lib/errors.js").LinterError}  A wiring error.
 */
function assertFolders(folders, keys, who) {
  const bad = (what) => wiringError(`${who} was handed source folders ${what}`);
  if (!folders || typeof folders !== "object") {
    throw bad("that are not an object");
  }
  const extra = Object.keys(folders).filter((k) => !keys.includes(k));
  if (extra.length) {
    throw bad(`with a key it does not take (${extra.join(", ")})`);
  }
  for (const key of keys) {
    const value = folders[key];
    if (key === "experiments" && !Object.hasOwn(folders, key)) {
      continue;
    }
    if (typeof value !== "string" || !path.isAbsolute(value)) {
      throw bad(`whose \`${key}\` is no absolute folder`);
    }
  }
  return folders;
}

/**
 * Assert that `folders` is a ScaFolders.
 * @param {*} folders
 * @param {string} who
 * @returns {ScaFolders}
 */
export function assertScaFolders(folders, who) {
  return assertFolders(
    folders,
    ["source", "used", "packageRoot", "experiments"],
    who
  );
}

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
    // (src/cli.js folderProblem, approveScaFolders), and the loader is about to read it and
    // say so properly.
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
 * submission. A package file reached on the way ends the walk: that is the package root.
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
function packageRootBelow(root) {
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
 * Why the source folders do not fit the add-on, or null where they do: the Experiment folder is
 * named exactly when the shipped manifest declares Experiments. The archive cannot say which
 * of its folders holds the Experiment, only the flag does, and without it the privileged code
 * is reviewed as WebExtension code and rejected for being what an Experiment is. One named for
 * an add-on without Experiments would exclude WebExtension code from the review instead.
 * @param {ScaHints} folders  As approveScaFolders returned them.
 * @param {boolean} isExp  Whether the shipped manifest declares experiment_apis.
 * @returns {?string}
 */
export function scaFoldersMisfit(folders, isExp) {
  const named = Object.hasOwn(folders, "experiments");
  if (isExp && !named) {
    return (
      "This add-on ships an Experiment (its manifest.json declares experiment_apis): " +
      "name the folder of the source archive that holds the Experiment " +
      "implementation with --sca-experiments."
    );
  }
  if (!isExp && named) {
    return (
      `--sca-experiments "${folders.experiments}" names an Experiment folder, but this ` +
      "add-on declares no Experiments (its manifest.json has no experiment_apis). " +
      "Drop --sca-experiments."
    );
  }
  return null;
}

/**
 * What is wrong with one of the sca folders, as `approveScaFolders` throws it: which folder
 * (`which`, the key of ScaHints), the folder it really is (`real`), and the problem:
 * `outside` (it does not lie inside the source), `not-folder` (nothing there is a folder),
 * `is-source` (the Experiment folder is the source itself), `holds-root` (the Experiment
 * folder holds the package-root hint, or the source where none is given) or `empty` (the
 * Experiment folder holds no file, so it would exclude nothing). Each caller catches
 * it and says what is wrong in its own words: a bad command line, or a refusal.
 */
export class ScaFoldersRejected extends Error {
  /**
   * @param {"packageRoot"|"experiments"} which
   * @param {"outside"|"not-folder"|"is-source"|"holds-root"|"empty"} problem
   * @param {string} real
   */
  constructor(which, problem, real) {
    super(`The sca folder ${which} "${real}" is rejected: ${problem}.`);
    this.name = "ScaFoldersRejected";
    this.which = which;
    this.problem = problem;
    this.real = real;
  }
}

/**
 * The folder `p` really is, links followed as far as it exists, the rest joined back on.
 * @param {string} p  Absolute.
 * @returns {string}
 */
function followed(p) {
  const rest = [];
  let at = p;
  try {
    while (!fs.existsSync(at)) {
      const up = path.dirname(at);
      if (up === at) {
        return p;
      }
      rest.unshift(path.basename(at));
      at = up;
    }
    return path.join(fs.realpathSync(at), ...rest);
  } catch (err) {
    rethrowIfFatal(err);
    return p;
  }
}

/**
 * Whether `p` is a folder.
 * @param {string} p
 * @returns {boolean}
 */
function isFolder(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (err) {
    rethrowIfFatal(err);
    return false;
  }
}

/**
 * Whether a regular file lies anywhere below `dir`. A link is not followed, as the load
 * skips it, so a file reached only through one does not count.
 * @param {string} dir  A folder.
 * @returns {boolean}
 */
function holdsFile(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    rethrowIfFatal(err);
    return false;
  }
  return entries.some(
    (e) => e.isFile() || (e.isDirectory() && holdsFile(path.join(dir, e.name)))
  );
}

/**
 * Approve the sca folders: the package-root hint and the Experiment folder, each optional and
 * each an absolute path, held against the source folder they are named in. Each is followed
 * to the folder it really is and must lie inside the source and be a folder, and the
 * Experiment folder must be neither the source itself nor hold the package-root hint (lie
 * inside it or be it), which is the source where no hint is given, and must hold at least one
 * file, since an Experiment folder with none excludes nothing. The package root is only
 * ever settled down from the hint and never into the Experiment folder, so an Experiment
 * folder that does not hold the hint cannot hold the settled package root either.
 *
 * Reads nothing relative: how a folder was written is the caller's, which hands it over
 * absolute. Decides nothing more: what is wrong is thrown (ScaFoldersRejected), and each
 * caller says it in its own words.
 * @param {string} source  The source folder, absolute: --sca-extracted, or the work folder's
 *   `sca/`.
 * @param {{packageRoot?: string, experiments?: string}} named  Absolute.
 * @returns {ScaHints}  The folders relative to the source.
 * @throws {ScaFoldersRejected}  What is wrong, and with which folder.
 */
export function approveScaFolders(source, named) {
  const base = followed(source);
  const folders = {};
  const real = {};
  for (const which of ["packageRoot", "experiments"]) {
    if (named[which] === undefined) {
      continue;
    }
    const at = followed(named[which]);
    const rel = relativeInside(at, base);
    if (rel === null) {
      throw new ScaFoldersRejected(which, "outside", at);
    }
    if (!isFolder(at)) {
      throw new ScaFoldersRejected(which, "not-folder", at);
    }
    folders[which] = rel;
    real[which] = at;
  }
  if (real.experiments !== undefined) {
    if (folders.experiments === "") {
      throw new ScaFoldersRejected(
        "experiments",
        "is-source",
        real.experiments
      );
    }
    if (relativeInside(real.packageRoot ?? base, real.experiments) !== null) {
      throw new ScaFoldersRejected(
        "experiments",
        "holds-root",
        real.experiments
      );
    }
    if (!holdsFile(real.experiments)) {
      throw new ScaFoldersRejected("experiments", "empty", real.experiments);
    }
  }
  return folders;
}

/**
 * Settle which folder of the work folder's `sca/` this review treats as the package root,
 * from the sca folders approveScaFolders returned, and return the folders the review reads.
 *
 * A package-root hint that holds package.json is the package root, and so is `sca/` itself
 * where none is given and it holds one. Otherwise the package root moves only where exactly
 * one folder below can be meant (packageRootBelow walks that down), and never into the
 * Experiment folder: where the folder found lies inside it, the folder given stands, as where
 * none is found. A lock is never required for the move, only ever used to choose between
 * several: a submission that forgot one is still moved, so the review reports the missing
 * lock it has rather than the missing build it does not. Nothing is thrown.
 * @param {string} sca  The work folder's `sca/`, holding the source.
 * @param {ScaHints} hints  Relative to `sca`.
 * @returns {{folders: ScaFolders, moved: ?{from: string, to: string}}}  The folders the
 *   review reads, absolute and real, and the package root's move inside `sca/`, relative to
 *   it, where it moved: the run narrates the difference rather than changing it silently.
 */
export function settlePackageRoot(sca, hints) {
  const root = fs.realpathSync(sca);
  const given = path.join(root, hints.packageRoot ?? "");
  const experiments =
    hints.experiments === undefined
      ? undefined
      : path.join(root, hints.experiments);
  const folders = (packageRoot) => ({
    source: root,
    used: root,
    packageRoot,
    ...(experiments === undefined ? {} : { experiments }),
  });
  if (hasPackageFile(given)) {
    return { folders: folders(given), moved: null };
  }
  const below = packageRootBelow(given);
  if (
    !below ||
    (experiments !== undefined && relativeInside(below, experiments) !== null)
  ) {
    return { folders: folders(given), moved: null };
  }
  return {
    folders: folders(below),
    moved: {
      from: path.relative(root, given),
      to: path.relative(root, below),
    },
  };
}
