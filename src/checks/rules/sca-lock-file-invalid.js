// Rejects a source-code submission whose committed lock file cannot be read: it does not
// parse, or it parses but is not an npm or pnpm lock while package.json declares something
// to install from it. The dependency audit reads the installed tree out of that file, so an
// unreadable one would leave the audit seeing nothing. Whether a readable lock matches
// package.json is the package manager's question, which `npm ci` and
// `pnpm install --frozen-lockfile` answer when the build installs - it is not re-decided
// here.
//
// Belongs here: turning an unreadable lock into a finding. Does NOT belong here: reading
// the lock formats (-> src/vendor/locks.js unreadableLock), whether a lock was owed at all
// (-> sca-lock-file-missing), or the response (-> the registry).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { unreadableLock } from "../../vendor/locks.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

const SUBJECT = {
  unreadable: "could not be read",
  unrecognised: "is not a recognisable npm or pnpm lock file",
};

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const lock = unreadableLock(ctx.artifact);
    if (!lock) {
      return { findings: [] };
    }
    const item = SUBJECT[lock.reason];
    ctx.note?.(ctx.artifact.at(lock.file), item, VERDICT.FAIL);
    return { findings: [finding({ ...ctx.artifact.at(lock.file), item })] };
  },
};
