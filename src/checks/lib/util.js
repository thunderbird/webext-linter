// Small shared helpers for rule modules. A check never sets a severity or a
// message - runChecks stamps every finding with its registry entry's severity,
// and the report resolver fills its text, so the yaml is the single source of
// both. A check that cannot settle a case returns an escalation. Only the
// orchestrator (escalation.js) routes it to the LLM or to manual review.
//
// Belongs here: generic, dependency-light check helpers - dedupe, llmEnabled,
// the asArray/asObject manifest guards, isMatchPattern/isBroadHost, scheme,
// trunc, manifestTokenLine, isExperiment/strictMaxVersion, the suspected-loader
// helpers referrerSupported/loaderSites, and the feed-note builder loaderTrace.
//
// Does NOT belong here: anything with a heavier dependency or a single home -
// reachability lives in reachability.js, permission analysis in permissions.js,
// manifest ref enumeration in manifest-refs.js, library classification in
// bundled.js. Shared utilities used across the whole repo (extname, sortKeys,
// debug) stay in src/util/files.js, src/util/json.js, src/util/log.js. Any
// rule's verdict logic - src/checks/rules/*.

import { DISPLAY_TRUNCATE_LENGTH } from "../../config.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("./reachability.js").Reachability} Reachability */
/** @typedef {import("../../addon/load.js").Manifest} Manifest */

// Documentation / project-metadata files an add-on may ship (for tooling, its
// store listing, or the i18n runtime) but never loads at runtime: license,
// readme, changelog, the vendor manifest, contributing/description/etc. Matched
// by base NAME, so the match is limited to a documentation extension
// (.md/.markdown/.txt/.rst) or none - a code file that merely shares the name
// (README.js, history.js, security.js) is NOT exempt and stays subject to the
// unused-files check. An optional [_-]<token> tail matches localized / variant
// names (README_DE, README-pt-BR, CHANGELOG_v2, LICENSE-MIT, Description_pt-BR),
// and the trailing `$` keeps it to the final path segment (so README/foo.js,
// a file UNDER a README dir, is not swept in). Shared so the unused-files ALLOW
// list and reachability's doc-file test agree.
export const DOC_METADATA_RE =
  /(^|\/)(LICENSE|COPYING|README|CHANGELOG|AUTHORS|NOTICE|VENDORS?|DESCRIPTION|CONTRIBUTING|INSTALL|HISTORY|SECURITY|CODE_OF_CONDUCT|TODO)(?:[_-][a-z0-9]+)*(?:\.(?:md|markdown|txt|rst))?$/i;

// Dependency manifests / lock files (a valid third-party-library declaration).
// Matched as EXACT filenames - the extension is part of the identity, so unlike
// the name-based docs above there is no name-without-extension ambiguity and no
// risk of exempting a same-named code file.
export const DEPENDENCY_FILE_RE =
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/i;

/**
 * Drop findings that duplicate file+line+column+item+data (the discriminators
 * now that findings carry no message).
 * @param {import("../../report/finding.js").Finding[]} findings
 * @returns {import("../../report/finding.js").Finding[]}
 */
