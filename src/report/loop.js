// Belongs here: the REVIEW LOOP. "start the review loop" starts mode `review` and advances it,
// "advance the review" is every pass that hands a phase out, "close the review" is where every
// LLM review ends - the closing prompt, or the restart prompt where an aborted source review
// may be restarted as a review of its XPI alone - and `accept` takes a phase back.
//
// Does NOT belong here: the one render of a review (src/review/settle.js), which phase is
// next (src/report/phases.js), what a hand-back must look like (src/report/handback.js), what
// a verdict DOES to an item (src/report/verdicts.js), writing the record and printing a prompt
// (src/review/issue.js), or the prompt's layout (src/report/format.js).
//
// WHY A RECORD AND NOT A CONVERSATION: `record + a filled answers file -> the next record +
// answers file` is a pure file-to-file transformation, and so is `record -> report`. That is
// what makes this half of the tool testable without talking to an agent.
import fs from "node:fs";
import path from "node:path";

import { assignRefs, orderReview } from "./order.js";
import { nextPhase, openIn, stepsOf, valuesOf } from "./phases.js";
import {
  HandbackRefused,
  answersOf,
  entriesFor,
  productWritten,
  readHandback,
  valueEntry,
} from "./handback.js";
import { MAX_NOTE } from "../config.js";
import { workPaths } from "../util/dest.js";
import { shellArg } from "../util/text.js";
import { rethrowIfFatal } from "../lib/errors.js";
import { writeReportFile } from "./report-file.js";
import { reviewItems } from "./items.js";
import { mergeSweepResults } from "./sweep.js";
import { readSweepAnswers, sweepRequests, sweepSlots } from "./sweep-files.js";
import { finding } from "./finding.js";
import { ARTIFACT_SCA, ARTIFACT_XPI } from "../lib/artifacts.js";
import { artifactRoots } from "../lib/artifacts.js";
import {
  detailLinkLines,
  detailRows,
  earlyExitLines,
  locusLabeler,
  loopPromptLines,
  schemaLines,
  summaryBodyLines,
} from "./format.js";
import { checkedNote, pickedChoice } from "./verdicts.js";
import { VERB } from "./verbs.js";
import {
  DOWNGRADE_PHASE,
  ITEMLESS_ANSWERS,
  sweepRun,
} from "../checks/registry-vocabulary.js";
import { checkSelected } from "../checks/registry.js";
import { BUILD_RESULT } from "../build-check/state.js";
import { settleReview } from "../review/settle.js";
import { MODE, addToRecord, startMode } from "../review/record.js";
import { issueClosingPrompt, issueHandbackPrompt } from "../review/issue.js";
import { claimNames } from "../util/claims.js";

/**
 * What this run was told, plus what the review has since decided for itself, read off the
 * settled review.
 *
 * `state.run` records the flags the review was STARTED with, and never changes. Whether
 * the review was aborted is not one of those: it is read off the review settled with the
 * verdicts so far, so a pass can abort it - a case reported that aborts the review, a build
 * that did not reproduce - and the passes after it are cut short.
 *
 * A late-exit reason (Registry lateExitFor) halts the review only once the phase that
 * would go out without it is `ask` or the close: the phases up to `settle` run as usual,
 * so verify can withdraw the finding first, and the reviewer is then asked nothing.
 *
 * `unbuildable` says no build can be made from this source by the review's own rules: a
 * finding of a check marked `review-unbuildable` stands (no usable package.json, no single
 * readable lock), or the build check's rescue failed and deleted what it would have built.
 * The build phases ask nothing then, so nobody is asked to build what cannot be built.
 *
 * Read off the review the loop holds, mode review's own part, or at the close the review the
 * record's permanent part holds. A review the early-exit checks rejected holds no run, no
 * phase, nothing issued and no value, so each of those facts is false there.
 * @param {object} state  The review: the loop's, or the one the permanent part holds.
 * @param {object} record  For the build results its permanent part holds.
 * @param {import("../review/settle.js").SettledReview} settled
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {object}  The run record: the facts every step is printed by.
 */
function runOf(state, record, settled, registry) {
  const issued = state.issued ?? [];
  const buildResult = buildResultFact(record);
  const run = {
    ...state.run,
    // Whether a build check came before this review, whose intro its reader already read:
    // read off the build results the record's permanent part holds.
    ...(record.build ? { "build-checked": true } : {}),
    halted: Boolean(settled.exits.early),
    // What the prompt about to go out can say: whether it is the review's first, whether
    // an agent was started that may still be running, and whether the agent has judged
    // anything it would account for when the review closes.
    first: !state.phase,
    spawned: spawnIssued(state),
    decided: issued.includes("verify") || issued.includes("settle"),
    // The process values returned so far, which value(phase, id) reads.
    values: state.values ?? {},
    unbuildable:
      buildResult === "rescue-failed" ||
      buildResult === "rescue-mismatch" ||
      settled.exits.aborting.some((id) => registry.unbuildable(id)),
    [buildResult]: true,
  };
  if (!run.halted && settled.exits.late) {
    const next = nextPhase(
      registry.llmPhases().phases,
      walkOrder(settled),
      state,
      run
    )?.phase;
    // A phase a case is sent on to halts it as `ask` does: it asks the reviewer for what the
    // case is judged against, and a review a late exit ends asks nobody anything.
    run.halted =
      !next ||
      next.name === "ask" ||
      registry.sentOnPhases().has(next.name) ||
      next.answer === "end";
  }
  return run;
}

