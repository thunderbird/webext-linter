// Producer of the declared permissions that warrant a closer look: every named
// permission a reachable API call does not provably require. A permission whose
// linked token vocabulary (check.permissionTokens) declares usage `tokens`
// that appear nowhere in the add-on's live code (comments excluded) or manifest
// is deterministically unused - a warning finding (the deterministic path stands
// down when the scan is blind - see enumerateUnusedPermissions). Every other such
// permission is scheduled as a code-review escalation, carrying the sites where
// its tokens occur so the reviewer reads concrete lines.
//
// Version handling lives in the registry, not here: a permission-prompts entry may
// carry min_strict_version / max_strict_version, and the token matcher keeps only the
// entries whose bounds cover the add-on's strict_min_version (versionInBounds). So
// this one check serves every add-on regardless of version.
//
// Belongs here: only the wiring. The enumeration, token matching and
// deterministic verdicts are enumerateUnusedPermissions
// (src/lib/permissions.js); the tokens and wording are
// assets/registry.yaml.

import { enumerateUnusedPermissions } from "../../lib/permissions.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../registry.js").LoadedCheck} LoadedCheck */

export default {
  /**
   * @param {RunContext} ctx
   * @param {LoadedCheck} check
   * @returns {{findings: {item: string, file: string, loc: ?object}[],
   *   escalations: {item: string, file: string, loc: ?object}[]}}
   */
  run(ctx, check) {
    return enumerateUnusedPermissions(ctx, check?.permissionTokens);
  },
};
