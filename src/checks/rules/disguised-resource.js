// Data smuggled out through a resource-load URL (an image/iframe/media src, or a
// setAttribute("src"|"href", ...)) built with appended runtime data - a channel
// not meant for data transmission, so it is an error regardless of consent.
//
// Belongs here: turning resource-load covert sinks into findings. Does NOT
// belong here: the sink scan and the shared exfil gate (-> src/parse/
// network-sinks.js + getOutboundSinks/isCovertExfil in
// src/checks/lib/outbound-sinks.js, shared with the other disguised-* and
// data-exfiltration checks), authored wording (-> assets/registry.yaml), and
// severity (-> that registry entry).

import { getOutboundSinks, isCovertExfil } from "../lib/outbound-sinks.js";
import { finding } from "../../report/finding.js";

const TYPES = new Set(["element-src", "set-attribute"]);

export default {
  run(ctx) {
    const out = [];
    for (const sink of getOutboundSinks(ctx)) {
      if (!TYPES.has(sink.type) || !isCovertExfil(sink)) {
        continue;
      }
      const loc = { line: sink.line, column: sink.column };
      out.push(finding({ file: sink.file, loc }));
      ctx.note?.(sink.file, loc, `disguised data send (${sink.type})`, "fail");
    }
    return out;
  },
};
