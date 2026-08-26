// Flags usage of WebExtension APIs not in Thunderbird's annotated schema: unknown
// namespaces, unknown members of a known namespace, and members that exist but are
// explicitly marked `unsupported`. Reads the shared, reachability-filtered resolution
// (lib/api-resolution.js) and emits a verdict per usage. A FEATURE-DETECTED (guarded)
// reference to an unknown MEMBER or an unsupported API goes to manual review rather
// than being reported or dropped: the add-on's fallback probably runs where the API is
// missing, but the guard signal is coarse (usage.guarded from api-usage.js -
// alias-aware, and satisfied by a `typeof _api.foo` probe or an earlier guard clause
// alike), so a human reads the site instead of the check guessing. A whole unknown
// NAMESPACE asks for more than a guard: it is skipped only when the guard offers a
// namespace that EXISTS in its place (usage.guardRefs - the other arm of the same
// short-circuit), the cross-browser shim shape, where the add-on's working path is the
// one it actually takes. Guarded with nothing live offered, the namespace is absent
// however the guard is written, so it stays a finding - a hallucinated or mistyped
// namespace cannot buy its way out by standing near a real one.
//
// Belongs here: deciding which resolveApi outcomes (unknown-namespace,
// unknown-member, unsupported def) count as a finding (a guarded member/unsupported
// escalates instead; a guarded unknown namespace is a finding unless the guard offers
// a live one), resolving what that guard names, and picking the item string
// (root.first-segment for an unknown namespace, else the full path).
// Does NOT belong here: resolving usage against the schema over the WebExtension
// tree - that is the shared src/lib/api-resolution.js (resolveApiUsages).
// Extracting browser.* usage from source - src/parse/api-usage.js. Walking the
// schema (isUnsupported, docUrl) - src/schema/index.js. Authored wording ->
// assets/registry.yaml. Severity -> that registry entry, stamped by runChecks
// (src/checks/registry.js). Report formatting -> src/report/format.js.

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { SchemaIndex } from "../../schema/index.js";
import { resolveApiUsages } from "../../lib/api-resolution.js";

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[],
   *   escalations: object[]}}
   */
  run(ctx) {
    const findings = [];
    const escalations = [];
    for (const { file, usage, res } of resolveApiUsages(ctx)) {
      const full = `${usage.root}.${usage.segments.join(".")}`;
      const loc = { line: usage.line, column: usage.column };

      // Classify: what (if anything) makes this API unavailable, and the finding it
      // would produce. reason === null means the API is available (a pass).
      let reason = null;
      let args = null;
      if (res.kind === "unknown-namespace") {
        reason = "unknown namespace";
        args = { file, loc, item: `${usage.root}.${usage.segments[0]}` };
      } else if (res.kind === "unknown-member") {
        reason = "unknown member";
        args = { file, loc, item: full };
      } else if (
        SchemaIndex.isUnsupported(res.def) ||
        SchemaIndex.isUnsupported(res.namespaceDef)
      ) {
        reason = "unsupported";
        args = { file, loc, item: full, hint: SchemaIndex.docUrl(res.def) };
      }

      if (!reason) {
        ctx.note?.(file, loc, full, VERDICT.PASS);
        continue;
      }

      // A feature-detected (guarded) reference to an unknown MEMBER or an unsupported
      // API is probably safe - the add-on's fallback runs where the API is missing -
      // but whether a given guard really covers a given call is a local judgement,
      // and the guard signal is a coarse one. So it goes to a human rather than
      // being dropped: read the site, then either it is fine or it is a finding.
      if (usage.guarded && res.kind !== "unknown-namespace") {
        ctx.note?.(
          file,
          loc,
          `${full} (${reason}, feature-detected)`,
          VERDICT.UNSURE
        );
        escalations.push({ file, loc, item: full, hint: reason });
        continue;
      }
      // The shim is the one guarded case that IS settled: the other arm of the same
      // short-circuit names a namespace the schema has, so the path the add-on takes
      // is the working one and there is nothing for anyone to read.
      if (usage.guarded && namesLiveNamespace(ctx, usage)) {
        ctx.note?.(
          file,
          loc,
          `${full} (${reason}, feature-detected)`,
          VERDICT.SKIPPED
        );
        continue;
      }

      ctx.note?.(file, loc, `${full} (${reason})`, VERDICT.FAIL);
      findings.push(finding(args));
    }
    return { findings, escalations };
  },
};

/**
 * Whether the guard around a usage names a namespace the schema actually has. The
 * guard's own paths are recorded by api-usage (usage.guardRefs); a path with no
 * segments carries no namespace to look up (a bare root, getBrowserInfo) and so
 * vouches for nothing.
 * @param {RunContext} ctx
 * @param {import("../../parse/api-usage.js").ApiUsage} usage
 * @returns {boolean}
 */
function namesLiveNamespace(ctx, usage) {
  return (usage.guardRefs ?? []).some(
    (segments) =>
      segments.length > 0 &&
      ctx.schema.resolveApi(segments).kind !== "unknown-namespace"
  );
}
