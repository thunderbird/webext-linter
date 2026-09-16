// The SCA build review's ONE look at the build, run in the setup phase (like resolveVendor
// for dependencies): it selects the build corpus (selectBuildCorpus) and returns what it
// found, which the pipeline stores on addon.buildFiles.buildReview for the input:build
// checks to read deterministically.
//
// Nothing here says what a build DOES. Reproducing it is the reviewer's attestation and no
// analysis substitutes for it, so every build routes to them and this records only what the
// escalation has to name: the deterministic `unresolved` signals from selectBuildCorpus (a
// network fetch / an opaque orchestrator the linter could not follow), and the file the
// findings and notes anchor at.
//
// Belongs here: running the analysis and shaping the stored record. Does NOT belong here: the
// corpus policy (-> ./corpus.js) or the finding/manual wording (-> the input:build checks +
// registry).

import { selectBuildCorpus } from "./corpus.js";

/**
 * @typedef {object} BuildReview
 * @property {{kind: string, detail: string}[]} unresolved  Deterministic build-corpus signals.
 * @property {?string} anchor  The file the findings/notes anchor at (package.json if present).
 */

/**
 * Look at the SCA build once, in setup.
 * @param {object} params
 * @param {{files: Map<string, Buffer>}} [params.build]  The build files
 *   (addon.buildFiles); absent is an empty corpus.
 * @returns {BuildReview}
 */
export function analyzeBuild({ build }) {
  const files = build?.files ?? new Map();
  const { corpus, unresolved } = selectBuildCorpus(build);
  return {
    unresolved,
    // The submission's own package.json when it ships one, else the first corpus file -
    // and null when there is no corpus at all, so an escalation carries no locus rather
    // than pointing the reviewer at a file the submission does not have.
    anchor: files.has("package.json") ? "package.json" : (corpus[0] ?? null),
  };
}
