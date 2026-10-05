// An Experiment schema Thunderbird cannot read. At install Thunderbird reads every
// experiment_apis entry's `schema` file and refuses the whole add-on when one is not UTF-8 /
// UTF-16 text or not JSON as its loader reads it. One finding per packaged schema file it
// cannot read. A declared schema that is not packaged at all is bundled-files' ("Missing
// referenced file"), so it is not reported twice.
//
// Belongs here: which declared, packaged schema files cannot be read. Does NOT belong here:
// reading what a readable schema declares (-> src/lib/experiments.js), wording and severity
// (-> assets/registry.yaml).

import { VERDICT } from "../../lib/enum.js";
import { asObject } from "../../lib/util.js";
import { resolveRef } from "../../lib/manifest-refs.js";
import { finding } from "../../report/finding.js";
import { parseExtensionJson } from "../../util/json.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const findings = [];
    const reported = new Set();
    for (const def of Object.values(
      asObject(ctx.manifest.json?.experiment_apis)
    )) {
      const declared = asObject(def).schema;
      if (typeof declared !== "string") {
        continue;
      }
      // Resolved as Thunderbird resolves it (against the add-on root, `.` and `..`
      // collapsed) - the resolver bundled-files asks whether it is packaged at all.
      const file = resolveRef(ctx.artifact.files, null, declared);
      if (!file || reported.has(file)) {
        continue;
      }
      const bytes = ctx.artifact.files.get(file);
      if (parseExtensionJson(bytes) === undefined) {
        reported.add(file);
        ctx.note?.(ctx.artifact.at(file), "cannot be read", VERDICT.FAIL);
        findings.push(finding({ ...ctx.artifact.at(file) }));
      }
    }
    return { findings };
  },
};
