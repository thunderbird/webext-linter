// Whether the submitted build files can be run at all - one question, asked of the FILES.
//
// It exists for the XPI-only advice (sca-not-required). That advice tells a developer their
// source archive was unnecessary because the shipped add-on IS the archive's code, and it
// only holds for a build that WORKS: a build that is missing or broken cannot be reproduced,
// so the review stops on it instead, and telling the same submission its archive was
// unnecessary would contradict the rejection printed beside it.
//
// The faults are the ones the four build-file checks report, in the order a reviewer meets
// them - an unsupported package manager, then the manifest, then the lock. Each check
// reports its own slice and this composes them, so the advice cannot survive a fault that
// something else rejected. Asked of the files rather than of those checks' outcomes: a
// check cannot read another's findings, and an answer that depended on which ran first
// would change with registry order.
//
// Belongs here: whether anything makes this build unrunnable. Does NOT belong here: what to
// SAY about each fault (-> the five checks and their registry entries), and deciding the
// advice itself (-> resolveXpiOnlyAdvice in src/pipeline.js, which asks a different
// question - whether the shipped bytes are the source).

import { lockGaps, TREE_LOCKS } from "../vendor/locks.js";
import { MANIFEST_FILE, parseManifest } from "../vendor/manifest.js";
import { unsupportedBuildTool } from "./tools.js";

/** @typedef {import("../addon/load.js").Addon} Addon */

/**
 * Why this build cannot be run, or null when nothing stops it.
 *
 * Every branch mirrors the check that reports it, reading the same shared helpers, so the
 * two cannot come to different answers about one submission.
 * @param {?{files?: Map<string, Buffer>}} addon  The SCA build corpus.
 * @returns {?string}  `tool`, `manifest-absent`, `manifest-unusable`, `lock-absent`,
 *   `lock-unusable`, or null.
 */
export function buildFileFault(addon) {
  if (unsupportedBuildTool(addon)) {
    return "tool"; // -> unsupported-build-tool
  }
  const files = addon?.files;
  if (!files?.has(MANIFEST_FILE)) {
    return "manifest-absent"; // -> sca-package-file-missing
  }
  const pkg = parseManifest(files.get(MANIFEST_FILE));
  if (!pkg) {
    return "manifest-unusable"; // -> sca-package-file-invalid
  }
  if (!TREE_LOCKS.some((lock) => files.has(lock))) {
    return "lock-absent"; // -> sca-lock-file-missing
  }
  return lockGaps(addon).length ? "lock-unusable" : null; // -> sca-lock-file-invalid
}
