// Heuristic: the developer's own code shipped minified or obfuscated, which
// cannot be reviewed as-is. Flags such a JS file - that is NOT a recognized
// third-party library (those are missing-library's job) - so the reviewer can
// require the original source. Detects minified line geometry, javascript-
// obfuscator "_0x" identifiers, and eval/Function-of-decoded-string packers. It
// cannot catch every obfuscator (high precision, partial recall).
//
// Belongs here: selecting the classifier verdicts that are minified or
// obfuscated AND not a library, and emitting one finding per such file.
//
// Does NOT belong here: the classification heuristics themselves (->
// src/checks/ lib/bundled.js, classifyAddonJs), the library-signal verdict and
// its finding (-> missing-library.js), authored wording (->
// assets/registry.yaml), severity (-> that registry entry, stamped by
// src/checks/registry.js), and report formatting (-> src/report/format.js).

import { finding } from "../../report/finding.js";
import { classifyAddonJs } from "../lib/bundled.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
export default {
  /**
   * @param {RunContext} ctx
   * @returns {import("../../report/finding.js").Finding[]}
   */
  run(ctx) {
    const findings = [];
    for (const c of classifyAddonJs(ctx)) {
      if (c.library) {
        continue; // a recognized library is missing-library's concern
      }
      const bad = c.minified || c.obfuscated;
      const what = c.obfuscated ? "obfuscated" : bad ? "minified" : "readable";
      ctx.note?.(c.file, null, what, bad ? "fail" : "pass");
      if (bad) {
        findings.push(finding({ file: c.file, item: c.file }));
      }
    }
    return findings;
  },
};
