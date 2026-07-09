// Producer of the declared permissions that warrant a closer look: every named
// permission a reachable API call does not provably require, scheduled as a
// manual-review escalation. When --llm-review is on, the orchestrator hands the
// ones the registry has a rubric prompt for to the `unused-permission` consumer to
// be re-judged with whole-add-on context; the rest stay manual (the divert applies
// registry.rechecks - see src/checks/registry.js and src/checks/lib/recheck.js).
//
// Version handling (D308076: before Thunderbird 154, filtering a tabs.query by
// url/title needs "tabs" even for the add-on's own pages) lives in the registry,
// not here: the version-bounded "tabs" permission-prompts entries in
// assets/registry.yaml, which the recheck assembler selects by the add-on's
// strict_min_version. So this one producer serves every add-on regardless of version.
//
// Belongs here: only the wiring. The enumeration is enumerateUnusedPermissions
// (src/checks/lib/permissions.js); the wording is assets/registry.yaml; re-judging
// is the consumer via src/checks/lib/recheck.js.

import { enumerateUnusedPermissions } from "../lib/permissions.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: [], escalations:
   *   {item: string, file: string, loc: ?object}[]}}
   */
  run(ctx) {
    return enumerateUnusedPermissions(ctx);
  },
};