export function dedupe(findings) {
  const seen = new Set();
  return findings.filter((f) => {
    const key = [
      f.file,
      f.loc?.line,
      f.loc?.column,
      f.item,
      JSON.stringify(f.data),
    ].join("|");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * Whether the LLM is enabled for this run - controlled ONLY by --llm-enabled (the
 * CLI sets ctx.options.llmEnabled from it; see resolveLlm in cli.js). Decoupled
 * from credentials: a keyless provider (Ollama) is still enabled. An enabled run
 * with an invalid config fails hard at the Setup pre-flight, so by the time a
 * check reads this the config is known-good.
 * @param {RunContext} ctx
 * @returns {boolean}
 */
export function llmEnabled(ctx) {
  return Boolean(ctx.options?.llmEnabled);
}

/**
 * Whether a referencing file is itself loaded by something that runs: it is
 * reachable, or its basename is named in a reachable file (so it is loaded along
 * a path static analysis could not follow, e.g. a config fetched by minified
 * code). A reference from a file that is NOT supported is dead and should not
 * count as use. Reads only the static reachability sets, so it is independent of
 * which file was checked first.
 * @param {Reachability} reach
 * @param {string} f  The referencing (loader) file.
 * @returns {boolean}
 */
export function referrerSupported(reach, f) {
  return (
    reach.isLive(f) || reach.mentionsOf(f).some((m) => reach.isLive(m.file))
  );
}

/**
 * The suspected loader sites of an unreachable file F, for per-site LLM judging:
 * when live code names F, the live mention sites (file:line); otherwise the live
 * runtime-loader sites (file, no line). Deduped. The caller excludes F from
 * `mentions`.
 * @param {Reachability} reach
 * @param {{file: string, line: number}[]} mentions  Referrers of F's basename.
 * @param {boolean} supported  Whether any referrer is itself reachable.
 * @returns {{file: string, line: ?number}[]}
 */
export function loaderSites(reach, mentions, supported) {
  const seen = new Set();
  const out = [];
  const add = (file, line) => {
    const key = `${file}:${line ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ file, line });
    }
  };
  if (supported) {
    for (const m of mentions) {
      if (referrerSupported(reach, m.file)) {
        add(m.file, m.line);
      }
    }
  } else {
    for (const s of reach.dynamicLoaderSites) {
      add(s.file, null);
    }
  }
  return out;
}

/** @param {string} a @param {string} b  Stable ascending string compare. */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The feed-note item tracing every loader the pre-flight examined for an
 * unreachable candidate: all referrers (file:line) it found, or the runtime
 * loaders when only those could load it, or that nothing references it. Sorted
 * so the trace never depends on iteration order, listing all of them - the feed
 * is a local re-check trail with no token cost. Adds "(dead code only)" when a
 * referrer exists but none is itself reachable.
 * @param {Reachability} reach
 * @param {{file: string, line: number}[]} mentions  Referrers of the basename.
 * @param {boolean} supported  Whether any referrer is itself reachable.
 * @returns {string}
 */
export function loaderTrace(reach, mentions, supported) {
  if (mentions.length) {
    const refs = [...mentions]
      .sort((a, b) =>
        a.file !== b.file ? cmp(a.file, b.file) : a.line - b.line
      )
      .map((m) => `${m.file}:${m.line}`);
    const tail = supported ? "" : " (dead code only)";
    return `referenced by ${refs.join(", ")}${tail}`;
  }
  if (reach.hasDynamicLoaders) {
    const sites = [
      ...new Set(reach.dynamicLoaderSites.map((s) => s.file)),
    ].sort(cmp);
    return `a runtime loader may build its path (${sites.join(", ")})`;
  }
  return "referenced by no loaded file";
}

/**
 * Whether the add-on is a Thunderbird Experiment (declares experiment_apis).
 * @param {Manifest} manifest
 * @returns {boolean}
 */
export function isExperiment(manifest) {
  const apis = manifest?.experiment_apis;
  return (
    Boolean(apis) && typeof apis === "object" && Object.keys(apis).length > 0
  );
}

/**
 * The declared gecko strict_max_version, from browser_specific_settings or the
 * legacy applications key, or undefined.
 * @param {Manifest} manifest
 * @returns {string|undefined}
 */
export function strictMaxVersion(manifest) {
  return (
    manifest?.browser_specific_settings?.gecko?.strict_max_version ??
    manifest?.applications?.gecko?.strict_max_version
  );
}

/**
 * The value if it is an array, else [] (defensive manifest-shape guard).
 * @param {unknown} v
 * @returns {unknown[]}
 */
export function asArray(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * The value if it is a non-null object, else {} (defensive manifest guard).
 * @param {unknown} v
 * @returns {Record<string, unknown>}
 */
export function asObject(v) {
  return v && typeof v === "object" ? v : {};
}

/**
 * True if the string is a URL match pattern rather than a named permission.
 * @param {string} p
 * @returns {boolean}
 */
export function isMatchPattern(p) {
  return p === "<all_urls>" || p.includes("://") || /^\*/.test(p);
}

/**
 * 1-based line of the first occurrence of `"<token>"` in the manifest text, or
 * null if not found. Works for any quoted JSON token - a key or a string value
 * (a permission, host pattern, or web_accessible_resources entry). Best-effort:
 * a token appearing more than once resolves to its first line.
 * @param {string} manifestText
 * @param {string} token  The bare key/value, without surrounding quotes.
 * @returns {number|null}
 */
export function manifestTokenLine(manifestText, token) {
  if (!manifestText) {
    return null;
  }
  const needle = `"${token}"`;
  const lines = manifestText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) {
      return i + 1;
    }
  }
  return null;
}

/**
 * 1-based line of the first line containing `needle` as a plain substring, or
 * null. Unlike manifestTokenLine (which matches a quoted JSON token), this suits
 * free-form text such as a VENDOR file, where a finding anchors on the verbatim
 * source URL rather than a quoted key.
 * @param {string} text
 * @param {string} needle
 * @returns {number|null}
 */
export function lineContaining(text, needle) {
  if (!text || !needle) {
    return null;
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) {
      return i + 1;
    }
  }
  return null;
}

/**
 * True if a match pattern grants global host access (<all_urls> or a "*" host).
 * @param {string} p
 * @returns {boolean}
 */
export function isBroadHost(p) {
  if (p === "<all_urls>") {
    return true;
  }
  const m = /^[^:]+:\/\/([^/]*)/.exec(p);
  return Boolean(m) && m[1] === "*";
}

/**
 * The scheme of a URL-ish string (text before the first ":").
 * @param {string} url
 * @returns {string}
 */
export function scheme(url) {
  return String(url).split(":")[0];
}

/**
 * Truncate a string for display.
 * @param {string} url
 * @param {number} [max]
 * @returns {string}
 */
export function trunc(url, max = DISPLAY_TRUNCATE_LENGTH) {
  const s = String(url);
  return s.length > max ? s.slice(0, max) + "…" : s;
}