/**
 * The review the phases are walked over: the settled review, every verdict applied. A verdict
 * changes an item and never makes a new one, so an answered item keeps its reference and is
 * told apart by its answer (src/report/phases.js isOpen).
 * @param {import("../review/settle.js").SettledReview} settled
 * @returns {import("./order.js").OrderedItem[]}
 */
function walkOrder(settled) {
  return orderReview(settled.findings, settled.manual);
}

/**
 * What came of the build, as the one BUILD_RESULT_FACTS name that holds: the agent's build
 * as the build check recorded it (`agent-built`, `agent-build-failed`, `rescue-failed`,
 * `rescue-mismatch`), else a vulnerable lock's build the reviewer skipped
 * (`vulnerable-build-skipped`), which nobody builds, else
 * a build the reviewer held unsafe in the build check (`build-unsafe`), which nothing builds,
 * else a build the reviewer makes (`self-build`): the agent was not let build, or nothing was
 * checked. Read off the build results the record's permanent part holds (`build`).
 * @param {object} record
 * @returns {string}
 */
export function buildResultFact(record) {
  const result = record.build?.result;
  if (result === BUILD_RESULT.built) {
    return "agent-built";
  }
  if (result === BUILD_RESULT.failed) {
    return "agent-build-failed";
  }
  if (result === BUILD_RESULT.rescueFailed) {
    return "rescue-failed";
  }
  if (result === BUILD_RESULT.rescueMismatch) {
    return "rescue-mismatch";
  }
  if (record.build?.vulnerableBuildSkipped === true) {
    return "vulnerable-build-skipped";
  }
  return record.build?.safe === false ? "build-unsafe" : "self-build";
}

/**
 * Whether the phase that starts the review's own agents - the report agent and the sweep
 * agents - went out. A review that never issued it started none of them, and so
 * has none of their files to wait for or to name.
 * @param {object} state
 * @returns {boolean}
 */
function spawnIssued(state) {
  return (state.issued ?? []).includes("spawn");
}

/** The work folder's names a review never claims: the shipped add-on's copy, which the load
 *  put there, the source in `sca/`, the copy of it a rescue makes, the copy every build of the
 *  build check runs in, the record, which every mode writes in turn, the answers file the
 *  linter rewrites for every step and phase, and the record of a folder from before the
 *  record had a mode. */
const WORK_INPUTS = new Set([
  "xpi",
  "sca",
  "rescued",
  "buildCopy",
  "prepare",
  "state",
  "answers",
]);

/**
 * The names a review loop will create in its work folder (src/util/dest.js workPaths): the
 * report, what its agents write, and a sweep answers file for each artifact - whether or not
 * this review turns out to use each one, since which of them it will use is only known once it
 * has run, and a review refused at the end for a name it needed is a review paid for and
 * thrown away. A build check that judged the build wrote build.md and build-issues.md, which
 * its review reads and never claims.
 * @param {ReturnType<typeof workPaths>} work
 * @param {?object} build  The build results of a build check done in the folder, or none.
 * @returns {string[]}  Absolute paths.
 */
function claimedNames(work, build) {
  const judged = Boolean(build?.safety);
  const outputs = Object.entries(work)
    .filter(
      ([key, value]) =>
        typeof value === "string" &&
        !WORK_INPUTS.has(key) &&
        !(judged && (key === "build" || key === "buildIssues"))
    )
    .map(([, value]) => value);
  const sweeps = [ARTIFACT_XPI, ARTIFACT_SCA].map(work.sweep);
  return [...outputs, ...sweeps];
}

/**
 * Claim the work folder for the loop: refuse it when it cannot be written to, and refuse it
 * when any name the loop will create is already there. A name already taken is left over from
 * a start that was cut short, and replacing it would destroy work nobody asked to discard. The
 * names this call claims are this run's (src/util/claims.js).
 * @param {string} dir  The work folder, absolute.
 * @param {string[]} names  claimedNames' answer.
 */
function claimWorkFolder(dir, names) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (err) {
    rethrowIfFatal(err);
    throw new Error(
      `The work folder "${dir}" cannot be written to, and every file this review creates ` +
        "lives there."
    );
  }
  const taken = names.filter(
    (p) => fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined
  );
  if (taken.length) {
    const listed = taken.map((p) => `"${path.relative(dir, p)}"`).join(", ");
    throw new Error(
      `The work folder "${dir}" already holds ${listed}, which this review would ` +
        "create. Nothing in a work folder is overwritten: remove what is there, and hand " +
        "the folder back again."
    );
  }
  claimNames(names);
}

/**
 * What a review loop needs from the run that starts it, beside the review: the work folder,
 * the registry under the review's band policy, the options it was started with, and the
 * submitted lock's vulnerable packages as this review's own audit counted them.
 * @typedef {{work: string, registry: import("../checks/registry.js").Registry,
 *   opts: object,
 *   vulnerabilities: ?import("../build-check/audit.js").VulnerabilityCounts}} LoopStart
 */

