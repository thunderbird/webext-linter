// Turns the --full-summary LLM pass's structured unused-permission list into
// Issues. That pass (src/checks/summaries.js -> ctx.llm.reviewAddon) judges every
// declared permission and stores the unused/unsure subset on
// ctx.addon.unusedPermissions; this check only reads it and emits a finding or a
// manual-review escalation per entry. It makes no LLM call of its own.
//
// The orchestrator runs it AFTER the add-on summary (so the list exists) rather
// than in the main loop - see src/pipeline.js reviewAddon. It always runs and
// reads the checks memory: when it holds entries they are evaluated, otherwise
// (no analysis ran: no token / no --full-summary / LLM error) there is nothing to
// evaluate, so it logs a `skipped` note. Its mirror, unused-permission-manual,
// raises the by-hand reminder in exactly that no-list case.
//
//   - status "unused" -> a warning finding (the model is confident it is not
//     needed); the developer-facing wording is the registry "response".
//   - status "unsure" -> a manual-review escalation (the model could not tell);
//     the registry "instructions" message is its text.
//
// The model's per-entry reason rides along as data.reason, filling the {{reason}}
// slot in both the finding response and the manual instructions.
//
// Belongs here: mapping each stored entry to a finding / escalation and a feed
// note. Does NOT belong here: producing the list (-> src/checks/summaries.js via
// the LLM), the wording (-> assets/registry.yaml), or routing the escalation to
// manual review (-> src/checks/escalation.js via the orchestrator).

import { finding } from "../../report/finding.js";
import { manifestKeyLine } from "../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[],
   *   escalations: {item: string, data: {reason: string}}[]}}
   */
  run(ctx) {
    const entries = ctx.addon?.unusedPermissions;
    if (!Array.isArray(entries) || !entries.length) {
      // No analysis produced a list (or it found none), so there is nothing to
      // evaluate. The unused-permission-manual mirror handles the reminder.
      ctx.note?.(
        "manifest.json",
        null,
        "no permission list to evaluate",
        "skipped"
      );
      return { findings: [], escalations: [] };
    }
    const text = ctx.addon.files.get("manifest.json")?.toString("utf8") ?? "";
    const findings = [];
    const escalations = [];
    for (const { permission, status, reason } of entries) {
      if (!permission) {
        continue;
      }
      const line = manifestKeyLine(text, permission);
      const loc = line ? { line } : undefined;
      const data = { reason: reason ?? "" };
      if (status === "unused") {
        ctx.note?.("manifest.json", loc, permission, "fail");
        findings.push(
          finding({ file: "manifest.json", loc, item: permission, data })
        );
      } else {
        // "unsure" (the only other status coerceReview emits): a human decides.
        ctx.note?.("manifest.json", loc, permission, "unsure");
        escalations.push({ item: permission, data });
      }
    }
    return { findings, escalations };
  },
};
