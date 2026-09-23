// Rejects a package.json dependency declared from a source the review does not
// support. Only two sources are auditable: an npm package and a GitHub URL (rated by
// popularity). This is the SOURCE axis - whether the release a spec names can be
// pinned at all is a separate question, answered per submission type
// (xpi-package-unpinned, sca-lock-file-missing / sca-lock-file-invalid).
// Anything else - a local file: path, a link:/workspace: ref, a tarball URL, or a
// non-GitHub git source - cannot be identified or vetted, so the
// developer must re-declare it as a pinned npm/GitHub dependency or bundle the
// library with the add-on as authored code so it can be reviewed directly.
// An `npm:<name>@<range>` alias is NOT one of them: it installs a registry package under
// another name, so it is classified by what it installs and the spelling decides nothing.
// resolveVendor already classified these (src/vendor/resolve.js ->
// addon.vendor.unsupportedDeps); this check only reads that and emits a finding
// per entry. Deterministic, no network.
//
// Belongs here: turning each unsupported dependency into a finding (+ a feed
// note). Does NOT belong here: parsing package.json / classifying specs (->
// src/vendor/resolve.js) and the registry wording.

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { anchorText, manifestTokenLine } from "../../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const { addon } = ctx;
    const unsupported = addon?.vendor?.unsupportedDeps ?? [];
    const text = anchorText(addon, "package.json");
    const findings = [];
    for (const { name, spec } of unsupported) {
      const line = manifestTokenLine(text, name);
      const loc = line ? { line } : undefined;
      ctx.note?.(
        "package.json",
        loc,
        `${name} ("${spec}") is from an unsupported source`,
        VERDICT.FAIL
      );
      // Collapsed response (no {{item}}): the subject renders on the location line
      // as `name (spec)`, matching the other dependency rejects.
      findings.push(
        finding({ file: "package.json", loc, item: `${name} (${spec})` })
      );
    }
    return { findings };
  },
};
