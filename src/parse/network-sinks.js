// Finds outbound network sinks in add-on JavaScript - the data-going-out
// counterpart to remote-js.js (which finds code coming in). Two channels:
// "overt" transmission APIs (fetch, XMLHttpRequest, WebSocket, EventSource,
// navigator.sendBeacon) that legitimately send data, and "covert" resource
// loads (assigning a URL to an element .src/.href, a style url(), window.open,
// location.assign/replace) that can smuggle data inside the URL - a channel
// that does not look like data transmission.
//
// Belongs here: locating each sink, classifying its destination (remote/local/
// dynamic/embedded), recording its scheme (cleartext vs encrypted), host and the
// destination expression as written, and flagging whether data is appended to the
// URL or a user-data API call sits in the argument.
//
// Does NOT belong here: the verdict and wording (-> src/checks/rules/
// disguised-*.js, cleartext-transmission.js, privacy-policy.js,
// data-exfiltration.js, assets/registry.yaml), the once-per-artifact aggregation
// (-> src/lib/outbound-sinks.js), URL classification (-> src/scan/url.js)
// and Babel access (-> src/parse/ast.js). Not yet covered: document.write, the
// anchor ping attribute.

import {
  parseJs,
  traverse,
  nodeLoc,
  memberPropName,
  isCallLike,
  isMemberLike,
  srcText,
  staticValues,
} from "./ast.js";
import {
  classifyUrl,
  isLoopback,
  prefixHost,
  worstUrlClass,
  writtenScheme,
} from "../scan/url.js";
import { declarationUrls, openUrlArg, urlsIn } from "../scan/css.js";
import { URL_CLASS, OVERTNESS } from "../lib/enum.js";
import { apiBasesOf } from "./api-base.js";
import { localUrlArgs, localUrlVarsOf } from "./local-url.js";
import { DATA_APIS } from "./webext-facts.js";

/** @typedef {import("@babel/types").Node} AstNode */

// Element properties whose assignment loads a URL (a covert channel), and the
// style properties that can carry a url() pointing at a remote host.
const URL_PROPS = new Set(["src", "href"]);
const STYLE_URL_PROPS = new Set(["backgroundImage", "background", "cssText"]);

// How a sink's value is read: as a URL, as a CSS value whose url() arguments
// are the destinations, or as a CSS declaration list (style.cssText).
const READ_AS = Object.freeze({
  URL: "url",
  CSS_VALUE: "css-value",
  CSS_DECLARATIONS: "css-declarations",
});

// Non-TLS remote schemes - data sent to one of these travels unencrypted.
const CLEARTEXT_PROTOCOLS = ["http:", "ws:", "ftp:"];

// XMLHttpRequest.open(method, url, ...) leads with an HTTP method, which is how
// it is told apart from window.open(url, ...).
const HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
]);

/**
 * @typedef {object} SinkHit
 * @property {string} type  Which sink fired (see the visitors below).
 * @property {import("../lib/enum.js").Overtness} channel  Overt = a transmission API; covert = a
 *   resource load that can disguise data as a URL.
 * @property {import("../lib/enum.js").UrlClass} destClass  Destination.
 * @property {boolean} cleartext  The destination scheme is non-TLS
 *   (http/ws/ftp).
 * @property {?string} host  The destination host, or null when local/dynamic.
 * @property {boolean} dataAppended  A remote URL built with a dynamic part
 *   (data put into the URL, the disguised-send pattern).
 * @property {boolean} carriesData  A user-data API call sits in the argument.
 * @property {?string} target  The destination expression AS WRITTEN, unresolved
 *   (`"https://x/a"`, `endpoint`, `base + "/c"`), or null where the sink names no
 *   destination (`fetch()`, `window.open()`). Developer-controlled text a report
 *   shows so a reviewer sees what is being sent to without opening the file - it
 *   is display material, never a key and never a match.
 * @property {number} line
 * @property {number} column
 */

