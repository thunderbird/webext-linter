// Classifies each JS or CSS file once into { library, minified, obfuscated } for
// the missing-library, minified-code and obfuscated-code checks. `library` is a
// TRUE content-hash match against the known-library database (a file whose raw
// sha256 is a known release is the library, identified by name@version - see
// src/lib/library-hashes.js). `minified` is a structural signal (statement density,
// see src/lib/minified.js); `obfuscated` is a structural match against a known
// obfuscator family (see src/lib/obfuscation.js).
//
// The classification keys off the raw shipped bytes (the library hash, and each
// detector's parse of the shipped source), so it is resolved ONCE up front - before the
// normalizer reformats files - by the pipeline into addon.bundled (classifyBundled), the
// same "compute once, checks read it" pattern as addon.vendor. Were it computed during
// the review, build/lint mode (which pretty-prints first) would change the bytes and
// miss all three.
//
// Belongs here: classifyBundled (the one-shot classification + non-authored skip
// set) and the per-file tagging it uses. classifyAddonJs / nonAuthoredJs are thin
// readers of the memoized store. The known-library hash DB itself is fetched and
// parsed in src/lib/library-hashes.js.
//
// Does NOT belong here: the rule verdicts and findings - those live in the
// missing-library, minified-code and obfuscated-code rules under src/checks/rules/*. Resolving
// the vendored set it builds on (addon.vendor.set) - src/vendor/resolve.js.
// Extension-set helpers - src/util/files.js.

import {
  extname,
  JS_EXTENSIONS,
  CSS_EXTENSIONS,
  CODE_EXTENSIONS,
} from "../util/files.js";
import { isVendored } from "../vendor/resolve.js";
import { collectJsSources } from "../addon/sources.js";
import { rawSha256 } from "../normalize/hash.js";
import { obfuscationVerdict } from "./obfuscation.js";
import { VERDICT } from "./enum.js";
import { isMinified, isMinifiedJs } from "./minified.js";

/** @typedef {import("../checks/registry.js").RunContext} RunContext */
/** @typedef {import("../addon/load.js").Addon} Addon */
/** @typedef {{name: string, version: string}} LibraryId */
/** @typedef {{file: string, library: boolean, minified: boolean,
 *   obfuscation: import("./enum.js").Verdict, untrusted?: boolean, libraryId?: LibraryId,
 *   cdn?: {url: string, type?: string, popular?: boolean}}} BundleTag  `library` is set by a
 *   content-hash match against the known-library database; `libraryId` names the
 *   matched release (for the missing-library finding). `minified` is the raw
 *   minified-by-geometry verdict; a minified non-library is non-authored and the CDN
 *   identifier considers it for a jsDelivr match. `obfuscation` is the three-state VERDICT
 *   from src/lib/obfuscation.js: FAIL (a STRONG-family match - the obfuscated-code finding,
 *   non-authored), UNSURE (a weak-family-only match - readable, authored, scanned, and
 *   referred to obfuscated-code's a reviewer's judgement), or PASS. `cdn` is set later
 *   (src/lib/cdn-lookup.js) when such a bundle is matched on the jsDelivr CDN:
 *   it holds the jsDelivr source URL (and its type) for the find-lib-on-cdn finding
 *   plus `popular` - whether the matched package cleared the popularity trust bar.
 *   A POPULAR match ALSO sets `library`/`libraryId` (vendored-family, like a hash
 *   match); a NOT-popular one sets `untrusted` instead (identified but not exempt -
 *   see markUntrusted), keeping `libraryId` for the OSV audit - but only when the
 *   package name matches the file's name; a mismatched not-popular match is
 *   discarded like a miss (a vendored copy inside an unrelated package - see
 *   src/lib/cdn-lookup.js). */
/** @typedef {{classified: BundleTag[], nonAuthored: Set<string>,
 *   untrusted: Array<{file: string, source?: string, name?: string, unreadable: boolean}>}} Bundled */

