// Synchronous XMLHttpRequest: open(method, url, false) - the literal `false`
// third argument makes the request synchronous, blocking the UI thread.
//
// Belongs here: skipping non-authored code, then matching a .open(...) member
// call whose third argument is the boolean literal false, and emitting a finding
// at the open() call site.
// Does NOT belong here: Babel parse/traverse plumbing (-> src/parse/ast.js, the
// only Babel front door), the non-authored skip-list (-> src/checks/lib/bundled.js),
// authored wording (-> assets/registry.yaml), severity (-> that registry entry,
// stamped by src/checks/registry.js), and report formatting (-> src/report/format.js).

import { finding } from "../../report/finding.js";
import { parseJs, traverse, nodeLoc } from "../../parse/ast.js";
import { nonAuthoredJs } from "../lib/bundled.js";

export default {
  run(ctx) {
    const out = [];
    const skip = nonAuthoredJs(ctx); // a library's own sync XHR is not the dev's
    for (const src of ctx.jsSources) {
      if (skip.has(src.file)) {
        continue;
      }
      const { ast } = src.parsed ?? parseJs(src.code);
      if (!ast) {
        continue;
      }
      traverse(ast, {
        CallExpression(path) {
          const callee = path.node.callee;
          if (
            callee.type !== "MemberExpression" ||
            callee.computed ||
            callee.property?.name !== "open"
          ) {
            return;
          }
          const async = path.node.arguments[2];
          // Only an explicit boolean async flag is the XHR.open(...) shape this
          // check judges; narrate each such site (sync = fail, async = pass).
          if (async?.type !== "BooleanLiteral") {
            return;
          }
          const loc = nodeLoc(path.node.callee.property, src.lineOffset);
          const sync = async.value === false;
          ctx.note?.(
            src.file,
            loc,
            `.open(..., async=${async.value})`,
            sync ? "fail" : "pass"
          );
          if (sync) {
            out.push(finding({ file: src.file, loc }));
          }
        },
      });
    }
    return out;
  },
};
