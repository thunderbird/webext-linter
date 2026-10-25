// How a review starts: the steps every path into a review takes before the pipeline runs.
//
// "load the .xpi" opens every path. It creates the review's work folder, fresh, and makes the
// work folder's xpi/ the one copy of the shipped add-on: a packed .xpi is extracted there and
// an unpacked folder copied there, and nothing else in a review extracts it again. The
// pipeline (src/pipeline.js) reads that copy where it is. The load also answers what the
// add-on declares and whether the review rejects it from the .xpi alone, which a path asks
// before it does anything for the source.
//
// Belongs here: creating the work folder, loading the .xpi into it, and the facts read from
// it before any review runs. Does NOT belong here: naming the work folder (src/util/dest.js
// defaultWorkFolder, asked by the caller), loading itself (src/addon/load.js), the Experiment
// verdict's rule (src/experiments/verify.js), or the review (src/pipeline.js).
import { ARTIFACT_XPI } from "../lib/artifacts.js";
import { loadAddon, readWebExtManifest } from "../addon/load.js";
import { experimentVerdict } from "../experiments/verify.js";
import { isExperiment } from "../lib/util.js";
import { rethrowIfFatal } from "../lib/errors.js";
import { claimFolder } from "../util/claims.js";
import { workPaths } from "../util/dest.js";

/**
 * @typedef {object} LoadedXpi
 * @property {import("../addon/load.js").Addon} addon  The add-on, read from the work folder's
 *   xpi/.
 * @property {import("../addon/load.js").WebExtManifestRecord} manifest  What it declares.
 * @property {boolean} experiments  Whether it declares Experiments.
 * @property {?import("../experiments/verify.js").ExperimentVerification} verification  The
 *   Experiment verdict's classification, or null for an add-on that declares none.
 * @property {boolean} rejected  Whether the review rejects it from the .xpi alone.
 */

/**
 * Load the .xpi: create the work folder, fresh, extract or copy the add-on into its xpi/, and
 * read from that copy what it declares and the Experiment verdict. Every review starts here,
 * once. The folder is this run's (src/util/claims.js), so a run that fails before its review
 * exists gives it back as it exits.
 *
 * A folder already there is refused rather than shared: it belongs to another review. Its
 * name carries the time to the millisecond (defaultWorkFolder), so that is all but impossible.
 * @param {string} addonPath  The shipped add-on, a .xpi or its folder, absolute.
 * @param {string} work  The work folder, absolute. Nothing may be there yet.
 * @param {object} opts  The pipeline options the verdict reads: the experiments cache and
 *   `allowExperiments`.
 * @returns {Promise<LoadedXpi>}
 * @throws {Error}  The folder is there or cannot be created, or the add-on cannot be loaded.
 */
export async function loadTheXpi(addonPath, work, opts) {
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
  const addon = loadAddon(addonPath, workPaths(work).xpi, {
    kind: ARTIFACT_XPI,
  });
  const manifest = readWebExtManifest(addon.store);
  const experiments = isExperiment(manifest.json);
  if (!experiments) {
    return {
      addon,
      manifest,
      experiments,
      verification: null,
      rejected: false,
    };
  }
  const { verification, invalid } = await experimentVerdict(
    addon,
    manifest,
    opts
  );
  return { addon, manifest, experiments, verification, rejected: invalid };
}
