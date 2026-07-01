// Classifies each JS or CSS file once into { library, minified, obfuscated } for
// the missing-library, minified-code and obfuscated-code checks. `library` is a
// TRUE content-hash match against the known-library database (a file whose raw
// sha256 is a known release is the library, identified by name@version - see
// src/checks/lib/library-hashes.js). `minified` and `obfuscated` are byte/geometry
// heuristics.
//
// The classification is byte-geometry sensitive (the minification heuristic keys
// off line length) and the library hash is of the raw bytes, so it is resolved
// ONCE up front - before the normalizer reformats files - by the pipeline into
// addon.bundled (classifyBundled), the same "compute once, checks read it" pattern
// as addon.vendor. Were it computed during the review, build/lint mode (which
// pretty-prints first) would change the bytes and miss both.
//
// Belongs here: classifyBundled (the one-shot classification + non-authored skip
// set) and the per-file tagging it uses. classifyAddonJs / nonAuthoredJs are thin
// readers of the memoized store. The known-library hash DB itself is fetched and
// parsed in src/checks/lib/library-hashes.js.
//
// Does NOT belong here: the rule verdicts and findings - those live in the
// missing-library, minified-code and obfuscated-code rules under src/checks/rules/*. Resolving
// the vendored set it builds on (addon.vendor.set) - src/vendor/resolve.js.
// Extension-set helpers - src/util/files.js.

import { extname, JS_EXTENSIONS, CSS_EXTENSIONS } from "../../util/files.js";
import { isVendored } from "../../vendor/resolve.js";
import { parseJs, traverse } from "../../parse/ast.js";
import { rawSha256 } from "../../normalize/hash.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../../addon/load.js").Addon} Addon */
/** @typedef {{name: string, version: string}} LibraryId */
/** @typedef {{file: string, library: boolean, minified: boolean,
 *   obfuscated: boolean, minifiedGeometry: boolean, untrusted?: boolean, libraryId?: LibraryId,
 *   cdn?: {url: string, type?: string, popular?: boolean}}} BundleTag  `library` is set by a
 *   content-hash match against the known-library database; `libraryId` names the
 *   matched release (for the missing-library finding). `minifiedGeometry` is the raw
 *   minified-by-geometry verdict, kept even when scanMinified clears `minified`,
 *   so the CDN identifier can still consider the bundle. `cdn` is set later
 *   (src/checks/lib/cdn-lookup.js) when such a bundle is matched on the jsDelivr CDN:
 *   it holds the jsDelivr source URL (and its type) for the find-lib-on-cdn finding
 *   plus `popular` - whether the matched package cleared the popularity trust bar.
 *   A POPULAR match ALSO sets `library`/`libraryId` (vendored-family, like a hash
 *   match); a NOT-popular one sets `untrusted` instead (identified but not exempt -
 *   see markUntrusted), keeping `libraryId` for the OSV audit. */
/** @typedef {{classified: BundleTag[], nonAuthored: Set<string>,
 *   untrusted: Array<{file: string, source?: string, name?: string, unreadable: boolean}>}} Bundled */

/**
 * Classify the add-on's JS and CSS once: per-file library/minified/obfuscated tags
 * plus the not-the-developer's-source skip set. Pure and addon-keyed, so the pipeline can
 * run it before normalize. The result is stored on addon.bundled.
 *
 * `nonAuthored` is the VENDOR.md-declared third-party files plus any JS or CSS
 * tagged library / minified / obfuscated. The source-level finding scanners (the
 * eval checks, unsafe-html, remote-script, code-sanity) skip these to save time
 * and noise - minified or obfuscated code is forbidden anyway (minified-code,
 * obfuscated-code and missing-library reject it and request the original sources,
 * which are then reviewed), and vendored files are declared third-party. Reachability skips
 * them only when REACHABILITY_SKIPS_NON_AUTHORED is on (src/config.js, off by
 * default), since dropping their loader edges would wrongly orphan what they
 * load.
 *
 * The `library` tag is a content-hash match (libraryHashes); the matched release
 * is named on tag.libraryId, which missing-library surfaces and which
 * auditIdentifiedLibraries (src/vendor/verify.js) OSV-audits so an undeclared
 * vulnerable bundle is caught. TODO: extend the same hashing to recognize
 * minified/obfuscated bundles.
 *
 * @param {Addon} addon
 * @param {{scanMinified?: boolean, libraryHashes?: Map<string, LibraryId>}} [opts]
 *   libraryHashes: the known-library `sha256 -> {name, version}` map - a file whose
 *   raw hash is a key is tagged `library` (and identified). Empty map = nothing
 *   recognized. scanMinified (on for source-code submissions): treat a minified-by-geometry file
 *   (an unidentifiable webpack/tsc bundle) as authored so every source-level check
 *   reviews it. A hash-identified library is real third-party code, so it - like the
 *   obfuscated tag and VENDOR.md-declared / experiment-trusted files - stays
 *   non-authored. Off by default.
 * @returns {Bundled}
 */
