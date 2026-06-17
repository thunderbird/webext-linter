// Finds outbound network sinks in add-on JavaScript - the data-going-out
// counterpart to remote-js.js (which finds code coming in). Two channels:
// "overt" transmission APIs (fetch, XMLHttpRequest, WebSocket, EventSource,
// navigator.sendBeacon) that legitimately send data, and "covert" resource
// loads (assigning a URL to an element .src/.href, a style url(), window.open,
// location.assign/replace) that can smuggle data inside the URL - a channel
// that does not look like data transmission.
//
// Belongs here: locating each sink, classifying its destination (remote/local/
// dynamic/embedded), recording its scheme (cleartext vs encrypted) and host, and
// flagging whether data is appended to the URL or a user-data API call sits in
// the argument. The static-vs-dynamic value test mirrors unsafe-html.js.
//
// Does NOT belong here: the verdict and wording (-> src/checks/rules/
// disguised-*.js, cleartext-transmission.js, privacy-policy.js,
// data-exfiltration.js, assets/registry.yaml),
// the once-per-run aggregation (-> src/checks/lib/outbound-sinks.js), URL
// classification (-> src/scan/url.js), and Babel access (-> src/parse/ast.js).
// Not yet covered: <form> action submits, document.write, the anchor ping
// attribute.

import { parseJs, traverse, nodeLoc } from "./ast.js";
import { classifyUrl } from "../scan/url.js";
import { API_ROOTS } from "./api-usage.js";

/** @typedef {import("@babel/types").Node} AstNode */

// Element properties whose assignment loads a URL (a covert channel), and the
// style properties that can carry a url() pointing at a remote host.
const URL_PROPS = new Set(["src", "href"]);
const STYLE_URL_PROPS = new Set(["backgroundImage", "background", "cssText"]);

// Non-TLS remote schemes - data sent to one of these travels unencrypted.
const CLEARTEXT_RE = /^(?:http|ws|ftp):\/\//i;
// The host (authority) of an absolute scheme://host URL.
const URL_HOST_RE = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i;

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

// WebExtension namespaces holding user data: a call to one inside a sink's
// argument is direct evidence the payload carries user data.
const DATA_APIS = new Set([
  "messages",
  "messageDisplay",
  "compose",
  "contacts",
  "addressBooks",
  "accounts",
  "identities",
  "folders",
  "mailTabs",
]);

