// Flags functions/events whose schema version_added is newer than the add-on's
// declared strict_min_version: the add-on claims to run on Thunderbird versions
// where the API does not yet exist, so those installs break. Independent of
// strict-max-version-api.js (the high bound). Each too-new API is reported once,
// anchored at its first call site.
//
// Tuple comparison, so a version_added of "140.4.1" against strict_min "140.0"
// is caught. No-op when strict_min_version is absent or unparsable.
//
// Belongs here: the version_added vs strict_min_version comparison and per-api
// dedup. Does NOT belong here: extracting browser.* usage
// (src/parse/api-usage.js via ctx.apiUsages), reading schema annotations
// (SchemaIndex.versionAdded / resolveApi), the wording (assets/registry.yaml) or
// severity (its registry entry, stamped by runChecks).

import { finding } from "../../report/finding.js";
import { SchemaIndex } from "../../schema/index.js";
import { strictMinVersion } from "../lib/util.js";

export default {
  /**
   * @param {import("../registry.js").RunContext} ctx
   * @returns {import("../../report/finding.js").Finding[]}
   */
  run(ctx) {
    const minStr = ctx.addon?.manifest
      ? strictMinVersion(ctx.addon.manifest)
      : undefined;
    const min = parseVersion(minStr);
    if (!min) {
      ctx.note?.(
        "manifest.json",
        null,
        "no parsable strict_min_version",
        "skipped"
      );
      return [];
    }

    const { schema } = ctx;
    const findings = [];
    const seen = new Set(); // report each api once, at its first call site

    for (const src of ctx.apiUsages) {
      for (const usage of src.usages) {
        if (usage.segments.length === 0) {
          continue;
        }
        const res = schema.resolveApi(usage.segments);
        if (res.kind !== "function" && res.kind !== "event") {
          continue;
        }
        const va =
          SchemaIndex.versionAdded(res.def) ||
          SchemaIndex.versionAdded(res.namespaceDef);
        // A null version means skip: boolean false (handled by unknown-api),
        // true/absent (supported), and "≤N" (pre-WebExtension, always
        // available).
        const added = parseVersion(va);
        if (!added || cmpVersion(added, min) <= 0) {
          continue;
        }
        const key = `${res.namespace}.${res.member}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const display =
          `${usage.root ?? "browser"}.${usage.segments.join(".")}` +
          (res.kind === "function" ? "()" : "");
        const loc = { line: usage.line, column: usage.column };
        ctx.note?.(src.file, loc, `${display} (added in TB ${va})`, "fail");
        findings.push(
          finding({
            file: src.file,
            loc,
            item: display,
            hint: `added in Thunderbird ${va}`,
            data: { min: String(minStr) },
          })
        );
      }
    }
    return findings;
  },
};

/**
 * Parse a version string into numeric components ([115,0] for "115.0",
 * [140,4,1] for "140.4.1"). Leading non-digits per component are dropped
 * ("0a1" -> 0). Returns null when nothing numeric reads, or when "≤"/"<"-
 * prefixed: "≤59" etc. predate WebExtension support (Thunderbird 60+), so the
 * API is always available to any real add-on and is skipped.
 * @param {unknown} v
 * @returns {number[]|null}
 */
function parseVersion(v) {
  if (typeof v !== "string") {
    return null;
  }
  const s = v.trim();
  if (/^[≤<]/.test(s)) {
    return null;
  }
  const nums = [];
  for (const part of s.split(".")) {
    const d = /^\d+/.exec(part);
    if (!d) {
      break;
    }
    nums.push(parseInt(d[0], 10));
  }
  return nums.length ? nums : null;
}

/**
 * Component-wise compare two version tuples (missing components are 0).
 * @param {number[]} a @param {number[]} b
 * @returns {number} -1 if a<b, 0 if equal, 1 if a>b.
 */
function cmpVersion(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
