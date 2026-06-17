// Finds writes of dynamic (non-literal) content into HTML sinks - the DOM-XSS
// pattern behind the "Modifying innerHTML, unsanitized HTML" review rule. Ports
// the core of eslint-plugin-no-unsanitized: a value is safe only if it is a
// static string (a string literal, a template with no interpolation, or a
// concatenation of safe values); anything dynamic is flagged.
//
// Sinks: assignment to .innerHTML / .outerHTML / .srcdoc, and
// .insertAdjacentHTML(pos, x).
//
// Belongs here: detecting those JS sinks and the static-vs-dynamic value test,
// emitting one hit per unsafe write.
//
// Does NOT belong here: the verdict and wording - those live in
// src/checks/rules/unsafe-html.js and assets/registry.yaml. Parsing markup in
// .html files is a different subsystem (src/scan/html.js and
// src/scan/html-parse.js). Babel access goes through src/parse/ast.js.

import { parseJs, traverse, nodeLoc } from "./ast.js";

/** @typedef {import("@babel/types").Node} AstNode */

const PROPERTY_SINKS = new Set(["innerHTML", "outerHTML", "srcdoc"]);

/**
 * @typedef {object} UnsafeHtmlHit
 * @property {"innerHTML"|"outerHTML"|"srcdoc"|"insertAdjacentHTML"} sink
 * @property {number} line
 * @property {number} column
 */

/**
 * @param {string} code  JavaScript source text.
 * @param {number} [lineOffset]  Added to reported lines (for inline scripts).
 * @param {import("./ast.js").ParseResult} [parsed]  Reuse this parse of `code`
 *   instead of re-parsing it.
 * @returns {{hits: UnsafeHtmlHit[], parseError: string|null}}
 */
export function scanUnsafeHtml(code, lineOffset = 0, parsed) {
  const { ast, parseError } = parsed ?? parseJs(code);
  if (parseError) {
    return { hits: [], parseError };
  }

  const hits = [];
  /** @param {AstNode} node @returns {{line:number, column:number}} */
  const at = (node) => nodeLoc(node, lineOffset);

  traverse(ast, {
    AssignmentExpression(path) {
      const { left, right } = path.node;
      const sink = memberPropName(left);
      if (sink && PROPERTY_SINKS.has(sink) && !isStaticHtml(right)) {
        hits.push({ sink, ...at(path.node) });
      }
    },
    CallExpression(path) {
      const { callee, arguments: args } = path.node;
      if (
        memberPropName(callee) === "insertAdjacentHTML" &&
        !isStaticHtml(args[1])
      ) {
        hits.push({ sink: "insertAdjacentHTML", ...at(path.node) });
      }
    },
  });
  return { hits, parseError: null };
}

/**
 * The accessed property name of a member expression - both dot access
 * (`el.innerHTML`) and string-literal bracket access (`el["innerHTML"]`, a
 * common obfuscation) - or null if it is not a static property access.
 * @param {AstNode} node
 * @returns {string|null}
 */
function memberPropName(node) {
  if (node?.type !== "MemberExpression") {
    return null;
  }
  if (!node.computed && node.property?.type === "Identifier") {
    return node.property.name;
  }
  if (node.computed && node.property?.type === "StringLiteral") {
    return node.property.value;
  }
  return null;
}

/**
 * True if a value carries no dynamic content: a string/number/boolean/null
 * literal, a template literal with no interpolation, a "+" concatenation of
 * static parts, or a ternary whose branches are both static. Anything dynamic
 * (variable, call, interpolated template, etc.) is not static.
 * @param {AstNode} node
 * @returns {boolean}
 */
function isStaticHtml(node) {
  if (!node) {
    return true; // no argument - nothing dynamic is written
  }
  switch (node.type) {
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
    case "NullLiteral":
      return true;
    case "TemplateLiteral":
      return node.expressions.length === 0;
    case "BinaryExpression":
      return (
        node.operator === "+" &&
        isStaticHtml(node.left) &&
        isStaticHtml(node.right)
      );
    case "ConditionalExpression":
      return isStaticHtml(node.consequent) && isStaticHtml(node.alternate);
    default:
      return false;
  }
}
