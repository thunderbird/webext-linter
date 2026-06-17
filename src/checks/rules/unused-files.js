// LLM check: files that should not ship in a published add-on. The deterministic
// pre-flight (reachability.js follows import/getURL/HTML/CSS plus file-loading
// API edges) resolves the clear cases as findings: hidden/junk by name, and a
// clearly-unreferenced file (its basename appears in no other file AND the add-on
// uses no dynamic loaders). For an ambiguous file (its name appears in live code,
// or the add-on builds load paths at runtime) we cannot tell statically whether
// any of those sites really loads it, so each suspected loader SITE becomes an
// LLM candidate ("does this site load F?"). The orchestrator gathers one verdict
// per site (or routes to manual with no token); this check then aggregates per
// file F: if any site loads it, F is used; if none does, F is unused.
//
// Belongs here: the ALLOW / JUNK name lists, classifying each packaged file as a
// finding / candidate / clean against reachability, the per-site candidate set,
// and the per-F aggregation in resolve. Does NOT belong here: the reachability
// graph, dynamic-loader sites, and mention lookups -> src/checks/lib/
// reachability.js. The declared-vendor set -> addon.vendor.set. The model
// transport (batched verdicts) -> src/checks/llm-client.js. The LLM-or-manual
// orchestration -> src/checks/escalation.js. Authored wording ->
// assets/registry.yaml. Severity -> that registry entry, stamped by runChecks.

import { finding } from "../../report/finding.js";
import { buildReachability } from "../lib/reachability.js";
import { aggregateGroups } from "../lib/verdict-resolve.js";
import {
  referrerSupported,
  loaderSites,
  loaderTrace,
  PROJECT_METADATA_RE,
} from "../lib/util.js";
import { basename } from "../../util/files.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../lib/reachability.js").Reachability} Reachability */

// Never flag: project metadata (referenced by tooling / the i18n runtime).
const ALLOW = [PROJECT_METADATA_RE, /^manifest\.json$/i, /^_locales\//];

// Definite "should not ship" by name: OS/editor junk, source maps, archives.
const JUNK = [
  /(^|\/)\.[^/]+(\/|$)/, // a dotfile/dotdir segment (.git/, .DS_Store, .vscode/)
  /(^|\/)(Thumbs\.db|__MACOSX(\/|$))/i,
  /~$/, // editor backups
  /\.(map|orig|bak|swp|tmp)$/i,
  /\.(zip|xpi|crx|7z|rar|tar|tgz|gz)$/i,
];

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[],
   *   llm?: import("../escalation.js").LlmStep}}
   */
  run(ctx) {
    const { addon } = ctx;
    if (!addon?.files) {
      return { findings: [] };
    }
    const reach = buildReachability(ctx);
    const vendored = addon.vendor?.set ?? new Set();
    const findings = [];
    const candidates = [];
    /** @type {{ids: string[], finding: object, item: string}[]} one per file F. */
    const groups = [];
    let n = 0;

    for (const file of addon.files.keys()) {
      if (vendored.has(file) || ALLOW.some((re) => re.test(file))) {
        continue;
      }
      if (JUNK.some((re) => re.test(file))) {
        ctx.note?.(file, null, "hidden/junk file", "fail");
        findings.push(finding({ file, item: file }));
        continue;
      }
      if (reach.reachable.has(file)) {
        continue;
      }
      // Unreachable. A reference from live code (whether it is a real load is the
      // model's call) or a live dynamic loader makes it ambiguous; a file named
      // only by dead code with no live loader is a clear orphan.
      const base = basename(file);
      const mentions = reach
        .mentionsOf(base, file)
        .filter((m) => m.file !== file);
      const supported = mentions.some((m) => referrerSupported(reach, m.file));
      const orphan = !supported && !reach.hasDynamicLoaders;
      ctx.note?.(
        file,
        null,
        loaderTrace(reach, mentions, supported),
        orphan ? "fail" : "unsure"
      );
      if (orphan) {
        findings.push(finding({ file, item: file }));
        continue;
      }
      // One candidate per suspected loader site of this file.
      const ids = [];
      for (const site of loaderSites(reach, mentions, supported)) {
        const id = `U${++n}`;
        ids.push(id);
        candidates.push({
          id,
          file: site.file,
          line: site.line ?? undefined,
          note: `does this site load ${file}?`,
          corpus: [site.file],
        });
      }
      groups.push({ ids, finding: { file, item: file }, item: file });
    }

    if (!candidates.length) {
      return { findings };
    }
    return { findings, llm: { candidates, resolve: aggregateGroups(groups) } };
  },
};