/**
 * Mode review's own part, from the review as the checks produced it: the review itself,
 * every item with its fixed reference, the files the review names, and what the run was
 * told and found, so no later pass has to rebuild any of it. Everything formatText reads that
 * the registry cannot recompute goes in here.
 *
 * Only an LLM review gets references and the files it names: a plain report has neither.
 * @param {import("../review/settle.js").StoredReview} review
 * @param {LoopStart} start
 * @param {object} record  The record, whose permanent part says whether a build check came
 *   first and what it found, and whether the XPI of a source review could be reviewed on its
 *   own.
 * @returns {object}
 */
function reviewBody(review, start, record) {
  const { work: folder, registry, opts } = start;
  const build = record.build ?? null;
  const work = workPaths(folder);
  claimWorkFolder(folder, claimedNames(work, build));
  const sca = review.report.sca;
  const skip = opts.llmSkip ?? [];
  const meta = { ...review.report.meta };
  // Where the prompt's reader writes the summary report, and where it writes the build
  // report: both sit in the review's work folder, and this tool writes
  // neither. A path printed for a file nobody is asked to write would be an instruction with
  // no step behind it, so the summary report is not named under --llm-skip-summary, and the
  // build report not in a review that is not a source code one.
  const summaryPath = skip.includes("llm-skip-summary") ? null : work.summary;
  const buildPath = sca ? work.build : null;
  meta.prompting = true;
  meta.summaryFile = summaryPath ?? undefined;
  meta.buildFile = buildPath ?? undefined;
  meta.buildIssuesFile = buildPath ? work.buildIssues : undefined;
  meta.reportFile = work.report;
  // Whether this run SWEEPS: it was not told to leave it out, and there is a blind spot to
  // cover. One sweep agent per tree, each handed a request of its own and answering into
  // a file of its own, made here because the request carries the tree's path and the sweeps
  // that tree was asked about, which no later pass could reconstruct.
  const sweepFiles =
    !opts.llmSkipSweep && review.preSweep?.items?.length
      ? sweepRequests(
          work,
          review.preSweep,
          artifactRoots(meta),
          registry.proseStyle(),
          registry.readingRule()
        )
      : {};
  const findings = review.report.findings;
  const manual = review.manual;
  // Every item gets its fixed reference here, the one every answer is recorded under, in the
  // order the checks raised them (src/report/order.js assignRefs).
  assignRefs([...findings, ...manual], registry);
  return {
    report: { findings, meta, sca },
    manual,
    preSweep: review.preSweep,
    // What this run was told, recorded ONCE. Every pass reads it from here.
    run: {
      skip,
      sca,
      // Whether every check an agent's build relies on runs: with one switched off, nothing
      // vouches for what the build would install, so the review neither judges the build
      // nor shows the Build Review Details, and asks the build question alone.
      ...(registry.buildGuardIds().every((id) =>
        checkSelected(registry, id, {
          only: opts.checksOnly,
          skip: opts.checksSkip,
        })
      )
        ? { "build-guarded": true }
        : {}),
      // One condition per tree that has a sweep to run, keyed the way the step names it.
      ...Object.fromEntries(
        Object.keys(sweepFiles).map((a) => [sweepRun(a), true])
      ),
      // The band policy, so a later pass reads the review under the one it was started
      // with: a case REPORTED on a later pass becomes a finding there and then
      // (src/report/verdicts.js asFinding), and that pass is never handed the flag again.
      warningsAsErrors: registry.warningsAsErrors,
    },
    sweep: null,
    paths: {
      description: summaryPath,
      build: buildPath,
      schemaCache: opts.schemaCache,
      xpiRoot: meta.xpiRoot,
      // Each tree's sweep request, as the text its step hands over, and the file its
      // answers are written to.
      sweeps: sweepFiles,
      // The schema block a judging phase prints - the snapshot its verdicts mean anything
      // against.
      schema: schemaLines(meta, opts.schemaCache).join("\n"),
    },
    // The source folders the review reads, in a source review: the roots every reported
    // path is relative to, so a later pass can resolve one without the review it came from.
    ...(sca ? { roots: opts.scaFolders } : {}),
    answers: {},
    // The submitted lock's vulnerable packages as this review's own audit counted them,
    // shown where the build check counted none (record.build).
    vulnerabilities: start.vulnerabilities ?? null,
    // build.md, which the build check's agent wrote, and build-issues.md, which the build
    // check wrote from the issues the agent handed back, as products the Review Details link.
    ...(build?.safety && buildPath && productWritten(buildPath)
      ? {
          products: [
            "build",
            ...(productWritten(work.buildIssues) ? ["buildIssues"] : []),
          ],
        }
      : {}),
    issued: [],
  };
}

/**
 * Mode review started ("start a mode"): its body the review as the checks produced it, with
 * its references assigned, the files it names and what the run was told. At no phase yet, and
 * nothing written.
 * @param {import("../review/settle.js").StoredReview} review
 * @param {object} record  The record, its permanent part as the review found it.
 * @param {LoopStart} start
 * @returns {object}  The record in mode review.
 */
export function startReview(review, record, start) {
  return startMode(
    record,
    MODE.review,
    reviewBody(review, start, record),
    null
  );
}

