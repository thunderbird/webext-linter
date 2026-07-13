// The single seam for JavaScript-obfuscation detection: whether a file's source is
// the output of a known obfuscator. Wraps the `obfuscation-detector` library
// (HumanSecurity), which classifies source by the AST STRUCTURE of seven obfuscator
// families (obfuscator.io, array/function replacements, caesar-plus) and returns an
// empty list for anything it does not recognize. Structural recognition is precise by
// construction: readable third-party code and plain-minified libraries match no family,
// so they are never called obfuscated - the failure mode of a token-presence heuristic.
//
// Minification is a SEPARATE, geometric signal (src/lib/bundled.js classify) and
// is deliberately not decided here: a minified-but-clean library is allowed with source,
// only obfuscation is forbidden outright.
//
// Belongs here: the library import and the boolean adapter. Does NOT belong here: the
// per-file library/minified tagging and the non-authored skip set (src/lib/
// bundled.js), the obfuscated-code finding (src/checks/rules/obfuscated-code.js), or the
// library's own AST parse (it parses internally, offline and pure - no network).

import { detectObfuscation } from "obfuscation-detector";
import { debug } from "../util/log.js";

/**
 * Whether `text` is the output of a recognized JavaScript obfuscator.
 * @param {string} text  JavaScript source.
 * @param {string} [file]  The file path, for the debug log on a parse failure.
 * @returns {boolean}  true when a known obfuscator family is detected.
 */
export function isObfuscated(text, file) {
  try {
    return detectObfuscation(text).length > 0;
  } catch (err) {
    // The detector parses internally; source it cannot parse is not a recognized
    // obfuscation (a genuinely obfuscated file that also fails to parse is the
    // minified-code check's concern, not a false obfuscation finding). Logged so a
    // silent skip is diagnosable under --debug.
    debug(
      `obfuscation-detector could not parse ${file ?? "source"}: ${err.message}`
    );
    return false;
  }
}
