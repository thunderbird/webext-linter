// Apply settled answers to a finished review. A reviewer - or the agent working through
// the phase loop - answers what the review asked, and this is where those answers change
// the report. No severity and no response comes from an answer, so a reported case lands
// in the band its own check declares and is worded by that check. The ONE exception is
// what a reviewer typed instead of picking an answer - their words, carried onto the
// case's location line and nowhere else (see below).
//
// An answer settles an item by its fixed reference (src/report/order.js assignRefs).
// Nothing here mints a reference of its own: an answer naming one the review does not
// hold is refused rather than guessed at.
//
// What an answer DOES bring is a reviewer's own words, carried onto the case's location
// line and nowhere else. The response paragraph a developer reads is
// still wholly the registry's, filled by renderFindings from the owning check.
//
// A reported case may also bring a `note`, and that one IS a person's words reaching the
// developer - the reviewer answered the question about this case in their own words
// instead of picking an answer, and those words are the answer. They are the REVIEWER's,
// never the model's: nothing here can tell the two apart, so the prompt that asks the
// question is what holds that line, and what this file refuses is the rest - a verb where
// a reviewer answered, an answer where nobody was asked, an answer with nothing in it,
// and one too long to have been typed into the question it answers. The note travels on
// the LOCATION line, like a hint, so the response paragraph stays the registry's word for
// word.
//
// Belongs here: matching each answer to the item it settles, deciding what that answer
// MEANS for that kind of item (a reviewer's label or words where a person was asked, one
// of the three verbs where the agent settled it), and normalising the words they typed.
//
// Does NOT belong here: reading what the agent handed back (src/report/handback.js), the
// item ORDER and its numbering (src/report/order.js, the one sequence the renderer prints
// from), WHO was asked about an item (the phase that answered it, src/report/loop.js), the
// wording (assets/registry.yaml), and deciding a hold's final band (resolveHolds, after
// this).

import { displayLine } from "../util/text.js";
// The length a reviewer is told they have, in the answer's own description: one number,
// stated there and enforced here. Exceeding it FAILS the run by design - truncating would
// drop words a person wrote, so the model goes back and asks rather than making them fit.
import { MAX_NOTE } from "../config.js";
import { finding } from "./finding.js";
import { orderReview, hasLocus } from "./order.js";
import { VERB, VERB_NAMES, verbNamed } from "./verbs.js";
import { locationLine } from "./format.js";

// The three verdicts, all naming what happens to the item in the REPORT rather than what
// the reviewer believes: it is reported to the developer, cleared away, or - for something
// the linter claimed and the reviewer disagrees with - withdrawn. A verb like "confirmed"
// reads as "confirmed, I checked it and it is fine", the opposite of what it does.
// Every verb EXCEPT `ask`, which never arrives here: it moves an item to the phase that
// asks a person rather than settling it, so nothing is left for this step to apply.
const VERBS = new Set(VERB_NAMES.filter((v) => v !== String(VERB.ask)));

/**
 * What one answer settles its item with: the verdict, and the reviewer's own words when
 * the answer WAS their words.
 *
 * An item a reviewer was asked takes one of the answers it offered, matched by label, or
 * anything else - which is what they typed instead of picking, so it reports the case and
 * carries what they wrote. An item nobody was asked - a finding, or a case settled by
 * reading the add-on - takes a verb, because there is no reviewer whose answer it could
 * be. That crossing is refused one way only: a verb where nobody was asked is a model
 * answering for a reviewer. The other way needs no refusal - `picked` already found
 * every answer a label spells, so anything left is a sentence, whatever it happens to
 * read like.
 * @param {string} answer  The answer recorded for this item.
 * @param {boolean} asked  Whether the phase that answered this item is the one that puts
 *   a question to a person. The PHASE decides it, never the item: a case the agent sent
 *   on with `ask` is answered by a reviewer while keeping the section it was filed under.
 * @param {string} ref  The item's reference, for the refusal texts.
 * @param {{label: string, verdict: string, description: string}[]} choices  The answers the
 *   question offered (registry.manualReviewChoices).
 * @returns {{verdict: string, note: ?string}}
 */
function settleAnswer(answer, asked, ref, choices) {
  const at = `--llm-handback: item ${ref}`;
  const verbs = [...VERBS].join(", ");
  if (!asked) {
    if (!VERBS.has(answer)) {
      throw new Error(
        `${at} was not put to a reviewer - it is settled by reading the add-on, so it takes one of ${verbs}, not ${JSON.stringify(answer)}`
      );
    }
    return { verdict: verbNamed(answer), note: null };
  }
  const picked = pickedChoice(answer, choices);
  if (picked) {
    // The registry spells what each answer settles the item with; crossing it here is
    // what lets a reviewer's label and a verb be compared as the same kind of thing.
    return { verdict: verbNamed(picked.verdict), note: null };
  }
  // Their own words, then: the case is reported and the words travel with it.
  const { note, problem } = checkedNote(answer);
  if (problem) {
    throw new Error(`${at} ${problem}`);
  }
  return { verdict: VERB.reported, note };
}