/**
 * Start the review loop: mode review started (startReview), the review settled with no
 * verdicts yet, and advanced to its first phase with it. The first run is pass 0 of the loop,
 * and from here on it runs what every later pass runs, with no verdicts yet.
 * @param {import("../review/settle.js").StoredReview} review
 * @param {object} record  The record, its permanent part as the review found it.
 * @param {LoopStart} start
 * @returns {{issued: "prompt"|"close"|"restart",
 *   settled: import("../review/settle.js").SettledReview}}
 */
export function startReviewLoop(review, record, start) {
  const started = startReview(review, record, start);
  const settled = settleReview(started.current, {}, start.registry);
  return advanceReview(start.work, started, settled, start.registry);
}

/**
 * Advance the review: one pass of the loop, handed the review settled with the verdicts so
 * far, and settling nothing itself. nextPhase picks what goes out from the settled review: a
 * phase with work, or the end of the review, where it is halted or no phase is left with
 * work. Before every hand-back prompt review.md is written, the settled review, so the report
 * is current whenever a prompt links it, and the record is put at the phase that goes out. At
 * the end the review as the checks produced it and the verdicts so far are added to the
 * record's permanent part, and the review closed with the record.
 * @param {string} work  The work folder.
 * @param {object} record  The record in mode review, mutated: it is put at the phase that
 *   goes out.
 * @param {import("../review/settle.js").SettledReview} settled  Its review, settled with the
 *   verdicts so far.
 * @param {import("../checks/registry.js").Registry} registry  Under the review's band policy.
 * @returns {{issued: "prompt"|"close"|"restart",
 *   settled: import("../review/settle.js").SettledReview}}
 */
export function advanceReview(work, record, settled, registry) {
  const review = record.current;
  const texts = registry.llmPhases();
  const run = runOf(review, record, settled, registry);
  const next = nextPhase(texts.phases, walkOrder(settled), review, run);
  if (!next) {
    // The registry refuses a loop without a closing phase, and that phase always has a
    // step to print - so nothing reaches here but a broken wiring.
    throw new Error("the review loop has no phase left to issue");
  }
  if (next.phase.answer === "end") {
    const { mode: _mode, ...ended } = review;
    return closeReview(
      work,
      addToRecord(work, record, { review: ended }),
      registry
    );
  }
  writeReportFile(workPaths(work).report, settled.report);
  const entries = askedIn(review, registry, next.phase, settled, run);
  const lines = promptLines(review, record, next.phase, next.steps, run, {
    work,
    registry,
    blocks: null,
    entries,
  });
  review.phase = next.phase.name;
  issueHandbackPrompt(work, record, entries, lines);
  return { issued: "prompt", settled };
}

/**
 * Close the review: where every LLM review ends, finished or rejected, handed the record
 * alone, and reading only its permanent part: the review and its verdicts, settled here, the
 * kind and whether the XPI could be reviewed on its own. A source review rejected for build
 * issues alone - every check that aborts it carries `review-downgrade` - whose XPI could be
 * reviewed on its own is offered the restart as an XPI review instead of the close: mode
 * downgrade is started with no body, review.md written at its fixed path, and the restart
 * prompt issued. Any other review is put at the close, so every later hand-back is refused,
 * and its closing prompt issued. A finished review fails the rule, since nothing aborted it.
 * @param {string} work
 * @param {object} record  Its permanent part holding the review (`review`).
 * @param {import("../checks/registry.js").Registry} registry  Under the review's band policy.
 * @returns {{issued: "close"|"restart",
 *   settled: import("../review/settle.js").SettledReview}}
 */
export function closeReview(work, record, registry) {
  const review = record.review;
  const settled = settleReview(review, review.answers ?? {}, registry);
  const restart =
    record.kind === "sca" &&
    record.xpiReviewable === true &&
    Boolean(settled.exits.late) &&
    settled.exits.aborting.every((id) => registry.downgrades(id));
  if (!restart) {
    return closeAt(work, record, settled, registry);
  }
  const run = runOf(review, record, settled, registry);
  const prompt = registry.llmPhases().restart;
  const downgrade = startMode(record, MODE.downgrade, {}, DOWNGRADE_PHASE);
  writeReportFile(workPaths(work).report, settled.report);
  const entries = [restartEntry(prompt, run, settled)];
  const lines = promptLines(review, record, prompt, stepsOf(prompt, run), run, {
    work,
    registry,
    blocks: closingBlocks(review, record, settled, work, registry),
    entries,
  });
  issueHandbackPrompt(work, downgrade, entries, lines);
  return { issued: "restart", settled };
}

/**
 * The review at the close: the record put at the close, its current part closed so every
 * later hand-back is refused, and the closing prompt issued with the settled review, its
 * steps chosen against whether that settled review was aborted. The review is the one the
 * permanent part holds.
 * @param {string} work
 * @param {object} record  Its permanent part holding the review (`review`).
 * @param {import("../review/settle.js").SettledReview} settled  That review, settled.
 * @param {import("../checks/registry.js").Registry} registry
 * @param {Record<string, string>} [values]  Process values the close is issued with beside
 *   the review's own: the reviewer's `keep` at the restart prompt.
 * @returns {{issued: "close", settled: import("../review/settle.js").SettledReview}}
 */
