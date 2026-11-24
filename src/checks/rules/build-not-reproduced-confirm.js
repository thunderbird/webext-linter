// SCA only: asks the reviewer to confirm that the source does not build into the shipped XPI,
// where the agent built the add-on in the build check and the linter could not confirm it:
// its comparison with the submitted XPI found no match, or the build failed. Where it matched,
// the linter answered the question itself and this check does not run (`when:`). Any answer
// but the override reports the check naming why (build-not-reproduced, build-fails) and
// aborts the review, as build-reproduces-xpi does after a self-build.
//
// Belongs here: raising the question, anchored at the submission's package.json. Does NOT
// belong here: when it is asked (-> `when:` and asked-in, assets/registry.yaml) or the wording
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
