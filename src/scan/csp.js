// Parses the policies of manifest.json and reports the two risk categories the remote-code
// checks care about: dynamic-code keywords ('unsafe-eval' / 'unsafe-inline') and remote
// script-source hosts.
//
// The policies are the ones Gecko applies. For extension pages: the content_security_policy
// string (MV2), or its `extension_pages` (MV3). For sandboxed pages: its `sandbox` (MV3), or
// sandbox.content_security_policy (MV2). Any other key of the MV3 object is one Gecko
// ignores, and so is it here. A sandboxed page runs without the extension's privileges, and
// the review allows eval and inline script there, so the keywords are read from the
// extension policies alone. Remote code is allowed nowhere, so remote hosts are read from
// every policy.
//
// A policy is tokenized into its directives first - split on ";", each directive split on
// ASCII whitespace into a name and its source list - and every question is then asked of
// the directive that governs it, through the fallback chain the CSP specification defines.
// So the order directives are written in never changes the answer: `script-src-elem 'self';
// script-src 'unsafe-eval'` allows eval exactly as the reverse does.
//
// Belongs here: parsing the manifest.json CSP string/object and extracting its raw
// facts (unsafe-eval, unsafe-inline, remote script hosts).
//
// Does NOT belong here: deciding whether those facts are a problem and the
// reviewer-facing wording - that lives in the checks (src/checks/rules/*) and
// the registry (assets/registry.yaml). Classifying arbitrary URL strings
// as remote/local belongs to src/scan/url.js. Reading the manifest.json off disk
// belongs to src/addon/load.js.

/** @typedef {import("../addon/load.js").Manifest} Manifest */

// Which directive governs a kind of script, and what it falls back to when absent - the
// first one the policy declares wins (CSP Level 3, "Get the effective directive").
const FALLBACK = {
  // eval and new Function: compiling a string is governed by script-src itself.
  "script-src": ["script-src", "default-src"],
  // <script> elements, inline or loaded.
  "script-src-elem": ["script-src-elem", "script-src", "default-src"],
  // Inline event handlers (onclick="...").
  "script-src-attr": ["script-src-attr", "script-src", "default-src"],
  // Workers and importScripts.
  "worker-src": ["worker-src", "child-src", "script-src", "default-src"],
};

/**
 * @typedef {object} CspRemoteSite  A remote script host, and the policy that names it.
 * @property {string} host  The source expression as written.
 * @property {string[]} path  The manifest.json path of the policy that names it.
 */

/**
 * @param {Manifest} manifest  Parsed manifest.json.
 * @returns {{unsafeEval: boolean, unsafeInline: boolean, remoteHosts: string[],
 *   remoteSites: CspRemoteSite[]}}  `remoteHosts` lists each host once, and
 *   `remoteSites` each host once per policy that names it.
 */
export function analyzeCsp(manifest) {
  let unsafeEval = false;
  let unsafeInline = false;
  const hosts = new Set();
  const sites = [];
  for (const { text, path, sandbox } of policiesOf(manifest)) {
    const policy = parsePolicy(text);
    // A directive the policy does not reach (no script directive, no default-src) leaves
    // scripts to the platform default, which permits none of this.
    if (
      !sandbox &&
      hasKeyword(effective(policy, "script-src"), "'unsafe-eval'")
    ) {
      unsafeEval = true;
    }
    if (
      !sandbox &&
      (allowsInline(effective(policy, "script-src-elem")) ||
        allowsInline(effective(policy, "script-src-attr")))
    ) {
      unsafeInline = true;
    }
    const named = new Set();
    for (const kind of ["script-src-elem", "script-src", "worker-src"]) {
      for (const source of effective(policy, kind)) {
        if (isRemoteSource(source)) {
          named.add(source);
        }
      }
    }
    for (const host of named) {
      hosts.add(host);
      sites.push({ host, path });
    }
  }
  return {
    unsafeEval,
    unsafeInline,
    remoteHosts: [...hosts],
    remoteSites: sites,
  };
}

/**
 * The policies Gecko applies, each with its manifest.json path and whether it governs
 * sandboxed pages (see the header).
 * @param {Manifest} manifest
 * @returns {{text: string, path: string[], sandbox: boolean}[]}
 */
function policiesOf(manifest) {
  const out = [];
  const csp = manifest?.content_security_policy;
  if (typeof csp === "string") {
    out.push({ text: csp, path: ["content_security_policy"], sandbox: false });
  } else if (csp && typeof csp === "object") {
    for (const [key, sandbox] of [
      ["extension_pages", false],
      ["sandbox", true],
    ]) {
      if (typeof csp[key] === "string") {
        out.push({
          text: csp[key],
          path: ["content_security_policy", key],
          sandbox,
        });
      }
    }
  }
  const sandboxed = manifest?.sandbox?.content_security_policy;
  if (typeof sandboxed === "string") {
    out.push({
      text: sandboxed,
      path: ["sandbox", "content_security_policy"],
      sandbox: true,
    });
  }
  return out;
}