export function closeAt(work, record, settled, registry, values = {}) {
  const review = {
    ...record.review,
    values: { ...(record.review.values ?? {}), ...values },
  };
  const run = runOf(review, record, settled, registry);
  const close = registry.llmPhases().phases.find((p) => p.answer === "end");
  const steps = stepsOf(close, { ...run, halted: Boolean(settled.exits.late) });
  const lines = promptLines(review, record, close, steps, run, {
    work,
    registry,
    blocks: closingBlocks(review, record, settled, work, registry),
    entries: [],
  });
  issueClosingPrompt(
    work,
    settled,
    startMode(record, MODE.review, {}, close.name),
    lines
  );
  return { issued: "close", settled };
}

/**
 * The restart prompt's one entry: a process value, worded by the prompt's own question with
 * {{abortReasons}} filled from what aborted the review.
 * @param {object} prompt  The restart prompt (Registry llmPhases().restart).
 * @param {object} run  The run record (runOf).
 * @param {import("../review/settle.js").SettledReview} settled
 * @returns {object}
 */
export function restartEntry(prompt, run, settled) {
  const named = (settled.exits.late?.reasons ?? [])
    .map(({ text }) => text.charAt(0).toLowerCase() + text.slice(1))
    .join(" and ");
  return valueEntry(
    { ...prompt, values: valuesOf(prompt, run) },
    prompt.question.split("{{abortReasons}}").join(named)
  );
}

/**
 * The reviewer's answer to the restart prompt, read from the answers file: `xpi` or `keep`,
 * the value id of the label they picked. Anything else is refused. What was asked is worked
 * out again from the review the permanent part holds.
 * @param {string} work
 * @param {object} record  In mode downgrade.
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {string}
 * @throws {HandbackRefused}
 */
export function restartAnswer(work, record, registry) {
  const prompt = registry.llmPhases().restart;
  const review = record.review;
  const settled = settleReview(review, review.answers ?? {}, registry);
  const asked = [
    restartEntry(prompt, runOf(review, record, settled, registry), settled),
  ];
  const { entries } = readHandback(workPaths(work).answers);
  const label = answersOf(entries, asked, prompt, (e) =>
    String(e.index ?? "undefined")
  ).get(prompt.name);
  return prompt.values.find((v) => v.label === label).value;
}

/**
 * The Review Details block and the tally a closing block hands over: the details with the
 * lines saying the review was aborted where it was, and the tally of what stands, none of the
 * to-do items once it was aborted.
 * @param {object} review  The review the permanent part holds.
 * @param {object} record
 * @param {import("../review/settle.js").SettledReview} settled
 * @param {string} work
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {{details: string, tally: string}}
 */
function closingBlocks(review, record, settled, work, registry) {
  const aborted = settled.exits.late;
  return {
    details: [
      reviewDetails(review, record, work, registry),
      ...earlyExitLines(aborted),
    ].join("\n"),
    tally: summaryBodyLines(
      settled.findings,
      aborted ? [] : settled.manual,
      null
    ).join("\n"),
  };
}

/**
 * The lines of one prompt of the loop: the preamble parts its conditions chose, the frame,
 * the phase's steps and its handover, every value they name filled from the review and the
 * record.
 * @param {object} review  The loop's, or at the close the one the permanent part holds.
 * @param {object} record
 * @param {object} phase
 * @param {object[]} steps
 * @param {object} run  The run record (runOf).
 * @param {{work: string, registry: import("../checks/registry.js").Registry,
 *   blocks: ?{details: string, tally: string}, entries: object[]}} parts
 * @returns {string[]}
 */
function promptLines(review, record, phase, steps, run, parts) {
  const { work, registry, blocks, entries } = parts;
  const texts = registry.llmPhases();
  // The preamble's parts are chosen the way a phase's steps are, against the same facts -
  // and as part of THIS prompt, so `closing` answers for the phase it sits above.
  const preamble = stepsOf(
    { answer: phase.answer, steps: texts.preamble },
    run
  );
  // A phase that ends the agent's turn closes its block with the line telling the reviewer
  // the review waits for their reply.
  const waiting = phase.endsTurn
    ? texts.waiting(phase.name, entries.length)
    : null;
  return loopPromptLines(
    texts,
    phase,
    steps,
    loopSlots(review, record, { blocks, waiting }, work, registry),
    preamble
  );
}

/**
 * Every value a phase's steps name, filled from the review and the record - the one list
 * every prompt of the loop is printed from.
 * @param {object} review  The loop's, or at the close the one the permanent part holds.
 * @param {object} record
 * @param {{blocks: ?{details: string, tally: string}, waiting: ?string}} issued  The closing
 *   blocks where the prompt hands the finished review over, and the line a turn-ending block
 *   ends with.
 * @param {string} work  The review's work folder.
 * @param {import("../checks/registry.js").Registry} registry  Words the build result.
 * @returns {Object<string, string>}
 */
