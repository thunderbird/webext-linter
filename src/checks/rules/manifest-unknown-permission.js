// A declared permission value is neither a known permission, a data-collection
// permission, nor a match pattern, so the submission is invalid. Runs only on a
// parsed manifest, over permissions and optional_permissions.
//
// Belongs here: validating each declared permission value against the schema.
// Does NOT belong here: the schema's permission sets (-> src/schema/index.js),
// match-pattern detection (-> src/checks/lib/util.js), authored wording (->
// assets/registry.yaml), and severity (-> that registry entry).

import { finding } from "../../report/finding.js";
import { asArray, isMatchPattern, manifestPathLine } from "../lib/util.js";

export default {
  run(ctx) {
    const m = ctx.addon.manifest;
    const { schema } = ctx;
    if (!m) {
      return [];
    }
    const out = [];
    for (const field of ["permissions", "optional_permissions"]) {
      asArray(m[field]).forEach((p, i) => {
        if (typeof p !== "string") {
          return;
        }
        if (
          isMatchPattern(p) ||
          schema.validPermissions.has(p) ||
          schema.dataCollectionPermissions.has(p)
        ) {
          ctx.note?.("manifest.json", null, `'${p}'`, "pass");
          return;
        }
        ctx.note?.(
          "manifest.json",
          null,
          `'${p}' (unknown permission)`,
          "fail"
        );
        const line = manifestPathLine(ctx.addon, field, i);
        out.push(
          finding({
            file: "manifest.json",
            loc: line ? { line } : null,
            item: p,
          })
        );
      });
    }
    return out;
  },
};
