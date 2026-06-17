// Unsanitized HTML insertion. Flags writing dynamic content into an HTML sink
// (innerHTML / outerHTML / srcdoc / insertAdjacentHTML). A warning, not an
// error: the construct is only a problem when the content is external/
// user-provided and unsanitized, which a static scan can't fully determine -
// so it points the reviewer at each site. Static string content is not flagged.
//
// Belongs here: skipping non-authored code, then emitting one finding per sink
// hit with the sink name as the item so the reviewer knows what to inspect.
// Does NOT belong here: the AST scan that finds dynamic-content sinks and the
// static-string filter (-> src/parse/unsafe-html.js), the non-authored skip-list
// (-> src/checks/lib/bundled.js), authored wording (-> assets/registry.yaml),
// severity (-> that registry entry, stamped by src/checks/registry.js), and
// report formatting (-> src/report/format.js).

import { finding } from "../../report/finding.js";
import { scanUnsafeHtml } from "../../parse/unsafe-html.js";
import { nonAuthoredJs } from "../lib/bundled.js";

export default {
  run(ctx) {
    const out = [];
    const skip = nonAuthoredJs(ctx); // skip non-authored bundles (see nonAuthoredJs)
    for (const src of ctx.jsSources) {
      if (skip.has(src.file)) {
        continue;
      }
      const { hits } = scanUnsafeHtml(src.code, src.lineOffset, src.parsed);
      for (const hit of hits) {
        const how =
          hit.sink === "insertAdjacentHTML"
            ? "insertAdjacentHTML()"
            : `.${hit.sink}`;
        const loc = { line: hit.line, column: hit.column };
        out.push(finding({ file: src.file, loc, item: how }));
        ctx.note?.(src.file, loc, how, "fail");
      }
    }
    return out;
  },
};
