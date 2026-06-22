// Data smuggled out through a stylesheet or CSS url() built with appended
// runtime data - a channel not meant for data transmission, so it is an error
// regardless of consent.
//
// Belongs here: turning style-url covert sinks into findings. Does NOT belong
// here: the sink scan and the shared exfil gate (-> getOutboundSinks/
// isCovertExfil in src/checks/lib/outbound-sinks.js), authored wording (->
// assets/registry.yaml), and severity (-> that registry entry).

import { getOutboundSinks, isCovertExfil } from "../lib/outbound-sinks.js";
import { finding } from "../../report/finding.js";

export default {
  run(ctx) {
    const out = [];
    for (const sink of getOutboundSinks(ctx)) {
      if (sink.type !== "style-url" || !isCovertExfil(sink)) {
        continue;
      }
      const loc = { line: sink.line, column: sink.column };
      out.push(finding({ file: sink.file, loc }));
      ctx.note?.(sink.file, loc, "disguised data send (style-url)", "fail");
    }
    return out;
  },
};
