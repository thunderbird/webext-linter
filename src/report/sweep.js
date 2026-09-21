// What a sweep handed back, and where each result belongs. The agent that swept cannot
// see the check it swept FOR - it reads the add-on, not the linter - so it classifies
// nothing: it names the check, the location and what is there, and the routing is decided
// here.
//
// A SWEEP IS A DETECTOR, NOTHING MORE. What comes back is a hint: a location its check's
// own detectors missed. From that point the case is one of that check's, handled exactly
// as a case that check found for itself - which is the whole rule:
//
//   the check escalates  -> an escalation of that check, in the section that check's own
//                           wording puts it in, worded by those same instructions. A swept
//                           case and a detected one ask the reader the same question.
//   it does not          -> a FINDING of that check. A check that authors no wording
//                           settles its cases as findings, so a swept one is a finding
//                           too, and the verify phase audits it like every other claim.
//
// So a `sweep-instruction` is read in two places, neither of them here: the request handed
// to the sweep agent, and the report's Standard Code Review list, which names the blind
// spots a reviewer covers by hand when no agent is sweeping. It says what to LOOK FOR. It
// never says what confirming something means - that is the owning check's to say.
//
// Belongs here: holding an authored result to a shape, refusing what cannot be routed, and
// building the items. The rows themselves arrive as the spawn phase's answers
// (src/report/handback.js), already checked for being present and for being a list.
// Does NOT belong here: what a settled item becomes (-> src/report/verdicts.js), the
// wording of either (-> assets/registry.yaml), or running the sweep, which the linter
// never does - an agent does, and hands what it found back in the spawn phase's slots.

import { renderManualItems } from "./responses.js";
import { finding } from "./finding.js";

/** @typedef {import("../checks/registry.js").Registry} Registry */

/** The fields a result may carry. `check` is the ROW it was written into, not something
 *  the agent types - which is why a hint cannot be misattributed. Everything else about how
 *  it reads - its band, its response, the paragraph a developer gets - is the registry's,
 *  so a row that sets anything more is refused rather than quietly ignored. */
const RESULT_FIELDS = ["check", "file", "line", "hint"];

/** What the agent writes into one row: where it is, and what is there. */
const RESULT_SHAPE =
  '{"file": "background.js", "line": 40, "hint": "<what is there>"}';

// A hint names what sits at one location and is printed on that location's line. Past
// roughly this it stops being an annotation and starts being a paragraph someone wrote
// for the developer, which is the registry's job.
const MAX_HINT = 200;

/**
 * One thing a sweep found, checked.
 *
 * The agent authors these - the linter cannot, since a sweep exists for what its detectors
 * miss - so this is where an authored row is held to a shape. It is refused rather than
 * repaired: a result nothing can be done with is a sweep half applied.
 *
 * The extra-field check matters more than it looks. A result says WHERE something is and
 * names it in a phrase; where it lands and how it reads to a developer are the linter's,
 * from the owning check's registry entry. A row that set its own severity or response
 * would be an agent wording the report.
 * @param {string} where  Names the row, for the message.
 * @param {*} raw
 * @returns {{check: string, file: string, line: ?number, hint: ?string}}
 */
