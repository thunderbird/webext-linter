// Belongs here: one pass of the REVIEW LOOP. `issue` hands a phase out, `accept` takes it
// back. Between them they are the whole protocol, and the pipeline does nothing else.
//
// Does NOT belong here: which phase is next (src/report/phases.js), what a hand-back must
// look like (src/report/handback.js), what a verdict DOES to an item
// (src/report/verdicts.js), or the prompt's layout (src/report/format.js).
//
// WHY TWO FUNCTIONS AND NOT A CONVERSATION: `state + a filled review file -> the next
// state + review file` is a pure file-to-file transformation, and so is `state -> report`.
// That is what makes this half of the tool testable at all - the old round trip could only
// be exercised by talking to an agent, which is why nothing ever drove it end to end.
import { orderReview } from "./order.js";
import { nextPhase, openIn, phaseNow } from "./phases.js";
import {
  HandbackRefused,
  answersOf,
  entriesFor,
  readHandback,
  reviewFile,
  sweepRows,
  writeReviewFile,
} from "./handback.js";
import { writeState } from "./state.js";
import { reviewItems } from "./items.js";
import { mergeSweepResults } from "./sweep.js";
import { resolveHolds } from "./finding.js";
import {
  headerLines,
  issuesBodyLines,
  locusLabeler,
  summaryBodyLines,
} from "./format.js";
import { applyVerdicts } from "./verdicts.js";
import { renderFindings } from "./responses.js";
import { VERB } from "./verbs.js";

/** The verdict that does not settle an item but MOVES it: a case the agent could not
 *  settle from the package goes on to the reviewer, keeping its index, so the question a
 *  person is asked is addressable by the number the agent saw. */

/**
 * Hand out the next phase, or say the review is settled.
 *
 * Writes both files: the state (the linter's, overwritten so the agent can never hand back
 * an older one) and the review file (the agent's, at one path for the whole review).
 * @param {import("./state.js").LoopState} state  Mutated: it records which phase went out.
 * @param {string} stateFile
 * @param {{name: string, answer: string, verbs: string[], intro: string,
 *   steps: object[]}[]} phases
 * @param {import("../checks/registry.js").Registry} registry  Renders each entry for
 *   THIS reader, at hand-out - never stored, so the same item can be worded one way
 *   here and another for the reviewer.
 * @returns {?{phase: object, steps: object[], entries: object[]}}  Null when settled.
 */
/**
 * The rows a `hints` phase asks about: one per swept check, when this run sweeps and has
 * not swept yet.
 *
 * Read off `run.sweep`, never off `preSweep`: --llm-skip-sweep leaves the instructions
 * standing and withholds the asking (src/pipeline.js), so a review can carry a full
 * `preSweep` and still ask nothing. Called by BOTH legs of the round trip, because what a
 * phase hands out and what it accepts back have to be the same question - asked twice from
 * two fields, they can differ, and then no hand-back satisfies the pass.
 * @param {import("./state.js").LoopState} state
 * @returns {object[]}
 */
function setupRows(state) {
  return state.run.sweep && state.sweep == null
    ? sweepRows(state.preSweep)
    : [];
}

export function issue(state, stateFile, phases, registry) {
  const run = state.run;
  const ordered = orderReview(state.report.findings, state.manual);
  const next = nextPhase(phases, ordered, state, run);
  if (!next) {
    return null;
  }
  const { phase, steps } = next;
  // A `hints` phase's rows are the sweep's, keyed by check. Every other phase hands over
  // its open items, rendered for THIS reader - never stored, so the same item can be
  // worded one way here and another for the reviewer.
  const entries =
    phase.answer === "hints"
      ? setupRows(state)
      : phaseEntries(state, registry, phase, run);
  state.phase = phase.name;
  writeState(stateFile, state);
  writeReviewFile(state.review, reviewFile(stateFile, entries));
  return { phase, steps, entries };
}

/**
 * Take a phase back: check what came back against what went out, and record it.
 *
 * Nothing in the state changes when this throws, so a corrected hand-back resumes exactly
 * where it was - which is why the caller does not re-print the prompt. The agent still has
 * it, and re-issuing the same text against the same input invites a loop.
 * @param {import("./state.js").LoopState} state  Mutated on success only.
 * @param {string} file  What the agent passed to --llm-verdict.
 * @param {{name: string, answer: string, verbs: string[]}[]} phases
 * @param {import("../checks/registry.js").Registry} registry  Renders the entries this
 *   phase asked about, so a hand-back is checked against the same question that went out,
 *   and routes what a sweep found - which check each hint belongs to is the registry's
 *   to say.
 * @returns {{phase: object, answers: Map<string, *>, swept?: string[]}}
 * @throws {HandbackRefused}
 */
