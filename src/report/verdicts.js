// Apply settled verdicts to a finished review (--llm-verdict). A reviewer - or a model
// handed the report by --llm-review - answers the questions the review asked, and this
// is where those answers change the report. It reads a verdict file and nothing else:
// no prose, no severity, no message comes from the answer, so the wording stays the
// registry's and a reported case lands in the band its own check declares.
//
// Belongs here: reading the file, matching each answer to the item it settles, and
// turning the three verbs into finding/to-do list edits.
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

/**
 * Read and shape-check a verdict file: `{ addon, verdicts: { "<index>": "<verb>" } }`.
 *
 * `addon` names the add-on the verdicts were reached on - the path the Review Details
 * section printed - and is checked against the one being reviewed. That is the whole
 * guard: an index means nothing on its own, so a file written for another submission
 * would otherwise settle whatever happens to sit at those positions here.
 *
 * Every malformed entry throws rather than being skipped: a verdict that does not apply
 * is a report that silently understates what was settled.
 * @param {string} file
 * @returns {{addon: string, verdicts: Map<number, string>}}
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
  if (!doc.verdicts || typeof doc.verdicts !== "object") {
    throw new Error(
      `--llm-verdict ${file} carries no "verdicts" object, e.g. ${shape}`
    );
  }
  const verdicts = new Map();
  for (const [key, verdict] of Object.entries(doc.verdicts)) {
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
  return { addon: doc.addon, verdicts };
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
 * @param {import("../checks/registry.js").Registry} args.registry
 * @param {(x: object) => string} [args.labelOf]
 * @returns {string[]}  One audit line per applied verdict, in index order.
 */
export function applyVerdicts({
  findings,
  manual,
  verdicts,
  registry,
  labelOf,
}) {
  // The same sequence the report printed, numbered the same way - not a reconstruction
  // of it. EVERY item is here, including one the page had no room to print: those are in
  // the item file a reviewer worked from, so a verdict naming one has to resolve rather
  // than be refused as out of range.
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
  return applied;
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
