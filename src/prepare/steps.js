// The STEPS of the preparation of a source code review: what one hand-back of a work folder
// does to it, and which prompt comes next.
//
// The run that creates the work folder has the source extracted into its `sca/`, its build
// reported in build.md, and the roots its reader works out handed back in the review file
// (`extract`), beside the reader's judgement whether the build is safe. That hand-back
// settles the roots as the review settles them (src/addon/sca-root.js). An unsafe build is
// done at once: the agent builds nothing, and runs no package-manager command. A safe one
// moves on to `permission`, which shows the reviewer the Build Review Details and asks them
// alone whether the agent may build the add-on, its package-manager commands included
// (pre-answered "yes" where the record holds agentBuilds, which skips that step). Where the reviewer
// declined, the folder is done at once: a rescue runs package-manager commands, so none is
// tried. Otherwise it audits the root's lock (./audit.js). A root the audit cannot read in
// full is done: nothing is built, and the review it starts stops on that lock. A clean lock
// moves on to `build`: the linter copies the whole `sca/` into `build/`, and the agent builds
// the original there, as the lock pins it, and names what the build produced, or that it
// failed. A vulnerable lock gets a RESCUED COPY of the whole `sca/` in the same work folder
// (`rescued/`), and moves on to `rescue`: the agent reduces or fixes the copy's dependencies
// with lock-only commands and audits them until no high or critical advisory remains. Only
// then it builds, in a fresh copy of the whole `rescued/` in `build/`, so nothing is ever
// installed or built in the rescued copy. It names what the build produced, or that the rescue
// failed. The linter audits the copy again and checks the output it names. Where both hold, the
// copy is reviewed instead of the original. Otherwise the copy and `build/` are deleted, and
// the original is done: it is reviewed like any other source, and its vulnerability checks
// stop it.
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
import { settleScaRoot } from "../addon/sca-root.js";
import { loadRegistry } from "../checks/registry.js";
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

/** The review file's entries for the roots, keyed by the names the prompt gives them. */
const ROOT = "SCA_ROOT";
const EXP_SOURCE = "SCA_EXP_SOURCE";
/** The review file's entry for the reviewer's answer whether the agent may build the add-on,
 *  its package-manager commands included, as `llm-sca-review-prompt` names it. */
const PACKAGE_MANAGERS = "PACKAGE_MANAGERS";
/** The review file's entry for the reader's judgement of the build, as
 *  `llm-sca-review-prompt` names it. */
const BUILD_SAFETY = "BUILD_SAFETY";
/** The review file's entry for what the agent's build produced, as `llm-sca-review-prompt`
 *  names it: in `build/` after a build and after a rescue. */
const BUILD_OUTPUT = "BUILD_OUTPUT";
/** The review file's entry for the agent's comparison of that output with the submitted XPI,
 *  as `llm-sca-review-prompt` names it: answered only where the build produced an output. */
const BUILD_MATCH = "BUILD_MATCH";
/** Whether the hot runs switched the agent's builds on (WEBEXT_LINTER_AGENT_BUILDS=1): their
 *  stand-in for the reviewer's "Let it build", which nothing documents. Read once: no setter,
 *  nothing to undo. */
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
 * The registry's permission question, as llmScaReviewPrompt gives it.
 * @typedef {ScaPrompt["packageManagers"]} PackageManagersAsk
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
 * Start the preparation in a work folder just created for it: its record, at `extract`, and
 * the review file its reader hands the build judgement and the roots back in.
 * @param {string} work  The work folder, absolute and real.
 * @param {import("./state.js").PrepareRecord} record  From startRecord.
 * @param {import("../checks/registry.js").Registry} [registry]  The authored registry,
 *   loaded here when the caller has none.
 * @returns {void}
 */
export function startPreparation(work, record, registry = loadRegistry()) {
  writePrepare(work, record);
  writeReviewFile(
    workPaths(work).review,
    reviewFile([
      safetyEntry(registry.llmScaReviewPrompt().buildSafety),
      ...rootEntries(record),
    ])
  );
}

