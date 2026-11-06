// SETTLE THE REVIEW: the one render of every review, plain or in the loop.
//
// A review is stored as the checks produced it - findings unworded, holds undecided - and
// every reader settles a copy: a plain report with no verdicts, every pass of the review loop
// with the verdicts recorded so far. So what a report says is worked out in one place, and
// never twice from two copies that could drift.
//
// Belongs here: applying the verdicts to a copy, wording each finding from the registry,
// deciding every provisional hold, the abort reasons (early and late apart), and report.md's
// text. Does NOT belong here: what a reader does with the abort reasons (a plain report counts
// both, the loop counts a late exit only once the phase that would go out is `ask` or the
// close, src/report/loop.js), what a verdict does to an item (./../report/verdicts.js), or
// the layout (src/report/format.js).

import { orderReview } from "../report/order.js";
import { phaseOf } from "../report/phases.js";
import { applyVerdicts } from "../report/verdicts.js";
import { renderFindings } from "../report/responses.js";
import { resolveHolds } from "../report/finding.js";
import { abortingChecks, earlyExitOf } from "../report/early-exit.js";
import { issuesBodyLines, locusLabeler } from "../report/format.js";

/**
 * A review as the checks produced it, the shape every reader settles: the findings, the meta
 * every report prints from, whether it is a source code review, the to-do items and the
 * blind-spot sweeps, null where no check that ran authors one. The to-dos and the sweeps are
 * held here once, beside the findings, never in the meta.
 * @typedef {{report: {findings: object[], meta: object, sca: boolean},
 *   manual: object[], preSweep: ?object}} StoredReview
 */

/**
 * The settled review. It holds the findings and to-do items with every verdict applied,
 * worded, and their holds decided, and the meta. It holds the abort reasons, early ones alone
 * (`early`) and early and late together (`late`), each null where nothing aborts the review,
 * and the checks they are counted from (`aborting`). It holds the audit line of each verdict
 * applied and report.md's text. A verdict changes an item and never makes a new one, so every
 * item keeps its reference: the loop walks its phases over this review, the one view.
 * @typedef {object} SettledReview
 * @property {object[]} findings
 * @property {object[]} manual
 * @property {object} meta
 * @property {{sca: boolean}} mode
 * @property {{early: ?object, late: ?object, aborting: string[]}} exits
 * @property {string[]} applied
 * @property {string} report
 */

/**
 * Whether a person answers this item: the phase it is open in takes their words. Read off
 * the phase's answer kind rather than its name, so every phase that asks a person reads its
 * answers the same way.
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {(x: import("../report/order.js").OrderedItem) => boolean}
 */
export function askedByPerson(registry) {
  const words = new Set(
    registry
      .llmPhases()
      .phases.filter((p) => p.answer === "words")
      .map((p) => p.name)
  );
  return (x) => words.has(phaseOf(x));
}

/**
 * Settle the review: on a copy, apply the verdicts (applyVerdicts), word each finding from the
 * registry (renderFindings), decide every provisional hold (resolveHolds), and work out the
 * abort reasons, after the holds, which they read. Each finding is worded before the verdicts
 * too, so the audit line of a verdict names its finding as the report shows it. Decides
 * nothing about what is settled: each caller does that on the value returned.
 * @param {StoredReview} review  As the checks produced it, never changed here.
 * @param {Record<string, string>} verdicts  An item's reference to its answer, none in a
 *   plain review or a first run.
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {SettledReview}
 */
export function settleReview(review, verdicts, registry) {
  // `mode` is an enum Proxy elsewhere, which refuses an unknown property, so the one fact
  // a report reads off it is what is stored.
  const mode = { sca: review.report.sca };
  const labelOf = locusLabeler(mode);
  const worded = (findings) => {
    renderFindings(findings, registry, mode);
    return findings;
  };
  const findings = worded(structuredClone(review.report.findings));
  const manual = structuredClone(review.manual);
  const { applied } = applyVerdicts({
    findings,
    manual,
    verdicts: new Map(Object.entries(verdicts ?? {})),
    registry,
    labelOf,
    // Who was asked is the PHASE's answer, not the item's section: a case the agent sent
    // on with `ask` is answered by a reviewer while keeping the section it was filed under,
    // so reading that section would refuse the words they gave.
    asking: askedByPerson(registry),
  });
  // A reported case became a finding carrying only its locus and slots, so it is worded from
  // the registry like any other - the same text either way.
  worded(findings);
  // After the verdicts, so a hold beside an error verify withdrew stands as a hold.
  resolveHolds(findings);
  const ordered = orderReview(findings, manual);
  const exits = {
    early: earlyExitOf(ordered, {}, registry),
    late: earlyExitOf(ordered, {}, registry, { late: true }),
    aborting: abortingChecks(ordered, {}, registry, { late: true }),
  };
  return {
    findings,
    manual,
    meta: structuredClone(review.report.meta),
    mode,
    exits,
    applied,
    // The developer's half of the report, without the section header the linter prints
    // around it - this is pasted into a response box, not into a terminal. It goes to the
    // file rather than into a prompt, so no model is ever in a position to reword it
    // (src/report/report-file.js).
    report: issuesBodyLines(
      ordered.filter((x) => x.kind === "finding"),
      registry.issueHeadings(),
      registry.verdictIntros(),
      labelOf,
      mode,
      exits.late
    ).join("\n"),
  };
}
