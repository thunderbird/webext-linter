// SCA only: asks the reviewer whether the source builds into the shipped XPI. Nothing in
// the files can answer it - only a build can - so EVERY source-code submission raises it,
// and the reviewer answers it once the build ran (by the agent, or by hand). Any answer but
// "Builds and reproduces" reports the check naming why (build-not-reproduced, build-fails,
// build-unsafe) and aborts the review: a source that does not build into the shipped XPI
// attests nothing about it, so nobody is then asked to install it.
//
// Belongs here: raising the question, anchored at the submission's package.json. Does NOT
// belong here: when it is asked (-> asked-in, assets/registry.yaml) or the wording
// (-> assets/registry.yaml).

import { VERDICT } from "../../lib/enum.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../escalation.js").Escalation} Escalation */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: [], escalations: Escalation[]}}
   */
  async run(ctx) {
    // Null when the source documents no build at all: the question then carries no locus
    // rather than pointing at a package.json the submission lacks.
    const { anchor } = await ctx.buildReview();
    ctx.note?.(ctx.artifact.at(anchor), "the built XPI", VERDICT.UNSURE);
    return { findings: [], escalations: [{ ...ctx.artifact.at(anchor) }] };
  },
};
