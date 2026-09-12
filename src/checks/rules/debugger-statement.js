// `debugger` statements left in shipped code. Every one ESCALATES; this check never
// rejects and never clears. A `debugger` is acceptable only when something keeps it from
// running for ordinary users, and an enclosing `if` does not establish that: a condition
// on runtime data - a message, a tab, a user setting - still fires in normal use, so
// treating any `if` as a licence silently passes a statement that halts a real user's
// Thunderbird. Reading which kind of condition it is means reading the file.
//
// Belongs here: skipping non-authored code, then raising each debugger site.
//
// Does NOT belong here: locating DebuggerStatement nodes (->
// src/parse/debugger-statement.js), the non-authored skip-list (->
// src/lib/bundled.js), authored wording (-> assets/registry.yaml),
// severity (-> that registry entry, stamped by src/checks/registry.js), and
// report formatting (-> src/report/format.js).

import { VERDICT } from "../../lib/enum.js";
import { debuggerStmtOf } from "../extract.js";
import { nonAuthoredJs } from "../../lib/bundled.js";

export default {
  run(ctx) {
    const escalations = [];
    const skip = nonAuthoredJs(ctx); // a debugger left in a library is not the dev's
    for (const src of ctx.jsSources) {
      if (skip.has(src.file)) {
        continue;
      }
      const { hits } = debuggerStmtOf(src);
      for (const hit of hits) {
        const loc = { line: hit.line, column: hit.column };
        ctx.note?.(src.file, loc, "debugger", VERDICT.UNSURE);
        escalations.push({ file: src.file, loc });
      }
    }
    return { findings: [], escalations };
  },
};
