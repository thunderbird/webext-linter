// A source-code archive was submitted where the built XPI alone would have done. Two ways
// the submission says so, and one remedy for both, which is why they are one check:
//
//   1. The XPI carries VENDORING INFORMATION - a VENDOR file, a package.json, a lock file.
//      In a source-code submission those belong in the ARCHIVE: that is the copy the
//      reviewer reads and the build installs from. A shipped one either means the process
//      was misread, or that this was meant to be an XPI-only submission all along.
//   2. Every file the XPI ships is byte-identical to a file in the archive. Then nothing
//      was built - the shipped bytes ARE the submitted source, readable as they stand, and
//      the XPI on its own is a complete review target.
//
// ADVICE about the NEXT submission, at warning severity. THIS review stays a full source
// review either way and nothing is narrowed by it - no content test can be trusted to
// route, because a committed unminified build is its own twin under any of them, and
// routing on that would let a build be dressed up as source. Under
// --warnings-as-errors a new submission can be refused at intake, while an update that
// switched to a source archive by accident is only told to go back.
//
// The comparison is CONTENT, anywhere in the archive: a build that merely relocates files
// still leaves every shipped byte readable, which is what the question is about. It runs
// here, in the check that reports it, rather than in setup - the answer has one reader, and
// a check that reads a flag it cannot verify cannot explain it either. `input: both` is
// what lets it: the one route that carries two artifacts, because "is what was shipped
// already readable in what was submitted?" has no answer from one side.
//
// Belongs here: the two questions and the comparison. Does NOT belong here: the wording
// (-> assets/registry.yaml) or the severity (-> that entry).

import { finding } from "../../report/finding.js";
import { rawSha256 } from "../../normalize/hash.js";
import { vendorFileNames } from "../../normalize/vendor.js";
import { PACKAGE_FILE } from "../../vendor/package-file.js";
import { TREE_LOCKS } from "../../vendor/locks.js";
import { basename } from "../../util/files.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

/** What the review reads a dependency DECLARATION from, by basename. A VENDOR file is
 *  asked for separately, because what counts as one is that module's answer. */
const DECLARATION_FILES = new Set([PACKAGE_FILE, ...TREE_LOCKS]);

/**
 * Whether the built XPI carries vendoring information of its own.
 * @param {import("../../addon/load.js").Addon} xpi
 * @returns {boolean}
 */
function carriesVendoringInfo(xpi) {
  if (vendorFileNames(xpi).length > 0) {
    return true;
  }
  for (const key of xpi.store.keys()) {
    if (DECLARATION_FILES.has(basename(key))) {
      return true;
    }
  }
  return false;
}

/**
 * Whether every byte the XPI ships is readable in the archive: each shipped file is
 * byte-identical to SOME file the archive holds, wherever it sits.
 *
 * Hashed, not compared pairwise. "Identical to some file" is set membership, so hashing
 * each side once and probing a set is one pass over each artifact, where comparing every
 * shipped file against every archive file of its size is a pass per pair. Byte-identity is
 * what rawSha256 answers - the exact bytes, with no EOL normalization, because a file a
 * build rewrote line endings in is a file the build touched. The size bucket in front of it
 * means a shipped file with no same-size candidate is answered without hashing anything.
 *
 * Both sides read `.store`, not `.files`: the archive's `files` view leaves out the
 * Experiment implementation (scaViews), and a twin there is still a twin - reading the view
 * would report a difference the submission does not have.
 * @param {import("../../addon/load.js").Addon} xpi
 * @param {import("../../addon/load.js").Addon} sca
 * @returns {boolean}
 */
function everyShippedByteIsInTheArchive(xpi, sca) {
  const archiveKeysBySize = new Map();
  for (const key of sca.store.keys()) {
    const size = sca.store.get(key).length;
    const keys = archiveKeysBySize.get(size) ?? [];
    keys.push(key);
    archiveKeysBySize.set(size, keys);
  }
  /** size -> the hashes of the archive files that size, hashed at the first ask. */
  const hashesBySize = new Map();
  for (const key of xpi.store.keys()) {
    const buf = xpi.store.get(key);
    const candidates = archiveKeysBySize.get(buf.length);
    if (!candidates) {
      return false; // nothing that size: no twin, and nothing hashed to find out
    }
    let hashes = hashesBySize.get(buf.length);
    if (!hashes) {
      hashes = new Set(candidates.map((k) => rawSha256(sca.store.get(k))));
      hashesBySize.set(buf.length, hashes);
    }
    if (!hashes.has(rawSha256(buf))) {
      return false;
    }
  }
  return true;
}

export default {
  /**
   * @param {RunContext} ctx  The cross-artifact ctx: ctx.xpi and ctx.sca, no ctx.artifact.
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const { xpi, sca } = ctx;
    if (
      !carriesVendoringInfo(xpi) &&
      !everyShippedByteIsInTheArchive(xpi, sca)
    ) {
      return { findings: [] };
    }
    // No locus: the subject is the submission as a whole, not a file in it.
    return { findings: [finding({})] };
  },
};
