import { displayText } from "./text.js";
// Minimal logger for the tool's own output, on two streams.
//
// STDOUT carries the review: the report, the --llm-review prompt, and the live "what is
// going on" feed (setup, progress, review activity) beside them. In quiet mode
// (--report-format json) none of it is emitted, so stdout carries only the JSON document.
//
// STDERR carries every message that is NOT part of the normal review - a warning that
// the run is degraded, a flag that cannot be honoured, a fatal error - and everything
// written there goes through writeToStderr. In the runs that print a prompt for an agent,
// the channel records instead of printing, and exitWith dumps the record as one block
// after everything else: an agent's harness merges both streams, so a message printed in
// place would read as part of the prompt.
//
// Belongs here: the narration feed - info, debug (verbose), progress, report, the FEED
// levels and feedIndent - the stderr channel (warn, writeToStderr, exitWith), and the
// verbose/progress/feed/quiet/recording toggles.
//
// Does NOT belong here: user-facing report content (findings, summaries), which is built
// and emitted by src/report/*, or the wording of a message, which its caller owns.

let verbose = false;
let progressOn = false;
let feedOn = true;
let quiet = false;
/** @type {string[]|null} The stderr messages held back while recording, else null. */
let recorded = null;

/**
 * Enable or disable verbose logging.
 *
 * @param {boolean|undefined} v
 */
export function setVerbose(v) {
  verbose = Boolean(v);
}

/**
 * Whether a debug() line would actually be narrated or recorded, for a caller that must do
 * EXTRA WORK to produce one (rather than just format one it already has). Quiet is part of
 * the answer: --report-format json sets it independently of --verbose, and emit() drops
 * everything while it is on, so verbose alone would have such a caller pay for output
 * nobody receives.
 *
 * @returns {boolean}
 */
export function isVerbose() {
  return verbose && !quiet;
}

/**
 * Enable or disable the live progress feed (which check is running, review
 * escalations). The CLI turns it on for text runs. JSON and test runs leave it
 * off so they stay quiet.
 *
 * @param {boolean|undefined} v
 */
export function setProgress(v) {
  progressOn = Boolean(v);
}

/**
 * Enable or disable the ACTIVITY FEED - the Setup and Activity sections, the narration
 * of what the run is doing. Distinct from setProgress, which governs the narration
 * stream as a whole: the report's own sections (its header, the --llm-review prompt)
 * ride that stream too and are NOT feed, so they survive this being off.
 *
 * The CLI turns it off for --llm-review and --llm-verdict, where the output exists to be
 * read or handed on, and a record of how it was produced is noise in it.
 *
 * @param {boolean|undefined} v
 */
export function setFeed(v) {
  feedOn = Boolean(v);
}

/**
 * Enable or disable quiet mode. When quiet, nothing is narrated or recorded -
 * the CLI turns this on for --report-format json so stdout carries only the JSON
 * document (real tool errors still go to stderr, written by the CLI directly).
 *
 * @param {boolean|undefined} v
 */
export function setQuiet(v) {
  quiet = Boolean(v);
}

/**
 * The feed's indentation levels, applied by emit() so callers narrate at a
 * semantic level and never hand-code spaces. SECTION headings sit at column 0
 * (── Setup ──, blank separators); STEP is one feed step ([i/total], the
 * per-check line, a reviewer-generating line); DETAIL is a line nested under its
 * step (an investigation note, a skipped-file notice, a reviewer verdict). The
 * 6-space DETAIL width matches the `• [verdict]` findings the checks emit.
 *
 * @readonly
 * @enum {number}
 */
export const FEED = { SECTION: 0, STEP: 1, DETAIL: 2 };

// Indentation for each FEED level, indexed by its value. Owned here so the feed's
// shape lives in one place; callers pass a level, emit() maps it to spaces.
const PREFIX = ["", "  ", "      "];

/**
 * The indent string for a feed level, for a caller that must build the prefix
 * into a wrapText() call so wrapped continuation lines hang-align (a reviewer
 * verdict list, the escalation header). A plain line passes the level to
 * progress()/warn() instead of prefixing by hand.
 *
 * @param {number} level  A FEED value.
 * @returns {string}
 */
export function feedIndent(level) {
  return PREFIX[level] ?? "";
}

