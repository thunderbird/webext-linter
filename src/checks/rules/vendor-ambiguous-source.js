// Flags a declaration whose source cannot verify what it is paired with. Two reach
// here, and resolveVendor settles both offline: a file source paired with MORE THAN
// ONE bundled file (a file source verifies a single file, so the pairing is
// ambiguous), and a DIRECTORY declared against something that is not an archive of
// the release - a single file's URL, or a CDN's directory listing page, which is
// fetchable enough that the request succeeds and only the unpacking fails. Either
// way the entry is pulled out of the manifest (never verified, never fetched) and
// recorded on `vendor.ambiguousSources`; this rule just turns each into a finding.
//
// Belongs here: turning the resolveVendor `ambiguousSources` list into findings.
// Does NOT belong here: the parse / pairing (src/normalize/vendor.js), the offline
// resolve (src/vendor/resolve.js), or the wording (assets/registry.yaml).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const vendor = ctx.addon?.vendor;
    const file = vendor?.vendorFile ?? "VENDOR";
    const out = [];
    for (const { source, paths } of vendor?.ambiguousSources ?? []) {
      const files = paths.join(", ");
      ctx.note?.(file, null, `${source} -> ${files}`, VERDICT.FAIL);
      // The source is the locus subject and the files it collides over the detail, so
      // every ambiguous pairing shares one message and they collapse into one entry.
      out.push(finding({ file, item: source, hint: files }));
    }
    return { findings: out };
  },
};
