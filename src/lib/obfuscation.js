// The single seam for JavaScript-obfuscation detection: whether a file's source is
// the output of a known obfuscator. Wraps the `obfuscation-detector` library
// (HumanSecurity), which recognizes obfuscator families by the AST STRUCTURE they
// leave behind. Structural recognition is precise by construction: readable
// third-party code and plain-minified libraries match none of the families we ask
// about, so they are never called obfuscated - the failure mode of a token-presence
// heuristic.
//
// The families we ask about are PINNED (PINNED_FAMILIES below), and that is the
// module's central decision. The library ships more detectors than we consult and
// gains new ones in minor releases; a family we have not reviewed decides nothing,
// so an upstream addition can neither reject an add-on nor reach a reviewer. The
// pinning has a price, paid deliberately: a pinned family the library no longer
// has is a verdict we can no longer produce, so it throws rather than quietly
// narrowing what we reject on.
//
// Minification is a SEPARATE signal (statement density - src/lib/minified.js, applied
// per file by src/lib/bundled.js classify) and is deliberately not decided here: a minified-but-clean library is allowed with source,
// only obfuscation is forbidden outright.
//
// Belongs here: the library import, the pinned family list, the flAST parse the detectors
// read (offline and pure - no network), and the obfuscation verdict. The family names
// never leave this module - callers branch on the verdict, not the families. Does NOT
// belong here: the per-file library/minified tagging and the non-authored skip set
// (src/lib/bundled.js), or the obfuscated-code finding
// (src/checks/rules/obfuscated-code.js).

import { getDetectorMap } from "obfuscation-detector/src/detectors/index.js";
import { generateFlatAST } from "flast";
import { debug, isVerbose } from "../util/log.js";
import { VERDICT } from "./enum.js";

// The obfuscator families whose structural match rejects an add-on. Every other family the
// library ships is excluded on evidence, not by oversight. Measured over 14011 JS files
// from 1543 submitted add-ons, these eight matched nothing in it while every excluded
// family matched something: `cff_storage_object` (an object whose keys are mostly five
// letters long) 1731, `function_to_array_replacements` (the ordinary revealing module
// pattern `const X = (() => {...})(); X.init();`, to which it applies none of the
// reference-density thresholds the others do) 255, `js_confuser_string_bank` 189,
// `sequenced_index_switch` 14 and `js_confuser_state_machine` 1. Adding a family here
// means reading it and measuring it first, never inheriting it from a release.
//
// Membership only: the ORDER they are asked in comes from the library's own registry
// (pinnedDetectors below), because it is load-bearing - `obfuscator_io` has two
// heuristics, and the first is only reachable when `augmented_array_function_replacements`
// is already among the families handed to it.
const PINNED_FAMILIES = new Set([
  "array_replacements",
  "array_function_replacements",
  "augmented_array_replacements",
  "augmented_array_function_replacements",
  "proxied_array_function_replacements",
  "augmented_proxied_array_function_replacements",
  "obfuscator_io",
  "caesar_plus",
]);

// Resolved once: the library rebuilds its registry on every getDetectorMap() call.
let pinned = null;

/**
 * The pinned detectors, in the library's REGISTRY ORDER - read from the map's own iteration
 * order, so the order a release chooses is the order they are asked in rather than a second
 * copy of it kept here that could drift out of step.
 *
 * A pinned family the library no longer has throws: the question can no longer be put, and
 * answering it "no" by default would silently shrink what the review rejects on.
 * @returns {[string, {detect: Function}][]}
 */
function pinnedDetectors() {
  if (pinned) {
    return pinned;
  }
  const map = getDetectorMap();
  const missing = [...PINNED_FAMILIES].filter((name) => !map.has(name));
  if (missing.length) {
    const names = missing.map((n) => `"${n}"`).join(", ");
    const one = missing.length === 1;
    throw new Error(
      `obfuscation-detector no longer has the pinned ${one ? "family" : "families"} ${names}, so ${one ? "its verdict is" : "their verdicts are"} missing`
    );
  }
  pinned = [...map].filter(([name]) => PINNED_FAMILIES.has(name));
  return pinned;
}

/**
 * Whether one pinned family matches `tree`. An answer that is not a boolean throws - the
 * detector's contract has changed and we no longer know what it told us. A detector that
 * throws ON THIS INPUT is a different thing and does not - see below.
 * @param {string} name  The family's name, for the messages.
 * @param {{detect: Function}} detector  Its detector, from pinnedDetectors().
 * @param {object[]} tree  A non-empty flAST tree.
 * @param {string[]} matched  The pinned families that already matched, in order.
 * @returns {boolean}
 */
