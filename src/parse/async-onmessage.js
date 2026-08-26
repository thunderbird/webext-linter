// Finds `<root>.<event>.addListener(...)` call sites, reporting which event each
// one listens to and whether its first argument is an async function. An async
// listener always returns a Promise, which an event that reads its listener's
// return value takes as "I will respond" - claiming the response for every message
// and starving the other listeners. WHICH events read it is a schema question, so
// the caller decides that and flags the async ones; the hit carries the event path
// and the flag.
//
// Belongs here: matching the addListener call shape, naming the event it is on,
// and reporting whether the listener is async. Does NOT belong here: which events
// answer with their return value (-> src/checks/rules/async-onmessage.js, from the
// schema), API-root and alias resolution (-> src/parse/api-base.js), the
// non-authored skip that decides WHICH files to scan (-> src/lib/bundled.js),
// authored wording / severity (-> assets/registry.yaml). Babel access goes through
// src/parse/ast.js.

import { parseJs, traverse, nodeLoc } from "./ast.js";
import { apiBasesOf, calleeApiPath } from "./api-base.js";

/**
 * @param {string} code  JavaScript source text.
 * @param {number} [lineOffset]  Added to reported lines (for inline scripts).
 * @param {import("./ast.js").ParseResult} [parsed]  Reuse this parse of `code`
 *   instead of re-parsing it.
 * @returns {{hits: {line: number, column: number, event: string,
 *   async: boolean}[], parseError: string|null}}  One hit per addListener call on a
 *   resolved API chain; `event` is the dotted path it listens to, after the root
 *   (e.g. `runtime.onMessage`, `tabs.onUpdated`), and `async` is true when the
 *   listener is an async function (the shape the caller flags).
 */
export function scanAsyncOnMessage(code, lineOffset = 0, parsed) {
  const { ast, parseError } = parsed ?? parseJs(code);
  if (parseError || !ast) {
    return { hits: [], parseError: parseError ?? null };
  }
  const hits = [];
  const bases = apiBasesOf(ast);
  traverse(ast, {
    "CallExpression|OptionalCallExpression"(path) {
      // The callee resolves through the api-base index (aliases and captured
      // namespaces included), so the event is named from the API root whatever
      // spelling the add-on used to reach it.
      const resolved = calleeApiPath(path.node.callee, bases);
      const segments = resolved?.segments ?? [];
      if (segments.length < 2 || segments.at(-1) !== "addListener") {
        return;
      }
      const cb = path.node.arguments[0];
      const isFn =
        cb?.type === "FunctionExpression" ||
        cb?.type === "ArrowFunctionExpression";
      hits.push({
        ...nodeLoc(path.node, lineOffset),
        event: segments.slice(0, -1).join("."),
        async: Boolean(isFn && cb.async),
      });
    },
  });
  return { hits, parseError: null };
}
