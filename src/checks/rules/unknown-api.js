// Flags usage of WebExtension APIs not in Thunderbird's annotated schema: unknown
// namespaces, unknown members of a known namespace, and members that exist but are
// explicitly marked `unsupported`. Reads the shared, reachability-filtered resolution
// (lib/api-resolution.js) and emits a verdict per usage.
//
// Every hit ESCALATES; this check never rejects on its own. An absent API is a fact, but
// whether the add-on is BROKEN by it is not: a fallback path may carry the add-on on the
// versions and browsers that lack the reference, and the constructions that arrange this
// are open-ended - a feature detection, a cross-browser shim, a cached capability flag, a
// try/catch. Deciding from the AST which of those really covers a given call is a
// judgement, and a wrong one rejects a working add-on. So the scan reports WHERE the
// question is and a reader settles it, reading the site against the schema.
//
// EVERY reference is listed, never one per name. Whether the NAME is in the schema is
// indeed one fact, but that is not what a reader settles here - they settle whether the
// add-on copes without it, and coping is a property of the site: one reference may sit in
// a try/catch with a fallback while the next is bare. Collapsing them would let a clear
// granted at the site someone read cover the sites nobody did, which is the silent clear
// this check exists to avoid.
//
// Belongs here: deciding which resolveApi outcomes (unknown-namespace, unknown-member,
// unsupported def) are worth a reader's attention, and picking the item string
// (root.first-segment for an unknown namespace, else the full path).
// Does NOT belong here: resolving usage against the schema over the WebExtension
// tree - that is the shared src/lib/api-resolution.js (resolveApiUsages).
// Extracting browser.* usage from source - src/parse/api-usage.js. Walking the
// schema (isUnsupported) - src/schema/index.js. Authored wording ->
// assets/registry.yaml. Severity -> that registry entry, stamped by runChecks
// (src/checks/registry.js). Report formatting -> src/report/format.js.

import { VERDICT } from "../../lib/enum.js";
import { SchemaIndex } from "../../schema/index.js";
import { resolveApiUsages } from "../../lib/api-resolution.js";

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: [], escalations: object[]}}
   */
  run(ctx) {
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
        args = { file, loc, item: full };
      }

      if (!reason) {
        ctx.note?.(file, loc, full, VERDICT.PASS);
        continue;
      }
      // The hint is the REASON, uniformly: it names what the reader has to settle about
      // this reference, and that is the same question in all three shapes. The
      // developer-facing docs link lives in the entry's response, not here.
      ctx.note?.(file, loc, `${full} (${reason})`, VERDICT.UNSURE);
      escalations.push({ ...args, hint: reason });
    }
    return { findings: [], escalations };
  },
};
