// The home for the codebase's guarded enums. `guarded` is the single home for the
// "guarded singleton" policy; `makeEnum` builds a whole enum from it; each enum the
// review needs is declared and exported here (VERDICT, URL_CLASS, OVERTNESS, REF_KIND,
// SYMLINK_CAUSE, REVIEW_MODE, ERROR_CLASS).
//
// Belongs here: the guard primitive, the enum factory, and the enums themselves.
// Does NOT belong here: how an enum value is decided (the detectors and checks), how
// it maps to an outcome, or how it renders (a consumer switch).

/**
 * One guard for both an enum's values and its container - the single home for the
 * "guarded singleton" policy: the target is frozen and any write throws; a symbol
 * (Symbol.toPrimitive, util.inspect.custom, iterator) passes straight through so
 * console.log/inspection works; every string access is answered by `resolve`, which
 * returns a value or throws a ReferenceError. What `resolve` accepts is the ONLY
 * difference between a value and its container.
 * @param {object} target  The backing object (frozen here); empty for a value,
 *   the singletons for a container.
 * @param {(t: object, prop: string) => unknown} resolve  Answers a string access.
 * @returns {object}  The guarded proxy.
 */
function guarded(target, resolve) {
  return new Proxy(Object.freeze(target), {
    get(t, prop) {
      return typeof prop === "symbol" ? t[prop] : resolve(t, prop);
    },
    set() {
      throw new TypeError("a guarded value is immutable");
    },
  });
}

// Node's console.log/util.inspect hook. A Symbol, so it is reached ONLY by
// inspection - never by String(), a template, or `==` - which is why exposing a
// debug rendering through it opens no string-comparison door.
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/**
 * Build a guarded enum from a list of lowercase member names. The two access paths
 * are split by case, so they can never be confused: the container is keyed by
 * UPPERCASE name (ENUM.FOO) and hands back the shared member value; a member is an
 * opaque singleton whose only readable properties are its LOWERCASE name-booleans
 * (m.foo is true iff it is `foo`). So ENUM.FOO is the value, m.foo is the test, and
 * the cross-accesses both throw: ENUM.foo (no lowercase key) and m.FOO (no uppercase
 * accessor). The name lives only in the closure - unreachable by string reflection,
 * spread, or any coercion hook, so the value has no string form usable in code. The
 * member's ONLY own property is a non-enumerable util.inspect hook that renders
 * `<ENUM(label) = NAME>` for console.log; it is symbol-keyed and non-enumerable, so
 * spread stays `{}` and String()/`${}`/`==` still throw. `label` names the enum in
 * error and debug text.
 * @param {string[]} names  Lowercase member names.
 * @param {string} [label]  What to call a member in error messages.
 * @returns {object}  The guarded container.
 */
function makeEnum(names, label = "enum member") {
  const member = (name) => {
    const target = {};
    Object.defineProperty(target, INSPECT, {
      value: () => `<ENUM(${label}) = ${name.toUpperCase()}>`,
    });
    return guarded(target, (_t, prop) => {
      if (!names.includes(prop)) {
        throw new ReferenceError(`unknown ${label}: ${String(prop)}`);
      }
      return name === prop;
    });
  };
  return guarded(
    Object.fromEntries(names.map((n) => [n.toUpperCase(), member(n)])),
    (t, prop) => {
      if (!Object.hasOwn(t, prop)) {
        throw new ReferenceError(`unknown ${label}: ${String(prop)}`);
      }
      return t[prop];
    }
  );
}

/** @typedef {{fail: boolean, pass: boolean, unsure: boolean, skipped: boolean,
 *   info: boolean}} Verdict  An opaque guarded singleton; only its five LOWERCASE
 *   booleans are readable (any other access throws). Compare by reference
 *   (v === VERDICT.FAIL) or by boolean (v.fail); render by switching over it
 *   (report/verdict-label.js). */

/**
 * The canonical status values - shared, immutable, reusable across the review.
 * FAIL/PASS/UNSURE are the three judgment verdicts a check can reach about what it
 * looked at; SKIPPED/INFO are feed-note statuses only.
 * @type {{FAIL: Verdict, PASS: Verdict, UNSURE: Verdict, SKIPPED: Verdict,
 *   INFO: Verdict}}
 */
export const VERDICT = makeEnum(
  ["fail", "pass", "unsure", "skipped", "info"],
  "verdict"
);

/** @typedef {{remote: boolean, embedded: boolean, local: boolean,
 *   dynamic: boolean}} UrlClass  An opaque guarded singleton; only its four
 *   LOWERCASE booleans are readable (any other access throws). Compare by reference
 *   (c === URL_CLASS.REMOTE) or boolean (c.remote). */

