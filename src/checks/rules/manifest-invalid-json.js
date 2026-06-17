// manifest.json is present but is not valid JSON, so the submission is invalid.
// The other manifest checks need a parsed manifest, so they stay silent in this
// case (this is the only finding).
//
// Belongs here: the unparsable-JSON verdict. Does NOT belong here: parsing the
// manifest (-> src/addon/load.js, which records addon.manifestError), authored
// wording (-> assets/registry.yaml), and severity (-> that registry entry).

import { finding } from "../../report/finding.js";

export default {
  run(ctx) {
    if (!ctx.addon.manifestError) {
      return [];
    }
    ctx.note?.("manifest.json", null, "unparsable JSON", "fail");
    return [finding({ file: "manifest.json" })];
  },
};
