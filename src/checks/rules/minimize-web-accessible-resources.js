// Minimize web_accessible_resources. The scan resolves the clear cases as
// findings, with two concerns. (a) Over-broad exposure - a resource pattern like
// "*" exposes the whole add-on. (b) A concrete exposed resource that no content
// script or page loads (not web-reachable via getURL/HTML/CSS) is a finding when
// clearly unloaded. When a resource is ambiguous (live code names it, or the
// add-on uses dynamic loaders) the exposed file escalates, for a reviewer to
// follow the suspected loaders and decide whether a web context really loads it.
//
// Belongs here: classifying each web_accessible_resources entry as a finding, an
// escalation, or clean. Does NOT belong here: parsing the entry list and the
// broad/over-broad predicates (warResourceList, expandResourcePattern,
// isOverBroadResource) -> src/lib/web-accessible-resources.js. The
// web-reachability graph and mention/loader-site lookups -> src/lib/
// reachability.js + util.js. The deterministic->manual routing ->
// src/checks/registry.js + src/checks/escalation.js. Authored wording ->
// assets/registry.yaml. Severity -> that registry entry, stamped by runChecks.
// Report formatting -> src/report/format.js.

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import {
  referrerSupported,
  loaderTrace,
  manifestTokenLine,
} from "../../lib/util.js";
import { buildReachability } from "../../lib/reachability.js";
import {
  warResourceList,
  expandResourcePattern,
  isOverBroadResource,
} from "../../lib/web-accessible-resources.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[],
   *   escalations: import("../escalation.js").Escalation[]}}
   */
  run(ctx) {
    // Registry `input: xpi`: ctx.addon is the built XPI. web_accessible_resources -
    // the resources, the files they expand to, and the reachability graph of what
    // loads them - is a property of what actually ships, so the exposure is judged
    // against the XPI, not a source submission's pre-build layout (which would
    // mislabel loaded resources).
    const { addon } = ctx;
    const entries = warResourceList(ctx.manifest || {});
    if (!entries.length) {
      return { findings: [] }; // nothing to minimize
    }
    const reach = buildReachability(ctx);
    const files = addon.files;
    const text = ctx.manifestText;
    /** @param {string} item  The WAR entry's manifest line as a loc, or null. */
    const lineOf = (item) => {
      const line = manifestTokenLine(text, item);
      return line ? { line } : null;
    };
    const findings = [];
    /** @type {{ids: string[], finding: object}[]} per WAR file. */
    const escalations = [];
    const seen = new Set();
    /**
     * Emit one finding per key. `item` is the displayed entry; `locItem` is the
     * manifest token to anchor on, which differs from `item` when a glob pattern
     * exposed the file - the loc must point at the WAR pattern (e.g. "icons/*"),
     * not the file's own coincidental line elsewhere (e.g. the "icons" field).
     * @param {string} key @param {?string} item @param {?string} [locItem]
     */
    const once = (key, item, locItem = item) => {
      if (!seen.has(key)) {
        seen.add(key);
        findings.push(
          finding({ file: "manifest.json", loc: lineOf(locItem), item })
        );
      }
    };

    for (const entry of entries) {
      // (a) over-broad resource patterns. A match like <all_urls> is not a file
      // and does not belong in this resource-minimization finding.
      for (const pat of entry.resources) {
        if (isOverBroadResource(pat)) {
          ctx.note?.(
            "manifest.json",
            null,
            `${pat} (over-broad)`,
            VERDICT.FAIL
          );
          once(`res:${pat}`, pat);
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
              VERDICT.PASS
            );
            continue;
          }
          const mentions = reach.mentionsOf(file);
          const supported = mentions.some((m) =>
            referrerSupported(reach, m.file)
          );
          const trace = `${file} - ${loaderTrace(reach, mentions, supported)}`;
          // A web context plausibly loads it (a reference from live code, or a
          // live dynamic loader) -> the reviewer decides whether one really does.
          // Named only by dead code with no live loader -> plainly needless.
          if (supported || reach.hasDynamicLoaders) {
            ctx.note?.("manifest.json", null, trace, VERDICT.UNSURE);
            escalations.push({
              file: "manifest.json",
              loc: lineOf(pat),
              item: file,
            });
          } else {
            ctx.note?.("manifest.json", null, trace, VERDICT.FAIL);
            once(`unused-finding:${file}`, file, pat);
          }
        }
      }
    }

    return { findings, escalations };
  },
};
