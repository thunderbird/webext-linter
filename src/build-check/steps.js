// The STEPS of the build check of a source code review: what one hand-back of a work folder
// in mode `build-check` does to it, and which prompt comes next.
//
// Every build check starts at `analyze`, once the source is in the work folder's `sca/` - the
// linter's copy of --sca-extracted, or the archive the agent extracted there at `unpack`
// (--llm-auto-review) - and the early-exit checks passed on it. There the reader reports the
// build in build.md and hands back the issues the verdict is read off. Where a check the build
// relies on is switched off (`build-guard`), the folder is done at once: nobody is asked, and
// the agent builds nothing and runs no package-manager command. Otherwise, after either
// verdict, it moves on to `permission`, which shows the reviewer the Build Review Details and
// asks them alone for the one decision about the build, worded by the verdict: let the agent
// build or build it themselves after a safe one, build nothing or let the agent build anyhow
// after an unsafe one, or, after either, hold it unsafe for reasons of their own
// (pre-answered where the hot runs switched the agent's builds on, which skips that step).
// Unless they let the agent build, the folder is done at once: a rescue runs package-manager
// commands, so none is tried. Otherwise it audits the package root's lock (./audit.js). A lock
// the audit cannot read in full is done: nothing is built, and the review it starts aborts on
// that lock. So is a lock with a declared dependency nobody can review: the review aborts on
// that dependency, and nothing is built that runs it.
// A clean lock moves on to `build`: the linter copies the whole `sca/` into `build/`, and the
// agent builds the original there, as the lock pins it, and names what the build produced, or
// that it failed. A vulnerable lock gets a RESCUED COPY of the whole `sca/` in the same work
// folder (`rescued/`), and moves on to `rescue`: the agent reduces or fixes the copy's
// dependencies with lock-only commands and audits them until no high or critical advisory
// remains. Only then it builds, in a fresh copy of the whole `rescued/` in `build/`, so
// nothing is ever installed or built in the rescued copy. It names what the build produced,
// or that the rescue failed. The linter audits the copy again, whatever the agent answered,
// records its counts beside the submitted lock's, and checks the output it names. Where both
// hold, the copy is reviewed instead of the original. Otherwise `build/` is deleted and the
// copy is left as it is, and the original is done: it is reviewed like any other source, and
// its vulnerability checks abort it.
//
// Nothing the agent did is verified except by that audit and that output check. A dependency
// edit that changed shipped code fails the question whether the build reproduces the XPI,
// asked by the review itself.
//
// ONE FOLDER. The work folder is the whole run: one record (src/review/record.js), one cache,
// one review. A step that moves the record on within the mode hands back the record at its
// next step and the entries its prompt asks for, and the hand-back issues them
// (src/review/issue.js), the record written before the answers file. A step that changes the
// folder changes it first, so a run cut short is somewhere the next hand-back goes on from: a
// copy whose record was never moved on is made again, a question whose answers file was never
// written is written again, and a failed rescue whose build copy was not yet removed is
// finished. The only thing this file ever removes is `build/`, a fixed name inside the work
// folder, so no record can point a delete anywhere else.
//
// Belongs here: one step (handBack), the answers each step reads, the copies, the record each
// step moves on to, the delete, and the prompt each step prints. Does NOT belong here: the
// command line and the switch on the mode (-> src/cli.js), writing the record and printing
// (-> src/review/issue.js), the audit (-> ./audit.js), the record's shape (-> ./state.js), or
// what each prompt says (-> `llm-sca-review-prompt` in assets/registry.yaml).

import fs from "node:fs";
import path from "node:path";

import {
  BUILD_CHECK_STEP,
  BUILD_RESULT,
  buildRootOf,
  markDone,
} from "./state.js";
import {
  auditRoot,
  isClean,
  isRescuable,
  vulnerabilityCounts,
} from "./audit.js";
import { checkSelected } from "../checks/registry.js";
import { splitList } from "../lib/util.js";
import { misplacedFolders, runCache, workPaths } from "../util/dest.js";
import { defaultNet } from "../vendor/verify.js";
import { withRunCache } from "../vendor/run-cache.js";
import { rethrowIfFatal } from "../lib/errors.js";
import {
  HandbackRefused,
  SLOT,
  answersOf,
  outputAt,
  outputEntry,
  productWritten,
  readHandback,
  valueEntry,
} from "../report/handback.js";
import { displayLine, shellArg } from "../util/text.js";
import { detailRows, scaPromptLines } from "../report/format.js";
import { MODE, addToRecord, modeOf } from "../review/record.js";
import { checkedNote, pickedChoice } from "../report/verdicts.js";
import { checkedResult } from "../report/sweep.js";
import { RESULT_SHAPE } from "../config.js";

