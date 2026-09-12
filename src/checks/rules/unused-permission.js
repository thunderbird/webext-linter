// Producer of the declared permissions that warrant a closer look: every named
// permission a reachable API call does not provably require. A permission whose
// linked token vocabulary (check.permissionTokens) declares usage `tokens`
// that appear nowhere in the add-on's live code (comments excluded) or manifest
// is deterministically unused - a warning finding (the deterministic path stands
// down when the scan is blind - see enumerateUnusedPermissions). Every other such
// permission is scheduled as a manual-review escalation, carrying the sites where
// its tokens occur so the reviewer reads concrete lines.
//
// Version handling (D308076: before Thunderbird 154, filtering a tabs.query by
// url/title needs "tabs" even for the add-on's own pages) lives in the registry,
// not here: the version-bounded "tabs" permission-prompts entries in
// assets/registry.yaml, selected by the add-on's strict_min_version (the token
// matcher applies versionInBounds). So this one check
// serves every add-on regardless of version.
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
