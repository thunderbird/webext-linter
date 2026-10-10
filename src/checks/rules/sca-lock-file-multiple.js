// Rejects a source-code submission that commits more than one lock file at its root. Every
// check reads one of them - the governing lock, the first in TREE_LOCKS order - while the
// build picks its package manager by the lock it finds: a pnpm-lock.yaml means
// `pnpm install --frozen-lockfile`. With two, the tree the review audits need not be the tree
// the reviewer installs, so a harmless npm lock beside a vulnerable pnpm one would pass. Only
// one package manager's lock may be committed.
//
// Belongs here: turning each committed lock into a finding at its file, when there is more
// than one. Does NOT belong here: which files count as a lock (-> src/vendor/locks.js
// committedLocks), whether one was owed at all (-> sca-lock-file-missing), or the response
// (-> the registry).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { committedLocks } from "../../vendor/locks.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const locks = committedLocks(ctx.artifact);
    if (locks.length < 2) {
      return { findings: [] };
    }
    const findings = [];
    for (const file of locks) {
      const at = ctx.artifact.at(file);
      ctx.note?.(at, "one of several lock files", VERDICT.FAIL);
      findings.push(finding({ ...at }));
    }
    return { findings };
  },
};
