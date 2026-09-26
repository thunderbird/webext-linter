// The SCA build review's ONE look at the build, run in the setup phase (like resolveVendor
// for dependencies): it narrows the source view to the files the build reaches
// (collectBuildFiles) and returns what it found, which the pipeline stores on
// addon.buildReview for the input:sca checks to read deterministically.
//
// Nothing here says what a build DOES. Reproducing it is the reviewer's attestation and no
// analysis substitutes for it, so every build routes to them and this records only what the
// escalation has to name: the deterministic `unresolved` signals from collectBuildFiles (a
// network fetch / an opaque orchestrator the linter could not follow), and the file the
// findings and notes anchor at.
//
// Belongs here: running the analysis and shaping the stored record. Does NOT belong here: the
// collection policy (-> ./collect.js) or the finding/manual wording (-> the input:sca checks +
// registry).

import { collectBuildFiles } from "./collect.js";

/**
 * @typedef {object} BuildReview
 * @property {{kind: string, detail: string}[]} unresolved  Deterministic build-trace signals.
 * @property {?string} anchor  The file the findings/notes anchor at (package.json if present).
 */

/**
 * Look at the SCA build once, in setup.
 * @param {object} params
 * @param {{files: Map<string, Buffer>}} [params.build]  The submission's files
 *   (the archive's source view); absent is no files at all.
 * @returns {BuildReview}
 */
export function analyzeBuild({ build }) {
  const files = build?.files ?? new Map();
  const { buildFiles, unresolved } = collectBuildFiles(build);
  return {
    unresolved,
    // The submission's own package.json when it ships one, else the first build file - and
    // null when the build reaches nothing at all, so an escalation carries no locus rather
    // than pointing the reviewer at a file the submission does not have.
    anchor: files.has("package.json")
      ? "package.json"
      : (buildFiles[0] ?? null),
  };
}
