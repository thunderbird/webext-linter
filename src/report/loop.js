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
import { assignRefs, orderReview } from "./order.js";
import { nextPhase, openIn, phaseOf, stepsOf } from "./phases.js";
import { earlyExitOf } from "./early-exit.js";
import {
  HandbackRefused,
  answersOf,
  productWritten,
  entriesFor,
  readHandback,
  reviewFile,
  valueEntry,
  writeReviewFile,
} from "./handback.js";
import { writeState } from "./state.js";
import { workPaths } from "../util/dest.js";
import { shellArg } from "../util/text.js";
import { rethrowIfFatal } from "../lib/errors.js";
import { writeReportFile } from "./report-file.js";
import { reviewItems } from "./items.js";
import { mergeSweepResults } from "./sweep.js";
import { readSweepAnswers, sweepSlots } from "./sweep-files.js";
import { finding, resolveHolds } from "./finding.js";
import { ARTIFACT_SCA, ARTIFACT_XPI } from "../lib/artifacts.js";
import { artifactRoots } from "../lib/artifacts.js";
import {
  detailLinkLines,
  detailRows,
  earlyExitLines,
  issuesBodyLines,
  locusLabeler,
  summaryBodyLines,
} from "./format.js";
import { applyVerdicts, pickedChoice } from "./verdicts.js";
import { renderFindings } from "./responses.js";
import { VERB } from "./verbs.js";
import { ITEMLESS_ANSWERS } from "../checks/registry-vocabulary.js";
import { BUILD_RESULT } from "../prepare/state.js";

/**
 * What this run was told, plus what the review has since decided for itself.
 *
 * `state.run` records the flags the review was STARTED with, and never changes. Whether
 * the review was aborted early is not one of those: it is derived from what stands so far,
 * so a pass can abort it - a case reported that aborts the review, a build that did not
 * reproduce - and the passes after it are cut short.
 *
 * Derived in ONE place, every pass, and read by `issue` to decide which phase goes out
 * and which of its steps it prints (src/report/phases.js stepsOf). What a phase asks
 * about does not depend on it, which is what lets `accept` re-derive what went out from
 * the review alone.
 * @param {import("./state.js").LoopState} state
 * @param {import("./order.js").OrderedItem[]} ordered  The whole review, ordered.
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {{skip: string[], sca: boolean, halted: boolean, first: boolean,
 *   spawned: boolean, decided: boolean, values: Object<string, string>}}  Beside these, the
 *   build result's fact (buildResultFact) is true.
 */
function runOf(state, ordered, registry) {
  const halted = Boolean(
    earlyExitOf(ordered, verdictsOf(state, ordered, registry), registry)
  );
  const issued = state.issued ?? [];
  return {
    ...state.run,
    halted,
    // What the prompt about to go out can say: whether it is the review's first, whether
    // an agent was started that may still be running, and whether the agent has judged
    // anything it would account for when the review closes.
    first: !state.phase,
    spawned: spawnIssued(state),
    decided: issued.includes("verify") || issued.includes("settle"),
    // The process values returned so far, which value(phase, id) reads.
    values: state.values ?? {},
    [buildResultFact(state)]: true,
  };
}

/**
 * What came of the build, as the one BUILD_RESULT_FACTS name that holds: the agent's build
 * as the preparation recorded it (`agent-built`, `agent-build-failed`), else a build judged
 * unsafe (`build-unsafe`), by the preparation or by this review's `build-safety` phase, which
 * nothing builds, else a build the reviewer makes (`self-build`): the agent was not let
 * build, or nothing was prepared.
 * @param {import("./state.js").LoopState} state
 * @returns {string}
 */
export function buildResultFact(state) {
  const result = state.build?.result;
  if (result === BUILD_RESULT.built) {
    return "agent-built";
  }
  if (result === BUILD_RESULT.failed) {
    return "agent-build-failed";
  }
  return state.values?.["build-safety"] === "unsafe"
    ? "build-unsafe"
    : "self-build";
}

/**
 * Whether the phase that starts the review's own agents - the add-on description and the
 * sweeps - went out. A review that never issued it started none of them, and so
 * has none of their files to wait for or to name.
 * @param {import("./state.js").LoopState} state
 * @returns {boolean}
 */
