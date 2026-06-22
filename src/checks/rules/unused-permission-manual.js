// The by-hand reminder mirror of unused-permission. The --full-summary LLM pass
// stores its verdict list on ctx.addon.unusedPermissions; when that analysis
// did NOT run (no --full-summary, no token, or the LLM call errored) the key is
// never set, so nothing assessed the declared permissions and the reviewer
// should check them by hand. This check raises that one generic reminder.
//
// It always runs (after the add-on summary, like unused-permission) and reads
// the same checks memory:
//   - a list is present (Array.isArray) -> the permissions were assessed, so the
//     reminder is not needed: log a `skipped` note and emit nothing.
//   - no list -> escalate one manual-review case per declared named permission
//     the add-on does not PROVABLY use, each anchored to its manifest.json line,
//     so the report lists only the permissions the reviewer must vet by hand
//     (the registry "Unused permissions" instructions name no specific one;
//     auto-group lists them). A permission a reachable API call requires
//     (usedPermissions in lib/permissions.js) is definitely used, so it is
//     dropped from the list.
//
// Belongs here: the present-or-not decision and enumerating the permissions.
// Does NOT belong here: the reminder wording (-> assets/registry.yaml),
// producing the list (-> src/checks/summaries.js via the LLM), or the
// per-permission Issues (-> src/checks/rules/unused-permission.js).

import { asArray, isMatchPattern, manifestTokenLine } from "../lib/util.js";
import { getPermissionAnalysis } from "../lib/permissions.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: [], escalations:
   *   {item: string, file: string, loc: ?object}[]}}
   */
  run(ctx) {
    if (Array.isArray(ctx.addon?.unusedPermissions)) {
      // The permissions were assessed (a list, even an empty one, was produced).
      ctx.note?.(
        "manifest.json",
        null,
        "permissions assessed automatically",
        "skipped"
      );
      return { findings: [], escalations: [] };
    }
    // No automated analysis: list each declared named permission the reviewer
    // must check by hand - except those a reachable API call provably requires
    // (deterministically used, so not worth a manual case) and host match
    // patterns (minimize-host-permissions' concern).
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
        if (used.has(p)) {
          // A reachable API call needs it - definitely used, not a manual case.
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
