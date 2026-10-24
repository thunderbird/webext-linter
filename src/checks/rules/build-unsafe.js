// SCA only: a build the reviewer judged unsafe to run, in the preparation's build decision
// (src/prepare/steps.js permission). It runs only then (`when: build-judged AND NOT
// build-safe`), so it always reports. Where the reviewer gave reasons of their own, one
// finding, anchored where the build checks anchor, carries them as its note. Where they
// trusted the agent's verdict, each issue the build analysis listed is a finding of its own,
// at its file and line in the extracted archive, with the agent's hint. With neither, the one
// finding stands alone.
// The review then goes on, and is aborted late with this check's reason and response.
//
// Belongs here: reporting it. Does NOT belong here: the decision and the issues
// (-> src/prepare/steps.js), handing them to the source (-> src/pipeline.js), when it runs or
// the wording (-> assets/registry.yaml).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {Promise<{findings: import("../../report/finding.js").Finding[]}>}
   */
  async run(ctx) {
    const reasons = ctx.artifact.buildReasons ?? null;
    const issues = ctx.artifact.buildIssues ?? [];
    const { anchor } = await ctx.buildReview();
    if (reasons === null && issues.length) {
      return {
        findings: issues.map(({ file, line, hint }) => {
          const at = ctx.artifact.at(file, line === null ? null : { line });
          ctx.note?.(at, hint, VERDICT.FAIL);
          return finding({ ...at, hint });
        }),
      };
    }
    const at = ctx.artifact.at(anchor);
    ctx.note?.(at, "the build process", VERDICT.FAIL);
    const reported = finding({ ...at });
    reported.note = reasons;
    return { findings: [reported] };
  },
};
