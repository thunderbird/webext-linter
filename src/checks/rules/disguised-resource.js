// Data smuggled out through a resource-load URL (an image/iframe/media src, or a
// setAttribute("src"|"href", ...)) that carries a user-data API call - the strong
// covert-exfil case, a hard error regardless of consent. The weaker "a runtime
// value is merely appended to the URL" case (common in legitimate code) goes to
// the disguised-transmission escalating check instead.
//
// Belongs here: turning resource-load covert sinks into findings. Does NOT
// belong here: the sink scan and the shared exfil gate (-> src/parse/
// network-sinks.js + getOutboundSinks/isStrongCovertExfil in
// src/lib/outbound-sinks.js, shared with the other disguised-* and
// data-exfiltration checks), authored wording (-> assets/registry.yaml), and
// severity (-> that registry entry).

import { VERDICT } from "../../lib/enum.js";
import {
  getOutboundSinks,
  isStrongCovertExfil,
  sinkLabel,
} from "../../lib/outbound-sinks.js";
import { finding } from "../../report/finding.js";

const TYPES = new Set(["element-src", "set-attribute"]);

export default {
  run(ctx) {
    const out = [];
    for (const sink of getOutboundSinks(ctx)) {
      if (!TYPES.has(sink.type) || !isStrongCovertExfil(sink)) {
        continue;
      }
      const loc = { line: sink.line, column: sink.column };
      // `hint` names the channel and where it sends, so the locus says what was
      // smuggled out through what - `item` stays absent, the locus is the identity.
      const label = sinkLabel(sink, `disguised data send (${sink.type})`);
      out.push(finding({ file: sink.file, loc, hint: label }));
      ctx.note?.(sink.file, loc, label, VERDICT.FAIL);
    }
    return { findings: out };
  },
};
