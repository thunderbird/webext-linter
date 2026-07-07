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
 *   obfuscated: boolean, untrusted?: boolean, libraryId?: LibraryId,
 *   cdn?: {url: string, type?: string, popular?: boolean}}} BundleTag  `library` is set by a
 *   content-hash match against the known-library database; `libraryId` names the
 *   matched release (for the missing-library finding). `minified` is the raw
 *   minified-by-geometry verdict; a minified non-library is non-authored and the CDN
 *   identifier considers it for a jsDelivr match. `cdn` is set later
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
 * Composed of classifyByteGeometry (the byte/geometry tags + skip-set seed, no parse)
 * and assembleBundled (folding in each candidate's AST obfuscation verdict). The
 * verdict comes from `obfuscated` when the extraction pass precomputed it on its shared
 * parse - the review source's path, via classifyAndExtractReview - else this parses each
 * candidate itself via detectObfuscationAst: the path for the built XPI's setup
 * classification (SCS) and the lazy getBundled callers (unit / rejected-Experiment
 * contexts that never ran a pre-step).
 *
 * @param {Addon} addon
 * @param {{libraryHashes?: Map<string, LibraryId>,
 *   obfuscated?: Map<string, ?boolean>}} [opts]
 *   libraryHashes: the known-library `sha256 -> {name, version}` map - a file whose
 *   raw hash is a key is tagged `library` (and identified). Empty map = nothing
 *   recognized. A minified-by-geometry file (an unidentifiable webpack/tsc bundle) is
 *   non-authored (skipped by the source-level scanners and rejected by minified-code),
 *   in both XPI and source-code-submission reviews. A hash-identified library is real
 *   third-party code, so it - like the
 *   obfuscated tag and VENDOR.md-declared / experiment-trusted files - stays
 *   non-authored. obfuscated: precomputed candidate-file -> AST
 *   verdict from the extraction pass; absent -> parse each candidate here.
 * @returns {Bundled}
 */
export function classifyBundled(
  addon,
  { libraryHashes = new Map(), obfuscated } = {}
) {
  const byte = classifyByteGeometry(addon, { libraryHashes });
  const verdicts =
    obfuscated ?? obfuscationForCandidates(addon, byte.candidates);
  return assembleBundled(byte, verdicts);
}

/**
 * The byte-geometry half of the classification (no parse): per-file library/minified
 * tags and the vendored / experiment-trusted / library / minified non-authored seed.
 * `tag.obfuscated` carries classify()'s comment/string-blind byte value, which
 * assembleBundled overrides with the AST verdict for each `candidate`.
 * @param {Addon} addon
 * @param {{libraryHashes?: Map<string, LibraryId>}} [opts]
 * @returns {{classified: BundleTag[], nonAuthored: Set<string>,
 *   candidates: Set<string>}}  `candidates` are the JS files the AST obfuscation check
 *   applies to (not library, not minified, >=1024 B) - a minified / library bundle is
 *   never one, so is never AST-parsed.
 */
export function classifyByteGeometry(
  addon,
  { libraryHashes = new Map() } = {}
) {
  const classified = [];
  const candidates = new Set();
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
    // Authored-candidate for the AST obfuscation check: a JS file not already
    // library/minified. classify()'s obfuscation signal (on tag.obfuscated) is
    // byte-based and comment/string-blind - `eval(` or `fromCharCode` in a comment
    // trips it - so assembleBundled recomputes it on the AST, where comments and
    // strings cannot count. A minified bundle is never a candidate, so the multi-MB
    // bundles are never parsed for this.
    if (JS_EXTENSIONS.has(ext) && !tag.library && !tag.minified) {
      candidates.add(file);
    }
    classified.push(tag);
    // library/minified join the skip set here; obfuscated is added by assembleBundled
    // once the AST verdict is known.
    if (tag.library || tag.minified) {
      nonAuthored.add(file);
    }
  }
  return { classified, nonAuthored, candidates };
}