export function loopSlots(review, record, issued, work, registry) {
  const paths = review.paths ?? {};
  // The block the agent prints verbatim ends with the waiting line, so the reviewer reads
  // it as part of that block.
  const waiting = issued.waiting ? `\n\n${issued.waiting}` : "";
  return {
    // The file the agent fills in, and the work folder it is handed back with: the one
    // folder a later pass finds the record and the answers file in, each by its fixed name.
    // Quoted like any argument of a command its reader runs.
    review: workPaths(work).answers,
    command: `node verify.js --llm-handback ${shellArg(work)}`,
    schemaCache: paths.schemaCache ?? "",
    // How the agent and the report and sweep agents it starts write their own prose.
    proseStyle: registry.proseStyle(),
    // How the report agent reads the add-on's files.
    readingRule: registry.readingRule(),
    summary: paths.description ?? "",
    xpiRoot: paths.xpiRoot,
    schema: paths.schema,
    // Named because `ask` can be the FIRST phase issued - a review with nothing to start,
    // verify or settle opens there - and that is a phase that hands the block over.
    // A closing block hands over the finished review's block instead, which ends on what
    // aborted it where something did.
    details:
      (issued.blocks?.details ??
        reviewDetails(review, record, work, registry)) + waiting,
    tally: issued.blocks?.tally ?? "",
    // The longest answer in a reviewer's own words the hand-back takes (checkedNote).
    maxNote: String(MAX_NOTE),
    // The Build Review Details block: the review's details without the two files the
    // `ask` pass hands over.
    buildDetails: buildDetails(review, record, work, registry) + waiting,
    ...sweepSlots(review),
  };
}

/**
 * The trees a review's reported paths are relative to, keyed by artifact
 * (src/lib/artifacts.js artifactRoots): the add-on's copy, and in a source review the tree
 * the review reads.
 * @param {object} state  The review's own part.
 * @returns {Record<string, string>}
 */
function treesOf(state) {
  return artifactRoots({
    xpiRoot: state.paths?.xpiRoot,
    ...(state.roots ? { scaFolders: state.roots } : {}),
  });
}

/**
 * Take a phase back: check what came back against what went out, settle the pass, and
 * record it.
 *
 * Its answers well formed, the pass is applied to a copy of the record, and the review is
 * settled with the verdicts so far and the new answers. A settle that throws is refused, so a
 * pass is only ever stored where it settles, and no later pass can throw over an answer
 * already taken. That settle is the pass's one settle, which "advance the review" is handed.
 *
 * Nothing on disk changes when this throws, so a corrected hand-back resumes exactly where
 * it was - which is why the refusal does not re-print the prompt. The agent still has it, and
 * re-issuing the same text against the same input invites a loop. The answers are read from
 * the answers file in the review's work folder, the one the last pass wrote them into.
 * @param {object} record  In mode review, never changed here.
 * @param {string} work  The review's work folder, the one the record was read from.
 * @param {import("../checks/registry.js").Registry} registry  Renders the entries this
 *   phase asked about, so a hand-back is checked against the same question that went out,
 *   and routes what a sweep found - which check each hint belongs to is the registry's
 *   to say.
 * @returns {{record: object, settled: import("../review/settle.js").SettledReview,
 *   phase: object, answers: Map<string, *>, swept?: string[]}}  The record with the pass
 *   accepted, and its review settled with it.
 * @throws {HandbackRefused}
 */
export function accept(record, work, registry) {
  const phases = registry.llmPhases().phases;
  const at = record.current.phase;
  const phase = phases.find((p) => p.name === at);
  if (!phase) {
    throw new HandbackRefused(
      `this review is not waiting on a phase called "${at}"`
    );
  }
  if (phase.answer === "end") {
    throw new HandbackRefused(
      "this review is finished - nothing is handed back after its closing prompt"
    );
  }
  const accepted = structuredClone(record);
  const state = accepted.current;
  const { entries } = readHandback(workPaths(work).answers);
  // What went out: the same question the pass before answered, asked again through the same
  // helper rather than stored, so the two cannot disagree about what was asked. Read against
  // the run's facts as that pass read them, so a value offered only under a condition is
  // accepted only where it was offered.
  const before = settleReview(state, state.answers, registry);
  const ordered = walkOrder(before);
  const asked = askedIn(
    state,
    registry,
    phase,
    before,
    runOf(state, accepted, before, registry)
  );
  const answers = answersOf(entries, asked, phase, (e) =>
    String(e.index ?? "undefined")
  );
  // A person's own words become the note their case is reported with, so they are held to
  // the note's rule here, where the agent can still ask the question again.
  if (phase.answer === "words") {
    const ruleOf = new Map(ordered.map((x) => [x.ref, x.target?.ruleId]));
    for (const [ref, value] of answers) {
      if (pickedChoice(value, registry.manualReviewChoices(ruleOf.get(ref)))) {
        continue;
      }
      const { problem } = checkedNote(value);
      if (problem) {
        throw new HandbackRefused(`${ref} ${problem}`);
      }
    }
  }
  // Read BEFORE anything is recorded, because a sweep file that cannot be acted on has to
  // leave the review exactly as it was - the agent fixes that one file and hands back
  // again.
  const swept = phase.answer === "hints" ? sweptResults(state) : null;
  state.issued ??= [];
  if (!state.issued.includes(phase.name)) {
    state.issued.push(phase.name);
  }
  const routed = {};
  if (phase.answer === "hints") {
    state.sweep = swept;
    routed.swept = routeSweep(state, registry);
  } else if (phase.answer === "value") {
    recordValue(state, registry, phase, answers, ordered);
  } else {
    recordVerdicts(state, answers);
  }
  let settled;
  try {
    settled = settleReview(state, state.answers, registry);
  } catch (err) {
    rethrowIfFatal(err);
    throw new HandbackRefused(err.message);
  }
  return { record: accepted, settled, phase, answers, ...routed };
}

