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

const REMOTE_RE = /^(?:https?:|ftps?:|wss?:)\/\//i;
const PROTOCOL_RELATIVE_RE = /^\/\//; // "//host/x" - inherits page scheme, i.e. remote
const EMBEDDED_RE = /^(?:data|blob):/i;

/**
 * @param {string} raw  URL or reference string to classify.
 * @returns {import("../lib/enum.js").UrlClass}
 *   - REMOTE:   network-loaded (http/https/ftp/ws, or protocol-relative
 *               "//host")
 *   - EMBEDDED: inline payload (data:, blob:) - not bundled source, often
 *               obfuscation
 *   - LOCAL:    relative path, root-relative "/x",
 *               moz-extension:/chrome:/resource:, "#...", or empty
 */
export function classifyUrl(raw) {
  const url = String(raw ?? "").trim();
  if (url === "") {
    return URL_CLASS.LOCAL;
  }
  if (EMBEDDED_RE.test(url)) {
    return URL_CLASS.EMBEDDED;
  }
  if (REMOTE_RE.test(url) || PROTOCOL_RELATIVE_RE.test(url)) {
    return URL_CLASS.REMOTE;
  }
  return URL_CLASS.LOCAL;
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
