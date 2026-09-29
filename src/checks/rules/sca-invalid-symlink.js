// Rejects a source-code submission whose tree holds a symbolic link the review cannot
// follow: one resolving OUTSIDE --sca-root, or one resolving to nothing at all. Either way
// the build installs or compiles something the submission does not hold, so the readable source the
// reviewer was promised is not the whole of what the add-on is built from.
//
// A link pointing WITHIN the submission is fine and is not reported: its target is walked
// and reviewed under its own real path, so the code is covered wherever the link sits.
// That is the whole difference from an add-on, which may carry no link at all
// (-> xpi-packaged-symlink).
//
// The links are recorded at load (addon.symlinks) with the cause as a FACT - loadAddon
// classifies, it does not judge - and scaViews passes the list onto the input: sca addon.
// The cause rides as the finding's hint, so one entry collapses every link and each locus
// line still says which kind it was.
//
// The policy is written as what is TOLERATED rather than as what is refused, so a cause
// this file has never heard of is rejected rather than skipped. A check that auto-rejects
// must not be able to fall silent because a producer grew a case it did not list.
//
// Belongs here: which recorded links a source archive may carry. Does NOT belong here:
// resolving a link (-> src/addon/load.js) or the wording (-> the registry).

import { SYMLINK_CAUSE, VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

// What a source archive is ALLOWED to carry - the policy, stated as the short list it is.
// Everything else is refused, so a cause nobody anticipated is rejected rather than
// slipping through an unlisted branch on a check that rejects submissions.
const TOLERATED = new Set([SYMLINK_CAUSE.INTERNAL]);

// Wording only, and never the policy: a cause with no entry here is still refused, just
// described generically. Keyed by the enum member itself, so a mistyped key is a
// ReferenceError at load rather than a branch that quietly never matches.
const HINTS = new Map([
  [SYMLINK_CAUSE.OUTSIDE, "target outside the submission"],
  [SYMLINK_CAUSE.BROKEN, "target does not exist"],
]);

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const findings = [];
    for (const link of ctx.artifact.symlinks) {
      if (TOLERATED.has(link.cause)) {
        continue;
      }
      const hint = HINTS.get(link.cause) ?? "target cannot be followed";
      ctx.note?.(ctx.artifact.at(link.path), hint, VERDICT.FAIL);
      findings.push(finding({ ...ctx.artifact.at(link.path), hint }));
    }
    return { findings };
  },
};
