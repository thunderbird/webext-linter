// Apply settled verdicts to a finished review (--llm-verdict). A reviewer - or a model
// handed the report by --llm-review - answers the questions the review asked, and this
// is where those answers change the report. It reads a verdict file and nothing else: no
// severity and no response comes from the answer, so a reported case lands in the band its
// own check declares and is worded by that check. The ONE exception is what a reviewer
// typed instead of picking an answer - their words, carried onto the case's location line
// and nowhere else (see below).
//
// A file carries two kinds of answer, and they are addressed differently ON PURPOSE.
// A VERDICT settles an item the linter numbered, so it is keyed by that index. An
// ADDITION is a case the linter never found - a check's sweep instruction sent a reader
// past its blind spot - so there is no index to name it by: it carries the `check` it
// belongs to and where it was found, and is filed as a finding OF that check, in that
// check's band and words. An index belongs to the linter's numbering of the document it
// wrote; letting an answer mint one would make the two documents disagree about what
// item 7 is.
//
// The one thing an answer DOES bring is an addition's `hint`. That is not a crack in the
// rule above: a hint is a locus annotation, on the same footing as the packaged file path
// beside it, saying what sits at that line. The response paragraph a developer reads is
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
// Belongs here: reading the file, matching each answer to the item it settles, deciding
// what that answer MEANS for that kind of item (a reviewer's label or words for a question,
// one of the three verbs for anything else), normalising the words they typed, and filing
// each addition under its check.
//
// Does NOT belong here: the item ORDER and its numbering (src/report/order.js, the one
// sequence the renderer prints from), the wording (assets/registry.yaml), and deciding a
// hold's final band (resolveHolds, after this).

import fs from "node:fs";

import { displayLine } from "../util/text.js";
// The length a reviewer is told they have, in the answer's own description: one number,
// stated there and enforced here. Exceeding it FAILS the run by design - truncating would
// drop words a person wrote, so the model goes back and asks rather than making them fit.
import { MAX_NOTE } from "../config.js";
import { finding } from "./finding.js";
import { orderReview, hasLocus, isQuestion } from "./order.js";
import { locationLine } from "./format.js";

// The three verdicts, all naming what happens to the item in the REPORT rather than what
// the reviewer believes: it is reported to the developer, cleared away, or - for something
// the linter claimed and the reviewer disagrees with - withdrawn. A verb like "confirmed"
// reads as "confirmed, I checked it and it is fine", the opposite of what it does.
const VERBS = new Set(["reported", "cleared", "withdrawn"]);

// The fields an addition may set. A whitelist rather than a pick, so a key nobody planned
// for is refused loudly instead of being dropped in silence.
const ADDITION_FIELDS = ["check", "file", "line", "hint"];

// Named in the messages for a malformed addition, so a reader is shown the shape rather
// than told the one they wrote is wrong.
const ADDITION_SHAPE =
  '{"check": "data-exfiltration", "file": "background.js", "line": 40, "hint": "<what is there>"}';

// A hint names what sits at one location and is printed on that location's line. Past
// roughly this, it stops being an annotation and starts being a paragraph someone wrote
// for the developer, which is the registry's job. displayLine strips control characters
// and collapses whitespace but bounds nothing, so the bound is here.
const MAX_HINT = 200;

/**
 * Read and shape-check a verdict file:
 * `{ xpi, additions?: [{check, file, line?, hint?}], verdicts?: {"<index>": "<answer>"} }`.
 *
 * `xpi` names the shipped add-on the answers were reached on - the path the Review Details
 * section printed under that name - and is checked against the one being reviewed. Named
 * for the ARTIFACT, like every other path in this round trip: the report's block, the
 * prompt's steps and this file all say XPI and mean the same file. That is the whole
 * guard, and it guards additions at least as much as verdicts: an index means nothing on
 * its own, and an addition CREATES a finding, so a file written for another submission
 * would otherwise invent findings here.
 *
 * At least one of the two must be present, though neither requires the other: a sweep
 * that found nothing and a review with nothing left to settle are each a legitimate
 * answer on their own.
 *
 * Every malformed entry throws rather than being skipped: an answer that does not apply
 * is a report that silently understates what was settled.
 * @param {string} file
 * @returns {{xpi: string, additions: object[], verdicts: Map<number, string>}}
 */
