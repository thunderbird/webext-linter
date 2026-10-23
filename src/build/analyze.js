// The SCA build review's ONE look at the build, run when a check first asks for it
// (src/review/products.js, ctx.buildReview()): where the build's escalations anchor.
//
// Nothing here says what a build DOES. Judging it is the reader's - the build agent, or the
// reviewer - and reproducing it is the reviewer's attestation, so every build routes to them
// and this records only the file the findings and notes anchor at: the submission's own
// package.json, the build's entry point.
//
// Belongs here: shaping the stored record. Does NOT belong here: the finding/manual wording
// (-> the input:sca checks + registry).

/**
 * @typedef {object} BuildReview
 * @property {?string} anchor  The file the findings/notes anchor at: package.json when the
 *   submission ships one, else null, so an escalation carries no locus rather than pointing
 *   the reviewer at a file the submission does not have.
 */

/**
 * Look at the SCA build once, when a check first asks for it (src/review/products.js).
 * @param {object} params
 * @param {{files: Map<string, Buffer>}} [params.build]  The submission's files
 *   (the archive's source view); absent is no files at all.
 * @returns {BuildReview}
 */
export function analyzeBuild({ build }) {
  const files = build?.files ?? new Map();
  return { anchor: files.has("package.json") ? "package.json" : null };
}
