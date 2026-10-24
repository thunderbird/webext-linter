// The STEPS of the preparation of a source code review: what one hand-back of a work folder
// does to it, and which prompt comes next.
//
// Two runs start a preparation, and from `analyze` on they run the same steps. One given a
// submission folder (--llm-sca-review) has the source archive extracted into the work folder's
// `sca/` and its Experiment folder named first (`unpack`), and its hand-back derives the package
// root inside it, that folder known (src/addon/package-root.js). One given the extracted source
// (--llm-review --sca-extracted) has it copied into `sca/` by the linter, and starts at
// `analyze`. There the reader reports the build in build.md and hands back the issues the verdict
// is read off. Where a check the build relies on is switched off (`build-guard`), the folder is
// done at once: nobody is asked, and the agent builds nothing and runs no package-manager
// command. Otherwise, after either verdict, it moves on to `permission`, which shows the reviewer
// the Build Review Details and asks them alone for the one decision about the build, worded by
// the verdict: let the agent build or build it themselves after a safe one, build nothing or let
// the agent build anyhow after an unsafe one, or, after either, hold it unsafe for reasons of
// their own (pre-answered where the record holds agentBuilds, which skips that step). Unless they
// let the agent build, the folder is done at once: a rescue runs package-manager commands, so
// none is tried. Otherwise it audits the package root's lock (./audit.js). A lock the audit
// cannot read in full is done: nothing is built, and the review it starts aborts on that lock. A
// clean lock moves on to `build`: the linter copies the whole `sca/` into `build/`, and the agent
// builds the original there, as the lock pins it, and names what the build produced, or that it
// failed. A vulnerable lock gets a RESCUED COPY of the whole `sca/` in the same work folder
// (`rescued/`), and moves on to `rescue`: the agent reduces or fixes the copy's dependencies with
// lock-only commands and audits them until no high or critical advisory remains. Only then it
// builds, in a fresh copy of the whole `rescued/` in `build/`, so nothing is ever installed or
// built in the rescued copy. It names what the build produced, or that the rescue failed. The
// linter audits the copy again, whatever the agent answered, records its counts beside the
// submitted lock's, and checks the output it names. Where both hold, the copy is reviewed instead
// of the original. Otherwise the copy and `build/` are deleted, and the original is done: it is
// reviewed like any other source, and its vulnerability checks abort it.
//
// Nothing the agent did is verified except by that audit and that output check. A dependency
// edit that changed shipped code fails the question whether the build reproduces the XPI,
// asked by the review itself.
//
// ONE FOLDER. The work folder is the whole run: one record (./state.js), one cache, one
// review. Each step writes the record first and changes the folder after, so a run cut short
// is somewhere the next hand-back goes on from: a copy whose record was never moved on is made
// again, a question whose review file was never written is written again, and a failed
// rescue whose copies were not yet removed is finished. The only things this file
// ever removes are `rescued/` and `build/`, fixed names inside the work folder, so no record
// can point a delete anywhere else.
//
// Belongs here: one step (handBack), the review files the steps read their answers from,
// the copy, the records each step writes, and the delete. Does NOT belong here: the command
// line and the printing (-> src/cli.js and src/report/format.js), the audit (-> ./audit.js),
// the record's shape (-> ./state.js), or what each prompt says (-> `llm-sca-review-prompt`
// in assets/registry.yaml).

import fs from "node:fs";
import path from "node:path";

import {
  BUILD_RESULT,
  PREPARE_STEP,
  markPrepare,
  readPrepare,
  writePrepare,
} from "./state.js";
import {
  auditRoot,
  isClean,
  isRescuable,
  vulnerabilityCounts,
} from "./audit.js";
import {
  foldersInCopy,
  readInPlace,
  settlePackageRoot,
} from "../addon/package-root.js";
import { checkSelected, loadRegistry } from "../checks/registry.js";
import { splitList } from "../lib/util.js";
import { relativeInside } from "../addon/load.js";
import { runCache, workPaths } from "../util/dest.js";
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
  reviewFile,
  valueEntry,
  writeReviewFile,
} from "../report/handback.js";
import { displayLine } from "../util/text.js";
import { checkedNote, pickedChoice } from "../report/verdicts.js";
import { checkedResult } from "../report/sweep.js";
import { RESULT_SHAPE } from "../config.js";

