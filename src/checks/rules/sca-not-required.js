// A source-code archive was submitted, but the shipped XPI turns out to BE that source:
// readable, not generated, and byte-for-byte what the archive holds. The developer can
// submit the XPI alone next time and skip the longer source review.
//
// ADVICE, not a routing decision. The review this fires in is still a full SCA review -
// nothing is narrowed by it. That is deliberate: no content test can be trusted to route,
// because a committed unminified build inside --sca-source is its own twin under any of
// them, and routing on that would let a build be dressed up as source.
//
// Belongs here: turning the pipeline's ctx.scaNotRequired into a finding. Does NOT belong
// here: deciding it (-> resolveXpiOnlyAdvice in src/pipeline.js, which asks the three
// questions), the wording (-> assets/registry.yaml), or the severity (-> that entry).

import { finding } from "../../report/finding.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    if (!ctx.scaNotRequired) {
      return { findings: [] };
    }
    // No locus: the subject is the submission as a whole, not a file in it.
    return { findings: [finding({})] };
  },
};
