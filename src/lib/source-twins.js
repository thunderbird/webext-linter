// Does every script the add-on SHIPS also exist, unchanged, in the source archive it
// was submitted with?
//
// Belongs here: the cross-artifact comparison of two loaded addons' file maps. Does NOT
// belong here: what the answer is used for (-> resolveXpiOnlyAdvice in src/pipeline.js),
// the single-artifact "can this file be read?" question (-> src/lib/bundled.js), or any
// path/extension string helper (-> src/util/files.js).
//
// Three decisions this module is built on, each load-bearing:
//
//  - MATCH BY BASENAME, NOT PATH. The name only SELECTS candidates - bytes decide - so
//    `file-a.js` is never compared against `file_b.js`, and the comparison survives the
//    two layouts that differ between an archive and an XPI for reasons that are not the
//    build: a wrapper directory (`repo-main/`, GitHub's "Download ZIP") and a build that
//    relocates a file it copied verbatim (`submodules/x/y.js` -> `extlib/y.js`).
//
//  - RAW BYTES. Buffer.equals, never an EOL-normalizing digest. Normalizing produces MORE
//    matches, and a false match says "your source is the shipped code" when it is not -
//    the careless direction. A false MISMATCH only withholds advice, which costs nothing.
//
//  - EXTENSION, NOT A PARSER. src/parse/ast.js could tell us whether a file parses as JS,
//    but that cannot discriminate here (a webpack bundle and a minified blob both parse
//    perfectly), and a parse failure would REMOVE a file from the set that needs a twin -
//    again the careless direction. JS_EXTENSIONS is the codebase's one definition of
//    "this is JS", and it already covers .cjs/.jsm/.es6, so an add-on whose code is
//    entirely .cjs cannot pass for free.

import { basename, extname } from "node:path";

import { JS_EXTENSIONS } from "../util/files.js";

/** @typedef {{file: string, reason: "absent"|"differs"}} Untwinned  One shipped script
 *   with no identical counterpart: `absent` - the archive holds no file of that name at
 *   all; `differs` - it holds one or more, and none matched byte for byte. */

/**
 * The shipped scripts that have no byte-identical same-named file in the source archive.
 *
 * Indexes the archive by lowercased basename FIRST, then does one lookup per shipped
 * script: a 2,000-file archive against a 10-file XPI costs 10 lookups and ~10 compares,
 * not 20,000. Lowercasing only widens the candidate set (a source checked out on a
 * case-insensitive filesystem can present `Background.js` for a stored `background.js`);
 * content still decides, so it cannot create a false match on its own.
 *
 * @param {Map<string, Buffer>} shipped  The built XPI's files.
 * @param {Map<string, Buffer>} source  The archive's files, keyed relative to
 *   --sca-source.
 * @param {{exempt?: Set<string>}} [opts]  `exempt` names shipped paths that need no twin
 *   - ONLY the content-hash-identified libraries; see the caller for why a VENDOR
 *   declaration must never reach this set.
 * @returns {Untwinned[]}  Empty when every shipped script is accounted for.
 */
export function untwinnedShippedJs(shipped, source, { exempt } = {}) {
  /** @type {Map<string, Buffer[]>} */
  const byName = new Map();
  for (const [file, buf] of source ?? []) {
    if (!JS_EXTENSIONS.has(extname(file).toLowerCase())) {
      continue;
    }
    const key = basename(file).toLowerCase();
    const bucket = byName.get(key);
    if (bucket) {
      bucket.push(buf);
    } else {
      byName.set(key, [buf]);
    }
  }

  /** @type {Untwinned[]} */
  const untwinned = [];
  for (const [file, buf] of shipped ?? []) {
    if (!JS_EXTENSIONS.has(extname(file).toLowerCase()) || exempt?.has(file)) {
      continue;
    }
    const candidates = byName.get(basename(file).toLowerCase());
    if (!candidates) {
      untwinned.push({ file, reason: "absent" });
      continue;
    }
    // Length first: it rejects almost every non-match without touching the bytes.
    if (!candidates.some((c) => c.length === buf.length && c.equals(buf))) {
      untwinned.push({ file, reason: "differs" });
    }
  }
  return untwinned;
}
