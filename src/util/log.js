// Minimal logger for the tool's narration - the live "what is going on" feed
// (setup notices, progress, LLM activity). This is standard output: the feed is
// one of the run's phases and goes to stdout, alongside the report. Only REAL
// tool errors go to stderr, and those are written directly by the CLI (not
// here). In quiet mode (--report-format json) nothing is emitted, so stdout
// carries only the JSON document. When capture is on (the CLI turns it on for a
// text --report-out), every emitted line is also recorded so the file is a
// carbon copy of the screen.
//
// Belongs here: the narration feed - info, debug (verbose), warn, progress, and
// the verbose/progress/quiet/capture toggles.
//
// Does NOT belong here: user-facing report content (findings, summaries), which
// is built and emitted by src/report/*. Real tool errors (CLI writes those to
// stderr directly). The capture buffer is only the activity feed - it is not the
// report itself.

let verbose = false;
let progressOn = false;
let quiet = false;
/** @type {string[]|null} Recorded lines while capturing, else null. */
let captured = null;

/**
 * Enable or disable verbose logging.
 *
 * @param {boolean|undefined} v
 */
export function setVerbose(v) {
  verbose = Boolean(v);
}

/**
 * Enable or disable the live progress feed (which check is running, LLM
 * escalations). The CLI turns it on for text runs. JSON and test runs leave it
 * off so they stay quiet.
 *
 * @param {boolean|undefined} v
 */
export function setProgress(v) {
  progressOn = Boolean(v);
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
 * Begin (or stop) recording emitted lines, for inclusion in a --report-out
 * file. Enabling resets the buffer.
 *
 * @param {boolean|undefined} v
 */
export function setCapture(v) {
  captured = v ? [] : null;
}

/**
 * The recorded lines as text, each terminated by a newline, or "" when capture
 * is off.
 *
 * @returns {string}
 */
export function getCapture() {
  return captured ? captured.map((line) => `${line}\n`).join("") : "";
}

/**
 * Narrate to stdout when `show`, and record the line whenever capture is on.
 * Quiet mode (JSON) emits and records nothing.
 *
 * @param {unknown[]} args
 * @param {boolean} show
 */
function emit(args, show) {
  if (quiet) {
    return;
  }
  if (show) {
    console.log(...args);
  }
  if (captured) {
    captured.push(args.map(String).join(" "));
  }
}

/**
 * Narrate an informational line to the feed (stdout).
 *
 * @param {...unknown} args
 */
export function info(...args) {
  emit(args, true);
}

/**
 * Narrate a debug line to the feed (stdout, only when verbose is enabled).
 * Recorded for capture only when verbose, so a non-verbose run does not bloat
 * the file.
 *
 * @param {...unknown} args
 */
export function debug(...args) {
  if (verbose) {
    emit(args, true);
  }
}

/**
 * Narrate a warning line to the feed (stdout).
 *
 * @param {...unknown} args
 */
export function warn(...args) {
  emit(args, true);
}

/**
 * Narrate a live progress line to the feed (stdout, only when progress is
 * enabled). Recorded for capture regardless, so a --report-out file gets the
 * activity feed.
 *
 * @param {...unknown} args
 */
export function progress(...args) {
  emit(args, progressOn);
}
