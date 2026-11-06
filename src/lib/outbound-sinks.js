// Every outbound network sink in the add-on's authored JavaScript, scanned once
// and shared. The cleartext-transmission (deterministic), privacy-policy and
// data-exfiltration (review) checks read this one list, gathered
// once per artifact - the same "compute once, checks read it" pattern as ctx.bundled() /
// ctx.vendor().
//
// Belongs here: getOutboundSinks - reading each authored source's precomputed
// network-sinks scan (networkSinksOf), skipping non-authored code, and
// memoizing the result on ctx.cache - plus sinkLabel, the one way a sink names
// itself on a locus line, so the checks that share the list also share how it
// reads.
//
// Does NOT belong here: the sink AST walk itself (-> src/parse/
// network-sinks.js), the verdicts (-> src/checks/rules/cleartext-transmission.js,
// privacy-policy.js, data-exfiltration.js), and the
// non-authored skip set (-> bundled.js).

import { networkSinksOf } from "../checks/extract.js";
import { nonAuthoredJs } from "./bundled.js";
import { trunc } from "./util.js";

/** @typedef {import("../checks/registry.js").RunContext} RunContext */
/** @typedef {import("../parse/network-sinks.js").SinkHit} SinkHit */
/** @typedef {SinkHit & {file: string}} FileSink */

/**
 * The add-on's outbound network sinks, scanned once and memoized on ctx.cache
 * so every check shares the result.
 * @param {RunContext} ctx
 * @returns {Promise<FileSink[]>}
 */
export function getOutboundSinks(ctx) {
  return ((ctx.cache ??= {}).outboundSinks ??= scanAll(ctx));
}

/**
 * How a sink reads on a locus line: the channel the check names it by, followed by
 * the destination as the developer wrote it, so a reviewer sees WHERE the data goes
 * without opening the file. A sink that names no destination (`fetch()`,
 * `window.open()`) keeps the channel alone. Truncated for display; the text is the
 * add-on's own, so it is shown and nothing more.
 * @param {FileSink} sink
 * @param {string} label  What this check calls the channel ("fetch()", "a page
 *   navigation").
 * @returns {string}
 */
export function sinkLabel(sink, label) {
  return sink.target ? `${label} ${trunc(sink.target)}` : label;
}

/**
 * @param {RunContext} ctx
 * @returns {Promise<FileSink[]>}
 */
async function scanAll(ctx) {
  const skip = await nonAuthoredJs(ctx);
  const out = [];
  for (const src of await ctx.jsSources()) {
    if (skip.has(src.file)) {
      continue;
    }
    const { hits } = networkSinksOf(src);
    for (const hit of hits) {
      out.push({ ...hit, file: src.file });
    }
  }
  return out;
}
