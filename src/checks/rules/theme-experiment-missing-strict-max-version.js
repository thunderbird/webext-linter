// A theme experiment (declares theme_experiment) must pin a strict_max_version.
// Its stylesheet styles Thunderbird's internal user interface, which changes
// between major Thunderbird versions, so without a maximum it breaks silently
// on upgrade. Silent for add-ons without a theme experiment, for theme
// experiments that already declare a max, and for an add-on that is also an
// Experiment, which experiment-missing-strict-max-version reports.
//
// Belongs here: flagging a theme experiment that omits strict_max_version.
// Does NOT belong here: detecting theme experiment status or reading the max
// version (-> isThemeExperiment and strictMaxVersion in src/lib/util.js).
// Requiring a max version on an Experiment (->
// experiment-missing-strict-max-version.js). Flagging a strict_max_version on
// an add-on that needs none (-> non-experiment-strict-max-version.js).
// Authored wording (-> assets/registry.yaml). Severity (-> the
// theme-experiment-missing-strict-max-version registry entry, stamped by
// src/checks/registry.js).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import {
  isExperiment,
  isThemeExperiment,
  strictMaxVersion,
  skipWithoutManifest,
} from "../../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const m = ctx.manifest?.json;
    if (!m) {
      return skipWithoutManifest(ctx);
    }
    if (!isThemeExperiment(m)) {
      ctx.note?.(
        ctx.manifest.locus(),
        "not a theme experiment",
        VERDICT.SKIPPED
      );
      return { findings: [] };
    }
    if (isExperiment(m)) {
      ctx.note?.(ctx.manifest.locus(), "is an Experiment", VERDICT.SKIPPED);
      return { findings: [] };
    }
    const max = strictMaxVersion(m);
    if (max != null) {
      ctx.note?.(
        ctx.manifest.locus(),
        `theme experiment pins strict_max_version ${max}`,
        VERDICT.PASS
      );
      return { findings: [] };
    }
    ctx.note?.(
      ctx.manifest.locus(),
      "theme experiment lacks strict_max_version",
      VERDICT.FAIL
    );
    return { findings: [finding({ ...ctx.manifest.locus() })] };
  },
};
