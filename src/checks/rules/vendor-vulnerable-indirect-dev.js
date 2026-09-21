// Flags a package the submission does NOT declare, but that one of its declared
// build dependencies pulls in, whose installed version has known OSV advisories.
// It is never shipped, but the SCA reviewer builds the add-on from source, so it
// runs on the reviewer's machine during the build. The audit ran in the network
// pre-step (src/vendor/verify.js verifyScaDependencies -> auditLockedPackages),
// which enumerated the committed lock file and recorded each hit on
// addon.vendor.treeDevVulnerabilities; this check maps that set to findings via
// the shared lib/vuln-findings.js mapper, anchored at the lock-file line.
// Identical to vendor-vulnerable-indirect, but for the build-only half of the
// tree (SCA-only; the registry entry is sca:true).
//
// Belongs here: choosing the build-time tree vulnerability set. Does NOT belong
// here: the vulnerability->finding mapping (-> src/lib/vuln-findings.js), the
// lock enumeration and OSV audit (-> src/vendor/locks.js + src/vendor/verify.js),
// and the wording (-> assets/registry.yaml).

import { vulnFindings } from "../../lib/vuln-findings.js";

export default {
  /**
   * @param {import("../registry.js").RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    return {
      findings: vulnFindings(
        ctx,
        ctx.addon?.vendor?.treeDevVulnerabilities ?? []
      ),
    };
  },
};