/**
 * Scan JavaScript for outbound network sinks.
 * @param {string} code  JavaScript source text.
 * @param {number} [lineOffset]  Added to reported lines (for inline scripts).
 * @param {import("./ast.js").ParseResult} [parsed]  Reuse this parse of `code`
 *   instead of re-parsing it.
 * @returns {{hits: SinkHit[], parseError: string|null}}
 */
export function scanNetworkSinks(code, lineOffset = 0, parsed) {
  const { ast, parseError } = parsed ?? parseJs(code);
  if (parseError) {
    return { hits: [], parseError };
  }

  const hits = [];
  const bases = apiBasesOf(ast);
  const urlVars = localUrlVarsOf(ast);
  /** @param {AstNode} node @returns {{line:number, column:number}} */
  const at = (node) => nodeLoc(node, lineOffset);

  /**
   * @param {string} type
   * @param {import("../lib/enum.js").Overtness} channel
   * @param {?AstNode} urlNode  The destination-URL argument.
   * @param {AstNode[]} dataNodes  Other arguments that may hold the payload.
   * @param {AstNode} site  The node to report the location of.
   * @param {string} [readAs]  How the value is read, a READ_AS member.
   */
  const push = (type, channel, urlNode, dataNodes, site, readAs) => {
    const { destClass, dataAppended, cleartext, host } = urlInfo(
      urlNode,
      bases,
      urlVars,
      readAs ?? READ_AS.URL
    );
    hits.push({
      type,
      channel,
      destClass,
      cleartext,
      host,
      dataAppended,
      carriesData: [urlNode, ...dataNodes].some((n) => carriesData(n, bases)),
      // Every channel reaches its destination through this one parameter, so the
      // text is taken here once rather than at each of the call sites.
      target: srcText(urlNode, code),
      ...at(site),
    });
  };

  // Pass 1: identifiers bound to document.createElement("form"). A dynamically
  // built form that is submitted is an overt transmission whose destination is
  // the form's `action` (the fields go to the action URL) - the form.submit()
  // exfiltration channel, which does not look like fetch/XHR.
  const formVars = new Set();
  // Identifiers bound to `new XMLHttpRequest()`: an `.open(method, url)` on one is an
  // XHR even when the method is a variable (xhr.open(opts.method, url)), where the
  // literal-method test below cannot tell it from window.open and would drop the URL.
  const xhrVars = new Set();
  traverse(ast, {
    "VariableDeclarator|AssignmentExpression"(path) {
      const id = path.isVariableDeclarator() ? path.node.id : path.node.left;
      const init = path.isVariableDeclarator()
        ? path.node.init
        : path.node.right;
      if (id?.type !== "Identifier") {
        return;
      }
      if (isCreateElementForm(init)) {
        formVars.add(id.name);
      } else if (isXhrConstruct(init)) {
        xhrVars.add(id.name);
      }
    },
  });
  // The `action` recorded per tracked form (name -> URL node), filled as the main
  // pass sees `form.action = …` / `form.setAttribute("action", …)` before the
  // `form.submit()` that reads it (create -> set action -> submit source order).
  const formActions = new Map();
  const isFormVar = (node) =>
    node?.type === "Identifier" && formVars.has(node.name);
  const isXhrVar = (node) =>
    node?.type === "Identifier" && xhrVars.has(node.name);

  traverse(ast, {
    "CallExpression|OptionalCallExpression"(path) {
      const { callee, arguments: args } = path.node;
      if (calleeName(callee) === "fetch") {
        push("fetch", OVERTNESS.OVERT, args[0], args.slice(1), path.node);
        return;
      }
      const prop = memberPropName(callee);
      if (prop === "sendBeacon") {
        push("beacon", OVERTNESS.OVERT, args[0], args.slice(1), path.node);
      } else if (prop === "open") {
        // XHR.open(method, url): a literal HTTP method OR a tracked XMLHttpRequest
        // receiver marks it as an XHR (url = args[1]); otherwise it is window.open,
        // whose sole argument is the URL.
        if (isXhrVar(callee.object) || isHttpMethodLiteral(args[0])) {
          push("xhr", OVERTNESS.OVERT, args[1], [], path.node);
        } else {
          push("window-open", OVERTNESS.COVERT, args[0], [], path.node);
        }
      } else if (
        (prop === "assign" || prop === "replace") &&
        isLocation(callee.object)
      ) {
        push("navigation", OVERTNESS.COVERT, args[0], [], path.node);
      } else if (prop === "setAttribute" && isUrlAttr(args[0])) {
        push("set-attribute", OVERTNESS.COVERT, args[1], [], path.node);
      } else if (
        prop === "setAttribute" &&
        isActionAttr(args[0]) &&
        isFormVar(callee.object)
      ) {
        formActions.set(callee.object.name, args[1]); // record the form action
      } else if (
        (prop === "submit" || prop === "requestSubmit") &&
        isFormVar(callee.object)
      ) {
        // form.submit() sends the form's fields to its action URL (a POST/GET
        // that bypasses fetch/XHR). Destination = the recorded action.
        push(
          "form-submit",
          OVERTNESS.OVERT,
          formActions.get(callee.object.name),
          [],
          path.node
        );
      }
    },
    NewExpression(path) {
      const name = calleeName(path.node.callee);
      const url = path.node.arguments[0];
      if (name === "WebSocket") {
        push("websocket", OVERTNESS.OVERT, url, [], path.node);
      } else if (name === "EventSource") {
        push("eventsource", OVERTNESS.OVERT, url, [], path.node);
      }
    },
    AssignmentExpression(path) {
      const { left, right } = path.node;
      const prop = memberPropName(left);
      if (URL_PROPS.has(prop)) {
        // location.href = ... is a page navigation (like location.assign), not a
        // resource load into an element (img/script/link .src/.href) - route it to
        // the navigation channel so disguised-navigation, not disguised-resource,
        // is the consumer.
        const type =
          prop === "href" && isLocation(left.object)
            ? "navigation"
            : "element-src";
        push(type, OVERTNESS.COVERT, right, [], path.node);
      } else if (STYLE_URL_PROPS.has(prop)) {
        const readAs =
          prop === "cssText" ? READ_AS.CSS_DECLARATIONS : READ_AS.CSS_VALUE;
        push("style-url", OVERTNESS.COVERT, right, [], path.node, readAs);
      } else if (prop === "action" && isFormVar(left.object)) {
        formActions.set(left.object.name, right); // record the form action
      }
    },
  });
  return { hits, parseError: null };
}

