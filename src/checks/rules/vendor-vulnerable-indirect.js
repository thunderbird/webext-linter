// Flags a package the submission does NOT declare, but that one of its declared
// dependencies pulls in, whose installed version has known OSV advisories and
// which the build installs for production - so it ends up in the shipped code.
// Almost all of a real submission's exposure sits here rather than in
// package.json. The audit ran in the network pre-step (src/vendor/verify.js
// verifyScaDependencies -> auditLockedPackages), which enumerated the committed
// lock file and recorded each hit on addon.vendor.treeVulnerabilities; this check
// maps that set to findings via the shared lib/vuln-findings.js mapper, anchored
// at the lock-file line. Only high and critical advisories are recorded - plus any
// advisory saying the package itself is malicious, which state no band at all - so every
// finding here is an error (SCA-only; the registry entry is sca:true).
//
// Belongs here: choosing the production tree vulnerability set. Does NOT belong
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
      findings: vulnFindings(ctx, ctx.addon?.vendor?.treeVulnerabilities ?? []),
    };
  },
};
