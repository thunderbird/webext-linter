// Flags a pinned package.json dependency whose bundled version has known
// security advisories. The OSV audit ran once in the network pre-step
// (src/vendor/verify.js auditPackage), which recorded each vulnerable package on
// addon.vendor.vulnerabilities; this check only reads that and emits a finding per
// vulnerable package, anchored at its package.json dependency line. Deterministic,
// no network.
//
// The registry entry is severity:auto, so this check sets each finding's severity
// from the advisory's OSV band (its registry severity is delegated here): high /
// critical -> error, moderate / medium -> warning, everything else (low / unknown)
// -> info. Every recorded vulnerability is reported; none are dropped.
//
// Belongs here: turning each recorded vulnerability into a finding (+ a feed
// note), and mapping its band to a finding severity. Does NOT belong here: the OSV
// query/parse (-> src/vendor/verify.js), the pinned-version resolution
// (-> src/vendor/resolve.js + src/vendor/locks.js), and the wording
// (-> assets/registry.yaml).

import { finding, SEVERITY } from "../../report/finding.js";
import { manifestTokenLine } from "../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../../report/finding.js").Severity} Severity */

/**
 * Map an OSV/GHSA severity band to a finding severity. GHSA labels the middle
 * band "moderate" while raw CVSS calls it "medium"; both map to warning. Anything
 * not high/critical/moderate/medium (low, unknown, an unrecognized label) is
 * informational - reported, but neither an error nor a warning.
 * @param {string} band  The recorded OSV band (auditPackage lowercases it).
 * @returns {Severity}
 */
function severityForBand(band) {
  switch (String(band).toLowerCase()) {
    case "critical":
    case "high":
      return SEVERITY.ERROR;
    case "moderate":
    case "medium":
      return SEVERITY.WARNING;
    default:
      return SEVERITY.INFO;
  }
}

export default {
  /**
   * @param {RunContext} ctx
   * @returns {import("../../report/finding.js").Finding[]}
   */
  run(ctx) {
    const { addon } = ctx;
    const vulns = addon?.vendor?.vulnerabilities ?? [];
    const text = addon.files?.get("package.json")?.toString("utf8") ?? "";
    const findings = [];
    for (const { name, version, ids, severity, fixed } of vulns) {
      const line = manifestTokenLine(text, name);
      const loc = line ? { line } : undefined;
      ctx.note?.(
        "package.json",
        loc,
        `${name}@${version} has known vulnerabilities (${ids.join(", ")})`,
        "fail"
      );
      findings.push(
        finding({
          file: "package.json",
          loc,
          item: name,
          // severity:auto - this check owns the finding's severity (mapped from
          // the band); the raw band string still fills the {{severity}} response
          // slot via data.severity.
          severity: severityForBand(severity),
          data: {
            version,
            ids: ids.join(", "),
            severity,
            fixed: fixed.length ? fixed.join(", ") : "a patched release",
          },
        })
      );
    }
    return findings;
  },
};
