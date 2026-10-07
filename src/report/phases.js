// Belongs here: which phase an item is in, which phase is issued next, and which of a
// phase's steps a run prints. The phase machine, and nothing else.
//
// Does NOT belong here: the file the agent reads (src/report/state.js writes the linter's
// half), what a hand-back must look like (src/report/handback.js), or the prompt's layout
// (src/report/format.js).
//
// ONE ROUTING FUNCTION, deliberately. `phaseOf` is the only thing that decides where a
// case is answered, so a later route - an escalation the agent screens before a reviewer
// sees it - is one condition here rather than a rule copied into the renderer, the phase
// builder and the verdict walk, where three copies drift.
import { isQuestion } from "./order.js";
import { ITEMLESS_ANSWERS } from "../checks/registry-vocabulary.js";

/**
 * The phase an item is answered in, from what the item IS.
 *
 * A finding is a claim the linter proved, so it is audited. A code-review case is one a
 * check could not settle, so it is settled. A question is one only a person can answer.
 * Nothing else decides it - not a flag, not the run's shape, and never the case itself.
 * @param {import("./order.js").OrderedItem} item
 * @returns {string}
 */
export function phaseOf(item) {
  if (item.kind === "finding") {
    return "verify";
  }
  return isQuestion(item) ? "ask" : "settle";
}

/**
 * Where an item is open NOW: its route when a verdict moved it, its kind otherwise.
 *
 * Only one verdict moves an item - `ask`, which sends a case the agent could not settle on
 * to the reviewer - and it keeps its index when it does, so the question a person is asked
 * is addressable by the same number the agent saw.
 * @param {import("./order.js").OrderedItem} item
 * @param {import("./state.js").LoopState} state
 * @returns {string}
 */
export function phaseNow(item, state) {
  return state.route?.[String(item.index)] ?? phaseOf(item);
}

/**
 * Whether an item still needs an answer.
 *
 * Answered is answered: an item whose answer is recorded never reappears, which is what
 * makes a single overwritten file safe to re-read.
 * @param {import("./order.js").OrderedItem} item
 * @param {import("./state.js").LoopState} state
 * @returns {boolean}
 */
export function isOpen(item, state) {
  return !(String(item.index) in (state.answers ?? {}));
}

/**
 * The steps this run prints for a phase, in order, after its markers.
 *
 * Two answers decide it: what the run was told to leave out, and which of the conditions
 * this run meets. A step carries at most one marker, so whether it prints is one answer
 * and never two at once.
 *
 * A `run:` marker is LOOKED UP in the run record rather than compared against a name
 * spelled here. The names live in one place (REVIEW_PROMPT_RUNS, which the registry
 * validates each marker against), so adding a condition is declaring it there and
 * answering it in the record - never editing a conjunction that a new condition could be
 * left out of. A condition the record does not answer is false, which is what an absent
 * one means.
 *
 * Whether the review STOPPED early is read against every step, beside its marker: a step
 * flagged `skip-if-stopped` is left out of a stopped review, one flagged
 * `skip-if-not-stopped` out of every other. That is how a stop withholds what comes after
 * it - the build that would run the submission's code, the questions nobody should be
 * asked - since a phase left with no step is not issued.
 * @param {{steps: {skip: ?string, run: ?string, skipIfStopped?: boolean,
 *   skipIfNotStopped?: boolean, text: string}[]}} phase
 * @param {{skip: string[], halted: boolean}} run  The run record, answering each condition
 *   by its own name, and whether the review stopped.
 * @returns {object[]}
 */
export function stepsOf(phase, run = {}) {
  const skipped = new Set(run.skip ?? []);
  const halted = run.halted === true;
  return phase.steps.filter(
    (step) =>
      !skipped.has(step.skip) &&
      ((step.run ?? null) === null || run[step.run] === true) &&
      !(halted ? step.skipIfStopped : step.skipIfNotStopped)
  );
}

/**
 * What a phase has to do this pass: the steps that survive, and the items still open in it.
 *
 * Both halves matter, because either alone is work. `spawn` in an XPI review with no sweep
 * has one step and no items - an agent to start, nothing to answer - and a phase whose
 * items are all settled has neither and is skipped.
 * @param {{name: string, steps: object[]}} phase
 * @param {import("./order.js").OrderedItem[]} ordered
 * @param {import("./state.js").LoopState} state
 * @param {{skip: string[], halted: boolean}} run  The run record (stepsOf).
 * @returns {{steps: object[], items: object[]}}
 */
export function workOf(phase, ordered, state, run) {
  return {
    steps: stepsOf(phase, run),
    items: openIn(phase.name, ordered, state, run),
  };
}

/**
 * The next phase to issue, or null when the review is settled.
 *
 * A phase is issued when it has WORK - surviving steps, or open items. This is also what
 * ends the loop: NOT "no item is still open", which an item routed to a phase this run
 * never issues would block forever, but "no phase left to issue".
 * @param {{name: string, answer: string, steps: object[]}[]} phases  In the order they
 *   are issued.
 * @param {import("./order.js").OrderedItem[]} ordered
 * @param {import("./state.js").LoopState} state
 * @param {{skip: string[], halted: boolean}} run  The run record (stepsOf).
 * @returns {?{phase: object, steps: object[], items: object[]}}
 */
export function nextPhase(phases, ordered, state, run) {
  const issued = new Set(state.issued ?? []);
  for (const phase of phases) {
    const { steps, items } = workOf(phase, ordered, state, run);
    if (steps.length === 0) {
      continue;
    }
    // A phase exists to settle ENTRIES, so with none there is nothing to issue it for -
    // whatever its steps would otherwise say. An itemless phase (`spawn`, `build`) is the
    // exception by nature: its work is what its steps do, and it is issued ONCE, because a
    // second pass would do all of it again. A run whose markers leave it no step never
    // gets here - the check above has already passed it over.
    if (ITEMLESS_ANSWERS.includes(phase.answer)) {
      if (!issued.has(phase.name)) {
        return { phase, steps, items };
      }
      continue;
    }
    if (items.length > 0) {
      return { phase, steps, items };
    }
  }
  return null;
}

/**
 * The items this phase still has to ask about, in review order.
 *
 * ONE place answers this, because two would drift: the loop asks it to decide whether a
 * phase is issued at all, and asks it again to render what that phase hands over. Two
 * answers means a phase issued for entries it never shows, or entries shown that nothing
 * asked for.
 *
 * A SKIP withholds the entries, not only the step that would use them. `--llm-skip-manual`
 * means those items are not put to anyone - they stay in the report for the reviewer to
 * work through later - so leaving them in the file would hand the agent questions it was
 * told not to ask and a handover demanding an answer for each.
 *
 * An EARLY EXIT is not decided here. It withholds the phase itself, through the steps it
 * leaves out (stepsOf, `skip-if-stopped`), and the report drops the same items rather
 * than leaving a to-do list under a line saying it was never finished
 * (src/report/early-exit.js).
 * @param {string} phaseName
 * @param {import("./order.js").OrderedItem[]} ordered
 * @param {import("./state.js").LoopState} state
 * @param {{skip: string[]}} run
 * @returns {import("./order.js").OrderedItem[]}
 */
export function openIn(phaseName, ordered, state, { skip = [] } = {}) {
  // An itemless phase (spawn, build) needs no case here: no item is ever routed to it.
  if (phaseName === "ask" && skip.includes("manual")) {
    return [];
  }
  return ordered.filter(
    (x) => isOpen(x, state) && phaseNow(x, state) === phaseName
  );
}
