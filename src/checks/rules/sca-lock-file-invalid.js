// Rejects a source-code submission whose committed lock file cannot install what its
// package.json declares. `npm ci` and `pnpm install --frozen-lockfile` both compare the
// lock against the manifest before installing anything, and refuse over all four cases
// reported here: a lock that does not parse, one that parses but is not a lock this
// comparison can read, a declared package it resolves nothing for, and one it records
// under a different spec.
//
// The stale case costs more than reproducibility: lockedVersion resolves a declared name
// against the lock's installed entry, so a lock recording an older range has the OSV audit
// clear a version the developer never declared.
//
//
// Silent on a submission that fingerprints as an unsupported package manager
// (src/build/tools.js): "this build uses yarn" and "this build has no npm or pnpm lock" are
// one fact, and unsupported-build-tool is the check whose subject the tool is. It carries
// the same review-early-exit, so the halt does not depend on this check speaking. The
// question is asked of the FILES rather than of that check's outcome, so the answer cannot
// depend on which check ran first.
//
// Belongs here: mapping a gap to a finding and wording its subject. Does NOT belong here:
// reading the lock formats (-> src/vendor/locks.js lockGaps), whether a lock was owed at
// all (-> sca-lock-file-missing), or the response (-> the registry).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { lockGaps } from "../../vendor/locks.js";
import { unsupportedBuildTool } from "../../build/tools.js";
import { manifestTokenLine } from "../../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const files = ctx.addon?.files;
    if (!files || unsupportedBuildTool(ctx.addon)) {
      return { findings: [] };
    }
    const text = files.get("package.json")?.toString("utf8") ?? "";
    const findings = [];
    for (const gap of lockGaps(ctx.addon)) {
      // An unreadable lock is the subject itself, so it anchors at the lock and has no
      // declaration line; every other gap is about one declaration in package.json.
      const line = gap.name ? manifestTokenLine(text, gap.name) : null;
      const loc = line ? { line } : undefined;
      const item = subject(gap);
      ctx.note?.(gap.file, loc, item, VERDICT.FAIL);
      findings.push(finding({ file: gap.file, loc, item }));
    }
    return { findings };
  },
};

/**
 * What this gap is about, as the location line renders it. The response states the rule
 * once, so which of the three ways the lock failed rides here.
 * @param {import("../../vendor/locks.js").LockGap} gap
 * @returns {string}
 */
function subject(gap) {
  // Two ways the FILE is the subject, told apart because a developer would check: one
  // will not open, the other opens fine and is simply not a lock we can compare against.
  if (gap.reason === "unreadable") {
    return "could not be read";
  }
  if (gap.reason === "unrecognised") {
    return "is not a recognisable npm or pnpm lock file";
  }
  const declared = `${gap.name} (${gap.spec})`;
  return gap.reason === "stale"
    ? `${declared} - the lock records ${gap.recorded}`
    : `${declared} - not recorded in the lock file`;
}
