// Belongs here: one pass of the REVIEW LOOP. `issue` hands a phase out, `accept` takes it
// back. Between them they are the whole protocol, and the pipeline does nothing else.
//
// Does NOT belong here: which phase is next (src/report/phases.js), what a hand-back must
// look like (src/report/handback.js), what a verdict DOES to an item
// (src/report/verdicts.js), or the prompt's layout (src/report/format.js).
//
// WHY TWO FUNCTIONS AND NOT A CONVERSATION: `state + a filled review file -> the next
// state + review file` is a pure file-to-file transformation, and so is `state -> report`.
// That is what makes this half of the tool testable without talking to an agent.
import { orderReview } from "./order.js";
import { nextPhase, openIn, phaseOf, stepsOf } from "./phases.js";
import { earlyExitOf, withoutQuestions } from "./early-exit.js";
import {
  HandbackRefused,
  answersOf,
  productWritten,
  entriesFor,
  readHandback,
  reviewFile,
  writeReviewFile,
} from "./handback.js";
import { writeState } from "./state.js";
import { rethrowIfFatal } from "../lib/errors.js";
import { writeReportFile } from "./report-file.js";
import { reviewItems } from "./items.js";
import { mergeSweepResults } from "./sweep.js";
import { readSweepAnswers, sweepSlots } from "./sweep-files.js";
import { resolveHolds } from "./finding.js";
import { artifactRoots } from "../lib/artifacts.js";
import {
  detailLinkLines,
  earlyExitLines,
  issuesBodyLines,
  locusLabeler,
  summaryBodyLines,
} from "./format.js";
import { applyVerdicts, pickedChoice } from "./verdicts.js";
import { renderFindings } from "./responses.js";
import { VERB } from "./verbs.js";
import { ITEMLESS_ANSWERS } from "../checks/registry-vocabulary.js";

/**
 * What this run was told, plus what the review has since decided for itself.
 *
 * `state.run` records the flags the review was STARTED with, and never changes. Whether
 * the review was aborted early is not one of those: it is derived from the findings that
 * still stand, so it can change with every verdict - a pass that withdraws the finding
 * which aborted the review puts its question block back.
 *
 * Derived in ONE place, every pass, and read by `issue` to decide which phase goes out
 * and which of its steps it prints (src/report/phases.js stepsOf). What a phase asks
 * about does not depend on it, which is what lets `accept` re-derive what went out from
 * the review alone.
 * @param {import("./state.js").LoopState} state
 * @param {import("./order.js").OrderedItem[]} ordered  The whole review, ordered.
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {{skip: string[], sca: boolean, halted: boolean}}
 */
function runOf(state, ordered, registry) {
  const halted = Boolean(
    earlyExitOf(ordered, verdictsOf(state, ordered, registry), registry)
  );
  return { ...state.run, halted };
}

/**
 * The answers recorded so far, each as the verdict it settles its item with.
 *
 * An agent's answer already IS a verdict. A person's is their words: the label they picked,
 * read as the verdict the registry says it settles with (Clear, Report), or anything else
 * they typed, which reports the case - the same reading applyVerdicts gives it once the
 * review is settled (src/report/verdicts.js settleAnswer). Read here too, so that a person
 * who reports a case that aborts the review aborts it on the very next pass, before
 * anything further is put to them, rather than only in the closing report.
 *
 * Keyed on the RECORDED answers, never on open items: an answered item is not open. And
 * nothing is validated here - an empty or overlong answer is refused when the review is
 * settled, and refusing it on every pass instead would break a loop that has already
 * accepted it.
 * @param {import("./state.js").LoopState} state
 * @param {import("./order.js").OrderedItem[]} ordered  The whole review, ordered.
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {Record<string, string>}
 */
function verdictsOf(state, ordered, registry) {
  const answers = state.answers ?? {};
  const asking = askedByPerson(registry);
  const choices = registry.manualReviewChoices();
  const out = { ...answers };
  for (const x of ordered) {
    const index = String(x.index);
    if (index in answers && asking(x)) {
      out[index] =
        pickedChoice(answers[index], choices)?.verdict ?? String(VERB.reported);
    }
  }
  return out;
}

