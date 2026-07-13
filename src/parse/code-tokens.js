// The code-text atoms of a source: every identifier name, string-literal value,
// template-literal text and regex pattern, joined into one newline-separated
// string. A textual presence test - "does token T occur in the CODE?" - reads
// this instead of the raw source, so it sees code and never comments: the atoms
// come from AST nodes, which carry no comment text, exactly the way every other
// analysis scanner ignores comments by walking the parse tree rather than the
// source string. Newlines separate atoms so a substring match cannot span two of
// them (permission tokens are word-like and never contain a newline).
//
// Belongs here: collecting the code-text atoms from a parsed AST. Does NOT belong
// here: deciding what to search for - that is the consumer's (e.g. the
// unused-permission token scan in src/lib/permissions.js). Babel access
// goes through src/parse/ast.js.

import { parseJs, traverse } from "./ast.js";

/**
 * @param {string} code  JavaScript source text.
 * @param {import("./ast.js").ParseResult} [parsed]  Reuse this parse of `code`
 *   instead of re-parsing it.
 * @returns {{text: string, parseError: string|null}}  `text` is the newline-joined
 *   code-text atoms (empty on a fatal parse).
 */
export function scanCodeText(code, parsed) {
  const { ast, parseError } = parsed ?? parseJs(code);
  if (parseError || !ast) {
    return { text: "", parseError: parseError ?? null };
  }
  const atoms = [];
  traverse(ast, {
    Identifier(path) {
      atoms.push(path.node.name);
    },
    StringLiteral(path) {
      atoms.push(path.node.value);
    },
    TemplateElement(path) {
      const value = path.node.value?.cooked ?? path.node.value?.raw;
      if (value) {
        atoms.push(value);
      }
    },
    RegExpLiteral(path) {
      atoms.push(path.node.pattern);
    },
  });
  return { text: atoms.join("\n"), parseError: null };
}
