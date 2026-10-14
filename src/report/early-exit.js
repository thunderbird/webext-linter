// The EARLY EXIT: some cases settle the submission on their own, and the review is aborted
// there rather than asking anyone to carry on with it.
//
// The case it exists for: a source submission whose dependency tree carries known
// high/critical advisories, where the very next thing the review would ask is for a
// reviewer to reproduce the build - running that tree on their own machine, on the
// strength of a question the linter issued knowing better. The linter knows before it
// asks, so it should not ask.
//
// Two decisions, and they are deliberately separate. WHETHER to abort is the registry's:
// a check names the reason it aborts a review (`review-early-exit`), and the report lists
// those reasons. WHAT is withheld is not per-check at all: it is every to-do item a
// REVIEWER would have been asked. Tying the second to the first would mean a table of
// items to strip, maintained beside the table of checks that strip them, drifting apart.
//
// Asked of the ITEM, and not only of the section it was filed under: a check can ask its
// question in a phase of its own, which the item carries (`askedIn`, src/report/phases.js
// phaseOf), and such an item is reviewer work whatever section lists it.
//
// Read from BOTH renderers, which is why it lives here rather than in either: the plain
// review asks it in src/pipeline.js, and the --llm-review loop asks it again on every pass
// (src/report/loop.js), because a pass may report a case no check had judged yet. Only the
// plain report keeps the items nobody would be asked (withoutQuestions). An aborted loop
// hands over no to-do item at all. A finding that aborts the review early is never put to
// anyone, as an aborted review verifies nothing, so what aborted it stays aborting it. A
// check naming a late-exit reason aborts it only once the loop has verified and settled,
// and a finding verify withdrew aborts nothing.
//
// Belongs here: whether a review was aborted, and what an aborted review withholds. Does NOT
// belong here: how the closing block is drawn (-> src/report/format.js), which items a
// reviewer answers (-> src/report/order.js), and the wording (-> assets/registry.yaml).

import { SEVERITY } from "./finding.js";
import { isQuestion } from "./order.js";
import { VERB, verbNamed } from "./verbs.js";

/** @typedef {import("./finding.js").ManualItem} ManualItem */
/** @typedef {import("../checks/registry.js").Registry} Registry */

/**
 * Whether this entry stands as an ERROR once its verdict has landed - which is to say,
 * whether the report will show it as one.
 *
 * Two shapes reach here, because a check settles a submission from either. A FINDING
 * stands at the severity it was reported at, unless verify withdrew it. One that aborts the
 * review early is never put to the agent to verify, as an aborted review hands out no such
 * phase. One that aborts it late is verified first, and a finding verify withdrew stands
 * for nothing, as applyVerdicts drops it from the settled review.
 *
 * A TO-DO item stands only once it is REPORTED, at the severity the registry stamps on a
 * reported case (`suggestedVerdict`, the same read applyVerdicts makes) - because being
 * reported is the moment it becomes a finding of its own check (src/report/verdicts.js
 * asFinding). That is how a check that only ESCALATES can abort a review: the case it
 * raised is not an error until someone has judged it one, so a case cleared as benign
 * stands for nothing, and neither does one in a review with nobody to judge it.
 *
 * Asked of the review as it WILL read, rather than of the settled report, because the
 * conversion happens only when the review is settled, once, at the end - after the `ask`
 * phase has been issued - and an abort decided only there would prune the printed report
 * instead of sparing the question.
 * @param {import("./order.js").OrderedItem} item  One ordered entry.
 * @param {?string} verdict  The verb its answer names, if it has one.
 * @param {Registry} registry
 * @returns {boolean}
 */
function standsAsError(item, verdict, registry) {
  if (item.kind === "finding") {
    return (
      verdict !== VERB.withdrawn && item.target?.severity === SEVERITY.ERROR
    );
  }
  return (
    verdict === VERB.reported &&
    registry.suggestedVerdict(item.target?.ruleId) === SEVERITY.ERROR
  );
}

/**
 * The reasons this review was aborted, deduplicated and in the order the registry authors
 * them. Empty means it was not aborted.
 *
 * An entry counts when two things are true of it: its check names a reason, and it stands
 * as an ERROR (standsAsError). A late-exit reason (Registry lateExitFor) counts only when
 * `late` is set, which the caller decides: the plain report and the settled review always
 * count it, and the loop once nothing but `ask` and `close` is left. Severity is the whole of the threshold, which is what makes
 * this "high and above" without restating any band - an advisory check maps its band to a
 * severity already (src/lib/vuln-findings.js), so a moderate advisory arrives here as a
 * warning and aborts nothing, while a malicious-package advisory, which states no band at
 * all, arrives as an error and aborts the review like any other.
 *
 * Reading the severity rather than the band is also what keeps --warnings-as-errors out of
 * this file. That policy is applied to each finding's own severity before this is asked
 * (bandUnder, src/checks/registry.js), so under it the same moderate advisory arrives as an
 * error and does abort the review - the consequence of settling every warning as an error,
 * reached without anything here knowing the flag exists.
 *
 * Registry order, not encounter order: which finding happened to come first is an
 * accident of the add-on, and the closing block is a sentence the developer reads.
 * @param {import("./order.js").OrderedItem[]} ordered  The whole review, ordered.
 * @param {Record<string, *>} answers  Verdicts recorded so far, by item reference. Empty for
 *   a review with no agent in it, where an escalated case stands for nothing because
 *   nobody has judged it.
 * @param {Registry} registry
 * @param {boolean} late  Whether late-exit reasons count.
 * @returns {{id: string, text: string}[]}
 */
