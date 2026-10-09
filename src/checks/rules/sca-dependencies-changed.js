// Tells the developer the review ran on changed dependencies, when the source reviewed is a
// rescued copy. A review the submitted dependencies would have stopped on known
// vulnerabilities goes on from a copy whose dependencies were reduced to what the release
// build uses, then audit-fixed where that was not enough (src/prepare/steps.js). The
// developer's own package.json and lock still carry what was changed, so the next
// submission would stop again - unless they are told.
//
// One finding, anchored at package.json, when the copy's lock differs from the lock of the
// root it was made from: a release it no longer installs or newly installs, or a package it
// no longer records as declared or newly does. Read from the locks alone, like every other
// dependency question of a source review. What changed is not listed - the developer's own
// audit (`npm audit`, `pnpm audit`) names what to fix in their project, against their own
// lock. Nothing is said where the source is no rescued copy, or where its lock installs what
// the original's did.
//
// Belongs here: telling whether the two locks differ. Does NOT belong here: reading the
// original's files (-> src/pipeline.js `source-archive`, through src/prepare/state.js
// originalPackages), reading a lock (-> src/vendor/locks.js), or the wording (-> the
// registry).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { PACKAGE_FILE } from "../../vendor/package-file.js";
import { lockedPackages } from "../../vendor/locks.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const original = ctx.artifact.originalPackages;
    if (!original) {
      return { findings: [] };
    }
    const before = lockedPackages(original);
    const after = lockedPackages(ctx.artifact);
    const installed = (pkgs) => pkgs.map((p) => `${p.name}@${p.version}`);
    const declared = (pkgs) => pkgs.filter((p) => p.direct).map((p) => p.name);
    if (
      sameSet(installed(before), installed(after)) &&
      sameSet(declared(before), declared(after))
    ) {
      return { findings: [] };
    }
    const at = ctx.artifact.at(PACKAGE_FILE);
    ctx.note?.(at, null, VERDICT.INFO);
    return { findings: [finding({ ...at })] };
  },
};

/** Whether two lists hold the same values, each counted once.
 *  @param {string[]} a @param {string[]} b @returns {boolean} */
function sameSet(a, b) {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
}
