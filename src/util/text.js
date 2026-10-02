// Word-wrap for prose printed to the terminal or report - notably review-authored
// text (the change summary, escalation explanations), whose lines can be
// arbitrarily long. Each source line is wrapped independently so the text's
// own structure (bullets, blank lines) is kept, and a leading list marker
// hanging-indents its continuations.
//
// It also holds the guards that make submission-derived text safe to print, which is the
// other half of "text on its way to a reader": displayText for prose, displayLine for a
// sink that is one line, displayPath for a value the reader copies back, and
// displayTerminal for the terminal itself, applied to every byte written there. Which to
// call is documented on each.
//
// And the plain scans that replace regexes on submission text whose time grows faster than
// it (trimStartOf, trimEndOf, cutAtFirst, replaceSpans, replaceQuoted, pathTokensEndingIn):
// a pattern like /[,;:]+$/ is retried from every position inside a long run - a loop walks
// it once.
//
// Belongs here: wrapText (a generic width-wrapper), that guard family, and those scans. Does NOT belong
// here: the report's section layout (src/report/format.js), the activity-feed narration
// (src/checks/escalation.js) that call them, or the one door to the terminal
// (src/util/log.js) that calls displayTerminal.

// A leading list marker ("- ", "* ", "• ", "1. ", "2) ") - its width sets the
// hanging indent for the wrapped continuations.
const MARKER = /^([-*•]\s+|\d+[.)]\s+)/;

/**
 * Wrap text to `width` columns. Source line breaks are preserved (each line is
 * wrapped on its own, blank lines kept). A leading list marker keeps its
 * continuation lines hanging-indented under the text. A single word longer than
 * the available width is left on its own over-long line rather than broken.
 * @param {string} text
 * @param {string} [indent]  Prefix applied to every output line.
 * @param {number} [width]
 * @returns {string[]}
 */
export function wrapText(text, indent = "", width = 80) {
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      out.push("");
      continue;
    }
    const lead = line.match(/^\s*/)[0];
    const afterLead = line.slice(lead.length);
    const marker = afterLead.match(MARKER)?.[0] ?? "";
    const firstPrefix = indent + lead + marker;
    const contPrefix = indent + lead + " ".repeat(marker.length);
    let cur = firstPrefix;
    let started = false;
    for (const word of afterLead.slice(marker.length).split(/\s+/)) {
      if (!word) {
        continue;
      }
      if (!started) {
        cur += word;
        started = true;
      } else if (cur.length + 1 + word.length <= width) {
        cur += ` ${word}`;
      } else {
        out.push(cur);
        cur = contPrefix + word;
      }
    }
    out.push(cur);
  }
  return out;
}

/**
 * Text from the submission, made safe to put in front of a person. Control and format
 * characters go: an escape sequence can repaint the terminal around a finding, erasing
 * what sits above it, and a bidi override can make a path read as something it is not.
 * Tab, carriage return and newline stay: they are ordinary text, and removing them would
 * flatten prose that is meant to have shape.
 *
 * Each one becomes a SPACE rather than nothing, so the characters either side stay
 * apart - deleting would let "htt<ESC>ps://evil" fuse into a working URL.
 *
 * The single definition of that rule. Everything the review shows a user passes
 * through here: the substituted {{slot}} values (src/report/responses.js), the locus
 * line and the machine-readable report, the report's own header - its value rows and the
 * schema sentence, which carries the submission's manifest_version (src/report/format.js) -
 * the per-check feed notes (src/checks/registry.js) and a reviewer verdict narration
 * (src/checks/escalation.js). Guarding those sinks rather than the hundreds of places
 * a check composes a finding is what makes a check added later inherit it.
 *
 * NOT applied to our own authored prose: the registry's wording is ours, carries none
 * of this, and stripping it would hide an authoring mistake rather than a submission.
 * Nor does it lay anything out - a caller wanting one line asks for one (displayLine).
 * @param {?string} text
 * @returns {string}
 */
export function displayText(text) {
  return String(text ?? "").replace(/(?![\t\r\n])[\p{Cc}\p{Cf}]/gu, " ");
}

