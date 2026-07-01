// Shared permission analysis for the missing-permission and missing-manifest-key
// checks. Cross-checks the permissions required by the APIs an add-on calls
// against what its manifest declares:
//   - missingPermissions: a required permission that is not declared,
//   - missingManifestKeys: an API that needs a manifest key not declared.
// Severity comes from each owning registry entry (missing-permission /
// missing-manifest-key), stamped by runChecks.
//
// We do NOT report declared-but-unused permissions: a permission can be needed
// only to read a permission-gated property of returned data (e.g. accountsRead
// for a message header's folder), which a static scan cannot confirm, so any
// "unused" verdict would be unsound. The optional --full-summary LLM pass
// assesses unused permissions advisorily instead.
//
// The schema expresses "this API needs a manifest key" via pseudo-permissions
// of the form "manifest:<key>" (e.g. browserAction needs "manifest:action" OR
// "manifest:browser_action"). Those are not declarable permissions - the
// manifest must declare at least one of the named keys.
//
// Belongs here: analyzePermissions (memoized via getPermissionAnalysis), the
// missing diff the rules consume, returning structured findings
// (file/loc/item/data) only.
//
// Does NOT belong here: the rules' wiring and any severity or text - that lives
// in the missing-permission / missing-manifest-key rules under
// src/checks/rules/* and in assets/registry.yaml (resolved by
// src/report/responses.js). The API-needs-which-permission schema knowledge -
// src/schema/index.js. Match-pattern helpers - lib/util.js.

import { finding } from "../../report/finding.js";
import { asArray, isMatchPattern, manifestPathLine } from "./util.js";
import { buildReachability } from "./reachability.js";

// Permissions that gate no callable API, so static analysis can never prove use;
// they are justified by their mere presence and must not be flagged unused.
const NO_API_GATE = new Set(["unlimitedStorage"]);

// The Thunderbird version that fixes D308076: at or above it, a tabs.query
// filtering by url/title on the add-on's own pages does not need "tabs". The two
// version-gated unused-permission-manual producers split on this (one fires at or
// above it, the other below / when unset), feeding their own recheck consumer.
export const D308076_FIXED_IN = "154";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../../addon/load.js").Manifest} Manifest */

const MANIFEST_PREFIX = "manifest:";
const GATED_KINDS = new Set(["function", "event", "property", "namespace"]);

/**
 * @typedef {{file: string, loc: ?{line: number, column: number}, item: string,
 *   verdict: string}} PermNote  A feed-activity record (emitted by the owning
 *   rule, so each appears once under the right check group).
 */

/**
 * @typedef {object} PermissionAnalysis
 * @property {import("../../report/finding.js").Finding[]} missingPermissions  A
 *   required permission (item) not declared in the manifest.
 * @property {import("../../report/finding.js").Finding[]} missingManifestKeys
 *   An API (item) needing a manifest key (data.keys) that is not declared.
 * @property {Set<string>} usedPermissions  Named permissions a reachable API
 *   call provably requires (so the add-on is definitely using them). The
 *   unused-permission-manual check drops these from its by-hand checklist. Only
 *   ever proves a permission USED - a permission absent here may still be needed
 *   via a gated property a static scan cannot see (see the file header).
 * @property {{requirements: PermNote[], manifestKeys: PermNote[]}} notes  Feed
 *   records, one list per owning rule.
 */

/**
 * Cross-check the permissions/manifest keys the called APIs require against what
 * the manifest declares. Use getPermissionAnalysis (memoized) from the rules.
 * @param {RunContext} ctx  The shared check context.
 * @returns {PermissionAnalysis}
 */
