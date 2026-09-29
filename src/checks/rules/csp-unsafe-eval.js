// The manifest.json content_security_policy allows 'unsafe-eval', which permits
// dynamic code execution - not allowed.
//
// Belongs here: emitting the finding when the CSP allows 'unsafe-eval'. Does NOT
// belong here: CSP parsing (-> src/scan/csp.js via getEvalScan in
// src/lib/eval-scan.js), authored wording (-> assets/registry.yaml), and
// severity (-> that registry entry).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { getEvalScan } from "../../lib/eval-scan.js";

export default {
  run(ctx) {
    if (!getEvalScan(ctx).unsafeEval) {
      return { findings: [] };
    }
    ctx.note?.(ctx.manifest.locus(), "CSP 'unsafe-eval'", VERDICT.FAIL);
    return {
      findings: [
        finding({
          ...ctx.manifest.locus("content_security_policy"),
        }),
      ],
    };
  },
};
