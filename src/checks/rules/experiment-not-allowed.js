// New submissions may not use Experiment APIs unless the reviewer enables them
// with --allow-experiments. When experiments are disabled (the default) and the
// add-on declares experiment_apis, error on the experiment_apis manifest line.
// Silent when experiments are allowed or the add-on is not an Experiment.
//
// Belongs here: rejecting an Experiment when experiments are NOT allowed, and
// locating the experiment_apis line for the finding.
//
// Does NOT belong here: detecting Experiment status (-> isExperiment in src/
// checks/lib/util.js) or finding a manifest key's line (-> manifestTokenLine in
// the same file). Requiring a strict_max_version on an ALLOWED Experiment (->
// experiment-missing-strict-max-version.js). Authored wording (->
// assets/review- registry.yaml). Severity, here an error (-> the
// experiment-not-allowed registry entry, stamped by src/checks/registry.js).

import { finding } from "../../report/finding.js";
import { isExperiment, manifestTokenLine } from "../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
export default {
  /**
   * @param {RunContext} ctx
   * @returns {import("../../report/finding.js").Finding[]}
   */
  run(ctx) {
    const m = ctx.addon.manifest;
    if (!m) {
      ctx.note?.("manifest.json", null, "manifest did not parse", "skipped");
      return [];
    }
    if (!isExperiment(m)) {
      ctx.note?.("manifest.json", null, "not an Experiment", "pass");
      return [];
    }
    if (ctx.options?.allowExperiments) {
      ctx.note?.(
        "manifest.json",
        null,
        "experiments allowed (--allow-experiments)",
        "skipped"
      );
      return [];
    }
    const text = ctx.addon.files.get("manifest.json")?.toString("utf8") ?? "";
    const line = manifestTokenLine(text, "experiment_apis");
    const loc = line ? { line, column: 0 } : null;
    ctx.note?.("manifest.json", loc, "experiment_apis declared", "fail");
    return [finding({ file: "manifest.json", loc })];
  },
};