export function analyzePermissions(ctx) {
  const { schema, addon } = ctx;
  const missingPermissions = [];
  const missingManifestKeys = [];
  // Named permissions some reachable API call provably requires (used below to
  // trim the by-hand unused-permission checklist).
  const usedPermissions = new Set();
  // Activity records, one list per owning rule's feed group.
  const requirements = [];
  const manifestKeyNotes = [];
  const notes = {
    requirements,
    manifestKeys: manifestKeyNotes,
  };
  if (!ctx.manifest) {
    return { missingPermissions, missingManifestKeys, usedPermissions, notes };
  }

  const declared = declaredPermissions(ctx.manifest);
  const manifestKeys = new Set(Object.keys(ctx.manifest));
  const missingReported = new Set();
  // namespace -> { alts:Set<key>, example, file, loc } for "manifest:<key>".
  const manifestKeyReqs = new Map();

  // Only usages in the pure WebExtension tree count: dead code and privileged
  // Experiment/core code (which uses no manifest permissions) are outside it, so they
  // bear on neither used nor missing permissions.
  const reach = buildReachability(ctx);
  for (const src of ctx.apiUsages) {
    if (!reach.pureWebExtensionReachable.has(src.file)) {
      continue;
    }
    for (const usage of src.usages) {
      const res = schema.resolveApi(usage.segments);
      if (!GATED_KINDS.has(res.kind)) {
        continue;
      }
      const member = res.member ?? "(namespace)";
      const loc = { line: usage.line, column: usage.column };
      for (const perm of schema.requiredPermissions(res)) {
        if (perm.startsWith(MANIFEST_PREFIX)) {
          const rec = manifestKeyReqs.get(res.namespace) || {
            alts: new Set(),
            example: `${res.namespace}.${member}`,
            file: src.file,
            loc,
          };
          rec.alts.add(perm.slice(MANIFEST_PREFIX.length));
          manifestKeyReqs.set(res.namespace, rec);
          continue;
        }
        // A reachable call requires this permission, so the add-on provably
        // uses it (whether or not it is declared - the manual checklist below
        // intersects this with the declared set).
        usedPermissions.add(perm);
        const declaredHere = declared.named.has(perm);
        requirements.push({
          file: src.file,
          loc,
          item: `${res.namespace}.${member} needs '${perm}'`,
          verdict: declaredHere ? "pass" : "fail",
        });
        if (!declaredHere && !missingReported.has(perm)) {
          missingReported.add(perm);
          missingPermissions.push(finding({ file: src.file, loc, item: perm }));
        }
      }
    }
  }

  // Manifest-key requirements: at least one of the named keys must be declared.
  // The schema lists both MV2/MV3 spellings, but only the one valid for the
  // target manifest version counts.
  /** @param {string} k @returns {string} top-level segment of a dotted key. */
  const topLevel = (k) => k.split(".")[0];
  for (const [, rec] of manifestKeyReqs) {
    const allAlts = [...rec.alts];
    const validAlts = allAlts.filter((k) =>
      schema.validManifestKeys.has(topLevel(k))
    );
    const altsToCheck = validAlts.length ? validAlts : allAlts;
    const satisfied = altsToCheck.some((k) => manifestKeys.has(topLevel(k)));
    const alts = altsToCheck.join('", "');
    manifestKeyNotes.push({
      file: rec.file,
      loc: rec.loc,
      item: `${rec.example} needs manifest key "${alts}"`,
      verdict: satisfied ? "pass" : "fail",
    });
    if (!satisfied) {
      missingManifestKeys.push(
        finding({
          file: rec.file,
          loc: rec.loc,
          item: rec.example,
          data: { keys: `"${alts}"` },
        })
      );
    }
  }

  return { missingPermissions, missingManifestKeys, usedPermissions, notes };
}

/**
 * The permission analysis, computed once and memoized on the addon so the
 * missing-permission and missing-manifest-key checks share one pass.
 * @param {RunContext} ctx
 * @returns {PermissionAnalysis}
 */
export function getPermissionAnalysis(ctx) {
  return (ctx.addon.permissionAnalysis ??= analyzePermissions(ctx));
}

/**
 * Enumerate the declared named permissions that warrant a closer look: every one
 * a reachable API call does NOT provably require, anchored to its manifest.json
 * line, as manual-review escalations. A permission a reachable call provably
 * requires (usedPermissions) or that gates no callable API (NO_API_GATE) is
 * justified and dropped. Host match patterns are minimize-host-permissions'
 * concern and are skipped. Shared by the unused-permission-manual producers,
 * which differ only in the strict_min_version gate around this call.
 * @param {RunContext} ctx
 * @returns {{findings: [], escalations:
 *   {item: string, file: string, loc: ?object}[]}}
 */
export function enumerateUnusedPermissions(ctx) {
  const used = getPermissionAnalysis(ctx).usedPermissions;
  const m = ctx.manifest ?? {};
  const seen = new Set();
  const escalations = [];
  for (const key of ["permissions", "optional_permissions"]) {
    asArray(m[key]).forEach((p, i) => {
      if (typeof p !== "string" || isMatchPattern(p) || seen.has(p)) {
        return;
      }
      seen.add(p);
      const line = manifestPathLine(ctx, key, i);
      const loc = line ? { line } : null;
      if (used.has(p) || NO_API_GATE.has(p)) {
        // A reachable call requires it, or it gates no callable API (always
        // justified) - either way not a manual case.
        ctx.note?.("manifest.json", loc, p, "pass");
        return;
      }
      ctx.note?.("manifest.json", loc, p, "unsure");
      escalations.push({ item: p, file: "manifest.json", loc });
    });
  }
  return { findings: [], escalations };
}

/**
 * Split declared manifest permissions into named permissions (required +
 * optional) and host match patterns, where `required` is the "permissions"
 * array only (used for the unused check). Shared with the native-messaging
 * check, which keys off whether a named permission is declared.
 * @param {Manifest} manifest
 * @returns {{named: Set<string>, required: Set<string>, hosts: Set<string>}}
 */
export function declaredPermissions(manifest) {
  const named = new Set();
  const required = new Set();
  const hosts = new Set();
  const lists = [
    { list: manifest.permissions, required: true },
    { list: manifest.optional_permissions, required: false },
    { list: manifest.host_permissions, required: false },
  ];
  for (const { list, required: isRequired } of lists) {
    for (const p of asArray(list)) {
      if (typeof p !== "string") {
        continue;
      }
      if (isMatchPattern(p)) {
        hosts.add(p);
      } else {
        named.add(p);
        if (isRequired) {
          required.add(p);
        }
      }
    }
  }
  return { named, required, hosts };
}
