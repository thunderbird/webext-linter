// The developer's own code shipped obfuscated - deliberately hidden behavior that
// cannot be reviewed as-is. Flags such a JS file - that is NOT a recognized
// third-party library (those are missing-library's job) - so the reviewer can
// require the original source. Obfuscation is recognized structurally, by the AST
// shape of a known obfuscator family (see src/lib/obfuscation.js); it cannot
// catch every obfuscator (high precision, partial recall). Every match is a
// deterministic finding: the families it is drawn from are pinned there precisely so
// that a match needs no second opinion, and their names appear only in the --verbose
// log. A file that is merely minified (not obfuscated) is minified-code's job; a file
// that is both is reported here, since obfuscation is the stronger signal.
//
// Belongs here: selecting the classifier verdicts that are obfuscated AND not a
// library, and emitting one finding per such file.
//
// Does NOT belong here: the classification heuristics themselves (->
// src/checks/ lib/bundled.js, classifyAddonJs), the library-signal verdict and
// its finding (-> missing-library.js), the minified-only verdict (->
// minified-code.js), authored wording (-> assets/registry.yaml), severity (-> that
// registry entry, stamped by src/checks/registry.js), and report formatting (->
// src/report/format.js).

import { finding } from "../../report/finding.js";
import { classifyAddonJs, classifyInlineScripts } from "../../lib/bundled.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const findings = [];
    for (const c of classifyAddonJs(ctx)) {
      if (c.library || c.untrusted) {
        // a recognized library is missing-library's concern; an untrusted (not-popular)
        // identified match is untrusted-library / untrusted-minified-library's.
        continue;
      }
      // A merely-minified (not obfuscated) file is minified-code's finding; here
      // it notes a pass. Only an obfuscated file is flagged.
      ctx.note?.(
        c.file,
        null,
        c.obfuscation.fail ? "obfuscated" : "readable",
        c.obfuscation
      );
      if (c.obfuscation.fail) {
        findings.push(finding({ file: c.file }));
      }
    }
    // The same question, asked of an inline <script>: its body ships and runs
    // like a file's, and classifyAddonJs only tags files. No library/untrusted branch
    // here - those come from hashing a FILE, so an inline body is always the
    // developer's own code (see classifyInlineScripts).
    for (const site of classifyInlineScripts(ctx)) {
      // The LINE is what distinguishes two scripts in one page: without it both
      // bodies render as the same subject and the reader cannot tell which one the
      // finding means.
      ctx.note?.(
        site.file,
        site.loc,
        site.obfuscation.fail ? "obfuscated" : "readable",
        site.obfuscation
      );
      if (site.obfuscation.fail) {
        findings.push(finding({ file: site.file, loc: site.loc }));
      }
    }
    return { findings };
  },
};
