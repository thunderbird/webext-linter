// SCA only: the build review where nobody decided about the build in a preparation - a plain
// report, or an agent review run with a build-guard check switched off. One question covers
// the whole build, in the order a reviewer takes it: whether it uses only the submitted source
// and the dependencies declared in package.json/lock, and only then whether it builds and
// reproduces the shipped XPI.
//
// Nothing decides that from the files, so every such source-code submission raises this, for
// the reviewer, anchored at the submission's package.json. Where the reviewer decided in the
// preparation, build-reproduces-xpi asks the outcome and build-unsafe reports an unsafe build
// instead.
//
// Belongs here: raising the escalation. Does NOT belong here: where it anchors
// (-> src/build/analyze.js), when it runs or the wording (-> assets/registry.yaml).

import { VERDICT } from "../../lib/enum.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../escalation.js").Escalation} Escalation */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: [], escalations?: Escalation[]}}
   */
  async run(ctx) {
    // Null when the source documents no build at all: the entry then carries no locus
    // rather than pointing the reviewer at a package.json the submission lacks.
    const { anchor } = await ctx.buildReview();

    ctx.note?.(
      ctx.artifact.at(anchor),
      "the build configuration",
      VERDICT.UNSURE
    );
    return {
      findings: [],
      escalations: [
        {
          // `anchor` is null when the source documents no build at all, which the locus
          // says by naming the artifact and no file in it.
          ...ctx.artifact.at(anchor),
        },
      ],
    };
  },
};
