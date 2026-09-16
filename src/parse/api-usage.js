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
// Belongs here: usage extraction - segments, line/column, dynamic-tail and alias
// limitations.
//
// Deliberately NOT here: whether a usage is feature-detected. The constructions that
// keep a call off the versions lacking an API are open-ended - a cached boolean, a
// version compared after an awaited getBrowserInfo, an early return in a helper, a
// try/catch fallback - and an enclosing `if` proves nothing on its own, since a
// condition on runtime data still runs for ordinary users. An AST shape therefore cannot
// settle the question in either direction, and the checks that ask it list their hits
// for a reader instead. Do not reintroduce the signal to serve one of them.
//
// `optional` stays, because it is a syntactic fact about the member chain rather than an
// inference about what the surrounding code means.
//
// Does NOT belong here: what denotes an API object - the API_ROOTS set, alias
// resolution, and the per-AST base index (-> src/parse/api-base.js). Deciding
// whether a usage needs a permission, is covered by the manifest, or is
// otherwise allowed - those verdicts live in the checks (src/checks/rules/* and
// src/lib/permissions.js). User-facing wording lives in
// assets/registry.yaml. Babel access goes through src/parse/ast.js.

import { parseJs, traverse, nodeLoc, isCallLike } from "./ast.js";
import { API_ROOTS, apiBasesOf } from "./api-base.js";

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
   * @param {import("./api-base.js").AliasTarget} target  What the base resolves to.
   */
  const recordUsage = (path, target) => {
    const climbed = climbChain(path);
    const segments = [...target.prefix, ...climbed.segments];
    const { dynamicTail, dynamicAt, optional } = climbed;
    usages.push({
      root: target.root,
      segments,
      dynamicTail,
      optional,
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
 * True when the identifier hands the API object to a binding this walker does not
 * follow, e.g. `const x = browser`, `const { messages } = browser`, or
 * `makeCollector(browser)`.
 *
 * The call-argument form matters as much as the declarator one and is the same event:
 * the root leaves for a parameter whose uses are resolved nowhere, so every check
 * reading the usage set is blind to whatever happens to it. Recording it is what lets
 * those checks know they are blind - permissions.js fails open on a limitation, so a
 * permission used only through such a parameter escalates instead of being called
 * unused. Left unrecorded, the two forms differ only in syntax and the scan believes
 * itself fully sighted.
 * @param {BabelPath} path
 * @returns {boolean}
 */
function isAliasOrigin(path) {
  const parent = path.parent;
  if (parent.type === "VariableDeclarator" && parent.init === path.node) {
    return !path.scope.hasBinding(path.node.name);
  }
  // Passed straight into a call: `makeCollector(browser)`, `new Wrapper(messenger)`. The
  // callee itself is not the subject - `browser.foo(x)` is a chain the walker already
  // resolves, and its identifier is not an argument.
  if (
    (isCallLike(parent) || parent.type === "NewExpression") &&
    parent.arguments?.includes(path.node)
  ) {
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
 * From a chain base - an identifier, or the member expression that names a root on the
 * global object - walk up the chain of member expressions collecting property names. Stops at the first computed/non-literal access (marked as a
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
