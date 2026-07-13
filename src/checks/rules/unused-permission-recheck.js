// The post-summary recheck consumer for declared permissions. The producer
// (unused-permission) hands over every declared named permission it could neither
// prove used nor deterministically prove unused; the divert (registry.rechecks)
// keeps only the ones the registry has a rubric prompt for and the rest stay
// manual. When --llm-review runs, the kept items are appended to the add-on
// summary under a rubric the assembler builds from the permission-prompt-framing
// + permission-prompts sections (choosing the tabs variant by the add-on's
// strict_min_version). The model returns a verdict per permission, and this check
// maps each: pass -> justified (drop), fail -> a warning finding, unsure or no
// verdict -> manual review. The model's per-permission reason rides along as
// data.reason.
//
// It makes no decision of its own: the mapping is the shared resolveRecheck
// (src/lib/recheck.js), driven by ctx.recheck (the handed-over items) and
// ctx.recheckVerdicts (the summary's verdicts). It runs in the post-summary phase
// because it is named as unused-permission's post-summary-recheck target
// (the orchestrator infers the phase from that reference). With no summary nothing
// is handed over, so it emits nothing and the producer's reminder stands.
//
// Belongs here: only the delegation. Does NOT belong here: enumerating the
// permissions and the deterministic token verdicts (-> unused-permission), the
// wording and tokens (-> assets/registry.yaml), or the verdict mapping
// (-> src/lib/recheck.js).

import { resolveRecheck } from "../../lib/recheck.js";

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
