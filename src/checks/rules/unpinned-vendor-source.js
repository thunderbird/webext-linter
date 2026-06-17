// Rejects a VENDOR-declared file whose source is a trusted host but is not
// pinned to an immutable ref (a branch like .../main, or an unversioned URL).
// Such a source can change after review, so the bytes cannot be verified - the
// developer must link to a specific version, tag, or commit. resolveVendor
// classified each declared source offline (src/vendor/sources.js) and recorded
// the non-pinned ones as `unpinned-source` results on addon.vendor. This check
// only reads them. Deterministic, no network.
//
// Belongs here: turning each unpinned-source result into a finding (+ a feed
// note). Does NOT belong here: classifying the URL (-> src/vendor/sources.js),
// resolving the store (-> src/vendor/resolve.js) and the registry wording.

import { finding } from "../../report/finding.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {import("../../report/finding.js").Finding[]}
   */
  run(ctx) {
    const results = ctx.addon?.vendor?.results ?? [];
    const findings = [];
    for (const { path, source } of results.filter(
      (r) => r.outcome === "unpinned-source"
    )) {
      ctx.note?.(path, null, `non-pinned source: ${source}`, "fail");
      findings.push(
        finding({
          file: path,
          item: path,
          data: { url: source },
        })
      );
    }
    return findings;
  },
};
