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
// (file/loc/item/data) only, plus the Web/DOM-API grounding that proves the
// permissions the browser.* schema cannot gate (clipboard/geolocation) used.
//
// Does NOT belong here: the rules' wiring and any severity or text - that lives
// in the missing-permission / missing-manifest-key rules under
// src/checks/rules/* and in assets/registry.yaml (resolved by
// src/report/responses.js). The API-needs-which-permission schema knowledge -
// src/schema/index.js (incl. the permissionWebApis annotation). The navigator.*
// call match itself - src/parse/web-api-calls.js. Match-pattern helpers - lib/util.js.

import { finding } from "../../report/finding.js";
import { asArray, isMatchPattern, manifestPathLine } from "./util.js";
import { resolveApiUsages } from "./api-resolution.js";
import { buildReachability } from "./reachability.js";
import { scanWebApiCalls } from "../../parse/web-api-calls.js";

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
 *   call provably requires (so the add-on is definitely using them), plus the
 *   Web/DOM-API permissions grounded from navigator.* calls (see
 *   groundWebApiPermissions) that the browser.* schema cannot gate. The
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
  // bear on neither used nor missing permissions (resolveApiUsages applies the filter).
  for (const { file, usage, res } of resolveApiUsages(ctx)) {
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
          file,
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
        file,
        loc,
        item: `${res.namespace}.${member} needs '${perm}'`,
        verdict: declaredHere ? "pass" : "fail",
      });
      if (!declaredHere && !missingReported.has(perm)) {
        missingReported.add(perm);
        missingPermissions.push(finding({ file, loc, item: perm }));
      }
    }
  }

  // Ground the permissions the schema cannot gate through a browser.* member -
  // the Web/DOM-API permissions (clipboardRead/clipboardWrite/geolocation),
  // consumed via navigator.* calls the schema names in its `web_api` annotation.
  // These feed only the USED set (so the unused-permission check stops flagging a
  // genuinely-used one); they never enter missingPermissions above.
  for (const perm of groundWebApiPermissions(ctx, declared.named)) {
    usedPermissions.add(perm);
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
 * The Web/DOM-API permissions a reachable WebExtension call proves in use - the
 * ones the browser.* schema cannot gate (clipboardRead/clipboardWrite/geolocation),
 * consumed via navigator.* calls the schema names in its `web_api` annotation. The
 * schema supplies the receiver+methods per permission; this scans the same pure
 * WebExtension tree resolveApiUsages uses for browser.* grounding. Called once,
 * from analyzePermissions (itself memoized), so it needs no memo of its own.
 *
 * Only DECLARED permissions are grounded: the result feeds the unused check (which
 * only concerns declared permissions) and never missingPermissions, so grounding an
 * undeclared one would be inert - and skipping them lets the common add-on that
 * declares no Web/DOM permission early-out before scanning any file.
 * @param {RunContext} ctx
 * @param {Set<string>} declaredNamed  The declared named permissions.
 * @returns {Set<string>}  Grounded permission names.
 */
function groundWebApiPermissions(ctx, declaredNamed) {
  const signatures = [];
  for (const [permission, apis] of ctx.schema.permissionWebApis) {
    if (!declaredNamed.has(permission)) {
      continue;
    }
    for (const { receiver, methods } of apis) {
      signatures.push({ permission, receiver, methods });
    }
  }
  const grounded = new Set();
  if (!signatures.length) {
    return grounded;
  }
  const webext = buildReachability(ctx).pureWebExtensionReachable;
  for (const src of ctx.jsSources ?? []) {
    if (!webext.has(src.file)) {
      continue;
    }
    for (const perm of scanWebApiCalls(src.code, signatures, src.parsed)) {
      grounded.add(perm);
    }
  }
  return grounded;
}

/**
 * Enumerate the declared named permissions that warrant a closer look: every one
 * a reachable API call does NOT provably require, anchored to its manifest.json
 * line, as manual-review escalations. A permission a reachable call provably
 * requires (usedPermissions) is justified and dropped; every other declared
 * permission escalates, to be re-judged by the LLM recheck when the registry has a
 * prompt for it (see registry.rechecks) or reviewed by hand otherwise. Host match
 * patterns are minimize-host-permissions' concern and are skipped. Backs the
 * unused-permission-manual producer.
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
      if (used.has(p)) {
        // A reachable call provably requires it, so it is justified - not a manual
        // case. Every other declared permission escalates below.
        ctx.note?.("manifest.json", loc, p, "pass");
        return;
      }
      // Every unused permission escalates the same way. Whether it can be re-judged
      // by the LLM (the registry has a rubric prompt for it) or stays manual-only is
      // decided later, at the divert, by registry.rechecks - the check does not know.
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
