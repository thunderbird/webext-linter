// A source-code submission whose archive holds the built XPI entire: every file the XPI
// ships is byte-identical to a file the archive carries, wherever it sits.
//
// TWO submissions look like this and the check cannot tell them apart, which is why the
// response offers two remedies rather than assuming one. Either nothing was built, and the
// shipped bytes ARE the submitted source - then the XPI on its own is a complete review
// target and the archive bought a slower review for nothing. Or a build ran and its OUTPUT
// was committed beside the real source - then the archive is right to exist and the build
// output is what does not belong in it. Both leave every shipped file readable in the
// archive, which is the only thing asked here.
//
// The comparison is CONTENT, anywhere in the archive: a build that merely relocates files
// still leaves every shipped byte readable, which is what the question is about. It runs
// here, in the check that reports it, rather than in setup - the answer has one reader, and
// a check that reads a flag it cannot verify cannot explain it either. `input: both` is
// what lets it: the one route that carries two artifacts, because "is what was shipped
// already readable in what was submitted?" has no answer from one side.
//
// Nothing is narrowed by this: THIS review stays a full source review whatever the answer.
// No content test can be trusted to route, because a committed unminified build is its own
// twin under any of them, and routing on that would let a build be dressed up as source.
//
// Belongs here: the comparison. Does NOT belong here: the wording
// (-> assets/registry.yaml) or the severity (-> that entry).

import { finding } from "../../report/finding.js";
import { rawSha256 } from "../../normalize/hash.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

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
 *
 * The two stores are not symmetric, which bounds what this can answer. A source archive is
 * loaded with its installed trees recorded rather than read (loadSourceArchive), so nothing
 * under node_modules reaches `sca.store`, while an XPI that ships such a folder has every
 * byte of it in `xpi.store`. A submission shipping node_modules therefore looks unmatched
 * here and stays silent - which costs nothing today, because committed-node-modules already
 * rejects it as an error, and that is the finding its developer has to act on.
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
    if (!everyShippedByteIsInTheArchive(ctx.xpi, ctx.sca)) {
      return { findings: [] };
    }
    // No FILE: every shipped file is the subject, so naming them lists the whole XPI.
    // The artifact is the archive all the same - `input: both` says this check READS two,
    // and what it accuses is the one holding what should not be in it, which the response
    // says too ("remove the build output from the archive"). The XPI is the comparand.
    // So the locus is minted from ctx.sca: a claim about a package, not a file in one.
    return { findings: [finding(ctx.sca.at())] };
  },
};
