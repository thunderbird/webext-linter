// Rejects a source-code submission that carries no package.json. The archive exists so a
// reviewer can reproduce the build that produced the shipped XPI, and the build's entry
// point is the root package.json (src/build/corpus.js seeds the corpus from it), so its
// absence is the absence of a build: there is nothing to reproduce.
//
// Reported as the bare fact. Whether the developer forgot it, packed the wrong folder, or
// never had a build is not decidable from an archive that does not contain one, so nothing
// here guesses.
//
// Presence is tested by NAME, not by parse: a package.json that exists but cannot be used
// is not MISSING, and sca-package-file-invalid reports it. Both read MANIFEST_FILE, so the
// two cannot disagree about which file they mean, and exactly one of them speaks.
//
// Silent on a submission that fingerprints as an unsupported package manager
// (src/build/tools.js): the tool is the fault there, reported once by the check whose
// subject it is, which carries the same review-early-exit.
//
// NOT silent when the shipped XPI happens to be the archive's own code. That the shipped
// bytes are readable says nothing about whether this source produces them, which is what a
// reviewer reproduces the build to establish - and with no build there is nothing to
// reproduce, so the review stops here either way. The XPI-only advice is what yields:
// sca-not-required is withheld from a submission whose build cannot be run
// (src/build/reproducible.js), rather than this rejection being withheld from it.
//
// Belongs here: asking whether the manifest is there. Does NOT belong here: whether it can
// be used (-> sca-package-file-invalid), what it declares (-> src/vendor/manifest.js), and
// the wording (-> assets/registry.yaml).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { MANIFEST_FILE } from "../../vendor/manifest.js";
import { unsupportedBuildTool } from "../../build/tools.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    if (
      unsupportedBuildTool(ctx.addon) ||
      ctx.addon?.files?.has(MANIFEST_FILE)
    ) {
      return { findings: [] };
    }
    // The FINDING names no file: its subject is something the archive does not contain, so
    // there is nothing to anchor it at. The feed note still names package.json, the file
    // whose absence is the whole point, so the reviewer reads what was looked for rather
    // than a bare verdict.
    ctx.note?.(MANIFEST_FILE, null, "no package.json", VERDICT.FAIL);
    return { findings: [finding({})] };
  },
};
