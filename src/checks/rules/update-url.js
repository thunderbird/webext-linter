// A self-hosted update_url is not accepted on ATN. It directs Thunderbird to
// install the add-on's next version from a URL the developer controls, so updates
// bypass review entirely - a later version could ship unreviewed code. Rejected
// unconditionally (any manifest version), in either valid location: the current
// browser_specific_settings.gecko, or the deprecated MV2 applications.gecko alias.
// One finding per present location, at its own line.
//
// Belongs here: detecting a declared update_url. Does NOT belong here: reading the
// gecko settings block generally, authored wording (-> assets/registry.yaml), or
// severity (-> the update-url registry entry, stamped by src/checks/registry.js).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { manifestPathLine } from "../../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
export default {
  /**
   * @param {RunContext} ctx
   * @returns {import("../../report/finding.js").Finding[]}
   */
  run(ctx) {
    const m = ctx.manifest;
    if (!m) {
      ctx.note?.(
        "manifest.json",
        null,
        "manifest did not parse",
        VERDICT.SKIPPED
      );
      return [];
    }
    const findings = [];
    // Both keys hold a `gecko` block; browser_specific_settings is current,
    // applications the deprecated MV2 alias (both read, like strictMinVersion).
    for (const key of ["browser_specific_settings", "applications"]) {
      const url = m[key]?.gecko?.update_url;
      if (url == null) {
        continue;
      }
      const line = manifestPathLine(ctx, key, "gecko", "update_url");
      const loc = line ? { line } : null;
      ctx.note?.(
        "manifest.json",
        loc,
        `update_url in ${key}.gecko`,
        VERDICT.FAIL
      );
      findings.push(finding({ file: "manifest.json", loc, item: url }));
    }
    if (!findings.length) {
      ctx.note?.("manifest.json", null, "no update_url", VERDICT.PASS);
    }
    return findings;
  },
};
