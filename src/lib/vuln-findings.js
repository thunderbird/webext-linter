// Shared vulnerability->finding mapping for the four dependency-vulnerability
// checks, one per (declared vs pulled in) x (shipped vs build-time only):
// vendor-vulnerable (prod deps + vendored libs, the vendor reading's vulnerabilities),
// vendor-vulnerable-dev (SCA declared build deps, its devVulnerabilities), and the two
// indirect ones (its treeVulnerabilities / treeDevVulnerabilities), read via ctx.vendor().
// The OSV audit ran once, when the vendor reading was first asked for (src/vendor/verify.js),
// which recorded each vulnerable package with the file + token to anchor it; this maps each recorded
// vulnerability to a finding, anchored at its declaration line - a package.json or VENDOR
// file line in a built XPI, the package's lock entry in a source review. Deterministic,
// no network.
//
// vendor-vulnerable is severity:auto, so the finding's severity is set here
// from the advisory's OSV band: high / critical -> error, moderate / medium ->
// warning, everything else (low / unknown) -> info. A malicious-package advisory arrives
// as critical (src/vendor/verify.js vulnRecord). Every vulnerability reaching
// this mapper is reported; none are dropped. The three source-review entries declare a
// flat error instead, which the registry stamps over what is set here - their audit
// only ever records high and critical, so there is no band left to map.
//
// Belongs here: turning each recorded vulnerability into a finding (+ a feed note)
// and mapping its band to a finding severity. Does NOT belong here: the OSV
// query/parse (-> src/vendor/verify.js), the pinned-version resolution (->
// src/vendor/resolve.js + src/vendor/locks.js), and the wording (->
// assets/registry.yaml).

import semver from "semver";

import { VERDICT } from "./enum.js";
import { finding, SEVERITY } from "../report/finding.js";
import { anchorText, declarationLine } from "./util.js";

/** @typedef {import("../checks/registry.js").RunContext} RunContext */
/** @typedef {import("../report/finding.js").Severity} Severity */
/** @typedef {import("../vendor/verify.js").VendorVuln} VendorVuln */

/**
 * Map an OSV/GHSA severity band to a finding severity. GHSA labels the middle
 * band "moderate" while raw CVSS calls it "medium". Both map to warning.
 * Anything not high/critical/moderate/medium (low, unknown, an unrecognized
 * label) is informational - reported, but neither an error nor a warning.
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

/**
 * Turn each recorded vulnerability into a finding, anchored at its declaration
 * line in the packaged file, and emit a feed note per finding.
 * @param {RunContext} ctx
 * @param {VendorVuln[]} vulns  The vulnerability records to report.
 * @returns {import("../report/finding.js").Finding[]}
 */
export function vulnFindings(ctx, vulns) {
  const { artifact } = ctx;
  const textByFile = new Map();
  /**
   * Read a packaged file's text, memoizing it per path.
   * @param {string} file  The packaged file path to read.
   * @returns {string}  The file's UTF-8 text, or "" when absent.
   */
  const fileText = (file) => {
    if (!textByFile.has(file)) {
      textByFile.set(file, anchorText(artifact, file));
    }
    return textByFile.get(file);
  };
  const findings = [];
  for (const { name, version, ids, severity, fixed, file, token } of vulns) {
    const text = fileText(file);
    // A quoted JSON token (a package.json dep name, an npm lock key), a YAML key (a
    // pnpm lock key) or a plain substring (the VENDOR-file source URL) - whichever
    // locates the declaration line. An empty token means there is no declaration line
    // (a hash-identified library), so the finding anchors at the file with no line.
    const line = token ? declarationLine(text, token) : null;
    const loc = line ? { line } : undefined;
    // One locus, in the artifact this check was routed to, for both the note and the
    // finding - so the feed and the report cannot name the declaration differently.
    const at = ctx.artifact.at(file, loc);
    ctx.note?.(
      at,
      `${name}@${version} has known vulnerabilities (${ids.join(", ")})`,
      VERDICT.FAIL
    );
    findings.push(
      finding({
        ...at,
        item: name,
        // The advisory's band, mapped to a finding severity for the
        // severity:auto entry. The other three declare a flat error,
        // which the registry stamps over this. Either way the raw band string
        // fills the {{severity}} response slot via data.severity.
        severity: severityForBand(severity),
        data: {
          version,
          ids: ids.join(", "),
          severity,
          fixed: latestFix(fixed) ?? "a patched release",
        },
      })
    );
  }
  return findings;
}

/**
 * The most recent of the releases the advisories were fixed in. OSV names a fixed release
 * for every range of every advisory, older release lines included, and only the most
 * recent one fixes them all.
 * @param {string[]} fixed  The fixed releases of the package's advisories.
 * @returns {?string}  The highest valid version among them, or null when there is none.
 */
function latestFix(fixed) {
  const valid = fixed.filter((v) => semver.valid(v, { loose: true }));
  return valid.length ? semver.rsort(valid, { loose: true })[0] : null;
}