/**
 * Record a verdict phase's answers in the review: each under its item's reference, and a case
 * moved on with `ask` marked with the phase it is sent on to instead.
 * @param {object} state  The review, mutated.
 * @param {Map<string, *>} answers
 */
function recordVerdicts(state, answers) {
  state.answers ??= {};
  // The stored review, unworded, is what the record keeps: a case moved on with `ask` is
  // marked there, found by its reference.
  const stored = new Map(
    [...state.report.findings, ...state.manual].map((x) => [x.ref, x])
  );
  for (const [ref, value] of answers) {
    if (value === VERB.ask) {
      // Not settled: moved. The case itself carries where it is asked now (phaseOf). A case
      // sent on for the first time goes to the phase its check names (`sent-on-to`), else
      // to `ask`. One already sent on goes to `ask`, so no phase sends a case back to itself.
      const item = stored.get(ref);
      item.askedIn = (!item.askedIn && item.sentOnTo) || "ask";
    } else {
      // Written down as text, because the record is JSON. A verb spells itself, and a person's
      // answer is already their own words.
      state.answers[ref] = String(value);
    }
  }
}

export { HandbackRefused };

/**
 * What a phase hands out and checks the hand-back against: a process-value phase its one
 * entry, worded by the open to-do routed to it, an itemless phase nothing, any other phase its
 * open items.
 * @param {object} state
 * @param {import("../checks/registry.js").Registry} registry
 * @param {object} phase
 * @param {import("../review/settle.js").SettledReview} settled
 * @param {object} run  The run record (runOf): a process value is offered only where its
 *   `when:` holds over it (valuesOf).
 * @returns {object[]}
 */
function askedIn(state, registry, phase, settled, run) {
  if (phase.answer === "value") {
    const [routed] = renderedOpen(state, registry, phase.name, settled);
    return [
      valueEntry(
        { ...phase, values: valuesOf(phase, run) },
        routed?.message ?? phase.question
      ),
    ];
  }
  return ITEMLESS_ANSWERS.includes(phase.answer)
    ? []
    : entriesFor(
        renderedOpen(state, registry, phase.name, settled),
        phase,
        // Keyed by the artifact a finding carries, so resolving a path is a lookup rather
        // than a branch on the review mode.
        treesOf(state)
      );
}

/**
 * Record the process value a phase returned, by the id its `when:` readers name. The value
 * itself settles no item, so it never goes into `answers`. Every open to-do routed to the
 * phase is its question, so each is cleared, recorded as a cleared answer is. A value that
 * `reports` a check then adds that check's finding, which aborts the review the way any
 * finding of an aborting check does - with its reason and its response, and nothing for the
 * loop to decide on its own. That finding is the reviewer's answer, so its check is one the
 * agent does not verify (`llm-verification: false`), and it opens in no phase.
 * @param {object} state  Mutated.
 * @param {import("../checks/registry.js").Registry} registry
 * @param {{name: string, values: {value: string, label: string, reports: ?string}[]}} phase
 * @param {Map<string, string>} answers  The one label that came back.
 * @param {import("./order.js").OrderedItem[]} ordered  The review as it was walked.
 */
