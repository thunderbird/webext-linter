// Rejects a source-code submission whose build uses a package manager other than npm or
// pnpm. Only those two are supported: they share the .npmrc config format, keeping the
// reviewable build surface small (yarn's .yarnrc.yml / PnP / plugins / committed yarnPath
// binary and bun's runtime are a much larger surface). The tool is identified
// deterministically from a committed FINGERPRINT (src/build/tools.js), so no judgement or
// network is needed. Pinning is a separate axis (xpi-package-unpinned for a shipped
// manifest, the lock checks here); the open-ended build review is undeclared-build-source.
//
// review-early-exit: the reviewer reproduces the build to attest that this source produces
// the shipped XPI, and they cannot do that with a tool the review does not support - so
// every question that depends on installing or building is unanswerable and none is put to
// them. That halt is also why the lock checks fall silent on the same submission: a
// disallowed tool and a missing npm/pnpm lock are one fact, told once, here.
//
// Belongs here: turning a disallowed-tool fingerprint into a finding. Does NOT belong here:
// what counts as a fingerprint (-> src/build/tools.js), which files are in the build corpus
// (-> src/addon/load.js) or the wording (-> the registry).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { unsupportedBuildTool } from "../../build/tools.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const found = unsupportedBuildTool(ctx.addon);
    if (!found) {
      return { findings: [] };
    }
    // Exactly one finding: the tool policy is a single verdict, whatever else fingerprints.
    ctx.note?.(found.file, null, `build uses ${found.tool}`, VERDICT.FAIL);
    return { findings: [finding({ file: found.file, item: found.tool })] };
  },
};
