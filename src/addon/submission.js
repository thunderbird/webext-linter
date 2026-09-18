// What a source code submission looks like on disk, for --llm-sca-review: a folder holding
// the built add-on and an archive of the source it was built from.
//
// An SCA review needs three arguments nobody can write without opening that source archive
// (--sca-root, --sca-source, --sca-exp-source). This module does the half a program can do
// - which file is the add-on, which is the source - and the prompt hands the rest to
// whoever can open the archive.
//
// Belongs here: locating those two files, refusing a folder that is not that pair, and
// naming where the source archive's own extraction goes - path math on the same terms as
// the other two, not the extracting itself, which stays the reader's (this tool cannot
// open every format the source arrives in; see src/addon/load.js for the built .xpi,
// which it can, and does, unpack itself).
//
// Does NOT belong here: reading either file (src/addon/load.js), extracting the source
// archive, the prompt's wording (assets/registry.yaml), how it is printed
// (src/report/format.js), or the NAME of the flag that asked - src/cli.js owns the
// options table, so it says which flag was wrong and this says what was found. A caller
// with no command line gets an answer about the folder.

import fs from "node:fs";
import path from "node:path";

import { extname } from "../util/files.js";
import { extractionDestination } from "../util/dest.js";

/** The built add-on's extension - the one archive in the folder that is not the source. */
const ADDON_EXTENSION = ".xpi";

/**
 * What counts as the SOURCE archive beside it. This module's own list, not the loader's
 * ARCHIVE_EXTENSIONS: that one answers "is this file, inside a submission, a committed
 * binary artifact" for committed-build-artifact and the build corpus, and it is scoped to
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
 * @returns {{folder: string, xpi: string, source: string, extracted: string}}
 */
export function scaSubmission(folder) {
  const root = path.resolve(folder);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    throw new Error(`not a readable folder: ${err.message}`);
  }
  const archives = entries
    .filter(
      (e) =>
        e.isFile() &&
        (extname(e.name) === ADDON_EXTENSION ||
          SOURCE_ARCHIVE_EXTENSIONS.has(extname(e.name)))
    )
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
  const source = path.join(root, sources[0]);
  return {
    folder: root,
    xpi: path.join(root, addons[0]),
    source,
    // Where the reader is asked to extract `source` - named on the same terms as the XPI
    // side (src/util/dest.js), so a submission reviewed twice gets a fresh folder rather
    // than a second extraction silently landing in the first one's.
    extracted: `${extractionDestination(`${source}.extracted`)}${path.sep}`,
  };
}
