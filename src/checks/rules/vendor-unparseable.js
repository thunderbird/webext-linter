// Flags a VENDOR file that exists but yielded no declaration. The parse is
// all-or-nothing (src/normalize/vendor.js): it reads only what the developer MARKED
// as a declaration, and a fault anywhere - half a declaration, a block naming two
// items, a source URL no declaration claimed - discards the whole file. So this
// fires both when nothing was marked at all and when something was, but the file
// contradicted itself. Either way the libraries go unchecked: an error until the
// documented format is used (a VENDOR that parsed, whose declared file is merely
// absent, is missing-vendor-file, not this).
//
// Belongs here: turning the resolveVendor `unparsedVendor` flag into a finding.
// Does NOT belong here: parsing the VENDOR file (src/normalize/vendor.js), the
// offline resolve (src/vendor/resolve.js), or the wording (assets/registry.yaml).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {import("../../report/finding.js").Finding[]}
   */
  run(ctx) {
    const vendor = ctx.addon?.vendor;
    if (!vendor?.unparsedVendor) {
      return [];
    }
    const file = vendor.vendorFile ?? "VENDOR";
    ctx.note?.(file, null, "could not be parsed", VERDICT.FAIL);
    return [finding({ file })];
  },
};