export function checkedResult(where, raw) {
  const at = where;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${at} must be an object, e.g. ${RESULT_SHAPE}`);
  }
  const extra = Object.keys(raw).filter((k) => !RESULT_FIELDS.includes(k));
  if (extra.length) {
    throw new Error(
      `${at} carries ${extra.map((k) => JSON.stringify(k)).join(", ")} - a result may only set ${RESULT_FIELDS.map((k) => `"${k}"`).join(", ")}, because where it lands and how it reads are the linter's`
    );
  }
  if (typeof raw.file !== "string" || raw.file === "") {
    throw new Error(
      `${at} names no "file" - a result must say where it was found, e.g. ${RESULT_SHAPE}`
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
 * Route every result the way its check routes its own cases, and hand back both lists with
 * them merged in.
 *
 * Refused rather than skipped, because a result nothing can be done with is a sweep half
 * applied: a check this review asked nobody to sweep for, and a check whose instruction
 * this run withheld, are both files written against a different review.
 *
 * Deduplicated on (check, file, line) against BOTH lists: one sweep naming a location twice
 * is one case, and a location the deterministic pass already covered for that check - as a
 * to-do item or as a finding - is already in the review. Both are scanned because either is
 * what the pass would have produced, depending on whether that check escalates.
 * @param {object} args
 * @param {{check: string, file: string, line: ?number, hint: ?string}[]} args.results
 * @param {object[]} args.manual  The rendered to-do list so far (meta.manualReview).
 * @param {object[]} args.findings  The findings so far, for dedup and for the new ones.
 * @param {?{items: {check: string}[]}} args.preSweep  What this run asked to be swept.
 * @param {Registry} args.registry
 * @param {string} args.file  The path, for messages.
 * @returns {{manual: object[], findings: object[], applied: string[]}}
 */
export function mergeSweepResults({
  results,
  manual,
  findings,
  preSweep,
  registry,
  file,
}) {
  const asked = new Set((preSweep?.items ?? []).map((s) => s.check));
  const seen = new Set();
  const refs = [];
  const found = [];
  const applied = [];
  for (const [i, r] of results.entries()) {
    const at = `${file}: result ${i + 1}`;
    if (!registry.sweepInstruction(r.check)) {
      throw new Error(
        `${at} is for "${r.check}", which authors no \`sweep-instruction\` - this review asked nobody to sweep for it`
      );
    }
    if (!asked.has(r.check)) {
      throw new Error(
        `${at} is for "${r.check}", which this review did not ask to be swept - the check did not run here, so its blind spot was never anyone's to cover`
      );
    }
    const key = JSON.stringify([r.check, r.file, r.line]);
    if (
      seen.has(key) ||
      listedAlready(manual, r) ||
      listedAlready(findings, r)
    ) {
      continue;
    }
    seen.add(key);
    const where = `${r.check} (${r.file}${r.line == null ? "" : `:${r.line}`})`;
    const section = registry.sectionFor(r.check);
    if (section) {
      // An escalation of that check, in the section that check's own wording puts it in.
      // renderManualItems words it from that check's instructions, so a swept case and a
      // detected one put the same question to the same reader.
      refs.push({
        ruleId: r.check,
        item: null,
        hint: r.hint,
        file: r.file,
        loc: r.line == null ? null : { line: r.line },
        section,
        data: null,
        occurrences: null,
      });
      applied.push(`${where} -> ${section}`);
    } else {
      // No escalation: this check settles its cases as findings, so a swept one is a
      // finding. Built the way applyVerdicts builds one from a reported case
      // (src/report/verdicts.js asFinding) - the band from the registry, the locus and the
      // agent's hint carried over, and the message left to renderFindings.
      found.push(
        finding({
          ruleId: r.check,
          severity: registry.suggestedVerdict(r.check),
          file: r.file,
          loc: r.line == null ? null : { line: r.line },
          hint: r.hint,
        })
      );
      applied.push(`${where} -> finding`);
    }
  }
  return {
    manual: [
      ...manual,
      ...renderManualItems(refs, registry).map((m) => ({
        ...m,
        extended: true,
      })),
    ],
    findings: [...findings, ...found],
    applied,
  };
}

/**
 * Whether this location is already covered for this check.
 *
 * Asked of the to-do list and of the findings, because the same three fields identify a
 * case in either - a check that escalates listed it as one, a check that does not filed it
 * as the other, and a sweep that names it again is naming what is already there.
 * @param {object[]} listed  To-do items or findings.
 * @param {{check: string, file: string, line: ?number}} r
 * @returns {boolean}
 */
function listedAlready(listed, r) {
  return listed.some(
    (m) =>
      m.ruleId === r.check &&
      m.file === r.file &&
      (m.loc?.line ?? null) === r.line
  );
}
