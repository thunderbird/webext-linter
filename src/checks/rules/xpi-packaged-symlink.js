// Rejects an add-on that carries a symbolic link, wherever it points. A packaged add-on is
// the bytes a user installs, and a link is not bytes: what it names is resolved on whatever
// machine unpacks it, so the same package is a different add-on in two places, and the file
// the reviewer read is not necessarily the file that runs. Every link is a fail here, which
// is stricter than a source archive, where a link within the submission is ordinary tree
// layout (-> sca-invalid-symlink).
//
// Both shapes an add-on can arrive in are covered, because loadAddon records both
// (addon.symlinks): a real link on disk when the add-on is handed over as a folder, and an
// entry the archive STORED as a link when it is packed. The packed one never reaches disk -
// extractZip records it and writes nothing, so the store holds no file whose bytes are a
// path - which is exactly why the record is the only thing left to report it by.
//
// The cause rides as the finding's hint, so one entry collapses every link and each locus
// line still says what was found.
//
// Belongs here: rejecting every recorded link. Does NOT belong here: resolving a link or
// reading an entry's mode (-> src/addon/load.js) or the wording (-> the registry).

import { SYMLINK_CAUSE, VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

// What each recorded cause looks like from the package's side. Wording only - every link
// is refused whatever it says, so an unlisted cause is described generically, never
// skipped. Keyed by the enum member itself, so a mistyped key is a ReferenceError at load
// rather than a branch that quietly never matches.
const HINTS = new Map([
  [SYMLINK_CAUSE.INTERNAL, "link inside the package"],
  [SYMLINK_CAUSE.OUTSIDE, "link outside the package"],
  [SYMLINK_CAUSE.BROKEN, "link with no target"],
  [SYMLINK_CAUSE.ENTRY, "stored as a link in the archive"],
]);

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const findings = [];
    for (const link of ctx.artifact?.symlinks ?? []) {
      const hint = HINTS.get(link.cause) ?? "symbolic link";
      ctx.note?.(link.path, null, hint, VERDICT.FAIL);
      findings.push(finding({ file: link.path, hint }));
    }
    return { findings };
  },
};
