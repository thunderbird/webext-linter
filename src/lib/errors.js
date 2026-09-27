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

/**
 * What each artifact-conditional field is produced BY, for the message a wrongly-routed
 * check gets. These are the fields only some artifacts carry: the built XPI has no build
 * to trace, and an artifact whose vendor declarations were never read has no `vendor`.
 * Every other field a loaded artifact carries is set for all of them (src/addon/load.js
 * loadAddon), so absence there is a bug, not a route.
 */
const PRODUCED_BY = {
  vendor: "resolveVendor, in the phase that prepares that artifact",
  buildReview: "analyzeBuild, in the phase that prepares the source archive",
};

/**
 * Close an artifact against reads of what was never computed for it. A field only some
 * artifacts carry is answered with `undefined` otherwise, and a check reading `undefined`
 * finds nothing - which reads as a clean submission. After this, that read throws instead.
 *
 * Called once per artifact when the setup steps are done, so "absent" is settled: a field
 * still missing here is one no step produced, whether because this artifact never needed it
 * or because the step that should have run did not. Both are wiring errors and both should
 * be loud. The accessor is non-enumerable so a spread or a serializer cannot trip it - only
 * a real read can.
 * @param {object} addon  The loaded artifact.
 * @param {string} label  What to call it in the message ("built XPI", "source archive").
 * @returns {object} The same artifact.
 */
export function sealArtifact(addon, label) {
  for (const [field, producer] of Object.entries(PRODUCED_BY)) {
    if (addon[field] !== undefined) {
      continue;
    }
    Object.defineProperty(addon, field, {
      enumerable: false,
      configurable: true,
      get() {
        throw wiringError(
          `a check read \`${field}\` on the ${label}, which never produced it ` +
            `(${producer}). A check reads only the artifact its \`input\` routes it ` +
            "to, so this is a routing error: either the route is wrong, or the field " +
            "has to be produced for that artifact too."
        );
      },
    });
  }
  return addon;
}
