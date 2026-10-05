// THE ONE PLACE JSON IS PARSED, plus JSON canonicalization for the schema merger.
//
// Two readers, and the only `JSON.parse` calls in src/ - eslint refuses another one anywhere
// else (no-restricted-syntax, eslint.config.js). `parseJson` reads plain JSON (a package
// file, a lock, our own state). `parseExtensionJson` reads a file the way Thunderbird's
// extension loader does - manifest.json, an Experiment's schemas, _locales messages - which
// is plain JSON plus `//` comments, so what reviews clean is JSON the application reads.
// The annotated API schemas (our own input) go through it too: they parse with it. That rule exists because the alternative
// was tried and failed repeatedly: a reader that parses for itself carries its own
// tolerances, and the one every hand-written reader forgot was the BOM. `JSON.parse` throws
// on a leading BOM while every tool that writes and reads these files does not, so a
// perfectly good file read as absent - silently, because "absent" is each reader's empty
// case. That defect shipped four separate times in four separate readers (an Experiment
// schema, a build package file, an install-hook package file, a package-manager
// fingerprint), each time invisible to a green suite. One parser cannot drift from itself.
//
// Belongs here: turning bytes or text into a value (parseJson, parseExtensionJson), the BOM
// and comment handling that needs (stripBom), and deterministic JSON shaping (sortKeys,
// canonicalJson). Does NOT belong
// here: what a parsed value MEANS - a package.json's declarations are src/vendor/package-file.js,
// a lock's are src/vendor/locks.js, a check's comparison is that check - and user-facing
// JSON report output, which is src/report/*.

import { rethrowIfFatal } from "../lib/errors.js";

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
  } catch (err) {
    rethrowIfFatal(err);
    return null;
  }
}

/**
 * Parse a file the way Thunderbird's extension loader reads it, or `undefined` when it would
 * not load it.
 *
 * Gecko reads manifest.json, an Experiment's schemas and `_locales` messages through one
 * function (ExtensionData.readJSON, toolkit/components/extensions/Extension.sys.mjs): it
 * removes `//` comments outside strings, refuses any other `/` there (so no block
 * comments), then calls JSON.parse - which refuses a trailing comma, an unquoted key and a
 * single-quoted string. This is that same syntax, and bytes are decoded the way Gecko decodes
 * them (decodeExtensionText).
 *
 * UNDEFINED is the failure value, not null: a JSON text may be `null`, and a manifest.json
 * holding it parses - it is just not a manifest object.
 * @param {Buffer|string|null|undefined} input  Bytes or text.
 * @returns {*}  The parsed value, or undefined.
 */
export function parseExtensionJson(input) {
  // Bytes lose their one BOM in decoding; a string is the file's text with its BOM, if any.
  // Never two: a second U+FEFF is text, and JSON.parse refuses it, as Thunderbird does.
  const text =
    typeof input === "string"
      ? stripBom(input)
      : input && decodeExtensionText(input);
  if (text == null) {
    return undefined;
  }
  const json = withoutLineComments(text);
  if (json === null) {
    return undefined;
  }
  try {
    return JSON.parse(json);
  } catch (err) {
    rethrowIfFatal(err);
    return undefined;
  }
}

/**
 * Decode a file's bytes the way Thunderbird's extension loader does, or `undefined` when it
 * would refuse them. Gecko reads these files as UTF-8 with no replacement character, so one
 * invalid byte (a Latin-1 "é") refuses the whole file, and its decoder sniffs a byte-order
 * mark first: a UTF-16 BOM reads the file as UTF-16, a UTF-8 BOM is dropped. It reads the
 * file in one pass that never flushes, so an incomplete sequence at the very end (half a
 * UTF-8 character, an odd UTF-16 byte, a lone high surrogate) is dropped, not refused.
 * @param {Uint8Array} bytes
 * @returns {string|undefined}
 */
export function decodeExtensionText(bytes) {
  let encoding = "utf-8";
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    start = 3;
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    start = 2;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    start = 2;
  }
  try {
    return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(start),
      { stream: true }
    );
  } catch (err) {
    rethrowIfFatal(err);
    return undefined;
  }
}

/**
 * `text` with its `//` comments removed, or null where Thunderbird would refuse it: a `/`
 * outside a string that does not start a comment, or a string that never ends. A port of
 * Gecko's stripCommentsFromJSON, scanning left to right and skipping over strings, so a `//`
 * inside one (a URL) is text.
 * @param {string} text @returns {?string}
 */
function withoutLineComments(text) {
  let out = "";
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let escaped;
      do {
        i = text.indexOf('"', i + 1);
        if (i === -1) {
          return null;
        }
        // Escaped when an odd run of backslashes stands right before it.
        escaped = false;
        for (let k = i - 1; text[k] === "\\"; k--) {
          escaped = !escaped;
        }
      } while (escaped);
    } else if (c === "/") {
      if (text[i + 1] !== "/") {
        return null;
      }
      const end = text.indexOf("\n", i + 2);
      out += text.slice(from, i);
      if (end === -1) {
        return out;
      }
      from = end;
      i = end;
    }
  }
  return out + text.slice(from);
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
