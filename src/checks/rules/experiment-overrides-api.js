// An Experiment may only ADD new APIs - it must not override a built-in
// Thunderbird API or graft a new member onto a built-in namespace. For each
// experiment_apis-declared API path, resolve it against the schema: a genuinely
// new API is "experiment" (registered) or "unknown-namespace" (top-level absent
// from the real schema); anything else means the path collides with a built-in,
// which is a violation.
//
// Belongs here: deciding which declared experiment API paths collide with a
// built-in, and locating the experiment_apis line. Does NOT belong here:
// detecting Experiment status (-> isExperiment), parsing experiment_apis (->
// experimentApiPaths in src/checks/lib/experiments.js), schema resolution (->
// SchemaIndex.resolveApi), wording (-> assets/registry.yaml), or severity (->
// that registry entry, stamped by src/checks/registry.js).

import { finding } from "../../report/finding.js";
import { isExperiment, manifestTokenLine } from "../lib/util.js";
import { experimentApiPaths } from "../lib/experiments.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
export default {
  /**
   * @param {RunContext} ctx
   * @returns {import("../../report/finding.js").Finding[]}
   */
  run(ctx) {
    const m = ctx.addon.manifest;
    if (!m || !isExperiment(m)) {
      ctx.note?.("manifest.json", null, "not an Experiment", "skipped");
      return [];
    }
    const { schema } = ctx;
    const text = ctx.addon.files.get("manifest.json")?.toString("utf8") ?? "";
    const line = manifestTokenLine(text, "experiment_apis");
    const loc = line ? { line, column: 0 } : null;

    const findings = [];
    for (const apiPath of experimentApiPaths(m)) {
      const kind = schema.resolveApi(apiPath.split(".")).kind;
      // Genuinely new (adds an API) -> fine. Anything else resolves to / grafts
      // onto a built-in -> the experiment overrides a built-in API.
      if (kind === "experiment" || kind === "unknown-namespace") {
        ctx.note?.("manifest.json", loc, apiPath, "pass");
        continue;
      }
      ctx.note?.(
        "manifest.json",
        loc,
        `${apiPath} (overrides built-in)`,
        "fail"
      );
      findings.push(finding({ file: "manifest.json", loc, item: apiPath }));
    }
    return findings;
  },
};
