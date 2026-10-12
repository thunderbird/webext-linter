// Classifies a URL/reference string found in HTML/CSS/JS so a check can decide
// whether a referenced source is bundled (local) or fetched from the network
// (remote).
//
// Belongs here: pure remote/embedded/local classification of a URL or reference
// string by its scheme/shape, and the ranking of those classes by exposure -
// the one place that decides which of two destinations is the graver one.
// Shared by every scanner that finds URLs.
//
// Does NOT belong here: finding the URLs in the first place - that is the
// per-format scanners (src/scan/css.js, src/scan/html.js, src/scan/csp.js).
// Deciding whether a remote reference is a violation lives in the checks
// (src/checks/rules/*) and the registry (assets/registry.yaml).

import { URL_CLASS } from "../lib/enum.js";

// The base a reference is resolved against: the add-on's own origin, so a relative
// path, "/x" or "#x" names a packaged resource.
const SELF_BASE = "moz-extension://ext/";
const SELF_HOST = "ext";
// A web page base, for telling a protocol-relative "//host/x" from an explicit
// moz-extension: URL. Content scripts resolve "//host/x" against the web page, so
// it is a network load.
const WEB_BASE = "https://page.invalid/";

const REMOTE_PROTOCOLS = new Set([
  "http:",
  "https:",
  "ftp:",
  "ftps:",
  "ws:",
  "wss:",
]);
const EMBEDDED_PROTOCOLS = new Set(["data:", "blob:"]);

/**
 * The class of a URL scheme: a network scheme is REMOTE, data: and blob: are
 * EMBEDDED, every other scheme (moz-extension:, chrome:, resource:, javascript:,
 * ...) is LOCAL.
 * @param {string} protocol  A scheme with its trailing colon, lowercase ("http:").
 * @returns {import("../lib/enum.js").UrlClass}
 */
function classifyScheme(protocol) {
  if (REMOTE_PROTOCOLS.has(protocol)) {
    return URL_CLASS.REMOTE;
  }
  if (EMBEDDED_PROTOCOLS.has(protocol)) {
    return URL_CLASS.EMBEDDED;
  }
  return URL_CLASS.LOCAL;
}

/**
 * The scheme a text starts with, read the way the URL parser reads it (tab, LF
 * and CR removed, leading C0 controls and spaces trimmed, lowercased), or null
 * when it starts with none. For text the URL parser rejects, such as the prefix
 * "http://" of a concatenation, whose scheme is still plain to read.
 * @param {string} text
 * @returns {?string}  The scheme with its trailing colon ("http:").
 */
export function writtenScheme(text) {
  let clean = "";
  for (const c of String(text ?? "")) {
    if (c !== "\t" && c !== "\n" && c !== "\r") {
      clean += c;
    }
  }
  let start = 0;
  while (start < clean.length && clean.charCodeAt(start) <= 0x20) {
    start++;
  }
  const colon = clean.indexOf(":", start);
  if (colon <= start) {
    return null;
  }
  const scheme = clean.slice(start, colon).toLowerCase();
  const isAlpha = (c) => c >= "a" && c <= "z";
  const isSchemeChar = (c) =>
    isAlpha(c) || (c >= "0" && c <= "9") || c === "+" || c === "-" || c === ".";
  return isAlpha(scheme[0]) && [...scheme].every(isSchemeChar)
    ? `${scheme}:`
    : null;
}

/**
 * The URL a reference names, read the way the browser reads it (WHATWG URL)
 * against `base`, or null when it does not parse. The parser does the trimming
 * (leading/trailing C0 controls and spaces, tab/LF/CR anywhere) and accepts the
 * forms a browser accepts (`https:/x`, `http:x`, `https:\x`).
 * @param {string} s
 * @param {string} base
 * @returns {?URL}
 */
function parseRef(s, base) {
  try {
    return new URL(s, base);
  } catch {
    return null;
  }
}

