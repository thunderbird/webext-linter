// A top-level manifest key the schema does not define - Thunderbird ignores it.
// A warning, since the manifest still loads (unlike the manifest-* errors).
//
// Belongs here: detecting unknown top-level keys against schema.validManifestKeys,
// plus the exception for experiment-owned keys (a key that names an experiment_apis
// entry - e.g. calendar_provider - is config the add-on's own experiment reads, so
// the developer owns it). Does NOT belong here: deep value-type validation (->
// mistyped-manifest-value.js), defects that invalidate the manifest (-> the
// manifest-* error checks), authored wording (-> assets/registry.yaml), and
// severity (-> that registry entry).

import { finding } from "../../report/finding.js";
import { asObject, manifestTokenLine } from "../lib/util.js";

export default {
  run(ctx) {
    const { addon, schema } = ctx;
    if (addon.manifestError || !addon.manifest) {
      return []; // a missing/unparsable manifest is the manifest-* checks' job
    }
    if (schema.validManifestKeys.size === 0) {
      return [];
    }
    const text = addon.files?.get("manifest.json")?.toString("utf8");
    // Top-level keys that name an experiment_apis entry are experiment-owned
    // config (the developer's own API reads them) - not unknown.
    const expKeys = new Set(
      Object.keys(asObject(addon.manifest.experiment_apis))
    );
    const out = [];
    for (const key of Object.keys(addon.manifest)) {
      const known = schema.validManifestKeys.has(key) || expKeys.has(key);
      ctx.note?.("manifest.json", null, key, known ? "pass" : "fail");
      if (!known) {
        const line = manifestTokenLine(text, key);
        out.push(
          finding({
            file: "manifest.json",
            loc: line ? { line } : null,
            item: key,
          })
        );
      }
    }
    return out;
  },
};
