// A top-level manifest key the schema does not define - Thunderbird ignores it.
// A warning, since the manifest still loads (unlike the manifest-* errors).
//
// Belongs here: detecting unknown top-level keys against schema.validManifestKeys.
// Does NOT belong here: deep value-type validation (-> mistyped-manifest-value.js),
// defects that invalidate the manifest (-> the manifest-* error checks), authored
// wording (-> assets/registry.yaml), and severity (-> that registry entry).

import { finding } from "../../report/finding.js";

export default {
  run(ctx) {
    const { addon, schema } = ctx;
    if (addon.manifestError || !addon.manifest) {
      return []; // a missing/unparsable manifest is the manifest-* checks' job
    }
    if (schema.validManifestKeys.size === 0) {
      return [];
    }
    const out = [];
    for (const key of Object.keys(addon.manifest)) {
      const known = schema.validManifestKeys.has(key);
      ctx.note?.("manifest.json", null, key, known ? "pass" : "fail");
      if (!known) {
        out.push(finding({ file: "manifest.json", item: key }));
      }
    }
    return out;
  },
};
