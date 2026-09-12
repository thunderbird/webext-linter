// The extension-URL seam: recognizing calls to runtime.getURL / extension.getURL
// and resolving what URL they denote. getURL mints a URL by resolving its argument
// against the extension's own moz-extension:// base (Firefox: `new URL(arg, base)`).
// So the RESULT is local only when the argument is a RELATIVE path - an absolute or
// protocol-relative argument escapes the origin (getURL("https://x") -> "https://x",
// getURL("//h/x") -> "moz-extension://h/x"). Treating every getURL call as local
// would let a remote/exfil URL hide behind getURL, so the resolution is
// argument-aware: a static relative argument is a local resource, a static absolute
// one keeps its real (remote/embedded) class, and a non-static argument stays
// unresolved. An argument that can take several values (a ternary) resolves to all
// of them, so a caller weighs the whole set - one arm is not the answer.
//
// The consumers and their needs:
//   - the URL classifiers (remote-js.js, network-sinks.js) need the resolved
//     argument so they classify the true destination -> localUrlArgs.
//   - the file-loader extractor (loader-files.js) only asks "is this a getURL call
//     at all" (the getURL loader itself handles the argument), regardless of the
//     argument -> isLocalUrlMethodCall.
//   - the URL classifiers additionally resolve the one-step variable indirection
//     (`const url = getURL("a.json"); fetch(url)`) -> localUrlVarsOf.
//
// Belongs here: the local-URL method seam (LOCAL_URL_METHODS is DATA, loaded from
// assets/webext-facts.yaml via webext-facts.js) and the alias-aware recognition /
// argument resolution over it. Does NOT belong here: API-root resolution (->
// src/parse/api-base.js, reused via calleeApiPath), static-string extraction (->
// src/parse/ast.js staticPathOf), URL classification (-> src/scan/url.js), or
// getURL->packaged-file resolution (-> the check/reachability layer).

import { isCallLike, staticValues, traverse } from "./ast.js";
import { apiBasesOf, calleeApiPath } from "./api-base.js";
import { LOCAL_URL_METHODS } from "./webext-facts.js";

// ast File node -> Map<Identifier node, string[]>. WeakMap so an index never
// outlives its AST (the apiBasesOf pattern).
const varIndexes = new WeakMap();

// Shared result for a null AST (parse failure), so callers need no guard.
const EMPTY = new Map();

/**
 * True when `node` is a call to a local-URL-minting API method (runtime.getURL /
 * extension.getURL), resolved through the AST's alias index so a captured or
 * feature-detected root (`const rt = browser.runtime; rt.getURL(...)`) matches and
 * a shadowed local of the same name does not. Structural only - says nothing about
 * whether the RESULT is local (that depends on the argument; see localUrlArgs).
 * @param {?import("./api-base.js").AstNode} node
 * @param {Map<object, object>} bases  The AST's alias index from apiBasesOf.
 * @returns {boolean}
 */
export function isLocalUrlMethodCall(node, bases) {
  if (!isCallLike(node)) {
    return false;
  }
  const p = calleeApiPath(node.callee, bases);
  return p != null && LOCAL_URL_METHODS.has(p.segments.join("."));
}

/**
 * EVERY URL a local-URL method call can resolve to, as strings a URL classifier
 * can judge, or null when `node` is not such a call or its argument is not FULLY
 * static. Argument values are returned verbatim (the classifier reads relative vs
 * absolute directly): a relative path classifies local, while an absolute or
 * protocol-relative argument classifies remote - so an exfil URL wrapped in getURL
 * is NOT masked. An argument that can take several values (a ternary) yields all
 * of them, so a caller judges the whole set rather than one arm; which value
 * governs is the caller's call, since ranking destinations is classification.
 * Only a fully-static argument is resolved; a partly-computed one yields null so
 * the caller keeps its conservative "unresolved" handling (a relative-looking
 * prefix must not mask a scheme the dynamic tail could complete, e.g.
 * `getURL("htt" + x)`), matching how each funnel treats a bare dynamic ref.
 * @param {?import("./api-base.js").AstNode} node
 * @param {Map<object, object>} bases  The AST's alias index from apiBasesOf.
 * @returns {?string[]}
 */
export function localUrlArgs(node, bases) {
  return isLocalUrlMethodCall(node, bases)
    ? staticValues(node.arguments[0])
    : null;
}

/**
 * The AST's local-URL variable index: every referenced identifier whose binding
 * is a never-reassigned `const/let/var url = <local-URL method call>` with a
 * fully static argument, mapped to every URL that argument resolves to. Covers
 * the one-step indirection `const url = runtime.getURL("a.json"); fetch(url)`
 * that a per-node classifier cannot see. Scope-resolved (a shadowing local does
 * not leak an outer binding's URL) and reassignment-safe (any constant violation
 * disqualifies the binding, so a later `url = remote` cannot hide behind the
 * getURL init). Built lazily by one traverse and cached per AST, keyed by node
 * identity like apiBasesOf. The alias index it resolves through is taken from
 * apiBasesOf directly (itself cached per AST), so the two indexes are always
 * built over the same AST and cannot disagree.
 * @param {?import("./api-base.js").AstNode} ast  The parsed File node, or null.
 * @returns {Map<import("./api-base.js").AstNode, string[]>}
 */
export function localUrlVarsOf(ast) {
  if (!ast) {
    return EMPTY;
  }
  let index = varIndexes.get(ast);
  if (!index) {
    const bases = apiBasesOf(ast);
    index = new Map();
    traverse(ast, {
      Identifier(path) {
        if (!path.isReferencedIdentifier()) {
          return;
        }
        const binding = path.scope.getBinding(path.node.name);
        if (
          !binding ||
          binding.constantViolations.length > 0 ||
          binding.path?.type !== "VariableDeclarator"
        ) {
          return;
        }
        const urls = localUrlArgs(binding.path.node.init, bases);
        if (urls) {
          index.set(path.node, urls);
        }
      },
    });
    varIndexes.set(ast, index);
  }
  return index;
}
