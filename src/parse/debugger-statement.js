// Finds `debugger` statements. It locates them and nothing else: whether a given one
// is acceptable turns on what any enclosing condition MEANS - a build flag never true
// for users, or a test on a message, a tab, a user setting - and that is read from the
// file, not from the AST shape.
//
// Belongs here: locating DebuggerStatement nodes. Does NOT belong here: the
// non-authored skip that decides WHICH files to scan (-> src/lib/bundled.js),
// authored wording / severity (-> assets/registry.yaml). Babel access goes through
// src/parse/ast.js.

import { parseJs, traverse, nodeLoc } from "./ast.js";

/**
 * @param {string} code  JavaScript source text.
 * @param {number} [lineOffset]  Added to reported lines (for inline scripts).
 * @param {import("./ast.js").ParseResult} [parsed]  Reuse this parse of `code`
 *   instead of re-parsing it.
 * @returns {{hits: {line: number, column: number}[], parseError: string|null}}
 */
export function scanDebugger(code, lineOffset = 0, parsed) {
  const { ast, parseError } = parsed ?? parseJs(code);
  if (parseError || !ast) {
    return { hits: [], parseError: parseError ?? null };
  }
  const hits = [];
  traverse(ast, {
    DebuggerStatement(path) {
      hits.push(nodeLoc(path.node, lineOffset));
    },
  });
  return { hits, parseError: null };
}
