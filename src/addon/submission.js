// What a source code submission looks like on disk, for --llm-sca-review: a folder holding
// the built add-on and an archive of the source it was built from.
//
// An SCA review needs the source archive's own paths, and nobody can write
// --sca-exp-source without opening it. This module
// does the half a program can do: which file is the add-on and which is the source. The
// prompt hands the rest to whoever can open the archive.
//
// Belongs here: locating those two files, and refusing a folder that is not that pair.
//
// Does NOT belong here: reading either file (src/addon/load.js), where the source archive
// is extracted (the review's work folder, src/util/dest.js workPaths), extracting it, which
// stays the reader's (this tool cannot open every format the source arrives in), the
// prompt's wording (assets/registry.yaml), how it is printed
// (src/report/format.js), or the NAME of the flag that asked - src/cli.js owns the
// options table, so it says which flag was wrong and this says what was found. A caller
// with no command line gets an answer about the folder.

import fs from "node:fs";
import path from "node:path";

import { extname } from "../util/files.js";

/** The built add-on's extension - the one archive in the folder that is not the source. */
const ADDON_EXTENSION = ".xpi";

/**
 * What counts as the SOURCE archive beside it. This module's own list, not the loader's
 * ARCHIVE_EXTENSIONS: that one answers "is this file, inside a submission, a committed
 * binary artifact" for committed-build-artifact and the build trace, and it is scoped to
 * what those checks care about. The question here is different - which of two files is the
 * source a reader is being sent to extract - and the answer includes formats this tool
 * never opens, because the reader's `tar` does.
 *
 * Read from the END of the name, so a double-packed `.tar.gz` is a `.gz` and an ATN-mangled
 * `…-src.tar_UubDLRC.gz` still lands here.
 */
const SOURCE_ARCHIVE_EXTENSIONS = new Set([
  ".zip",
  ".gz",
  ".tgz",
  ".tar",
  ".xz",
  ".bz2",
  ".zst",
  ".7z",
  ".rar",
]);

/**
 * The two files of a source code submission, as absolute paths: the built add-on, and the
 * source it was built from.
 *
 * The add-on is the one file named .xpi; the source is the one ARCHIVE beside it. This
 * never opens that archive - the prompt's reader extracts it - but it has to say which
 * file it is, so the name is all there is to go on.
 *
 * Only the top level is read, and only archives are counted: a README, a licence, a
 * .DS_Store a download picked up, a folder someone already extracted - none of them make a
 * submission ambiguous, so none of them is an error. Anything else throws, naming what was
 * found: there is nothing useful to print for a folder with no source archive or two of
 * them, and a prompt built on a guess would send its reader to review a file nobody
 * submitted.
 * @param {string} folder
 * @returns {{folder: string, xpi: string, source: string}}
 */
export function scaSubmission(folder) {
  const root = path.resolve(folder);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    throw new Error(`not a readable folder: ${err.message}`);
  }
  const submitted = (e) =>
    extname(e.name) === ADDON_EXTENSION ||
    SOURCE_ARCHIVE_EXTENSIONS.has(extname(e.name));
  // The submission's files must be the files themselves. A link to one names a file
  // anywhere on this machine, so it is refused by name rather than read - or skipped, which
  // would report the folder as missing the file it plainly lists.
  const linked = entries.find((e) => e.isSymbolicLink() && submitted(e));
  if (linked) {
    throw new Error(
      `"${linked.name}" is a symlink, and a submission's files must be the files ` +
        "themselves."
    );
  }
  const archives = entries
    .filter((e) => e.isFile() && submitted(e))
    .map((e) => e.name);
  const addons = archives.filter((n) => extname(n) === ADDON_EXTENSION);
  const sources = archives.filter((n) => extname(n) !== ADDON_EXTENSION);
  const found = (list) =>
    list.length ? list.map((n) => `"${n}"`).join(", ") : "none";
  if (addons.length !== 1 || sources.length !== 1) {
    throw new Error(
      `a submission folder holds exactly one ${ADDON_EXTENSION} and exactly one other ` +
        "archive - the built add-on and the source it was built from. Found " +
        `${addons.length} add-on(s) (${found(addons)}) and ${sources.length} ` +
        `source archive(s) (${found(sources)}).`
    );
  }
  return {
    folder: root,
    xpi: path.join(root, addons[0]),
    source: path.join(root, sources[0]),
  };
}
