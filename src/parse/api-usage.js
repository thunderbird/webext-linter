// Extracts WebExtension API usage from JavaScript by walking the AST for
// member-expression chains rooted at `browser`, `messenger`, or `chrome` (all
// three are valid in Thunderbird submissions). For
// `browser.messages.tags.list(...)` it yields segments
// ["messages","tags","list"]. It also follows a whole-object alias of the API
// object - the common Thunderbird feature-detection shapes `const api = messenger
// || browser` and `const api = typeof messenger !== "undefined" ? messenger :
// browser` - so `api.*` calls resolve too. This is deliberately best-effort:
// dynamic/computed access and destructured aliases (const { messages } = browser)
// can't always be resolved statically, so we surface those as "limitations"
// rather than silently dropping them.
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
 * @property {boolean} optional        True if any link in the member chain uses
 *   optional chaining (`messenger.foo?.bar`), so the access short-circuits to
 *   undefined where the member is missing.
 * @property {boolean} guarded         True if `optional`, OR the access sits in a
 *   local guard (an enclosing if/?:/while test or `&&`/`||` referencing an API
 *   root or getBrowserInfo, or a `typeof` probe) - a coarse "might be feature-
 *   detected" signal a consumer can hand to the LLM for a precise call.
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
      // The literal API roots, OR a local variable that whole-object-aliases one
      // (const api = messenger || browser; const api = cond ? messenger : ...).
      // The alias's canonical root is interchangeable for resolution.
      let root = null;
      if (API_ROOTS.has(name) && isApiRoot(path)) {
        root = name;
      } else if (!API_ROOTS.has(name) && isChainBase(path)) {
        root = aliasedRoot(path);
      }

      if (!root) {
        // A direct alias/destructuring of the API object we could NOT resolve to
        // usages (e.g. const { messages } = browser) stays a coverage gap.
        if (
          API_ROOTS.has(name) &&
          isAliasOrigin(path) &&
          !aliasIsResolved(path)
        ) {
          limitations.push({
            ...loc(path.node),
            reason: `API object "${name}" is aliased/destructured; usage via the alias is not statically resolved`,
          });
        }
        return;
      }

      const { segments, dynamicTail, dynamicAt, optional } = climbChain(path);
      const guarded = optional || isGuarded(path);
      usages.push({
        root,
        segments,
        dynamicTail,
        optional,
        guarded,
        ...loc(path.node),
      });
      if (dynamicTail && dynamicAt) {
        limitations.push({
          ...loc(dynamicAt),
          reason: `computed/dynamic member access on "${root}.${segments.join(".")}" not fully resolved`,
        });
      }
    },
  });

  return { usages, limitations, parseError: null };
}

/**
 * True when this identifier is the base object of a member chain (e.g. the `x` in
 * `x.foo.bar`), not a property name. Says nothing about whether `x` is an API
 * object - just the syntactic position.
 * @param {BabelPath} path
 * @returns {boolean}
 */
function isChainBase(path) {
  if (path.key === "property" && path.parent.type === "MemberExpression") {
    return false; // it's the `.x` part of something.x
  }
  return Boolean(
    path.parentPath?.isMemberExpression() && path.parent.object === path.node
  );
}

/**
 * True when this identifier is the root object of a member expression on the
 * global API object (browser/messenger/chrome), not a property name or a shadowed
 * local binding.
 * @param {BabelPath} path
 * @returns {boolean}
 */
function isApiRoot(path) {
  // Don't count a shadowed local binding as the global API object.
  return isChainBase(path) && !path.scope.hasBinding(path.node.name);
}

/**
 * The canonical API root an initializer expression resolves to, or null. Handles
 * the common Thunderbird feature-detection alias shapes:
 *   const api = messenger                                  (direct)
 *   const api = messenger || browser || chrome             (|| / ?? chain)
 *   const api = typeof messenger !== 'undefined' ? messenger : browser  (ternary)
 * @param {object} node  An expression node (a VariableDeclarator init).
 * @returns {?string}
 */
function aliasRoot(node) {
  if (!node) {
    return null;
  }
  switch (node.type) {
    case "Identifier":
      return API_ROOTS.has(node.name) ? node.name : null;
    case "ParenthesizedExpression":
      return aliasRoot(node.expression);
    case "LogicalExpression":
      return node.operator === "||" || node.operator === "??"
        ? (aliasRoot(node.left) ?? aliasRoot(node.right))
        : null;
    case "ConditionalExpression":
      return aliasRoot(node.consequent) ?? aliasRoot(node.alternate);
    default:
      return null;
  }
}