/** The answers file's entry for the Experiment folder, keyed by the name the prompt gives it. */
const EXPERIMENTS = "SCA_EXPERIMENTS";
/** The review file's entry for the reviewer's build decision, as `llm-sca-review-prompt`
 *  names it. */
const SCA_BUILD_PERMISSION = "SCA_BUILD_PERMISSION";
/** The review file's entry for what the build reaches for outside the declared dependencies,
 *  as `llm-sca-review-prompt` names it: the list the verdict is read off. */
const SCA_BUILD_SAFETY_ISSUES = "SCA_BUILD_SAFETY_ISSUES";
/** The review file's entry for what the agent's build produced, as `llm-sca-review-prompt`
 *  names it: in `build/` after a build and after a rescue. */
const LLM_BUILD_OUTPUT = "LLM_BUILD_OUTPUT";
/** The review file's entry for the agent's comparison of that output with the submitted XPI,
 *  as `llm-sca-review-prompt` names it: answered only where the build produced an output. */
const LLM_BUILD_XPI_MATCH = "LLM_BUILD_XPI_MATCH";
/**
 * Whether the hot runs switched the agent's builds on (WEBEXT_LINTER_AGENT_BUILDS=1): their
 * stand-in for the reviewer's build decision, which nothing documents. It lets the agent
 * build a build judged safe, and builds nothing judged unsafe. A test concern, so it is read
 * where it is used, by `analyze` when it would ask, and never recorded: the hot runs export it
 * for the whole session, so every hand-back inherits it (tests/hot/README.md).
 * @returns {boolean}
 */
function agentBuildsSwitchedOn() {
  return process.env.WEBEXT_LINTER_AGENT_BUILDS === "1";
}

/**
 * What a step hands out next: the record at the next step and the entries its prompt asks for
 * (`step`), which the hand-back issues, or the folder done (`review`), its record written,
 * whose review the hand-back starts in that folder.
 * @typedef {{next: "step", record: import("./state.js").BuildCheckPart, entries: object[]}
 *   | {next: "review", record: import("./state.js").BuildCheckPart}} Handout
 */

/**
 * The registry's build check texts, as llmScaReviewPrompt gives them.
 * @typedef {ReturnType<import("../checks/registry.js").Registry["llmScaReviewPrompt"]>}
 *   ScaPrompt
 */

/**
 * The registry's build decision, as llmScaReviewPrompt gives it: one question per verdict.
 * @typedef {ScaPrompt["buildPermission"]} BuildPermissionAsk
 */

/**
 * The registry's question for a build's output, as llmScaReviewPrompt gives it: the build's
 * or the rescue's.
 * @typedef {ScaPrompt["buildOutput"]} OutputAsk
 */

/**
 * The registry's comparison entry, as llmScaReviewPrompt gives it.
 * @typedef {ScaPrompt["buildMatch"]} MatchAsk
 */

/**
 * The context an audit is asked in (./audit.js auditRoot).
 * @typedef {{net?: import("../vendor/verify.js").VendorNet, cacheDir?: string}}
 *   AuditContext
 */

/**
 * Whether `unpack` asks for the Experiment folder: the built add-on declares Experiments, as
 * the load read it. It is asked there, beside the extracted archive, so the package root is
 * settled with it known. A review given --sca-extracted was given it (--sca-experiments).
 * @param {object} record  The record, in any mode.
 * @returns {boolean}
 */
export function asksExperiments(record) {
  return modeOf(record) === MODE.unpack && record.submission.experiments;
}

/**
 * The entries `unpack` asks for: the Experiment folder where it is asked (asksExperiments),
 * else none.
 * @param {object} record  In mode unpack.
 * @returns {object[]}
 */
export function unpackEntries(record) {
  return asksExperiments(record) ? [{ index: EXPERIMENTS, [SLOT]: null }] : [];
}

/**
 * The entries `analyze` asks for: the build's safety issues.
 * @returns {object[]}
 */
export function analyzeEntries() {
  return [{ index: SCA_BUILD_SAFETY_ISSUES, [SLOT]: null }];
}

/**
 * The entry the reviewer makes their build decision in, worded by the agent's verdict and
 * built as a process value's entry is. It is answered with one of its labels or the
 * reviewer's own words (permission).
 * @param {BuildPermissionAsk} question
 * @param {string} verdict  The agent's verdict, a BUILD_SAFETY_VALUES id.
 * @returns {object}
 */
function permissionEntry(question, verdict) {
  return valueEntry(
    { name: SCA_BUILD_PERMISSION, values: question[verdict].values },
    question[verdict].question
  );
}

/**
 * The entry the agent names what its build produced in, built as an output phase's entry is.
 * Its name is the one a refusal names the answer by.
 * @param {OutputAsk} ask
 * @returns {{name: string, answer: string, question: string,
 *   failed: {label: string, description: string}}}
 */
