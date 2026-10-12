// Scans CSS for external references: @import (a CSS *source*, must be bundled) and the
// URLs of url() and image-set() (fonts/images - resources). remote-resources flags the
// remote ones.
//
// Read as the browser reads CSS: by its tokenizer, the first stage of CSS Syntax, here
// css-tree's. The browser never rejects a stylesheet - it skips what it cannot read and
// applies the rest - so neither does this, and a construct a stricter parser refuses is
// still read. The tokenizer leaves comments out of the stream, and takes a url() whose
// argument breaks off as a bad url, which loads nothing. Every name and URL is decoded
// (css-tree's decoders) before it is matched or classified, as the browser decodes CSS
// escapes: `@\69mport` is `@import`, `htt\70://x` is `http://x`.
//
// Belongs here: CSS tokenizing and extraction of @import, url() and image-set()
// references with their kind, line, and URL classification.
//
// Does NOT belong here: deciding which references are violations and the
// reviewer-facing wording - that lives in the checks (src/checks/rules/*) and
// the registry (assets/registry.yaml). URL remote/local classification belongs
// to src/scan/url.js. HTML markup scanning is src/scan/html.js.

import {
  ident,
  string as cssString,
  tokenize,
  tokenTypes,
  url as cssUrl,
} from "css-tree";
import { classifyUrl } from "./url.js";
import { REF_KIND } from "../lib/enum.js";

/**
 * @typedef {object} CssRef
 * @property {import("../lib/enum.js").RefKind} kind  Reference kind.
 * @property {string} url  The referenced URL.
 * @property {import("../lib/enum.js").UrlClass} klass  URL classification.
 * @property {number} line  1-based source line.
 */

/**
 * @param {string} css  CSS source text to scan.
 * @returns {CssRef[]}
 */
export function scanCssRemoteRefs(css) {
  const lineAt = lineCounter(css);
  return urlRefs(css)
    .filter((ref) => ref.url != null)
    .map((ref) => ({
      kind: ref.imported ? REF_KIND.IMPORT : REF_KIND.URL,
      url: ref.url,
      klass: classifyUrl(ref.url),
      line: lineAt(ref.start),
    }));
}

/**
 * All URLs a value loads: each url() argument, and each URL of an image-set(). An
 * unclosed url() at the end counts too, as the browser closes it at the end of the value.
 * @param {string} value  The raw value text.
 * @returns {string[]}
 */
export function urlsIn(value) {
  return urlRefs(value)
    .map((ref) => ref.url)
    .filter((u) => u != null);
}

/**
 * The argument of the unclosed url() a value ends in ("" for a bare `url(`), or
 * null when it has none. A value built as a prefix (`"url(https://h/" + x`)
 * ends this way, and its dynamic tail continues that argument.
 * @param {string} value  The raw value text.
 * @returns {?string}
 */
export function openUrlArg(value) {
  const last = urlRefs(value).at(-1);
  return last?.unclosed ? (last.url ?? "") : null;
}

/**
 * All URLs a CSS declaration list loads (a style attribute or an element's
 * style.cssText). The tokenizer needs no structure around it, so a list is read like any
 * other CSS.
 * @param {string} text  The raw declaration list text.
 * @returns {string[]}
 */
export function declarationUrls(text) {
  return urlsIn(text);
}

/** The CSS functions whose arguments are URLs, by decoded, lower-case name. */
const IMAGE_SETS = new Set(["image-set", "-webkit-image-set"]);

/**
 * A CSS name (an at-keyword's, a function's) as the browser's tokenizer reads it: escapes
 * decoded, and lower-cased, since CSS matches these names without case.
 * @param {string} raw
 * @returns {string}
 */
function decodedName(raw) {
  return ident.decode(raw).toLowerCase();
}

/**
 * The tokens of `text` that carry meaning here, in order: whitespace and comments left out.
 * @param {string} text
 * @returns {{type: number, start: number, end: number}[]}
 */
function tokensOf(text) {
  const tokens = [];
  tokenize(text, (type, start, end) => {
    if (type !== tokenTypes.WhiteSpace && type !== tokenTypes.Comment) {
      tokens.push({ type, start, end });
    }
  });
  return tokens;
}

/**
 * Every URL a stylesheet or value loads, in order: an @import's, each url() argument, and
 * each string or url() of an image-set(). `unclosed` marks a url() the text ends inside,
 * `imported` an @import's. An @import counts only at the top of a sheet, outside every
 * block, which is the only place the browser follows one.
 * @param {string} text
 * @returns {{url: ?string, start: number, unclosed: boolean, imported: boolean}[]}
 */
