// The user's sensitive data leaving the machine where the user would not expect it, by
// any route. Whether it leaves, and whether the user set the transmission up or it is
// the add-on's single purpose, is a judgement the source does not settle, so each sink
// that may carry data to a remote or dynamic destination escalates:
// - an overt transmission (fetch, XMLHttpRequest, WebSocket, EventSource,
//   navigator.sendBeacon, an HTML form submission), whatever its URL;
// - a URL channel (a resource src/href, a stylesheet url(), window.open, a page
//   navigation) whose URL is built with a runtime value or carries a user-data API
//   call. A static URL there sends nothing of the user's.
//
// Mail the add-on composes and sends itself, and routes this scan does not know, are
// reached through the check's sweep.
//
// Belongs here: one escalation per such sink, carrying file:line and the route it
// sends on. Does NOT belong here: the sink scan (-> src/parse/network-sinks.js,
// aggregated by src/lib/outbound-sinks.js), the deterministic->manual routing (->
// src/checks/registry.js + src/checks/escalation.js), and authored wording (->
// registry).

import { VERDICT } from "../../lib/enum.js";
import { getOutboundSinks, sinkLabel } from "../../lib/outbound-sinks.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

// Human name of each route (network-sinks.js mints the short codes), shown on the locus
// line so the reviewer sees the route used, not the file repeated.
const METHOD = {
  fetch: "fetch()",
  beacon: "navigator.sendBeacon()",
  xhr: "XMLHttpRequest",
  websocket: "WebSocket",
  eventsource: "EventSource",
  "form-submit": "an HTML form submission",
  "element-src": "a resource URL (src/href)",
  "set-attribute": "a resource URL (setAttribute)",
  "style-url": "a stylesheet url()",
  "window-open": "window.open()",
  navigation: "a page navigation",
};

/**
 * True for a sink that may carry data to a remote or dynamic destination.
 * @param {import("../../lib/outbound-sinks.js").FileSink} sink
 * @returns {boolean}
 */
function maySendData(sink) {
  if (sink.channel.overt) {
    return sink.destClass.remote || sink.destClass.dynamic;
  }
  return !sink.destClass.local && (sink.dataAppended || sink.carriesData);
}

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: [], escalations:
   *   import("../escalation.js").Escalation[]}}
   */
  async run(ctx) {
    const escalations = [];
    const seen = new Set();
    for (const sink of await getOutboundSinks(ctx)) {
      const key = `${sink.file}:${sink.line}`;
      if (!maySendData(sink) || seen.has(key)) {
        continue;
      }
      seen.add(key);
      const loc = { line: sink.line, column: sink.column };
      const method = METHOD[sink.type] ?? sink.type;
      // The escalation lists file:line via its location; `hint` (the route and where it
      // sends) rides along and is shown on the locus. `item` stays absent, so every
      // site groups under the one manual entry.
      const label = sinkLabel(sink, method);
      escalations.push({ ...ctx.artifact.at(sink.file, loc), hint: label });
      ctx.note?.(ctx.artifact.at(sink.file, loc), label, VERDICT.UNSURE);
    }
    return { findings: [], escalations };
  },
};
