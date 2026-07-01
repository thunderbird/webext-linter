// Flags usage of WebExtension APIs not in Thunderbird's annotated schema:
// unknown namespaces, unknown members of a known namespace, and members that
// exist but are explicitly marked `unsupported`. Reads the shared, reachability-
// filtered resolution (lib/api-resolution.js) and emits a verdict per usage.
//
// Belongs here: deciding which resolveApi outcomes (unknown-namespace,
// unknown-member, unsupported def) count as a finding, and picking the item
// string (root.first-segment for an unknown namespace, full path otherwise).
// Does NOT belong here: resolving usage against the schema over the WebExtension
// tree - that is the shared src/checks/lib/api-resolution.js (resolveApiUsages).
// Extracting browser.* usage from source - src/parse/api-usage.js. Walking the
// schema (isUnsupported, docUrl) - src/schema/index.js. Authored wording ->
// assets/registry.yaml. Severity -> that registry entry, stamped by runChecks
// (src/checks/registry.js). Report formatting -> src/report/format.js.

import { finding } from "../../report/finding.js";
import { SchemaIndex } from "../../schema/index.js";
import { resolveApiUsages } from "../lib/api-resolution.js";

export default {
  run(ctx) {
    const findings = [];
    for (const { file, usage, res } of resolveApiUsages(ctx)) {
      const full = `${usage.root}.${usage.segments.join(".")}`;
      const loc = { line: usage.line, column: usage.column };

      if (res.kind === "unknown-namespace") {
        ctx.note?.(file, loc, `${full} (unknown namespace)`, "fail");
        findings.push(
          finding({
            file,
            loc,
            item: `${usage.root}.${usage.segments[0]}`,
          })
        );
        continue;
      }

      if (res.kind === "unknown-member") {
        ctx.note?.(file, loc, `${full} (unknown member)`, "fail");
        findings.push(
          finding({
            file,
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
        ctx.note?.(file, loc, `${full} (unsupported)`, "fail");
        findings.push(
          finding({
            file,
            loc,
            hint: SchemaIndex.docUrl(res.def),
            item: full,
          })
        );
        continue;
      }

      ctx.note?.(file, loc, full, "pass");
    }
    return findings;
  },
};
