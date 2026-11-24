// The STEPS of the build check of a source code review: what one hand-back of a work folder
// in mode `build-check` does to it, and which prompt comes next.
//
// Every build check starts at `analyze`, once the source is in the work folder's `sca/` - the
// linter's copy of --sca-extracted, or the source archive the linter extracted there itself
// (--llm-auto-review, src/addon/source-archive.js) - and the early-exit checks passed on it.
// There the reader reports the build in build.md and hands back the issues the verdict is read
// off. Where a check the build relies on is switched off (`build-guard`), the folder is done at
// once: nobody is asked, and the agent builds nothing and runs no package-manager command.
// Otherwise it audits the package root's lock (./audit.js), before anyone is asked. A lock the
// audit cannot read in full is done at once: nothing is asked or built, and the review it
// starts aborts on that lock. So is a lock with a declared dependency nobody can review: the
// review aborts on that dependency, and nothing is built that runs it. Otherwise an unsafe
// verdict moves on to `override-unsafe`, which shows the reviewer the Build Review Details and
// asks them alone whether to skip the build, which is done at once, or to override the verdict
// and go on as if the build were safe. A safe verdict, or an overridden one, moves on to
// `decision`, which shows the Build Review Details where `override-unsafe` did not and asks
// them alone for the one decision about the build: let the agent build or build it themselves,
// or hold it unsafe for reasons of their own. Unless they let the agent build, the folder is
// done at once: a rescue runs package-manager commands, so none is tried. Otherwise the audit
// decides. A clean lock moves on to `build`: the linter copies the whole `sca/` into `build/`,
// and the agent builds the original there, as the lock pins it, and names what the build
// produced, or that it failed. A vulnerable lock gets a RESCUED COPY of the whole `sca/` in the
// same work folder (`rescued/`), and moves on to `rescue`: the agent reduces or fixes the
// copy's dependencies with lock-only commands and audits them until no high or critical
// advisory remains. Only then it builds, in a fresh copy of the whole `rescued/` in `build/`,
// so nothing is ever installed or built in the rescued copy. It names what the build produced,
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
import os from "node:os";
import path from "node:path";

import {
  BUILD_CHECK_STEP,
  BUILD_RESULT,
  buildRootOf,
  markDone,
} from "./state.js";
import {
  auditRoot,
  countsVulnerable,
  isClean,
  isRescuable,
  vulnerabilityCounts,
} from "./audit.js";
import { checkSelected } from "../checks/registry.js";
import { holds } from "../checks/condition.js";
import { loadAddon } from "../addon/load.js";
import { ARTIFACT_XPI } from "../lib/artifacts.js";
import { splitList } from "../lib/util.js";
import {
  misplacedFolders,
  misplacedFoldersError,
  runCache,
  workPaths,
} from "../util/dest.js";
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
import { resultShape } from "../config.js";

/** The answers file's entry for the Experiment folder, keyed by the name the prompt gives it. */
const EXPERIMENTS = "SCA_EXPERIMENTS";
/** The review file's entry for the reviewer's build decision, as `llm-sca-review-prompt`
 *  names it. */
const SCA_BUILD_DECISION = "SCA_BUILD_DECISION";
/** The review file's entry for whether the reviewer overrides an unsafe verdict, as
 *  `llm-sca-review-prompt` names it. */
const SCA_BUILD_OVERRIDE = "SCA_BUILD_OVERRIDE";
/** The review file's entry for what the build reaches for outside the declared dependencies,
 *  as `llm-sca-review-prompt` names it: the list the verdict is read off. */
const SCA_BUILD_SAFETY_ISSUES = "SCA_BUILD_SAFETY_ISSUES";
/** The review file's entry for what the agent's build produced, as `llm-sca-review-prompt`
 *  names it: in `build/` after a build and after a rescue. */
const LLM_BUILD_OUTPUT = "LLM_BUILD_OUTPUT";
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
 * A question the build check puts to the reviewer, as llmScaReviewPrompt gives it: the build
 * decision, or the override of an unsafe verdict.
 * @typedef {ScaPrompt["buildDecision"]} BuildValueAsk
 */

