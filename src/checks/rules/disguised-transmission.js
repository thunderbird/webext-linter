// A covert channel (a resource/stylesheet src/href, a CSS url(), a window.open,
// or a page navigation) whose URL is built with a runtime value but carries NO
// user-data API call. Smuggling data through such a channel is disguised
// exfiltration, but "a remote URL with a dynamic piece" on its own is a weak
// signal - extremely common in legitimate code (navigating to `host/${id}`,
// loading `cdn/${name}.png`). The STRONG case (a messages/contacts/... call sits
// in the URL) is the hard-error disguised-* checks; this check takes the weak
// residue, which the source does not settle, and escalates each site to a
// reviewer.
//
// Belongs here: one escalation per weak covert sink. Does NOT belong here: the
// sink scan (-> src/parse/network-sinks.js, aggregated by
// getOutboundSinks/isWeakCovertExfil in src/lib/outbound-sinks.js), the
// hard-error strong case (-> the disguised-*.js checks), the
// deterministic->manual routing (-> src/checks/registry.js +
// src/checks/escalation.js), and authored wording (-> assets/registry.yaml).

import { VERDICT } from "../../lib/enum.js";
import {
  getOutboundSinks,
  isWeakCovertExfil,
  sinkLabel,
} from "../../lib/outbound-sinks.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

// Human name of each covert channel (network-sinks.js mints the short codes),
// shown on the locus line so the reviewer sees the channel used.
const CHANNEL = {
  "element-src": "a resource URL (src/href)",
  "set-attribute": "a resource URL (setAttribute)",
  "style-url": "a stylesheet url()",
  "window-open": "window.open()",
  navigation: "a page navigation",
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
      if (!isWeakCovertExfil(sink)) {
        continue;
      }
      const key = `${sink.file}:${sink.line}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const loc = { line: sink.line, column: sink.column };
      const channel = CHANNEL[sink.type] ?? sink.type;
      // file:line via the location; `hint` (the channel) rides along and is shown
      // on the locus. `item` stays absent, so every site groups under the one
      // manual entry.
      const label = sinkLabel(sink, channel);
      escalations.push({ file: sink.file, loc, hint: label });
      ctx.note?.(sink.file, loc, label, VERDICT.UNSURE);
    }
    return { findings: [], escalations };
  },
};