/**
 * The called name: a bare `fetch(...)` identifier, or the property of a member
 * call like `window.fetch`/`navigator.sendBeacon`.
 * @param {AstNode} callee
 * @returns {string|null}
 */
function calleeName(callee) {
  if (callee?.type === "Identifier") {
    return callee.name;
  }
  return memberPropName(callee);
}

/**
 * True for the `location`/`window.location`/`document.location` object, so a
 * `.assign`/`.replace` is a navigation and not, say, `Object.assign`.
 * @param {AstNode} obj
 * @returns {boolean}
 */
function isLocation(obj) {
  return (
    (obj?.type === "Identifier" && obj.name === "location") ||
    memberPropName(obj) === "location"
  );
}

/**
 * True for a `setAttribute("src"|"href", ...)` URL attribute (first argument).
 * @param {AstNode} node
 * @returns {boolean}
 */
function isUrlAttr(node) {
  return node?.type === "StringLiteral" && URL_PROPS.has(node.value);
}

/**
 * True for a `setAttribute("action", …)` form-action attribute (first argument).
 * @param {AstNode} node
 * @returns {boolean}
 */
function isActionAttr(node) {
  return (
    node?.type === "StringLiteral" && node.value.toLowerCase() === "action"
  );
}

/**
 * True for `document.createElement("form")` (case-insensitive) - the start of a
 * dynamically built form whose later `.submit()` transmits its fields.
 * @param {AstNode} node
 * @returns {boolean}
 */
