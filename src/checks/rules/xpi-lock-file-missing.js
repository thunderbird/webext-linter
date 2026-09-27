// Rejects a ranged vendoring declaration that no lock file resolves, because none was
// committed. A shipped package.json `dependencies` entry is not something the add-on
// installs - it states that a file bundled in this XPI was copied from that release, and
// verifyPackage takes it literally, fetching THAT release's listing and matching the
// shipped bytes against it. A range names no single release, so the lock beside it is what
// says which one was bundled, and with no lock the copy stays unverified.
//
// The reading is fixed by the SUBMISSION TYPE, never by the file's contents: in an XPI a
// package.json declares VENDORED libraries whatever else it carries, `scripts` included,
// because nothing in a built add-on is installed. The mirror holds in a source archive,
// where it defines the BUILD whatever it carries (-> sca-lock-file-missing).
//
// Reports only the declarations `resolveVendor` filed as having NO lock to consult. Where
// one was committed and still resolves nothing, the remedy is a different one and so is the
// check (-> xpi-lock-file-invalid). Neither decides which case it is: classifyDeps does,
// once, where both facts are known.
//
// Belongs here: turning each such declaration into a finding (+ a feed note). Does NOT
// belong here: parsing package.json or reading the lock (-> src/vendor/resolve.js), whether
// the SOURCE it names is supported (-> unsupported-dependency), and the registry wording.

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import {
  anchorText,
  manifestTokenLine,
  utf8ComparisonSigns,
} from "../../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const { artifact } = ctx;
    const unlocked = artifact.vendor.unlocked ?? [];
    const text = anchorText(artifact, "package.json");
    const findings = [];
    for (const { name, spec } of unlocked) {
      const line = manifestTokenLine(text, name);
      const loc = line ? { line } : undefined;
      ctx.note?.(
        "package.json",
        loc,
        `${name} ("${spec}") is a range and no lock file was committed`,
        VERDICT.FAIL
      );
      // Collapsed response (no {{item}}): the subject renders on the location line
      // as `name (spec)`, matching the other dependency rejects. utf8ComparisonSigns:
      // a spec's comparison signs must stay readable/copyable, unlike free prose - see
      // its own doc comment (src/lib/util.js).
      findings.push(
        finding({
          file: "package.json",
          loc,
          item: utf8ComparisonSigns(`${name} (${spec})`),
        })
      );
    }
    return { findings };
  },
};
