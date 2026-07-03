// Producer of the declared permissions that warrant a closer look, for add-ons
// whose strict_min_version is at least Thunderbird 154 (the POST-D308076 path).
// It enumerates every named permission a reachable API call does not provably
// require and schedules each as a manual-review escalation. When --full-summary is
// on, the orchestrator hands the property/gesture-gated ones (LLM_RECHECK_PERMISSIONS,
// the only permissions the model can judge without the schema) to the
// `unused-permission` consumer to be re-judged with whole-add-on context; the rest
// stay manual (see src/checks/lib/permissions.js and src/checks/lib/recheck.js).
//
// The version gate is the only difference from its sibling
// unused-permission-manual-pre-d308076: that one produces for add-ons below 154
// (or with no parsable strict_min_version) and feeds the more relaxed
// `unused-permission-pre-d308076` consumer. Exactly one of the two fires per
// add-on, so exactly one consumer prompt is appended to the summary. The split
// exists because the same tabs.query({url}/{title}) on an add-on's OWN pages
// needs "tabs" before the D308076 fix but not after.
//
// Belongs here: the >=154 gate. The shared enumeration is
// enumerateUnusedPermissions (src/checks/lib/permissions.js); the wording is
// assets/registry.yaml; re-judging is the consumer via src/checks/lib/recheck.js.

import { strictMinAtLeast } from "../lib/util.js";
import {
  enumerateUnusedPermissions,
  D308076_FIXED_IN,
} from "../lib/permissions.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: [], escalations:
   *   {item: string, file: string, loc: ?object, recheckEligible: boolean}[]}}
   */
  run(ctx) {
    if (!strictMinAtLeast(ctx.manifest, D308076_FIXED_IN)) {
      return { findings: [], escalations: [] };
    }
    return enumerateUnusedPermissions(ctx);
  },
};