function outputPhase(ask) {
  return {
    name: LLM_BUILD_OUTPUT,
    answer: "output",
    question: ask.question,
    failed: ask.failed,
  };
}

/**
 * The entry the agent compares its build's output with the submitted XPI in, built as a
 * process value's entry is.
 * @param {MatchAsk} question
 * @returns {object}
 */
function matchEntry(question) {
  return valueEntry(
    { name: LLM_BUILD_XPI_MATCH, values: question.values },
    question.question
  );
}

/**
 * The two entries the build and rescue prompts hand out: where the build put its output, and
 * how that output compares with the submitted XPI.
 * @param {OutputAsk} asked
 * @param {MatchAsk} match
 * @returns {object[]}
 */
function buildEntries(asked, match) {
  return [outputEntry(outputPhase(asked)), matchEntry(match)];
}

/**
 * The build or rescue step's two answers, read from the review file, or undefined where the
 * file holds no LLM_BUILD_OUTPUT entry: the file an earlier step left, by a run cut short before
 * it wrote the question, which is then handed out again.
 *
 * LLM_BUILD_OUTPUT is checked as an output phase takes it. LLM_BUILD_XPI_MATCH belongs to an
 * output only: beside the `failed` label it must stay null, and beside a path it must be one of the
 * labels its entry offers. Either way round is refused, with nothing changed. The match comes
 * back as its id.
 * @param {string} work
 * @param {OutputAsk} asked
 * @param {MatchAsk} match
 * @returns {{answer: string, match: ?string}|undefined}
 * @throws {HandbackRefused}
 */
function builtAnswers(work, asked, match) {
  const file = workPaths(work).answers;
  const keyOf = (e) => String(e?.index);
  const entries = fs.existsSync(file) ? readHandback(file).entries : [];
  if (!entries.some((e) => keyOf(e) === LLM_BUILD_OUTPUT)) {
    return undefined;
  }
  const phase = outputPhase(asked);
  const answer = answersOf(
    entries.filter((e) => keyOf(e) !== LLM_BUILD_XPI_MATCH),
    [outputEntry(phase)],
    phase,
    keyOf
  ).get(LLM_BUILD_OUTPUT);
  const compared = entries.filter((e) => keyOf(e) === LLM_BUILD_XPI_MATCH);
  if (answer === phase.failed.label) {
    if (compared.length !== 1) {
      throw new HandbackRefused(
        `${LLM_BUILD_XPI_MATCH} ${compared.length ? "appears twice" : "is missing from the file"}`
      );
    }
    if (compared[0][SLOT] !== null && compared[0][SLOT] !== undefined) {
      throw new HandbackRefused(
        `${LLM_BUILD_XPI_MATCH} answers "${displayLine(String(compared[0][SLOT]))}", but ` +
          `${LLM_BUILD_OUTPUT} answers "${phase.failed.label}": leave its "${SLOT}" null`
      );
    }
    return { answer, match: null };
  }
  const picked = answersOf(
    compared,
    [matchEntry(match)],
    { name: phase.name, answer: "value" },
    keyOf
  ).get(LLM_BUILD_XPI_MATCH);
  return {
    answer,
    match: match.values.find((v) => v.label === picked).value,
  };
}

/**
 * Take the next step of the build check in `work`, and say what comes next. The record was
 * read by the hand-back, which found the folders the linter made as it left them.
 * @param {string} work  The work folder handed back, absolute and real.
 * @param {object} record  In mode build-check.
 * @param {import("../checks/registry.js").Registry} registry  The authored registry.
 * @returns {Promise<Handout>}
 * @throws {HandbackRefused}
 */
export async function handBack(work, record, registry) {
  // The audit reads the npm registry cache the review it starts will read, and asks OSV and
  // the popularity hosts through the run's cache, which every step of the build check and
  // its review share: the folder its flags name (--cache-work-dir), or the work folder's.
  const context = {
    net: withRunCache(
      defaultNet,
      runCache(work, record.flags?.["cache-work-dir"] || undefined)
    ),
    cacheDir: record.flags?.["cache-npm-registry-dir"] || undefined,
  };
  const prompt = registry.llmScaReviewPrompt();
  switch (record.current.step) {
    case BUILD_CHECK_STEP.analyze:
      return analyze(work, record, context, prompt, registry);
    case BUILD_CHECK_STEP.permission:
      return permission(work, record, context, prompt);
    case BUILD_CHECK_STEP.build:
      return builtOriginal(work, record, prompt.buildOutput, prompt.buildMatch);
    case BUILD_CHECK_STEP.rescue:
      return rescueStep(
        work,
        record,
        context,
        prompt.rescueOutput,
        prompt.buildMatch
      );
    default:
      return doneAgain(work, record);
  }
}

