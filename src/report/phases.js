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
import { holds } from "../checks/condition.js";
import { ITEMLESS_ANSWERS } from "../checks/registry-vocabulary.js";

/**
 * The phase an item is answered in, from what the item IS.
 *
 * A finding is a claim the linter proved, so it is audited. A code-review case is one a
 * check could not settle, so it is settled. A question is one only a person can answer.
 *
 * A to-do item can name the phase a person is asked it in (`askedIn`), and then it opens
 * there. Two things write that, both onto the item itself: its check, which asks its
 * question in a phase of its own (`asked-in`, stamped when the item is rendered), and the
 * agent's `ask` verdict, which sends a case it could not settle on to a reviewer (stamped
 * when the hand-back is accepted). Carried BY the item, so the route travels with the case
 * wherever the review sorts it.
 * @param {import("./order.js").OrderedItem} item
 * @returns {string}
 */
export function phaseOf(item) {
  if (item.kind === "finding") {
    return "verify";
  }
  return item.target?.askedIn ?? (isQuestion(item) ? "ask" : "settle");
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
  return !(item.ref in (state.answers ?? {}));
}

/**
 * The steps this run prints for a phase, in order: those with no `when:` condition, and
 * those whose condition holds (src/checks/condition.js) over the facts this run meets.
 *
 * The facts are the flags the run was given, `aborted` once a finding has aborted the
 * review, `closing` when the phase is the one the review ends with, and every other name
 * the run record answers true (`sca`, `sweep-<artifact>`, `first`, `spawned`, `decided`).
 * Their names live in one place (REVIEW_PROMPT_FACTS, which the registry validates every
 * condition against), so a new fact is declared there and answered in the record - never
 * added to a test spelled out here. A fact the record does not answer is false, which is
 * what an absent one means.
 *
 * This is how an abort withholds what comes after it - the build that would run the
 * submission's code, the questions nobody should be asked, and in a review the
 * deterministic checks already aborted, every pass but the close - since a phase left with
 * no step is not issued.
 * @param {{answer?: string, steps: {when: ?object, text: string}[]}} phase
 * @param {{skip: string[], halted: boolean}} run  The run record: the flags it was given,
 *   whether the review was aborted, and each other fact by its own name.
 * @returns {object[]}
 */
export function stepsOf(phase, run = {}) {
  const facts = new Set(run.skip ?? []);
  if (run.halted === true) {
    facts.add("aborted");
  }
  // The one fact the phase itself contributes: the prompt it is printed in is the one
  // the review ends with.
  if (phase.answer === "end") {
    facts.add("closing");
  }
  for (const [name, value] of Object.entries(run)) {
    if (value === true) {
      facts.add(name);
    }
  }
  return phase.steps.filter(
    (step) => !step.when || holds(step.when, facts, run.values ?? {})
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
    items: openIn(phase.name, ordered, state),
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
 * Whether the items are put to anyone at all is not decided here. A flag that withholds
 * them (--llm-skip-manual) or an abort withholds the PHASE, through the steps its `when:`
 * leaves out (stepsOf) - a phase with no step is never issued, so its entries never go
 * out - and an aborted report drops the same items rather than leaving a to-do list under
 * a line saying it was never finished (src/report/early-exit.js).
 * @param {string} phaseName
 * @param {import("./order.js").OrderedItem[]} ordered
 * @param {import("./state.js").LoopState} state
 * @returns {import("./order.js").OrderedItem[]}
 */
export function openIn(phaseName, ordered, state) {
  // An itemless phase (spawn, build) needs no case here: no item is ever routed to it.
  return ordered.filter((x) => isOpen(x, state) && phaseOf(x) === phaseName);
}
