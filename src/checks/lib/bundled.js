// Shared, hash-free heuristics for the missing-library and obfuscated-code
// checks. Without a library-hash database these cannot identify a specific
// library or verify a version - they only classify each JS file by surface
// signals. A file is examined once and tagged { library, minified, obfuscated }.
//
// The classification is byte-geometry sensitive (the minification heuristic
// keys off line length), so it is resolved ONCE up front - before the normalizer
// reformats files - by the pipeline into addon.bundled (classifyBundled), the
// same "compute once, checks read it" pattern as addon.vendor. Were it computed
// during the review, build/lint mode (which pretty-prints first) would see an
// undeclared minified library as authored source and miss it.
//
// Belongs here: classifyBundled (the one-shot classification + non-authored skip
// set) and the per-file surface-signal tagging it uses. classifyAddonJs /
// nonAuthoredJs are thin readers of the memoized store. A planned hash-DB
// replacement is tracked in assets/todo - do not edit assets/todo.
//
// Does NOT belong here: the rule verdicts and findings - those live in the
// missing-library and obfuscated-code rules under src/checks/rules/*. Resolving
// the vendored set it builds on (addon.vendor.set) - src/vendor/resolve.js.
// Extension-set helpers - src/util/files.js.

import { extname, JS_EXTENSIONS } from "../../util/files.js";
import { BANNER_SCAN_CHARS } from "../../config.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../../addon/load.js").Addon} Addon */
/** @typedef {{file: string, library: boolean, minified: boolean,
 *   obfuscated: boolean}} BundleTag */
/** @typedef {{classified: BundleTag[], nonAuthored: Set<string>}} Bundled */

// Known third-party library filename stems (a strong "this is a library" hint).
const LIB_NAME =
  /(^|\/)(jquery|angular|react|react-dom|vue|lodash|underscore|backbone|moment|bootstrap|d3|zepto|axios|preact|three|chart|ical)[.\-]/i;

/**
 * Classify the add-on's JS once: per-file surface-signal tags plus the
 * not-the-developer's-source skip set. Pure and addon-keyed, so the pipeline can
 * run it before normalize. The result is stored on addon.bundled.
 *
 * `nonAuthored` is the VENDOR.md-declared third-party files plus any JS tagged
 * library / minified / obfuscated. The source-level finding scanners (the eval
 * checks, unsafe-html, remote-script, code-sanity) skip these to save time
 * and noise - minified or obfuscated code is forbidden anyway (obfuscated-code /
 * missing-library reject it and request the original sources, which are then
 * reviewed), and vendored files are declared third-party. Reachability skips
 * them only when REACHABILITY_SKIPS_NON_AUTHORED is on (src/config.js, off by
 * default), since dropping their loader edges would wrongly orphan what they
 * load.
 *
 * TODO: replace this surface-signal heuristic with a hash-based allow/block
 * list - identify known libraries by content hash to skip, and flag known-bad
 * or vulnerable versions by hash - instead of guessing library/minified/
 * obfuscated. See the dispensary hashes.txt / libraries.json approach in
 * assets/todo.
 *
 * @param {Addon} addon
 * @returns {Bundled}
 */
export function classifyBundled(addon) {
  const vendored = addon.vendor?.set ?? new Set();
  const classified = [];
  const nonAuthored = new Set(vendored);
  for (const [file, buf] of addon.files) {
    if (!JS_EXTENSIONS.has(extname(file)) || vendored.has(file)) {
      continue;
    }
    const text = buf.toString("utf8");
    if (text.length < 1024) {
      continue; // too small to be a bundled library or a worrying blob
    }
    const tag = { file, ...classify(text, file) };
    classified.push(tag);
    if (tag.library || tag.minified || tag.obfuscated) {
      nonAuthored.add(file);
    }
  }
  return { classified, nonAuthored };
}

/**
 * The bundled classification for this review: the pipeline's pre-normalize
 * addon.bundled, or a lazy compute for callers that ran no pre-step (unit tests,
 * which never normalize). Memoized on the addon so the ~8 consumers share it.
 * @param {RunContext} ctx
 * @returns {Bundled}
 */
function getBundled(ctx) {
  return (ctx.addon.bundled ??= classifyBundled(ctx.addon));
}

/**
 * Per-file surface-signal tags for the add-on's JS (see classifyBundled).
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
 * @param {string} text
 * @param {string} file
 * @returns {{library: boolean, minified: boolean, obfuscated: boolean}}
 */
function classify(text, file) {
  const library =
    /\.min\.js$/i.test(file) ||
    LIB_NAME.test(file) ||
    /\/\*!/.test(text.slice(0, BANNER_SCAN_CHARS)) || // minifier banner
    (/\btypeof exports\b/.test(text) && /\btypeof define\b/.test(text)); // UMD

  // Minified line geometry: at least one very long line, dense on average.
  const lines = text.split("\n");
  const maxLine = lines.reduce((m, l) => (l.length > m ? l.length : m), 0);
  const minified = maxLine > 500 && text.length / lines.length > 150;

  // Obfuscation: javascript-obfuscator "_0x...." identifiers in bulk, or an
  // eval/Function-of-decoded-string packer.
  const hexNames = (text.match(/_0x[0-9a-f]{4,}/gi) || []).length;
  const packed =
    (/\beval\s*\(/.test(text) || /\bFunction\s*\(/.test(text)) &&
    (/\batob\s*\(/.test(text) || /String\.fromCharCode/.test(text));
  const obfuscated = hexNames >= 5 || packed;

  return { library, minified, obfuscated };
}
