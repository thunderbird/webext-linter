// Extracts WebExtension API usage from JavaScript by walking the AST for
// member-expression chains rooted at `browser`, `messenger`, or `chrome` (all
// three are valid in Thunderbird submissions). For
// `browser.messages.tags.list(...)` it yields segments
// ["messages","tags","list"]. It also follows an alias of the API object OR one of
// its namespaces - the common Thunderbird feature-detection shapes `const api =
// messenger || browser`, `const api = typeof messenger !== "undefined" ? messenger
// : browser`, and a namespace captured into a local (`const m = browser.messages`,
// or the guarded shim shape `_m = _api && _api.messages || null`) - so `api.*` and
// `m.*` calls resolve to their full path (`m.archive()` -> messages.archive). The
// alias is resolved by its binding's initializer, not its name, and back to a real
// root (browser/messenger/chrome). This is deliberately best-effort: dynamic/computed
// access and destructured aliases (const { messages } = browser) can't always be
// resolved statically, so we surface those as "limitations" rather than silently
// dropping them.
//
// Within this module, `aliasTarget` is the single notion of "does this expression
// denote an API object?" - both the usage extraction above AND the feature-detection
// guard signal (whether a call sits behind `if (typeof _m.foo === "function") _m.foo()`)
// consume it, so an aliased namespace is understood the same way in both paths. (Coarse
// scanners elsewhere - network-sinks, loader detection - match only a literal root and
// do not resolve aliases; a tolerable best-effort gap there.)
//
// Belongs here: usage extraction (segments, line/column, dynamic-tail and alias
// limitations), the feature-detection guard signal, and the shared API_ROOTS set.
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
 *   local guard (an enclosing if/?:/while test or `&&`/`||` referencing an API object
 *   - a root or an alias/captured namespace - or getBrowserInfo, or a `typeof` probe)
 *   - a coarse "might be feature-detected" signal a consumer can hand to the LLM.
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
      // A chain-base identifier that denotes an API object: a literal root, a
      // whole-object alias (const api = messenger || browser), or a captured namespace
      // (const m = browser.messages; _m = _api && _api.messages || null). aliasTarget
      // resolves it by its binding's initializer to {root, prefix}, where prefix is the
      // captured segment path (browser.messages -> ["messages"]), prepended to the chain.
      const target = isChainBase(path)
        ? aliasTarget(path.node, path.scope, new Set())
        : null;

      if (!target) {
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

      const climbed = climbChain(path);
      const segments = [...target.prefix, ...climbed.segments];
      const { dynamicTail, dynamicAt, optional } = climbed;
      const guarded = optional || isGuarded(path);
      usages.push({
        root: target.root,
        segments,
        dynamicTail,
        optional,
        guarded,
        ...loc(path.node),
      });
      if (dynamicTail && dynamicAt) {
        limitations.push({
          ...loc(dynamicAt),
          reason: `computed/dynamic member access on "${target.root}.${segments.join(".")}" not fully resolved`,
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
 * @typedef {object} AliasTarget
 * @property {"browser"|"messenger"|"chrome"} root  The real API global the alias
 *   resolves back to.
 * @property {string[]} prefix  The captured segment path between the root and the
 *   alias site (browser.messages -> ["messages"]; a whole-object alias -> []).
 */

/**
 * The API target an initializer expression resolves to, or null. Handles the common
 * Thunderbird feature-detection alias shapes AND a namespace captured into a local:
 *   const api = messenger                                  (direct root)
 *   const api = messenger || browser || chrome             (|| / ?? chain)
 *   const api = typeof messenger !== 'undefined' ? messenger : browser  (ternary)
 *   const m = browser.messages                             (namespace capture)
 *   const m = _api && _api.messages || null                (guarded shim capture)
 * Resolution is by structure, back to a real root: a member access appends its
 * static property name to the prefix; a computed/dynamic property gives up (null).
 * @param {object} node  An expression node (a VariableDeclarator init).
 * @param {object} scope  The declarator's scope, for resolving nested identifiers.
 * @param {Set<string>} seen  Binding names already being resolved (cycle guard).
 * @returns {?AliasTarget}
 */
function aliasTarget(node, scope, seen) {
  if (!node) {
    return null;
  }
  switch (node.type) {
    case "Identifier":
      if (API_ROOTS.has(node.name)) {
        // The GLOBAL api object only - a shadowed local named browser/messenger/
        // chrome (e.g. a function parameter) is not the API root.
        return scope?.getBinding(node.name)
          ? null
          : { root: node.name, prefix: [] };
      }
      return aliasedTarget(scope?.getBinding(node.name), scope, seen);
    case "MemberExpression":
    case "OptionalMemberExpression": {
      const base = aliasTarget(node.object, scope, seen);
      if (!base) {
        return null;
      }
      const key = memberName(node);
      return key === null
        ? null
        : { root: base.root, prefix: [...base.prefix, key] };
    }
    case "ParenthesizedExpression":
      return aliasTarget(node.expression, scope, seen);
    case "LogicalExpression":
      // ||/?? -> either operand carries the value; && -> the RHS is the value
      // (`_api && _api.messages`), the LHS is just the presence guard.
      if (node.operator === "||" || node.operator === "??") {
        return (
          aliasTarget(node.left, scope, seen) ??
          aliasTarget(node.right, scope, seen)
        );
      }
      if (node.operator === "&&") {
        // `A && B` is B when A is truthy; A is the value only on short-circuit
        // (the API is absent), so the presence guard (LHS) is never the alias.
        return aliasTarget(node.right, scope, seen);
      }
      return null;
    case "ConditionalExpression":
      return (
        aliasTarget(node.consequent, scope, seen) ??
        aliasTarget(node.alternate, scope, seen)
      );
    default:
      return null;
  }
}

/**
 * The static property name of a member expression (`x.foo` -> "foo",
 * `x["foo"]` -> "foo"), or null for a computed/dynamic property (`x[k]`).
 * @param {object} node  A MemberExpression / OptionalMemberExpression.
 * @returns {?string}
 */
function memberName(node) {
  if (node.computed) {
    return node.property.type === "StringLiteral" ? node.property.value : null;
  }
  return node.property.type === "Identifier" ? node.property.name : null;
}

/**
 * Resolve a binding to the API target its initializer aliases, or null. Only a
 * `const/let/var x = <init>` whose id is a plain identifier counts (destructuring
 * does not - that stays a coverage-gap limitation). Recurses through multi-hop
 * captures (`_m` -> `_api.messages`, `_api` -> browser); `seen` (keyed by binding
 * name) guarantees termination - each binding is resolved at most once, and bindings
 * are finite, so a cycle bottoms out at null.
 * @param {object} binding  A Babel scope binding (or undefined).
 * @param {object} scope  Fallback scope for nested identifier lookups.
 * @param {Set<string>} seen  Binding names already being resolved.
 * @returns {?AliasTarget}
 */
function aliasedTarget(binding, scope, seen) {
  const decl = binding?.path;
  if (!decl || decl.type !== "VariableDeclarator") {
    return null;
  }
  if (decl.node.id.type !== "Identifier") {
    return null; // destructuring etc. - not a whole-object/namespace alias
  }
  const name = decl.node.id.name;
  if (seen.has(name)) {
    return null; // a cycle - each binding is resolved at most once
  }
  seen.add(name);
  return aliasTarget(decl.node.init, decl.scope ?? scope, seen);
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
 * Coarse: does this AST subtree reference an API object - a literal root, OR a local
 * that aliases a root/namespace (resolved via aliasTarget, the same primitive usage
 * extraction uses) - or the getBrowserInfo version-gate helper? Such a reference in a
 * guard test marks the guarded code as possibly feature-detected; the precise call is
 * left to the LLM. Scope-aware: a shadowed local named browser/messenger/chrome does
 * NOT resolve, so it is not a false signal. Only VALUE-position identifiers count - a
 * property name (`flag.something`) is a name, not a reference, so it is never resolved.
 * @param {object} node
 * @param {object} scope  Scope of the guarded access, for resolving aliases.
 * @returns {boolean}
 */
function refsGuardSignal(node, scope) {
  let found = false;
  const visit = (n) => {
    if (found || !n || typeof n.type !== "string") {
      return;
    }
    if (
      n.type === "Identifier" &&
      (n.name === "getBrowserInfo" || aliasTarget(n, scope, new Set()) !== null)
    ) {
      found = true;
      return;
    }
    // A non-computed member's `property` is a name, not a value - skip it so a plain
    // `flag.something` never resolves `something` as an alias (only `x[expr]` computed
    // keys and value-position operands are real references).
    const skipProperty =
      (n.type === "MemberExpression" ||
        n.type === "OptionalMemberExpression") &&
      !n.computed;
    for (const key of Object.keys(n)) {
      if (key === "loc" || key === "start" || key === "end") {
        continue;
      }
      if (skipProperty && key === "property") {
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
 * `&&`/`||` referencing an API object (root or alias) or getBrowserInfo, or a
 * `typeof` probe. The walk stops at the nearest function boundary, so a guard never
 * leaks across a function definition (a deliberately conservative, coarse signal).
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
    if (
      GUARD_TEST_TYPES.has(node.type) &&
      refsGuardSignal(node.test, rootPath.scope)
    ) {
      return true;
    }
    if (
      node.type === "LogicalExpression" &&
      (node.operator === "&&" || node.operator === "||") &&
      refsGuardSignal(node, rootPath.scope)
    ) {
      return true;
    }
    p = parent;
  }
  return false;
}
