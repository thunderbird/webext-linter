// The EARLY EXIT: some cases settle the submission on their own, and the review stops
// there rather than asking anyone to carry on with it.
//
// The case it exists for: a source submission whose dependency tree carries known
// high/critical advisories, where the very next thing the review would ask is for a
// reviewer to reproduce the build - running that tree on their own machine, on the
// strength of a question the linter issued knowing better. The linter knows before it
// asks, so it should not ask.
//
// Two decisions, and they are deliberately separate. WHETHER to stop is the registry's:
// a check names the reason it stops a review (`review-early-exit`), and the report lists
// those reasons. WHAT is withheld is not per-check at all: it is every to-do item a
// REVIEWER would have been asked, which src/report/phases.js already answers for the
// phase machine (phaseNow). Tying the second to the first would mean a table of items to
// strip, maintained beside the table of checks that strip them, drifting apart.
//
// phaseNow, and NOT the section an item was filed under: a case the agent could not
// settle is sent on to a reviewer KEEPING its section, so asking where it was filed would
// leave it listed as reviewer work under a closing line saying nobody was asked. Where an
// item is answered NOW is the question, and one function answers it for both readers.
//
// Read from BOTH renderers, which is why it lives here rather than in either: the plain
// review applies it in src/pipeline.js, and the --llm-review loop asks it again on every
// phase (src/report/loop.js), because what settles a submission is not fixed when the
// checks run: the agent may withdraw the very finding that stopped the review, and it may
// report a case no check had judged yet.
//
// Belongs here: whether a review stopped, and what a stopped review withholds. Does NOT
// belong here: how the closing block is drawn (-> src/report/format.js), which items a
// reviewer answers (-> src/report/order.js), and the wording (-> assets/registry.yaml).

import { SEVERITY } from "./finding.js";
import { phaseNow } from "./phases.js";
import { VERB, verbNamed } from "./verbs.js";

/** @typedef {import("./finding.js").ManualItem} ManualItem */
/** @typedef {import("../checks/registry.js").Registry} Registry */

/**
 * Whether this entry stands as an ERROR once its verdict has landed - which is to say,
 * whether the report will show it as one.
 *
 * Two shapes reach here, because a check settles a submission from either. A FINDING
 * stands at the severity it was reported at, unless the agent withdrew it - a finding
 * taken back is not a finding, which is why this is asked again after every pass rather
 * than once.
 *
 * A TO-DO item stands only once it is REPORTED, at the severity the registry stamps on a
 * reported case (`suggestedVerdict`, the same read applyVerdicts makes) - because being
 * reported is the moment it becomes a finding of its own check (src/report/verdicts.js
 * asFinding). That is how a check that only ESCALATES can stop a review: the case it
 * raised is not an error until someone has judged it one, so a case cleared as benign
 * stands for nothing, and neither does one in a review with nobody to judge it.
 *
 * Asked of the review as it WILL read, rather than of the settled report, because the
 * conversion cannot happen sooner: it moves a case out of the manual list and into the
 * findings, which renumbers every index after it, and an index is what a recorded answer
 * names. So settlement runs once, at the end - after the `ask` phase has been issued - and
 * a stop decided only there would prune the printed report instead of sparing the question.
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
 * The reasons this review stopped, deduplicated and in the order the registry authors
 * them. Empty means it did not stop.
 *
 * An entry counts when two things are true of it: its check names a reason, and it stands
 * as an ERROR (standsAsError). Severity is the whole of the threshold, which is what makes
 * this
 * "high and above" without restating any band - the two auto-severity checks map their
 * advisory band to a severity already (src/lib/vuln-findings.js), so a moderate advisory is
 * a warning and stops nothing, while a malicious-package advisory, which states no band at
 * all, is an error and stops the review like any other.
 *
 * Registry order, not encounter order: which finding happened to come first is an
 * accident of the add-on, and the closing block is a sentence the developer reads.
 * @param {import("./order.js").OrderedItem[]} ordered  The whole review, ordered.
 * @param {Record<string, *>} answers  Verdicts recorded so far, by item index. Empty for
 *   a review with no agent in it, where an escalated case stands for nothing because
 *   nobody has judged it.
 * @param {Registry} registry
 * @returns {{id: string, text: string}[]}
 */
function earlyExitReasons(ordered, answers, registry) {
  const { reasons } = registry.earlyExitProse();
  const hit = new Set();
  for (const item of ordered) {
    // An ordered entry WRAPS what it is about: `target` is the finding or the to-do item,
    // while the entry's own `section` is the band it is listed under and `index` is what a
    // verdict names it by. Reading a severity or a ruleId off the wrapper silently matches
    // nothing.
    //
    // Crossed through verbNamed rather than compared as text: a stored answer is text
    // until something says which verb it names, and that crossing happens in one place.
    const verdict = verbNamed(answers?.[String(item.index)]);
    if (!standsAsError(item, verdict, registry)) {
      continue;
    }
    const reason = registry.earlyExitFor(item.target?.ruleId);
    if (reason) {
      hit.add(reason);
    }
  }
  return Object.keys(reasons)
    .filter((id) => hit.has(id))
    .map((id) => ({ id, text: reasons[id] }));
}

/**
 * What a stopped review carries, or null when it did not stop: the authored line and the
 * reasons it lists, each with the id that named it.
 *
 * ONE producer for that value. Both renderers used to assemble it themselves from two
 * registry reads, which put the shape - and the null-vs-empty convention its consumers
 * branch on - in two places that could answer differently.
 *
 * The ids travel beside the texts because the JSON report is read by machines: a wording
 * edit changes the text, and a consumer matching on English silently stops recognising
 * the case it was written for. The terminal report prints only the texts.
 * @param {import("./order.js").OrderedItem[]} ordered  The whole review, ordered.
 * @param {Record<string, *>} answers  Verdicts recorded so far, by item index.
 * @param {Registry} registry
 * @returns {?{intro: string, reasons: {id: string, text: string}[]}}
 */
export function earlyExitOf(ordered, answers, registry) {
  const reasons = earlyExitReasons(ordered, answers, registry);
  return reasons.length
    ? { intro: registry.earlyExitProse().intro, reasons }
    : null;
}

/**
 * The to-do items a stopped review still lists: the ones nobody was going to be ASKED.
 *
 * Filtering the manual list is the whole of the strip. Three of the report's four to-do
 * sections are rendered from it, and the Summary re-orders the same array for its counts
 * (src/report/format.js), so the sections and the tally cannot disagree about what is
 * left. The sweep list is untouched: reading code is safe, and what it turns up is the
 * evidence for the halt rather than work the halt makes pointless.
 *
 * Asked of the ORDERED review rather than the raw list, because "would a reviewer have
 * been asked this" is not answered by the section an item was filed under. A case the
 * agent could not settle is routed onward keeping its section, and only the route says so.
 * @param {import("./order.js").OrderedItem[]} ordered  The whole review, ordered.
 * @param {import("./state.js").LoopState} [state]  Carries the route. Absent for a review
 *   with no agent in it, where nothing has been routed and every item starts where it
 *   stays.
 * @returns {ManualItem[]}
 */
export function withoutQuestions(ordered, state = {}) {
  return ordered
    .filter((x) => x.kind === "todo" && phaseNow(x, state) !== "ask")
    .map((x) => x.target);
}