/**
 * The Experiment folder `unpack` handed back where it asked for one, as the agent wrote it,
 * else undefined. It names the folder as an absolute path inside EXTRACT_TO, which the
 * hand-back approves with the sca folders (src/addon/package-root.js approveScaFolders). A
 * blank answer or a relative one names no folder there, and is refused.
 * @param {string} work
 * @param {object} record  In mode unpack.
 * @returns {string|undefined}
 * @throws {HandbackRefused}
 */
export function unpackedExperiments(work, record) {
  if (!asksExperiments(record)) {
    return undefined;
  }
  const keyOf = (e) => String(e?.index);
  const handed = readHandback(workPaths(work).answers).entries.filter(
    (e) => keyOf(e) === EXPERIMENTS
  );
  // A blank answer names no folder, and would otherwise resolve to the extracted archive itself.
  const blank = handed.find(
    (e) => typeof e?.[SLOT] === "string" && !e[SLOT].trim()
  );
  if (blank) {
    throw new HandbackRefused(`${EXPERIMENTS} names no folder`);
  }
  const answer = answersOf(
    handed,
    [{ index: EXPERIMENTS, [SLOT]: null }],
    { name: "unpack", answer: "words" },
    keyOf
  )
    .get(EXPERIMENTS)
    .trim();
  if (!path.isAbsolute(answer)) {
    throw new HandbackRefused(
      `${EXPERIMENTS} "${displayLine(answer)}" is not an absolute path: name the folder as ` +
        "the absolute path it has inside EXTRACT_TO"
    );
  }
  return answer;
}

/**
 * The build analyzed: the verdict and the build report it rests on. Where a check the build
 * relies on is switched off (buildGuarded), the folder is done at once, asking nobody and
 * allowing no package-manager command: nothing then vouches for what an install pulls in.
 * Otherwise, after either verdict, it moves on to the permission question, or, where the
 * hot runs switched the agent's builds on (agentBuildsSwitchedOn), to the decision that
 * answers for the reviewer.
 * @param {string} work
 * @param {object} record  At `analyze`.
 * @param {AuditContext} context
 * @param {ScaPrompt} prompt
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {Promise<Handout>}
 */
async function analyze(work, record, context, prompt, registry) {
  const answers = analyzedAnswers(work, record);
  if (answers === undefined) {
    return ask(record, analyzeEntries());
  }
  const { roots, buildIssues } = answers;
  const build = workPaths(work).build;
  if (!productWritten(build)) {
    throw new HandbackRefused(
      `"${build}" holds no build report: write it there, as the prompt says`
    );
  }
  writeBuildIssues(workPaths(work).buildIssues, buildIssues);
  const buildSafety = buildIssues.length ? "unsafe" : "safe";
  const settled = movedOn(record, { buildSafety, buildIssues, roots });
  if (!buildGuarded(record, registry)) {
    return done(work, movedOn(settled, { packageManagers: false }));
  }
  if (agentBuildsSwitchedOn()) {
    const id = buildSafety === "safe" ? "allow" : "skip";
    return decided(work, settled, id, null, context, prompt);
  }
  return ask(movedOn(settled, { step: BUILD_CHECK_STEP.permission }), [
    permissionEntry(prompt.buildPermission, buildSafety),
  ]);
}

/**
 * The record moved on within the build check: what a step settled, or the next step, set in
 * its current part. The permanent part is not touched.
 * @param {object} record  In mode build-check.
 * @param {object} changes  The build check's own fields that change.
 * @returns {object}
 */
function movedOn(record, changes) {
  return { ...record, current: { ...record.current, ...changes } };
}

/**
 * Hand out a step's question: the record at its step, and the entries its answers file
 * holds, for the hand-back to issue. It writes the record first, so a run cut short before
 * the answers file leaves a folder whose next hand-back writes that file again (answerOf).
 * @param {object} record  At the step that asks.
 * @param {object[]} entries  The question's entries.
 * @returns {Handout}
 */
function ask(record, entries) {
  return { next: "step", record, entries };
}

/**
 * The answer to a step's one question, read from the review file and checked as `phase`
 * takes it, or undefined where the file holds no entry for it: the file an earlier step
 * left, by a run cut short before it wrote the question, which is then handed out again.
 * @param {string} work
 * @param {object} entry  The question's entry, as `ask` hands it out.
 * @param {{name: string, answer: string}} phase  How the answer is checked (answersOf).
 * @returns {*}
 * @throws {HandbackRefused}
 */
function answerOf(work, entry, phase) {
  const file = workPaths(work).answers;
  const keyOf = (e) => String(e?.index);
  const entries = fs.existsSync(file) ? readHandback(file).entries : [];
  if (!entries.some((e) => keyOf(e) === entry.index)) {
    return undefined;
  }
  return answersOf(entries, [entry], phase, keyOf).get(entry.index);
}

