// Every outbound network sink in the add-on's authored JavaScript, scanned once
// and shared. The disguised-* and cleartext-transmission (deterministic),
// privacy-policy, and data-exfiltration (LLM) checks read this one list, so the
// AST scan runs a single time per review - the same "compute once, checks read
// it" pattern as addon.bundled / addon.vendor.
//
// Belongs here: getOutboundSinks - running scanNetworkSinks over each authored
// source (reusing its already-parsed AST), skipping non-authored code, and
// memoizing the result on the addon.
//
// Does NOT belong here: the sink AST walk itself (-> src/parse/
// network-sinks.js), the verdicts (-> src/checks/rules/disguised-*.js,
// cleartext-transmission.js, privacy-policy.js, data-exfiltration.js), and the
// non-authored skip set (-> bundled.js).

import { scanNetworkSinks } from "../../parse/network-sinks.js";
import { nonAuthoredJs } from "./bundled.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../../parse/network-sinks.js").SinkHit} SinkHit */
/** @typedef {SinkHit & {file: string}} FileSink */

/**
 * The add-on's outbound network sinks, scanned once and memoized on the addon
 * so every check shares the result.
 * @param {RunContext} ctx
 * @returns {FileSink[]}
 */
export function getOutboundSinks(ctx) {
  return (ctx.addon.outboundSinks ??= scanAll(ctx));
}

/**
 * Whether a sink is a disguised exfiltration: a covert channel to a remote
 * destination carrying data (appended to the URL, or a user-data API call in
 * it). The shared gate for the disguised-* checks; a static remote load with no
 * data is not exfiltration.
 * @param {FileSink} sink
 * @returns {boolean}
 */
export function isCovertExfil(sink) {
  return (
    sink.channel === "covert" &&
    sink.destClass !== "local" &&
    (sink.dataAppended || sink.carriesData)
  );
}

/**
 * @param {RunContext} ctx
 * @returns {FileSink[]}
 */
function scanAll(ctx) {
  const skip = nonAuthoredJs(ctx);
  const out = [];
  for (const src of ctx.jsSources ?? []) {
    if (skip.has(src.file)) {
      continue;
    }
    const { hits } = scanNetworkSinks(src.code, src.lineOffset, src.parsed);
    for (const hit of hits) {
      out.push({ ...hit, file: src.file });
    }
  }
  return out;
}