/**
 * The registry's question for a build's output, as llmScaReviewPrompt gives it: the build's
 * or the rescue's.
 * @typedef {ScaPrompt["buildOutput"]} OutputAsk
 */

/**
 * The context an audit is asked in (./audit.js auditRoot).
 * @typedef {{net?: import("../vendor/verify.js").VendorNet, cacheDir?: string}}
 *   AuditContext
 */

/**
 * Whether `experiment-folder` asks for the Experiment folder: the built add-on declares
 * Experiments, as the load read it. It is asked there, beside the extracted archive, so the
 * package root is settled with it known. A review given --sca-extracted was given it
 * (--sca-experiments).
 * @param {object} record  The record, in any mode.
 * @returns {boolean}
 */
export function asksExperiments(record) {
  return (
    modeOf(record) === MODE.experimentFolder && record.submission.experiments
  );
}

/**
 * The entries `experiment-folder` asks for: the Experiment folder where it is asked
 * (asksExperiments), else none.
 * @param {object} record  In mode experiment-folder.
 * @returns {object[]}
 */
export function experimentFolderEntries(record) {
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
 * The answers a build check question (the override, the decision) offers for this build:
 * those whose `when:` holds over the audit at `analyze` (`build-vulnerable`, a high or
 * critical advisory in the lock), and those with none. The one list both what is offered and
 * what is accepted back are read from.
 * @param {BuildValueAsk} question
 * @param {object} record  Audited at `analyze`.
 * @returns {{value: string, label: string, description: string}[]}
 */
function offeredValues(question, record) {
  const facts = new Set(
    countsVulnerable(record.current.vulnerabilities) ? ["build-vulnerable"] : []
  );
  return question.values.filter((v) => v.when === null || holds(v.when, facts));
}

/**
 * The entry the reviewer makes their build decision in, about a build held safe, built as a
 * process value's entry is, with the answers this build is offered (offeredValues). It is
 * answered with one of its labels or the reviewer's own words (decision).
 * @param {BuildValueAsk} question
 * @param {object} record  Audited at `analyze`.
 * @returns {object}
 */
function decisionEntry(question, record) {
  return valueEntry(
    { name: SCA_BUILD_DECISION, values: offeredValues(question, record) },
    question.question
  );
}

/**
 * The entry the reviewer overrides an unsafe verdict in, or does not, built as a process
 * value's entry is, with the answers this build is offered (offeredValues). It is answered
 * with one of its labels and nothing else (overrideUnsafe).
 * @param {BuildValueAsk} question
 * @param {object} record  Audited at `analyze`.
 * @returns {object}
 */
function overrideEntry(question, record) {
  return valueEntry(
    { name: SCA_BUILD_OVERRIDE, values: offeredValues(question, record) },
    question.question
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
 * The one entry the build and rescue prompts hand out: where the build put its output. How
 * that output compares with the submitted XPI is the linter's to say (xpiMatch).
 * @param {OutputAsk} asked
 * @returns {object[]}
 */
function buildEntries(asked) {
  return [outputEntry(outputPhase(asked))];
}

/**
 * The build or rescue step's answer, read from the review file and checked as an output phase
 * takes it, or undefined where the file holds no LLM_BUILD_OUTPUT entry: the file an earlier
 * step left, by a run cut short before it wrote the question, which is then handed out again.
 * @param {string} work
 * @param {OutputAsk} asked
 * @returns {string|undefined}
 * @throws {HandbackRefused}
 */
function builtAnswer(work, asked) {
  const phase = outputPhase(asked);
  return answerOf(work, outputEntry(phase), phase);
}

/**
 * Whether what the build produced is the submitted XPI: the same files at the same paths, each
 * with the same contents, where only line endings may differ. The linter's own comparison,
 * never the agent's: a build that matches is the evidence that the shipped XPI comes from the
 * source the review reads.
 *
 * Both sides are read by the loader the review reads an XPI with (loadAddon), so a packed
 * output is held to the same limits as the submitted XPI: one it refuses, too large or
 * holding a link, is no match. A packed output is extracted into a temporary folder of its
 * own, removed again afterwards. The submitted XPI is the work folder's extracted copy, read
 * where it is.
 * @param {string} output  What the build produced, a file or folder (outputAt).
 * @param {string} xpiRoot  The work folder's extracted XPI.
 * @returns {string}  A BUILD_MATCH_VALUES id.
 */
export function xpiMatch(output, xpiRoot) {
  const packed = fs.statSync(output).isFile();
  const scratch = packed
    ? fs.mkdtempSync(path.join(os.tmpdir(), "webext-linter-build-"))
    : null;
  try {
    let built;
    try {
      built = loadAddon(output, scratch ? path.join(scratch, "x") : undefined, {
        kind: ARTIFACT_XPI,
      }).store;
    } catch (err) {
      rethrowIfFatal(err);
      return "no match";
    }
    const submitted = loadAddon(xpiRoot, undefined, {
      kind: ARTIFACT_XPI,
    }).store;
    return sameFiles(built, submitted) ? "match" : "no match";
  } finally {
    if (scratch) {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/**
 * Whether two loaded file stores hold the same files, each with the same contents once every
 * carriage return before a line feed is dropped.
 * @param {Map<string, Buffer>} a
 * @param {Map<string, Buffer>} b
 * @returns {boolean}
 */
function sameFiles(a, b) {
  if (a.size !== b.size) {
    return false;
  }
  for (const [key, bytes] of a) {
    const other = b.get(key);
    if (!other || !lfOnly(bytes).equals(lfOnly(other))) {
      return false;
    }
  }
  return true;
}

/**
 * The bytes with every carriage return that stands before a line feed dropped.
 * @param {Buffer} bytes
 * @returns {Buffer}
 */
function lfOnly(bytes) {
  const out = Buffer.allocUnsafe(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) {
      continue;
    }
    out[n++] = bytes[i];
  }
  return out.subarray(0, n);
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
    case BUILD_CHECK_STEP.overrideUnsafe:
      return overrideUnsafe(work, record, prompt);
    case BUILD_CHECK_STEP.decision:
      return decision(work, record, prompt);
    case BUILD_CHECK_STEP.build:
      return builtOriginal(work, record, prompt.buildOutput);
    case BUILD_CHECK_STEP.rescue:
      return rescueStep(work, record, context, prompt.rescueOutput);
    default:
      return doneAgain(work, record);
  }
}

/**
 * The Experiment folder `experiment-folder` handed back where it asked for one, as the agent
 * wrote it, else undefined. It names the folder as an absolute path inside EXTRACT_TO, which
 * the hand-back approves with the sca folders (src/addon/package-root.js approveScaFolders). A
 * blank answer or a relative one names no folder there, and is refused.
 * @param {string} work
 * @param {object} record  In mode experiment-folder.
 * @returns {string|undefined}
 * @throws {HandbackRefused}
 */
export function namedExperimentFolder(work, record) {
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
    { name: "experiment-folder", answer: "words" },
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
 * Otherwise the package root's lock is audited and its counts recorded, before anyone is
 * asked. A lock the audit cannot read in full, or one with a declared dependency nobody can
 * review, is done at once too, with nothing asked and nothing built. Otherwise, after either
 * verdict, it moves on to the reviewer's questions.
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
  const found = await auditRoot(settled.current.roots, context);
  const audited = movedOn(settled, {
    vulnerabilities: found.complete ? vulnerabilityCounts(found) : null,
  });
  if (!isClean(found) && !isRescuable(found)) {
    return done(work, movedOn(audited, { packageManagers: false }));
  }
  if (buildSafety === "unsafe") {
    return ask(movedOn(audited, { step: BUILD_CHECK_STEP.overrideUnsafe }), [
      overrideEntry(prompt.buildOverride, audited),
    ]);
  }
  return ask(movedOn(audited, { step: BUILD_CHECK_STEP.decision }), [
    decisionEntry(prompt.buildDecision, audited),
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
 * The override-unsafe step, handed back: whether the reviewer overrides the unsafe verdict,
 * one of the two labels its question offers and nothing else (answersOf, as a value).
 * Skipping holds the build unsafe and builds nothing, as their own words at the decision do.
 * Continuing moves the record on to the decision, as if the build were safe, with nothing
 * else recorded: an unsafe verdict at the decision is an overridden one.
 * @param {string} work
 * @param {object} record  At `override-unsafe`.
 * @param {ScaPrompt} prompt
 * @returns {Handout}
 * @throws {HandbackRefused}
 */
function overrideUnsafe(work, record, prompt) {
  const entry = overrideEntry(prompt.buildOverride, record);
  const answer = answerOf(work, entry, {
    name: "override-unsafe",
    answer: "value",
  });
  if (answer === undefined) {
    return ask(record, [entry]);
  }
  const picked = prompt.buildOverride.values.find((v) => v.label === answer);
  if (picked.value === "skip") {
    return decided(work, record, "skip", null, prompt);
  }
  const moved = movedOn(record, { step: BUILD_CHECK_STEP.decision });
  return ask(moved, [decisionEntry(prompt.buildDecision, moved)]);
}

/**
 * The decision step, handed back: the reviewer's build decision read, one of the labels its
 * question offers this build (offeredValues), or their own words, which hold the build unsafe
 * for the reasons they give, held to the rule a reviewer's note is (checkedNote). The label of
 * an answer this build is not offered, a rescue of a clean lock or a plain build of a
 * vulnerable one, is refused rather than read as words of their own.
 * @param {string} work
 * @param {object} record
 * @param {ScaPrompt} prompt
 * @returns {Handout}
 * @throws {HandbackRefused}
 */
function decision(work, record, prompt) {
  const entry = decisionEntry(prompt.buildDecision, record);
  const answer = answerOf(work, entry, { name: "decision", answer: "words" });
  if (answer === undefined) {
    return ask(record, [entry]);
  }
  const offered = offeredValues(prompt.buildDecision, record);
  const picked = pickedChoice(answer, offered);
  if (picked) {
    return decided(work, record, picked.value, null, prompt);
  }
  const withheld = pickedChoice(
    answer,
    prompt.buildDecision.values.filter((v) => !offered.includes(v))
  );
  if (withheld) {
    throw new HandbackRefused(
      `${SCA_BUILD_DECISION} answers "${withheld.label}", which this build is not offered ` +
        `(expected one of: ${offered.map((v) => v.label).join(", ")}, or words of the ` +
        "reviewer's own)"
    );
  }
  const { note, problem } = checkedNote(answer);
  if (problem) {
    throw new HandbackRefused(`${SCA_BUILD_DECISION} ${problem}`);
  }
  return decided(work, record, null, note, prompt);
}

/**
 * The reviewer's build decision, recorded: whether the build is safe, and whether the agent
 * builds it (`allow` and `rescue`), which `permitted` goes on from: the audit routes a clean
 * lock to the build and a vulnerable one to the rescue. `manual` holds the build safe and
 * leaves it to the reviewer. `skip-vulnerable` holds it safe and lets nobody build it
 * (`vulnerableBuildSkipped`), since the lock's vulnerabilities end the review whatever a
 * build gives. `skip` is the override-unsafe step's, which holds the
 * build unsafe. Their own words are no id, and hold the build unsafe for those reasons.
 * @param {string} work
 * @param {object} record  Audited at `analyze`.
 * @param {?string} id  A BUILD_DECISION_VALUES id, `skip`, or null for the reviewer's own
 *   words.
 * @param {?string} reasons  Those words, where they gave them.
 * @param {ScaPrompt} prompt
 * @returns {Handout}
 */
function decided(work, record, id, reasons, prompt) {
  return permitted(
    work,
    movedOn(record, {
      packageManagers: id === "allow" || id === "rescue",
      buildSafe: ["allow", "rescue", "manual", "skip-vulnerable"].includes(id),
      buildReasons: reasons,
      vulnerableBuildSkipped: id === "skip-vulnerable",
    }),
    prompt
  );
}

/**
 * What follows the decision: where the agent may not build, the folder done at once, since a
 * rescue would run package-manager commands. Otherwise the audit at `analyze` decides, which
 * only a lock it read in full, with every declared dependency reviewable, gets past: a clean
 * lock is copied whole into `build/` and handed to the agent to build there, and a vulnerable
 * one is rescued.
 * @param {string} work
 * @param {object} record  With the reviewer's decision.
 * @param {ScaPrompt} prompt
 * @returns {Handout}
 */
function permitted(work, record, prompt) {
  if (!record.current.packageManagers) {
    return done(work, record);
  }
  if (countsVulnerable(record.current.vulnerabilities)) {
    return rescue(work, record, prompt.rescueOutput);
  }
  const { sca, buildCopy } = workPaths(work);
  wholeCopy(sca, buildCopy, "build copy");
  return ask(
    movedOn(record, { step: BUILD_CHECK_STEP.build }),
    buildEntries(prompt.buildOutput)
  );
}

/**
 * The build step, handed back: what the agent's build of the clean original produced, held
 * to `build/`, and the linter's comparison of it with the submitted XPI, or that it failed.
 * Either way the folder is done. A path that names nothing the build produced there is
 * refused, with nothing changed.
 * @param {string} work
 * @param {object} record  At `build`.
 * @param {OutputAsk} asked
 * @returns {Handout}
 * @throws {HandbackRefused}
 */
function builtOriginal(work, record, asked) {
  const answer = builtAnswer(work, asked);
  if (answer === undefined) {
    return ask(record, buildEntries(asked));
  }
  const paths = workPaths(work);
  const output = outputAt(answer, outputPhase(asked), paths.buildCopy);
  return done(
    work,
    movedOn(record, {
      buildResult: output ? BUILD_RESULT.built : BUILD_RESULT.failed,
      buildOutput: output,
      buildMatch: output ? xpiMatch(output, paths.xpi) : null,
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
    buildIssues: buildIssuesOf(list, realSca(work)),
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
        `${at} has no "hint" - say what the build does there, e.g. ${resultShape(root)}`
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
 * The folder the linter extracted the source into, real: it must still be a folder itself,
 * not a link to one, since everything inside it is taken as the submission's source. Asked
 * before the source review starts, at once or at `experiment-folder`, and found as it was by
 * every later step, whose hand-back checked it first (src/review/record.js namedFolders).
 * The linter made it, so one that is gone or replaced is no answer to correct: the review
 * cannot be carried on (misplacedFoldersError).
 * @param {string} work  The work folder, absolute.
 * @returns {string}
 * @throws {Error}  The failure, naming what happened to sca/.
 */
export function realSca(work) {
  const sca = workPaths(work).sca;
  const misplaced = misplacedFolders([sca]);
  if (misplaced.length) {
    throw misplacedFoldersError(work, misplaced);
  }
  return fs.realpathSync(sca);
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
 * @returns {Handout}
 * @throws {Error}  The copy could not be made.
 */
function rescue(work, record, asked) {
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
    buildEntries(asked)
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
 * `build/`, the copy's lock audits clean, and the linter's comparison of the output with the
 * submitted XPI matches: only then did none of the vulnerable code ship. An output and a clean
 * copy without a match is `rescue-mismatch`, the vulnerable code possibly shipped. Without an
 * output or a clean copy, or where the agent answered that the rescue failed, the rescue
 * failed. Either way the folder is done with its roots back in `sca/`, before `build/` is
 * removed, the copy left as the agent left it, and the source as submitted is reviewed.
 * @param {string} work
 * @param {object} record  At `rescue`.
 * @param {AuditContext} context
 * @param {OutputAsk} asked
 * @returns {Promise<Handout>}
 * @throws {HandbackRefused}  An answer that is no path and no label.
 */
async function rescueStep(work, record, context, asked) {
  const phase = outputPhase(asked);
  const answer = builtAnswer(work, asked);
  if (answer === undefined) {
    return ask(record, buildEntries(asked));
  }
  const { sca, rescued, buildCopy, xpi } = workPaths(work);
  const output = producedIn(answer, phase, buildCopy);
  const found = await auditRoot(record.current.roots, context);
  const rescuedVulnerabilities = found.complete
    ? vulnerabilityCounts(found)
    : null;
  const built = output && isClean(found);
  if (built && xpiMatch(output, xpi) === "match") {
    return done(
      work,
      movedOn(record, {
        rescuedVulnerabilities,
        buildResult: BUILD_RESULT.built,
        buildOutput: output,
        buildMatch: "match",
      })
    );
  }
  const real = fs.realpathSync(rescued);
  const back = (p) => path.join(fs.realpathSync(sca), path.relative(real, p));
  const dropped = markDone(
    work,
    movedOn(record, {
      rescuedVulnerabilities,
      step: BUILD_CHECK_STEP.done,
      roots: moveTree(record.current.roots, back),
      buildResult: built
        ? BUILD_RESULT.rescueMismatch
        : BUILD_RESULT.rescueFailed,
      buildOutput: null,
      buildMatch: null,
    })
  );
  removeBuild(work);
  return { next: "review", record: dropped };
}

/**
 * Remove the build copy a rescue that failed or did not reproduce the XPI built in.
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
 * failed, or was cut short: its review is started once more. A rescue that failed or did not
 * reproduce the XPI, cut short, has its build copy removed first.
 * And the build check's answers file, which no prompt names any more, is deleted again, in
 * case the run that marked the folder was cut short before it could.
 * @param {string} work
 * @param {object} record
 * @returns {Handout}
 */
function doneAgain(work, record) {
  if (
    record.current.buildResult === BUILD_RESULT.rescueFailed ||
    record.current.buildResult === BUILD_RESULT.rescueMismatch
  ) {
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
 * The prompt a record in mode experiment-folder or build-check is waiting on, its step's own
 * (`llm-sca-review-prompt`): printed by the run that starts the mode (`first`, with the intro,
 * on the review's first prompt) and by every hand-back that moves it on. What each prompt names
 * beside its steps follows its step: the submission and where it was extracted
 * (`experiment-folder`), the source, its package root and the build report (`analyze`), the
 * Build Review Details (`decision`), and the folders a build runs in. Every build runs at the
 * package root's place in `build/`, the linter compares its output with the submitted XPI, and
 * the rescue's agent makes `build/` a copy of the whole `rescued/` before each build, with the
 * two commands named here.
 * @param {string} work
 * @param {object} record  At the step its prompt is for.
 * @param {import("../checks/registry.js").Registry} registry
 * @param {{first?: boolean, submission?: {folder: string, xpi: string, source: string}}}
 *   [start]  On the run that starts the mode: the intro where it is the review's first
 *   prompt, and for `experiment-folder` the submission (scaSubmission).
 * @returns {string[]}
 */
export function stepPromptLines(work, record, registry, start = {}) {
  const prompt = registry.llmScaReviewPrompt();
  const paths = workPaths(work);
  const roots = record.current?.roots;
  const buildRoot = () => buildRootOf(work, roots);
  const named = {
    "experiment-folder": () => ({
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
    [BUILD_CHECK_STEP.overrideUnsafe]: () => ({
      answers: paths.answers,
      buildDetails: buildDetailLines(work, record, registry),
    }),
    // After an override the reviewer has read the Build Review Details at `override-unsafe`,
    // and its decision prompt does not show them again (`when: NOT build-overridden`).
    [BUILD_CHECK_STEP.decision]: () => ({
      answers: paths.answers,
      buildDetails: buildDetailLines(work, record, registry),
      buildOverridden: record.current.buildSafety === "unsafe",
    }),
    [BUILD_CHECK_STEP.build]: () => ({
      answers: paths.answers,
      scaPackageRoot: roots.packageRoot,
      buildRoot: buildRoot(),
      buildProcess: paths.build,
    }),
    [BUILD_CHECK_STEP.rescue]: () => ({
      answers: paths.answers,
      rescueRoot: roots.packageRoot,
      buildRoot: buildRoot(),
      buildProcess: paths.build,
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
 * The Build Review Details the decision prompt shows: the submitted XPI, the source folders,
 * the build report, the verdict and the issues it was read off, and the lock's counts from the
 * audit at `analyze`, as the review loop's blocks
 * name them (detailRows), so the review's Build Review Details hold every row of it. It ends
 * with the line saying the review waits for the reviewer's reply, as a turn-ending block does.
 * @param {string} work
 * @param {object} record  At `decision`.
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
      buildVulnerabilities: record.current.vulnerabilities,
    }),
    "",
    registry.llmPhases().waiting("decision"),
  ];
}
