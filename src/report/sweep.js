// What a sweep handed back, and where each result belongs. The agent that swept cannot
// see the check it swept FOR - it reads the add-on, not the linter - so it classifies
// nothing: it names the check, the location and what is there, and the routing is decided
// here, from that check's own `escalation`.
//
// The two routes, and the whole reason this file exists:
//
//   escalation: manual-review  -> a question put to the REVIEWER. The check's cases cannot
//                                 be settled from the package at all (a privacy policy
//                                 lives in the ATN listing), so neither can a swept one.
//                                 It is not inspected, not verified, not cleared - it is
//                                 passed through as another case of the one question that
//                                 check asks.
//   anything else              -> an Extended Code Review item the LLM settles by reading
//                                 the add-on, reported or cleared like any other.
//
// Belongs here: holding an authored result to a shape, refusing what cannot be routed, and
// building the items. The rows themselves arrive as the spawn phase's answers
// (src/report/handback.js), already checked for being present and for being a list.
// Does NOT belong here: what a settled item becomes (-> src/report/verdicts.js), the
// wording of either (-> assets/registry.yaml), or running the sweep, which the linter
// never does - an agent does, and hands what it found back in the spawn phase's slots.

import { renderManualItems } from "./responses.js";

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
 * Route every result to the section its check's cases go to, and hand back the to-do list
 * with them merged in.
 *
 * Refused rather than skipped, because a result nothing can be done with is a sweep half
 * applied: a check this review asked nobody to sweep for, and a check whose instruction
 * this run withheld, are both files written against a different review.
 *
 * Deduplicated on (check, file, line): one sweep naming a location twice is one case, and
 * a location the deterministic pass already listed for that check is already on the item
 * it would be merged into.
 * @param {object} args
 * @param {{check: string, file: string, line: ?number, hint: ?string}[]} args.results
 * @param {object[]} args.manual  The rendered to-do list so far (meta.manualReview).
 * @param {?{items: {check: string}[]}} args.preSweep  What this run asked to be swept.
 * @param {Registry} args.registry
 * @param {string} args.file  The path, for messages.
 * @returns {{manual: object[], applied: string[]}}
 */
export function mergeSweepResults({
  results,
  manual,
  preSweep,
  registry,
  file,
}) {
  const asked = new Set((preSweep?.items ?? []).map((s) => s.check));
  const seen = new Set();
  const refs = [];
  const swept = [];
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
    if (seen.has(key) || listedAlready(manual, r)) {
      continue;
    }
    seen.add(key);
    const where = `${r.check} (${r.file}${r.line == null ? "" : `:${r.line}`})`;
    // The one property that decides where a result goes. A check whose cases only a
    // reviewer can settle cannot have a swept one settled by anybody else, so it becomes
    // another case of that check's own question rather than something inspected here.
    if (registry.checkEntry(r.check)?.escalation === "manual-review") {
      refs.push({
        ruleId: r.check,
        item: null,
        hint: r.hint,
        file: r.file,
        loc: r.line == null ? null : { line: r.line },
        section: "manual-review",
        data: null,
        occurrences: null,
      });
      applied.push(`${where} -> question`);
    } else {
      swept.push(sweptCodeReviewItem(r, registry));
      applied.push(`${where} -> code review`);
    }
  }
  return {
    manual: [
      ...manual,
      ...renderManualItems(refs, registry).map((m) => ({
        ...m,
        extended: true,
      })),
      ...swept,
    ],
    applied,
  };
}

/**
 * A result for a check that files findings, as the Extended Code Review item that settles
 * it - built here rather than through renderManualItems, which reads the `instructions` an
 * ESCALATING check authors and these checks author none.
 *
 * Its instruction is the check's own `sweep-instruction`: the text the agent was sent
 * after is the text that says what confirming it means, so the reader settles the case
 * against the same description that found it.
 * @param {{check: string, file: string, line: ?number, hint: ?string}} r
 * @param {Registry} registry
 * @returns {object}
 */
function sweptCodeReviewItem(r, registry) {
  const entry = registry.checkEntry(r.check);
  return {
    title: entry?.title ?? r.check,
    instructions: registry.sweepInstruction(r.check),
    response: entry?.response ?? null,
    verdict: registry.suggestedVerdict(r.check),
    data: null,
    ruleId: r.check,
    // Not "manual-review", so bucketOf lists it under Extended Code Review: it is settled
    // by reading the add-on, which is what that section is.
    section: "code-review",
    file: r.file,
    loc: r.line == null ? null : { line: r.line },
    item: null,
    hint: r.hint,
    listItem: false,
    extended: true,
  };
}

/**
 * Whether the deterministic pass already listed this location for this check.
 * @param {object[]} manual
 * @param {{check: string, file: string, line: ?number}} r
 * @returns {boolean}
 */
function listedAlready(manual, r) {
  return manual.some(
    (m) =>
      m.ruleId === r.check &&
      m.file === r.file &&
      (m.loc?.line ?? null) === r.line
  );
}
