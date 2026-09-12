// Flags an add-on shipping more than one file whose name says it is the VENDOR
// manifest (VENDOR, VENDOR.md, VENDORS, VENDORS.md - matched case-insensitively).
// Which one the review would read is otherwise decided by the order the archive
// lists them in, so the same submission could verify against a different manifest
// after a rebuild. Choosing is not ours to do: the developer says which file is the
// manifest by shipping one.
//
// Nothing else reads an ambiguous manifest either - readVendorFile returns null for
// it (src/normalize/vendor.js), so no declaration from either file is trusted and
// vendor-unparseable does not also fire.
//
// Belongs here: turning "more than one candidate" into a finding. Does NOT belong
// here: which names count as a VENDOR file (-> src/normalize/vendor.js
// vendorFileNames), or the wording (-> assets/registry.yaml).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { vendorFileNames } from "../../normalize/vendor.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {import("../../report/finding.js").Finding[]}
   */
  run(ctx) {
    const names = vendorFileNames(ctx.addon);
    if (names.length < 2) {
      return [];
    }
    // Every candidate is a locus, so the reviewer sees which files collide without
    // opening the submission. The item names them together for the response.
    for (const name of names) {
      ctx.note?.(name, null, "candidate VENDOR file", VERDICT.FAIL);
    }
    return names.map((name) => finding({ file: name, item: names.join(", ") }));
  },
};