function urlRefs(text) {
  const tokens = tokensOf(text);
  const raw = (t) => text.slice(t.start, t.end);
  const refs = [];
  let depth = 0;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === tokenTypes.LeftCurlyBracket) {
      depth++;
    } else if (t.type === tokenTypes.RightCurlyBracket) {
      depth = Math.max(0, depth - 1);
    }
    if (
      depth === 0 &&
      t.type === tokenTypes.AtKeyword &&
      decodedName(raw(t).slice(1)) === "import"
    ) {
      const ref = refAt(text, tokens, i + 1);
      if (ref) {
        refs.push({ ...ref, imported: true });
        i = ref.next;
        continue;
      }
    } else if (
      t.type === tokenTypes.Function &&
      IMAGE_SETS.has(fnName(raw(t)))
    ) {
      i = imageSetRefs(text, tokens, i, refs);
      continue;
    } else {
      const ref = urlAt(text, tokens, i);
      if (ref) {
        refs.push({ ...ref, imported: false });
        i = ref.next;
        continue;
      }
    }
    i++;
  }
  return refs;
}

/**
 * The name of a function token, decoded: its text without the opening parenthesis.
 * @param {string} rawToken
 * @returns {string}
 */
function fnName(rawToken) {
  return decodedName(rawToken.slice(0, -1));
}

/**
 * The URL a url() at `i` loads, or null when no url() starts there: a url token, or a
 * function whose decoded name is `url`. The CSS Syntax tokenizer decodes the name before
 * it decides, so `u\72l(` is a url() as much as `url(` is, which css-tree's tokenizer does
 * not do: such a call arrives as a function, and its unquoted argument is read here from
 * the text up to the closing parenthesis, as the url token would have held it.
 * @param {string} text
 * @param {{type: number, start: number, end: number}[]} tokens
 * @param {number} i
 * @returns {?{url: ?string, start: number, unclosed: boolean, next: number}}
 */
function urlAt(text, tokens, i) {
  const t = tokens[i];
  if (t?.type === tokenTypes.Url) {
    const rawUrl = text.slice(t.start, t.end);
    return {
      url: cssUrl.decode(rawUrl.endsWith(")") ? rawUrl : `${rawUrl})`),
      start: t.start,
      unclosed: !rawUrl.endsWith(")"),
      next: i + 1,
    };
  }
  if (
    t?.type !== tokenTypes.Function ||
    fnName(text.slice(t.start, t.end)) !== "url"
  ) {
    return null;
  }
  // Searched forward from the call: what follows it is all a later call is read from.
  let close = -1;
  for (let at = i + 1; at < tokens.length; at++) {
    if (tokens[at].type === tokenTypes.RightParenthesis) {
      close = at;
      break;
    }
  }
  const end = close === -1 ? tokens.length : close;
  const arg = tokens[i + 1];
  if (arg?.type === tokenTypes.String && end === i + 2) {
    return {
      url: cssString.decode(text.slice(arg.start, arg.end)),
      start: t.start,
      unclosed: close === -1,
      next: end + 1,
    };
  }
  const inside = text.slice(
    t.end,
    close === -1 ? text.length : tokens[close].start
  );
  return {
    url: cssUrl.decode(`url(${inside})`),
    start: t.start,
    unclosed: close === -1,
    next: end + 1,
  };
}

/**
 * The URL an @import names at `i`: a string, or a url().
 * @param {string} text
 * @param {{type: number, start: number, end: number}[]} tokens
 * @param {number} i
 * @returns {?{url: ?string, start: number, unclosed: boolean, next: number}}
 */
function refAt(text, tokens, i) {
  const t = tokens[i];
  if (t?.type === tokenTypes.String) {
    return {
      url: cssString.decode(text.slice(t.start, t.end)),
      start: t.start,
      unclosed: false,
      next: i + 1,
    };
  }
  return urlAt(text, tokens, i);
}

/**
 * Add the URLs of the image-set() starting at `i` to `refs` - each string, and each
 * url(), among its arguments - and return the index after its closing parenthesis.
 * @param {string} text
 * @param {{type: number, start: number, end: number}[]} tokens
 * @param {number} i
 * @param {object[]} refs
 * @returns {number}
 */
function imageSetRefs(text, tokens, i, refs) {
  let depth = 1;
  let at = i + 1;
  while (at < tokens.length && depth > 0) {
    const t = tokens[at];
    if (depth === 1 && t.type === tokenTypes.String) {
      refs.push({
        url: cssString.decode(text.slice(t.start, t.end)),
        start: t.start,
        unclosed: false,
        imported: false,
      });
      at++;
      continue;
    }
    const ref = depth === 1 ? urlAt(text, tokens, at) : null;
    if (ref) {
      refs.push({ ...ref, imported: false });
      at = ref.next;
      continue;
    }
    if (
      t.type === tokenTypes.Function ||
      t.type === tokenTypes.LeftParenthesis
    ) {
      depth++;
    } else if (t.type === tokenTypes.RightParenthesis) {
      depth--;
    }
    at++;
  }
  return at;
}

/**
 * The 1-based line of an offset in `text`, asked in increasing order: each call counts on
 * from where the last stopped, so a whole sheet is counted once.
 * @param {string} text
 * @returns {(offset: number) => number}
 */
function lineCounter(text) {
  let line = 1;
  let at = 0;
  return (offset) => {
    for (; at < offset; at++) {
      if (text[at] === "\n") {
        line++;
      }
    }
    return line;
  };
}
