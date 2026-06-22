// Producer of the declared permissions that warrant a closer look: every named
// permission the manifest declares that a reachable API call does NOT provably
// require. It runs in the main loop and schedules each as a manual-review
// escalation, anchored to its manifest.json line; same-bodied escalations
// auto-group into one "review these permissions" reminder.
//
// When --full-summary is on, the orchestrator does not add these to manual review
// directly: this check declares `post-summary-recheck: unused-permission`, so its
// escalations are handed to the unused-permission consumer, which re-judges each
// against the whole add-on (see src/checks/lib/recheck.js and runChecks). Without
// the summary they fall to manual review as the grouped reminder, as before.
//
// A permission a reachable API call provably requires (usedPermissions in
// lib/permissions.js) is definitely used, so it is dropped here and never reaches
// the consumer. Host match patterns are minimize-host-permissions' concern and are
// skipped.
//
// Belongs here: enumerating the unprovable named permissions. Does NOT belong
// here: the reminder wording (-> assets/registry.yaml), or re-judging them with
// the summary (-> the unused-permission consumer via src/checks/lib/recheck.js).

import { asArray, isMatchPattern, manifestTokenLine } from "../lib/util.js";
import { getPermissionAnalysis } from "../lib/permissions.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

// Permissions that gate no callable API, so static analysis can never prove use;
// they are justified by their mere presence and must not be flagged unused.
const NO_API_GATE = new Set(["unlimitedStorage"]);

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: [], escalations:
   *   {item: string, file: string, loc: ?object}[]}}
   */
  run(ctx) {
    // List each declared named permission the reviewer must check - except those
    // a reachable API call provably requires (deterministically used, not a manual
    // case) and host match patterns (minimize-host-permissions' concern).
    const used = getPermissionAnalysis(ctx).usedPermissions;
    const m = ctx.addon?.manifest ?? {};
    const text = ctx.addon?.files?.get("manifest.json")?.toString("utf8");
    const seen = new Set();
    const escalations = [];
    for (const list of [m.permissions, m.optional_permissions]) {
      for (const p of asArray(list)) {
        if (typeof p !== "string" || isMatchPattern(p) || seen.has(p)) {
          continue;
        }
        seen.add(p);
        const line = manifestTokenLine(text, p);
        const loc = line ? { line } : null;
        if (used.has(p) || NO_API_GATE.has(p)) {
          // A reachable call requires it, or it gates no callable API (always
          // justified) - either way not a manual case.
          ctx.note?.("manifest.json", loc, p, "pass");
          continue;
        }
        ctx.note?.("manifest.json", loc, p, "unsure");
        escalations.push({ item: p, file: "manifest.json", loc });
      }
    }
    return { findings: [], escalations };
  },
};
