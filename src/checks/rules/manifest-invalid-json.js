// manifest.json is present but does not parse to an object, so the submission is
// invalid. Two ways to fail one question - is what this file holds a JSON object
// the review can read keys off: the text will not parse at all, or it parses to
// something that is not an object (a primitive, or an array). Both are reported
// the same way, because the developer's remedy is the same and neither yields a
// key to name. A file that is not there at all is manifest-missing's verdict.
//
// An array is refused with the primitives: Object.keys walks one happily and
// yields index keys, so letting it through means reporting "0", "1", "2" to a
// developer as unknown manifest.json keys.
//
// The other manifest checks need a parsed manifest.json, so they stay silent when the
// text will not parse (this is then the only finding). They do NOT yet stay
// silent for a non-object that is truthy - `[]` and a non-empty string are read
// as manifest.json files by everything downstream, so their findings arrive beside this
// one. Fixing that means the loader refusing a non-object into `json`, which is
// a wider change than this verdict.
//
// Belongs here: the unusable-manifest.json verdict. Does NOT belong here: parsing the
// manifest.json (-> src/addon/load.js records the parse error, surfaced as
// ctx.manifest.error - the SHIPPED manifest.json's), authored wording
// (-> assets/registry.yaml), and severity (-> that registry entry).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";

/**
 * A parse the review can read manifest.json keys off: an object, and not an array.
 * @param {*} json  The record's parse.
 * @returns {boolean}
 */
function isManifestObject(json) {
  return Boolean(json) && typeof json === "object" && !Array.isArray(json);
}

export default {
  run(ctx) {
    const record = ctx.manifest;
    if (!record.present || isManifestObject(record.json)) {
      return { findings: [] };
    }
    ctx.note?.(ctx.manifest.locus(), "unusable manifest.json", VERDICT.FAIL);
    return { findings: [finding({ ...ctx.manifest.locus() })] };
  },
};
