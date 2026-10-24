// SCA only: a build the reviewer judged unsafe to run, in the preparation's build decision
// (src/prepare/steps.js permission): trusting the agent's unsafe verdict, or giving reasons
// of their own. It runs only then (`when: build-judged AND NOT build-safe`), so it always
// reports, once, anchored where the build checks anchor, and carries the reviewer's reasons
// as its note where they gave some. The review then goes on, and is aborted late with this
// check's reason and response.
//
// Belongs here: reporting it. Does NOT belong here: the decision (-> src/prepare/steps.js),
// handing the reasons to the source (-> src/pipeline.js), when it runs or the wording
// (-> assets/registry.yaml).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {Promise<{findings: import("../../report/finding.js").Finding[]}>}
   */
  async run(ctx) {
    const { anchor } = await ctx.buildReview();
    const at = ctx.artifact.at(anchor);
    ctx.note?.(at, "the build process", VERDICT.FAIL);
    const reported = finding({ ...at });
    reported.note = ctx.artifact.buildReasons ?? null;
    return { findings: [reported] };
  },
};
