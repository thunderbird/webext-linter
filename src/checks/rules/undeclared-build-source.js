// SCA only: the build review - the build must NOT load or fetch remote resources.
// Everything must ship in the source; the only allowed copy-in is installed libraries via
// `npm ci` (from node_modules). A curl/wget/git-clone/CDN fetch is a reject.
//
// Nothing classifies what a build does, so every build with a corpus takes this check's
// escalation lane: the reviewer reproduces it from the source by hand, which is the
// attestation the SCA review rests on. The deterministic `unresolved` signals from
// ride along, so the entry names what could not be followed. A build with no corpus
// ("none") produces nothing - there is no build to reproduce.
//
// Belongs here: mapping the stored classification to a manual escalation. Does NOT
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
    const { classification, buildInstructions, unresolved } = review;
    const anchor = review.anchor ?? "package.json";

    // A build that exists (not "none") goes to the reviewer to reproduce.
    if (classification !== "none") {
      ctx.note?.(anchor, null, "the build configuration", VERDICT.UNSURE);
      return {
        findings: [],
        escalations: [
          {
            file: anchor,
            // manualReview: reproducing the build is the reviewer's own attestation
            // that the source produces the shipped XPI. No reading of the code
            // substitutes for doing it.
            manualReview: true,
            data: {
              buildInstructions:
                typeof buildInstructions === "string" ? buildInstructions : "",
              unresolvedBuildSteps: formatUnresolved(unresolved),
            },
          },
        ],
      };
    }

    return { findings: [] };
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