export function readVerdicts(file) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(
      `--llm-verdict ${file} is not readable JSON: ${err.message}`
    );
  }
  const shape =
    '{"xpi": "<the reviewed path>", "verdicts": {"4": "Clear", "7": "withdrawn"}}';
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`--llm-verdict ${file} must be an object, e.g. ${shape}`);
  }
  if (typeof doc.xpi !== "string" || doc.xpi === "") {
    throw new Error(
      `--llm-verdict ${file} names no "xpi" - it must carry the path the review printed, so verdicts cannot be applied to a different submission (e.g. ${shape})`
    );
  }
  if (
    doc.verdicts !== undefined &&
    (typeof doc.verdicts !== "object" ||
      doc.verdicts === null ||
      Array.isArray(doc.verdicts))
  ) {
    throw new Error(
      `--llm-verdict ${file}: "verdicts" must be an object, e.g. ${shape}`
    );
  }
  if (doc.additions !== undefined && !Array.isArray(doc.additions)) {
    throw new Error(
      `--llm-verdict ${file}: "additions" must be an array, e.g. ${ADDITION_SHAPE}`
    );
  }
  if (doc.verdicts === undefined && doc.additions === undefined) {
    throw new Error(
      `--llm-verdict ${file} carries neither "verdicts" nor "additions" - it settles nothing, e.g. ${shape}`
    );
  }
  const additions = (doc.additions ?? []).map((raw, i) =>
    readAddition(file, i, raw)
  );
  const verdicts = new Map();
  for (const [key, raw] of Object.entries(doc.verdicts ?? {})) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 1) {
      throw new Error(
        `--llm-verdict ${file}: "${key}" is not an item index (a whole number from 1)`
      );
    }
    // What an answer MEANS needs the review it settles - a question takes one of the
    // answers it offered, or the reviewer's own words, and everything else takes a verb.
    // Neither is knowable from a path, so applyVerdicts checks it and this only refuses
    // what is not an answer at all.
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new Error(
        `--llm-verdict ${file}: item ${index} has ${JSON.stringify(raw)} - an answer is the reviewer's, or one of ${[...VERBS].join(", ")} for an item they were not asked`
      );
    }
    verdicts.set(index, raw);
  }
  return { xpi: doc.xpi, additions, verdicts };
}

/**
 * One addition, shape-checked: a finding a check's sweep found past its own blind spot.
 *
 * `file` is REQUIRED. A sweep that reports something without saying where leaves the
 * developer told that something is wrong and given nowhere to look, which is the exact
 * failure this whole mechanism exists to end.
 *
 * That the `check` names a real check declaring a sweep instruction is NOT checked here:
 * readVerdicts is handed a path and nothing else, and has no registry to ask. It is
 * checked in applyVerdicts, which does.
 * @param {string} file  The verdict file's path, for the messages.
 * @param {number} i  Position in the additions array, for the messages.
 * @param {unknown} raw
 * @returns {{check: string, file: string, line: ?number, hint: ?string}}
 */
function readAddition(file, i, raw) {
  const at = `--llm-verdict ${file}: addition ${i + 1}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${at} must be an object, e.g. ${ADDITION_SHAPE}`);
  }
  const extra = Object.keys(raw).filter((k) => !ADDITION_FIELDS.includes(k));
  if (extra.length) {
    throw new Error(
      `${at} carries ${extra.map((k) => JSON.stringify(k)).join(", ")} - an addition may only set ${ADDITION_FIELDS.map((k) => `"${k}"`).join(", ")}, because the wording of every response is the linter's`
    );
  }
  if (typeof raw.check !== "string" || raw.check === "") {
    throw new Error(
      `${at} names no "check" - an addition is filed as a finding of one, e.g. ${ADDITION_SHAPE}`
    );
  }
  if (typeof raw.file !== "string" || raw.file === "") {
    throw new Error(
      `${at} names no "file" - an addition must say where it was found, e.g. ${ADDITION_SHAPE}`
    );
  }
  if (raw.line !== undefined && (!Number.isInteger(raw.line) || raw.line < 1)) {
    throw new Error(
      `${at} has line ${JSON.stringify(raw.line)} (expected a whole number from 1)`
    );
  }
  if (
    raw.hint !== undefined &&
    (typeof raw.hint !== "string" || raw.hint === "")
  ) {
    throw new Error(
      `${at} has hint ${JSON.stringify(raw.hint)} (expected a short phrase naming what is there)`
    );
  }
  if (typeof raw.hint === "string" && raw.hint.length > MAX_HINT) {
    throw new Error(
      `${at} has a ${raw.hint.length}-character hint - a hint names what sits at that location in at most ${MAX_HINT} characters; the response a developer reads is the linter's`
    );
  }
  return {
    check: raw.check,
    file: raw.file,
    line: raw.line ?? null,
    hint: raw.hint ?? null,
  };
}

