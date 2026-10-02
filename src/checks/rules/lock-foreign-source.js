// Rejects a source-code submission whose committed lock file installs a package from a
// source the review cannot audit. The dependency audit identifies each package by name and
// version, while `npm ci` and `pnpm install --frozen-lockfile` fetch the URL the lock
// records - so an entry resolved anywhere but the npm registry or GitHub installs bytes the
// audit vouched for under another name. The same holds for a root dependency declared as a
// registry release that the lock takes from GitHub.
//
// Belongs here: mapping each such entry to a finding at its line in the lock. Does NOT
// belong here: reading the lock formats or deciding what counts as a supported source
// (-> src/vendor/locks.js lockSourceGaps), or the response (-> the registry).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { lockSourceGaps } from "../../vendor/locks.js";
import { declarationLine } from "../../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const findings = [];
    for (const gap of lockSourceGaps(ctx.artifact)) {
      const text = ctx.artifact.files.get(gap.file)?.toString("utf8") ?? "";
      const line = declarationLine(text, gap.token);
      const at = ctx.artifact.at(gap.file, line ? { line } : undefined);
      const item = `${gap.name}${gap.version ? ` ${gap.version}` : ""} - ${gap.source}`;
      ctx.note?.(at, item, VERDICT.FAIL);
      findings.push(finding({ ...at, item }));
    }
    return { findings };
  },
};
