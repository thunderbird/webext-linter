// Extracts WebExtension API usage from JavaScript by walking the AST for
// member-expression chains rooted at the API object. For
// `browser.messages.tags.list(...)` it yields segments
// ["messages","tags","list"]. Chain bases are resolved through the shared
// per-AST index (apiBasesOf in src/parse/api-base.js), so an alias of the API
// object or a captured namespace (`const api = messenger || browser`,
// `const m = browser.messages`) yields the same full path as a direct call
// (`m.archive()` -> messages.archive). This is deliberately best-effort:
// dynamic/computed access and destructured aliases (const { messages } =
// browser) can't always be resolved statically, so we surface those as
// "limitations" rather than silently dropping them.
//
// Belongs here: usage extraction (segments, line/column, dynamic-tail and alias
// limitations) and the feature-detection guard signal - whether a call sits behind
// `if (typeof _m.foo === "function") _m.foo()`, and which API paths a short-circuit
// offers it as the alternative.
//
// Does NOT belong here: what denotes an API object - the API_ROOTS set, alias
// resolution, and the per-AST base index (-> src/parse/api-base.js). Deciding
// whether a usage needs a permission, is covered by the manifest, or is
// otherwise allowed - those verdicts live in the checks (src/checks/rules/* and
// src/lib/permissions.js). User-facing wording lives in
// assets/registry.yaml. Babel access goes through src/parse/ast.js.

import { parseJs, traverse, nodeLoc } from "./ast.js";
import { API_ROOTS, aliasTarget, apiBasesOf } from "./api-base.js";

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
 *   local guard: an enclosing if/?:/while test or a short-circuit referencing an API
 *   object - a root or an alias/captured namespace - or getBrowserInfo, or a `typeof`
 *   probe, or an earlier guard clause in the same statement list whose test names such
 *   an object and whose consequent always exits (`if (!api.foo) return;`). A coarse
 *   "might be feature-detected" signal a consumer can hand to a reviewer.
 * @property {string[][]} guardRefs    The API paths that guard names, as segment
 *   lists after the root. Empty when the guard names none (a `typeof` probe), and an
 *   empty list stands for a reference carrying no namespace (a bare root,
 *   getBrowserInfo). Lets a consumer ask whether the guard offers a path that
 *   actually exists - the `browser.menus ?? browser.contextMenus` shim - which a bare
 *   `guarded` cannot say.
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
  const loc = (node) => nodeLoc(node, lineOffset);

  const bases = apiBasesOf(ast);

  /**
   * Record the usage a resolved chain base carries: the segments its chain adds
   * to the base's own prefix, plus how confidently they were read. Shared by both
   * shapes a base can take, so a root reached through the global object is
   * reported exactly like one reached by name.
   * @param {object} path  The chain base's path.
   * @param {AliasTarget} target  What the base resolves to.
   */
  const recordUsage = (path, target) => {
    const climbed = climbChain(path);
    const segments = [...target.prefix, ...climbed.segments];
    const { dynamicTail, dynamicAt, optional } = climbed;
    const guard = guardOf(path);
    usages.push({
      root: target.root,
      segments,
      dynamicTail,
      optional,
      guarded: optional || guard !== null,
      guardRefs: guard ?? [],
      ...loc(path.node),
    });
    if (dynamicTail && dynamicAt) {
      limitations.push({
        ...loc(dynamicAt),
        reason: `computed/dynamic member access on "${target.root}.${segments.join(".")}" not fully resolved`,
      });
    }
  };

  traverse(ast, {
    Identifier(path) {
      const name = path.node.name;
      // A chain-base identifier that denotes an API object: a literal root, a
      // whole-object alias (const api = messenger || browser), or a captured namespace
      // (const m = browser.messages; _m = _api && _api.messages || null). The shared
      // index resolves it to {root, prefix}, where prefix is the captured segment
      // path (browser.messages -> ["messages"]), prepended to the chain.
      const target = bases.get(path.node) ?? null;

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
      recordUsage(path, target);
    },
    // A root named on the global object (globalThis.browser.tabs.create) is a
    // chain base in its own right - the index holds it under the member node,
    // since the identifier at its head denotes the global object, not an API
    // object. Only such members are indexed, so a chain is never counted twice.
    "MemberExpression|OptionalMemberExpression"(path) {
      const target = bases.get(path.node);
      if (target) {
        recordUsage(path, target);
      }
    },
  });

  return { usages, limitations, parseError: null };
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
 * Every API object this AST subtree references - a literal root, a local that aliases
 * a root/namespace (resolved via aliasTarget, the same primitive usage extraction
 * uses), or the getBrowserInfo version-gate helper - as the segment path each names
 * after the root. A reference carrying no namespace of its own (a bare root,
 * getBrowserInfo) contributes an empty path, so it still counts as a signal without
 * claiming to name an API. Any reference at all marks the guarded code as possibly
 * feature-detected; WHICH paths it names lets a consumer tell a compat shim from a
 * probe for something that does not exist.
 *
 * Scope-aware: a shadowed local named browser/messenger/chrome does NOT resolve, so it
 * is not a false signal. Only VALUE-position identifiers count - a property name
 * (`flag.something`) is a name, not a reference, so it is never resolved.
 * @param {object} node
 * @param {object} scope  Scope of the guarded access, for resolving aliases.
 * @returns {string[][]}  One path per reference; empty when there are none.
 */