/**
 * What one answer settles its item with: the verdict, and the reviewer's own words when
 * the answer WAS their words.
 *
 * An item a reviewer was asked takes one of the answers it offered, matched by label, or
 * anything else - which is what they typed instead of picking, so it reports the case and
 * carries what they wrote. An item nobody was asked - a finding, or a case settled by
 * reading the add-on - takes a verb, because there is no reviewer whose answer it could
 * be. Crossing the two is refused either way: a verb on a question is a model answering
 * for a reviewer, and a sentence on the rest is a model writing prose a developer reads.
 * @param {string} answer  The value the verdict file carries for this item.
 * @param {import("./order.js").OrderedItem} item
 * @param {number} index
 * @param {{label: string, verdict: string, description: string}[]} choices  The answers a
 *   question offered, read once per review by the caller: the registry cannot change
 *   between two answers of one file, and an accessor that says "read once" should be.
 * @returns {{verdict: string, note: ?string}}
 */
function settleAnswer(answer, item, index, choices) {
  const at = `--llm-verdict: item ${index}`;
  const verbs = [...VERBS].join(", ");
  const asked = isQuestion(item);
  if (!asked) {
    if (!VERBS.has(answer)) {
      throw new Error(
        `${at} was not put to a reviewer - it is settled by reading the add-on, so it takes one of ${verbs}, not ${JSON.stringify(answer)}`
      );
    }
    return { verdict: answer, note: null };
  }
  const picked = choices.find(
    (c) => c.label.toLowerCase() === answer.trim().toLowerCase()
  );
  if (picked) {
    return { verdict: picked.verdict, note: null };
  }
  if (VERBS.has(answer)) {
    throw new Error(
      `${at} was put to a reviewer and carries ${JSON.stringify(answer)} - answer it as they did, with ${choices.map((c) => `"${c.label}"`).join(" or ")}, or with their own words`
    );
  }
  // Their own words, then: the case is reported and the words travel with it.
  const note = reviewerNote(answer);
  if (note === "") {
    throw new Error(
      `${at} carries an answer with nothing in it - leave the item out, or carry what the reviewer said`
    );
  }
  // Counted in CODE POINTS, not UTF-16 units: an emoji is one character to the person who
  // typed it, and a refusal calling their 1001 characters 2002 tells them something they
  // cannot act on.
  const length = [...note].length;
  if (length > MAX_NOTE) {
    throw new Error(
      `${at} carries a ${length}-character answer and the limit is ${MAX_NOTE} - ask the reviewer to shorten it and answer that question again, rather than shortening their words yourself`
    );
  }
  return { verdict: "reported", note };
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
 * Every answer must land. An index past the end of the list throws: it means the file was
 * written against a different review, and applying the rest of it would settle cases
 * nobody looked at. readVerdicts has already checked the file names this add-on.
 * @param {object} args
 * @param {import("./finding.js").Finding[]} args.findings  Mutated in place.
 * @param {import("./finding.js").ManualItem[]} args.manual  Mutated in place.
 * @param {Map<number, string>} args.verdicts  Index to the answer that settles it, as the
 *   verdict file carries it: a reviewer's answer for a question, a verb for anything else.
 * @param {object[]} [args.additions]  Findings a check's sweep found, from readAddition.
 * @param {import("../checks/registry.js").Registry} args.registry
 * @param {(x: object) => string} [args.labelOf]
 * @returns {{applied: string[], added: string[]}}  One audit line per applied verdict in
 *   index order, and one per addition in file order.
 */
export function applyVerdicts({
  findings,
  manual,
  verdicts,
  additions = [],
  registry,
  labelOf,
}) {
  // The same sequence the report printed, numbered the same way - not a reconstruction
  // of it. EVERY item is here, including one the page had no room to print: those are in
  // the item file a reviewer worked from, so a verdict naming one has to resolve rather
  // than be refused as out of range.
  //
  // Built BEFORE a single addition is filed, and that ordering is load-bearing.
  // orderReview sorts findings into severity bands before numbering, so an addition
  // entering `findings` first would push every later item down and silently re-aim every
  // verdict in the same file at its neighbour. The additions go in with the rest of the
  // edits at the end; "additions first" is their order in the array, never in this map.
  const byIndex = new Map();
  for (const item of orderReview(findings, manual)) {
    byIndex.set(item.index, item);
  }
  // The answers every question offered, read ONCE: they are the same for every item, and
  // the registry cannot change while one file is applied.
  const choices = registry.manualReviewChoices();
  const applied = [];
  const dropFindings = new Set();
  const dropManual = new Set();
  const added = [];
  for (const [index, answer] of [...verdicts].sort((a, b) => a[0] - b[0])) {
    const item = byIndex.get(index);
    if (!item) {
      throw new Error(
        `--llm-verdict: item ${index} does not exist - this review lists ${byIndex.size} item(s)`
      );
    }
    const { verdict, note } = settleAnswer(answer, item, index, choices);
    // Named in the audit line, so a misaimed verdict is legible there rather than only
    // in the re-rendered report.
    const ref = refOf(item.target, labelOf);
    const where = ref
      ? ` (${ref})`
      : ` (${item.target.title ?? item.target.ruleId})`;
    if (item.kind === "finding") {
      if (verdict !== "withdrawn") {
        throw new Error(
          `--llm-verdict: item ${index} is a finding, so it can only be "withdrawn" (given: ${verdict})`
        );
      }
      dropFindings.add(item.target);
    } else {
      if (verdict === "withdrawn") {
        throw new Error(
          `--llm-verdict: item ${index} is a to-do item, so it is "reported" or "cleared" (given: withdrawn)`
        );
      }
      dropManual.add(item.target);
      if (verdict === "reported") {
        // A check whose report IS what the reviewer found ends its response on a list.
        // When they reported the case without writing that list, the registry's marker
        // stands in it - quietly, because completing it is the reviewer's job and nobody
        // else's to know about.
        const fallback = registry.defaultNote(item.target.ruleId);
        added.push(
          asFinding(
            item.target,
            index,
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
    applied.push(`${index} ${verdict}${note ? " + note" : ""}${where}`);
  }
  // Still validate-only: an addition that cannot be filed must fail before anything is
  // edited, exactly like a verdict that cannot be applied.
  const addedAudit = [];
  const sweepFindings = [];
  for (const a of additions) {
    // The binding that makes an addition an ANSWER rather than an assertion: this review
    // asked the reader to sweep this check's blind spot, and this is what they found
    // there. A check that asked nothing has no question for it to answer.
    if (!registry.sweepInstruction(a.check)) {
      throw new Error(
        `--llm-verdict: addition for "${a.check}" - that check authors no \`sweep-instruction\`, so this review asked nobody to sweep for it`
      );
    }
    const severity = registry.suggestedVerdict(a.check);
    if (!severity) {
      throw new Error(
        `--llm-verdict: addition for "${a.check}" cannot be filed - that check declares no severity a reported case could carry`
      );
    }
    const f = finding({
      file: a.file,
      loc: a.line == null ? undefined : { line: a.line },
      hint: a.hint ?? undefined,
    });
    f.ruleId = a.check;
    f.severity = severity;
    sweepFindings.push(f);
    addedAudit.push(`${a.check} (${refOf(f, labelOf) || a.file})`);
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
  // Sweep findings before settled ones: they were found first, and the report re-sorts
  // by band anyway, so this only decides how ties read.
  findings.push(...sweepFindings, ...added);
  return { applied, added: addedAudit };
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
 * @param {number} index
 * @param {import("../checks/registry.js").Registry} registry
 * @param {?string} [note]  The reviewer's own words about this case, carried onto the
 *   finding's location line. The response paragraph stays the registry's.
 * @returns {import("./finding.js").Finding}
 */
function asFinding(item, index, registry, note = null) {
  const severity = item.ruleId ? registry.suggestedVerdict(item.ruleId) : null;
  if (!severity) {
    throw new Error(
      `--llm-verdict: item ${index} cannot be reported - "${item.title}" declares no severity a reported case could carry`
    );
  }
  const f = finding({
    file: item.file ?? undefined,
    loc: item.loc ?? undefined,
    item: item.item ?? undefined,
    hint: item.hint ?? undefined,
    data: item.data ?? undefined,
  });
  f.ruleId = item.ruleId;
  f.severity = severity;
  f.note = note;
  return f;
}