/** The review file's entry for the Experiment folder, keyed by the name the prompt gives it. */
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
/** Whether the hot runs switched the agent's builds on (WEBEXT_LINTER_AGENT_BUILDS=1): their
 *  stand-in for the reviewer's build decision, which nothing documents. It lets the agent
 *  build a build judged safe, and builds nothing judged unsafe. Read once: no setter, nothing
 *  to undo. */
const AGENT_BUILDS = process.env.WEBEXT_LINTER_AGENT_BUILDS === "1";

/**
 * Whether the hot runs answered the permission question up front. Read only by the run that
 * creates the work folder, which records it (`agentBuilds`), so every hand-back after reads
 * the record and never the environment.
 * @returns {boolean}
 */
export function agentBuildsSwitchedOn() {
  return AGENT_BUILDS;
}

/**
 * What a hand-back hands out next: the prompt for the record's step (`step`), the permission
 * question or a rescued copy's step, or the review (`review`), which the hand-back starts in
 * that folder from that record.
 * @typedef {{next: "step"|"review", work: string,
 *   record: import("./state.js").PrepareRecord}} Handout
 */

/**
 * The registry's preparation texts, as llmScaReviewPrompt gives them.
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
 * Start the preparation in a work folder just created for it: its record, at `unpack` or at
 * `analyze` (startRecord), and the review file its first step's answers come back in - none at
 * `unpack`, whose hand-back answers nothing.
 * @param {string} work  The work folder, absolute and real.
 * @param {import("./state.js").PrepareRecord} record  From startRecord.
 * @returns {void}
 */
export function startPreparation(work, record) {
  writePrepare(work, record);
  writeReviewFile(
    workPaths(work).review,
    reviewFile(
      record.step === PREPARE_STEP.analyze
        ? analyzeEntries()
        : unpackEntries(record)
    )
  );
}

/**
 * Whether `unpack` asks for the Experiment folder: the built add-on declares Experiments. It is
 * asked there, beside the extracted archive, so the package root is settled with it known. A
 * review given --sca-extracted was given it (--sca-experiments) and starts at `analyze`.
 * @param {import("./state.js").PrepareRecord} record
 * @returns {boolean}
 */
export function asksExperiments(record) {
  return record.step === PREPARE_STEP.unpack && record.submission.experiments;
}

/**
 * The entries `unpack` asks for: the Experiment folder where it is asked (asksExperiments),
 * else none.
 * @param {import("./state.js").PrepareRecord} record
 * @returns {object[]}
 */
function unpackEntries(record) {
  return asksExperiments(record) ? [{ index: EXPERIMENTS, [SLOT]: null }] : [];
}

/**
 * The entries `analyze` asks for: the build's safety issues.
 * @returns {object[]}
 */
