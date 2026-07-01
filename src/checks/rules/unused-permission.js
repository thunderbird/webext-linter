// The post-summary recheck consumer for declared permissions on the POST-D308076
// path (strict_min_version >= Thunderbird 154). The producer
// (unused-permission-manual) hands over every declared named permission a
// reachable API call does not provably require. (The pre-154 path is the sibling
// pair unused-permission-manual-pre-d308076 -> unused-permission-pre-d308076,
// with a more relaxed tabs rubric; exactly one pair fires per add-on.)
// When --full-summary runs, those items are appended to the add-on summary under
// this entry's `summary-prompt`
// rubric; the model returns a verdict per permission, and this check maps each:
// pass -> justified (drop), fail -> a warning finding ("{{item}} appears unused"),
// unsure or no verdict -> manual review. The model's per-permission reason rides
// along as data.reason for the {{reason}} slot in both texts.
//
// It makes no decision of its own: the mapping is the shared resolveRecheck
// (src/checks/lib/recheck.js), driven by ctx.recheck (the handed-over items) and
// ctx.recheckVerdicts (the summary's verdicts). It runs in the post-summary phase
// because it is named as unused-permission-manual's post-summary-recheck target
// (the orchestrator infers the phase from that reference). With no summary nothing
// is handed over, so it emits nothing and the producer's reminder stands.
//
// Belongs here: only the delegation. Does NOT belong here: enumerating the
// permissions (-> unused-permission-manual), the wording (-> assets/registry.yaml),
// or the verdict mapping (-> src/checks/lib/recheck.js).

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
