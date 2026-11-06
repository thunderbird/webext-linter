// How a review is set up: the steps every entry point takes for its own review before the
// review runs (src/pipeline.js reviewLoadedSubmission).
//
// "load the .xpi" opens every path. It creates the review's work folder, fresh, with an empty
// record in it (src/review/record.js), which every later step writes into, and makes the
// work folder's xpi/ the one copy of the shipped add-on: a packed .xpi is extracted there and
// an unpacked folder copied there, and nothing else in a review extracts it again. The review
// reads that copy where it is. The load fails only on an add-on it cannot read.
//
// A source code review given --sca-extracted then has the source copied into the work
// folder's sca/, whole and as it is, by its own step ("copy the source"): the review reads
// that copy where it is, as it reads xpi/, and copies nothing. Where the package root lies in
// it is settled after the copy (src/addon/package-root.js settlePackageRoot).
//
// Belongs here: creating the work folder with its empty record, loading the .xpi into it, and
// copying a named source into it. Does NOT belong here: naming the work folder (src/util/dest.js
// defaultWorkFolder, asked by the caller), loading itself (src/addon/load.js), the folders
// named inside the source (src/addon/package-root.js), or the review (src/pipeline.js).
import fs from "node:fs";

import { ARTIFACT_XPI } from "../lib/artifacts.js";
import { loadAddon, readWebExtManifest } from "../addon/load.js";
import { rethrowIfFatal } from "../lib/errors.js";
import { claimFolder } from "../util/claims.js";
import { workPaths } from "../util/dest.js";
import { writeRecord } from "./record.js";

/**
 * @typedef {object} LoadedXpi
 * @property {string} work  The work folder it was loaded into, absolute.
 * @property {import("../addon/load.js").Addon} addon  The add-on, read from the work folder's
 *   xpi/.
 * @property {import("../addon/load.js").WebExtManifestRecord} manifest  What it declares.
 * @property {object} record  The work folder's record, empty: no mode, nothing carried.
 */

/**
 * Load the .xpi: create the work folder, fresh, with an empty record in it, and extract or
 * copy the add-on into its xpi/.
 * Every review starts here, once. The folder is this run's (src/util/claims.js), so a run that
 * fails gives it back as it exits.
 *
 * A folder already there is refused rather than shared: it belongs to another review. Its
 * name carries the time to the millisecond (defaultWorkFolder), so that is all but impossible.
 * @param {string} addonPath  The shipped add-on, a .xpi or its folder, absolute.
 * @param {string} work  The work folder, absolute, named for the kind of review
 *   (defaultWorkFolder). Nothing may be there yet.
 * @returns {LoadedXpi}
 * @throws {Error}  The folder is there or cannot be created, or the add-on cannot be loaded:
 *   a bad zip, a link, an unreadable file, the size cap.
 */
export function loadTheXpi(addonPath, work) {
  let created;
  try {
    created = claimFolder(work);
  } catch (err) {
    rethrowIfFatal(err);
    throw new Error(
      `The work folder "${work}" cannot be created (${err.code ?? err.message}).`
    );
  }
  if (!created) {
    throw new Error(
      `The work folder "${work}" is already there, and every review starts in a fresh one.`
    );
  }
  const record = writeRecord(work, {});
  const addon = loadAddon(addonPath, workPaths(work).xpi, {
    kind: ARTIFACT_XPI,
  });
  return { work, addon, manifest: readWebExtManifest(addon.store), record };
}

/**
 * Copy the source: the extracted source archive the reviewer named (--sca-extracted), whole
 * and as it is, into the work folder's sca/. Symbolic links are copied as they are written:
 * one the submission points out of itself stays pointing out, for the review to report.
 * @param {string} work  The work folder, loaded (loadTheXpi).
 * @param {string} extracted  The folder named, absolute and real.
 * @returns {string}  The work folder's sca/, as named.
 * @throws {Error}  The copy could not be made.
 */
export function copySource(work, extracted) {
  const { sca } = workPaths(work);
  try {
    fs.cpSync(extracted, sca, { recursive: true, verbatimSymlinks: true });
  } catch (err) {
    rethrowIfFatal(err);
    throw new Error(
      `The source "${extracted}" could not be copied into the work folder ` +
        `(${err.code ?? err.message}).`,
      { cause: err }
    );
  }
  return sca;
}
