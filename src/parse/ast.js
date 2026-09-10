// The shared Babel front door for every module that parses add-on JavaScript:
// one canonical set of lenient parse options, the ESM unwrap of
// @babel/traverse's CommonJS default export, and the node -> finding-loc
// helper. Submission code is untrusted and often partial, so parsing is
// error-recovering and a fatal failure is reported, never thrown.
//
// Belongs here: the only direct import of @babel/parser and @babel/traverse in
// the app, plus the parse-options and the node->report primitives every parser
// reuses (nodeLoc for where a node is, srcText for what it says).
// Any module needing Babel goes through parseJs/traverse/nodeLoc here.
//
// Does NOT belong here: extracting facts from the AST or any check logic - the
// per-concern AST walks live in the sibling parsers (src/parse/api-base.js,
// api-usage.js, code-tokens.js, remote-js.js, unsafe-html.js, local-imports.js,
// loader-files.js). Verdicts go to src/checks/rules/*. HTML/markup parsing is a
// separate subsystem (src/scan/html.js and src/scan/html-parse.js).

import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import { extname } from "../util/files.js";
import { displayLine } from "../util/text.js";

export const traverse = _traverse.default || _traverse;

/** @typedef {import("@babel/types").Node} AstNode */
/**
 * @typedef {{ast: ?import("@babel/types").File, parseError: string|null}}
 *   ParseResult
 */

/**
 * The Babel plugins for a parse hint (a filename or a bare extension). The base
 * set applies to every source; TypeScript and JSX are enabled by extension so
 * authored framework source parses (type syntax is stripped, not checked). `.ts`
 * and `.tsx` differ deliberately: with `jsx` on, TSX mode disables `<T>`
 * angle-bracket type assertions, so a `.ts` file keeps them and a `.tsx` file
 * does not. Plain JS gets `jsx` too, since React is commonly authored in `.js`.
 * A missing/unknown hint keeps just the base set, so callers that parse
 * non-authored text (a library / obfuscation blob) are unaffected.
 * @param {string} [hint]
 * @returns {string[]}
 */
function pluginsFor(hint) {
  const base = ["topLevelAwait"];
  switch (hint ? extname(hint) : "") {
    // .cts / .mts are TypeScript's explicit CJS / ESM variants - they carry types exactly
    // like .ts, so they need the typescript plugin (without it a type annotation is a parse
    // error). JSX is .tsx only, so these do not get it, mirroring .ts.
    case ".ts":
    case ".cts":
    case ".mts":
      return [...base, "typescript"];
    case ".tsx":
      return [...base, "typescript", "jsx"];
    case ".jsx":
    case ".js":
    case ".cjs":
    case ".mjs":
    case ".jsm":
    case ".es":
    case ".es6":
      return [...base, "jsx"];
    default:
      return base;
  }
}

/**
 * Parse JavaScript leniently. Never throws: a fatal parse error comes back as
 * `parseError` so each caller can surface it its own way (a finding, a
 * scan-result field, ...).
 * @param {string} code
 * @param {string} [hint]  A filename or extension whose type selects the parse
 *   mode (TypeScript / JSX). Omitted -> plain-JS base plugins.
 * @returns {ParseResult}
 */
export function parseJs(code, hint) {
  try {
    return {
      ast: parse(code, {
        sourceType: "unambiguous",
        allowReturnOutsideFunction: true,
        errorRecovery: true,
        plugins: pluginsFor(hint),
      }),
      parseError: null,
    };
  } catch (err) {
    return { ast: null, parseError: err.message };
  }
}

/**
 * A finding loc from a node, shifted by an inline-script line offset.
 * @param {AstNode} node
 * @param {number} [lineOffset]
 * @returns {{line: number, column: number}}
 */
export function nodeLoc(node, lineOffset = 0) {
  return {
    line: (node.loc?.start.line ?? 1) + lineOffset,
    column: node.loc?.start.column ?? 0,
  };
}

/**
 * The add-on's own source for a node, as written - the expression a report shows
 * when what the developer typed IS the evidence (the destination of a network
 * sink), with nothing resolved. `code` must be the very string the node was parsed
 * from, since the offsets index into it.
 *
 * The text is the ADD-ON'S OWN and lands in a report a human reads in a terminal,
 * so it is flattened to plain visible characters first. Control and format
 * characters go: an escape sequence would let a string in the reviewed source
 * repaint or erase the report around it, and a bidi override would let it reorder
 * what is displayed. Whitespace then collapses to single spaces, since an
 * expression can span lines (a template literal, a ternary) and a raw slice would
 * carry newlines into a one-line locus.
 *
 * A node with no offsets - hand-built, or recovered from a parse error - yields
 * null rather than a slice of undefined bounds, which would be the WHOLE file.
 *
 * What survives is display material: never a key and never a match.
 * @param {AstNode} node
 * @param {string} code  The source the node was parsed from.
 * @returns {?string}  The expression as written, or null.
 */
export function srcText(node, code) {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") {
    return null;
  }
  // A destination expression can span lines (a template literal, a ternary) and the
  // locus it lands on is one.
  return displayLine(String(code ?? "").slice(node.start, node.end)) || null;
}

/**
 * True for a call node in either form: `f(x)` (CallExpression) or `f?.(x)`
 * (OptionalCallExpression). The two share their shape (callee, arguments), so a
 * scanner that handles one handles the other - this is the single guard that keeps
 * an optional call from slipping past a `=== "CallExpression"` check.
 * @param {AstNode} node
 * @returns {boolean}
 */
