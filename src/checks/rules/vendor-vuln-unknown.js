// Flags a VENDOR entry whose library cannot be checked for known
// vulnerabilities: its source is a GitHub URL, which carries no npm package
// identity to query OSV with. (npm-sourced VENDOR entries and package.json deps
// ARE audited - see vendor-vulnerable / src/vendor/verify.js auditNpm.) Surfaced
// as info so the reviewer knows the library is unaudited and can ask the
// developer for an npm source. Deterministic, no network: it reads the resolved
// addon.vendor.manifest and classifies each source offline.
//
// Only trusted + pinned entries qualify - the same gate as byte verification;
// an untrusted/unpinned source already routes to vendor-unverified, so flagging
// it as "unaudited" too would be redundant.
//
// Belongs here: selecting trusted+pinned github VENDOR entries and emitting one
// info finding + note each. Does NOT belong here: the OSV audit (-> vendor-
// vulnerable / src/vendor/verify.js), source classification (-> src/vendor/
// sources.js), or the wording (-> the registry).

import { finding } from "../../report/finding.js";
import { classifySource } from "../../vendor/sources.js";
import { lineContaining } from "../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {import("../../report/finding.js").Finding[]}
   */
  run(ctx) {
    const { addon } = ctx;
    const vendor = addon?.vendor;
    const manifest = vendor?.manifest ?? [];
    const vendorName = vendor?.vendorFile ?? null;
    const vendorText = vendorName
      ? (addon.files?.get(vendorName)?.toString("utf8") ?? "")
      : "";
    const findings = [];
    for (const entry of manifest) {
      if (!entry.trusted || !entry.pinned) {
        continue; // already handled by vendor-unverified
      }
      if (classifySource(entry.sourceUrl).kind !== "github") {
        continue; // npm sources are OSV-audited by vendor-vulnerable
      }
      const line = lineContaining(vendorText, entry.sourceUrl);
      const loc = line ? { line } : undefined;
      ctx.note?.(
        vendorName,
        loc,
        `${entry.path} (source ${entry.sourceUrl}) could not be checked for known vulnerabilities`,
        "skipped"
      );
      findings.push(
        finding({
          file: vendorName,
          loc,
          item: entry.path,
          data: { source: entry.sourceUrl },
        })
      );
    }
    return findings;
  },
};
