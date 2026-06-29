// Reports a bundled third-party library that the Mozilla hash DB did not recognize
// but whose exact bytes were found on the jsDelivr CDN (src/checks/lib/cdn-lookup.js,
// run in the pipeline before this check). A CDN match is promoted into the vendored
// family - tagged `library` with a `libraryId` and a `cdn` source URL - so it is
// excluded from minified-code and OSV-audited like a hash-DB library; this check is
// the advisory "you shipped a known library undeclared - here is the VENDOR entry to
// add" report. Info severity, and silent when nothing matched (no `cdn` tags).
//
// Belongs here: selecting the cdn-tagged verdicts and emitting one finding (named
// with its libraryId, hinting its jsDelivr source URL) per such file.
//
// Does NOT belong here: the CDN lookup and the tag promotion (->
// src/checks/lib/cdn-lookup.js), the Mozilla-hash library verdict (->
// missing-library.js), the minified-without-library verdict (-> minified-code.js),
// authored wording (-> assets/registry.yaml), severity (-> that registry entry,
// stamped by src/checks/registry.js), and report formatting (-> src/report/format.js).

import { finding } from "../../report/finding.js";
import { classifyAddonJs } from "../lib/bundled.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
export default {
  /**
   * @param {RunContext} ctx
   * @returns {import("../../report/finding.js").Finding[]}
   */
  run(ctx) {
    const findings = [];
    for (const c of classifyAddonJs(ctx)) {
      if (!c.cdn) {
        continue;
      }
      // A cdn tag always carries the matched release (cdn-lookup sets both).
      const id = `${c.libraryId.name} ${c.libraryId.version}`;
      ctx.note?.(c.file, null, id, "fail");
      // hint = the jsDelivr source URL: with the file path (the location) it IS the
      // `file:`/`source:` VENDOR entry to add.
      findings.push(finding({ file: c.file, item: id, hint: c.cdn.url }));
    }
    return findings;
  },
};