/**
 * Classify the add-on's JS and CSS once: per-file library/minified/obfuscated tags
 * plus the not-the-developer's-source skip set. Pure and addon-keyed, so the pipeline can
 * run it before normalize. The result is stored on addon.bundled.
 *
 * `nonAuthored` is the VENDOR.md-declared third-party files plus any JS or CSS
 * tagged library / minified / obfuscated. The source-level finding scanners (the
 * eval checks, unsafe-html, remote-resources, code-sanity) skip these to save time
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
 * Composed of classifyFiles (the per-file library/minified/obfuscated tags +
 * non-authored skip set) and assembleBundled (the thin finalizer that seeds the empty
 * `untrusted` list). Every mode and caller shares this one path - there is no separate
 * precomputed-verdict route, since the obfuscation detector is self-contained.
 *
 * @param {Addon} addon
 * @param {{libraryHashes?: Map<string, LibraryId>}} [opts]
 *   libraryHashes: the known-library `sha256 -> {name, version}` map - a file whose
 *   raw hash is a key is tagged `library` (and identified). Empty map = nothing
 *   recognized. A minified-by-geometry file (an unidentifiable webpack/tsc bundle) is
 *   non-authored (skipped by the source-level scanners and rejected by minified-code),
 *   in both XPI and source-code submission reviews. A hash-identified library is real
 *   third-party code, so it - like the obfuscated tag and VENDOR.md-declared /
 *   experiment-trusted files - stays non-authored.
 * @returns {Bundled}
 */
export function classifyBundled(addon, { libraryHashes = new Map() } = {}) {
  return assembleBundled(classifyFiles(addon, { libraryHashes }));
}

// Below this, the LIBRARY and OBFUSCATION questions are not worth asking: too small to
// be a library release, and the obfuscation detector's array-replacement heuristic fires
// on an ordinary string-lookup table at these sizes. The MINIFIED question has no such
// limit and is asked at every size. Applied to a file's bytes and to an inline script's
// body alike (classifyInlineSources).
export const MIN_CLASSIFY_BYTES = 1024;

/**
 * The per-file classification: library (content hash) / minified (geometry) /
 * obfuscation (structural, via classify) tags, plus the vendored / experiment-trusted /
 * library / minified / obfuscated non-authored seed. `tag.obfuscation` is the final
 * verdict here - the detector is structural, so there is no later AST correction.
 * @param {Addon} addon
 * @param {{libraryHashes?: Map<string, LibraryId>}} [opts]
 * @returns {{classified: BundleTag[], nonAuthored: Set<string>}}
 */
export function classifyFiles(addon, { libraryHashes = new Map() } = {}) {
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
    // The floor guards the two questions that need it, not the one that does not. A
    // tiny file is too small to be a library release, and the obfuscation detector's
    // array-replacement heuristic fires on an ordinary string-lookup table at these
    // sizes (a day-name array). Minification is neither: it is statement density on a
    // long line, as precise at 700 bytes as at 700 KB - and skipping it here hid real
    // packed build chunks (a Vite modulepreload polyfill, a webpack chunk) and let a
    // bundle split into sub-floor pieces ship unasked.
    const small = buf.length < MIN_CLASSIFY_BYTES;
    // The size-independence argument is about STATEMENT DENSITY, which only the JS
    // branch measures: for CSS, isMinified is pure geometry (one long line surviving a
    // payload strip), and a small one-line stylesheet - a generated design-token file -
    // reads as packed. So CSS keeps the floor and JS does not.
    if (small && !JS_EXTENSIONS.has(ext)) {
      continue;
    }
    const text = buf.toString("utf8");
    // The library tag is a true content-hash match against the known-library DB;
    // a hit also names the matched release (libraryId) for missing-library.
    const libraryId = small ? undefined : libraryHashes.get(rawSha256(buf));
    const content = classify(text, file, { detectObfuscation: !small });
    const tag = { file, library: Boolean(libraryId), ...content };
    if (libraryId) {
      tag.libraryId = libraryId;
    }
    classified.push(tag);
    // A library/minified/obfuscated file is not the developer's reviewable source, so
    // it joins the skip set: identified libraries are declared third-party, minified
    // and obfuscated files are rejected (and their original source requested) rather
    // than scanned.
    if (tag.library || tag.minified || tag.obfuscation.fail) {
      nonAuthored.add(file);
    }
  }
  return { classified, nonAuthored };
}