/**
 * @param {string} raw  URL or reference string to classify.
 * @returns {import("../lib/enum.js").UrlClass}
 *   - REMOTE:   network-loaded (http/https/ftp/ws, or protocol-relative
 *               "//host"), or a value that does not parse and names no other
 *               scheme as written (only a broken authority throws, so this fails
 *               closed)
 *   - EMBEDDED: inline payload (data:, blob:) - not bundled source, often
 *               obfuscation
 *   - LOCAL:    relative path, root-relative "/x", "#...", empty, and every
 *               other scheme (moz-extension:, chrome:, resource:, javascript:,
 *               about:, ...)
 */
export function classifyUrl(raw) {
  const text = String(raw ?? "");
  const url = parseRef(text, SELF_BASE);
  if (!url) {
    const scheme = writtenScheme(text);
    return scheme ? classifyScheme(scheme) : URL_CLASS.REMOTE;
  }
  if (url.protocol === "moz-extension:" && url.host !== SELF_HOST) {
    // Another host: an explicit moz-extension: URL keeps its scheme against a web
    // base, a protocol-relative "//host/x" takes the web page's.
    const onWeb = parseRef(text, WEB_BASE);
    return onWeb?.protocol === "moz-extension:"
      ? URL_CLASS.LOCAL
      : URL_CLASS.REMOTE;
  }
  return classifyScheme(url.protocol);
}

// The classes ordered by exposure, gravest first: a network destination outranks
// an inline payload, which outranks a destination we could not pin down, which
// outranks a packaged resource. DYNAMIC sits above LOCAL because an unknown
// destination is a reason to look, not a reason to relax.
const CLASS_BY_EXPOSURE = [
  URL_CLASS.REMOTE,
  URL_CLASS.EMBEDDED,
  URL_CLASS.DYNAMIC,
  URL_CLASS.LOCAL,
];

/**
 * The gravest of the classes an expression could resolve to - what a reference
 * with several possible values must be judged as, since any one of them is the
 * value it may take at runtime (see staticValues in src/parse/ast.js).
 * @param {import("../lib/enum.js").UrlClass[]} classes  The classes the expression
 *   could resolve to; may be empty.
 * @returns {import("../lib/enum.js").UrlClass}  LOCAL for an empty list.
 */
export function worstUrlClass(classes) {
  return (
    CLASS_BY_EXPOSURE.find((candidate) => classes.includes(candidate)) ??
    URL_CLASS.LOCAL
  );
}

/**
 * True when a URL host is a loopback address - traffic that never leaves the
 * machine (cannot be sniffed in transit and cannot hold a CA certificate), so the
 * "remote transmission" judgments (cleartext / privacy-policy) do not apply.
 * Matches `localhost` (and `*.localhost`), IPv4 127.0.0.0/8, 0.0.0.0, and IPv6
 * ::1 - true loopback only. Private LAN (RFC-1918) is deliberately NOT loopback:
 * that traffic does traverse a network.
 *
 * Used to downgrade a loopback outbound sink to "local" in
 * src/parse/network-sinks.js. classifyUrl itself is left scheme-only, so a
 * loopback <script src> still classifies remote for the remote-code checks (it is
 * still unbundled, unreviewable code).
 *
 * Takes the URL parser's `hostname`, which has already done the hard part: it is
 * lowercase, has no userinfo or port, writes IPv6 as `[::1]`, and spells every IPv4 form
 * (`127.1`, `0x7f.0.0.1`, `2130706433`) as four decimal parts.
 * @param {?string} hostname  A WHATWG URL's `hostname` (or null).
 * @returns {boolean}
 */
export function isLoopback(hostname) {
  if (!hostname) {
    return false;
  }
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    hostname === "0.0.0.0"
  ) {
    return true;
  }
  // 127.0.0.0/8. All four parts numeric, so a name like "127.example.com" is not one.
  const parts = hostname.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((p) => p !== "" && [...p].every((c) => c >= "0" && c <= "9"))
  );
}
