// Warns about deprecated APIs. Each ctx.apiUsages member is resolved and a
// deprecated function/event/property is reported once.
//
// Belongs here: deciding that a resolved function/event/property is deprecated,
// and dedup of repeated hits. A deprecated finding carries the schema's own
// deprecation message as its hint (the actionable migration note), not a link to
// the deprecated item. Does NOT belong here: extracting browser.* usage - that is
// src/parse/api-usage.js, consumed via ctx.apiUsages. Reading schema annotations
// (resolveApi, deprecation) - src/schema/index.js. Flagging an API added after
// the supported version range - the strict-min/strict-max-version-api checks; an
// API absent or marked unsupported (version_added: false) - unknown-api. Authored
// wording -> assets/registry.yaml. Severity -> that registry entry, stamped by
// runChecks (src/checks/registry.js). Report formatting -> src/report/format.js.

import { finding } from "../../report/finding.js";
import { SchemaIndex } from "../../schema/index.js";

export default {
  run(ctx) {
    const findings = [];
    const { schema } = ctx;
    const seen = new Set(); // report each deprecated api once

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

        // Narrate every resolved API site (the unit this check examines), with
        // its verdict - so the feed shows what was vetted, not only the hits.
        ctx.note?.(
          src.file,
          loc,
          dep ? `${full} (deprecated)` : full,
          dep ? "fail" : "pass"
        );

        if (dep && add(seen, full)) {
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