/**
 * How a URL / destination is loaded: REMOTE (network), EMBEDDED (inline
 * data:/blob:), LOCAL (bundled/relative), or DYNAMIC (built at runtime, no literal
 * URL to classify). src/scan/url.js classifyUrl produces REMOTE/EMBEDDED/LOCAL from
 * a literal string; DYNAMIC is assigned by the network-sink scanner when there is no
 * literal URL.
 * @type {{REMOTE: UrlClass, EMBEDDED: UrlClass, LOCAL: UrlClass, DYNAMIC: UrlClass}}
 */
export const URL_CLASS = makeEnum(
  ["remote", "embedded", "local", "dynamic"],
  "url_class"
);

/** @typedef {{overt: boolean, covert: boolean}} Overtness  An opaque guarded
 *   singleton; only its two LOWERCASE booleans are readable (any other access
 *   throws). Compare by reference (c === OVERTNESS.OVERT) or boolean (c.overt). */

/**
 * How a network sink sends data (src/parse/network-sinks.js): OVERT (a transmission
 * API like fetch/XHR/sendBeacon) or COVERT (a resource load that can disguise data
 * as a URL).
 * @type {{OVERT: Overtness, COVERT: Overtness}}
 */
export const OVERTNESS = makeEnum(["overt", "covert"], "overtness");

/** @typedef {{script: boolean, css: boolean, content: boolean, resource: boolean,
 *   import: boolean, url: boolean}} RefKind  An opaque guarded singleton; only its
 *   six LOWERCASE booleans are readable (any other access throws). Compare by
 *   reference (k === REF_KIND.SCRIPT) or boolean (k.script). */

/**
 * What a scanned URL reference points at (src/scan/html.js, src/scan/css.js):
 * SCRIPT, CSS, CONTENT (iframe/frame/object/embed), RESOURCE (img/audio/...), or -
 * from CSS - IMPORT (@import) / URL (url()).
 * @type {{SCRIPT: RefKind, CSS: RefKind, CONTENT: RefKind, RESOURCE: RefKind,
 *   IMPORT: RefKind, URL: RefKind}}
 */
export const REF_KIND = makeEnum(
  ["script", "css", "content", "resource", "import", "url"],
  "ref_kind"
);

/** @typedef {{internal: boolean, outside: boolean, broken: boolean}}
 *   SymlinkCause  An opaque guarded singleton; only its three LOWERCASE booleans are
 *   readable (any other access throws). Compare by reference
 *   (c === SYMLINK_CAUSE.OUTSIDE) or boolean (c.outside). */

/**
 * What the loader found at the far end of a symbolic link in a source archive
 * (src/addon/load.js): INTERNAL (a target inside the submission root), OUTSIDE (beyond
 * it) or BROKEN (it resolves to nothing). An XPI holding any link is refused at load.
 *
 * A FACT about the link, never a verdict: which of these a source archive may carry is
 * decided by its check, not here.
 * @type {{INTERNAL: SymlinkCause, OUTSIDE: SymlinkCause, BROKEN: SymlinkCause}}
 */
export const SYMLINK_CAUSE = makeEnum(
  ["internal", "outside", "broken"],
  "symlink_cause"
);

/** @typedef {{sca: boolean, xpi: boolean}} ReviewMode  An opaque guarded singleton; only
 *   its two LOWERCASE booleans are readable (any other access throws). Compare by
 *   reference (m === REVIEW_MODE.SCA) or boolean (m.sca). */

/**
 * The review mode: SCA (a source-code submission - the two-pass source+build
 * review) or XPI (a built add-on, the default).
 * @type {{SCA: ReviewMode, XPI: ReviewMode}}
 */
export const REVIEW_MODE = makeEnum(["sca", "xpi"], "review_mode");

/** @typedef {{network_gone: boolean, no_answer: boolean, wiring: boolean, io: boolean,
 *   walk: boolean}}
 *   ErrorClass  An opaque
 *   guarded singleton; only its LOWERCASE booleans are readable (any other access throws).
 *   Compare by reference (c === ERROR_CLASS.WIRING) or boolean (c.wiring). */

/**
 * Why the review cannot continue, carried by a LinterError (src/lib/errors.js) so each
 * catch can tell a local failure it may swallow from one it must re-throw:
 * NETWORK_GONE (the route to the internet is down, not one load failing), NO_ANSWER (one
 * host gave no answer - still refusing after the retries, timed out, or never accepted the
 * connection - to a question the review cannot be completed without), WIRING (a
 * check reached for data that was never generated for the artifact it was routed to), IO
 * (a submission file that changed during the run and can no longer be read) or WALK (Babel
 * could not walk the AST of one submission file). All but WALK end the run. WALK is about
 * one file: the per-file loops that walk submission code catch it and carry on, and only
 * one escaping them ends the run. The class is what a catch reads to decide, and what the
 * exit names.
 * @type {{NETWORK_GONE: ErrorClass, NO_ANSWER: ErrorClass, WIRING: ErrorClass,
 *   IO: ErrorClass, WALK: ErrorClass}}
 */
export const ERROR_CLASS = makeEnum(
  ["network_gone", "no_answer", "wiring", "io", "walk"],
  "error_class"
);
