// No manifest.json at the add-on root, so the submission is invalid. ONE question: is the
// file there. Whatever a file that IS there turns out to hold - unparsable, or parsing to
// something that is not an object - is manifest-invalid-json's verdict, not this one's.
//
// `ctx.manifest` is that answer already: the loader builds a record for a manifest.json it
// finds and returns null when the store holds no such key (src/addon/load.js
// manifestRecord), so the record's existence IS the file's. It is read there rather than off
// the files because the record is the SHIPPED answer, whichever artifact this review routes.
//
// Belongs here: the absent-manifest.json verdict. Does NOT belong here: loading the
// add-on (-> src/addon/load.js), authored wording (-> assets/registry.yaml), and
// severity (-> that registry entry).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";

export default {
  run(ctx) {
    if (ctx.manifest) {
      return { findings: [] };
    }
    ctx.note?.("manifest.json", null, "no manifest.json", VERDICT.FAIL);
    return { findings: [finding({})] };
  },
};