/**
 * A reviewer's own words as the note they become, held to the one rule a note has: once
 * cleaned up (reviewerNote) something is left, and it is at most MAX_NOTE characters.
 * The one copy of that rule, read where the hand-back takes a words answer
 * (src/report/loop.js accept), which refuses a bad one so the question can be asked again,
 * and where the review settles (settleAnswer).
 * @param {string} answer  What the reviewer typed.
 * @returns {{note: string, problem: ?string}}  `problem` completes a sentence opened by
 *   the item it is about, null where the note holds.
 */
export function checkedNote(answer) {
  const note = reviewerNote(answer);
  if (note === "") {
    return {
      note,
      problem:
        "carries an answer with nothing in it - ask the reviewer that question again and carry what they said",
    };
  }
  // Counted in CODE POINTS, not UTF-16 units: an emoji is one character to the person who
  // typed it, and a refusal calling their 1001 characters 2002 tells them something they
  // cannot act on.
  const length = [...note].length;
  if (length > MAX_NOTE) {
    return {
      note,
      problem: `carries a ${length}-character answer and the limit is ${MAX_NOTE} - ask the reviewer to shorten it and answer that question again, rather than shortening their words yourself`,
    };
  }
  return { note, problem: null };
}

/**
 * The answer a reviewer picked, matched by its label, or null when what they gave is their
 * own words. One matching rule, shared with the loop's reading of an answer mid-review
 * (src/report/loop.js verdictsOf), so the two cannot disagree about what was picked.
 * @param {string} answer
 * @param {{label: string, verdict: string}[]} choices
 * @returns {?{label: string, verdict: string}}
 */
export function pickedChoice(answer, choices) {
  const said = String(answer).trim().toLowerCase();
  return choices.find((c) => c.label.toLowerCase() === said) ?? null;
}

/**
 * A reviewer's answer as it will be printed: their LINES, kept.
 *
 * A reviewer asked for what a check found answers with a list as often as with a sentence,
 * and flattening it into one line runs their items together. So each line survives as a
 * line - the report gives each one its own bullet - while everything inside a line is
 * collapsed and stripped of control characters (displayLine), because a line is still one
 * line. The bullet a reviewer typed goes with it: the report opens every line with one, so
 * keeping theirs would print two.
 *
 * Blank lines go. They separate nothing once each line is its own bullet, and a trailing
 * one would print an empty item.
 * @param {string} text
 * @returns {string}  The lines, joined by "\n"; "" when nothing was written.
 */
function reviewerNote(text) {
  const lines = String(text ?? "")
    .split("\n")
    .map((line) =>
      displayLine(line)
        // A bullet is a marker followed by space; a dash that runs into its text is part
        // of it ("-5 icons are missing").
        .replace(/^[-*\u2022]\s+/, "")
        .trim()
    )
    // A line that is nothing but a bullet is what a reviewer who started an item and
    // thought better of it leaves behind; it says nothing, so it is not an item.
    .filter((line) => line !== "" && !/^[-*\u2022]+$/.test(line));
  return lines.join("\n");
}

/**
 * Settle the review against `verdicts`, in place: withdraw findings, clear to-do items,
 * and turn a reported one into a finding of its own check.
 *
 * Every answer must land. A reference the review does not hold throws: it means the
 * answers were recorded against a different review, and applying the rest would settle
 * cases nobody looked at.
 * @param {object} args
 * @param {import("./finding.js").Finding[]} args.findings  Mutated in place.
 * @param {import("./finding.js").ManualItem[]} args.manual  Mutated in place.
 * @param {Map<string, string>} args.verdicts  Reference to the answer that settles it, as the
 *   state records it: a reviewer's answer for a question, a verb for anything else.
 * @param {import("../checks/registry.js").Registry} args.registry
 * @param {(x: object) => string} [args.labelOf]
 * @param {(x: import("./order.js").OrderedItem) => boolean} args.asking  Whether a person
 *   was asked about this item, which decides the vocabulary its answer is read in. The
 *   PHASE that answered it says so and nothing else can: a case the agent sends on with
 *   `ask` is put to a reviewer while keeping the section it was filed under, so an item
 *   read on its own would be read in the wrong vocabulary. REQUIRED, and not defaulted -
 *   a default could only guess, and guessing wrong refuses the words a reviewer gave.
 * @returns {{applied: string[]}}  One audit line per applied verdict, in reference order.
 */
