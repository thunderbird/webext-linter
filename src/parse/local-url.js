// The extension-URL seam: recognizing calls to runtime.getURL / extension.getURL
// and resolving what URL they denote. getURL mints a URL by resolving its argument
// against the extension's own moz-extension:// base (Firefox: `new URL(arg, base)`).
// So the RESULT is local only when the argument is a RELATIVE path - an absolute or
// protocol-relative argument escapes the origin (getURL("https://x") -> "https://x",
// getURL("//h/x") -> "moz-extension://h/x"). Treating every getURL call as local
// would let a remote/exfil URL hide behind getURL, so the resolution is
// argument-aware: a static relative argument is a local resource, a static absolute
// one keeps its real (remote/embedded) class, and a non-static argument stays
// unresolved.
//
// Two consumers, two needs:
//   - the URL classifiers (remote-js.js, network-sinks.js) need the resolved
//     argument so they classify the true destination -> localUrlArg.
//   - the file-loader extractor (loader-files.js) only asks "is this a getURL call
//     at all" (the getURL loader itself handles the argument), regardless of the
//     argument -> isLocalUrlMethodCall.
//
// Belongs here: the local-URL method seam (LOCAL_URL_METHODS is DATA, loaded from
// assets/webext-facts.yaml via webext-facts.js) and the alias-aware recognition /
// argument resolution over it. Does NOT belong here: API-root resolution (->
// src/parse/api-base.js, reused via calleeApiPath), static-string extraction (->
// src/parse/ast.js staticPathOf), URL classification (-> src/scan/url.js), or
// getURL->packaged-file resolution (-> the check/reachability layer).

import { isCallLike, isStatic, staticValue } from "./ast.js";
import { calleeApiPath } from "./api-base.js";
import { LOCAL_URL_METHODS } from "./webext-facts.js";

/**
 * True when `node` is a call to a local-URL-minting API method (runtime.getURL /
 * extension.getURL), resolved through the AST's alias index so a captured or
 * feature-detected root (`const rt = browser.runtime; rt.getURL(...)`) matches and
 * a shadowed local of the same name does not. Structural only - says nothing about
 * whether the RESULT is local (that depends on the argument; see localUrlArg).
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
 * The URL a local-URL method call resolves to, as a string a URL classifier can
 * judge, or null when `node` is not such a call or its argument is not FULLY
 * static. The argument value is returned verbatim (the classifier reads relative vs
 * absolute directly): a relative path classifies local, while an absolute or
 * protocol-relative argument classifies remote - so an exfil URL wrapped in getURL
 * is NOT masked. Only a fully-static argument is resolved; a partly-computed one
 * yields null so the caller keeps its conservative "unresolved" handling (a
 * relative-looking prefix must not mask a scheme the dynamic tail could complete,
 * e.g. `getURL("htt" + x)`), matching how each funnel treats a bare dynamic ref.
 * @param {?import("./api-base.js").AstNode} node
 * @param {Map<object, object>} bases  The AST's alias index from apiBasesOf.
 * @returns {?string}
 */
export function localUrlArg(node, bases) {
  if (!isLocalUrlMethodCall(node, bases)) {
    return null;
  }
  const arg = node.arguments[0];
  return isStatic(arg) ? staticValue(arg) : null;
}
