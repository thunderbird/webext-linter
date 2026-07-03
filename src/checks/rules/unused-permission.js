// The post-summary recheck consumer for declared permissions. The producer
// (unused-permission-manual) hands over every declared named permission a reachable
// API call does not provably require; the divert (registry.rechecks) keeps only the
// ones the registry has a rubric prompt for and the rest stay manual. When
// --full-summary runs, the kept items are appended to the add-on summary under a
// rubric the assembler builds from the permission-prompt-framing + permission-prompts
// sections (choosing the tabs variant by the add-on's strict_min_version). The model
// returns a verdict per permission, and this check maps each: pass -> justified
// (drop), fail -> a warning finding ("{{item}} appears unused"), unsure or no verdict
// -> manual review. The model's per-permission reason rides along as data.reason.
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
