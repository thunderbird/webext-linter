// A JS file that failed to parse, so its API checks were skipped - a
// static-analysis coverage gap (info), reported with the parser's own error. A file
// Babel parsed but could not walk carries a parse error too (the extraction pass empties
// its scans with one) and is unanalysable-file's to report, so it is skipped here.
//
// Belongs here: turning per-file parse errors the extraction pass recorded into
// findings. Does NOT belong here: producing them (src/checks/extract.js), authored
// wording (-> assets/registry.yaml), and severity (-> that registry entry).

import { finding } from "../../report/finding.js";
import { apiUsageOf, walkFailureOf } from "../extract.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const findings = [];
    for (const src of ctx.jsSources) {
      const { parseError } = apiUsageOf(src);
      if (parseError && !walkFailureOf(src)) {
        findings.push(
          finding({
            ...ctx.artifact.at(src.file),
            data: { detail: parseError },
          })
        );
      }
    }
    return { findings };
  },
};
