// Apply settled verdicts to a finished review (--llm-verdict). A reviewer - or a model
// handed the report by --llm-review - answers the questions the review asked, and this
// is where those answers change the report. It reads a verdict file and nothing else:
// no prose, no severity, no message comes from the answer, so the wording stays the
// registry's and a reported case lands in the band its own check declares.
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
// Belongs here: reading the file, matching each answer to the item it settles, filing
// each addition under its check, and turning the three verbs into finding/to-do edits.
//
// Does NOT belong here: the item ORDER and its numbering (src/report/order.js, the one
// sequence the renderer prints from), the wording (assets/registry.yaml), and deciding a
// hold's final band (resolveHolds, after this).

import fs from "node:fs";

import { finding } from "./finding.js";
import { orderReview, hasLocus } from "./order.js";
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
 * `{ addon, additions?: [{check, file, line?, hint?}], verdicts?: {"<index>": "<verb>"} }`.
 *
 * `addon` names the add-on the answers were reached on - the path the Review Details
 * section printed - and is checked against the one being reviewed. That is the whole
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
 * @returns {{addon: string, additions: object[], verdicts: Map<number, string>}}
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
    '{"addon": "<the reviewed path>", "verdicts": {"4": "reported"}}';
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`--llm-verdict ${file} must be an object, e.g. ${shape}`);
  }
  if (typeof doc.addon !== "string" || doc.addon === "") {
    throw new Error(
      `--llm-verdict ${file} names no "addon" - it must carry the path the review printed, so verdicts cannot be applied to a different submission (e.g. ${shape})`
    );
  }
  if (doc.verdicts !== undefined && typeof doc.verdicts !== "object") {
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
  for (const [key, verdict] of Object.entries(doc.verdicts ?? {})) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 1) {
      throw new Error(
        `--llm-verdict ${file}: "${key}" is not an item index (a whole number from 1)`
      );
    }
    if (!VERBS.has(verdict)) {
      throw new Error(
        `--llm-verdict ${file}: item ${index} has verdict ${JSON.stringify(verdict)} (expected one of: ${[...VERBS].join(", ")})`
      );
    }
    verdicts.set(index, verdict);
  }
  return { addon: doc.addon, additions, verdicts };
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
 * Settle the review against `verdicts`, in place: withdraw findings, clear to-do items,
 * and turn a reported one into a finding of its own check.
 *
 * Every answer must land. An index past the end of the list throws: it means the file was
 * written against a different review, and applying the rest of it would settle cases
 * nobody looked at. readVerdicts has already checked the file names this add-on.
 * @param {object} args
 * @param {import("./finding.js").Finding[]} args.findings  Mutated in place.
 * @param {import("./finding.js").ManualItem[]} args.manual  Mutated in place.
 * @param {Map<number, string>} args.verdicts  Index to verdict.
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
  const applied = [];
  const dropFindings = new Set();
  const dropManual = new Set();
  const added = [];
  for (const [index, verdict] of [...verdicts].sort((a, b) => a[0] - b[0])) {
    const item = byIndex.get(index);
    if (!item) {
      throw new Error(
        `--llm-verdict: item ${index} does not exist - this review lists ${byIndex.size} item(s)`
      );
    }
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
        added.push(asFinding(item.target, index, registry));
      }
    }
    applied.push(`${index} ${verdict}${where}`);
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
 * @returns {import("./finding.js").Finding}
 */
function asFinding(item, index, registry) {
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
  return f;
}
