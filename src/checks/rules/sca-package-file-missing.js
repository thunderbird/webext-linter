// Rejects a source-code submission that carries no package.json. The archive exists so a
// reviewer can reproduce the build that produced the shipped XPI, and the build's entry
// point is the root package.json (src/build/collect.js seeds the trace from it), so its
// absence is the absence of a build: there is nothing to reproduce.
//
// Reported as the bare fact. Whether the developer forgot it, packed the wrong folder, or
// never had a build is not decidable from an archive that does not contain one, so nothing
// here guesses.
//
// Presence is tested by NAME, not by parse: a package.json that exists but cannot be used
// is not MISSING, and sca-package-file-invalid reports it. Both read PACKAGE_FILE, so the
// two cannot disagree about which file they mean, and exactly one of them speaks.
//
// NOT silent when the shipped XPI happens to be the archive's own code. That the shipped
// bytes are readable says nothing about whether this source produces them, which is what a
// reviewer reproduces the build to establish - and with no build there is nothing to
// reproduce, so the review stops here either way. Whether the archive held the whole XPI
// is INDEPENDENT of this (sca-xpi-fully-included-in-archive): that asks what the archive
// contains, and prints beside this rejection rather than in place of it.
//
// Belongs here: asking whether the package file is there. Does NOT belong here: whether it can
// be used (-> sca-package-file-invalid), what it declares (-> src/vendor/package-file.js), and
// the wording (-> assets/registry.yaml).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { PACKAGE_FILE } from "../../vendor/package-file.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    if (ctx.artifact.files.has(PACKAGE_FILE)) {
      return { findings: [] };
    }
    // The FINDING names no file: its subject is something the archive does not contain, so
    // there is nothing to anchor it at. The feed note still names package.json, the file
    // whose absence is the whole point, so the reviewer reads what was looked for rather
    // than a bare verdict.
    ctx.note?.(ctx.artifact.at(PACKAGE_FILE), "no package.json", VERDICT.FAIL);
    return { findings: [finding({ ...ctx.artifact.at() })] };
  },
};