/**
 * A policy's directives by lower-cased name, each with its source list. A name declared
 * twice keeps its first declaration, as the specification says. A directive holding any
 * character outside printable ASCII is dropped whole before that, as Gecko drops it - so it
 * claims no name, and a later declaration of the same name is the one in force.
 * @param {string} text
 * @returns {Map<string, string[]>}
 */
function parsePolicy(text) {
  const policy = new Map();
  for (const directive of text.split(";")) {
    const tokens = whitespaceTokens(directive);
    if (!tokens.length || !tokens.every(isPrintableAscii)) {
      continue;
    }
    const [name, ...sources] = tokens;
    if (!policy.has(name.toLowerCase())) {
      policy.set(name.toLowerCase(), sources);
    }
  }
  return policy;
}

/** @param {string} token @returns {boolean} Every character within 0x21-0x7E. */
function isPrintableAscii(token) {
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) {
      return false;
    }
  }
  return true;
}

/**
 * The source list governing one kind of script: the first directive of its fallback
 * chain the policy declares, or none.
 * @param {Map<string, string[]>} policy @param {keyof typeof FALLBACK} kind
 * @returns {string[]}
 */
function effective(policy, kind) {
  for (const name of FALLBACK[kind]) {
    if (policy.has(name)) {
      return policy.get(name);
    }
  }
  return [];
}

/**
 * Whether a source list lets inline script run: 'unsafe-inline' - unless the same list
 * carries a nonce, a hash or 'strict-dynamic', which make a browser ignore it. A nonce or
 * hash counts only in the form Gecko parses ('nonce-<base64>', 'sha256-<base64>', ...);
 * one that does not parse is dropped and cancels nothing. Its value is not checked.
 * @param {string[]} sources @returns {boolean}
 */
function allowsInline(sources) {
  if (!hasKeyword(sources, "'unsafe-inline'")) {
    return false;
  }
  return !sources.some(
    (s) => s.toLowerCase() === "'strict-dynamic'" || isNonceOrHash(s)
  );
}

const NONCE_HASH_PREFIXES = ["'nonce-", "'sha256-", "'sha384-", "'sha512-"];

/** @param {string} source @returns {boolean} A well-formed nonce or hash source. */
function isNonceOrHash(source) {
  const lower = source.toLowerCase();
  const prefix = NONCE_HASH_PREFIXES.find((p) => lower.startsWith(p));
  if (!prefix || !source.endsWith("'")) {
    return false;
  }
  return isBase64Value(source.slice(prefix.length, -1));
}

/**
 * A base64 or base64url value as Gecko accepts one: at least one character from the
 * alphabet, then at most two "=" of padding.
 * @param {string} v @returns {boolean}
 */
function isBase64Value(v) {
  let end = v.length;
  for (let pad = 0; pad < 2 && end > 0 && v[end - 1] === "="; pad++) {
    end--;
  }
  if (end === 0) {
    return false;
  }
  for (let i = 0; i < end; i++) {
    const c = v[i];
    const ok =
      (c >= "a" && c <= "z") ||
      (c >= "A" && c <= "Z") ||
      (c >= "0" && c <= "9") ||
      "+/-_".includes(c);
    if (!ok) {
      return false;
    }
  }
  return true;
}

/** @param {string[]} sources @param {string} keyword @returns {boolean} */
function hasKeyword(sources, keyword) {
  return sources.some((s) => s.toLowerCase() === keyword);
}

// The schemes a script can be fetched over from outside the add-on.
const NETWORK_SCHEMES = new Set(["http", "https", "ws", "wss", "ftp"]);

/**
 * Whether a source expression lets scripts load from outside the add-on: `*` (any host),
 * a network scheme on its own ("https:"), or a URL with a network scheme
 * ("https://cdn.example.com"). A source with no scheme ("cdn.example.com", "//x") takes
 * the add-on's own moz-extension: scheme, as Gecko resolves it, so it names nothing remote;
 * nor does a keyword, nonce or hash, or a local scheme ("data:", "blob:").
 * @param {string} source @returns {boolean}
 */
function isRemoteSource(source) {
  if (source === "*") {
    return true;
  }
  const colon = source.indexOf(":");
  if (source.startsWith("'") || colon <= 0) {
    return false;
  }
  return NETWORK_SCHEMES.has(source.slice(0, colon).toLowerCase());
}

/** @param {string} s @returns {string[]} The ASCII-whitespace-separated tokens of `s`. */
function whitespaceTokens(s) {
  const tokens = [];
  let start = -1;
  for (let i = 0; i <= s.length; i++) {
    const space = i === s.length || " \t\n\f\r".includes(s[i]);
    if (space && start !== -1) {
      tokens.push(s.slice(start, i));
      start = -1;
    } else if (!space && start === -1) {
      start = i;
    }
  }
  return tokens;
}
