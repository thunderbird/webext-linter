// Async listener passed to runtime.onMessage.addListener(). An async listener
// always returns a Promise, which signals "I will respond" for every message
// and breaks other listeners. It is error-prone and must be avoided.
//
// Belongs here: skipping non-authored code, then matching the
// <root>.runtime.onMessage.addListener() call shape and flagging when its first
// argument is an async function.
//
// Does NOT belong here: Babel parse/traverse plumbing (-> src/parse/ast.js, the
// only Babel front door), the API-root name set (-> src/parse/api-usage.js), the
// non-authored skip-list (-> src/checks/lib/bundled.js), authored wording (->
// assets/registry.yaml), severity (-> that registry entry, stamped by
// src/checks/registry.js), and report formatting (-> src/report/format.js).

import { finding } from "../../report/finding.js";
import { parseJs, traverse, nodeLoc } from "../../parse/ast.js";
import { API_ROOTS } from "../../parse/api-usage.js";
import { nonAuthoredJs } from "../lib/bundled.js";

/** @typedef {import("@babel/types").Node} AstNode */

export default {
  run(ctx) {
    const out = [];
    const skip = nonAuthoredJs(ctx); // a library's own onMessage use is not the dev's
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
          if (!isOnMessageAddListener(path.node.callee)) {
            return;
          }
          const cb = path.node.arguments[0];
          const isFn =
            cb?.type === "FunctionExpression" ||
            cb?.type === "ArrowFunctionExpression";
          const isAsync = isFn && cb.async;
          const loc = nodeLoc(path.node, src.lineOffset);
          ctx.note?.(
            src.file,
            loc,
            isAsync
              ? "runtime.onMessage.addListener (async)"
              : "runtime.onMessage.addListener",
            isAsync ? "fail" : "pass"
          );
          if (isAsync) {
            out.push(finding({ file: src.file, loc }));
          }
        },
      });
    }
    return out;
  },
};

/**
 * True for <browser|messenger|chrome>.runtime.onMessage.addListener(...).
 * @param {AstNode} callee
 * @returns {boolean}
 */
function isOnMessageAddListener(callee) {
  if (
    callee?.type !== "MemberExpression" ||
    callee.computed ||
    callee.property?.name !== "addListener"
  ) {
    return false;
  }
  const onMessage = callee.object; // <root>.runtime.onMessage
  if (
    onMessage?.type !== "MemberExpression" ||
    onMessage.computed ||
    onMessage.property?.name !== "onMessage"
  ) {
    return false;
  }
  const runtime = onMessage.object; // <root>.runtime
  if (
    runtime?.type !== "MemberExpression" ||
    runtime.computed ||
    runtime.property?.name !== "runtime"
  ) {
    return false;
  }
  return (
    runtime.object?.type === "Identifier" && API_ROOTS.has(runtime.object.name)
  );
}
