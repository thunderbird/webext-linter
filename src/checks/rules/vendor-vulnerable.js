// Rejects a pinned package.json dependency whose bundled version has known
// security advisories. The OSV audit ran once in the network pre-step
// (src/vendor/verify.js auditPackage), which recorded each vulnerable package on
// addon.vendor.vulnerabilities; this check only reads that and emits a finding per
// vulnerable package, anchored at its package.json dependency line. Deterministic,
// no network.
//
// Belongs here: turning each recorded vulnerability into a finding (+ a feed
// note). Does NOT belong here: the OSV query/parse (-> src/vendor/verify.js), the
// pinned-version resolution (-> src/vendor/resolve.js + src/vendor/locks.js), and
// the wording (-> assets/registry.yaml).

import { finding } from "../../report/finding.js";
import { manifestTokenLine } from "../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

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
