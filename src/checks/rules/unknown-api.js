// Flags usage of WebExtension APIs not in Thunderbird's annotated schema:
// unknown namespaces, unknown members of a known namespace, and members that
// exist but are explicitly marked `unsupported`. Each ctx.apiUsages segment
// list is resolved against the schema and a verdict emitted.
//
// Belongs here: deciding which resolveApi outcomes (unknown-namespace,
// unknown-member, unsupported def) count as a finding, and picking the item
// string (root.first-segment for an unknown namespace, full path otherwise).
// Does NOT belong here: extracting browser.* usage from source - that is
// src/parse/api-usage.js, consumed via ctx.apiUsages. Walking the schema
// (resolveApi, isUnsupported, docUrl) - src/schema/index.js. Authored wording
// -> assets/registry.yaml. Severity -> that registry entry, stamped by
// runChecks (src/checks/registry.js). Report formatting -> src/report/format.js.

import { finding } from "../../report/finding.js";
import { SchemaIndex } from "../../schema/index.js";

export default {
  run(ctx) {
    const findings = [];
    const { schema } = ctx;

    for (const src of ctx.apiUsages) {
      for (const usage of src.usages) {
        if (usage.segments.length === 0) {
          continue; // bare `browser` reference
        }
        const res = schema.resolveApi(usage.segments);
        const full = `${usage.root}.${usage.segments.join(".")}`;
        const loc = { line: usage.line, column: usage.column };

        if (res.kind === "unknown-namespace") {
          ctx.note?.(src.file, loc, `${full} (unknown namespace)`, "fail");
          findings.push(
            finding({
              file: src.file,
              loc,
              item: `${usage.root}.${usage.segments[0]}`,
            })
          );
          continue;
        }

        if (res.kind === "unknown-member") {
          ctx.note?.(src.file, loc, `${full} (unknown member)`, "fail");
          findings.push(
            finding({
              file: src.file,
              loc,
              item: full,
            })
          );
          continue;
        }

        if (
          SchemaIndex.isUnsupported(res.def) ||
          SchemaIndex.isUnsupported(res.namespaceDef)
        ) {
          ctx.note?.(src.file, loc, `${full} (unsupported)`, "fail");
          findings.push(
            finding({
              file: src.file,
              loc,
              hint: SchemaIndex.docUrl(res.def),
              item: full,
            })
          );
          continue;
        }

        ctx.note?.(src.file, loc, full, "pass");
      }
    }
    return findings;
  },
};