export function accept(state, file, phases, registry) {
  const phase = phases.find((p) => p.name === state.phase);
  if (!phase) {
    throw new HandbackRefused(
      `this review is not waiting on a phase called "${state.phase}"`
    );
  }
  const { entries } = readHandback(file);
  // What went out: the same question `issue` answered, asked again through the same
  // helper rather than stored, so the two cannot disagree about what was asked.
  const asked =
    phase.answer === "hints"
      ? // A phase can have steps and no entries - `setup` in a run with no sweep starts
        // agents and asks nothing - and then an empty hand-back is the right one.
        setupRows(state)
      : phaseEntries(state, registry, phase, state.run);
  const keyOf = (e) =>
    phase.answer === "hints" ? e.check : String(e.index ?? "undefined");
  const answers = answersOf(entries, asked, phase, keyOf);
  // Recorded only once every check above has passed, so a refusal leaves the review
  // exactly as it was.
  state.issued ??= [];
  if (!state.issued.includes(phase.name)) {
    state.issued.push(phase.name);
  }
  if (phase.answer === "hints") {
    state.sweep = Object.fromEntries(answers);
    return { phase, answers, swept: routeSweep(state, registry) };
  }
  state.answers ??= {};
  state.route ??= {};
  for (const [index, value] of answers) {
    if (value === VERB.ask) {
      // Not settled: moved. It keeps its index and opens in the phase that asks a person.
      state.route[index] = "ask";
    } else {
      // Written down as text, because the state is JSON. A verb spells itself; a person's
      // answer is already their own words.
      state.answers[index] = String(value);
    }
  }
  return { phase, answers };
}

export { HandbackRefused };

/**
 * The entries one phase asks about, rendered.
 *
 * Built from `reviewItems` - the same array the report is numbered from - so an entry
 * carries the wording the review already gave it: a question's `message` and the answers
 * it offers, a case's `instructions`, a finding's locus. The ordered walk decides WHICH,
 * the item file decides WHAT, and they are joined by the index, which is the one thing
 * both agree on.
 * @param {import("./state.js").LoopState} state
 * @param {import("../checks/registry.js").Registry} registry
 * @param {{name: string, answer: string}} phase
 * @returns {object[]}
 */
function phaseEntries(state, registry, phase, run) {
  const ordered = orderReview(state.report.findings, state.manual);
  const open = openIn(phase.name, ordered, state, run);
  if (open.length === 0) {
    return [];
  }
  const mode = { sca: state.report.sca };
  const rendered = new Map(
    reviewItems({
      findings: state.report.findings,
      manual: state.manual,
      choices: registry.manualReviewChoices(),
      labelOf: locusLabeler(mode, registry.checkInputs()),
    }).map((item) => [item.index, item])
  );
  return entriesFor(
    open.map((x) => rendered.get(x.index)).filter(Boolean),
    phase
  );
}

/**
 * The Review Details block a reviewer is handed with the finished report, when no phase
 * handed it over already.
 *
 * It names the files written FOR the reviewer, and they exist to be read WHILE the
 * questions are answered - so the `ask` phase hands the block over before it asks
 * anything. When there is nothing to ask, that phase is never issued and the reviewer
 * would never be told those files exist, so it travels with the report instead: once,
 * either way, and never twice.
 * @param {import("./state.js").LoopState} state
 * @returns {string}
 */
function detailBlock(state) {
  return (state.issued ?? []).includes("ask")
    ? ""
    : `\n${reviewDetails(state)}\n`;
}

/**
 * The Review Details block itself, for the phase that hands it over.
 * @param {import("./state.js").LoopState} state
 * @returns {string}
 */
export function reviewDetails(state) {
  // Without the blank `section` opens with: the block is handed over as a thing of its
  // own here, not as one section among others in a report.
  return headerLines(reportMeta(state)).join("\n").replace(/^\n/, "");
}

/**
 * The finished review: every answer applied, and the report the last prompt carries.
 *
 * Built from the STATE alone. The deterministic review ran ONCE, in the --llm-review run,
 * and nothing re-derives it - which is why anything the report reads has to be in the
 * state, and why the invariant test (equivalent decisions produce today's report byte for
 * byte) is really a completeness check on that shape.
 *
 * `applyVerdicts` settles each item by INDEX: an answer names an item by its position in
 * the printed report, and that order comes from orderReview over the STORED
 * findings and manual items - so an index cannot shift between passes, because its input
 * cannot change.
 * @param {import("./state.js").LoopState} state
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {{review: object, applied: string[]}}
 */