/**
 * Finalize the classification: fold each candidate's AST obfuscation verdict over
 * classify()'s byte value (the AST verdict wins unless null - the exact merge
 * classifyBundled has always used), then add every obfuscated file to the
 * non-authored set. Pure, no parse.
 * @param {{classified: BundleTag[], nonAuthored: Set<string>,
 *   candidates: Set<string>}} byteResult  From classifyByteGeometry.
 * @param {Map<string, ?boolean>} obfuscated  candidate file -> AST verdict; null
 *   (undecidable / parseError) or absent keeps classify()'s byte value.
 * @returns {Bundled}
 */
export function assembleBundled(
  { classified, nonAuthored, candidates },
  obfuscated
) {
  for (const tag of classified) {
    if (candidates.has(tag.file)) {
      const astVerdict = obfuscated.get(tag.file);
      if (astVerdict !== null && astVerdict !== undefined) {
        tag.obfuscated = astVerdict;
      }
    }
    if (tag.obfuscated) {
      nonAuthored.add(tag.file);
    }
  }
  // `untrusted` is filled later (cdn-lookup.js, vendor/verify.js) for an
  // identified-but-not-popular library: known by content, but not confirmed
  // widely used, so NOT in the trusted/exempt family - see markUntrusted.
  return { classified, nonAuthored, untrusted: [] };
}

/**
 * Parse each candidate and record its AST obfuscation verdict - the standalone path
 * used when no extraction pass precomputed it (the lazy getBundled callers). Mirrors
 * the extraction pass's per-candidate compute.
 * @param {Addon} addon
 * @param {Set<string>} candidates
 * @returns {Map<string, ?boolean>}
 */
function obfuscationForCandidates(addon, candidates) {
  const out = new Map();
  for (const file of candidates) {
    const buf = addon.files.get(file);
    if (buf) {
      out.set(file, detectObfuscationAst(buf.toString("utf8"), file));
    }
  }
  return out;
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
  // The pipeline pre-classifies the review target in setup (and, in SCS, the built XPI
  // too - in XPI mode they are one artifact), so this lazy fallback only fires for a
  // caller that ran no pre-step (a rejected Experiment or a direct unit ctx). Minified
  // is classified identically in every mode and artifact - a minified non-library is
  // non-authored (and rejected).
  return (ctx.addon.bundled ??= classifyBundled(ctx.addon, {
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
 * The obfuscation signal on a parsed AST: the same heuristic as classify() (>=5
 * `_0x….` identifiers, or an eval/Function call paired with an
 * atob/String.fromCharCode decode) but blind to comments and string literals, where
 * a mere mention of `eval(`/`fromCharCode` must NOT count. Called by
 * detectObfuscationAst (which parses first) and by the extraction pass on its shared
 * AST (src/checks/extract.js), so the walk is separate from the parse.
 * @param {?import("@babel/types").File} ast  A parsed AST (parseJs's `.ast`).
 * @returns {?boolean}  the verdict, or null when the AST is absent or the scope walk
 *   is undecidable (the caller then keeps classify()'s byte heuristic).
 */
export function obfuscationFrom(ast) {
  if (!ast) {
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

/**
 * The obfuscation signal computed on the parsed AST instead of raw bytes. Used for
 * authored-candidate files; minified/library files are non-authored regardless and
 * are never parsed here (keeping the multi-MB bundles out of the parser). This is the
 * standalone path taken whenever classifyBundled gets no precomputed obfuscation map: the
 * lazy getBundled callers (unit / rejected-Experiment contexts), and the setup
 * classification of the built XPI in SCS. It parses each candidate itself. The review
 * source instead reuses the extraction pass's shared AST (obfuscationFrom), so no reviewed
 * source is parsed twice.
 * @param {string} text
 * @param {string} [file]  The candidate's path, so TypeScript/JSX authored source
 *   parses (a candidate is always JS, but may be .ts/.tsx/.jsx).
 * @returns {?boolean}  the verdict, or null when the file does not parse (the
 *   caller then keeps classify()'s byte heuristic).
 */
export function detectObfuscationAst(text, file) {
  const { parseError, ast } = parseJs(text, file);
  return parseError ? null : obfuscationFrom(ast);
}
