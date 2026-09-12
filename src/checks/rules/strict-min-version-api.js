// Flags functions/events whose schema version_added is newer than the add-on's
// declared strict_min_version: the add-on claims to run on Thunderbird versions where
// the API does not yet exist, so an unconditional call breaks those installs.
//
// Every hit ESCALATES; this check never rejects on its own. The same API is used safely
// whenever the add-on keeps it off the versions that lack it, and the constructions that
// do so are open-ended - a cached boolean, a version compared after an awaited
// getBrowserInfo, an early return in a helper, a try/catch fallback. Deciding from the
// AST which of those is a real guard is a judgement, and a wrong one rejects a working
// add-on. So the scan reports WHERE the question is and a reader settles it, reading the
// call in its file. That is the whole contract: the check locates, it does not judge.
//
// Scope: this only ever sees REAL, schema-resolved APIs (kind function|event with a
// version_added). A hallucinated/unsupported API resolves to neither and is left to
// unknown-api.
//
// Tuple comparison, so version_added "140.4.1" against strict_min "140.0" is caught.
// No-op when strict_min_version is absent or unparsable. Independent of
// strict-max-version-api.js (the high bound), which stays deterministic (no construction
// can make an API exist on a version capped below it).
//
// Belongs here: the version_added vs strict_min comparison. Does NOT
// belong here: resolving usage against the schema over the WebExtension tree (->
// src/lib/api-resolution.js), extracting browser.* usage (src/parse/api-usage.js via
// ctx.apiUsages), reading schema annotations (SchemaIndex), the verdict mapping
// (lib/verdict-resolve.js), or the wording / severity (assets/registry.yaml).

import { VERDICT } from "../../lib/enum.js";
import { SchemaIndex } from "../../schema/index.js";
import { strictMinVersion, parseVersion, cmpVersion } from "../../lib/util.js";
import { resolveApiUsages } from "../../lib/api-resolution.js";

export default {
  /**
   * @param {import("../registry.js").RunContext} ctx
   * @returns {{findings: object[],
   *   escalations: import("../escalation.js").Escalation[]}}
   */
  run(ctx) {
    const minStr = ctx.manifest ? strictMinVersion(ctx.manifest) : undefined;
    const min = parseVersion(minStr);
    if (!min) {
      ctx.note?.(
        "manifest.json",
        null,
        "no parsable strict_min_version",
        VERDICT.SKIPPED
      );
      return { findings: [] };
    }

    // EVERY site, not one per api. Whether a call is kept off the versions that lack the
    // API is a property of that call: a capability flag can cover one use and not the
    // next, and a reader cannot settle a site they were never shown. Each one gets its
    // own index and so its own verdict.
    const sites = [];
    for (const { file, usage, res } of resolveApiUsages(ctx)) {
      if (res.kind !== "function" && res.kind !== "event") {
        continue;
      }
      const va =
        SchemaIndex.versionAdded(res.def) ||
        SchemaIndex.versionAdded(res.namespaceDef);
      // A null version means skip: boolean false (handled by unknown-api),
      // true/absent (supported), and "≤N" (pre-WebExtension, always available).
      const added = parseVersion(va);
      if (!added || cmpVersion(added, min) <= 0) {
        continue;
      }
      sites.push({
        display:
          `${usage.root ?? "browser"}.${usage.segments.join(".")}` +
          (res.kind === "function" ? "()" : ""),
        va,
        file,
        loc: { line: usage.line, column: usage.column },
      });
    }

    const escalations = [];
    for (const e of sites) {
      ctx.note?.(
        e.file,
        e.loc,
        `${e.display} (added in TB ${e.va})`,
        VERDICT.UNSURE
      );
      escalations.push({
        file: e.file,
        loc: e.loc,
        item: e.display,
        hint: `added in Thunderbird ${e.va}`,
        data: { min: String(minStr) },
      });
    }

    return { findings: [], escalations };
  },
};