function isCreateElementForm(node) {
  return (
    isCallLike(node) &&
    memberPropName(node.callee) === "createElement" &&
    node.arguments[0]?.type === "StringLiteral" &&
    node.arguments[0].value.toLowerCase() === "form"
  );
}

/**
 * True for `new XMLHttpRequest()`. Lets a later `.open(method, url)` on the bound
 * identifier be read as an XHR even when the method argument is dynamic (where the
 * literal-method test alone cannot tell it from window.open).
 * @param {AstNode} node
 * @returns {boolean}
 */
function isXhrConstruct(node) {
  return (
    node?.type === "NewExpression" &&
    calleeName(node.callee) === "XMLHttpRequest"
  );
}

/**
 * True for a string literal naming an HTTP method (XHR.open's first argument).
 * @param {AstNode} node
 * @returns {boolean}
 */
function isHttpMethodLiteral(node) {
  return (
    node?.type === "StringLiteral" && HTTP_METHODS.has(node.value.toUpperCase())
  );
}

/**
 * Classify a URL-valued expression: its destination, its scheme (cleartext or
 * not) and host, and whether it is a remote URL built with a dynamic part (data
 * appended to the URL). Cleartext/host are read from the static value, or from
 * the leading static prefix of a dynamic URL (which still carries the scheme).
 * @param {?AstNode} node
 * @param {Map<object, object>} bases  The AST's alias index from apiBasesOf.
 * @param {Map<AstNode, string[]>} urlVars  The AST's local-URL variable index
 *   from localUrlVarsOf.
 * @param {string} readAs  How the value is read, a READ_AS member.
 * @returns {{destClass: import("../lib/enum.js").UrlClass,
 *   cleartext: boolean, host: ?string, dataAppended: boolean}}
 */
function urlInfo(node, bases, urlVars, readAs) {
  if (!node) {
    return {
      destClass: URL_CLASS.LOCAL,
      cleartext: false,
      host: null,
      dataAppended: false,
    };
  }
  // fetch(getURL(<path>)) / img.src = getURL(<path>): getURL resolves its argument
  // against the extension base, so classify the argument - a relative path is a
  // local resource, an absolute one escapes the origin and keeps its remote class
  // (an exfil URL wrapped in getURL is not masked). A dynamic argument stays
  // unresolved and falls through to the conservative prefix branch below.
  const values =
    localUrlArgs(node, bases) ?? urlVars.get(node) ?? staticValues(node);
  if (values) {
    if (readAs === READ_AS.URL) {
      return worstStaticUrlInfo(values);
    }
    // Every url() argument of every value is a destination. A style value
    // without url() loads nothing.
    const read = readAs === READ_AS.CSS_DECLARATIONS ? declarationUrls : urlsIn;
    return worstStaticUrlInfo(values.flatMap(read)) ?? LOCAL_DEST;
  }
  const prefix = staticPrefix(node);
  return readAs === READ_AS.URL
    ? prefixUrlInfo(prefix)
    : stylePrefixUrlInfo(prefix);
}

/**
 * Classify the leading static text of a dynamic URL. The dynamic tail is data
 * appended to a remote destination.
 * @param {string} prefix
 * @returns {{destClass: import("../lib/enum.js").UrlClass,
 *   cleartext: boolean, host: ?string, dataAppended: boolean}}
 */
