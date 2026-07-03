// Producer of the declared permissions that warrant a closer look, for add-ons
// that still run on Thunderbird before the D308076 fix: strict_min_version below
// 154, or absent/unparsable (treated as possibly-old, the relaxed default). The
// sibling unused-permission-manual covers >=154. Exactly one of the two fires per
// add-on; this one feeds the `unused-permission-pre-d308076` consumer, whose
// prompt keeps "tabs" justified whenever the code filters tabs.query by url or
// title anywhere - because before D308076, that needs "tabs" even on the add-on's
// own moz-extension:// pages.
//
// Same enumeration as its sibling (enumerateUnusedPermissions); only the version
// gate is the negation. See unused-permission-manual.js for the full rationale.
//
// Belongs here: the <154 gate. The shared enumeration is
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
    if (strictMinAtLeast(ctx.manifest, D308076_FIXED_IN)) {
      return { findings: [], escalations: [] };
    }
    return enumerateUnusedPermissions(ctx);
  },
};