/**
 * The permission step, handed back: the reviewer's build decision read, one of the labels its
 * verdict's question offers, or their own words, which hold the build unsafe for the reasons
 * they give, held to the rule a reviewer's note is (checkedNote).
 * @param {string} work
 * @param {object} record
 * @param {AuditContext} context
 * @param {ScaPrompt} prompt
 * @returns {Promise<Handout>}
 * @throws {HandbackRefused}
 */
async function permission(work, record, context, prompt) {
  const entry = permissionEntry(
    prompt.buildPermission,
    record.current.buildSafety
  );
  const answer = answerOf(work, entry, { name: "permission", answer: "words" });
  if (answer === undefined) {
    return ask(record, [entry]);
  }
  const offered = prompt.buildPermission[record.current.buildSafety].values;
  const picked = pickedChoice(answer, offered);
  if (picked) {
    return decided(work, record, picked.value, null, context, prompt);
  }
  const { note, problem } = checkedNote(answer);
  if (problem) {
    throw new HandbackRefused(`${SCA_BUILD_PERMISSION} ${problem}`);
  }
  return decided(work, record, null, note, context, prompt);
}

/**
 * The reviewer's build decision, recorded: whether the build is safe, and whether the agent
 * builds it (`allow` and `override`), which `permitted` goes on from. Their own words are no
 * id, and hold the build unsafe for those reasons.
 * @param {string} work
 * @param {object} record
 * @param {?string} id  A BUILD_PERMISSION_VALUES id, or null for the reviewer's own words.
 * @param {?string} reasons  Those words, where they gave them.
 * @param {AuditContext} context
 * @param {ScaPrompt} prompt
 * @returns {Promise<Handout>}
 */
function decided(work, record, id, reasons, context, prompt) {
  return permitted(
    work,
    movedOn(record, {
      packageManagers: id === "allow" || id === "override",
      buildSafe: id === "allow" || id === "manual" || id === "override",
      buildReasons: reasons,
    }),
    context,
    prompt
  );
}

/**
 * What follows the permission: where the agent may not build, the folder done at once,
 * since a rescue would run package-manager commands. Otherwise the package root's lock
 * audited, and its counts recorded. A lock the audit cannot read in full, or one with a
 * declared dependency nobody can review, is done with nothing built, a clean one is copied
 * whole into `build/` and handed to the agent to build there, and a vulnerable one is
 * rescued.
 * @param {string} work
 * @param {object} record  With its permission.
 * @param {AuditContext} context
 * @param {ScaPrompt} prompt
 * @returns {Promise<Handout>}
 */
async function permitted(work, record, context, prompt) {
  if (!record.current.packageManagers) {
    return done(work, record);
  }
  const found = await auditRoot(record.current.roots, context);
  const audited = movedOn(record, {
    vulnerabilities: found.complete ? vulnerabilityCounts(found) : null,
  });
  if (isClean(found)) {
    const { sca, buildCopy } = workPaths(work);
    wholeCopy(sca, buildCopy, "build copy");
    return ask(
      movedOn(audited, { step: BUILD_CHECK_STEP.build }),
      buildEntries(prompt.buildOutput, prompt.buildMatch)
    );
  }
  if (isRescuable(found)) {
    return rescue(work, audited, prompt.rescueOutput, prompt.buildMatch);
  }
  return done(work, audited);
}

/**
 * The build step, handed back: what the agent's build of the clean original produced, held
 * to `build/`, and how it compares with the submitted XPI, or that it failed. Either way the
 * folder is done. A path that names nothing the build produced there is refused, with nothing
 * changed.
 * @param {string} work
 * @param {object} record  At `build`.
 * @param {OutputAsk} asked
 * @param {MatchAsk} match
 * @returns {Handout}
 * @throws {HandbackRefused}
 */
function builtOriginal(work, record, asked, match) {
  const answers = builtAnswers(work, asked, match);
  if (answers === undefined) {
    return ask(record, buildEntries(asked, match));
  }
  const output = outputAt(
    answers.answer,
    outputPhase(asked),
    workPaths(work).buildCopy
  );
  return done(
    work,
    movedOn(record, {
      buildResult: output ? BUILD_RESULT.built : BUILD_RESULT.failed,
      buildOutput: output,
      buildMatch: answers.match,
    })
  );
}

/**
 * What `analyze` handed back: the build's safety issues, a list of results each held to the
 * shape a sweep's are (buildIssuesOf), or undefined where the file holds no entry for them
 * (answerOf). Every way they can be wrong is refused, with nothing changed, so the reader can
 * correct the file and hand it back again.
 * @param {string} work
 * @param {object} record  At `analyze`, its folders known.
 * @returns {{roots: import("../addon/package-root.js").ScaFolders,
 *   buildIssues: {file: string, line: ?number, hint: string}[]}|undefined}
 * @throws {HandbackRefused}
 */