function prefixUrlInfo(prefix) {
  // The host is the prefix's only once its authority has ended: before that, the dynamic
  // tail can still extend it or move it (prefixHost). So an open authority is never
  // loopback, and names no host.
  const fixed = prefixHost(prefix);
  const destClass = prefix ? classifyUrl(prefix) : URL_CLASS.DYNAMIC;
  if (destClass.remote && isLoopback(fixed?.hostname)) {
    return LOCAL_DEST; // a loopback host the tail can no longer move
  }
  return {
    destClass,
    cleartext: isCleartext(prefix, parsedUrl(prefix)),
    host: fixed?.host || null,
    dataAppended: destClass.remote,
  };
}

/**
 * Classify the leading static text of a dynamic style value. Its closed url()
 * arguments are whole destinations. When it ends inside an unclosed url(), the
 * dynamic tail continues that argument, which is then a URL prefix. Otherwise
 * the tail stands outside any url() and may add one, so it is dynamic.
 * @param {string} prefix
 * @returns {{destClass: import("../lib/enum.js").UrlClass,
 *   cleartext: boolean, host: ?string, dataAppended: boolean}}
 */
function stylePrefixUrlInfo(prefix) {
  const urls = urlsIn(prefix);
  const open = openUrlArg(prefix);
  if (open) {
    urls.pop(); // the last argument is the open one, read as a prefix below
  }
  const tail = open == null ? DYNAMIC_DEST : prefixUrlInfo(open);
  return gravestInfo([...urls.map(staticUrlInfo), tail]);
}

/**
 * Classify a fully-known static URL string (a literal destination, or a getURL
 * argument resolved against the extension base). Loopback resolves to local.
 * @param {string} url
 * @returns {{destClass: import("../lib/enum.js").UrlClass,
 *   cleartext: boolean, host: ?string, dataAppended: boolean}}
 */
function staticUrlInfo(url) {
  const parsed = parsedUrl(url);
  const host = parsed?.host || null;
  const destClass = classifyUrl(url);
  if (destClass.remote && isLoopback(parsed?.hostname)) {
    return LOCAL_DEST; // loopback never leaves the machine - not a transmission
  }
  return {
    destClass,
    cleartext: isCleartext(url, parsed),
    host,
    dataAppended: false,
  };
}

/**
 * Classify every value a destination expression can take and report the gravest
 * one. Each value is classified in full BEFORE they are compared, because the
 * loopback downgrade and the cleartext/host reads are per-value: in
 * `c ? "http://127.0.0.1/x" : "https://evil/y"` the first arm is genuinely local
 * while the second decides the sink, and reporting the host of the wrong arm
 * would name an innocent destination.
 * @param {string[]} urls  The candidate values.
 * @returns {{destClass: import("../lib/enum.js").UrlClass,
 *   cleartext: boolean, host: ?string, dataAppended: boolean}|undefined}
 *   undefined when there is no value.
 */
function worstStaticUrlInfo(urls) {
  return gravestInfo(urls.map(staticUrlInfo));
}

/**
 * The gravest of several classified destinations, or undefined for none.
 * @param {{destClass: import("../lib/enum.js").UrlClass,
 *   cleartext: boolean, host: ?string, dataAppended: boolean}[]} infos
 * @returns {{destClass: import("../lib/enum.js").UrlClass,
 *   cleartext: boolean, host: ?string, dataAppended: boolean}|undefined}
 */
function gravestInfo(infos) {
  const worst = worstUrlClass(infos.map((info) => info.destClass));
  const gravest = infos.filter((info) => info.destClass === worst);
  // Among equally grave destinations a cleartext one is the graver still, and
  // it is the one whose host the report should name: `c ? "https://h/x" :
  // "http://h/x"` does send in the clear on one of its paths.
  return gravest.find((info) => info.cleartext) ?? gravest[0];
}

// A local (non-network) destination: no cleartext/privacy/exfil concern. The
// answer for a resolved loopback destination and for a style value that loads
// nothing.
const LOCAL_DEST = {
  destClass: URL_CLASS.LOCAL,
  cleartext: false,
  host: null,
  dataAppended: false,
};

