// Rejects a source-code submission whose committed lock file cannot install what its
// package.json declares. `npm ci` and `pnpm install --frozen-lockfile` both compare the
// lock against the manifest before installing anything, and refuse over all four cases
// reported here: a lock that does not parse, one that parses but is not a lock this
// comparison can read, a declared package it resolves nothing for, and one whose pin the
// declaration does not admit.
//
// The last case is asked the way each installer asks it, which is not the same question.
// npm resolves ONE node per name and checks the version it pinned against the declared
// range, so `unsatisfied` names a pin, and tightening a range to exactly what the lock
// already installs is no fault at all. pnpm compares the recorded SPECIFIER to the declared
// one as text and refuses on any difference, so `stale` names a string. Reading npm's the
// way pnpm's reads would reject locks npm installs from (-> src/vendor/locks.js npmGap).
//
// Belongs here: mapping a gap to a finding and wording its subject. Does NOT belong here:
// reading the lock formats (-> src/vendor/locks.js lockGaps), whether a lock was owed at
// all (-> sca-lock-file-missing), or the response (-> the registry).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { lockGaps } from "../../vendor/locks.js";
import {
  declarationLine,
  manifestTokenLine,
  utf8ComparisonSigns,
} from "../../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const files = ctx.addon?.files;
    if (!files) {
      return { findings: [] };
    }
    const findings = [];
    for (const gap of lockGaps(ctx.addon)) {
      // Each gap anchors in the file its failing value sits in (LockGap.file), so the line
      // is located in THAT file: the pinned entry inside the lock for `unsatisfied`, the
      // declaration in package.json otherwise. An unreadable lock is the subject itself and
      // has no line at all.
      const text = files.get(gap.file)?.toString("utf8") ?? "";
      const line = gap.token
        ? declarationLine(text, gap.token)
        : gap.name
          ? manifestTokenLine(text, gap.name)
          : null;
      const loc = line ? { line } : undefined;
      const item = subject(gap);
      ctx.note?.(gap.file, loc, item, VERDICT.FAIL);
      // utf8ComparisonSigns: a spec's comparison signs must stay readable/copyable,
      // unlike free prose - see its own doc comment (src/lib/util.js). Applied only to
      // the report's item, not the feed note above, matching the other three checks.
      findings.push(
        finding({ file: gap.file, loc, item: utf8ComparisonSigns(item) })
      );
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
  if (gap.reason === "unsatisfied") {
    // Read at the lock entry this anchors on: the pinned version is ON that line, and the
    // other two are attributed to where they live - the root record that produced the pin,
    // and the declaration in package.json that it fails.
    return `${gap.name} ${gap.installed} installed via ${gap.recorded} locking does not satisfy the declared ${gap.spec}`;
  }
  const declared = `${gap.name} (${gap.spec})`;
  return gap.reason === "stale"
    ? `${declared} - the lock records ${gap.recorded}`
    : `${declared} - not recorded in the lock file`;
}
