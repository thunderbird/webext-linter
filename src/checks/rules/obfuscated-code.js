// Heuristic: the developer's own code shipped obfuscated - deliberately hidden
// behavior that cannot be reviewed as-is. Flags such a JS file - that is NOT a
// recognized third-party library (those are missing-library's job) - so the
// reviewer can require the original source. Detects javascript-obfuscator "_0x"
// identifiers and eval/Function-of-decoded-string packers. It cannot catch every
// obfuscator (high precision, partial recall). A file that is merely minified
// (not obfuscated) is minified-code's job; a file that is both is reported here,
// since obfuscation is the stronger signal.
//
// Belongs here: selecting the classifier verdicts that are obfuscated AND not a
// library, and emitting one finding per such file.
//
// Does NOT belong here: the classification heuristics themselves (->
// src/checks/ lib/bundled.js, classifyAddonJs), the library-signal verdict and
// its finding (-> missing-library.js), the minified-only verdict (->
// minified-code.js), authored wording (-> assets/registry.yaml), severity (->
// that registry entry, stamped by src/checks/registry.js), and report
// formatting (-> src/report/format.js).

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
      // A merely-minified (not obfuscated) file is minified-code's finding; here
      // it notes a pass. Only an obfuscated file is flagged.
      ctx.note?.(
        c.file,
        null,
        c.obfuscated ? "obfuscated" : "readable",
        c.obfuscated ? "fail" : "pass"
      );
      if (c.obfuscated) {
        findings.push(finding({ file: c.file }));
      }
    }
    return findings;
  },
};