function analyzedAnswers(work, record) {
  const list = answerOf(work, analyzeEntries()[0], {
    name: "analyze",
    answer: "list",
  });
  if (list === undefined) {
    return undefined;
  }
  return {
    roots: record.current.roots,
    buildIssues: buildIssuesOf(list, realSca(workPaths(work))),
  };
}

/**
 * The build's safety issues as the reader handed them back: a list, each entry a result held by
 * the checker a sweep's results are held by (checkedResult), against the extracted archive
 * (`sca/`), which the build analysis reads whole, and each with a hint, which is what its
 * finding says. An empty list is a safe build.
 * @param {object[]} list  The SCA_BUILD_SAFETY_ISSUES answer, a list (answersOf).
 * @param {string} root  The extracted archive, absolute and real.
 * @returns {{file: string, line: ?number, hint: string}[]}
 * @throws {HandbackRefused}
 */
function buildIssuesOf(list, root) {
  const lineCounts = new Map();
  return list.map((raw, i) => {
    const at = `${SCA_BUILD_SAFETY_ISSUES} entry ${i + 1}`;
    let issue;
    try {
      issue = checkedResult(at, raw, root, lineCounts);
    } catch (err) {
      rethrowIfFatal(err);
      throw new HandbackRefused(err.message);
    }
    if (issue.hint === null) {
      throw new HandbackRefused(
        `${at} has no "hint" - say what the build does there, e.g. ${RESULT_SHAPE}`
      );
    }
    return issue;
  });
}

/**
 * Write the build's safety issues to the file the Build Review Details link: one line per
 * issue, its location and its hint, or one line saying the analysis found none. The linter's,
 * never the reader's, so it says exactly what was handed back and what build-unsafe reports.
 * @param {string} file  The work folder's build-issues.md.
 * @param {{file: string, line: ?number, hint: string}[]} issues
 * @returns {void}
 */
function writeBuildIssues(file, issues) {
  const lines = issues.length
    ? issues.map(
        ({ file: at, line, hint }) =>
          `- ${line === null ? at : `${at}:${line}`} - ${displayLine(hint)}`
      )
    : [
        "The build analysis found nothing the build reaches for outside the declared dependencies.",
      ];
  fs.writeFileSync(file, `# Build safety issues\n\n${lines.join("\n")}\n`);
}

/**
 * Whether every check the agent's build relies on runs (`build-guard`), by the flags the
 * review is run with: with one switched off by --checks-only or --checks-skip, nothing
 * vouches for what an install pulls in, so the agent is not let build. The review reads the
 * same answer (`build-guarded`, src/report/loop.js reviewBody).
 * @param {object} record
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {boolean}
 */
function buildGuarded(record, registry) {
  const only = splitList(record.flags?.["checks-only"]);
  const skip = splitList(record.flags?.["checks-skip"]);
  return registry
    .buildGuardIds()
    .every((id) => checkSelected(registry, id, { only, skip }));
}

/**
 * The folders moved to another copy of the source: the tree the review reads and the folders
 * inside it mapped by `to`, the Experiment folder only where it is there. The source copy
 * stays where it is.
 * @param {import("../addon/package-root.js").ScaFolders} roots
 * @param {(folder: string) => string} to
 * @returns {import("../addon/package-root.js").ScaFolders}
 */
function moveTree({ source, ...inTree }, to) {
  return {
    source,
    ...Object.fromEntries(
      Object.entries(inTree).map(([key, folder]) => [key, to(folder)])
    ),
  };
}

/**
 * The folder the source was extracted into, real: it must be a folder itself, not a link
 * to one, since everything inside it is taken as the submission's source. Asked of the
 * agent's answer at `unpack` (misplacedFolders words why it is not), and found as it was by
 * every later step, whose hand-back checked it first (src/review/record.js namedFolders).
 * @param {ReturnType<typeof workPaths>} paths
 * @returns {string}
 * @throws {HandbackRefused}
 */
export function realSca(paths) {
  const [misplaced] = misplacedFolders([paths.sca]);
  if (misplaced) {
    throw new HandbackRefused(
      `"${paths.sca}" ${misplaced.problem}, so it is not the folder the source was ` +
        "extracted into: extract it there"
    );
  }
  return fs.realpathSync(paths.sca);
}

/**
 * Mark a folder done: its review starts there, with the roots its record holds.
 * @param {string} work
 * @param {object} record
 * @returns {Handout}
 */
function done(work, record) {
  return {
    next: "review",
    record: markDone(work, movedOn(record, { step: BUILD_CHECK_STEP.done })),
  };
}

