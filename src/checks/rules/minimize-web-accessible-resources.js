// LLM check: minimize web_accessible_resources. The deterministic pre-flight
// resolves the clear cases as findings, with two concerns. (a) Over-broad
// exposure - a resource pattern like "*" exposes the whole add-on, and MV3
// matches like <all_urls> / *://*/* expose to every site. (b) A concrete exposed
// resource that no content script or page loads (not web-reachable via
// getURL/HTML/CSS) is a finding when clearly unloaded. When a resource is
// ambiguous (live code names it, or the add-on uses dynamic loaders) each
// suspected loader SITE becomes an LLM candidate ("does this site load F for a
// web context?"); this check aggregates per exposed file F (any site loads it ->
// the exposure is needed; none does -> needless).
//
// Belongs here: classifying each web_accessible_resources entry as a finding, a
// candidate, or clean, the per-site candidate set, and the per-F aggregation.
// Does NOT belong here: parsing the entry list and the broad/over-broad
// predicates (warResourceList, expandResourcePattern, isOverBroadResource) ->
// src/checks/lib/web-accessible-resources.js. The web-reachability graph and
// mention/loader-site lookups -> src/checks/lib/reachability.js + util.js. The
// model transport -> src/checks/llm-client.js. The resolve pattern ->
// src/checks/lib/verdict-resolve.js. Authored wording -> assets/registry.yaml.
// Severity -> that registry entry, stamped by runChecks. Report formatting ->
// src/report/format.js.

import { finding } from "../../report/finding.js";
import {
  isBroadHost,
  referrerSupported,
  loaderTrace,
  loaderSites,
  manifestTokenLine,
} from "../lib/util.js";
import { aggregateGroups } from "../lib/verdict-resolve.js";
import { buildReachability } from "../lib/reachability.js";
import {
  warResourceList,
  expandResourcePattern,
  isOverBroadResource,
} from "../lib/web-accessible-resources.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[],
   *   llm?: import("../escalation.js").LlmStep}}
   */
  run(ctx) {
    const entries = warResourceList(ctx.addon?.manifest || {});
    if (!entries.length) {
      return { findings: [] }; // nothing to minimize
    }
    const reach = buildReachability(ctx);
    const files = ctx.addon.files;
    const text = files?.get("manifest.json")?.toString("utf8");
    /** @param {string} item  The WAR entry's manifest line as a loc, or null. */
    const lineOf = (item) => {
      const line = manifestTokenLine(text, item);
      return line ? { line } : null;
    };
    const findings = [];
    const candidates = [];
    /** @type {{ids: string[], finding: object, item: string}[]} per WAR file. */
    const groups = [];
    let n = 0;
    const seen = new Set();
    /** @param {string} key @param {?string} item  Emit one finding per key. */
    const once = (key, item) => {
      if (!seen.has(key)) {
        seen.add(key);
        findings.push(
          finding({ file: "manifest.json", loc: lineOf(item), item })
        );
      }
    };

    for (const entry of entries) {
      // (a) over-broad resource patterns and (MV3) matches.
      for (const pat of entry.resources) {
        if (isOverBroadResource(pat)) {
          ctx.note?.("manifest.json", null, `${pat} (over-broad)`, "fail");
          once(`res:${pat}`, pat);
        }
      }
      for (const mt of entry.matches) {
        if (isBroadHost(mt)) {
          ctx.note?.("manifest.json", null, `${mt} (over-broad)`, "fail");
          once(`match:${mt}`, mt);
        }
      }

      // (b) concrete resources that nothing web-facing in the add-on loads.
      for (const pat of entry.resources) {
        if (isOverBroadResource(pat)) {
          continue; // already covered by (a)
        }
        for (const file of expandResourcePattern(files, pat)) {
          if (seen.has(`res-file:${file}`)) {
            continue;
          }
          seen.add(`res-file:${file}`);
          if (reach.webReachable.has(file)) {
            ctx.note?.(
              "manifest.json",
              null,
              `${file} reachable by a web context`,
              "pass"
            );
            continue;
          }
          const mentions = reach.mentionsOf(file);
          const supported = mentions.some((m) =>
            referrerSupported(reach, m.file)
          );
          const trace = `${file} - ${loaderTrace(reach, mentions, supported)}`;
          // A web context plausibly loads it (a reference from live code, or a
          // live dynamic loader) -> ask per site whether it really does. Named
          // only by dead code with no live loader -> plainly needless.
          if (supported || reach.hasDynamicLoaders) {
            ctx.note?.("manifest.json", null, trace, "unsure");
            const ids = [];
            for (const site of loaderSites(reach, mentions, supported)) {
              const id = `W${++n}`;
              ids.push(id);
              candidates.push({
                id,
                file: site.file,
                line: site.line ?? undefined,
                note: `does this site load ${file} for a web context?`,
                corpus: [site.file],
              });
            }
            groups.push({
              ids,
              finding: { file: "manifest.json", loc: lineOf(file), item: file },
              item: file,
            });
          } else {
            ctx.note?.("manifest.json", null, trace, "fail");
            once(`unused-finding:${file}`, file);
          }
        }
      }
    }

    const result = { findings };
    if (candidates.length) {
      result.llm = { candidates, resolve: aggregateGroups(groups) };
    }
    return result;
  },
};