/**
 * For a non-root identifier sitting at a chain base (e.g. `api` in `api.foo`),
 * resolve its binding to a whole-object API alias and return the canonical root
 * it aliases, or null. Only a `const x = <init>` whose id is a plain identifier
 * and whose init resolves via aliasRoot counts (one hop; destructuring does not).
 * @param {BabelPath} path
 * @returns {?string}
 */
function aliasedRoot(path) {
  const binding = path.scope.getBinding(path.node.name);
  const decl = binding?.path;
  if (!decl || decl.type !== "VariableDeclarator") {
    return null;
  }
  if (decl.node.id.type !== "Identifier") {
    return null; // destructuring etc. - not a whole-object alias
  }
  return aliasRoot(decl.node.init);
}

/**
 * True when an alias-origin identifier (the `browser` in `const x = browser`) is
 * a whole-object alias we DO resolve (its declarator id is a plain identifier),
 * so it need not be reported as a coverage-gap limitation.
 * @param {BabelPath} path
 * @returns {boolean}
 */
function aliasIsResolved(path) {
  return (
    path.parent.type === "VariableDeclarator" &&
    path.parent.id.type === "Identifier"
  );
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
 * True when the path is a member access (plain or optional-chained), so a chain
 * like `messenger.foo?.bar` is climbed in full rather than cut at the `?.`.
 * @param {BabelPath} [path]
 * @returns {boolean}
 */
function isMemberish(path) {
  return Boolean(
    path && (path.isMemberExpression() || path.isOptionalMemberExpression())
  );
}

/**
 * From a root identifier, walk up the chain of member expressions collecting
 * property names. Stops at the first computed/non-literal access (marked as a
 * dynamic tail). Optional-chained links (`?.`) are traversed and flagged.
 * @param {BabelPath} rootPath
 * @returns {{segments:string[], dynamicTail:boolean, dynamicAt:object|null,
 *   optional:boolean}}
 */
function climbChain(rootPath) {
  const segments = [];
  let current = rootPath;
  let dynamicTail = false;
  let dynamicAt = null;
  let optional = false;

  while (
    isMemberish(current.parentPath) &&
    current.parent.object === current.node
  ) {
    const member = current.parent;
    if (member.optional) {
      optional = true;
    }
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
  return { segments, dynamicTail, dynamicAt, optional };
}

// Statement/expression kinds whose `.test` is a guard condition.
const GUARD_TEST_TYPES = new Set([
  "IfStatement",
  "ConditionalExpression",
  "WhileStatement",
  "DoWhileStatement",
]);

/**
 * Coarse: does this AST subtree mention an API root (browser/messenger/chrome)
 * or getBrowserInfo? Such a reference in a guard test marks the guarded code as
 * possibly feature-detected; the precise call is left to the LLM.
 * @param {object} node
 * @returns {boolean}
 */
function refsGuardSignal(node) {
  let found = false;
  const visit = (n) => {
    if (found || !n || typeof n.type !== "string") {
      return;
    }
    if (
      n.type === "Identifier" &&
      (API_ROOTS.has(n.name) || n.name === "getBrowserInfo")
    ) {
      found = true;
      return;
    }
    for (const key of Object.keys(n)) {
      if (key === "loc" || key === "start" || key === "end") {
        continue;
      }
      const v = n[key];
      if (Array.isArray(v)) {
        for (const c of v) {
          visit(c);
        }
      } else {
        visit(v);
      }
    }
  };
  visit(node);
  return found;
}

/**
 * Whether the access sits in a LOCAL guard - an enclosing if/?:/while test or a
 * `&&`/`||` referencing an API root or getBrowserInfo, or a `typeof` probe. The
 * walk stops at the nearest function boundary, so a guard never leaks across a
 * function definition (a deliberately conservative, coarse signal).
 * @param {BabelPath} rootPath
 * @returns {boolean}
 */
function isGuarded(rootPath) {
  let p = rootPath;
  while (p) {
    const parent = p.parentPath;
    if (!parent || parent.isFunction()) {
      return false;
    }
    const node = parent.node;
    // An optional CALL on this chain (`messenger.foo.bar?.()`) short-circuits to
    // undefined when the member is missing - a guard, like optional chaining on
    // the member path (which climbChain already flags as `optional`).
    if (node.type === "OptionalCallExpression" && p.key === "callee") {
      return true;
    }
    if (node.type === "UnaryExpression" && node.operator === "typeof") {
      return true;
    }
    if (GUARD_TEST_TYPES.has(node.type) && refsGuardSignal(node.test)) {
      return true;
    }
    if (
      node.type === "LogicalExpression" &&
      (node.operator === "&&" || node.operator === "||") &&
      refsGuardSignal(node)
    ) {
      return true;
    }
    p = parent;
  }
  return false;
}
