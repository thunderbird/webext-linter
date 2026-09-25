// Rejects a source-code submission that ships a package.json and no lock file. The reviewer
// installs with `npm ci` or `pnpm install --frozen-lockfile`, and both refuse without one
// whatever the package file declares, so the source cannot be shown to produce the shipped XPI.
// npm and pnpm are the only supported package managers, so those are the only locks that
// count.
//
// The reading is fixed by the SUBMISSION TYPE, never by the file's contents: in a source
// archive a package.json defines the BUILD whatever it carries, so whatever it declares
// is installed and a lock is owed. An absent `scripts` block is not a second reading and
// not grounds for anything - it neither exempts a submission nor is complained about. The
// mirror holds in a built XPI, where the same file declares VENDORED libraries whatever it
// carries (-> xpi-lock-file-missing / xpi-lock-file-invalid).
//
// Only the ROOT package.json is read - that is the build's entry point
// (src/build/corpus.js), while a nested one is a workspace member or a vendored library's
// own copy. Every build file this review reads is read at that root, for the same reason:
// it is the directory the install runs in. Which folder IS the root was settled before any
// check ran (src/addon/sca-root.js), so this reads a root that has been confirmed to be one
// rather than the folder a command line happened to name.
//
// Belongs here: deciding whether a lock was owed and is absent. Does NOT belong here:
// whether a present lock works (-> sca-lock-file-invalid) or the wording (-> the registry).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { readPackageFile } from "../../vendor/package-file.js";
import { TREE_LOCKS } from "../../vendor/locks.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const files = ctx.addon?.files;
    if (!files) {
      return { findings: [] };
    }
    const pkg = readPackageFile(files);
    if (!pkg) {
      return { findings: [] }; // no readable package file: no declared install to lock
    }
    // Presence is tested by NAME, not by parse: a lock that exists but is corrupt is not
    // MISSING (-> sca-lock-file-invalid). The list is the one sca-lock-file-invalid reads,
    // so the two cannot disagree about whether a submission has a lock at all.
    //
    // Owed by the PACKAGE FILE, never by what it happens to declare. `npm ci` and `pnpm
    // install --frozen-lockfile` refuse without a lock whatever it holds, so a
    // root declaring nothing itself is not a submission that installs nothing - it is a
    // workspace root, or a package file whose declarations moved, and the reviewer still
    // cannot install from it. Asking only about THIS file is also what keeps the rule
    // whole: nothing here goes looking for package files or locks deeper in the archive.
    if (TREE_LOCKS.some((lock) => files.has(lock))) {
      return { findings: [] };
    }
    ctx.note?.(
      "package.json",
      null,
      "no npm or pnpm lock file committed",
      VERDICT.FAIL
    );
    return { findings: [finding({ file: "package.json" })] };
  },
};
