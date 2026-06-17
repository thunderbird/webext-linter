// The by-hand reminder mirror of unused-permission. The --full-summary LLM pass
// stores its verdict list on ctx.addon.unusedPermissions; when that analysis did
// NOT run (no --full-summary, no token, or the LLM call errored) the key is never
// set, so nothing assessed the declared permissions and the reviewer should check
// them by hand. This check raises that one generic reminder.
//
// It always runs (after the add-on summary, like unused-permission) and reads the
// same checks memory:
//   - a list is present (Array.isArray) -> the permissions were assessed, so the
//     reminder is not needed: log a `skipped` note and emit nothing.
//   - no list -> escalate one manual-review case (item: null), whose text is the
//     registry "Unused permissions" entry's instructions (which name no specific
//     permission).
//
// Belongs here: the present-or-not decision and the single escalation. Does NOT
// belong here: the reminder wording (-> assets/registry.yaml), producing the list
// (-> src/checks/summaries.js via the LLM), or the per-permission Issues
// (-> src/checks/rules/unused-permission.js).

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: [], escalations: {item: null}[]}}
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
    // No automated analysis: remind the reviewer to check by hand. A null item, so
    // the registry instructions (which carry no {{item}}) render verbatim.
    ctx.note?.(
      "manifest.json",
      null,
      "review unused permissions by hand",
      "unsure"
    );
    return { findings: [], escalations: [{ item: null }] };
  },
};