function analyzeEntries() {
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
  const file = workPaths(work).review;
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
 * Take the next step of the preparation in `work`, and say what comes next.
 * @param {string} work  The work folder handed back, absolute and real, holding a record.
 * @param {import("../checks/registry.js").Registry} [registry]  The authored registry,
 *   loaded here when the caller has none.
 * @returns {Promise<Handout>}
 * @throws {HandbackRefused}
 */
export async function handBack(work, registry = loadRegistry()) {
  const record = readPrepare(work);
  if (!record) {
    throw new HandbackRefused(`"${work}" holds no preparation`);
  }
  // The audit reads the npm registry cache the review it starts will read, and asks OSV and
  // the popularity hosts through the run's cache, which every step of the preparation and
  // its review share: the folder its flags name (--cache-work-dir), or the work folder's.
  const context = {
    net: withRunCache(
      defaultNet,
      runCache(work, record.flags?.["cache-work-dir"] || undefined)
    ),
    cacheDir: record.flags?.["cache-npm-registry-dir"] || undefined,
  };
  const prompt = registry.llmScaReviewPrompt();
  switch (record.step) {
    case PREPARE_STEP.unpack:
      return unpacked(work, record);
    case PREPARE_STEP.analyze:
      return analyze(work, record, context, prompt, registry);
    case PREPARE_STEP.permission:
      return permission(work, record, context, prompt);
    case PREPARE_STEP.build:
      return builtOriginal(work, record, prompt.buildOutput, prompt.buildMatch);
    case PREPARE_STEP.rescue:
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
 * The source archive extracted into `sca/`, and the Experiment folder in it where it was asked
 * (unpackedExperiments): the package root derived inside it, as the review derives one
 * (src/addon/package-root.js settlePackageRoot) with the Experiment folder known - `sca/`
 * itself where it holds the package file or the walk cannot decide - and the build handed out
 * to be analyzed. A refusal leaves the record at `unpack`, so the reader corrects the file and
 * hands it back again.
 * @param {string} work
 * @param {import("./state.js").PrepareRecord} record  At `unpack`.
 * @returns {Handout}
 * @throws {HandbackRefused}
 */
function unpacked(work, record) {
  const extracted = realSca(workPaths(work));
  let folders;
  try {
    ({ folders } = settlePackageRoot({
      extracted,
      packageRoot: extracted,
      ...unpackedExperiments(work, record, extracted),
    }));
  } catch (err) {
    rethrowIfFatal(err);
    throw err instanceof HandbackRefused
      ? err
      : new HandbackRefused(err.message);
  }
  const analyzing = {
    ...record,
    step: PREPARE_STEP.analyze,
    roots: readInPlace(folders),
  };
  return ask(work, analyzing, analyzeEntries());
}

/**
 * The Experiment folder `unpack` handed back where it asked for one, as `{experiments}`, else
 * nothing: taken as the folder it really is and held inside the extracted archive, resolved
 * against it as the review resolves it. Every way it can be wrong is refused.
 * @param {string} work
 * @param {import("./state.js").PrepareRecord} record  At `unpack`.
 * @param {string} extracted  The real `sca/`.
 * @returns {{experiments?: string}}
 * @throws {HandbackRefused}
 */
function unpackedExperiments(work, record, extracted) {
  if (!asksExperiments(record)) {
    return {};
  }
  const keyOf = (e) => String(e?.index);
  const handed = readHandback(workPaths(work).review).entries.filter(
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
  ).get(EXPERIMENTS);
  const exp = realFolder(path.resolve(extracted, answer.trim()));
  if (!exp || relativeInside(exp, extracted) === null) {
    throw new HandbackRefused(
      `${EXPERIMENTS} "${displayLine(answer)}" is not a folder inside "${extracted}"`
    );
  }
  return { experiments: exp };
}

/**
 * The build analyzed: the verdict and the build report it rests on. Where a check the build
 * relies on is switched off (buildGuarded), the folder is done at once, asking nobody and
 * allowing no package-manager command: nothing then vouches for what an install pulls in.
 * Otherwise, after either verdict, it moves on to the permission question, or, where the
 * record holds agentBuilds, to the decision that answers for the reviewer.
 * @param {string} work
 * @param {import("./state.js").PrepareRecord} record  At `analyze`.
 * @param {AuditContext} context
 * @param {ScaPrompt} prompt
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {Promise<Handout>}
 */
async function analyze(work, record, context, prompt, registry) {
  const { roots, buildIssues } = analyzedAnswers(work, record);
  const build = workPaths(work).build;
  if (!productWritten(build)) {
    throw new HandbackRefused(
      `"${build}" holds no build report: write it there, as the prompt says`
    );
  }
  writeBuildIssues(workPaths(work).buildIssues, buildIssues);
  const buildSafety = buildIssues.length ? "unsafe" : "safe";
  const settled = { ...record, buildSafety, buildIssues, roots };
  if (!buildGuarded(record, registry)) {
    return done(work, { ...settled, packageManagers: false });
  }
  if (record.agentBuilds) {
    const id = buildSafety === "safe" ? "allow" : "skip";
    return decided(work, settled, id, null, context, prompt);
  }
  return ask(work, { ...settled, step: PREPARE_STEP.permission }, [
    permissionEntry(prompt.buildPermission, buildSafety),
  ]);
}

/**
 * Hand out a step's question: the record at its step, and the review file holding the
 * question's entries. The record is written first, so a run cut short before the review
 * file leaves a folder whose next hand-back writes that file again (answerOf, builtAnswers).
 * @param {string} work
 * @param {import("./state.js").PrepareRecord} record  At the step that asks.
 * @param {object[]} entries  The question's entries.
 * @returns {Handout}
 */
function ask(work, record, entries) {
  const written = writePrepare(work, record);
  writeReviewFile(workPaths(work).review, reviewFile(entries));
  return { next: "step", work, record: written };
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
  const file = workPaths(work).review;
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
 * @param {import("./state.js").PrepareRecord} record
 * @param {AuditContext} context
 * @param {ScaPrompt} prompt
 * @returns {Promise<Handout>}
 * @throws {HandbackRefused}
 */
async function permission(work, record, context, prompt) {
  const entry = permissionEntry(prompt.buildPermission, record.buildSafety);
  const answer = answerOf(work, entry, { name: "permission", answer: "words" });
  if (answer === undefined) {
    return ask(work, record, [entry]);
  }
  const offered = prompt.buildPermission[record.buildSafety].values;
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
 * @param {import("./state.js").PrepareRecord} record
 * @param {?string} id  A BUILD_PERMISSION_VALUES id, or null for the reviewer's own words.
 * @param {?string} reasons  Those words, where they gave them.
 * @param {AuditContext} context
 * @param {ScaPrompt} prompt
 * @returns {Promise<Handout>}
 */
function decided(work, record, id, reasons, context, prompt) {
  return permitted(
    work,
    {
      ...record,
      packageManagers: id === "allow" || id === "override",
      buildSafe: id === "allow" || id === "manual" || id === "override",
      buildReasons: reasons,
    },
    context,
    prompt
  );
}

/**
 * What follows the permission: where the agent may not build, the folder done at once,
 * since a rescue would run package-manager commands. Otherwise the package root's lock audited, and
 * its counts recorded. A lock the audit cannot read in full is done with nothing built, a
 * clean one is copied whole into `build/` and handed to the agent to build there, and a
 * vulnerable one is rescued.
 * @param {string} work
 * @param {import("./state.js").PrepareRecord} record  With its permission.
 * @param {AuditContext} context
 * @param {ScaPrompt} prompt
 * @returns {Promise<Handout>}
 */
async function permitted(work, record, context, prompt) {
  if (!record.packageManagers) {
    return done(work, record);
  }
  const found = await auditRoot(record.roots, context);
  const audited = { ...record, vulnerabilities: vulnerabilityCounts(found) };
  if (isClean(found)) {
    const { sca, buildCopy } = workPaths(work);
    wholeCopy(sca, buildCopy, "build copy");
    return ask(
      work,
      { ...audited, step: PREPARE_STEP.build },
      buildEntries(prompt.buildOutput, prompt.buildMatch)
    );
  }
  if (isRescuable(found)) {
    return rescue(work, audited, prompt.rescueOutput, prompt.buildMatch);
  }
  return done(work, record);
}

/**
 * The build step, handed back: what the agent's build of the clean original produced, held
 * to `build/`, and how it compares with the submitted XPI, or that it failed. Either way the
 * folder is done. A path that names nothing the build produced there is refused, with nothing
 * changed.
 * @param {string} work
 * @param {import("./state.js").PrepareRecord} record  At `build`.
 * @param {OutputAsk} asked
 * @param {MatchAsk} match
 * @returns {Handout}
 * @throws {HandbackRefused}
 */
function builtOriginal(work, record, asked, match) {
  const answers = builtAnswers(work, asked, match);
  if (answers === undefined) {
    return ask(work, record, buildEntries(asked, match));
  }
  const output = outputAt(
    answers.answer,
    outputPhase(asked),
    workPaths(work).buildCopy
  );
  return done(work, {
    ...record,
    buildResult: output ? BUILD_RESULT.built : BUILD_RESULT.failed,
    buildOutput: output,
    buildMatch: answers.match,
  });
}

/**
 * What `analyze` handed back: the build's safety issues, a list of results each held to the
 * shape a sweep's are (buildIssuesOf). Every way they can be wrong is refused, with nothing
 * changed, so the reader can correct the file and hand it back again.
 * @param {string} work
 * @param {import("./state.js").PrepareRecord} record  At `analyze`, its folders known.
 * @returns {{roots: import("../addon/package-root.js").ScaFolders,
 *   buildIssues: {file: string, line: ?number, hint: string}[]}}
 * @throws {HandbackRefused}
 */
function analyzedAnswers(work, record) {
  const keyOf = (e) => String(e?.index);
  const all = readHandback(workPaths(work).review).entries;
  const buildIssues = buildIssuesOf(
    all.find((e) => keyOf(e) === SCA_BUILD_SAFETY_ISSUES),
    realSca(workPaths(work))
  );
  return { roots: record.roots, buildIssues };
}

/**
 * The build's safety issues as the reader handed them back: a list, each entry a result held by
 * the checker a sweep's results are held by (checkedResult), against the extracted archive
 * (`sca/`), which the build analysis reads whole, and each with a hint, which is what its
 * finding says. An empty list is a safe build.
 * @param {?object} entry  The SCA_BUILD_SAFETY_ISSUES entry of the review file.
 * @param {string} root  The extracted archive, absolute and real.
 * @returns {{file: string, line: ?number, hint: string}[]}
 * @throws {HandbackRefused}
 */
function buildIssuesOf(entry, root) {
  const list = entry?.[SLOT];
  if (list === undefined || list === null) {
    throw new HandbackRefused(
      `${SCA_BUILD_SAFETY_ISSUES} still has no "${SLOT}" - answer it with a list, [] where the build reaches for nothing`
    );
  }
  if (!Array.isArray(list)) {
    throw new HandbackRefused(
      `${SCA_BUILD_SAFETY_ISSUES} answers with no list - answer it with one entry per issue, [] where there are none`
    );
  }
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
 * same answer (`build-guarded`, src/pipeline.js).
 * @param {import("./state.js").PrepareRecord} record
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {boolean}
 */
function buildGuarded(record, registry) {
  const only = splitList(record.flags?.["checks-only"]);
  const skip = splitList(record.flags?.["checks-skip"]);
  return registry
    .buildGuardIds()
    .every((id) => checkSelected(id, { only, skip }));
}

/**
 * The folders a review is started with, asked again of the folder it starts in: the agent
 * works there between the step that settled them and the start, and can swap a folder for
 * a link. So each is followed to the folder it really is, and must still be one where the
 * preparation put it - the source copy `sca/`, the tree the review reads, `sca/` or its rescued
 * copy `rescued/`, and the package root and Experiment folder inside that tree.
 * @param {string} work  The work folder the review starts in.
 * @param {import("../addon/package-root.js").ScaFolders} roots  As the record holds them.
 * @returns {import("../addon/package-root.js").ScaFolders}  The real folders, which the review
 *   reads.
 * @throws {HandbackRefused}
 */
export function recordedRoots(work, roots) {
  const paths = workPaths(work);
  const sca = realSca(paths);
  if (realFolder(roots.source) !== sca) {
    throw new HandbackRefused(
      `the preparation's record names a source copy "${displayLine(roots.source)}" ` +
        `that is not "${sca}"`
    );
  }
  const used = realFolder(roots.used);
  if (used !== sca && used !== realFolder(paths.rescued)) {
    throw new HandbackRefused(
      `the preparation's record names a reviewed copy "${displayLine(roots.used)}" ` +
        `that is neither "${sca}" nor its rescued copy`
    );
  }
  const inside = (key, what) => {
    const real = realFolder(roots[key]);
    if (!real || relativeInside(real, used) === null) {
      throw new HandbackRefused(
        `the preparation's record names ${what} "${displayLine(roots[key])}" ` +
          `that is not a folder inside "${used}"`
      );
    }
    return real;
  };
  return {
    source: sca,
    used,
    packageRoot: inside("packageRoot", "a package root"),
    ...(Object.hasOwn(roots, "experiments")
      ? { experiments: inside("experiments", "an Experiment folder") }
      : {}),
  };
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
 * to one, since everything inside it is taken as the submission's source.
 * @param {ReturnType<typeof workPaths>} paths
 * @returns {string}
 * @throws {HandbackRefused}
 */
function realSca(paths) {
  const linked = fs.lstatSync(paths.sca, { throwIfNoEntry: false });
  if (!linked?.isDirectory()) {
    throw new HandbackRefused(
      `"${paths.sca}" is not the folder the source was extracted into: extract it there`
    );
  }
  return fs.realpathSync(paths.sca);
}

/**
 * The folder `p` really is, links followed, or null where it is no folder.
 * @param {string} p
 * @returns {?string}
 */
function realFolder(p) {
  try {
    const real = fs.realpathSync(p);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch (err) {
    rethrowIfFatal(err);
    return null;
  }
}

/**
 * Mark a folder done: its review starts there, with the roots its record holds.
 * @param {string} work
 * @param {import("./state.js").PrepareRecord} record
 * @returns {Handout}
 */
function done(work, record) {
  return {
    next: "review",
    work,
    record: markPrepare(work, { ...record, step: PREPARE_STEP.done }),
  };
}

/**
 * Make the rescued copy of the work folder's source, in its `rescued/`, and hand out its
 * rescue.
 *
 * The copy is made first and the record moved on after, so a run cut short in between
 * leaves the record at the step that audited the lock, and handing the folder back makes the copy again - over
 * whatever the cut-short run left there, which is this run's own. Symbolic links are copied
 * as they are written: one the submission points out of itself stays pointing out, for the
 * review to report, rather than being followed into a copy of whatever it names.
 *
 * A copy that cannot be made ends the run as the tool's failure, before any prompt names it.
 * @param {string} work
 * @param {import("./state.js").PrepareRecord} record  Audited.
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
  return ask(
    work,
    {
      ...record,
      step: PREPARE_STEP.rescue,
      roots: moveTree(record.roots, (p) => fs.realpathSync(into(p))),
    },
    buildEntries(asked, match)
  );
}

/**
 * The source every review given --sca-extracted works on: the whole of that folder copied
 * into the work folder's `sca/`, as --llm-sca-review's reader extracts the archive there, and
 * the folders given inside it mapped to their place in the copy. The folder given is read
 * only by the copy: from here on the review, and the preparation before it, read the copy.
 * @param {string} work  The work folder.
 * @param {import("../addon/package-root.js").ScaGiven} given  Settled, absolute and real: the
 *   extracted source, and the package root and Experiment folder inside it.
 * @returns {import("../addon/package-root.js").ScaFolders}  The same folders in the copy,
 *   which the review reads as it is.
 * @throws {Error}  The copy could not be made.
 */
export function copySource(work, given) {
  const { sca } = workPaths(work);
  wholeCopy(given.extracted, sca, "source copy");
  return foldersInCopy(given, fs.realpathSync(sca));
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
        "Hand the work folder back once that is fixed."
    );
  }
}

/**
 * The rescue, handed back: the copy's lock audited, whatever the agent answered, and its
 * counts recorded beside the submitted lock's, null where the audit cannot read it in full.
 * Done with the copy as the reviewed source where the output the agent named lies inside
 * `build/` and the copy's lock audits clean, with the agent's comparison recorded. Otherwise,
 * or where the agent answered that the rescue failed, the rescue failed: the folder is done
 * with its roots back in `sca/`, before the copy and `build/` are removed.
 * @param {string} work
 * @param {import("./state.js").PrepareRecord} record  At `rescue`.
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
    return ask(work, record, buildEntries(asked, match));
  }
  const { sca, rescued, buildCopy } = workPaths(work);
  const output = producedIn(answers.answer, phase, buildCopy);
  const found = await auditRoot(record.roots, context);
  const rescuedVulnerabilities = found.complete
    ? vulnerabilityCounts(found)
    : null;
  if (output && isClean(found)) {
    return done(work, {
      ...record,
      rescuedVulnerabilities,
      buildResult: BUILD_RESULT.built,
      buildOutput: output,
      buildMatch: answers.match,
    });
  }
  const real = fs.realpathSync(rescued);
  const back = (p) => path.join(fs.realpathSync(sca), path.relative(real, p));
  const failed = markPrepare(work, {
    ...record,
    rescuedVulnerabilities,
    step: PREPARE_STEP.done,
    roots: moveTree(record.roots, back),
    buildResult: BUILD_RESULT.rescueFailed,
    buildOutput: null,
    buildMatch: null,
  });
  removeRescue(work);
  return { next: "review", work, record: failed };
}

/**
 * Remove what a failed rescue leaves: the rescued copy and the build copy it was built in.
 * @param {string} work
 * @returns {void}
 */
function removeRescue(work) {
  const { rescued, buildCopy } = workPaths(work);
  fs.rmSync(rescued, { recursive: true, force: true });
  fs.rmSync(buildCopy, { recursive: true, force: true });
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
 * failed, or was cut short: its review is started once more. A copy its roots do not lie in is
 * no longer read - a failed rescue cut short before it was removed - and its removal is
 * finished first, the build copy of a failed rescue with it.
 * And the review file the review claims is deleted again, in case the run that marked the
 * folder was cut short before it could.
 * @param {string} work
 * @param {import("./state.js").PrepareRecord} record
 * @returns {Handout}
 */
function doneAgain(work, record) {
  if (record.buildResult === BUILD_RESULT.rescueFailed) {
    removeRescue(work);
  } else if (record.roots.used !== realFolder(workPaths(work).rescued)) {
    fs.rmSync(workPaths(work).rescued, { recursive: true, force: true });
  }
  return { next: "review", work, record: markPrepare(work, record) };
}
