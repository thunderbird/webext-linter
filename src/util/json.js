// JSON canonicalization for the schema merger: deep-sort object keys so
// deeply-equal values serialize to identical bytes.
//
// Belongs here: deterministic JSON shaping (sortKeys, canonicalJson) and the
// tiny shared JSON-text helper stripBom (used by the trusted-upstream JSON5
// readers in src/schema and src/experiments, and by every reader of a
// submission's dependency manifest or lock file - src/vendor/*, src/addon/load.js).
// Does NOT belong here: PARSING JSON/JSON5 text from a submission - stripBom only
// prepares the text, and who parses it is each reader's own business. Diffing or
// comparing two values for a check belongs to that check (src/checks/rules/*).
// User-facing JSON report output is src/report/*.

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
 * Drop a leading UTF-8 BOM so a parser sees clean text.
 *
 * Not cosmetic for a submission's files: `JSON.parse` THROWS on a BOM while the
 * tools that read the same file do not (npm parses through it, editors write it),
 * so a reader that skips this treats a perfectly good manifest or lock as absent -
 * silently, since every one of those reads falls back to "nothing declared".
 * @param {string} text @returns {string}
 */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