/**
 * Make the rescued copy of the work folder's source, in its `rescued/`, add that folder to
 * the record, and hand out its rescue.
 *
 * The copy is made first and the record moved on after, so a run cut short in between
 * leaves the record at the step that audited the lock, and handing the folder back makes the copy again - over
 * whatever the cut-short run left there, which is this run's own. Symbolic links are copied
 * as they are written: one the submission points out of itself stays pointing out, for the
 * review to report, rather than being followed into a copy of whatever it names.
 *
 * A copy that cannot be made ends the run as the tool's failure, before any prompt names it.
 * @param {string} work
 * @param {object} record  Audited.
 * @param {OutputAsk} asked
 * @param {MatchAsk} match
 * @returns {Handout}
 * @throws {Error}  The copy could not be made.
 */
function rescue(work, record, asked, match) {
  const { sca: from, rescued: to } = workPaths(work);
  const real = fs.realpathSync(from);
  const into = (p) => path.join(to, path.relative(real, p));
  wholeCopy(from, to, "rescued copy");
  // The rescued copy is one of the submission's folders from here on, named by the record.
  const named = addToRecord(work, record, { folders: { rescued: to } });
  return ask(
    movedOn(named, {
      step: BUILD_CHECK_STEP.rescue,
      roots: moveTree(record.current.roots, (p) => fs.realpathSync(into(p))),
    }),
    buildEntries(asked, match)
  );
}

/**
 * A whole-tree copy of `from` in `to`, over whatever was there: the rescued copy of `sca/`,
 * or the copy of `sca/` a clean source is built in. Symbolic links are copied as they are
 * written. A copy that cannot be made ends the run as the tool's failure, before any prompt
 * names it.
 * @param {string} from
 * @param {string} to
 * @param {string} called  How the failure names the copy.
 * @returns {void}
 * @throws {Error}  The copy could not be made.
 */
function wholeCopy(from, to, called) {
  try {
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  } catch (err) {
    rethrowIfFatal(err);
    throw new Error(
      `The ${called} "${to}" could not be made (${err.code ?? err.message}). ` +
        "Hand the work folder back once that is fixed.",
      { cause: err }
    );
  }
}

/**
 * The rescue, handed back: the copy's lock audited, whatever the agent answered, and its
 * counts recorded beside the submitted lock's, null where the audit cannot read it in full.
 * Done with the copy as the reviewed source where the output the agent named lies inside
 * `build/` and the copy's lock audits clean, with the agent's comparison recorded. Otherwise,
 * or where the agent answered that the rescue failed, the rescue failed: the folder is done
 * with its roots back in `sca/`, before `build/` is removed, the copy left as the agent left
 * it.
 * @param {string} work
 * @param {object} record  At `rescue`.
 * @param {AuditContext} context
 * @param {OutputAsk} asked
 * @param {MatchAsk} match
 * @returns {Promise<Handout>}
 * @throws {HandbackRefused}  An answer that is no path and no label, or a comparison that
 *   does not go with it.
 */
async function rescueStep(work, record, context, asked, match) {
  const phase = outputPhase(asked);
  const answers = builtAnswers(work, asked, match);
  if (answers === undefined) {
    return ask(record, buildEntries(asked, match));
  }
  const { sca, rescued, buildCopy } = workPaths(work);
  const output = producedIn(answers.answer, phase, buildCopy);
  const found = await auditRoot(record.current.roots, context);
  const rescuedVulnerabilities = found.complete
    ? vulnerabilityCounts(found)
    : null;
  if (output && isClean(found)) {
    return done(
      work,
      movedOn(record, {
        rescuedVulnerabilities,
        buildResult: BUILD_RESULT.built,
        buildOutput: output,
        buildMatch: answers.match,
      })
    );
  }
  const real = fs.realpathSync(rescued);
  const back = (p) => path.join(fs.realpathSync(sca), path.relative(real, p));
  const failed = markDone(
    work,
    movedOn(record, {
      rescuedVulnerabilities,
      step: BUILD_CHECK_STEP.done,
      roots: moveTree(record.current.roots, back),
      buildResult: BUILD_RESULT.rescueFailed,
      buildOutput: null,
      buildMatch: null,
    })
  );
  removeBuild(work);
  return { next: "review", record: failed };
}

/**
 * Remove the build copy a failed rescue built in.
 * @param {string} work
 * @returns {void}
 */
function removeBuild(work) {
  fs.rmSync(workPaths(work).buildCopy, { recursive: true, force: true });
}

/**
 * What the rescue's build produced inside the build copy, or null where the agent answered
 * that the rescue failed or named nothing the build produced there: either way the rescue
 * failed.
 * @param {string} answer
 * @param {ReturnType<typeof outputPhase>} phase
 * @param {string} copy  The work folder's `build/`.
 * @returns {?string}
 */
