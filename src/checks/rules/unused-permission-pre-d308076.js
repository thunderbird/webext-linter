// The post-summary recheck consumer for the pre-D308076 path: the producer
// unused-permission-manual-pre-d308076 (add-ons below Thunderbird 154, or with no
// parsable strict_min_version) hands over the declared permissions a reachable
// API call does not provably require. Identical mechanics to unused-permission -
// the shared resolveRecheck maps each summary verdict to justified (drop), unused
// (warning), or manual review; only the registry summary-prompt differs, keeping
// "tabs" justified whenever the code filters tabs.query by url/title anywhere
// (before D308076 that needs "tabs" even for the add-on's own pages).
//
// Belongs here: only the delegation. The verdict mapping is
// src/checks/lib/recheck.js; the wording is assets/registry.yaml.

import { resolveRecheck } from "../lib/recheck.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../registry.js").LoadedCheck} LoadedCheck */

export default {
  /**
   * @param {RunContext} ctx
   * @param {LoadedCheck} check
   * @returns {{findings: object[], escalations: object[]}}
   */
  run(ctx, check) {
    return resolveRecheck(ctx, check);
  },
};
