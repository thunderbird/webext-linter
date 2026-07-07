// Deterministic (SCA only): mission 3 of the build review - a source submission is only needed
// when the XPI is genuinely built from source. This flags a "build" whose only job is copying
// installed libraries (from node_modules) into the add-on: nothing is compiled or bundled from
// authored source, so the developer could ship the XPI plus package.json and submit it as a
// standard third-party-library (vendoring) review instead. The source submission is redundant;
// the build script can still be used locally. The response points at the vendoring guide.
//
// The classification is produced once in setup (analyzeBuild -> addon.buildFiles.buildReview);
// this check reads it. `classification === "sca-redundant"` -> error (its {{explanation}} is the
// model's reason).
//
// Belongs here: mapping the stored classification to a finding. Does NOT belong here: the analysis
// (-> src/build/analyze.js) or the wording (-> assets/registry.yaml).

import { finding } from "../../report/finding.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {import("../../report/finding.js").Finding[]}
   */
  run(ctx) {
    const review = ctx.addon?.buildReview;
    if (review?.classification !== "sca-redundant") {
      return [];
    }
    const anchor = review.anchor ?? "package.json";
    const explanation = typeof review.reason === "string" ? review.reason : "";
    ctx.note?.(anchor, null, "the source submission is not needed", "fail");
    return [finding({ file: anchor, data: { explanation } })];
  },
};