function producedIn(answer, phase, copy) {
  try {
    return outputAt(answer, phase, copy);
  } catch (err) {
    if (err instanceof HandbackRefused) {
      return null;
    }
    throw err;
  }
}

/**
 * A done folder handed back again before its review started - the start before was refused,
 * failed, or was cut short: its review is started once more. A failed rescue cut short has its
 * build copy removed first.
 * And the build check's answers file, which no prompt names any more, is deleted again, in
 * case the run that marked the folder was cut short before it could.
 * @param {string} work
 * @param {object} record
 * @returns {Handout}
 */
function doneAgain(work, record) {
  if (record.current.buildResult === BUILD_RESULT.rescueFailed) {
    removeBuild(work);
  }
  return { next: "review", record: markDone(work, record) };
}

/**
 * The command that carries the folder on: a hand-back of the work folder named.
 * @param {string} work
 * @returns {string[]}
 */
function handbackCommand(work) {
  return [`--llm-handback ${shellArg(work)}`];
}

/**
 * The prompt a record in mode unpack or build-check is waiting on, its step's own
 * (`llm-sca-review-prompt`): printed by the run that starts the mode (`first`, with the intro,
 * on the review's first prompt) and by every hand-back that moves it on. What each prompt
 * names beside its steps follows its step: the submission and where to extract it (`unpack`),
 * the source, its package root and the build report (`analyze`), the Build Review Details
 * (`permission`), and the folders a build runs in. Every build runs at the package root's place
 * in `build/`, its output is compared with the submitted XPI, and the rescue's agent makes
 * `build/` a copy of the whole `rescued/` before each build, with the two commands named here.
 * @param {string} work
 * @param {object} record  At the step its prompt is for.
 * @param {import("../checks/registry.js").Registry} registry
 * @param {{first?: boolean, submission?: {folder: string, xpi: string, source: string}}}
 *   [start]  On the run that starts the mode: the intro where it is the review's first
 *   prompt, and for `unpack` the submission (scaSubmission).
 * @returns {string[]}
 */
export function stepPromptLines(work, record, registry, start = {}) {
  const prompt = registry.llmScaReviewPrompt();
  const paths = workPaths(work);
  const roots = record.current?.roots;
  const buildRoot = () => buildRootOf(work, roots);
  const named = {
    unpack: () => ({
      submission: start.submission,
      extractTo: `${paths.sca}${path.sep}`,
      // The Experiment folder is handed back in the answers file, where it is asked.
      ...(asksExperiments(record)
        ? { answers: paths.answers, findExperiment: true }
        : {}),
    }),
    [BUILD_CHECK_STEP.analyze]: () => ({
      answers: paths.answers,
      scaSource: roots.source,
      scaPackageRoot: roots.packageRoot,
      buildProcess: paths.build,
    }),
    [BUILD_CHECK_STEP.permission]: () => ({
      answers: paths.answers,
      buildDetails: buildDetailLines(work, record, registry),
    }),
    [BUILD_CHECK_STEP.build]: () => ({
      answers: paths.answers,
      scaPackageRoot: roots.packageRoot,
      buildRoot: buildRoot(),
      buildProcess: paths.build,
      submittedXpi: record.submission.xpi,
    }),
    [BUILD_CHECK_STEP.rescue]: () => ({
      answers: paths.answers,
      rescueRoot: roots.packageRoot,
      buildRoot: buildRoot(),
      buildProcess: paths.build,
      submittedXpi: record.submission.xpi,
      copy: [
        `rm -rf ${shellArg(paths.buildCopy)}`,
        `cp -a ${shellArg(paths.rescued)} ${shellArg(paths.buildCopy)}`,
      ],
    }),
  }[record.current.step]();
  return scaPromptLines(prompt, record.current.step, {
    first: Boolean(start.first),
    ...named,
    flags: handbackCommand(work),
  });
}

/**
 * The Build Review Details the permission prompt shows: the submitted XPI, the source folders,
 * the build report, the verdict and the issues it was read off, as the review loop's blocks
 * name them (detailRows), so the review's Build Review Details hold every row of it. It ends
 * with the line saying the review waits for the reviewer's reply, as a turn-ending block does.
 * @param {string} work
 * @param {object} record  At `permission`.
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {string[]}
 */
function buildDetailLines(work, record, registry) {
  return [
    ...detailRows({
      xpiFile: path.basename(record.submission.xpi),
      xpi: record.submission.xpi,
      scaFolders: record.current.roots,
      buildFile: workPaths(work).build,
      buildSafety: record.current.buildSafety,
      buildIssuesFile: workPaths(work).buildIssues,
    }),
    "",
    registry.llmPhases().waiting("permission"),
  ];
}
