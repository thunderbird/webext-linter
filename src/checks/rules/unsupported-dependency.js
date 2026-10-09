// Rejects a dependency installed from a source the review does not support. Only two
// sources are auditable: an npm package and a GitHub URL (rated by popularity). This is the
// SOURCE axis - whether the release a spec names can be pinned at all is a separate
// question, answered per submission type (xpi-lock-file-missing / xpi-lock-file-invalid,
// sca-lock-file-missing).
//
// Read per review, from what that review reads its dependencies out of. A built XPI's
// package.json: a workspace: ref, a tarball URL, a non-GitHub git source or a file:/link:
// path cannot be identified or vetted, so the developer must re-declare it as a pinned
// npm/GitHub dependency or bundle the library with the add-on as authored code. An
// `npm:<name>@<range>` alias is NOT one of them: it installs a registry package under
// another name, so it is classified by what it installs and the spelling decides nothing
// (src/vendor/resolve.js -> artifact.vendor.unsupportedDeps). A source archive's committed
// lock file: an install from a local path the archive does not hold as a folder - outside
// the source root, absent, or a local tarball (src/vendor/locks.js localInstalls ->
// artifact.vendor.lockLocalInstalls). A local folder inside the source root is the
// submission's own code, reviewed like any other file, so it never reaches this check; a
// remote tarball or a non-GitHub git source in the lock is lock-foreign-source's.
// This check only reads those two lists and emits a finding per entry. Deterministic, no
// network.
//
// Belongs here: turning each unsupported dependency into a finding (+ a feed
// note). Does NOT belong here: parsing package.json / classifying specs (->
// src/vendor/resolve.js), reading the lock (-> src/vendor/locks.js) and the registry
// wording.

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import {
  anchorText,
  declarationLine,
  tokenLine,
  utf8ComparisonSigns,
} from "../../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const { artifact } = ctx;
    // One of the two is empty in any review: a built XPI fills the first, a source
    // archive the second (src/vendor/resolve.js).
    const unsupported = [
      ...(artifact.vendor.unsupportedDeps ?? []),
      ...(artifact.vendor.lockLocalInstalls ?? []),
    ];
    // Memoized per distinct file: one file can hold several unsupported entries, and
    // re-reading/re-decoding the same bytes once per one would be wasted work.
    const textByFile = new Map();
    const findings = [];
    for (const { name, spec, file, token } of unsupported) {
      const at = file ?? "package.json";
      let text = textByFile.get(at);
      if (text === undefined) {
        text = anchorText(artifact, at);
        textByFile.set(at, text);
      }
      // A lock entry carries the string locating it (a JSON key or a YAML key); a
      // package.json declaration is found by its quoted name.
      const line = token ? declarationLine(text, token) : tokenLine(text, name);
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
