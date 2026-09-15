// SCA only: the build review - the build must NOT load or fetch remote resources.
// Everything must ship in the source; the only allowed copy-in is installed libraries via
// `npm ci` (from node_modules). A curl/wget/git-clone/CDN fetch is a reject.
//
// Nothing decides that from the files, so EVERY source-code submission raises this:
// the reviewer reproduces the build by hand and confirms the shipped XPI comes from the
// source they just read. That attestation is what the SCA review rests on - reviewing
// readable source is only worth anything if the shipped bytes come from it, so a
// submission documenting no build at all still has to be checked against the XPI. The
// deterministic `unresolved` signals from selectBuildCorpus (a network fetch, an
// orchestrator the linter could not follow) ride along, so the entry names what could
// not be followed.
//
// Belongs here: raising the escalation and the detail it carries. Does NOT
// belong here: the analysis (-> src/build/analyze.js), the corpus policy
// (-> build-corpus.js), or the wording (-> assets/registry.yaml).

import { VERDICT } from "../../lib/enum.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../escalation.js").Escalation} Escalation */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: [], escalations: Escalation[]}}
   */
  run(ctx) {
    const review = ctx.addon?.buildReview;
    if (!review) {
      return { findings: [] };
    }
    const { unresolved } = review;
    // Null when the source documents no build at all: the entry then carries no locus
    // rather than pointing the reviewer at a package.json the submission lacks.
    const anchor = review.anchor;

    ctx.note?.(anchor, null, "the build configuration", VERDICT.UNSURE);
    return {
      findings: [],
      escalations: [
        {
          ...(anchor ? { file: anchor } : {}),
          data: {
            unresolvedBuildSteps: formatUnresolved(unresolved),
          },
        },
      ],
    };
  },
};

/**
 * One sentence naming the build steps the linter could not statically bound, or "" when there
 * are none (the registry template is authored to read with the slot empty).
 * @param {{kind: string, detail: string}[]} [unresolved]
 * @returns {string}
 */
function formatUnresolved(unresolved) {
  if (!unresolved?.length) {
    return "";
  }
  const parts = unresolved.map((u) =>
    u.kind === "tool"
      ? `an unrecognized build tool (\`${u.detail}\`)`
      : u.kind === "network"
        ? `a network fetch in ${u.detail}`
        : u.detail
  );
  return `The linter could not statically analyze part of the build (${parts.join("; ")}), so the build corpus may be incomplete - reproduce the build by hand.`;
}
