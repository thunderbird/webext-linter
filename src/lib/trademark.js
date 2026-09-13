// The Mozilla trademark facts the add-on NAME is matched against, in one place so
// the three name checks cannot drift apart on them.
//
// Two different kinds of fact live here. A brand term is absolute: "Firefox",
// "Mozilla" and "MZLA" are not allowed in an add-on name at all, so recognising
// one needs no knowledge of the language. "Thunderbird" is allowed in exactly one
// construction, "<name> for Thunderbird", and recognising THAT needs the meaning
// of the word before it, which a string test cannot supply.
//
// So offFormThunderbird answers only what is decidable from the string, and a true
// result does NOT mean "violates the policy" - it means "not the form we can
// verify". Keeping those two statements apart is what the callers turn on: a name
// whose language the package states as English is decided, and any other is put to
// a reader. Collapsing them rejects a Czech name reading "Konverzace pro
// Thunderbird", which is the allowed form in that language.
//
// Belongs here: the brand terms, the allowed Thunderbird construction, and the two
// predicates over a name. Does NOT belong here: which locale a name came from or
// whether that locale is English (-> src/lib/locales.js), what to do with either
// answer (-> the three src/checks/rules/trademark-*.js checks), and the authored
// wording (-> assets/registry.yaml).

// Brand terms never allowed anywhere in the name (lowercased needle -> label).
const FORBIDDEN = [
  ["firefox", "Firefox"],
  ["mozilla", "Mozilla"],
  ["mzla", "MZLA"],
];

// The allowed construction, anchored at the end: "<add-on name> for Thunderbird".
const ALLOWED_FORM = /\s+for\s+thunderbird\s*$/i;

/**
 * The Mozilla brand a name misuses, or null. Case-insensitive, and needs no
 * language: these terms are not allowed in an add-on name in any form.
 * @param {string} name  An add-on name, as displayed.
 * @returns {string|null}
 */
export function brandTerm(name) {
  const lc = String(name).toLowerCase();
  for (const [needle, label] of FORBIDDEN) {
    if (lc.includes(needle)) {
      return label;
    }
  }
  return null;
}

/**
 * Whether `name` carries "Thunderbird" in a form this scan cannot verify - the
 * brand appears and the allowed trailing construction does not account for it.
 * A true result is a question, not a verdict: see the header.
 * @param {string} name  An add-on name, as displayed.
 * @returns {boolean}
 */
export function offFormThunderbird(name) {
  const s = String(name);
  if (!/thunderbird/i.test(s)) {
    return false;
  }
  return /thunderbird/i.test(s.replace(ALLOWED_FORM, ""));
}