export function classifyBundled(
  addon,
  { scanMinified = false, libraryHashes = new Map() } = {}
) {
  const classified = [];
  // Files of a recognised allowed Experiment (pristine or modified) are
  // upstream-derived, not the developer's - the byte-match IS their review, so
  // the source-level scanners skip them like a vendored library, regardless of
  // --allow-experiments. trustedFiles is empty only when some experiment is
  // unsupported (not a known upstream draft): then nothing is trusted and all of
  // it stays linted.
  const trusted = addon.experiments?.trustedFiles ?? new Set();
  const nonAuthored = new Set([...trusted]);
  for (const [file, buf] of addon.files) {
    const ext = extname(file);
    // A vendored file (an exact VENDOR entry OR a file under a vendored folder) is
    // not the developer's code: skip scanning it and treat it as non-authored.
    const vend = isVendored(addon.vendor, file);
    if (vend) {
      nonAuthored.add(file);
    }
    if ((!JS_EXTENSIONS.has(ext) && !CSS_EXTENSIONS.has(ext)) || vend) {
      continue;
    }
    if (buf.length < 1024) {
      continue; // too small (by bytes, as hashed) to be a library or worrying blob.
    }
    const text = buf.toString("utf8");
    // The library tag is a true content-hash match against the known-library DB;
    // a hit also names the matched release (libraryId) for missing-library.
    const libraryId = libraryHashes.get(rawSha256(buf));
    const content = classify(text, file);
    const tag = { file, library: Boolean(libraryId), ...content };
    if (libraryId) {
      tag.libraryId = libraryId;
    }
    // Preserve the raw minified-by-geometry verdict where scanMinified cannot
    // reach it: that option clears tag.minified (treat the bundle as authored), but
    // the CDN identifier (a later pipeline step) must still recognise a known
    // library here - a real third-party library is excluded regardless of the
    // option, exactly as the hash-DB library tag is kept below. See cdn-lookup.js.
    tag.minifiedGeometry = Boolean(content.minified);
    // classify()'s obfuscation signal is byte-based and so comment/string-blind -
    // `eval(` or `fromCharCode` in a comment trips it. For an authored-candidate
    // JS file (not already library/minified, which are non-authored regardless)
    // recompute it on the AST, where comments and strings cannot count. Skipped
    // for minified/library files, so the multi-MB bundles are never parsed here.
    if (JS_EXTENSIONS.has(ext) && !tag.library && !tag.minified) {
      const astVerdict = detectObfuscationAst(text);
      if (astVerdict !== null) {
        tag.obfuscated = astVerdict;
      }
    }
    // scanMinified: clear the minified tag so a merely-minified file (a
    // webpack/tsc bundle we can't identify) is treated as authored - it leaves the
    // non-authored set (scanned by every check) and minified-code stays silent. The
    // library tag is NOT cleared: a hash match is a real, named third-party library
    // (vendored-family), so it stays excluded and still drives missing-library /
    // vendor-vulnerable, exactly like a VENDOR.md-declared copy. Done AFTER the
    // obfuscation gate above, so a multi-MB bundle is still not AST-parsed here;
    // the obfuscated tag is likewise untouched (it stays excluded).
    if (scanMinified) {
      tag.minified = false;
    }
    classified.push(tag);
    if (tag.library || tag.minified || tag.obfuscated) {
      nonAuthored.add(file);
    }
  }
  // `untrusted` is filled later (cdn-lookup.js, vendor/verify.js) for an
  // identified-but-not-popular library: known by content, but not confirmed
  // widely used, so NOT in the trusted/exempt family - see markUntrusted.
  return { classified, nonAuthored, untrusted: [] };
}

