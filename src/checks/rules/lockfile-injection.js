// Rejects a source-code submission whose committed lock file names one release and installs
// another: an entry whose `version` says 1.2.2 while its `resolved` URL (or pnpm's
// `resolution.tarball`) fetches 1.2.1, or another package entirely. The dependency audit asks
// about the name and version the entry records, while `npm ci` and
// `pnpm install --frozen-lockfile` fetch the URL - so the audit would vouch for a release the
// build never installs.
//
// Belongs here: mapping each such entry to a finding at its line in the lock. Does NOT
// belong here: reading the lock formats, comparing an entry with its URL or asking the
// registry where a release is (-> src/vendor/locks.js findLockInjections, computed once
// through ctx.lockInstalls()), or the response (-> the registry).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { declarationLine } from "../../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {Promise<{findings: import("../../report/finding.js").Finding[]}>}
   */
  async run(ctx) {
    const findings = [];
    for (const forged of await ctx.lockInstalls()) {
      const text = ctx.artifact.files.get(forged.file)?.toString("utf8") ?? "";
      const line = declarationLine(text, forged.token);
      const at = ctx.artifact.at(forged.file, line ? { line } : undefined);
      const item = `${forged.name} ${forged.version} - installs ${forged.installed}`;
      ctx.note?.(at, item, VERDICT.FAIL);
      findings.push(finding({ ...at, item }));
    }
    return { findings };
  },
};
