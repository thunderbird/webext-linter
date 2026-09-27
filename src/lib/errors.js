// The errors a review cannot continue through, and the one guard every swallowing catch
// calls. A `catch` in this codebase usually exists to turn ONE local failure into a benign
// value - an unparseable cache file, an unreadable entry, a fetch that 404s - and those
// fallbacks are right. They are wrong for a failure that invalidates the whole run: a dead
// network route would silently reclassify a popular library as the developer's own code, and
// a check reading data that was never generated for its artifact would silently find nothing.
// A LinterError carries an ERROR_CLASS saying which, so a catch does not have to guess: it
// calls rethrowIfFatal first and its existing body still handles everything else.
//
// The class reaches the outside world because nothing swallows it: src/cli.js prints
// err.message and exits 2 - a tool failure the review could not run through, distinct from a
// completed review that found errors.
//
// Belongs here: the error type, the class-driven re-throw guard. Does NOT belong here: the
// class NAMES (-> src/lib/enum.js, where every enum is declared), what any one failure means
// (-> the thrower), or how the exit is worded (-> src/cli.js). Imports enum.js and nothing
// else, so any module can call rethrowIfFatal without risking an import cycle.

import { ERROR_CLASS } from "./enum.js";

/**
 * A failure the review cannot continue through, tagged with WHY. The message is the one
 * a reviewer sees: src/cli.js writes `err.message` before exiting 2, so it says what
 * happened in full rather than naming a code.
 */
export class LinterError extends Error {
  /**
   * @param {object} errorClass  An ERROR_CLASS member (src/lib/enum.js).
   * @param {string} message  What happened, worded for the person reading the exit.
   */
  constructor(errorClass, message) {
    super(message);
    this.name = "LinterError";
    // The reason, as the enum singleton itself - not a string. A catch that wants to
    // absorb one specific class compares by reference (err.class === ERROR_CLASS.WIRING)
    // or by boolean (err.class.wiring); neither has a string form to typo.
    this.class = errorClass;
  }
}

/**
 * Re-throw when the caught error is one the review cannot continue through, and return
 * otherwise. Called at the TOP of every catch that swallows a failure into a benign value,
 * so the catch's own body still handles the local failure it was written for and only has
 * to not eat the fatal one. An unclassed error stays swallowed: that is the existing
 * contract of every such site, and widening it is not this guard's job.
 * @param {unknown} err  The caught error.
 * @returns {void}
 */
export function rethrowIfFatal(err) {
  if (err instanceof LinterError) {
    throw err;
  }
}

/**
 * A check reached for data that was never generated for the artifact it was routed to -
 * a wiring error, not a review finding. Thrown rather than answered with `undefined`,
 * because a check that silently finds nothing reports a clean submission.
 * @param {string} message
 * @returns {LinterError}
 */
export function wiringError(message) {
  return new LinterError(ERROR_CLASS.WIRING, message);
}
