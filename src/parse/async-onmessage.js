// Finds `<root>.runtime.onMessage.addListener(...)` call sites, tagging each with
// whether its first argument is an async function. An async listener always
// returns a Promise, signalling "I will respond" for every message and breaking
// other listeners, so the caller flags the async ones - the hit carries the flag.
//
// Belongs here: matching the onMessage.addListener call shape and reporting
// whether the listener is async. Does NOT belong here: the API-root name set (->
// src/parse/api-usage.js), the non-authored skip that decides WHICH files to scan
// (-> src/checks/lib/bundled.js), authored wording / severity (->
// assets/registry.yaml). Babel access goes through src/parse/ast.js.

import { parseJs, traverse, nodeLoc } from "./ast.js";
import { API_ROOTS } from "./api-usage.js";

/** @typedef {import("@babel/types").Node} AstNode */

/**
 * @param {string} code  JavaScript source text.
 * @param {number} [lineOffset]  Added to reported lines (for inline scripts).
 * @param {import("./ast.js").ParseResult} [parsed]  Reuse this parse of `code`
 *   instead of re-parsing it.
 * @returns {{hits: {line: number, column: number, async: boolean}[],
 *   parseError: string|null}}  One hit per addListener call; `async` is true when
 *   the listener is an async function (the flagged shape).
 */
export function scanAsyncOnMessage(code, lineOffset = 0, parsed) {
  const { ast, parseError } = parsed ?? parseJs(code);
  if (parseError || !ast) {
    return { hits: [], parseError: parseError ?? null };
  }
  const hits = [];
  traverse(ast, {
    CallExpression(path) {
      if (!isOnMessageAddListener(path.node.callee)) {
        return;
      }
      const cb = path.node.arguments[0];
      const isFn =
        cb?.type === "FunctionExpression" ||
        cb?.type === "ArrowFunctionExpression";
      hits.push({
        ...nodeLoc(path.node, lineOffset),
        async: Boolean(isFn && cb.async),
      });
    },
  });
  return { hits, parseError: null };
}

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
