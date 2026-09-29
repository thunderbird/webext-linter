// A source-code submission whose BUILT XPI carries vendoring information of its own - a
// VENDOR file, a package.json, a lock file. In a source-code submission those belong in the
// ARCHIVE: that is the copy the reviewer reads and the build installs from. A shipped one
// either means the process was misread, or that this was meant to be an XPI-only submission
// all along, and the remedy differs by which - so the response offers both.
//
// One finding per file, because here the submission CAN point at what is wrong: the paths
// are the answer, not a detail of it. Each locus is minted by `ctx.xpi`, the side those
// files are in - on a route carrying two artifacts, asking the holder is how a finding
// says which one it means (src/addon/load.js `at`).
//
// Nothing is narrowed by this: THIS review stays a full source review whatever the answer.
// No content test can be trusted to route, because a committed unminified build is its own
// twin under any of them, and routing on that would let a build be dressed up as source.
//
// Belongs here: which files count as vendoring information, and finding them in the XPI.
// Does NOT belong here: what a VENDOR file IS (-> src/normalize/vendor.js, whose answer this
// asks for rather than restating), the wording (-> assets/registry.yaml) or the severity
// (-> that entry).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { vendorFileNames } from "../../normalize/vendor.js";
import { PACKAGE_FILE } from "../../vendor/package-file.js";
import { TREE_LOCKS } from "../../vendor/locks.js";
import { basename } from "../../util/files.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

/** What the review reads a dependency DECLARATION from, by basename. A VENDOR file is
 *  asked for separately, because what counts as one is that module's answer. */
const DECLARATION_FILES = new Set([PACKAGE_FILE, ...TREE_LOCKS]);

/**
 * Every vendoring file the built XPI carries, as packaged paths, sorted and without
 * repeats.
 *
 * Matched at any depth, by basename, because a declaration is a declaration wherever the
 * packaging put it. Both halves read the same keyspace: for a built XPI `files` holds every
 * key the store has (src/addon/load.js), so a path from either is a path a reviewer can
 * open.
 *
 * Each half matches the way its own READER matches, which is why the case rules differ. A
 * VENDOR file is found case-insensitively (vendorFileNames), because that is how the review
 * finds the one it reads. A package.json or a lock is matched exactly, because that is how
 * npm resolves them and how src/vendor/package-file.js and src/vendor/locks.js read them.
 * Reporting a `Package.json` that nothing else in the review treats as one would name a file
 * the developer cannot act on.
 * @param {import("../../addon/load.js").Addon} xpi
 * @returns {string[]}
 */
function vendoringFilesIn(xpi) {
  const found = new Set(vendorFileNames(xpi));
  for (const key of xpi.store.keys()) {
    if (DECLARATION_FILES.has(basename(key))) {
      found.add(key);
    }
  }
  return [...found].sort();
}

export default {
  /**
   * @param {RunContext} ctx  The cross-artifact ctx: ctx.xpi and ctx.sca, no ctx.artifact.
   *   Only the XPI is read - the question is about what was shipped, and the archive is
   *   what makes it a question at all rather than something the check has to look at.
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const files = vendoringFilesIn(ctx.xpi);
    const loci = files.map((file) => ctx.xpi.at(file));
    for (const at of loci) {
      ctx.note?.(at, "vendoring information in the XPI", VERDICT.FAIL);
    }
    // Minted by the XPI, because this route carries two artifacts and so names neither:
    // asking the side the files are actually in is how the finding says which it means.
    return { findings: loci.map((at) => finding(at)) };
  },
};
