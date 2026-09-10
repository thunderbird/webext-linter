// Word-wrap for prose printed to the terminal or report - notably review-authored
// text (the change summary, escalation explanations), whose lines can be
// arbitrarily long. Each source line is wrapped independently so the text's
// own structure (bullets, blank lines) is kept, and a leading list marker
// hanging-indents its continuations.
//
// Belongs here: wrapText (a generic width-wrapper) and humanSize (a byte-size
// formatter). Does NOT belong here: the report's section layout
// (src/report/format.js) or the activity-feed narration
// (src/checks/escalation.js) that call them.

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
    const line = raw.replace(/\s+$/, "");
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
 * A byte count as a short human string: "812 B", "4.5 KB", "2.4 MB" (one
 * decimal for KB/MB). Used for a reviewer-payload size in the summary status lines.
 * @param {number} bytes
 * @returns {string}
 */
export function humanSize(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * Text from the submission, made safe to put in front
 * of a person. Control and format characters go: an escape sequence can repaint the
 * terminal around a finding, erasing what sits above it, and a bidi override can make
 * a path read as something it is not. Tab, carriage return and newline stay: they are
 * ordinary text, and removing them would flatten prose that is meant to have shape.
 *
 * Each one becomes a SPACE rather than nothing, so the characters either side stay
 * apart - deleting would let "htt<ESC>ps://evil" fuse into a working URL.
 *
 * The single definition of that rule. Everything the review shows a user passes
 * through here: the substituted {{slot}} values (src/report/responses.js), the locus
 * line and the machine-readable report (src/report/format.js), the per-check feed
 * notes (src/checks/registry.js) and a reviewer verdict narration
 * (src/checks/escalation.js). Guarding those sinks rather than the hundreds of places
 * a check composes a finding is what makes a check added later inherit it.
 *
 * NOT applied to our own authored prose: the registry's wording is ours, carries none
 * of this, and stripping it would hide an authoring mistake rather than a submission.
 * Nor does it lay anything out - a caller wanting one line asks for one (srcText).
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
 * Which to call is decided by the SINK, not by the value: a caller that wraps its
 * text (wrapText) wants displayText, one that emits a single line wants this.
 * @param {?string} text
 * @returns {string}
 */
export function displayLine(text) {
  return displayText(text).replace(/\s+/g, " ").trim();
}
