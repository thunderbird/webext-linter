// Guarded enum values, and the shared status vocabulary the review speaks with
// them. `guarded` is the single home for the "guarded singleton" policy; `makeEnum`
// builds a whole enum from it; VERDICT is the one this review needs today.
//
// Belongs here: the guard primitive, the enum factory, and the status vocabulary.
// Does NOT belong here: how a verdict is decided (the detectors and checks), how it
// maps to an outcome, or how it renders (a consumer switch).

/** @typedef {{fail: boolean, pass: boolean, unsure: boolean, skipped: boolean,
 *   info: boolean}} Verdict  An opaque guarded singleton; only its five LOWERCASE
 *   booleans are readable (any other access throws). Compare by reference
 *   (v === VERDICT.FAIL) or by boolean (v.fail); render by switching over it
 *   (report/verdict-label.js). */

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

/**
 * The canonical status values - shared, immutable, reusable across the review.
 * FAIL/PASS/UNSURE are the three judgment verdicts (obfuscation, the LLM);
 * SKIPPED/INFO are feed-note statuses only.
 * @type {{FAIL: Verdict, PASS: Verdict, UNSURE: Verdict, SKIPPED: Verdict,
 *   INFO: Verdict}}
 */
export const VERDICT = makeEnum(
  ["fail", "pass", "unsure", "skipped", "info"],
  "verdict"
);
