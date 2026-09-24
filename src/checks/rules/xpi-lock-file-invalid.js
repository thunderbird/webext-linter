// Rejects a ranged vendoring declaration the committed lock file does not resolve. A
// shipped package.json `dependencies` entry is not something the add-on installs - it
// states that a file bundled in this XPI was copied from that release, and verifyPackage
// takes it literally, fetching THAT release's listing and matching the shipped bytes
// against it. A range names no single release, so the lock beside it is what says which one
// was bundled. This one does not say: it was written from another manifest, records the
// package under another name, or does not parse at all.
//
// The reading is fixed by the SUBMISSION TYPE, never by the file's contents: in an XPI a
// package.json is a vendoring manifest whatever else it carries, `scripts` included,
// because nothing in a built add-on is installed. The mirror holds in a source archive,
// where the same question is asked of the tree the reviewer installs
// (-> sca-lock-file-invalid).
//
// Reports only the declarations `resolveVendor` filed as having a lock that resolves them
// to nothing. Where none was committed, the submission is asked for one instead
// (-> xpi-lock-file-missing). Neither decides which case it is: classifyDeps does, once,
// where both facts are known.
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
    const { addon } = ctx;
    const unpinned = addon?.vendor?.unpinned ?? [];
    const text = anchorText(addon, "package.json");
    const findings = [];
    for (const { name, spec } of unpinned) {
      const line = manifestTokenLine(text, name);
      const loc = line ? { line } : undefined;
      ctx.note?.(
        "package.json",
        loc,
        `${name} ("${spec}") is a range the committed lock file does not pin`,
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