function familyMatches(name, detector, tree, matched) {
  let answer;
  try {
    answer = detector.detect(tree, matched);
  } catch (err) {
    // The library guards every detector this way, because several of them dereference AST
    // fields that ordinary source leaves empty - the hole in a sparse array literal is a
    // null element, a destructuring declaration has no `id.name`. A throw here is that
    // bug meeting this file, not a statement about the add-on and not the contract break
    // the missing-family throw above exists for, so the family simply does not match.
    // Refusing to review the submission over it would reject legitimate add-ons.
    debug(
      `obfuscation: the family "${name}" failed on this source: ${err.message}`
    );
    return false;
  }
  if (typeof answer !== "boolean") {
    throw new Error(
      `obfuscation-detector answered the family "${name}" with ${typeof answer}, not a verdict`
    );
  }
  return answer;
}

/**
 * The pinned families `text` matches (empty for anything we do not recognize), each one
 * asked in turn. Logged under --verbose so a surprising verdict - either way - is
 * diagnosable.
 * @param {string} text  JavaScript source.
 * @param {string} [file]  The file path, for the debug log.
 * @returns {string[]}  The matched family names.
 */
function detectFamilies(text, file) {
  const where = file ?? "source";
  let tree;
  try {
    tree = generateFlatAST(text);
  } catch (err) {
    debug(`obfuscation: ${where} could not be parsed: ${err.message}`);
    return [];
  }
  // The parser reports source it cannot read as an EMPTY tree rather than by throwing, and
  // every detector reads the tree's root. Source that does not parse is not a recognized
  // obfuscation - a genuinely obfuscated file that also fails to parse is the
  // minified-code check's concern, not a false obfuscation finding - so no family is
  // asked and none is therefore missing.
  if (!tree.length) {
    debug(`obfuscation: ${where} does not parse, so no family was asked`);
    return [];
  }
  const detectors = pinnedDetectors();
  const matched = [];
  for (const [name, detector] of detectors) {
    if (familyMatches(name, detector, tree, matched)) {
      matched.push(name);
    }
  }
  if (isVerbose()) {
    debug(
      `obfuscation families for ${where}: ${detectors
        .map(([n]) => `${n}=${matched.includes(n)}`)
        .join(", ")}`
    );
    logUnpinnedFamilies(tree, where, matched);
  }
  return matched;
}

/**
 * Report which UNPINNED families match, under --verbose only. They decide nothing, and that
 * is the point: this log is the only trace that the library saw something we ignore, so a
 * detector added upstream is diagnosable from a verbose run instead of by bisecting
 * versions.
 *
 * A SEPARATE pass from the verdict, deliberately. Detectors may consult the families
 * already matched, so folding the two together would let an unpinned match enter the list a
 * pinned detector reads - and a verdict that changes under --verbose is not a verdict.
 * @param {object[]} tree  A non-empty flAST tree.
 * @param {string} where  The file path, for the log line.
 * @param {string[]} pinnedMatches  The pinned families that matched, seeding the list the
 *   detectors are handed - the closest this pass can stand to the library's own view.
 */
function logUnpinnedFamilies(tree, where, pinnedMatches) {
  const seen = [...pinnedMatches];
  const matched = [];
  for (const [name, detector] of getDetectorMap()) {
    if (PINNED_FAMILIES.has(name)) {
      continue;
    }
    // Diagnostics, not a verdict, so an unpinned family that fails is skipped rather than
    // being allowed to take the review down.
    try {
      if (detector.detect(tree, seen)) {
        seen.push(name);
        matched.push(name);
      }
    } catch (err) {
      debug(`obfuscation: unpinned family "${name}" failed: ${err.message}`);
    }
  }
  if (matched.length) {
    debug(
      `obfuscation: unpinned families matching ${where} (ignored): ${matched.join(", ")}`
    );
  }
}

/**
 * The obfuscation verdict for one JavaScript file, a shared VERDICT: FAIL (a pinned family
 * matched its structure) or PASS (none did, or the source does not parse). The family list
 * stays inside this module - callers branch on the verdict, not the families. Throws when
 * a pinned family is gone from the library, which aborts the review rather than
 * understating it.
 * @param {string} text  JavaScript source.
 * @param {string} [file]  The file path, for the debug log.
 * @returns {import("./enum.js").Verdict}
 */
export function obfuscationVerdict(text, file) {
  return detectFamilies(text, file).length ? VERDICT.FAIL : VERDICT.PASS;
}
