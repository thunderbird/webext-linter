// Warns about deprecated APIs and APIs that require a newer Thunderbird than
// the target schema set (version_added greater than the schema's
// applicationVersion - e.g. when linting against an older ESR branch). Each
// ctx.apiUsages member is resolved and checked against both concerns, with
// every (api, reason) pair reported once.
//
// Belongs here: deciding that a resolved function/event/property is deprecated
// or too new (vaMajor greater than the schema target major), and dedup of
// repeated hits. A deprecated finding carries the schema's own deprecation
// message as its hint (the actionable migration note), not a link to the
// deprecated item. Does NOT belong here: extracting browser.* usage - that is
// src/parse/api-usage.js, consumed via ctx.apiUsages. Reading schema
// annotations (resolveApi, deprecation, versionAdded) and the target
// version - src/schema/index.js. Authored wording -> assets/registry.yaml.
// Severity -> that registry entry, stamped by runChecks
// (src/checks/registry.js). Report formatting -> src/report/format.js.

import { finding } from "../../report/finding.js";
import { SchemaIndex } from "../../schema/index.js";

export default {
  run(ctx) {
    const findings = [];
    const { schema } = ctx;
    const targetMajor = schema.applicationVersionMajor;
    const seen = new Set(); // report each (api, reason) once

    for (const src of ctx.apiUsages) {
      for (const usage of src.usages) {
        if (usage.segments.length === 0) {
          continue;
        }
        const res = schema.resolveApi(usage.segments);
        if (
          res.kind !== "function" &&
          res.kind !== "event" &&
          res.kind !== "property"
        ) {
          continue;
        }
        const full = `${res.namespace}.${res.member}`;
        const loc = { line: usage.line, column: usage.column };

        const dep =
          SchemaIndex.deprecation(res.def) ||
          SchemaIndex.deprecation(res.namespaceDef);
        const va =
          SchemaIndex.versionAdded(res.def) ||
          SchemaIndex.versionAdded(res.namespaceDef);
        const vaMajor = va ? parseInt(va, 10) : null;
        const tooNew = Boolean(vaMajor && targetMajor && vaMajor > targetMajor);

        // Narrate every resolved API site (the unit this check examines), with
        // its verdict - so the feed shows what was vetted, not only the hits.
        const why = dep ? "deprecated" : tooNew ? `needs TB ${vaMajor}` : null;
        ctx.note?.(
          src.file,
          loc,
          why ? `${full} (${why})` : full,
          why ? "fail" : "pass"
        );

        if (dep && add(seen, `dep:${full}`)) {
          findings.push(
            finding({
              file: src.file,
              loc,
              // The schema's deprecation message (a migration note) when it has
              // one; a bare `deprecated: true` carries no text, so no hint.
              hint: typeof dep === "string" ? dep : null,
              item: full,
            })
          );
        }

        if (tooNew && add(seen, `ver:${full}`)) {
          findings.push(
            finding({
              file: src.file,
              loc,
              item: full,
            })
          );
        }
      }
    }
    return findings;
  },
};

/**
 * Add key to set if absent, returning whether it was newly added.
 * @param {Set<string>} set
 * @param {string} key
 * @returns {boolean}
 */
function add(set, key) {
  if (set.has(key)) {
    return false;
  }
  set.add(key);
  return true;
}
