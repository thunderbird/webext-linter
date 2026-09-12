// Code whose source may be remote is executed dynamically - the
// statically-undecidable fetch().then(eval) pattern. Whether the executed code
// is remote cannot be decided from the source, so each occurrence escalates to a
// reviewer. The definite dynamic-execution cases are separate deterministic
// checks (eval-call, function-constructor, string-timer, csp-unsafe-eval,
// csp-unsafe-inline).
//
// Belongs here: one escalation per ambiguous fetch().then(eval) hit. Does NOT
// belong here: the scan (-> getEvalScan in src/lib/eval-scan.js), the
// deterministic->manual routing (-> src/checks/registry.js +
// src/checks/escalation.js), and authored wording (-> assets/registry.yaml).

import { VERDICT } from "../../lib/enum.js";
import { getEvalScan } from "../../lib/eval-scan.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: [], escalations:
   *   import("../escalation.js").Escalation[]}}
   */
  run(ctx) {
    const escalations = [];
    for (const hit of getEvalScan(ctx).hits) {
      if (hit.type !== "ambiguous-fetch-eval") {
        continue;
      }
      const loc = { line: hit.line, column: hit.column };
      escalations.push({
        file: hit.file,
        loc,
        item: `${hit.file}:${hit.line}`,
      });
      ctx.note?.(hit.file, loc, "fetch().then(eval)", VERDICT.UNSURE);
    }
    return { findings: [], escalations };
  },
};