/**
 * The same guard, for a sink that is ONE line: a locus line or a feed note. There a newline is not text, it is a second line - a packaged file named
 * "a.js\n - INJECTED.js" otherwise renders as two loci, indistinguishable from a
 * real second finding. So tab, CR and LF collapse here, where displayText keeps them
 * for prose that is meant to have shape.
 *
 * Which to call: prose that will be wrapped (wrapText) wants displayText, one line of TEXT
 * - a locus, a feed note - wants this, and a PATH the reader copies back wants displayPath.
 * The sink decides between the first two; the third is decided by the value, because a path
 * is the one thing here that has to survive a round trip unaltered.
 * @param {?string} text
 * @returns {string}
 */
export function displayLine(text) {
  return displayText(text).replace(/\s+/g, " ").trim();
}

/**
 * The same guard again, for a one-line sink whose value is a PATH the reader COPIES -
 * a named value in the Review Details block or in the --llm-sca-review prompt's
 * Submission block.
 *
 * Control characters go, like everywhere else: a path reaches us through a folder a
 * reviewer named and a file name a submission chose, and neither may forge a line. What
 * stays is every ordinary space, because a path is a NAME - "/reviews/my  add-on" is not
 * the same folder as "/reviews/my add-on", and displayLine's collapse would print one for
 * the other. The reader hands that path back (the verdict file names the add-on it
 * settled, and the review compares it), so a printed path that is not the path is a round
 * trip that fails on a line nobody wrote wrong.
 *
 * What goes is everything some renderer ENDS A LINE on, not just the three ASCII ones.
 * Every such character that is also a control - vertical tab, form feed, NEL - displayText
 * has already replaced; U+2028 and U+2029 survive it because they are SEPARATORS, so they
 * are named here by property. A value block read in a Markdown client would otherwise
 * carry a file name that breaks its own line and forges the next one.
 * @param {?string} text
 * @returns {string}
 */
export function displayPath(text) {
  return displayText(text).replace(/[\t\r\n\p{Zl}\p{Zp}]+/gu, " ");
}

/**
 * The guard for the terminal itself, applied by the one door every stdout and stderr write
 * passes (src/util/log.js) - to everything, our own text included, since nothing printed
 * there needs a control character. Stricter than displayText in one place: a carriage
 * return goes too, because on a terminal "safe\rEVIL" prints EVIL over safe; so do the line
 * and paragraph separators some terminals break on. Newline and tab stay: the door writes
 * whole multi-line documents. Nothing is collapsed or reflowed - keeping a value to one line
 * is the source's job (displayLine, displayPath), since only the source knows a value's role.
 *
 * Our own colour survives because it is not in the text at this point: it travels as
 * markers that hold no control character, turned into escape codes after this guard
 * (src/util/color.js applyColor).
 * @param {?string} text
 * @returns {string}
 */
export function displayTerminal(text) {
  return String(text ?? "").replace(
    /(?![\t\n])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    " "
  );
}

/**
 * `s` without its leading run of characters from `chars` - the linear form of
 * `s.replace(/^[chars]+/, "")`.
 * @param {string} s
 * @param {string} chars  The characters to drop, each one a single code unit.
 * @returns {string}
 */
export function trimStartOf(s, chars) {
  let start = 0;
  while (start < s.length && chars.includes(s[start])) {
    start++;
  }
  return s.slice(start);
}

/**
 * `s` without its trailing run of characters from `chars` - the linear form of
 * `s.replace(/[chars]+$/, "")`, which retries from every position inside a long run.
 * @param {string} s
 * @param {string} chars  The characters to drop, each one a single code unit.
 * @returns {string}
 */
export function trimEndOf(s, chars) {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1])) {
    end--;
  }
  return s.slice(0, end);
}

/**
 * Everything in `s` before its first character from `chars`, or `s` when it has none -
 * the linear form of `s.replace(/[chars].*$/, "")`. Unlike that regex it cuts across a line
 * break too, which in the values it is used on (a path, a version) is malformed anyway.
 * @param {string} s
 * @param {string} chars  The characters to cut at, each one a single code unit.
 * @returns {string}
 */
export function cutAtFirst(s, chars) {
  for (let i = 0; i < s.length; i++) {
    if (chars.includes(s[i])) {
      return s.slice(0, i);
    }
  }
  return s;
}

