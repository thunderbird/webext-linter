// A non-Experiment should NOT pin strict_max_version. Regular MailExtensions
// stay forward-compatible, so a maximum version only blocks installs on newer
// Thunderbird with no benefit. Silent for Experiments and theme experiments
// (which need one) and for other add-ons that omit it.
//
// Belongs here: flagging a strict_max_version declared by an add-on that is
// neither an Experiment nor a theme experiment.
// Does NOT belong here: detecting Experiment or theme experiment status or
// reading the max version (-> needsStrictMax and strictMaxVersion in
// src/lib/util.js). Requiring a max version on an Experiment (->
// experiment-missing-strict-max-version.js) or on a theme experiment (->
// theme-experiment-missing-strict-max-version.js).
// Authored wording (-> assets/registry.yaml). Severity (-> the non-
// experiment-strict-max-version registry entry, stamped by src/checks/
// registry.js).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import {
  needsStrictMax,
  strictMaxVersion,
  strictMaxVersionPath,
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
    if (needsStrictMax(m)) {
      ctx.note?.(
        ctx.manifest.locus(),
        "is an Experiment or a theme experiment",
        VERDICT.SKIPPED
      );
      return { findings: [] };
    }
    const max = strictMaxVersion(m);
    if (max == null) {
      ctx.note?.(ctx.manifest.locus(), "no strict_max_version", VERDICT.PASS);
      return { findings: [] };
    }
    ctx.note?.(
      ctx.manifest.locus(),
      `strict_max_version ${max} on a non-Experiment`,
      VERDICT.FAIL
    );
    return {
      findings: [
        finding({
          ...ctx.manifest.locus(...(strictMaxVersionPath(m) ?? [])),
          item: String(max),
        }),
      ],
    };
  },
};