/**
 * Whether a person answers this item: the phase it is open in takes their words. Read off
 * the phase's answer kind rather than its name, so every phase that asks a person reads
 * its answers the same way.
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {(x: import("./order.js").OrderedItem) => boolean}
 */
function askedByPerson(registry) {
  const words = new Set(
    registry
      .llmPhases()
      .phases.filter((p) => p.answer === "words")
      .map((p) => p.name)
  );
  return (x) => words.has(phaseOf(x));
}

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
 * @returns {{phase: object, steps: object[], entries: object[],
 *   settled: ?ReturnType<typeof settle>}}  `settled` is the finished review, for the
 *   closing phase only.
 */
export function issue(state, stateFile, phases, registry) {
  const ordered = orderReview(state.report.findings, state.manual);
  const run = runOf(state, ordered, registry);
  const next = nextPhase(phases, ordered, state, run);
  if (!next) {
    // The registry refuses a loop without a closing phase, and that phase always has a
    // step to print - so nothing reaches here but a broken wiring.
    throw new Error("the review loop has no phase left to issue");
  }
  const { phase } = next;
  // The closing phase hands over the FINISHED review: every answer applied, and the report
  // the reviewer sends written. Whether the review was aborted is read off that settled review
  // rather than the run's - a verdict applied only now can still decide it - so the steps
  // are chosen again against it. Settled on a COPY, as below: the state is written after
  // this, and a review settled in place would be settled twice by anything that read it.
  const settled =
    phase.answer === "end" ? settle(structuredClone(state), registry) : null;
  const steps = settled
    ? stepsOf(phase, { ...run, halted: settled.earlyExit })
    : next.steps;
  // An itemless phase asks about nothing in this file: its work is what its steps do, and
  // each product lands in a file of its own. Every other phase hands over its open items,
  // rendered for THIS reader - never stored, so the same item can be worded one way here
  // and another for the reviewer.
  const entries = ITEMLESS_ANSWERS.includes(phase.answer)
    ? []
    : phaseEntries(state, registry, phase, ordered);
  state.phase = phase.name;
  // The `details` phase hands the reviewer the Review Details block, and that block links
  // the report. Refresh the file first, so the link opens the review as it stands rather
  // than nothing at all - the reviewer reads it to answer the questions that follow.
  //
  // Settled on a COPY: settle() applies the verdicts in place, and this pass is not the
  // last. What the copy answers is "what would the report say if the review ended now",
  // which is the review minus what the pending questions have yet to produce.
  //
  // Only on this phase, not on every pass: settling walks every answer recorded so far, and
  // a throw inside issue() would break the loop over a file nobody has been handed yet.
  if (settled) {
    writeReportFile(state.paths?.report, settled.report);
  } else if (phase.name === "details") {
    writeReportFile(
      state.paths?.report,
      settle(structuredClone(state), registry).report
    );
  }
  writeState(stateFile, state);
  writeReviewFile(state.review, reviewFile(stateFile, entries));
  return { phase, steps, entries, settled };
}

/**
 * Every value a phase's steps name, filled from the state - the one list both the first run
 * and every later pass print a prompt from.
 * @param {import("./state.js").LoopState} state
 * @param {{settled: ?object}} issued  What `issue` handed out: the closing phase carries the
 *   finished review, whose Review Details and tally it hands over.
 * @returns {Object<string, string>}
 */