// A destination that cannot be pinned down: the dynamic tail of a style value
// that stands outside any url().
const DYNAMIC_DEST = {
  destClass: URL_CLASS.DYNAMIC,
  cleartext: false,
  host: null,
  dataAppended: false,
};

/**
 * The URL a value names, read the way a browser reads it (WHATWG URL), or null when it
 * is not an absolute URL: a relative path, a bare fragment, a dynamic prefix that stops
 * before the host. Its `host` is where the request goes - a hand-rolled reader of the
 * authority disagrees with the browser on inputs like `http://evil\@127.0.0.1/`.
 * @param {string} s
 * @returns {?URL}
 */
function parsedUrl(s) {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/**
 * True when a destination is sent over a non-TLS scheme. A parsed URL answers by its
 * protocol. A value that does not parse (the prefix `"http://"` of `"http://" + host`)
 * answers by its scheme as written.
 * @param {string} s  The destination text.
 * @param {?URL} parsed  Its parsedUrl.
 * @returns {boolean}
 */
function isCleartext(s, parsed) {
  return CLEARTEXT_PROTOCOLS.includes(parsed?.protocol ?? writtenScheme(s));
}

/**
 * The leading static string of a dynamic concatenation/template - the literal
 * prefix before the first dynamic piece (e.g. "https://x/?d=" of
 * `"https://x/?d=" + v`).
 * @param {AstNode} node
 * @returns {string}
 */
function staticPrefix(node) {
  switch (node?.type) {
    case "StringLiteral":
      return node.value;
    case "TemplateLiteral":
      return node.quasis[0]?.value.cooked ?? "";
    case "BinaryExpression": {
      if (node.operator !== "+") {
        return "";
      }
      // A side that has exactly one value contributes ALL of it and the scan
      // carries on rightwards, so a scheme spelled across several pieces
      // ("htt" + "ps://host/x" + tail, "/" + "/host/x" + tail) is read whole
      // instead of being cut off at the first piece and passing for a relative
      // path. A side with several possible values shares no single prefix, so
      // the scan stops within it.
      const left = staticValues(node.left);
      return left?.length === 1
        ? left[0] + staticPrefix(node.right)
        : staticPrefix(node.left);
    }
    default:
      return "";
  }
}

/**
 * True if a `<root>.<dataApi>...` member call sits anywhere in the node subtree
 * (e.g. `messenger.messages.getFull(id)` in a fetch body), evidence the payload
 * carries user data. The chain base is looked up by node identity in the AST's
 * api-base index - the walk itself is scope-less, but the index was built with
 * scope, so aliases (`api.messages.getFull(id)`) and captured namespaces
 * (`const m = messenger.messages; m.getFull(id)`, where the data API is the
 * capture's prefix) resolve, as does a root named on the global object, and a
 * shadowed local named like a root does not.
 * @param {?AstNode} node
 * @param {Map<AstNode, import("./api-base.js").AliasTarget>} bases
 * @returns {boolean}
 */
function carriesData(node, bases) {
  let found = false;
  walk(node, (n) => {
    if (found || !isMemberLike(n)) {
      return;
    }
    const target = bases.get(n.object) ?? null;
    if (!target) {
      return;
    }
    const ns =
      target.prefix[0] ??
      (!n.computed && n.property?.type === "Identifier"
        ? n.property.name
        : null);
    if (ns && DATA_APIS.has(ns)) {
      found = true;
    }
  });
  return found;
}

/**
 * Visit every AST node in a subtree (a lightweight descent that needs no Babel
 * scope, for checking an argument expression).
 * @param {unknown} node
 * @param {(n: AstNode) => void} visit
 */
function walk(node, visit) {
  if (!node || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  if (typeof node.type === "string") {
    visit(node);
  }
  for (const key of Object.keys(node)) {
    if (key !== "loc" && key !== "start" && key !== "end") {
      walk(node[key], visit);
    }
  }
}
