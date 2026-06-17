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
// in the missing-permission / missing-manifest-key rules under src/checks/rules/*
// and in assets/registry.yaml (resolved by src/report/responses.js). The
// API-needs-which-permission schema knowledge - src/schema/index.js.
// Match-pattern helpers - lib/util.js.

import { finding } from "../../report/finding.js";
import { asArray, isMatchPattern } from "./util.js";
import { buildReachability } from "./reachability.js";

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
 * @property {import("../../report/finding.js").Finding[]} missingManifestKeys  An
 *   API (item) needing a manifest key (data.keys) that is not declared.
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
  // Activity records, one list per owning rule's feed group.
  const requirements = [];
  const manifestKeyNotes = [];
  const notes = {
    requirements,
    manifestKeys: manifestKeyNotes,
  };
  if (!addon.manifest) {
    return { missingPermissions, missingManifestKeys, notes };
  }

  const declared = declaredPermissions(addon.manifest);
  const manifestKeys = new Set(Object.keys(addon.manifest));
  const missingReported = new Set();
  // namespace -> { alts:Set<key>, example, file, loc } for "manifest:<key>".
  const manifestKeyReqs = new Map();

  // Only usages in files that actually run count: a dead (unreachable) file must
  // neither require a permission nor fulfil a declared one. unused-files surfaces
  // such files for review; their API calls never execute.
  const reach = buildReachability(ctx);
  for (const src of ctx.apiUsages) {
    if (!reach.isLive(src.file)) {
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

  return { missingPermissions, missingManifestKeys, notes };
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
