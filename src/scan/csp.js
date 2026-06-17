// Parses a manifest content_security_policy (string in MV2, object of named
// policies in MV3) and reports the two risk categories the remote-code checks
// care about: dynamic-code keywords ('unsafe-eval' / 'unsafe-inline') and
// remote script-source hosts. CSP has no ubiquitous parser to depend on, so
// directives are split on semicolons and whitespace, hosts detected by pattern.
//
// Belongs here: parsing the manifest CSP string/object and extracting its raw
// facts (unsafe-eval, unsafe-inline, remote script-src hosts).
//
// Does NOT belong here: deciding whether those facts are a problem and the
// reviewer-facing wording - that lives in the checks (src/checks/rules/*) and
// the registry (assets/registry.yaml). Classifying arbitrary URL strings
// as remote/local belongs to src/scan/url.js. Reading the manifest off disk
// belongs to src/addon/load.js.

/** @typedef {import("../addon/load.js").Manifest} Manifest */

/**
 * @param {Manifest} manifest  Parsed manifest.json.
 * @returns {{unsafeEval: boolean, unsafeInline: boolean, remoteHosts: string[]}}
 */
export function analyzeCsp(manifest) {
  const csp = manifest?.content_security_policy;
  const strings =
    typeof csp === "string"
      ? [csp]
      : csp && typeof csp === "object"
        ? Object.values(csp).filter((v) => typeof v === "string")
        : [];

  let unsafeEval = false;
  let unsafeInline = false;
  const hosts = new Set();
  for (const s of strings) {
    if (/'unsafe-eval'/i.test(s)) {
      unsafeEval = true;
    }
    if (/'unsafe-inline'/i.test(s)) {
      unsafeInline = true;
    }
    for (const host of remoteScriptHosts(s)) {
      hosts.add(host);
    }
  }
  return { unsafeEval, unsafeInline, remoteHosts: [...hosts] };
}

/**
 * Remote hosts allowed by the script-src (or fallback default-src) directive.
 * @param {string} csp
 * @returns {string[]}
 */
function remoteScriptHosts(csp) {
  const directives = csp
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);
  const scriptSrc =
    directives.find((d) => /^script-src(-elem)?\b/i.test(d)) ||
    directives.find((d) => /^default-src\b/i.test(d));
  if (!scriptSrc) {
    return [];
  }
  const hosts = [];
  for (const token of scriptSrc.split(/\s+/).slice(1)) {
    if (token.startsWith("'")) {
      continue; // 'self' 'none' 'unsafe-*' nonce/sha
    }
    if (/^(data|blob|filesystem|mediastream):$/i.test(token)) {
      continue;
    }
    if (
      token.includes("://") ||
      token.startsWith("//") ||
      /[a-z0-9*]\.[a-z]{2,}/i.test(token)
    ) {
      hosts.push(token);
    }
  }
  return hosts;
}