/**
 * Record an identified-but-not-popular ("untrusted") library and route it out of
 * the trusted/exempt family: a readable one is reviewed as authored code (removed
 * from the non-authored skip set), an unreadable (minified/obfuscated) one stays
 * skipped and is rejected by untrusted-minified-library. The untrusted-library /
 * untrusted-minified-library checks read addon.bundled.untrusted. Idempotent and
 * defensive (no-op without a bundled store, e.g. some unit harnesses).
 * @param {Addon} addon
 * @param {{file: string, source?: string, name?: string, unreadable: boolean}} entry
 *   `name` is the display id (e.g. "lodash 4.17.21"); `source` the upstream URL.
 */
export function markUntrusted(addon, { file, source, name, unreadable }) {
  const bundled = addon?.bundled;
  if (!bundled) {
    return;
  }
  bundled.untrusted.push({ file, source, name, unreadable });
  if (unreadable) {
    bundled.nonAuthored.add(file); // unreadable -> not scanned; the reject asks for source
  } else {
    bundled.nonAuthored.delete(file); // readable -> reviewed as authored code
  }
}

/**
 * Reconcile the `not-popular` VENDOR/package results (recorded by verifyVendor)
 * into the untrusted family - identified but not a confirmed widely-used library,
 * so reviewed as authored code (markUntrusted). Done as a pipeline step AFTER
 * classifyBundled (which builds addon.bundled), since verifyVendor runs before it.
 * The reconciled results leave vendor.results (they are no longer manual review).
 * The CDN not-popular case is handled in cdn-lookup.js, which already runs after
 * classifyBundled. No-op without a bundled store or vendor results.
 * @param {Addon} addon
 */
export function applyNotPopularVendor(addon) {
  const results = addon?.vendor?.results;
  if (!results || !addon.bundled) {
    return;
  }
  const remaining = [];
  for (const result of results) {
    if (result.outcome !== "not-popular") {
      remaining.push(result);
      continue;
    }
    const buf = addon.files?.get(result.path);
    const content = buf
      ? classify(buf.toString("utf8"), result.path)
      : { minified: false, obfuscated: false };
    markUntrusted(addon, {
      file: result.path,
      source: result.source,
      unreadable: content.minified || content.obfuscated,
    });
  }
  addon.vendor.results = remaining;
}

/**
 * The bundled classification for this review: the pipeline's pre-normalize
 * addon.bundled, or a lazy compute for callers that ran no pre-step (unit tests,
 * which never normalize). Memoized on the addon so the ~8 consumers share it.
 * @param {RunContext} ctx
 * @returns {Bundled}
 */
function getBundled(ctx) {
  return (ctx.addon.bundled ??= classifyBundled(ctx.addon, {
    // scanMinified is on in SCS mode (ctx.mode === "scs"). For the review target
    // (the readable source) it means "scan every file as authored, even a minified-
    // looking one". For the built XPI - which the orchestrator routes in as ctx.addon
    // for the `input: xpi` structure checks, carrying the same mode - it keeps the
    // built bundles' load graph in play (their loaders still count), which keeps
    // unused-files conservative. The pipeline pre-classifies only the source review
    // target, so this lazy fallback also runs for the XPI in SCS (besides a rejected
    // Experiment or a direct unit ctx).
    scanMinified: ctx.mode === "scs",
    libraryHashes: ctx.options?.libraryHashes,
  }));
}

/**
 * Per-file library/minified/obfuscated tags for the add-on's JS (see classifyBundled).
 * @param {RunContext} ctx
 * @returns {BundleTag[]}
 */
export function classifyAddonJs(ctx) {
  return getBundled(ctx).classified;
}

/**
 * Files that are not the developer's authored source (see classifyBundled).
 * @param {RunContext} ctx
 * @returns {Set<string>}
 */
export function nonAuthoredJs(ctx) {
  return getBundled(ctx).nonAuthored;
}

/**
 * Identified-but-not-popular libraries (see markUntrusted), read by the
 * untrusted-library (info) and untrusted-minified-library (reject) checks.
 * @param {RunContext} ctx
 * @returns {Array<{file: string, source?: string, name?: string, unreadable: boolean}>}
 */