export function isCallLike(node) {
  return (
    node?.type === "CallExpression" || node?.type === "OptionalCallExpression"
  );
}

/**
 * True for a member access in either form: `x.foo` (MemberExpression) or `x?.foo`
 * (OptionalMemberExpression). Same shape (object, property, computed), so callee
 * and receiver checks must accept both or an optional-chained access slips past.
 * @param {AstNode} node
 * @returns {boolean}
 */
export function isMemberLike(node) {
  return (
    node?.type === "MemberExpression" ||
    node?.type === "OptionalMemberExpression"
  );
}

/**
 * The static property name of a (possibly optional) member expression:
 * `x.foo` / `x?.foo` -> "foo", `x["foo"]` -> "foo", and null for anything
 * computed/dynamic or a non-member node. The type guard is load-bearing -
 * callers pass arbitrary nodes.
 * @param {AstNode} node
 * @returns {string|null}
 */
export function memberPropName(node) {
  if (
    node?.type !== "MemberExpression" &&
    node?.type !== "OptionalMemberExpression"
  ) {
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
 * The fully-static file path an argument node resolves to, or null if any part
 * of the *path* is computed. Beyond a plain string this catches two
 * runtime-built shapes whose file is still fixed, so they are references, not
 * dynamic loaders:
 *   - a template literal with no interpolation (`"foo.js"` in backticks), and
 *   - a template or string concatenation whose computed part lands only in a
 *     `?query` or `#fragment` (e.g. `popup.html?id=${x}` -> popup.html).
 * A plain StringLiteral returns its value, so callers can pass any argument node.
 * @param {AstNode} node
 * @returns {string|null}
 */
export function staticPathOf(node) {
  if (node?.type === "StringLiteral") {
    return node.value;
  }
  if (node?.type === "TemplateLiteral") {
    if (node.expressions.length === 0) {
      return node.quasis[0]?.value?.cooked ?? null;
    }
    return pathBeforeQuery(node.quasis[0]?.value?.cooked ?? "");
  }
  if (node?.type === "BinaryExpression" && node.operator === "+") {
    let cur = node;
    while (cur.type === "BinaryExpression" && cur.operator === "+") {
      cur = cur.left;
    }
    if (cur.type === "StringLiteral") {
      return pathBeforeQuery(cur.value);
    }
  }
  return null;
}

/**
 * The path portion of a static prefix when the computed part falls in a query or
 * fragment: the text before the first `?` or `#`, or null if there is none (so a
 * prefix like `views/` that the computed part extends is not treated as fixed).
 * @param {string} prefix
 * @returns {?string}
 */
function pathBeforeQuery(prefix) {
  const i = prefix.search(/[?#]/);
  return i >= 0 ? prefix.slice(0, i) : null;
}

// How many values one expression may resolve to before it counts as dynamic. A
// ternary branches the value set and a "+" multiplies the branches on each side,
// so a chain of them grows exponentially; past this bound the expression is
// reported unresolved rather than half-enumerated.
const MAX_STATIC_VALUES = 32;

/**
 * EVERY string value a fully-static expression can take, or null when it carries
 * dynamic content. Static means a literal, an uninterpolated template, a "+"
 * concatenation of static parts, or a ternary whose arms are all static.
 *
 * A ternary yields the values of BOTH arms, and a concatenation the combinations
 * of its two sides, because a caller judging the result (is this URL local?) must
 * see every value it could be: reporting one arm as if it were the whole answer
 * lets an absolute URL parked in another arm pass for a relative one. A caller
 * that needs a single answer decides which value governs - this function ranks
 * nothing. Nesting needs no special case: `a ? x : b ? y : z` parses as
 * Cond(x, Cond(y, z)), so the two-arm rule already collects the whole chain.
 *
 * A missing node resolves to one empty string (an absent argument is the empty
 * value, not a dynamic one), as does a null literal.
 * @param {AstNode} node
 * @returns {?string[]}  Values (at least one, deduplicated), or null if dynamic.
 */
export function staticValues(node) {
  if (!node) {
    return [""];
  }
  switch (node.type) {
    case "StringLiteral":
      return [node.value];
    case "NumericLiteral":
    case "BooleanLiteral":
      return [String(node.value)];
    case "NullLiteral":
      return [""];
    case "TemplateLiteral":
      return node.expressions.length === 0
        ? [node.quasis.map((q) => q.value.cooked ?? "").join("")]
        : null;
    case "BinaryExpression": {
      if (node.operator !== "+") {
        return null;
      }
      const left = staticValues(node.left);
      const right = staticValues(node.right);
      if (!left || !right) {
        return null;
      }
      const combined = [];
      for (const l of left) {
        for (const r of right) {
          combined.push(l + r);
        }
      }
      return capped(combined);
    }
    case "ConditionalExpression": {
      const consequent = staticValues(node.consequent);
      const alternate = staticValues(node.alternate);
      return consequent && alternate
        ? capped([...consequent, ...alternate])
        : null;
    }
    default:
      return null;
  }
}

/**
 * Deduplicate a value set, or drop it for being too large to enumerate (which
 * reads as dynamic - the conservative answer, never a truncated one).
 * @param {string[]} values
 * @returns {?string[]}
 */
function capped(values) {
  const unique = [...new Set(values)];
  return unique.length > MAX_STATIC_VALUES ? null : unique;
}