function recordValue(state, registry, phase, answers, ordered) {
  const label = answers.get(phase.name);
  const picked = phase.values.find((v) => v.label === label);
  state.values = { ...(state.values ?? {}), [phase.name]: picked.value };
  state.answers ??= {};
  for (const x of openIn(phase.name, ordered, state)) {
    state.answers[x.ref] = String(VERB.cleared);
  }
  if (!picked.reports) {
    return;
  }
  // It names no file, so no holder answers which artifact it is about: the reported check
  // does, by the one it reads (its `input`, held to a single artifact at load).
  const reported = finding({
    ruleId: picked.reports,
    severity: registry.checkEntry(picked.reports).severity,
    artifact: artifactRead(registry.inputFor(picked.reports), state.report.sca),
  });
  if (!registry.verifiedByLlm(picked.reports)) {
    reported.llmVerification = false;
  }
  state.report.findings.push(reported);
  assignRefs([...state.report.findings, ...state.manual], registry);
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
 * The items still open in one phase, each as reviewItems renders it from the review as it is
 * walked: a to-do carries the `message` a person is asked, the one wording every phase that
 * asks a person relays.
 * @param {object} state
 * @param {import("../checks/registry.js").Registry} registry
 * @param {string} phaseName
 * @param {import("../review/settle.js").SettledReview} settled
 * @returns {object[]}
 */
function renderedOpen(state, registry, phaseName, settled) {
  const open = openIn(phaseName, walkOrder(settled), state);
  if (open.length === 0) {
    return [];
  }
  const mode = { sca: state.report.sca };
  const rendered = new Map(
    reviewItems({
      findings: settled.findings,
      manual: settled.manual,
      choicesOf: (ruleId) => registry.manualReviewChoices(ruleId),
      verifyInstructionOf: (ruleId) =>
        registry.verificationInstructionFor(ruleId),
      labelOf: locusLabeler(mode),
    }).map((item) => [item.ref, item])
  );
  return open.map((x) => rendered.get(x.ref)).filter(Boolean);
}

/**
 * The Review Details block itself, for the phase that hands it over: every row the review
 * holds (detailsMeta).
 * @param {object} review  The loop's, or at the close the one the permanent part holds.
 * @param {object} record
 * @param {string} work
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {string}
 */
export function reviewDetails(review, record, work, registry) {
  // The chat renderer, not the report's: what a phase hands over is read in a client, not
  // in a terminal, so its paths are links rather than an aligned block.
  return detailLinkLines(detailsMeta(review, record, work, registry)).join(
    "\n"
  );
}

/**
 * Every row the review holds, the one meta each details block renders, so each block holds
 * every row of the block before it. Which add-on this is and where it can be read (the
 * unpacked package), the source the review read, and what is left for the reviewer: the
 * summary report once the phase that starts its agent went out, the build report where the
 * build check wrote it, and the report, which the linter writes at its fixed path. A file no
 * agent was ever asked to write is not among them. Beside them the build results the
 * record's permanent part holds (`build`), and the submitted lock's counts as this review's
 * audit found them where the build check counted none. A review the early-exit checks
 * rejected holds only the meta the checks produced, so the rows the loop adds are not there.
 * @param {object} review  The loop's, or at the close the one the permanent part holds.
 * @param {object} record
 * @param {string} work
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {import("./format.js").ReviewMeta}
 */
function detailsMeta(review, record, work, registry) {
  const {
    prompting: _prompting,
    summaryFile,
    buildFile,
    buildIssuesFile,
    reportFile: _reportFile,
    ...rest
  } = review.report.meta;
  const build = record.build ?? {};
  const vulnerabilities = build.vulnerabilities ?? review.vulnerabilities;
  const worded =
    review.run?.sca && review.run["build-guarded"]
      ? registry.llmPhases().buildResults[buildResultFact(record)]
      : undefined;
  return {
    ...rest,
    ...(spawnIssued(review) ? { summaryFile } : {}),
    ...(review.products?.includes("build") ? { buildFile } : {}),
    ...(review.products?.includes("buildIssues") ? { buildIssuesFile } : {}),
    ...(build.safety ? { buildSafety: build.safety } : {}),
    ...(vulnerabilities ? { buildVulnerabilities: vulnerabilities } : {}),
    ...(build.rescuedVulnerabilities
      ? { rescuedVulnerabilities: build.rescuedVulnerabilities }
      : {}),
    ...(worded ? { buildResult: worded } : {}),
    ...(build.copy ? { buildCopy: build.copy } : {}),
    ...(build.output ? { buildOutput: build.output } : {}),
    ...(build.match ? { buildMatch: build.match } : {}),
    reportFile: workPaths(work).report,
  };
}

/**
 * The Build Review Details block: the review's details (detailsMeta) as the `built` pass
 * shows them, which goes out before the report agent is started and before the report
 * is handed over, so it names neither.
 * @param {object} review
 * @param {object} record
 * @param {string} work
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {string}
 */
function buildDetails(review, record, work, registry) {
  const {
    summaryFile: _summaryFile,
    reportFile: _reportFile,
    ...meta
  } = detailsMeta(review, record, work, registry);
  return detailRows(meta).join("\n");
}

/**
 * Everything the sweep agents returned, read back off the answers files their replies
 * were written into.
 *
 * ONE READ for the whole review, because a sweep file that cannot be acted on must leave
 * the review untouched: a half-applied sweep would record one tree's hints and then
 * refuse on the other, and the agent's fix would replay the first.
 *
 * The files are the ones THIS review named (state.paths.sweeps). Null where no tree was
 * asked, which is not the same as every tree answering with nothing.
 * @param {object} state
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
  const roots = treesOf(state);
  for (const [artifact, paths] of trees) {
    const asked = (state.preSweep?.items ?? []).filter(
      (s) => s.artifact === artifact
    );
    try {
      out.push(...readSweepAnswers(paths.answers, asked, roots[artifact]));
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
 * tell a swept case from a deterministic one. Stored as the checks would have produced it,
 * unworded: every pass words a copy (src/review/settle.js).
 *
 * The new cases get references of their own (assignRefs), continuing their check's count,
 * so an answer recorded before the sweep stays on the item it was given for.
 * @param {object} state
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {string[]}  What was routed, for the audit line.
 */
function routeSweep(state, registry) {
  // Null where no tree was asked (--llm-skip-sweep): the list stays for the reviewer to
  // sweep by hand. Asked, the sweep is over however much it found.
  const results = state.sweep;
  if (!results) {
    return [];
  }
  if (results.length === 0) {
    state.preSweep = null;
    return [];
  }
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
  // The sweep is over: leaving it standing would ask a reviewer for work that is now in
  // the lists above it.
  state.preSweep = null;
  return applied;
}