/**
 * Finalize the classification into a Bundled: the classified tags and non-authored set
 * from classifyFiles, plus the empty `untrusted` list. Pure, no parse.
 * @param {{classified: BundleTag[], nonAuthored: Set<string>}} byteResult  From
 *   classifyFiles.
 * @returns {Bundled}
 */
export function assembleBundled({ classified, nonAuthored }) {
  // `untrusted` is filled later (cdn-lookup.js, vendor/verify.js) for an
  // identified-but-not-popular library: known by content, but not confirmed
  // widely used, so NOT in the trusted/exempt family - see markUntrusted.
  return { classified, nonAuthored, untrusted: [] };
}

// Every outcome that leaves a declared file unverified. The verdicts that REJECT -
// a modified copy, an unpinned source - are not here: those are already errors, and
// the file's status is decided by its own check.
const UNVERIFIED_OUTCOMES = new Set([
  "not-popular",
  "untrusted",
  "unfetchable",
  "no-url",
]);

/**
 * Record an identified-but-not-popular ("untrusted") library and route it out of
 * the trusted/exempt family: a readable one is reviewed as authored code (removed
 * from the non-authored skip set), an unreadable (minified/obfuscated) one stays
 * skipped and is rejected by untrusted-minified-library. The untrusted-library /
 * untrusted-minified-library checks read addon.bundled.untrusted. Defensive (no-op
 * without a bundled store, e.g. some unit harnesses). One call, one entry: two
 * declarations covering the same file list it twice, which the report shows and no
 * consumer minds - the readability routing below is what decides its status, and it
 * reaches the same answer either way.
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
 * Reconcile every UNVERIFIED VENDOR/package result into the untrusted family. A
 * bundled file is exempt from review because we fetched its declared source and the
 * bytes matched - nothing else earns it. So each way that can fail lands here:
 *
 *   not-popular  the source is real but the package is not a known library
 *   untrusted    the source is on a host we will not fetch from
 *   unfetchable  a reachable host had no such release (the review stops if the
 *                network itself is gone - src/util/net.js)
 *   no-url       nothing was declared as the source at all
 *
 * All four say the same thing: the claim is unsupported. markUntrusted then routes by
 * readability - a readable file is reviewed as the developer's own code and flagged
 * (info) by untrusted-library, an unreadable one stays unscanned and
 * untrusted-minified-library rejects it, asking for source. A declaration cannot
 * exempt a file the tool was never able to check.
 *
 * Runs as a pipeline step AFTER classifyBundled (which builds addon.bundled), since
 * verifyVendor runs before it. A reconciled result is REMOVED from vendor.results:
 * the untrusted family is now where that file's status is read, so leaving the row
 * would let a second consumer reach its own conclusion about it. The CDN not-popular
 * case is handled in cdn-lookup.js, which already runs after classifyBundled. No-op
 * without a bundled store or vendor results.
 * @param {Addon} addon
 */