export function settle(state, registry) {
  const ruleInputs = registry.checkInputs();
  // `mode` is an enum Proxy that refuses an unknown property, so it never reaches the
  // state - artifactLabel reads one fact off it, and that is what was stored.
  const mode = { sca: state.report.sca };
  const labelOf = locusLabeler(mode, ruleInputs);
  const { findings } = state.report;
  const { applied } = applyVerdicts({
    findings,
    manual: state.manual,
    // applyVerdicts walks ENTRIES keyed by a NUMBER. The state holds the answers as an
    // object because that is what survives JSON, and an object's keys are strings.
    verdicts: new Map(
      Object.entries(state.answers ?? {}).map(([i, v]) => [Number(i), v])
    ),
    registry,
    labelOf,
    // Who was asked is the PHASE's answer, not the item's: a case the agent sent on with
    // `ask` is answered by a reviewer while keeping the section it was filed under, so
    // reading that section would refuse the words they gave.
    asking: (x) => phaseNow(x, state) === "ask",
  });
  // A reported case became a finding carrying only its locus and slots, so word it from
  // the registry like any other - the same text either way.
  renderFindings(findings, registry);
  resolveHolds(findings);
  return {
    applied,
    // The Review Details block, above the finished report. Pure from meta, which is
    // stored - so this pass prints what a settled report has always printed, without the
    // add-on being read a second time.
    //
    // `details` is empty when the `ask` phase already handed the block over: it says the
    // same thing either way, and saying it twice would have the reviewer reading a list
    // of paths they have already been given.
    details: detailBlock(state),
    // The tally, which only this pass can be right about: every earlier one runs before
    // the answers are applied, and would count items the reviewer is in the middle of
    // settling.
    tally: summaryBodyLines(findings, state.manual, null).join("\n"),
    // The developer's half of the report, without the section header the linter prints
    // around it - this is pasted into a response box, not into a terminal.
    report: issuesBodyLines(
      orderReview(findings, state.manual).filter((x) => x.kind === "finding"),
      registry.issueHeadings(),
      registry.verdictIntros(),
      labelOf,
      mode
    ).join("\n"),
    review: {
      findings,
      // The sweep stops being asked: this review has been swept, and leaving it standing
      // would ask a reviewer for work already in the report above it.
      meta: {
        ...state.report.meta,
        manualReview: state.manual,
        preSweep: null,
      },
      mode,
      // The registry's, recomputed rather than stored: a copy in the state would outlive
      // an edit to the registry and word this review from a version nobody is running.
      ruleInputs,
      issueHeadings: registry.issueHeadings(),
      verdictIntros: registry.verdictIntros(),
    },
  };
}

/** The meta the Review Details block names: the review's own artifacts, plus the files
 *  written FOR the reviewer - the description, the build report, the unpacked package.
 *  Those are what the block exists to hand over. The loop's own bookkeeping is not:
 *  the state and review files are the linter talking to itself, and a reviewer has no
 *  use for either. */
function reportMeta(state) {
  const {
    prompting: _prompting,
    sweepFile: _sweep,
    stateFile: _state,
    reviewFile: _review,
    ...rest
  } = state.report.meta;
  return { ...rest, manualReview: state.manual, preSweep: null };
}

/**
 * Send what the sweep found where its check's own cases go.
 *
 * A hint becomes a case of the check it names - an escalation where that check escalates, a
 * finding where it does not - so everything downstream sees the SAME two lists and cannot
 * tell a swept case from a deterministic one.
 *
 * This runs while accepting the `setup` phase, whose rows are keyed by check and carry no
 * index; `verify` is the first pass that hands one out. So nothing is renumbered by what is
 * added here, because nothing has been numbered yet.
 * @param {import("./state.js").LoopState} state
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {string[]}  What was routed, for the audit line.
 */
function routeSweep(state, registry) {
  const results = Object.entries(state.sweep ?? {}).flatMap(([check, hints]) =>
    (hints ?? []).map((h) => ({ ...h, check }))
  );
  if (results.length === 0) {
    return [];
  }
  const { manual, findings, applied } = mergeSweepResults({
    results,
    manual: state.manual,
    findings: state.report.findings,
    preSweep: state.preSweep,
    registry,
    file: state.review,
  });
  state.manual = manual;
  state.report.findings = findings;
  // Worded NOW, not left to `settle`. orderReview groups findings by their message, and a
  // swept one arrives with none - so an unrendered finding would group one way while the
  // verify phase asks about it and another once the report is built, moving items under an
  // index that is supposed to mean the same case for the life of the review.
  renderFindings(state.report.findings, registry);
  // The sweep is over: leaving it standing would ask a reviewer for work that is now in
  // the lists above it.
  state.preSweep = null;
  return applied;
}