function spawnIssued(state) {
  return (state.issued ?? []).includes("spawn");
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
  const out = { ...answers };
  for (const x of ordered) {
    if (x.ref in answers && asking(x)) {
      out[x.ref] =
        pickedChoice(answers[x.ref], registry.answerChoices(phaseOf(x)))
          ?.verdict ?? String(VERB.reported);
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
 * @param {string} work  The review's work folder, which holds both files by their fixed
 *   names (src/util/dest.js workPaths). Not recorded in the state: the state is read from
 *   it, so the folder is always the one in hand.
 * @param {{name: string, answer: string, verbs: string[], intro: string,
 *   steps: object[]}[]} phases
 * @param {import("../checks/registry.js").Registry} registry  Renders each entry for
 *   THIS reader, at hand-out - never stored, so the same item can be worded one way
 *   here and another for the reviewer.
 * @returns {{phase: object, steps: object[], preamble: object[], entries: object[],
 *   settled: ?ReturnType<typeof settle>, waiting: ?string}}  `preamble` is the parts of it
 *   this prompt prints. `settled` is the finished review, for the closing phase only.
 *   `waiting` is the line a turn-ending phase appends to its block.
 */
export function issue(state, work, phases, registry) {
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
  // The preamble's parts are chosen the way a phase's steps are, against the same facts -
  // and as part of THIS prompt, so `closing` answers for the phase it sits above.
  const preamble = stepsOf(
    { answer: phase.answer, steps: registry.llmPhases().preamble },
    run
  );
  // An itemless phase asks about nothing in this file: its work is what its steps do, and
  // each product lands in a file of its own. Every other phase hands over its open items,
  // rendered for THIS reader - never stored, so the same item can be worded one way here
  // and another for the reviewer.
  const entries = askedIn(state, registry, phase, ordered);
  state.phase = phase.name;
  // The `ask` phase hands the reviewer the Review Details block, and that block links the
  // report. Refresh the file first, so the link opens the review as it stands rather than
  // nothing at all - the reviewer reads it to answer the questions that follow.
  //
  // Settled on a COPY: settle() applies the verdicts in place, and this pass is not the
  // last. What the copy answers is "what would the report say if the review ended now",
  // which is the review minus what the pending questions have yet to produce.
  //
  // Only on this phase, not on every pass: settling walks every answer recorded so far, and
  // a throw inside issue() would break the loop over a file nobody has been handed yet.
  if (settled) {
    writeReportFile(state.paths?.report, settled.report);
  } else if (phase.name === "ask") {
    writeReportFile(
      state.paths?.report,
      settle(structuredClone(state), registry).report
    );
  }
  writeState(workPaths(work).state, state);
  writeReviewFile(workPaths(work).review, reviewFile(entries));
  // A phase that ends the agent's turn closes its block with the line telling the
  // reviewer the review waits for their reply.
  const waiting = phase.endsTurn ? registry.llmPhases().waiting : null;
  return { phase, steps, preamble, entries, settled, waiting };
}

/**
 * Every value a phase's steps name, filled from the state - the one list both the first run
 * and every later pass print a prompt from.
 * @param {import("./state.js").LoopState} state
 * @param {{settled: ?object, waiting: ?string}} issued  What `issue` handed out: the
 *   closing phase carries the finished review, whose Review Details and tally it hands
 *   over, and a turn-ending phase the line its block ends with.
 * @param {string} work  The review's work folder.
 * @param {import("../checks/registry.js").Registry} registry  Words the build result.
 * @returns {Object<string, string>}
 */
export function loopSlots(state, issued, work, registry) {
  const paths = state.paths ?? {};
  // The block the agent prints verbatim ends with the waiting line, so the reviewer reads
  // it as part of that block.
  const waiting = issued.waiting ? `\n\n${issued.waiting}` : "";
  return {
    // The file the agent fills in, and the work folder it is handed back with: the one
    // folder a later pass finds the state and the review file in, each by its fixed name.
    // Quoted like any argument of a command its reader runs.
    review: workPaths(work).review,
    command: `node verify.js --llm-handback ${shellArg(work)}`,
    schemaCache: paths.schemaCache ?? "",
    description: paths.description ?? "",
    build: paths.build ?? "",
    scaRoot: paths.scaRoot ?? "",
    xpiRoot: paths.xpiRoot,
    schema: paths.schema,
    // Named because `ask` can be the FIRST phase issued - a review with nothing to start,
    // verify or settle opens there - and that is a phase that hands the block over.
    // The closing phase hands over the finished review's block instead, which ends on
    // what aborted it where something did.
    details: (issued.settled?.details ?? reviewDetails(state)) + waiting,
    tally: issued.settled?.tally ?? "",
    // The Build Review Details block: the submitted XPI, the source the review read, the
    // build's report and judgement, the vulnerabilities the review's audit counted in the
    // lock, what came of the build, and what it produced where the agent built it.
    buildDetails: buildDetails(state, registry) + waiting,
    ...sweepSlots(state),
  };
}

/**
 * Take a phase back: check what came back against what went out, and record it.
 *
 * Nothing in the state changes when this throws, so a corrected hand-back resumes exactly
 * where it was - which is why the caller does not re-print the prompt. The agent still has
 * it, and re-issuing the same text against the same input invites a loop.
 * The answers are read from the review file in the review's work folder, the one `issue`
 * wrote them into.
 * @param {import("./state.js").LoopState} state  Mutated on success only.
 * @param {string} work  The review's work folder, the one the state was read from.
 * @param {{name: string, answer: string, verbs: string[]}[]} phases
 * @param {import("../checks/registry.js").Registry} registry  Renders the entries this
 *   phase asked about, so a hand-back is checked against the same question that went out,
 *   and routes what a sweep found - which check each hint belongs to is the registry's
 *   to say.
 * @returns {{phase: object, answers: Map<string, *>, swept?: string[]}}
 * @throws {HandbackRefused}
 */
export function accept(state, work, phases, registry) {
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
  const { entries } = readHandback(workPaths(work).review);
  // What went out: the same question `issue` answered, asked again through the same
  // helper rather than stored, so the two cannot disagree about what was asked.
  // The one ordering of this hand-back: what went out is read from it, and an answer that
  // moves a case finds that case in it by its reference.
  const ordered = orderReview(state.report.findings, state.manual);
  const asked = askedIn(state, registry, phase, ordered);
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
  if (phase.answer === "value") {
    recordValue(state, registry, phase, answers);
    return { phase, answers };
  }
  state.answers ??= {};
  const byRef = new Map(ordered.map((x) => [x.ref, x]));
  for (const [ref, value] of answers) {
    if (value === VERB.ask) {
      // Not settled: moved. The case itself carries where it is asked now (phaseOf).
      byRef.get(ref).target.askedIn = "ask";
    } else {
      // Written down as text, because the state is JSON. A verb spells itself; a person's
      // answer is already their own words.
      state.answers[ref] = String(value);
    }
  }
  return { phase, answers };
}

export { HandbackRefused };

/**
 * What a phase hands out and checks the hand-back against: a process-value phase its one
 * entry, an itemless phase nothing, any other phase its open items.
 * @param {import("./state.js").LoopState} state
 * @param {import("../checks/registry.js").Registry} registry
 * @param {object} phase
 * @param {import("./order.js").OrderedItem[]} ordered
 * @returns {object[]}
 */
function askedIn(state, registry, phase, ordered) {
  if (phase.answer === "value") {
    return [valueEntry(phase)];
  }
  return ITEMLESS_ANSWERS.includes(phase.answer)
    ? []
    : phaseEntries(state, registry, phase, ordered);
}

/**
 * Record the process value a phase returned, by the id its `when:` readers name. It settles
 * no item, so it never goes into `answers`. A value that `reports` a check adds that check's
 * finding, which aborts the review the way any finding of an aborting check does - with its
 * reason and its response, and nothing for the loop to decide on its own.
 * @param {import("./state.js").LoopState} state  Mutated.
 * @param {import("../checks/registry.js").Registry} registry
 * @param {{name: string, values: {value: string, label: string, reports: ?string}[]}} phase
 * @param {Map<string, string>} answers  The one label that came back.
 */
function recordValue(state, registry, phase, answers) {
  const label = answers.get(phase.name);
  const picked = phase.values.find((v) => v.label === label);
  state.values = { ...(state.values ?? {}), [phase.name]: picked.value };
  if (!picked.reports) {
    return;
  }
  // It names no file, so no holder answers which artifact it is about: the reported check
  // does, by the one it reads (its `input`, held to a single artifact at load).
  state.report.findings.push(
    finding({
      ruleId: picked.reports,
      severity: registry.checkEntry(picked.reports).severity,
      artifact: artifactRead(
        registry.inputFor(picked.reports),
        state.report.sca
      ),
    })
  );
  assignRefs([...state.report.findings, ...state.manual], registry);
  renderFindings(state.report.findings, registry, { sca: state.report.sca });
}

/**
 * The artifact a check with `input` reads: the XPI, the source archive, or for `source` the
 * review's own - the source archive in a source review, else the XPI.
 * @param {"xpi"|"sca"|"source"} input
 * @param {boolean} sca  Whether this is a source review.
 * @returns {string}
 */
function artifactRead(input, sca) {
  if (input === "xpi") {
    return ARTIFACT_XPI;
  }
  return input === "sca" || sca ? ARTIFACT_SCA : ARTIFACT_XPI;
}

/**
 * The entries one phase asks about, rendered.
 *
 * Built from `reviewItems` - the same array the report is numbered from - so an entry
 * carries the wording the review already gave it: a question's `message` and the answers
 * it offers, a case's `instructions`, a finding's locus. The ordered walk decides WHICH,
 * the item file decides WHAT, and they are joined by the item's reference.
 * @param {import("./state.js").LoopState} state
 * @param {import("../checks/registry.js").Registry} registry
 * @param {{name: string, answer: string}} phase
 * @param {import("./order.js").OrderedItem[]} ordered  The whole review, ordered - the
 *   caller's, so what it hands out and what it acts on come from one ordering.
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
      choices: registry.answerChoices(phase.name),
      labelOf: locusLabeler(mode),
    }).map((item) => [item.ref, item])
  );
  return entriesFor(
    open.map((x) => rendered.get(x.ref)).filter(Boolean),
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
 * Handed over on EVERY settled review, including one whose `ask` phase already showed the
 * same block. That is not a duplicate: the `ask` copy exists to be read WHILE the questions
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
 * `applyVerdicts` settles each item by its fixed reference (src/report/order.js
 * assignRefs), so an answer stays on its item whatever the review gained after it was
 * given.
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
    verdicts: new Map(Object.entries(state.answers ?? {})),
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
  // Decided HERE, on the review with every answer applied: a review the deterministic
  // checks did not abort can still be aborted by what a pass reported - a case settled as
  // reported, a build that did not reproduce. An aborted review hands over no to-do item at
  // all: nothing was put to anyone, and nobody is asked to carry on with a submission it
  // already settles.
  const ordered = orderReview(findings, state.manual);
  const earlyExit = earlyExitOf(ordered, {}, registry);
  const manual = earlyExit ? [] : state.manual;
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
      // report above, or nothing swept - the run was told to leave the sweep out
      // (--llm-skip-sweep), or the review was aborted before it - and then it is left out
      // for the reviewer too.
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
 *  (the unpacked package), plus what was left for the reviewer - the description where
 *  the phase that starts its agent went out, the build report where the phase that leaves
 *  it recorded it, and the build output where the agent built the add-on. Those are what the
 *  block exists to hand over, and a file no agent was ever asked to write is not one of
 *  them. Beside them the source archive's root where a rescued copy was reviewed, and the
 *  root the agent built in where it built or tried to. */
function reportMeta(state) {
  const {
    prompting: _prompting,
    summaryFile,
    buildFile,
    ...rest
  } = state.report.meta;
  return {
    ...rest,
    ...(spawnIssued(state) ? { summaryFile } : {}),
    ...(state.products?.includes("build") ? { buildFile } : {}),
    ...(state.paths?.scaRootOrig
      ? { scaRootOrig: state.paths.scaRootOrig }
      : {}),
    ...(state.build?.root ? { buildRoot: state.build.root } : {}),
    ...(state.build?.output ? { buildOutput: state.build.output } : {}),
    manualReview: state.manual,
  };
}

/**
 * The Build Review Details block: the rows the review holds of the build (detailRows).
 * BUILD_SAFETY is the judgement the review holds, the preparation's or its own, and
 * BUILD_RESULT the wording of what came of the build (buildResultFact). BUILD_MATCH is the
 * agent's comparison of its output with the submitted XPI, shown beside that output.
 * @param {import("./state.js").LoopState} state
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {string}
 */
function buildDetails(state, registry) {
  const meta = reportMeta(state);
  return detailRows({
    submittedXpi: state.report.meta.xpi,
    scaRoot: state.paths?.scaRoot ?? undefined,
    scaRootOrig: meta.scaRootOrig,
    buildFile: meta.buildFile,
    buildSafety: state.values?.["build-safety"],
    buildVulnerabilities: state.build?.vulnerabilities ?? undefined,
    buildResult: registry.llmPhases().buildResults[buildResultFact(state)],
    buildRoot: meta.buildRoot,
    buildOutput: meta.buildOutput,
    buildMatch: state.build?.match ?? undefined,
  }).join("\n");
}

/**
 * Everything the sweeping agents returned, read back off the answers files their replies
 * were written into.
 *
 * ONE READ for the whole review, because a sweep file that cannot be acted on must leave
 * the review untouched: a half-applied sweep would record one tree's hints and then
 * refuse on the other, and the agent's fix would replay the first.
 *
 * The files are the ones THIS run named (state.paths.sweeps), so which labels belong in
 * each and what each label means are the review's own answers, never the file's. Read
 * only where a tree was actually asked - `--llm-skip-sweep` asks none, and then there
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
 * The new cases get references of their own (assignRefs), continuing their check's count,
 * so an answer recorded before the sweep stays on the item it was given for.
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
  assignRefs([...findings, ...manual], registry);
  // Worded NOW, not left to `settle`. orderReview groups findings by their message, and a
  // swept one arrives with none - so an unrendered finding would group one way while the
  // verify phase asks about it and another once the report is built.
  renderFindings(state.report.findings, registry, mode);
  // The sweep is over: leaving it standing would ask a reviewer for work that is now in
  // the lists above it.
  state.preSweep = null;
  return applied;
}
