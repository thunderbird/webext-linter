// Flags a VENDOR entry that names a file not present in the submission - a stale
// entry or a forgotten file. Contrast the package.json side, where a declared
// dependency whose file is absent is intentionally ignored (dependencies are
// installed/bundled at build time and the submission may predate the build - see
// verifyPackage in src/vendor/verify.js). resolveVendor recorded these on
// addon.vendor.missing; this check only reads them. Deterministic, no network.
//
// Belongs here: turning each missing VENDOR entry into a finding and a note.
// Does NOT belong here: the VENDOR parse (-> src/normalize/vendor.js) and the
// store resolution (-> src/vendor/resolve.js) or the wording (-> the registry).

import { finding } from "../../report/finding.js";
import { readVendorFile } from "../../normalize/vendor.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {import("../../report/finding.js").Finding[]}
   */
  run(ctx) {
    const { addon } = ctx;
    const missing = addon?.vendor?.missing ?? [];
    if (!missing.length) {
      return [];
    }
    // Anchor the finding to the VENDOR file (where the bad declaration lives).
    // The missing path is the item, and the source URL rides on the feed note.
    const vendorName = readVendorFile(addon)?.name ?? "VENDOR";
    const findings = [];
    for (const { path, sourceUrl } of missing) {
      ctx.note?.(
        vendorName,
        null,
        `${path} declared (source ${sourceUrl}) but not in the submission`,
        "fail"
      );
      findings.push(finding({ file: vendorName, item: path }));
    }
    return findings;
  },
};
