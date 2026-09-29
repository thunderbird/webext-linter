// Rejects a package.json dependency declared from a source the review does not
// support. Only two sources are auditable: an npm package and a GitHub URL (rated by
// popularity). This is the SOURCE axis - whether the release a spec names can be
// pinned at all is a separate question, answered per submission type
// (xpi-lock-file-missing / xpi-lock-file-invalid, sca-lock-file-missing /
// sca-lock-file-invalid).
// Anything else - a workspace: ref, a tarball URL, a non-GitHub git source, or a
// file:/link: path that does NOT resolve to a real directory inside the submission -
// cannot be identified or vetted, so the developer must re-declare it as a pinned
// npm/GitHub dependency or bundle the library with the add-on as authored code so it
// can be reviewed directly. A file:/link: path that DOES resolve inside the submission
// (SCA mode only) is exactly that already - resolveVendor drops it from
// unsupportedDeps entirely and classifies ITS OWN declared dependencies the same way
// (src/vendor/package-file.js resolveLocalPackageFiles), so it never reaches this check at
// all; only an unresolvable one, root or nested, does.
// An `npm:<name>@<range>` alias is NOT one of them: it installs a registry package under
// another name, so it is classified by what it installs and the spelling decides nothing.
// resolveVendor already classified these (src/vendor/resolve.js ->
// artifact.vendor.unsupportedDeps, each item carrying the package file that declared it);
// this check only reads that and emits a finding per entry. Deterministic, no network.
//
// Belongs here: turning each unsupported dependency into a finding (+ a feed
// note). Does NOT belong here: parsing package.json / classifying specs (->
// src/vendor/resolve.js) and the registry wording.

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { anchorText, tokenLine, utf8ComparisonSigns } from "../../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const { artifact } = ctx;
    const unsupported = artifact.vendor.unsupportedDeps ?? [];
    // Memoized per distinct file: a nested package file can declare several unsupported
    // specs, and re-reading/re-decoding the same bytes once per one would be wasted work.
    const textByFile = new Map();
    const findings = [];
    for (const { name, spec, file } of unsupported) {
      const at = file ?? "package.json";
      let text = textByFile.get(at);
      if (text === undefined) {
        text = anchorText(artifact, at);
        textByFile.set(at, text);
      }
      const line = tokenLine(text, name);
      const loc = line ? { line } : undefined;
      ctx.note?.(
        ctx.artifact.at(at, loc),
        `${name} ("${spec}") is from an unsupported source`,
        VERDICT.FAIL
      );
      // Collapsed response (no {{item}}): the subject renders on the location line
      // as `name (spec)`, matching the other dependency rejects. utf8ComparisonSigns:
      // a spec's comparison signs must stay readable/copyable, unlike free prose - see
      // its own doc comment (src/lib/util.js).
      findings.push(
        finding({
          ...ctx.artifact.at(at, loc),
          item: utf8ComparisonSigns(`${name} (${spec})`),
        })
      );
    }
    return { findings };
  },
};