/**
 * The entries the first step asks for: the root, and the Experiment folder where the built
 * add-on declares Experiments.
 * @param {import("./state.js").PrepareRecord} record
 * @returns {object[]}
 */
function rootEntries(record) {
  return [ROOT, ...(record.submission.experiments ? [EXP_SOURCE] : [])].map(
    (index) => ({ index, [SLOT]: null })
  );
}

/**
 * The entry the reader judges the build in, built as a process value's entry is.
 * @param {ScaPrompt["buildSafety"]} judgement
 * @returns {object}
 */
function safetyEntry(judgement) {
  return valueEntry({ name: BUILD_SAFETY, values: judgement.values }, null);
}

/**
 * The entry the reviewer answers whether the agent may build the add-on in, built as a
 * process value's entry is.
 * @param {PackageManagersAsk} question
 * @returns {object}
 */
function managersEntry(question) {
  return valueEntry(
    { name: PACKAGE_MANAGERS, values: question.values },
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
    name: BUILD_OUTPUT,
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
    { name: BUILD_MATCH, values: question.values },
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
 * file holds no BUILD_OUTPUT entry: the file an earlier step left, by a run cut short before
 * it wrote the question, which is then handed out again.
 *
 * BUILD_OUTPUT is checked as an output phase takes it. BUILD_MATCH belongs to an output only:
 * beside the `failed` label it must stay null, and beside a path it must be one of the
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
  if (!entries.some((e) => keyOf(e) === BUILD_OUTPUT)) {
    return undefined;
  }
  const phase = outputPhase(asked);
  const answer = answersOf(
    entries.filter((e) => keyOf(e) !== BUILD_MATCH),
    [outputEntry(phase)],
    phase,
    keyOf
  ).get(BUILD_OUTPUT);
  const compared = entries.filter((e) => keyOf(e) === BUILD_MATCH);
  if (answer === phase.failed.label) {
    if (compared.length !== 1) {
      throw new HandbackRefused(
        `${BUILD_MATCH} ${compared.length ? "appears twice" : "is missing from the file"}`
      );
    }
    if (compared[0][SLOT] !== null && compared[0][SLOT] !== undefined) {
      throw new HandbackRefused(
        `${BUILD_MATCH} answers "${displayLine(String(compared[0][SLOT]))}", but ` +
          `${BUILD_OUTPUT} answers "${phase.failed.label}": leave its "${SLOT}" null`
      );
    }
    return { answer, match: null };
  }
  const picked = answersOf(
    compared,
    [matchEntry(match)],
    { name: phase.name, answer: "value" },
    keyOf
  ).get(BUILD_MATCH);
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
    case PREPARE_STEP.extract:
      return extract(work, record, context, prompt);
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
 * The first step: the roots the reader handed back, settled, with the build judgement and
 * the build report it rests on. An unsafe build is done at once, with no package-manager
 * command allowed. A safe one moves on to the permission question, or, where
 * the record holds agentBuilds, straight to the audit.
 * @param {string} work
 * @param {import("./state.js").PrepareRecord} record
 * @param {AuditContext} context
 * @param {ScaPrompt} prompt
 * @returns {Promise<Handout>}
 */
async function extract(work, record, context, prompt) {
  const { roots, buildSafety } = answeredRoots(
    work,
    record,
    prompt.buildSafety
  );
  const build = workPaths(work).build;
  if (!productWritten(build)) {
    throw new HandbackRefused(
      `"${build}" holds no build report: write it there, as the prompt says`
    );
  }
  const settled = { ...record, buildSafety, roots };
  if (buildSafety !== "safe") {
    return done(work, { ...settled, packageManagers: false });
  }
  if (record.agentBuilds) {
    return permitted(
      work,
      { ...settled, packageManagers: true },
      context,
      prompt
    );
  }
  return ask(work, { ...settled, step: PREPARE_STEP.permission }, [
    managersEntry(prompt.packageManagers),
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
 * The permission step, handed back: the reviewer's answer read, and the folder done where
 * they did not let the agent build, or its lock audited where they did.
 * @param {string} work
 * @param {import("./state.js").PrepareRecord} record
 * @param {AuditContext} context
 * @param {ScaPrompt} prompt
 * @returns {Promise<Handout>}
 */
async function permission(work, record, context, prompt) {
  const entry = managersEntry(prompt.packageManagers);
  const picked = answerOf(work, entry, { name: "permission", answer: "value" });
  if (picked === undefined) {
    return ask(work, record, [entry]);
  }
  const allowed =
    prompt.packageManagers.values.find((v) => v.label === picked).value ===
    "allow";
  return permitted(
    work,
    { ...record, packageManagers: allowed },
    context,
    prompt
  );
}

/**
 * What follows the permission: where the agent may not build, the folder done at once,
 * since a rescue would run package-manager commands. Otherwise the root's lock audited, and
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
 * The roots the reader handed back in the review file, held to the folder the source was
 * extracted into and settled as the review settles them, and the reader's judgement of the
 * build, which must be one of the labels its entry offered. Every way they can be wrong is refused, with nothing changed, so the reader can
 * correct the file and hand it back again.
 *
 * Both are taken as the folders they really are, links followed, and asked of that target:
 * the root must lie inside `sca/`, which is what this preparation audits and copies, and
 * the Experiment folder inside the root, resolved against it as the review resolves it.
 * @param {string} work
 * @param {import("./state.js").PrepareRecord} record
 * @param {ScaPrompt["buildSafety"]} judgement
 * @returns {{roots: {scaRoot: string, scaExpSource: ?string}, buildSafety: string}}
 * @throws {HandbackRefused}
 */
function answeredRoots(work, record, judgement) {
  const paths = workPaths(work);
  const asked = rootEntries(record);
  const keyOf = (e) => String(e?.index);
  const all = readHandback(paths.review).entries;
  // Every entry but the judgement names a folder.
  const handed = all.filter((e) => keyOf(e) !== BUILD_SAFETY);
  // A blank answer names no folder, and would otherwise resolve to the folder it is
  // resolved against.
  for (const entry of handed) {
    const answer = entry?.[SLOT];
    if (typeof answer === "string" && !answer.trim()) {
      throw new HandbackRefused(
        `${displayLine(String(entry.index))} names no folder`
      );
    }
  }
  const answers = answersOf(
    handed,
    asked,
    { name: "extract", answer: "words" },
    keyOf
  );
  // The judgement is a process value, checked against the labels its entry offered.
  const picked = answersOf(
    all.filter((e) => keyOf(e) === BUILD_SAFETY),
    [safetyEntry(judgement)],
    { name: "extract", answer: "value" },
    keyOf
  ).get(BUILD_SAFETY);
  const sca = realSca(paths);
  const root = realFolder(path.resolve(sca, answers.get(ROOT).trim()));
  if (!root || relativeInside(root, sca) === null) {
    throw new HandbackRefused(
      `${ROOT} "${displayLine(answers.get(ROOT))}" is not a folder inside "${sca}"`
    );
  }
  let exp = null;
  if (record.submission.experiments) {
    exp = realFolder(path.resolve(root, answers.get(EXP_SOURCE).trim()));
    if (!exp || relativeInside(exp, root) === null) {
      throw new HandbackRefused(
        `${EXP_SOURCE} "${displayLine(answers.get(EXP_SOURCE))}" is not a folder inside ` +
          `"${root}"`
      );
    }
  }
  let settled;
  try {
    settled = settleScaRoot({ scaRoot: root, scaExpSource: exp ?? undefined });
  } catch (err) {
    rethrowIfFatal(err);
    throw new HandbackRefused(err.message);
  }
  return {
    roots: {
      scaRoot: settled.scaRoot,
      scaExpSource: settled.scaExpSource ?? null,
    },
    buildSafety: judgement.values.find((v) => v.label === picked).value,
  };
}

/**
 * The roots a review is started with, asked again of the folder it starts in: the agent
 * works there between the step that settled them and the start, and can swap a folder for
 * a link. So each is followed to the folder it really is, and must still be one where the
 * preparation put it - the root inside `sca/`, or inside `rescued/` for a rescued copy, and
 * the Experiment folder inside the root.
 * @param {string} work  The work folder the review starts in.
 * @param {{scaRoot: string, scaExpSource: ?string}} roots  As the record holds them.
 * @returns {{scaRoot: string, scaExpSource: ?string}}  The real folders, which the review
 *   reads.
 * @throws {HandbackRefused}
 */
export function recordedRoots(work, roots) {
  const sca = realSca(workPaths(work));
  const root = realFolder(roots.scaRoot);
  if (!root || !(relativeInside(root, sca) !== null || inCopy(work, root))) {
    throw new HandbackRefused(
      `the preparation's record names a source root "${displayLine(roots.scaRoot)}" ` +
        `that is not a folder inside "${sca}" or its rescued copy`
    );
  }
  if (typeof roots.scaExpSource !== "string") {
    return { scaRoot: root, scaExpSource: null };
  }
  const exp = realFolder(roots.scaExpSource);
  if (!exp || relativeInside(exp, root) === null) {
    throw new HandbackRefused(
      "the preparation's record names an Experiment folder " +
        `"${displayLine(roots.scaExpSource)}" that is not a folder inside "${root}"`
    );
  }
  return { scaRoot: root, scaExpSource: exp };
}

/**
 * Whether `root` lies in the work folder's rescued copy - which is how a record says its
 * review reads the copy: a rescue that came out clean leaves its roots there, and every other
 * record names `sca/`.
 * @param {string} work
 * @param {?string} root
 * @returns {boolean}
 */
function inCopy(work, root) {
  const copy = realFolder(workPaths(work).rescued);
  const real = root ? realFolder(root) : null;
  return copy !== null && real !== null && relativeInside(real, copy) !== null;
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
  const into = (p) => (p ? path.join(to, path.relative(real, p)) : p);
  wholeCopy(from, to, "rescued copy");
  return ask(
    work,
    {
      ...record,
      step: PREPARE_STEP.rescue,
      roots: {
        scaRoot: fs.realpathSync(into(record.roots.scaRoot)),
        scaExpSource: record.roots.scaExpSource
          ? fs.realpathSync(into(record.roots.scaExpSource))
          : null,
      },
    },
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
        "Hand the work folder back once that is fixed."
    );
  }
}

/**
 * The rescue, handed back: done with the copy as the reviewed source where the output the
 * agent named lies inside `build/` and the copy's lock audits clean, its counts and the
 * agent's comparison recorded. Otherwise, or where the agent answered that the rescue failed,
 * the rescue failed: the folder is done with its roots back in `sca/`, before the copy and
 * `build/` are removed.
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
  if (output) {
    const found = await auditRoot(record.roots, context);
    if (isClean(found)) {
      return done(work, {
        ...record,
        vulnerabilities: vulnerabilityCounts(found),
        buildResult: BUILD_RESULT.built,
        buildOutput: output,
        buildMatch: answers.match,
      });
    }
  }
  const real = fs.realpathSync(rescued);
  const back = (p) =>
    p ? path.join(fs.realpathSync(sca), path.relative(real, p)) : p;
  const failed = markPrepare(work, {
    ...record,
    step: PREPARE_STEP.done,
    roots: {
      scaRoot: back(record.roots.scaRoot),
      scaExpSource: back(record.roots.scaExpSource),
    },
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
  } else if (!inCopy(work, record.roots?.scaRoot)) {
    fs.rmSync(workPaths(work).rescued, { recursive: true, force: true });
  }
  return { next: "review", work, record: markPrepare(work, record) };
}