/**
 * `text` with every `open ... close` span (the shortest, left to right) replaced by
 * `replacement` - the linear form of a lazy /open[\s\S]*?close/g. An `open` with no `close`
 * after it leaves the rest unchanged: nothing later can be closed either, so the scan stops
 * where the regex would have retried from every remaining `open`.
 * @param {string} text
 * @param {string} open
 * @param {string} close
 * @param {string} replacement
 * @param {{caseInsensitive?: boolean}} [options]  Match `open` in any ASCII case.
 * @returns {string}
 */
export function replaceSpans(text, open, close, replacement, options = {}) {
  const find = options.caseInsensitive
    ? (from) => indexOfAsciiCi(text, open, from)
    : (from) => text.indexOf(open, from);
  let out = "";
  let at = 0;
  for (;;) {
    const start = find(at);
    const end = start === -1 ? -1 : text.indexOf(close, start + open.length);
    if (end === -1) {
      return out + text.slice(at);
    }
    out += text.slice(at, start) + replacement;
    at = end + close.length;
  }
}

/** @param {string} text @param {string} needle  Lower-case. @param {number} from */
function indexOfAsciiCi(text, needle, from) {
  for (let i = from; i + needle.length <= text.length; i++) {
    let k = 0;
    while (
      k < needle.length &&
      (text[i + k] === needle[k] || text[i + k] === needle[k].toUpperCase())
    ) {
      k++;
    }
    if (k === needle.length) {
      return i;
    }
  }
  return -1;
}

/**
 * `text` with every `quote`-delimited string replaced by two quotes - the linear form of
 * /"(?:[^"\\]|\\.)*"/g. A backslash escapes the next character unless that is a line break
 * or the end, which leaves the string unterminated and its text unchanged. After an
 * unterminated string the scan resumes where it failed: no unescaped quote lies inside it,
 * so no string could start there either.
 * @param {string} text
 * @param {string} quote  `"` or `'`.
 * @returns {string}
 */
export function replaceQuoted(text, quote) {
  let out = "";
  let at = 0;
  let from = 0;
  for (;;) {
    const start = text.indexOf(quote, from);
    if (start === -1) {
      return out + text.slice(at);
    }
    let k = start + 1;
    let closed = false;
    while (k < text.length) {
      const c = text[k];
      if (c === quote) {
        closed = true;
        break;
      }
      if (c === "\\") {
        if (k + 1 < text.length && !LINE_BREAKS.includes(text[k + 1])) {
          k += 2;
          continue;
        }
        break;
      }
      k++;
    }
    if (closed) {
      out += text.slice(at, start) + quote + quote;
      at = from = k + 1;
    } else {
      from = Math.max(k, start + 1);
    }
  }
}

// The line terminators a regex "." does not match.
const LINE_BREAKS = "\n\r\u2028\u2029";

/**
 * Each token of `line` that is a run of path characters (letters, digits, `_ . / @ -`)
 * ending in `base`, left to right - what /[\w./@-]*<base>/g yields, without retrying from
 * every position of a long run that never reaches `base`. From each occurrence of `base` the
 * token reaches back over path characters (not into the previous token) and forward to the
 * LAST `base` starting inside that run, as the greedy prefix did.
 * @param {string} line
 * @param {string} base  Non-empty.
 * @returns {string[]}
 */
export function pathTokensEndingIn(line, base) {
  const tokens = [];
  let from = 0;
  for (;;) {
    const hit = line.indexOf(base, from);
    if (hit === -1) {
      return tokens;
    }
    let start = hit;
    while (start > from && isPathChar(line[start - 1])) {
      start--;
    }
    let runEnd = start;
    while (runEnd < line.length && isPathChar(line[runEnd])) {
      runEnd++;
    }
    const last = line.lastIndexOf(base, runEnd);
    tokens.push(line.slice(start, last + base.length));
    from = last + base.length;
  }
}

/** @param {string} c @returns {boolean} */
function isPathChar(c) {
  return (
    (c >= "a" && c <= "z") ||
    (c >= "A" && c <= "Z") ||
    (c >= "0" && c <= "9") ||
    "_./@-".includes(c)
  );
}
