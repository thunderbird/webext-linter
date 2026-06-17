// Classifies a URL/reference string found in HTML/CSS/JS so the remote-code
// check can decide whether a referenced source is bundled (local) or fetched
// from the network (remote).
//
// Belongs here: pure remote/embedded/local classification of a URL or reference
// string by its scheme/shape. Shared by every scanner that finds URLs.
//
// Does NOT belong here: finding the URLs in the first place - that is the
// per-format scanners (src/scan/css.js, src/scan/html.js, src/scan/csp.js).
// Deciding whether a remote reference is a violation lives in the checks
// (src/checks/rules/*) and the registry (assets/registry.yaml).

const REMOTE_RE = /^(?:https?:|ftps?:|wss?:)\/\//i;
const PROTOCOL_RELATIVE_RE = /^\/\//; // "//host/x" - inherits page scheme, i.e. remote
const EMBEDDED_RE = /^(?:data|blob):/i;

/**
 * @param {string} raw  URL or reference string to classify.
 * @returns {"remote"|"embedded"|"local"}
 *   - remote:   network-loaded (http/https/ftp/ws, or protocol-relative
 *               "//host")
 *   - embedded: inline payload (data:, blob:) - not bundled source, often
 *               obfuscation
 *   - local:    relative path, root-relative "/x",
 *               moz-extension:/chrome:/resource:, "#...", or empty
 */
export function classifyUrl(raw) {
  const url = String(raw ?? "").trim();
  if (url === "") {
    return "local";
  }
  if (EMBEDDED_RE.test(url)) {
    return "embedded";
  }
  if (REMOTE_RE.test(url) || PROTOCOL_RELATIVE_RE.test(url)) {
    return "remote";
  }
  return "local";
}
