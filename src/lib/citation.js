// Verifying the cited evidence a post-summary PASS must supply. A recheck consumer
// that requires citation (registry `require-citation: true`) accepts a `pass` only
// when the model points at a real, locatable usage; an ungrounded pass is downgraded
// to unsure -> manual by the consumer. This module owns the ADJUDICATION only; the
// decision to require it, and the unsure downgrade, live in resolveRecheck.
//
// The check is deliberately generic - it names no consumer and no permission:
//   - structural (always): the cited file is in the corpus and, for a
//     line-numbered file, the cited line(s) are in range;
//   - token (only when the item carries an accepted-token vocabulary): the cited
//     token is one of the accepted tokens AND appears - on a word boundary,
//     case-sensitive, the same matcher presentTokens uses - in the file's real code
//     AND within the cited raw line(s). "Real code" is the same surface presentTokens
//     grounds on: a parsed JS source's comment-free atoms (via codeTextOf), or the
//     manifest JSON. A non-JS file (.css, markup, prose) contributes no code, so a
//     token can never be grounded in it - a citation must point at code the
//     deterministic scanner also trusts.
//
// Honest boundary: this catches an ungrounded / hallucinated pass (no evidence, an
// invalid token, a token that is absent or comment-only, a wrong line). It does NOT
// judge whether the real usage means what the rubric asks - that stays the model's
// call. The line precision is only as strong as the raw-line test, and a token that
// is both a comment on the cited line AND real code elsewhere in the file passes.
//
// The manifest is shown to the model as a single-line canonicalJson MANIFEST block
// (JSON.stringify, no indentation), so it has no per-key line to cite: a manifest-key
// token (compose_scripts) is verified by presence in that same canonical text, not by
// line - the only file without a line requirement.

import { codeTextOf } from "../checks/extract.js";
import { canonicalJson } from "../util/json.js";
import { wholeWordRe } from "./util.js";

/** @typedef {import("../checks/registry.js").RunContext} RunContext */
/** @typedef {import("../llm/schema.js").RecheckUsage} RecheckUsage */

/**
 * Does `token` occur in `text` as a whole word (case-sensitive)? Uses the shared
 * wholeWordRe - the same word-boundary test presentTokens uses - so a citation
 * grounds a permission by exactly the spellings the registry lists (`folder` does
 * not match `displayedFolder`).
 * @param {string} token @param {string} text
 * @returns {boolean}
 */
function wordPresent(token, text) {
  return wholeWordRe(token).test(text);
}

/**
 * Parse a cited `lines` string - a single 1-based line ("42") or an inclusive range
 * ("40-45") - into {start, end}, or null when it is malformed or inverted.
 * @param {unknown} lines
 * @returns {?{start: number, end: number}}
 */
function parseLineRange(lines) {
  if (typeof lines !== "string") {
    return null;
  }
  const m = lines.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (!m) {
    return null;
  }
  const start = Number(m[1]);
  const end = m[2] != null ? Number(m[2]) : start;
  if (start < 1 || end < start) {
    return null;
  }
  return { start, end };
}

/**
 * The corpus text of a cited file: its raw bytes (for the line-range test, matching
 * numberLines' whole-file numbering) and its comment-free code (for the real-code
 * test), or null when the file is not in the corpus. The manifest is the one
 * unnumbered source - it is the canonicalized MANIFEST block, so it is verified by
 * token presence, not by line.
 * @param {RunContext} ctx @param {string} file
 * @returns {?{raw: string, code: string, numbered: boolean}}
 */
function fileTexts(ctx, file) {
  if (file === "manifest.json") {
    // The exact text the model saw in the MANIFEST block, so a cited token is
    // checked against what it was shown (not the raw manifest.json bytes).
    const raw = canonicalJson(ctx.manifest ?? null);
    return { raw, code: raw, numbered: false };
  }
  const buf = ctx.addon?.files?.get(file);
  if (buf == null) {
    return null;
  }
  const raw = buf.toString("utf8");
  // The token-presence surface is the file's REAL CODE only: the comment-free atoms of
  // its parsed JS source(s) - a single .js file has one, an .html page may have several
  // inline scripts. This is exactly what presentTokens grounds a permission on, so a
  // citation grounds by the same rule the deterministic scanner uses. A file with NO
  // parsed source (a .css, .md, markup, or data file) contributes no code text, so a
  // token cannot be grounded in its prose or markup - only its raw line still exists,
  // for a structural-only (no-vocabulary) citation.
  const srcs = (ctx.jsSources ?? []).filter((s) => s.file === file);
  const code = srcs.map((s) => codeTextOf(s)).join("\n");
  return { raw, code, numbered: true };
}

/**
 * Verify the cited evidence backing a `pass`, returning the first usage that checks
 * out (for the feed note) or null when none does.
 * @param {?RecheckUsage[]} usages  The cited usages from the verdict.
 * @param {?Iterable<string>} accepted  The accepted-token vocabulary for this item;
 *   empty/absent means structural verification only.
 * @param {RunContext} ctx  The corpus to verify against - the recheck's producer
 *   artifact (its ctxForRule ctx), the same corpus the summary numbered and showed.
 * @returns {?RecheckUsage}
 */
export function verifyCitation(usages, accepted, ctx) {
  const vocab = accepted ? new Set(accepted) : new Set();
  const requireToken = vocab.size > 0;
  for (const usage of usages ?? []) {
    if (!usage || typeof usage.file !== "string") {
      continue;
    }
    const texts = fileTexts(ctx, usage.file);
    if (!texts) {
      continue; // cited a file that is not in the corpus
    }
    // The raw text to search for the token: the whole file for a numbered source
    // (narrowed to the cited line(s)), or the entire manifest for the unnumbered one.
    let citedRaw = texts.raw;
    if (texts.numbered) {
      const range = parseLineRange(usage.lines);
      if (!range) {
        continue;
      }
      const lines = texts.raw.split("\n");
      if (range.end > lines.length) {
        continue; // cited a line past the end of the file
      }
      citedRaw = lines.slice(range.start - 1, range.end).join("\n");
    }
    if (requireToken) {
      const token = usage.token;
      if (typeof token !== "string" || !vocab.has(token)) {
        continue; // no token, or one outside the accepted vocabulary
      }
      if (!wordPresent(token, texts.code)) {
        continue; // absent from real code (comment-only, or not there at all)
      }
      if (!wordPresent(token, citedRaw)) {
        continue; // not at the cited location
      }
    }
    return usage;
  }
  return null;
}