export function loopSlots(state, issued) {
  const paths = state.paths ?? {};
  return {
    review: state.review,
    command: `node verify.js --llm-verdict ${state.review}`,
    schemaCache: paths.schemaCache ?? "",
    description: paths.description ?? "",
    build: paths.build ?? "",
    buildCopy: paths.buildCopy ?? "",
    buildDiff: paths.buildDiff ?? "",
    scaRoot: paths.scaRoot ?? "",
    xpiRoot: paths.xpiRoot,
    schema: paths.schema,
    // Named because `details` can be the FIRST phase issued - a review with no findings
    // and nothing to settle opens there - and that is a phase that hands the block over.
    // The closing phase hands over the finished review's block instead, which ends on
    // what aborted it where something did.
    details: issued.settled?.details ?? reviewDetails(state),
    tally: issued.settled?.tally ?? "",
    ...sweepSlots(state),
  };
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
  if (phase.answer === "end") {
    throw new HandbackRefused(
      "this review is finished - nothing is handed back after its closing prompt"
    );
  }
  const { entries } = readHandback(file);
  // What went out: the same question `issue` answered, asked again through the same
  // helper rather than stored, so the two cannot disagree about what was asked. An
  // itemless phase asks about no entry at all - its work is what its steps do, and each
  // product lands in a file of its own - so what it hands out is empty and so must be what
  // comes back.
  // The one ordering of this hand-back: what went out is read from it, and an answer that
  // moves a case finds that case in it - so both name the same item by the same number.
  const ordered = orderReview(state.report.findings, state.manual);
  const asked = ITEMLESS_ANSWERS.includes(phase.answer)
    ? []
    : phaseEntries(state, registry, phase, ordered);
  const answers = answersOf(entries, asked, phase, (e) =>
    String(e.index ?? "undefined")
  );
  // Read BEFORE anything is recorded, because a sweep file that cannot be acted on has to
  // leave the review exactly as it was - the agent fixes that one file and hands back
  // again.
  const swept = phase.answer === "hints" ? sweptResults(state) : null;
  // Recorded only once every check above has passed, so a refusal leaves the review
  // exactly as it was.
  state.issued ??= [];
  if (!state.issued.includes(phase.name)) {
    state.issued.push(phase.name);
  }
  if (phase.answer === "hints") {
    state.sweep = swept;
    return { phase, answers, swept: routeSweep(state, registry) };
  }
  // A product exists only where the reviewer wanted the work that makes it, so whether it
  // came back is recorded here, once, and every later pass says the same thing about it.
  if (phase.product && productWritten(state.paths?.[phase.product])) {
    state.products = [...(state.products ?? []), phase.product];
  }
  if (phase.answer === "none") {
    return { phase, answers };
  }
  state.answers ??= {};
  const byIndex = new Map(ordered.map((x) => [String(x.index), x]));
  for (const [index, value] of answers) {
    if (value === VERB.ask) {
      // Not settled: moved. The case itself carries where it is asked now (phaseOf), so a
      // later pass that renumbers the review still finds it there.
      byIndex.get(index).target.askedIn = "ask";
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
 * @param {import("./order.js").OrderedItem[]} ordered  The whole review, ordered - the
 *   caller's, so what it hands out and what it acts on are numbered alike.
 * @returns {object[]}
 */
function phaseEntries(state, registry, phase, ordered) {
  const open = openIn(phase.name, ordered, state);
  if (open.length === 0) {
    return [];
  }
  const mode = { sca: state.report.sca };
  const rendered = new Map(
    reviewItems({
      findings: state.report.findings,
      manual: state.manual,
      choices: registry.manualReviewChoices(),
      labelOf: locusLabeler(mode),
    }).map((item) => [item.index, item])
  );
  return entriesFor(
    open.map((x) => rendered.get(x.index)).filter(Boolean),
    phase,
    // Keyed by the artifact a finding carries, so resolving a path is a lookup rather
    // than a branch on the review mode - and asked of the module that owns the names, so
    // this cannot drift from what a locus is stamped with.
    artifactRoots(state.paths)
  );
}

/**
 * What the LAST prompt hands over: every path this review named, and - where the review
 * was aborted - the line saying so.
 *
 * Handed over on EVERY settled review, including one whose `details` phase already showed the
 * same block. That is not a duplicate: the `details` copy exists to be read WHILE the questions
 * are answered, and by the time they have been, it is far above the reviewer. The report they
 * are about to send is one of these rows, and so is the package it is about.
 *
 * The early-exit lines belong to the block rather than to the closing phase's steps, because
 * the reasons are the review's, not authored text: only the block can list the ones that
 * aborted THIS review. earlyExitLines answers [] for a review that was not aborted, so this is
 * asked unconditionally and the block simply ends sooner.
 * @param {import("./state.js").LoopState} state
 * @param {?{intro: string, reasons: {id: string, text: string}[]}} earlyExit  What aborted the
 *   review, or null where nothing did.
 * @returns {string}
 */
function finalDetails(state, earlyExit) {
  return [reviewDetails(state), ...earlyExitLines(earlyExit)].join("\n");
}

/**
 * The Review Details block itself, for the phase that hands it over.
 * @param {import("./state.js").LoopState} state
 * @returns {string}
 */
export function reviewDetails(state) {
  // The chat renderer, not the report's: what a phase hands over is read in a client, not
  // in a terminal, so its paths are links rather than an aligned block.
  return detailLinkLines(reportMeta(state)).join("\n");
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
 * @returns {{review: object, applied: string[], earlyExit: boolean, details: string,
 *   tally: string, report: string}}
 */
export function settle(state, registry) {
  // `mode` is an enum Proxy that refuses an unknown property, so it never reaches the
  // state - artifactLabel reads one fact off it, and that is what was stored.
  const mode = { sca: state.report.sca };
  const labelOf = locusLabeler(mode);
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
    // Who was asked is the PHASE's answer, not the item's section: a case the agent sent
    // on with `ask` is answered by a reviewer while keeping the section it was filed
    // under, so reading that section would refuse the words they gave.
    asking: askedByPerson(registry),
  });
  // A reported case became a finding carrying only its locus and slots, so word it from
  // the registry like any other - the same text either way.
  renderFindings(findings, registry, mode);
  resolveHolds(findings);
  // Decided HERE, on the findings that survived every verdict, rather than carried over
  // from the run that produced them: the agent may have withdrawn the very finding that
  // aborted the review, and then nothing aborted it. What remains is what the reviewer
  // is left with - the questions were never put to anyone, so the report drops them
  // instead of listing work under a line saying the review did not finish.
  const ordered = orderReview(findings, state.manual);
  const earlyExit = earlyExitOf(ordered, {}, registry);
  const manual = earlyExit ? withoutQuestions(ordered) : state.manual;
  return {
    applied,
    // Which hand-over text the last prompt carries. Telling an agent the review is
    // settled, when it was aborted, is the one thing the second text exists to avoid.
    earlyExit: Boolean(earlyExit),
    // The Review Details block the reviewer is left with, and the line saying the review
    // was aborted where one was. Pure from meta, which is stored - so this pass prints what a
    // settled report has always printed, without the add-on being read a second time.
    details: finalDetails(state, earlyExit),
    // The tally, which only this pass can be right about: every earlier one runs before
    // the answers are applied, and would count items the reviewer is in the middle of
    // settling.
    tally: summaryBodyLines(findings, manual, null).join("\n"),
    // The developer's half of the report, without the section header the linter prints
    // around it - this is pasted into a response box, not into a terminal. It goes to the
    // file below rather than into the prompt, so no model is ever in a position to reword
    // it (src/report/report-file.js).
    report: issuesBodyLines(
      orderReview(findings, manual).filter((x) => x.kind === "finding"),
      registry.issueHeadings(),
      registry.verdictIntros(),
      labelOf,
      mode,
      earlyExit
    ).join("\n"),
    review: {
      findings,
      // The sweep list is not handed on. Either agents swept, and its results are in the
      // report above, or the run was told to leave the sweep out (--llm-skip-sweep), and
      // then it is left out for the reviewer too.
      meta: {
        ...state.report.meta,
        manualReview: manual,
        // Spread rather than set: a review that was not aborted carries no such key, which
        // is the shape the plain path produces for the same outcome.
        ...(earlyExit ? { earlyExit } : {}),
        preSweep: null,
      },
      mode,
      // The registry's, recomputed rather than stored: a copy in the state would outlive
      // an edit to the registry and word this review from a version nobody is running.
      issueHeadings: registry.issueHeadings(),
      verdictIntros: registry.verdictIntros(),
    },
  };
}

/** The meta the Review Details block names: which add-on this is and where it can be read
 *  (the unpacked package), plus the files written for the reviewer - the description, the
 *  build report, and the build diff where the build phase wrote one. Those are what the
 *  block exists to hand over. The loop's own bookkeeping is not: the state and review
 *  files are the linter talking to itself, and a reviewer has no use for either. */
function reportMeta(state) {
  const {
    prompting: _prompting,
    stateFile: _state,
    reviewFile: _review,
    ...rest
  } = state.report.meta;
  return {
    ...rest,
    ...(state.products?.includes("buildDiff")
      ? { buildDiffFile: state.paths.buildDiff }
      : {}),
    manualReview: state.manual,
  };
}

/**
 * Everything the sweeping agents wrote, read back off their own files.
 *
 * ONE READ for the whole review, because a sweep file that cannot be acted on must leave
 * the review untouched: a half-applied sweep would record one tree's hints and then
 * refuse on the other, and the agent's fix would replay the first.
 *
 * The files are the ones THIS run wrote (state.paths.sweeps), so which labels belong in
 * each and what each label means are the review's own answers, never the file's. Read
 * only where a tree was actually asked - `--llm-skip-sweep` writes none, and then there
 * is nothing to read and nothing to say about it.
 * Null where no tree was asked, which is not the same as every tree answering with
 * nothing - the distinction the answers files are built around, kept here too.
 * @param {import("./state.js").LoopState} state
 * @returns {?{check: string, artifact: string, file: string, line: ?number,
 *   hint: ?string}[]}
 * @throws {HandbackRefused}
 */
function sweptResults(state) {
  const trees = Object.entries(state.paths?.sweeps ?? {});
  if (trees.length === 0) {
    return null;
  }
  const out = [];
  for (const [artifact, paths] of trees) {
    const asked = (state.preSweep?.items ?? []).filter(
      (s) => s.artifact === artifact
    );
    try {
      out.push(...readSweepAnswers(paths.answers, asked));
    } catch (err) {
      rethrowIfFatal(err);
      throw new HandbackRefused(err.message);
    }
  }
  return out;
}

/**
 * Send what the sweep found where its check's own cases go.
 *
 * A hint becomes a case of the check it names - an escalation where that check escalates, a
 * finding where it does not - so everything downstream sees the SAME two lists and cannot
 * tell a swept case from a deterministic one.
 *
 * This runs while accepting the `spawn` phase, which asks about no numbered entry;
 * `verify` is the first pass that hands one out. So nothing is renumbered by what is
 * added here, because nothing has been numbered yet.
 * @param {import("./state.js").LoopState} state
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {string[]}  What was routed, for the audit line.
 */
function routeSweep(state, registry) {
  const results = state.sweep ?? [];
  if (results.length === 0) {
    return [];
  }
  // The review mode, rebuilt from the one fact the state carries - the same reconstruction
  // phaseEntries and settle make. It words nothing here: it only picks which text a check
  // that authors one response per review mode is worded from.
  const mode = { sca: state.report.sca };
  const { manual, findings, applied } = mergeSweepResults({
    results,
    manual: state.manual,
    findings: state.report.findings,
    registry,
    mode,
  });
  state.manual = manual;
  state.report.findings = findings;
  // Worded NOW, not left to `settle`. orderReview groups findings by their message, and a
  // swept one arrives with none - so an unrendered finding would group one way while the
  // verify phase asks about it and another once the report is built, moving items under an
  // index that is supposed to mean the same case for the life of the review.
  renderFindings(state.report.findings, registry, mode);
  // The sweep is over: leaving it standing would ask a reviewer for work that is now in
  // the lists above it.
  state.preSweep = null;
  return applied;
}
