// Rejects a vendoring declaration that does not name one exact npm release. A shipped
// package.json `dependencies` entry is not something the add-on installs - it states that
// a file bundled in this XPI was copied from that release, and verifyPackage takes it
// literally, fetching THAT release's listing and matching the shipped bytes against it. A
// spec naming no single release (a range, a dist-tag, a partial version, a wildcard)
// leaves nothing to compare, so the copy stays unverified.
//
// The reading is fixed by the SUBMISSION TYPE, never by the file's contents: in an XPI a
// package.json is a vendoring manifest whatever else it carries, `scripts` included,
// because nothing in a built add-on is installed. The mirror holds in a source archive,
// where it is a build manifest whatever it carries (-> sca-lock-file-missing).
//
// `sca: false`: this is the XPI submission type's half of the pinnability question. A
// source archive answers it with its lock file, where a range is legitimate
// (-> sca-lock-file-missing, sca-lock-file-invalid). That is also why no lock is consulted
// here - a lock has no place inside a built add-on, so reading one found there would let a
// range launder itself into a pin from a file nothing verifies (resolveVendor's
// reviewerInstalls).
//
// Belongs here: turning each unpinned declaration into a finding (+ a feed note). Does NOT
// belong here: parsing package.json (-> src/vendor/resolve.js), whether the SOURCE it
// names is supported (-> unsupported-dependency), and the registry wording.

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { manifestTokenLine } from "../../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const { addon } = ctx;
    const unpinned = addon?.vendor?.unpinned ?? [];
    const text = addon.files.get("package.json")?.toString("utf8") ?? "";
    const findings = [];
    for (const { name, spec } of unpinned) {
      const line = manifestTokenLine(text, name);
      const loc = line ? { line } : undefined;
      ctx.note?.(
        "package.json",
        loc,
        `${name} ("${spec}") is not pinned`,
        VERDICT.FAIL
      );
      // Collapsed response (no {{item}}): the subject renders on the location line
      // as `name (spec)`, matching the other dependency rejects.
      findings.push(
        finding({ file: "package.json", loc, item: `${name} (${spec})` })
      );
    }
    return { findings };
  },
};
