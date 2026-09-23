// Rejects a source-code submission that ships a package.json and no lock file. The reviewer
// installs with `npm ci` or `pnpm install --frozen-lockfile`, and both refuse without one
// whatever the manifest declares, so the source cannot be shown to produce the shipped XPI.
// npm and pnpm are the only supported package managers, so those are the only locks that
// count.
//
// The reading is fixed by the SUBMISSION TYPE, never by the file's contents: in a source
// archive a package.json is a build manifest whatever it carries, so whatever it declares
// is installed and a lock is owed. An absent `scripts` block is not a second reading and
// not grounds for anything - it neither exempts a submission nor is complained about. The
// mirror holds in a built XPI, where the same file is a vendoring manifest whatever it
// carries (-> xpi-package-unpinned).
//
// Only the ROOT package.json is read - that is the build's entry point
// (src/build/corpus.js), while a
// nested one is a workspace member or a vendored library's own copy. Deliberately narrower
// than unsupported-build-tool and build-registry-redirect, which scan every depth: those
// detect a disallowed thing, where looking too widely is harmless, while this asserts a
// requirement, where it invents rejections.
//
//
// Silent on a submission that fingerprints as an unsupported package manager
// (src/build/tools.js): "this build uses yarn" and "this build has no npm or pnpm lock" are
// one fact, and unsupported-build-tool is the check whose subject the tool is. It carries
// the same review-early-exit, so the halt does not depend on this check speaking. The
// question is asked of the FILES rather than of that check's outcome, so the answer cannot
// depend on which check ran first.
//
// Belongs here: deciding whether a lock was owed and is absent. Does NOT belong here:
// whether a present lock works (-> sca-lock-file-invalid) or the wording (-> the registry).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { readManifest } from "../../vendor/manifest.js";
import { TREE_LOCKS } from "../../vendor/locks.js";
import { unsupportedBuildTool } from "../../build/tools.js";

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
    if (unsupportedBuildTool(ctx.addon)) {
      return { findings: [] }; // the tool is the fact, told by unsupported-build-tool
    }
    const pkg = readManifest(files);
    if (!pkg) {
      return { findings: [] }; // no readable manifest: no declared install to lock
    }
    // Presence is tested by NAME, not by parse: a lock that exists but is corrupt is not
    // MISSING (-> sca-lock-file-invalid). The list is the one sca-lock-file-invalid reads,
    // so the two cannot disagree about whether a submission has a lock at all.
    //
    // Owed by the MANIFEST, never by what it happens to declare. `npm ci` and `pnpm
    // install --frozen-lockfile` refuse without a lock whatever the manifest holds, so a
    // root declaring nothing itself is not a submission that installs nothing - it is a
    // workspace root, or a manifest whose declarations moved, and the reviewer still
    // cannot install from it. Asking only about THIS file is also what keeps the rule
    // whole: nothing here goes looking for manifests or locks deeper in the archive.
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
