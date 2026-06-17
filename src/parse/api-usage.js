// Extracts WebExtension API usage from JavaScript by walking the AST for
// member-expression chains rooted at `browser`, `messenger`, or `chrome` (all
// three are valid in Thunderbird submissions). For
// `browser.messages.tags.list(...)` it yields segments
// ["messages","tags","list"]. This is deliberately best-effort: dynamic/
// computed access and destructured aliases can't always be resolved statically,
// so we surface those as "limitations" rather than silently dropping them.
//
// Belongs here: usage extraction (segments, line/column, dynamic-tail and alias
// limitations) and the shared API_ROOTS set of root identifiers.
//
// Does NOT belong here: deciding whether a usage needs a permission, is covered
// by the manifest, or is otherwise allowed - those verdicts live in the checks
// (src/checks/rules/* and src/checks/lib/permissions.js). User-facing wording
// lives in assets/registry.yaml. Babel access goes through src/parse/ast.js.

import { parseJs, traverse } from "./ast.js";

export const API_ROOTS = new Set(["browser", "messenger", "chrome"]);

/** @typedef {object} BabelPath A @babel/traverse NodePath object. */

/**
 * @typedef {object} ApiUsage
 * @property {"browser"|"messenger"|"chrome"} root
 * @property {string[]} segments       Property names after the root.
 * @property {number} line             1-based line in the original file.
 * @property {number} column           0-based column.
 * @property {boolean} dynamicTail     True if the chain ended at a computed
 *   access.
 */

/**
 * @typedef {object} ApiUsageResult
 * @property {ApiUsage[]} usages
 * @property {{line:number, column:number, reason:string}[]} limitations
 * @property {string|null} parseError
 */

/**
 * @param {string} code
 * @param {number} [lineOffset]  Added to reported lines (for inline scripts).
 * @param {import("./ast.js").ParseResult} [parsed]  Reuse this parse of `code`
 *   instead of re-parsing it.
 * @returns {ApiUsageResult}
 */
export function parseApiUsage(code, lineOffset = 0, parsed) {
  const { ast, parseError } = parsed ?? parseJs(code);
  if (parseError) {
    return { usages: [], limitations: [], parseError };
  }

  const usages = [];
  const limitations = [];
  /** @param {object} node @returns {{line:number, column:number}} */
  const loc = (node) => ({
    line: (node.loc?.start.line ?? 1) + lineOffset,
    column: node.loc?.start.column ?? 0,
  });

  traverse(ast, {
    Identifier(path) {
      const name = path.node.name;
      if (!API_ROOTS.has(name)) {
        return;
      }
      // Only treat it as a root when it is the base object of a member chain,
      // not a property name, declaration id, or otherwise shadowed local
      // binding.
      if (!isApiRoot(path)) {
        // Aliasing / destructuring of the API object - record as a coverage
        // gap.
        if (isAliasOrigin(path)) {
          limitations.push({
            ...loc(path.node),
            reason: `API object "${name}" is aliased/destructured; usage via the alias is not statically resolved`,
          });
        }
        return;
      }

      const { segments, dynamicTail, dynamicAt } = climbChain(path);
      usages.push({ root: name, segments, dynamicTail, ...loc(path.node) });
      if (dynamicTail && dynamicAt) {
        limitations.push({
          ...loc(dynamicAt),
          reason: `computed/dynamic member access on "${name}.${segments.join(".")}" not fully resolved`,
        });
      }
    },
  });

  return { usages, limitations, parseError: null };
}

/**
 * True when this identifier is the root object of a member expression (e.g.
 * browser.xxx), not a property name or shadowed binding.
 * @param {BabelPath} path
 * @returns {boolean}
 */
function isApiRoot(path) {
  if (path.key === "property" && path.parent.type === "MemberExpression") {
    return false; // it's the `.browser` part of something.browser
  }
  if (
    path.parentPath?.isMemberExpression() &&
    path.parent.object === path.node
  ) {
    // Don't count a shadowed local binding as the global API object.
    return !path.scope.hasBinding(path.node.name);
  }
  return false;
}

/**
 * True when the identifier is the source of an alias, e.g.
 * `const x = browser` or `const { messages } = browser`.
 * @param {BabelPath} path
 * @returns {boolean}
 */
function isAliasOrigin(path) {
  const parent = path.parent;
  if (parent.type === "VariableDeclarator" && parent.init === path.node) {
    return !path.scope.hasBinding(path.node.name);
  }
  return false;
}

/**
 * From a root identifier, walk up the chain of member expressions collecting
 * property names. Stops at the first computed/non-literal access (marked as a
 * dynamic tail).
 * @param {BabelPath} rootPath
 * @returns {{segments:string[], dynamicTail:boolean, dynamicAt:object|null}}
 */
function climbChain(rootPath) {
  const segments = [];
  let current = rootPath;
  let dynamicTail = false;
  let dynamicAt = null;

  while (
    current.parentPath?.isMemberExpression() &&
    current.parent.object === current.node
  ) {
    const member = current.parent;
    if (member.computed) {
      if (member.property.type === "StringLiteral") {
        segments.push(member.property.value);
      } else {
        dynamicTail = true;
        dynamicAt = member.property;
        break;
      }
    } else if (member.property.type === "Identifier") {
      segments.push(member.property.name);
    } else {
      dynamicTail = true;
      dynamicAt = member.property;
      break;
    }
    current = current.parentPath;
  }
  return { segments, dynamicTail, dynamicAt };
}