function earlyExitReasons(ordered, answers, registry, late) {
  const { reasons } = registry.earlyExitProse();
  const hit = new Set(
    aborting(ordered, answers, registry, late).map((a) => a.reason)
  );
  return Object.keys(reasons)
    .filter((id) => hit.has(id))
    .map((id) => ({ id, text: reasons[id] }));
}

/**
 * The entries that abort this review, each with its check and the reason it names: those
 * whose check names a reason and that stand as an ERROR (standsAsError). Arguments as for
 * earlyExitReasons.
 * @param {import("./order.js").OrderedItem[]} ordered
 * @param {Record<string, *>} answers
 * @param {Registry} registry
 * @param {boolean} late
 * @returns {{ruleId: string, reason: string}[]}
 */
function aborting(ordered, answers, registry, late) {
  const out = [];
  for (const item of ordered) {
    // An ordered entry WRAPS what it is about: `target` is the finding or the to-do item,
    // while the entry's own `section` is the band it is listed under and `ref` is what a
    // verdict names it by. Reading a severity or a ruleId off the wrapper silently matches
    // nothing.
    //
    // Crossed through verbNamed rather than compared as text: a stored answer is text
    // until something says which verb it names, and that crossing happens in one place.
    const verdict = verbNamed(answers?.[item.ref]);
    if (!standsAsError(item, verdict, registry)) {
      continue;
    }
    const ruleId = item.target?.ruleId;
    const reason =
      registry.earlyExitFor(ruleId) ??
      (late ? registry.lateExitFor(ruleId) : null);
    if (reason) {
      out.push({ ruleId, reason });
    }
  }
  return out;
}

/**
 * The checks whose entries abort this review, read with the one standing rule the reasons
 * are counted by (earlyExitReasons), deduplicated. Empty means it was not aborted.
 * @param {import("./order.js").OrderedItem[]} ordered  The whole review, ordered.
 * @param {Record<string, *>} answers  Verdicts recorded so far, by item reference.
 * @param {Registry} registry
 * @param {{late?: boolean}} [opts]  `late`: whether late-exit reasons count.
 * @returns {string[]}
 */
export function abortingChecks(
  ordered,
  answers,
  registry,
  { late = false } = {}
) {
  return [
    ...new Set(aborting(ordered, answers, registry, late).map((a) => a.ruleId)),
  ];
}

/**
 * What an aborted review carries, or null when it was not aborted: the authored line and the
 * reasons it lists, each with the id that named it.
 *
 * ONE producer for that value. Assembled per renderer, the shape - and the null-vs-empty
 * convention its consumers branch on - would live in two places that could answer
 * differently.
 *
 * The ids travel beside the texts because the JSON report is read by machines: a wording
 * edit changes the text, and a consumer matching on English silently stops recognising
 * the case it was written for. The terminal report prints only the texts.
 * @param {import("./order.js").OrderedItem[]} ordered  The whole review, ordered.
 * @param {Record<string, *>} answers  Verdicts recorded so far, by item reference.
 * @param {Registry} registry
 * @param {{late?: boolean}} [opts]  `late`: whether late-exit reasons count
 *   (earlyExitReasons).
 * @returns {?{intro: string, reasons: {id: string, text: string}[]}}
 */
export function earlyExitOf(ordered, answers, registry, { late = false } = {}) {
  const reasons = earlyExitReasons(ordered, answers, registry, late);
  return reasons.length
    ? { intro: registry.earlyExitProse().intro, reasons }
    : null;
}

/**
 * The to-do items an aborted review still lists: the ones nobody was going to be ASKED.
 *
 * Filtering the manual list is the whole of the strip. Three of the report's four to-do
 * sections are rendered from it, and the Summary re-orders the same array for its counts
 * (src/report/format.js), so the sections and the tally cannot disagree about what is
 * left. The sweep list is untouched: reading code is safe. It holds what the checks up to
 * an early-aborting one authored, because no check after it runs (src/checks/registry.js
 * abortsReview).
 *
 * A reviewer would have been asked an item that is a question by its section, or that
 * names the phase a person is asked it in (`askedIn`), as a check that asks its question in
 * a phase of its own does. Only the plain report calls this (src/pipeline.js): an aborted
 * --llm-review hands over no to-do item at all (src/report/loop.js settle).
 * @param {import("./order.js").OrderedItem[]} ordered  The whole review, ordered.
 * @returns {ManualItem[]}
 */
export function withoutQuestions(ordered) {
  return ordered
    .filter((x) => x.kind === "todo" && !isQuestion(x) && !x.target?.askedIn)
    .map((x) => x.target);
}
