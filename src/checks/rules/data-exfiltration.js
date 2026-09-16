// Normal data transmission (fetch, XMLHttpRequest, WebSocket, EventSource,
// navigator.sendBeacon, an HTML form submission) to a remote host is allowed only if
// the user actively
// enabled it - by entering the destination URL/credentials on an options page
// that lists what is transmitted, or via an explicit off-by-default opt-in for a
// hard-coded URL. Thunderbird has no built-in data-collection prompt. Whether a
// valid opt-in exists is a judgement the source does not settle, so each overt
// sink to a remote/dynamic destination escalates to a reviewer.
//
// Disguising transmission as a resource load is a separate, always-error
// concern (-> the disguised-* checks); this check is only the overt channels.
//
// Belongs here: one escalation per overt remote sink, carrying file:line and the
// channel it sends on. Does NOT belong here: the sink scan (->
// src/parse/network-sinks.js, aggregated by src/lib/outbound-sinks.js), the
// deterministic->manual routing (-> src/checks/registry.js +
// src/checks/escalation.js), and authored wording (-> registry).

import { VERDICT } from "../../lib/enum.js";
import { getOutboundSinks, sinkLabel } from "../../lib/outbound-sinks.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

// Human name of each outbound method (network-sinks.js mints the short codes), shown
// on the locus line so the reviewer sees the channel used, not the file repeated.
const METHOD = {
  fetch: "fetch()",
  beacon: "navigator.sendBeacon()",
  xhr: "XMLHttpRequest",
  websocket: "WebSocket",
  eventsource: "EventSource",
  "form-submit": "an HTML form submission",
};

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: [], escalations:
   *   import("../escalation.js").Escalation[]}}
   */
  run(ctx) {
    const escalations = [];
    const seen = new Set();
    for (const sink of getOutboundSinks(ctx)) {
      const remote = sink.destClass.remote || sink.destClass.dynamic;
      const key = `${sink.file}:${sink.line}`;
      if (!sink.channel.overt || !remote || seen.has(key)) {
        continue;
      }
      seen.add(key);
      const loc = { line: sink.line, column: sink.column };
      const method = METHOD[sink.type] ?? sink.type;
      // The escalation lists file:line via its location; `hint` (the transmission
      // method and where it sends) rides along and is shown on the locus. `item`
      // stays absent, so every site groups under the one manual entry.
      const label = sinkLabel(sink, method);
      escalations.push({ file: sink.file, loc, hint: label });
      ctx.note?.(sink.file, loc, label, VERDICT.UNSURE);
    }
    return { findings: [], escalations };
  },
};
