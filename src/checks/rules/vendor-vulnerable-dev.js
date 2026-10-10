// Flags a package the committed lock file marks as declared and installs for the build
// only, whose version has known OSV advisories. Build dependencies are never shipped, but
// in SCA mode the reviewer builds the add-on from source, so a vulnerable build tool runs on
// the reviewer's machine. The OSV audit ran behind ctx.vendor() (src/vendor/verify.js
// verifyScaDependencies -> auditLockedPackages), recording each hit on
// addon.vendor.devVulnerabilities, anchored at the lock entry; this check maps that set to
// findings via the shared lib/vuln-findings.js mapper - identical to vendor-vulnerable, but
// for the dev set (SCA-only; the registry entry is input: sca). Only high and critical
// advisories are recorded - plus any advisory saying the package itself is malicious - so
// every finding here is an error.
//
// Belongs here: choosing the dev vulnerability set. Does NOT belong here: the
// vulnerability->finding mapping (-> src/lib/vuln-findings.js), the OSV query
// (-> src/vendor/verify.js), and the wording (-> assets/registry.yaml).

import { vulnFindings } from "../../lib/vuln-findings.js";

export default {
  /**
   * @param {import("../registry.js").RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  async run(ctx) {
    return {
      findings: vulnFindings(
        ctx,
        (await ctx.vendor()).devVulnerabilities ?? []
      ),
    };
  },
};
