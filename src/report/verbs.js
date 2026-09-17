// The verdict vocabulary, as VALUES rather than as the words that spell them.
//
// A phase answering with `words` hands back whatever a person wrote, and a sentence that
// happens to spell a verb is still a sentence - so text arriving from a hand-back may never
// be compared to a verb. It is compared ONCE, here, at the point the phase that accepted it
// says its answers are verdicts; what comes out is a Verb, and every question after that
// ("is this the one that moves an item?") is asked by identity.
//
// One declaration, so the registry's validation, the loop's routing and the apply step
// cannot drift into three lists that disagree about what a verdict is.
//
// Belongs here: which verbs exist, and the one crossing from text to verb.
//
// Does NOT belong here: which verbs a PHASE offers (assets/registry.yaml, validated in
// src/checks/registry.js), what a verb DOES to an item (src/report/verdicts.js), and where
// `ask` sends one (src/report/loop.js).

/** One verdict. Frozen and unique: two Verbs are equal only when they are the same Verb,
 *  and no string is ever equal to one. `String(verb)` is how it is written down - the state
 *  file is JSON, which holds text, and reading it back goes through `verbOf` again. */
class Verb {
  constructor(name) {
    this.name = name;
    Object.freeze(this);
  }
  toString() {
    return this.name;
  }
}

/** Every verb a phase may accept, by the word that spells it. */
export const VERB = Object.freeze({
  reported: new Verb("reported"),
  cleared: new Verb("cleared"),
  withdrawn: new Verb("withdrawn"),
  // Alone among them, this one does not settle an item - it moves it to the phase that
  // asks a person, so it never reaches the apply step (src/report/verdicts.js).
  ask: new Verb("ask"),
});

/** The words the verbs are spelled with, for a message that lists what was expected. */
export const VERB_NAMES = Object.freeze(Object.keys(VERB));

/**
 * The verb a phase accepts under this spelling, or null.
 *
 * THE ONLY WAY TO OBTAIN A VERB, and the only place a verb is compared to text. A phase
 * that does not offer the word gets null even when the word names a verb, so "a verdict
 * this review knows" and "a verdict THIS PHASE accepts" cannot come apart.
 * @param {{verbs: string[]}} phase  The phase that accepted the answer.
 * @param {*} text  What came back in the slot.
 * @returns {?Verb}
 */
export function verbOf(phase, text) {
  return phase.verbs.includes(text) ? verbNamed(text) : null;
}

/**
 * The verb this word spells, or null.
 *
 * The crossing with no phase behind it, for the settled answers the STATE holds: those
 * were crossed once already, on the way in, and written down as text because the state is
 * JSON. Crossing back here is what keeps the apply step comparing verbs rather than the
 * words that spell them.
 * @param {*} text
 * @returns {?Verb}
 */
export function verbNamed(text) {
  return typeof text === "string" && Object.hasOwn(VERB, text)
    ? VERB[text]
    : null;
}

/** Whether a value IS a verb, as opposed to text that spells one. */
export function isVerb(value) {
  return value instanceof Verb;
}