/**
 * Narrate to stdout when `show`, indented for its feed level. Quiet mode (JSON)
 * emits nothing. The level's indent is prepended to the first argument so it sits
 * OUTSIDE any color the caller wrapped the text in (spaces are colorless).
 *
 * @param {unknown[]} args
 * @param {boolean} show
 * @param {number} [level]  A FEED value; defaults to SECTION (column 0).
 */
function emit(args, show, level = FEED.SECTION) {
  if (quiet) {
    return;
  }
  const prefix = PREFIX[level] ?? "";
  const out =
    prefix && args.length ? [prefix + String(args[0]), ...args.slice(1)] : args;
  if (show) {
    console.log(...out);
  }
}

/**
 * Narrate an informational line to the feed (stdout) - always shown (unless
 * quiet), at SECTION (column 0), and not part of the progress-gated feed.
 *
 * The loudest channel there is, so it is kept for the few things a run must say
 * whatever else is switched off - today the run banner alone. The rate gate's own
 * narration is deliberately NOT here: it goes through progress(), because --llm-review
 * switches the feed off and its output IS the document (src/util/net.js).
 *
 * @param {...unknown} args
 */
export function info(...args) {
  emit(args, true);
}

/**
 * Narrate a debug line to the feed (stdout, only when verbose is enabled).
 *
 * @param {...unknown} args
 */
export function debug(...args) {
  if (verbose) {
    // Verbose output is where the submission is quoted most freely - a path that failed
    // to parse, a detector's diagnostic, a fetch error body. Guarded here, once, rather
    // than at each of the call sites. Newlines survive: these dumps have shape, and
    // none of them is a single line. No caller colours its text (emit's colour
    // contract is unaffected).
    emit(args.map(displayText), true);
  }
}

/**
 * Hold stderr messages back until exit (on) or print them as they come (off). The CLI
 * turns it on for the runs that print a prompt for an agent, and nothing else in this
 * channel knows which those are.
 *
 * @param {boolean|undefined} v
 */
export function setRecording(v) {
  recorded = v ? [] : null;
}

/**
 * Write one message that is not part of the normal review to stderr - or hold it back
 * for exitWith, while recording. Takes exactly what `process.stderr.write` takes: the
 * caller owns its wording, newlines and colour.
 *
 * Never silenced by quiet mode. A message here says the run went wrong or cannot do
 * what it was asked, and JSON mode keeps stdout clean, not stderr.
 *
 * @param {string} text
 */
export function writeToStderr(text) {
  if (recorded) {
    recorded.push(text);
  } else {
    process.stderr.write(text);
  }
}

/**
 * Warn that the run is carrying on degraded - an input that cannot be used as given, a
 * refresh that failed. Indented as a DETAIL, so in a text run it sits under the feed step
 * it belongs to. Silenced by quiet mode: JSON is a machine contract, and a degraded run's
 * notice is for whoever watches it, not for the document.
 *
 * @param {...unknown} args
 */
export function warn(...args) {
  if (quiet) {
    return;
  }
  writeToStderr(`${PREFIX[FEED.DETAIL]}${args.join(" ")}\n`);
}

/**
 * End the process, after dumping whatever stderr messages were held back - as one block
 * under its own header, so a reader of the merged output sees them apart from the prompt
 * and after everything else. With nothing recorded it prints nothing: outside the
 * recording runs this is just the exit.
 *
 * @param {number} code
 */
export function exitWith(code) {
  if (recorded?.length) {
    process.stderr.write(`\n── Tool messages ──\n\n${recorded.join("")}`);
  }
  process.exit(code);
}

/**
 * Narrate a live progress line to the feed (stdout, only when progress is
 * enabled), at its indentation level.
 *
 * @param {string} text  One formatted feed line.
 * @param {number} [level]  A FEED value; defaults to SECTION (column 0).
 */
export function progress(text, level = FEED.SECTION) {
  emit([text], progressOn && feedOn, level);
}

/**
 * Narrate a line that belongs to the REPORT rather than to the feed - its header, the
 * --llm-review prompt. Emitted with the report, and unaffected by setFeed.
 *
 * @param {string} text  One line.
 */
export function report(text) {
  emit([text], progressOn);
}
