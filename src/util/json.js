// THE ONE PLACE JSON IS PARSED, plus JSON canonicalization for the schema merger.
//
// `parseJson` is the only `JSON.parse` in src/, and eslint refuses another one anywhere
// else (no-restricted-syntax, eslint.config.js). That rule exists because the alternative
// was tried and failed repeatedly: a reader that parses for itself carries its own
// tolerances, and the one every hand-written reader forgot was the BOM. `JSON.parse` throws
// on a leading BOM while every tool that writes and reads these files does not, so a
// perfectly good file read as absent - silently, because "absent" is each reader's empty
// case. That defect shipped four separate times in four separate readers (an Experiment
// schema, a build package file, an install-hook package file, a package-manager
// fingerprint), each time invisible to a green suite. One parser cannot drift from itself.
//
// Belongs here: turning bytes or text into a value (parseJson), the BOM handling that needs
// (stripBom), and deterministic JSON shaping (sortKeys, canonicalJson). Does NOT belong
// here: what a parsed value MEANS - a package.json's declarations are src/vendor/package-file.js,
// a lock's are src/vendor/locks.js, a check's comparison is that check - and user-facing
// JSON report output, which is src/report/*.

/**
 * Recursively sort object keys (array order is preserved). The result
 * serializes byte-identically for deeply-equal inputs.
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = sortKeys(value[k]);
    }
    return out;
  }
  return value;
}

/**
 * Canonical JSON text (sorted keys) of a value, for deep-equality comparison.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

/**
 * Parse JSON from a submission's bytes or any text, or null when it cannot be read.
 *
 * NULL, never a throw, for every failure alike - absent, empty, malformed, or the wrong
 * type. Each caller already has a meaning for "nothing here", and the ones that owe the
 * user a message raise their own from the null rather than re-wording a parser's.
 *
 * A Buffer is decoded as UTF-8, which is what every file this reads is written in.
 * @param {Buffer|string|null|undefined} input  Bytes or text.
 * @returns {*}  The parsed value, or null.
 */
export function parseJson(input) {
  const text = typeof input === "string" ? input : input?.toString("utf8");
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(stripBom(text));
  } catch {
    return null;
  }
}

/**
 * Drop a leading UTF-8 BOM so a parser sees clean text.
 *
 * Not cosmetic for a submission's files: `JSON.parse` THROWS on a BOM while the
 * tools that read the same file do not (npm parses through it, editors write it),
 * so a reader that skips this treats a perfectly good package file or lock as absent -
 * silently, since every one of those reads falls back to "nothing declared".
 * @param {string} text @returns {string}
 */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