export function applyVerdicts({
  findings,
  manual,
  verdicts,
  registry,
  labelOf,
  asking,
}) {
  // EVERY item is here, including one the page had no room to print: those are in the
  // review a reviewer worked through, so a verdict naming one has to resolve rather than
  // be refused.
  const byRef = new Map();
  for (const item of orderReview(findings, manual)) {
    byRef.set(item.ref, item);
  }
  const applied = [];
  const dropFindings = new Set();
  const dropManual = new Set();
  const added = [];
  for (const [ref, answer] of [...verdicts].sort((a, b) =>
    byReference(a[0], b[0])
  )) {
    const item = byRef.get(ref);
    if (!item) {
      throw new Error(
        `--llm-handback: item ${ref} is not an item of this review`
      );
    }
    // Read against the answers the item's question offered.
    const { verdict, note } = settleAnswer(
      answer,
      asking(item),
      ref,
      registry.manualReviewChoices()
    );
    // Named in the audit line, so a misaimed verdict is legible there rather than only
    // in the re-rendered report.
    const locus = refOf(item.target, labelOf);
    const where = locus
      ? ` (${locus})`
      : ` (${item.target.title ?? item.target.ruleId})`;
    if (item.kind === "finding") {
      // A finding that HOLDS is "reported": it stays in the review and is reported to the
      // developer, which is what the verb names. Nothing is done to it.
      //
      // The loop requires every slot to be filled, so a finding that stands has to carry
      // a word.
      //
      // It is NOT in the audit line: that line says what a verdict DID, so a review whose
      // findings all hold prints nothing there, and the handful that were withdrawn are
      // not buried under the ones that were not.
      if (verdict === VERB.reported) {
        continue;
      }
      if (verdict !== VERB.withdrawn) {
        throw new Error(
          `--llm-handback: item ${ref} is a finding, so it is "reported" or "withdrawn" (given: ${verdict})`
        );
      }
      dropFindings.add(item.target);
    } else {
      if (verdict === VERB.withdrawn) {
        throw new Error(
          `--llm-handback: item ${ref} is a to-do item, so it is "reported" or "cleared" (given: withdrawn)`
        );
      }
      dropManual.add(item.target);
      if (verdict === VERB.reported) {
        // A check whose report IS what the reviewer found ends its response on a list.
        // When they reported the case without writing that list, the registry's marker
        // stands in it - quietly, because completing it is the reviewer's job and nobody
        // else's to know about.
        const fallback = registry.defaultNote(item.target.ruleId);
        added.push(
          asFinding(
            item.target,
            ref,
            registry,
            // The marker is authored as the list item its response needs, bullet and all;
            // a location line opens with a bullet of its own, so it is normalised exactly
            // as a reviewer's own answer is.
            note ?? (fallback ? reviewerNote(fallback) : null)
          )
        );
      }
    }
    // The note is named, not quoted: this line is the audit of what was applied, and the
    // words themselves are in the report below it, where the developer reads them.
    applied.push(`${ref} ${verdict}${note ? " + note" : ""}${where}`);
  }
  // Edit the arrays only once every answer has been checked, so a file that fails
  // halfway leaves the review untouched rather than half-settled.
  for (let i = findings.length - 1; i >= 0; i--) {
    if (dropFindings.has(findings[i])) {
      findings.splice(i, 1);
    }
  }
  for (let i = manual.length - 1; i >= 0; i--) {
    if (dropManual.has(manual[i])) {
      manual.splice(i, 1);
    }
  }
  findings.push(...added);
  return { applied };
}

/**
 * Two references in the order of the registry, then of the check's own count.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function byReference(a, b) {
  const [ab, an] = a.split(".").map(Number);
  const [bb, bn] = b.split(".").map(Number);
  return ab - bb || an - bn;
}

/**
 * The location line the report shows for this item, for the audit line - empty for an item
 * listed with no location, which then names its check instead.
 * @param {object} target
 * @param {(x: object) => string} [labelOf]
 * @returns {string}
 */
function refOf(target, labelOf) {
  return hasLocus(target) ? locationLine(target, labelOf?.(target)) : "";
}

/**
 * The finding a REPORTED to-do item becomes: the same locus and subject, at the band
 * its own check declares. Refused when the check declares none a reported case could
 * carry - `severity: auto` leaves the band to each finding, so there is nothing to stamp,
 * and `severity: none` means the check emits no findings at all. The message is left for renderFindings to fill from the
 * registry, exactly as for a finding the check emitted itself - so a settled case and a
 * detected one are worded by the same text.
 * @param {import("./finding.js").ManualItem} item
 * @param {string} ref  The item's reference, for the refusal text.
 * @param {import("../checks/registry.js").Registry} registry
 * @param {?string} [note]  The reviewer's own words about this case, carried onto the
 *   finding's location line. The response paragraph stays the registry's.
 * @returns {import("./finding.js").Finding}
 */
function asFinding(item, ref, registry, note = null) {
  const severity = item.ruleId ? registry.suggestedVerdict(item.ruleId) : null;
  if (!severity) {
    throw new Error(
      `--llm-handback: item ${ref} cannot be reported - "${item.title}" declares no severity a reported case could carry`
    );
  }
  const f = finding({
    file: item.file ?? undefined,
    loc: item.loc ?? undefined,
    item: item.item ?? undefined,
    hint: item.hint ?? undefined,
    data: item.data ?? undefined,
    // Carried over, not recomputed: the case already knows which artifact its locus is
    // in, and a reported case is the same locus said as a finding.
    artifact: item.artifact ?? undefined,
  });
  f.ruleId = item.ruleId;
  f.severity = severity;
  f.note = note;
  return f;
}
