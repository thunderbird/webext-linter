// A declared permission value is neither a known permission, a data-collection
// permission, nor a match pattern, so the submission is invalid. Runs only on a
// parsed manifest, over permissions and optional_permissions.
//
// Belongs here: validating each declared permission value against the schema.
// Does NOT belong here: the schema's permission sets (-> src/schema/index.js),
// match-pattern detection (-> src/checks/lib/util.js), authored wording (->
// assets/registry.yaml), and severity (-> that registry entry).

import { finding } from "../../report/finding.js";
import { asArray, isMatchPattern, manifestTokenLine } from "../lib/util.js";

export default {
  run(ctx) {
    const m = ctx.addon.manifest;
    const { schema } = ctx;
    if (!m) {
      return [];
    }
    const text = ctx.addon.files?.get("manifest.json")?.toString("utf8");
    const out = [];
    for (const field of ["permissions", "optional_permissions"]) {
      for (const p of asArray(m[field])) {
        if (typeof p !== "string") {
          continue;
        }
        if (
          isMatchPattern(p) ||
          schema.validPermissions.has(p) ||
          schema.dataCollectionPermissions.has(p)
        ) {
          ctx.note?.("manifest.json", null, `'${p}'`, "pass");
          continue;
        }
        ctx.note?.(
          "manifest.json",
          null,
          `'${p}' (unknown permission)`,
          "fail"
        );
        const line = manifestTokenLine(text, p);
        out.push(
          finding({
            file: "manifest.json",
            loc: line ? { line } : null,
            item: p,
          })
        );
      }
    }
    return out;
  },
};
