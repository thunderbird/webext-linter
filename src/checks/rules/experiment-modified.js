// Flags a bundled Experiment that IS a recognised published Thunderbird API
// draft but is not the unmodified latest version (locally modified or an older
// draft). Such a submission stays on the normal review path (so the developer
// gets full feedback) but is rejected by this error until they bundle the
// unmodified latest upstream copy. Silent for non-Experiments, pristine
// experiments, and unsupported ones (no upstream draft exists to compare against).
//
// Belongs here: turning the per-experiment classification
// (ctx.experiments, from src/experiments/verify.js) into one finding per
// `modified` experiment. Does NOT belong here: classifying the files
// (src/experiments/verify.js), authored wording (assets/registry.yaml), or
// severity (that registry entry).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { isExperiment } from "../../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const m = ctx.manifest?.json;
    if (!m || !isExperiment(m)) {
      ctx.note?.(ctx.manifest.locus(), "not an Experiment", VERDICT.SKIPPED);
      return { findings: [] };
    }
    const groups = ctx.experiments?.groups;
    if (!Array.isArray(groups)) {
      ctx.note?.(
        ctx.manifest.locus(),
        "no experiment classification",
        VERDICT.SKIPPED
      );
      return { findings: [] };
    }
    const findings = [];
    for (const g of groups) {
      const at = ctx.manifest.locus("experiment_apis", g.key);
      if (g.status === "modified") {
        ctx.note?.(at, `${g.name} (modified draft)`, VERDICT.FAIL);
        findings.push(finding({ ...at, item: g.name }));
      } else if (g.status === "pristine") {
        ctx.note?.(at, g.name, VERDICT.PASS);
      } else {
        // unsupported: not a known upstream draft, so there is nothing to
        // compare against - this check has no say (experiment-not-allowed does).
        ctx.note?.(
          at,
          `${g.name} (not a known upstream draft)`,
          VERDICT.SKIPPED
        );
      }
    }
    return { findings };
  },
};
