// Shared, hash-free heuristics for the missing-library, minified-code and obfuscated-code
// checks. Without a library-hash database these cannot identify a specific
// library or verify a version - they only classify each JS or CSS file by
// surface signals (a vendored bootstrap.min.css is a library just as a bundled
// jquery.min.js is). A file is examined once and tagged
// { library, minified, obfuscated }.
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
// missing-library, minified-code and obfuscated-code rules under src/checks/rules/*. Resolving
// the vendored set it builds on (addon.vendor.set) - src/vendor/resolve.js.
// Extension-set helpers - src/util/files.js.

import { extname, JS_EXTENSIONS, CSS_EXTENSIONS } from "../../util/files.js";
import { isVendored } from "../../vendor/resolve.js";
import { parseJs, traverse } from "../../parse/ast.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../../addon/load.js").Addon} Addon */
/** @typedef {{file: string, library: boolean, minified: boolean,
 *   obfuscated: boolean}} BundleTag */
/** @typedef {{classified: BundleTag[], nonAuthored: Set<string>}} Bundled */

// Known third-party library filename stems (a strong "this is a library" hint).
const LIB_NAME =
  /(^|\/)(jquery|angular|react|react-dom|vue|lodash|underscore|backbone|moment|bootstrap|d3|zepto|axios|preact|three|chart|ical)[.\-]/i;

/**
 * Classify the add-on's JS and CSS once: per-file surface-signal tags plus the
 * not-the-developer's-source skip set. Pure and addon-keyed, so the pipeline can
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
    const text = buf.toString("utf8");
    if (text.length < 1024) {
      continue; // too small to be a bundled library or a worrying blob.
    }
    const tag = { file, ...classify(text, file) };
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
 * The content signal for one file: whether it looks like a distributed third-party
 * library, is minified, or is obfuscated. Pure (bytes + filename only), so the
 * VENDOR parser reuses it to tell a vendored library from the add-on's own code.
 * @param {string} text
 * @param {string} file
 * @returns {{library: boolean, minified: boolean, obfuscated: boolean}}
 */
export function classify(text, file) {
  // The UMD-wrapper and obfuscation signals below are JS-only - a stylesheet has
  // no module wrapper and is never "obfuscated" in the packer sense - so gate
  // them. The name (.min.*, library stem) and geometry signals apply to JS and
  // CSS alike (a vendored bootstrap.min.css trips them just as jquery does).
  const isJs = JS_EXTENSIONS.has(extname(file));

  // No "/*!" license-banner signal: a preserved comment is a weak, fragile proxy -
  // it missed real banners not at byte 0 (`;/*!`, `@charset"…";\n/*!`) and tripped
  // on a developer's own "/*!" - so a bundled library is recognized only by its
  // distribution name, a known stem, a UMD wrapper, or minified geometry (plus the
  // authoritative VENDOR.md declaration, isVendored in classifyBundled). A library
  // the strong signals miss is scanned; the resulting finding prompts the developer
  // to declare it.
  const library =
    /\.min\.(?:js|css)$/i.test(file) ||
    LIB_NAME.test(file) ||
    (isJs && /\btypeof exports\b/.test(text) && /\btypeof define\b/.test(text)); // UMD

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

  return { library, minified, obfuscated };
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