function guardApiRefs(node, scope) {
  const refs = [];
  const visit = (n) => {
    if (!n || typeof n.type !== "string") {
      return;
    }
    if (n.type === "Identifier") {
      if (n.name === "getBrowserInfo") {
        refs.push([]);
        return;
      }
      const target = aliasTarget(n, scope, new Set());
      if (target) {
        refs.push([...target.prefix]);
        return;
      }
    }
    const isMember =
      n.type === "MemberExpression" || n.type === "OptionalMemberExpression";
    // A member can denote an API object itself (a root named on the global
    // object, or a namespace read off one), and it is tested here rather than
    // through its parts: the skip below hides the very property that names it.
    if (isMember) {
      const target = aliasTarget(n, scope, new Set());
      if (target) {
        refs.push([...target.prefix]);
        return;
      }
    }
    // A non-computed member's `property` is a name, not a value - skip it so a plain
    // `flag.something` never resolves `something` as an alias (only `x[expr]` computed
    // keys and value-position operands are real references).
    const skipProperty = isMember && !n.computed;
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
  return refs;
}

/**
 * Whether control can NEVER continue past this statement to the one after it - it
 * returns, throws, or jumps out of the loop. That is what turns an `if` into a guard
 * for its FOLLOWING siblings rather than for its own body: if the bail is taken there
 * is no "after", so reaching the next statement means the test was falsy.
 * @param {AstNode} node  A statement.
 * @returns {boolean}
 */
function alwaysExits(node) {
  switch (node?.type) {
    case "ReturnStatement":
    case "ThrowStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return true;
    case "BlockStatement":
      return alwaysExits(node.body[node.body.length - 1]);
    default:
      return false;
  }
}

/**
 * The guard clause standing over this statement: an earlier sibling that tests an API
 * object and bails when the test passes (`if (!messenger.x) return`). Everything after
 * such an `if` runs only when its test was falsy, which is how feature detection is
 * most often written - the alternative to nesting the whole function in an `if`.
 *
 * Siblings are read nearest-first, and the answer is only whether ONE is there; which
 * API it named is deliberately not weighed against the access, since the verdict this
 * feeds is "a human should look", not "this is fine".
 *
 * The preceding statements are read as plain nodes off the container rather than as
 * paths. This runs for every API access in a file, and a bundled one puts thousands of
 * statements in a single list - building a path per sibling to look at its `type` costs
 * more than the whole rest of the walk.
 * @param {BabelPath} stmt  A statement path inside a statement list.
 * @param {object} scope  Scope of the guarded access, for resolving aliases.
 * @returns {boolean}
 */
function precededByGuardClause(stmt, scope) {
  const siblings = stmt.container;
  if (!Array.isArray(siblings) || typeof stmt.key !== "number") {
    return false;
  }
  for (let i = stmt.key - 1; i >= 0; i--) {
    const prev = siblings[i];
    if (
      prev?.type === "IfStatement" &&
      alwaysExits(prev.consequent) &&
      guardApiRefs(prev.test, scope).length > 0
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The LOCAL guard the access sits in, as the API paths that guard names (see
 * guardApiRefs) - an enclosing if/?:/while test, an earlier guard clause that bailed,
 * or a short-circuit referencing an API object (root or alias) or getBrowserInfo, or a
 * `typeof` probe. Null when there is no guard; an empty list when the guard names no
 * API of its own. The walk stops at
 * the nearest function boundary, so a guard never leaks across a function definition
 * (a deliberately conservative, coarse signal).
 * @param {BabelPath} rootPath
 * @returns {?string[][]}
 */
function guardOf(rootPath) {
  let p = rootPath;
  while (p) {
    const parent = p.parentPath;
    if (!parent || parent.isFunction()) {
      return null;
    }
    const node = parent.node;
    // An optional CALL on this chain (`messenger.foo.bar?.()`) short-circuits to
    // undefined when the member is missing - a guard, like optional chaining on
    // the member path (which climbChain already flags as `optional`).
    if (node.type === "OptionalCallExpression" && p.key === "callee") {
      return [];
    }
    if (node.type === "UnaryExpression" && node.operator === "typeof") {
      return [];
    }
    if (
      GUARD_TEST_TYPES.has(node.type) &&
      guardApiRefs(node.test, rootPath.scope).length
    ) {
      // A test names what must be PRESENT to reach here, so it offers this access
      // no alternative of its own.
      return [];
    }
    // A guard that already ran: an earlier sibling bailed out unless the API was
    // there. The walk reaches every statement between the access and the function
    // boundary, so a guard clause is found however deep the access sits under it and
    // however far below it stands.
    if (precededByGuardClause(p, rootPath.scope)) {
      // Like a test, it names what must be PRESENT to arrive here - no alternative.
      return [];
    }
    // Every logical operator short-circuits, so each one can hold a fallback: `??`
    // takes the right side when the left is nullish, which is what a missing API
    // reads as, and is the form feature detection most often takes.
    if (node.type === "LogicalExpression") {
      if (!guardApiRefs(node, rootPath.scope).length) {
        p = parent;
        continue;
      }
      // The other operand stands as this access's alternative - the two are the
      // arms of one choice, which is what makes a live sibling vouch for a missing
      // namespace. Only for a plain READ of the namespace: reaching through a
      // missing one (`browser.gone.f()`) throws rather than falling back, so it is
      // no alternative to anything.
      const plainRead =
        p.node.type === "Identifier" || p.node.type === "MemberExpression";
      return plainRead
        ? guardApiRefs(
            p.key === "left" ? node.right : node.left,
            rootPath.scope
          )
        : [];
    }
    p = parent;
  }
  return null;
}