export function untrustedLibs(ctx) {
  return getBundled(ctx).untrusted ?? [];
}

/**
 * The CONTENT signal for one file: whether it is minified (line geometry) or
 * obfuscated (JS packer signatures). Library detection is NOT here - it is a true
 * content-hash match against the known-library database, done in classifyBundled.
 * Pure (bytes + filename only).
 * @param {string} text
 * @param {string} file
 * @returns {{minified: boolean, obfuscated: boolean}}
 */
export function classify(text, file) {
  // Obfuscation is JS-only (a stylesheet is never "obfuscated" in the packer
  // sense); minified geometry applies to JS and CSS alike.
  const isJs = JS_EXTENSIONS.has(extname(file));

  // Minified line geometry: at least one very long line, dense on average.
  const lines = text.split("\n");
  const maxLine = lines.reduce((m, l) => (l.length > m ? l.length : m), 0);
  const minified = maxLine > 500 && text.length / lines.length > 150;

  // Obfuscation (JS only): javascript-obfuscator "_0x...." identifiers in bulk,
  // or an eval/Function-of-decoded-string packer.
  const hexNames = isJs ? (text.match(/_0x[0-9a-f]{4,}/gi) || []).length : 0;
  const packed =
    isJs &&
    (/\beval\s*\(/.test(text) || /\bFunction\s*\(/.test(text)) &&
    (/\batob\s*\(/.test(text) || /String\.fromCharCode/.test(text));
  const obfuscated = hexNames >= 5 || packed;

  return { minified, obfuscated };
}

// Identifiers that denote the global object, so window.eval / globalThis.Function
// are the same packer sinks as the bare forms (mirrors src/parse/remote-js.js).
const GLOBAL_OBJECTS = new Set([
  "window",
  "self",
  "globalThis",
  "global",
  "frames",
  "top",
  "parent",
]);

// The bare name a call/new targets: `eval`, `Function`, `atob`, or the dotted
// `String.fromCharCode` - unwrapping a global-object receiver (window.eval -> eval)
// but only for a non-computed member, so a string/comment can never be the name.
function calleeName(callee) {
  if (!callee) {
    return null;
  }
  if (callee.type === "Identifier") {
    return callee.name;
  }
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property?.type === "Identifier" &&
    callee.object?.type === "Identifier"
  ) {
    return GLOBAL_OBJECTS.has(callee.object.name)
      ? callee.property.name
      : `${callee.object.name}.${callee.property.name}`;
  }
  return null;
}

/**
 * The obfuscation signal computed on the parsed AST instead of raw bytes: the
 * same heuristic as classify() (>=5 `_0x….` identifiers, or an eval/Function call
 * paired with an atob/String.fromCharCode decode) but blind to comments and string
 * literals, where a mere mention of `eval(`/`fromCharCode` must NOT count. Used for
 * authored-candidate files; minified/library files are non-authored regardless and
 * are never parsed here (keeping the multi-MB bundles out of the parser).
 * @param {string} text
 * @returns {?boolean}  the verdict, or null when the file does not parse (the
 *   caller then keeps classify()'s byte heuristic).
 */
export function detectObfuscationAst(text) {
  const { ast, parseError } = parseJs(text);
  if (parseError || !ast) {
    return null;
  }
  let hexNames = 0;
  let hasEval = false;
  let hasDecode = false;
  const visitInvocation = (path) => {
    const name = calleeName(path.node.callee);
    if (name === "eval" || name === "Function") {
      hasEval = true;
    } else if (name === "atob" || name === "String.fromCharCode") {
      hasDecode = true;
    }
  };
  try {
    traverse(ast, {
      Identifier(path) {
        if (/^_0x[0-9a-f]{4,}$/i.test(path.node.name)) {
          hexNames += 1;
        }
      },
      CallExpression: visitInvocation,
      NewExpression: visitInvocation,
    });
  } catch {
    // @babel/traverse builds scope and throws on some pathological inputs (e.g. a
    // duplicate `const`, common in machine-generated code). The walk is then
    // undecidable, so fall back to classify()'s byte heuristic.
    return null;
  }
  return hexNames >= 5 || (hasEval && hasDecode);
}
