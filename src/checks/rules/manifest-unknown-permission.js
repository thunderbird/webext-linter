// A declared permission value is neither a known permission, a data-collection
// permission, nor a match pattern, so the submission is invalid. Runs only on a
// parsed manifest.json, over permissions and optional_permissions.
//
// Belongs here: validating each declared permission value against the schema.
// Does NOT belong here: the schema's permission sets (-> src/schema/index.js),
// match-pattern detection (-> src/lib/util.js), authored wording (->
// assets/registry.yaml), and severity (-> that registry entry).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { asArray, isMatchPattern } from "../../lib/util.js";

export default {
  run(ctx) {
    const m = ctx.manifest?.json;
    const { schema } = ctx;
    if (!m) {
      return { findings: [] };
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
          ctx.note?.(ctx.manifest.locus(), `'${p}'`, VERDICT.PASS);
          return;
        }
        ctx.note?.(
          ctx.manifest.locus(),
          `'${p}' (unknown permission)`,
          VERDICT.FAIL
        );
        out.push(
          finding({
            ...ctx.manifest.locus(field, i),
            item: p,
          })
        );
      });
    }
    return { findings: out };
  },
};
