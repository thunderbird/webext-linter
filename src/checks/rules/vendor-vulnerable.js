// Flags a pinned npm library whose bundled version has known security
// advisories - a package.json dependency OR an npm-sourced VENDOR entry. The OSV
// audit ran once in the network pre-step (src/vendor/verify.js auditNpm), which
// recorded each vulnerable package on addon.vendor.vulnerabilities with the file
// + token to anchor it; this check only reads that and emits a finding per
// vulnerable package, anchored at its declaration line (the package.json
// dependency, or the VENDOR-file source line). Deterministic, no network.
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
import { manifestTokenLine, lineContaining } from "../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../../report/finding.js").Severity} Severity */

/**
 * Map an OSV/GHSA severity band to a finding severity. GHSA labels the middle
 * band "moderate" while raw CVSS calls it "medium"; both map to warning. Anything
 * not high/critical/moderate/medium (low, unknown, an unrecognized label) is
 * informational - reported, but neither an error nor a warning.
 * @param {string} band  The recorded OSV band (auditNpm lowercases it).
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
    const textByFile = new Map();
    const fileText = (file) => {
      if (!textByFile.has(file)) {
        textByFile.set(file, addon.files?.get(file)?.toString("utf8") ?? "");
      }
      return textByFile.get(file);
    };
    const findings = [];
    for (const { name, version, ids, severity, fixed, file, token } of vulns) {
      const text = fileText(file);
      // A quoted JSON token (a package.json dep name) or a plain substring (the
      // VENDOR-file source URL) - whichever locates the declaration line.
      const line =
        manifestTokenLine(text, token) ?? lineContaining(text, token);
      const loc = line ? { line } : undefined;
      ctx.note?.(
        file,
        loc,
        `${name}@${version} has known vulnerabilities (${ids.join(", ")})`,
        "fail"
      );
      findings.push(
        finding({
          file,
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
