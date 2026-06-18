// Heuristic bundled third-party library detection (no hash database, so it
// cannot say WHICH library or verify the version - see the README). Flags a JS
// file - not declared in VENDOR.md - that looks like a distributed library by a
// minifier "/*! ... */" banner, a UMD/AMD wrapper, a *.min.js name, or a known
// library filename, so the developer links its source / declares it. Minified
// or obfuscated code WITHOUT those library signals is obfuscated-code's job.
//
// Belongs here: selecting the classifier verdicts flagged as library, and
// emitting one finding per such file.
//
// Does NOT belong here: the library-signal heuristics and the VENDOR.md
// declaration check (-> src/checks/lib/bundled.js, classifyAddonJs), the
// minified/obfuscated-without-library-signals verdict (-> obfuscated-code.js),
// authored wording (-> assets/registry.yaml), severity (-> that registry
// entry, stamped by src/checks/registry.js), and report formatting (-> src/
// report/format.js).

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
      ctx.note?.(
        c.file,
        null,
        c.library ? "bundled library" : "not a library",
        c.library ? "fail" : "pass"
      );
      if (c.library) {
        findings.push(finding({ file: c.file }));
      }
    }
    return findings;
  },
};
