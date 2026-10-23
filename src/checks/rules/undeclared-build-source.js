// SCA only: the build review - the build must use only the submitted source and the
// dependencies declared in package.json/lock. Everything must ship in the source; the only
// allowed copy-in is installed libraries via `npm ci` (from node_modules).
//
// Nothing decides that from the files, so EVERY source-code submission raises this, for
// the agent to settle in `settle`, after the build (or, with no agent, for the reviewer),
// anchored at the submission's package.json. Whether the source then builds into the
// shipped XPI is a question of its own (build-reproduces-xpi).
//
// Belongs here: raising the escalation. Does NOT belong here: where it anchors
// (-> src/build/analyze.js), or the wording (-> assets/registry.yaml).

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