export function applyUnverifiedVendor(addon) {
  const results = addon?.vendor?.results;
  if (!results || !addon.bundled) {
    return;
  }
  const remaining = [];
  for (const result of results) {
    if (!UNVERIFIED_OUTCOMES.has(result.outcome)) {
      remaining.push(result);
      continue;
    }
    // Only files whose CONTENT is reviewed have anything to reconcile. A folder
    // declaration covers whatever sits under it - fonts, images, JSON - and nothing
    // reads those, so there is no exemption to withdraw and no readable/unreadable
    // question to answer. Judging them anyway called a one-line .woff2 "minified"
    // and rejected the add-on for it.
    if (!CODE_EXTENSIONS.has(extname(result.path))) {
      continue;
    }
    const buf = addon.files?.get(result.path);
    const content = buf
      ? classify(buf.toString("utf8"), result.path)
      : { minified: false, obfuscation: VERDICT.PASS };
    markUntrusted(addon, {
      file: result.path,
      source: result.source,
      unreadable: content.minified || content.obfuscation.fail,
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
  // The pipeline pre-classifies the review target in setup (and, in SCA, the built XPI
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
 * Content verdicts for inline `<script>` bodies, one entry per site.
 *
 * classifyFiles tags FILES, and an inline script is not one - so the same bytes that
 * are rejected as unreviewable beside a page went unasked inside it. The body ships and
 * runs exactly like a .js file's, so both questions have to be put to the extracted
 * SOURCE, which is where the code is. The verdicts come from the same two detectors
 * classifyFiles uses, so "minified" and "obfuscated" keep one definition each.
 *
 * The floor applies to the OBFUSCATION half only, as for files: the minified question
 * is statement density, which does not lose precision on a short body, and a page's
 * scripts must not become invisible by being cut small. `skip` is the non-authored set - an inline script in a vendored or library
 * page is no more the developer's than the page around it. No library/untrusted
 * tagging: those come from hashing a FILE against the known-library database, and an
 * inline body is not one, so every hit here is the developer's own code.
 * @param {import("../addon/sources.js").JsSource[]} sources
 * @param {Set<string>} [skip]  Non-authored paths.
 * @returns {{file: string, loc: {line: number, column: number}, minified: boolean,
 *   obfuscation: import("./enum.js").Verdict}[]}
 */
export function classifyInlineSources(sources, skip = new Set()) {
  const out = [];
  for (const src of sources) {
    if (!src.inline || skip.has(src.file)) {
      continue;
    }
    // Floor as in classifyFiles: it bounds the obfuscation detector, not the minified
    // question - which is why a page's inline bodies cannot be shrunk below it to hide
    // packed code.
    const small = Buffer.byteLength(src.code, "utf8") < MIN_CLASSIFY_BYTES;
    // The parse hint is the source's own (`parseAs`), never the container's path: a
    // Vue <script lang="ts"> lives in a .vue, and judging it by that extension parses
    // it as plain JS, fails, and reports an ordinary component as packed code. This is
    // the hint every other consumer uses (src/checks/extract.js parseHint).
    const hint = src.parseAs ?? src.file;
    out.push({
      file: src.file,
      loc: { line: src.lineOffset + 1, column: 0 },
      minified: isMinifiedJs(src.code, hint, {
        // A body the tag declares as JavaScript and that will not parse is packed or
        // broken - the file default. One the tag declares as something else is data
        // the browser never runs, and calling it minified rejects an add-on for
        // shipping a template. Anything that PARSES is judged whatever its type says,
        // so the type list can never hide code (see declaresJs).
        unparsableIsMinified: src.declaredJs !== false,
      }),
      obfuscation: small ? VERDICT.PASS : obfuscationVerdict(src.code, hint),
    });
  }
  return out;
}

/**
 * classifyInlineSources for a check's routed artifact, computed ONCE per review and
 * shared - the module's compute-once contract, the same one classifyAddonJs keeps.
 * Read at CHECK time on purpose: applyUnverifiedVendor removes a readable unverifiable
 * page from the non-authored set after classification, and its inline scripts are then
 * the developer's to answer for.
 * @param {RunContext} ctx
 * @returns {ReturnType<typeof classifyInlineSources>}
 */
export function classifyInlineScripts(ctx) {
  const bundled = getBundled(ctx);
  return (bundled.inline ??= classifyInlineSources(
    ctx.jsSources ?? [],
    bundled.nonAuthored
  ));
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
 * A minified first-party file: minified geometry, not a recognized library, not
 * obfuscated, not an identified-but-untrusted match - exactly what minified-code flags.
 * @param {BundleTag} c
 * @returns {boolean}
 */
export function isMinifiedFirstParty(c) {
  return Boolean(
    c.minified && !c.library && !c.obfuscation.fail && !c.untrusted
  );
}

/**
 * An obfuscated first-party file: the FAIL verdict, on the developer's own code (not a
 * recognized library, not an identified-but-untrusted match). Read by hasUnreviewableCode
 * to decide whether the shipped XPI carries developer-authored obfuscated code, so the
 * source-archive review is kept: a recognized library is reviewable by its identity, and
 * an untrusted match is counted by its own branch there.
 * @param {BundleTag} c
 * @returns {boolean}
 */
export function isObfuscatedFirstParty(c) {
  return Boolean(c.obfuscation.fail && !c.library && !c.untrusted);
}

/**
 * Whether the add-on ships code that cannot be reviewed as-is: minified or obfuscated
 * first-party code, or an identified-but-untrusted library that is unreadable. The union
 * of what minified-code / obfuscated-code / untrusted-minified-library flag, so the
 * pipeline's "is the shipped XPI directly reviewable?" decision and those checks share one
 * definition. Note WHEN the pipeline reads this: applyUnverifiedVendor runs inside
 * identifyBundledLibraries, which precedes resolveReviewMode, so the untrusted list is
 * already filled at the mode decision. An unverifiable, unreadable vendored file
 * therefore counts as unreviewable code and keeps a source-archive review - which is
 * the point: if we could neither read nor check that file, the source archive is
 * exactly what the reviewer needs.
 * @param {?Bundled} bundled  A classifyBundled result.
 * @returns {boolean}
 */
export function hasUnreviewableCode(bundled, addon) {
  if (!bundled) {
    return false;
  }
  const classified = bundled.classified ?? [];
  if (
    classified.some(isMinifiedFirstParty) ||
    classified.some(isObfuscatedFirstParty) ||
    (bundled.untrusted ?? []).some((lib) => lib.unreadable)
  ) {
    return true;
  }
  // Code shipped INSIDE a page counts too. Without this the report contradicts itself:
  // minified-code tells the developer to send the readable original while
  // sca-not-required tells them the source archive was not needed - and the archive
  // they did send is discarded at the moment it is what the reviewer needs.
  return addon
    ? classifyInlineSources(collectJsSources(addon), bundled.nonAuthored).some(
        (site) => site.minified || site.obfuscation.fail
      )
    : false;
}

/**
 * The CONTENT signal for one file: whether it is minified (packed code, via isMinified)
 * and its obfuscation verdict (a recognized obfuscator's AST structure, via
 * obfuscationVerdict). Library detection is NOT here - it is a true content-hash match
 * against the known-library database, done in classifyBundled. Pure (bytes + filename
 * only; both detectors parse `text` internally, offline).
 * @param {string} text
 * @param {string} file
 * @returns {{minified: boolean, obfuscation: import("./enum.js").Verdict}}
 */
export function classify(text, file, { detectObfuscation = true } = {}) {
  // Obfuscation is JS-only (a stylesheet is never obfuscated in this sense); isMinified
  // handles both JS (statement density) and CSS (packed rules). The verdict is three-state:
  // a weak-family-only match is UNSURE (readable, authored, scanned) and referred to the
  // obfuscated-code check's a reviewer's judgement, never a deterministic finding.
  return {
    minified: isMinified(text, file),
    obfuscation:
      detectObfuscation && JS_EXTENSIONS.has(extname(file))
        ? obfuscationVerdict(text, file)
        : VERDICT.PASS,
  };
}
