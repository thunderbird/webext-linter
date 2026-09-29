// A source-code review, said by `input: sca` - the archive it reads exists in no other
// kind. Rejects a declared dependency that is not a confirmed
// widely-used library. In a source-code submission the dependency code is not in
// the readable source (it is pulled in at build) and is mangled in the built XPI,
// so a non-popular one cannot be reviewed. The remedy differs by what it is for: a
// SHIPPED dependency can be included readable in the archive instead, and a BUILD
// one cannot, so there the answer is a widely-used equivalent, or dropping the dependency
// where reproducing the XPI never needed it. Build dependencies are
// held to the same bar for the reason they are OSV-audited - the reviewer installs and
// RUNS them - so the pre-step (src/vendor/verify.js verifyScaDependencies) looks up the
// popularity of every declared dependency, production and build alike, and records the
// ones below the trust bar on artifact.vendor.unpopularDeps.
// This check only reads that and emits one error finding per such dependency,
// anchored at its package.json declaration line. Deterministic, no network.
//
// A POPULAR dependency is not recorded (trusted by ubiquity), so it never reaches
// here. OSV vulnerability auditing of every declared dependency is separate (->
// auditNpm -> vendor-vulnerable).
//
// Belongs here: turning each recorded unpopular dependency into a finding (+ a
// feed note). Does NOT belong here: the popularity lookup (-> src/vendor/
// verify.js), the dep pinning (-> src/vendor/resolve.js + src/vendor/locks.js),
// and the wording (-> assets/registry.yaml).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { anchorText, declarationLine } from "../../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const { artifact } = ctx;
    const deps = artifact.vendor.unpopularDeps ?? [];
    const findings = [];
    for (const { name, version, file, token } of deps) {
      const text = anchorText(artifact, file);
      // Anchor at the dependency's declaration line (a quoted JSON key in
      // package.json); fall back to a plain substring, then to no line.
      const line = token ? declarationLine(text, token) : null;
      const loc = line ? { line } : undefined;
      // The response is collapsible (no {{item}}), so `item` renders on the
      // location line as "package.json:<line> - <name> (<version>)".
      const item = `${name} (${version})`;
      ctx.note?.(
        ctx.artifact.at(file, loc),
        `${item} - unreviewable build dependency`,
        VERDICT.FAIL
      );
      findings.push(finding({ ...ctx.artifact.at(file, loc), item }));
    }
    return { findings };
  },
};
