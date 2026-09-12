// The SCA build review's ONE analysis, run in the setup phase (like resolveVendor for
// dependencies): it selects the build corpus (selectBuildCorpus) and stores what it found
// on addon.buildFiles.buildReview so the input:build checks read it deterministically.
// The classification it can reach:
//   - "none"  no package.json entry point to follow (nothing to review).
//   - null    there is a build corpus but nothing classifies what it does, so the build
//             goes to a reviewer, who reproduces it from the source by hand. Reproducing
//             the build is the reviewer's attestation and no analysis substitutes for it.
// The deterministic `unresolved` signals from selectBuildCorpus (a network fetch / an opaque
// orchestrator the linter could not follow) ride along for the checks to report.
//
// Belongs here: running the analysis and shaping the stored verdict. Does NOT belong here: the
// corpus policy (-> ./corpus.js) or the finding/manual wording (-> the input:build checks +
// registry).

import { selectBuildCorpus } from "./corpus.js";

/**
 * @typedef {object} BuildReview
 * @property {"ok"|"remote-fetch"|"not-from-source"|"none"|null} classification
 * @property {string} reason  One-line explanation (for the finding {{explanation}}).
 * @property {string} buildInstructions  How to build the XPI (for the manual note).
 * @property {{kind: string, detail: string}[]} unresolved  Deterministic build-corpus signals.
 * @property {boolean} analyzed  True only when the build was classified.
 * @property {?string} anchor  The file the findings/notes anchor at (package.json if present).
 */

/**
 * Look at the SCA build once, in setup.
 * @param {object} params
 * @param {{files: Map<string, Buffer>}} params.build  The build files (addon.buildFiles).
 * @returns {BuildReview}
 */
export function analyzeBuild({ build }) {
  const files = build?.files ?? new Map();
  const { corpus, unresolved } = selectBuildCorpus(build);
  const anchor = files.has("package.json")
    ? "package.json"
    : (corpus[0] ?? null);
  const base = {
    classification: null,
    reason: "",
    buildInstructions: "",
    unresolved,
    analyzed: false,
    anchor,
  };
  // No entry point to follow -> no npm build to review.
  if (!corpus.length) {
    return { ...base, classification: "none" };
  }
  // The build corpus exists but nothing classifies it, so it stays unanalyzed: the
  // build routes to the reviewer, who reproduces it from the source by hand.
  return base;
}