/**
 * @typedef {object} SinkHit
 * @property {string} type  Which sink fired (see the visitors below).
 * @property {"overt"|"covert"} channel  Overt = a transmission API; covert = a
 *   resource load that can disguise data as a URL.
 * @property {"remote"|"embedded"|"local"|"dynamic"} destClass  Destination.
 * @property {boolean} cleartext  The destination scheme is non-TLS (http/ws/ftp).
 * @property {?string} host  The destination host, or null when local/dynamic.
 * @property {boolean} dataAppended  A remote URL built with a dynamic part
 *   (data put into the URL, the disguised-send pattern).
 * @property {boolean} carriesData  A user-data API call sits in the argument.
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
  /** @param {AstNode} node @returns {{line:number, column:number}} */
  const at = (node) => nodeLoc(node, lineOffset);

  /**
   * @param {string} type
   * @param {"overt"|"covert"} channel
   * @param {?AstNode} urlNode  The destination-URL argument.
   * @param {AstNode[]} dataNodes  Other arguments that may hold the payload.
   * @param {AstNode} site  The node to report the location of.
   */
  const push = (type, channel, urlNode, dataNodes, site) => {
    const { destClass, dataAppended, cleartext, host } = urlInfo(urlNode);
    hits.push({
      type,
      channel,
      destClass,
      cleartext,
      host,
      dataAppended,
      carriesData: [urlNode, ...dataNodes].some(carriesData),
      ...at(site),
    });
  };

  traverse(ast, {
    CallExpression(path) {
      const { callee, arguments: args } = path.node;
      if (calleeName(callee) === "fetch") {
        push("fetch", "overt", args[0], args.slice(1), path.node);
        return;
      }
      const prop = memberPropName(callee);
      if (prop === "sendBeacon") {
        push("beacon", "overt", args[0], args.slice(1), path.node);
      } else if (prop === "open") {
        if (isHttpMethodLiteral(args[0])) {
          push("xhr", "overt", args[1], [], path.node); // XHR.open(method, url)
        } else {
          push("window-open", "covert", args[0], [], path.node);
        }
      } else if (
        (prop === "assign" || prop === "replace") &&
        isLocation(callee.object)
      ) {
        push("navigation", "covert", args[0], [], path.node);
      } else if (prop === "setAttribute" && isUrlAttr(args[0])) {
        push("set-attribute", "covert", args[1], [], path.node);
      }
    },
    NewExpression(path) {
      const name = calleeName(path.node.callee);
      const url = path.node.arguments[0];
      if (name === "WebSocket") {
        push("websocket", "overt", url, [], path.node);
      } else if (name === "EventSource") {
        push("eventsource", "overt", url, [], path.node);
      }
    },
    AssignmentExpression(path) {
      const { left, right } = path.node;
      const prop = memberPropName(left);
      if (URL_PROPS.has(prop)) {
        push("element-src", "covert", right, [], path.node);
      } else if (STYLE_URL_PROPS.has(prop)) {
        push("style-url", "covert", right, [], path.node);
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
 * The accessed property name of a member expression - dot access (`el.src`) and
 * string-literal bracket access (`el["src"]`, a common obfuscation) - else null.
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
 * @returns {{destClass: "remote"|"embedded"|"local"|"dynamic",
 *   cleartext: boolean, host: ?string, dataAppended: boolean}}
 */
function urlInfo(node) {
  if (!node) {
    return {
      destClass: "local",
      cleartext: false,
      host: null,
      dataAppended: false,
    };
  }
  if (isStatic(node)) {
    const url = bareUrl(staticValue(node));
    return {
      destClass: classifyUrl(url),
      cleartext: CLEARTEXT_RE.test(url),
      host: urlHost(url),
      dataAppended: false,
    };
  }
  const prefix = bareUrl(staticPrefix(node));
  const destClass = prefix ? classifyUrl(prefix) : "dynamic";
  return {
    destClass,
    cleartext: CLEARTEXT_RE.test(prefix),
    host: urlHost(prefix),
    dataAppended: destClass === "remote",
  };
}

/**
 * The host (authority) of an absolute scheme://host URL, or null when the value
 * has no scheme://host (a relative path, a bare fragment, a dynamic prefix that
 * stops before the host).
 * @param {string} s
 * @returns {?string}
 */
function urlHost(s) {
  const match = URL_HOST_RE.exec(s);
  return match ? match[1] : null;
}

/**
 * True if a value carries no dynamic content (a literal, an uninterpolated
 * template, a "+" concatenation of static parts, or a static ternary).
 * @param {AstNode} node
 * @returns {boolean}
 */
function isStatic(node) {
  if (!node) {
    return true;
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
        node.operator === "+" && isStatic(node.left) && isStatic(node.right)
      );
    case "ConditionalExpression":
      return isStatic(node.consequent) && isStatic(node.alternate);
    default:
      return false;
  }
}

/**
 * The concatenated string value of a fully-static expression.
 * @param {AstNode} node
 * @returns {string}
 */
function staticValue(node) {
  switch (node?.type) {
    case "StringLiteral":
      return node.value;
    case "NumericLiteral":
    case "BooleanLiteral":
      return String(node.value);
    case "TemplateLiteral":
      return node.quasis.map((q) => q.value.cooked ?? "").join("");
    case "BinaryExpression":
      return staticValue(node.left) + staticValue(node.right);
    case "ConditionalExpression":
      return staticValue(node.consequent);
    default:
      return "";
  }
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
    case "BinaryExpression":
      return node.operator === "+" ? staticPrefix(node.left) : "";
    default:
      return "";
  }
}

/**
 * The bare URL from a value that may be wrapped in `url("...")` (a CSS
 * background), with surrounding quotes stripped.
 * @param {string} s
 * @returns {string}
 */
function bareUrl(s) {
  const match = /url\(\s*['"]?([^'")]*)/i.exec(s);
  return (match ? match[1] : s).replace(/^['"]/, "").trim();
}

/**
 * True if a `<root>.<dataApi>...` member call sits anywhere in the node subtree
 * (e.g. `messenger.messages.getFull(id)` in a fetch body), evidence the payload
 * carries user data.
 * @param {?AstNode} node
 * @returns {boolean}
 */
function carriesData(node) {
  let found = false;
  walk(node, (n) => {
    if (
      !found &&
      n.type === "MemberExpression" &&
      n.object?.type === "Identifier" &&
      API_ROOTS.has(n.object.name) &&
      n.property?.type === "Identifier" &&
      DATA_APIS.has(n.property.name)
    ) {
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
