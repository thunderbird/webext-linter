// The STEPS of the preparation of a source code review: what one hand-back of a work folder
// does to it, and which prompt comes next.
//
// The run that creates the work folder has the source extracted into its `sca/`, and the
// roots its reader works out handed back in the review file (`extract`). That hand-back
// settles them as the review settles them (src/addon/sca-root.js) and audits the root's lock
// (./audit.js). A root whose lock is clean, or that the audit cannot read in full, is done:
// the review starts there, and decides everything else. A vulnerable lock gets a RESCUED COPY
// of its source in the same work folder (`rescued/`, beside `sca/`), whose dependencies an
// agent reduces to what the release build uses, and then, where that is not enough,
// audit-fixes. The copy is audited after each, and a clean one is reviewed instead of the
// original. A copy still vulnerable after both is deleted, and the original is done, marked
// UNRESCUED: it is reviewed like any other source, and its vulnerability checks stop it.
//
// Nothing the agent did is verified except by that audit. A dependency edit the build
// cannot use fails the build, and one that changed shipped code fails the question whether
// the build reproduces the XPI - both asked by the review itself.
//
// ONE FOLDER. The work folder is the whole run: one record (./state.js), one cache, one
// review. Each step writes the record first and changes the folder after, so a run cut short
// is somewhere the next hand-back goes on from: a copy whose record was never moved on is made
// again, and a give-up whose copy was not yet removed is finished. The one thing this file
// ever removes is `rescued/`, a fixed name inside the work folder, so no record can point a
// delete anywhere else.
//
// Belongs here: one step (handBack), the review file the first step reads its roots from,
// the copy, the records each step writes, and the delete. Does NOT belong here: the command
// line and the printing (-> src/cli.js and src/report/format.js), the audit (-> ./audit.js),
// the record's shape (-> ./state.js), or what each prompt says (-> `llm-sca-review-prompt`
// in assets/registry.yaml).

import fs from "node:fs";
import path from "node:path";

import {
  PREPARE_STEP,
  markPrepare,
  readPrepare,
  writePrepare,
} from "./state.js";
import { auditRoot, isClean, isRescuable } from "./audit.js";
import { settleScaRoot } from "../addon/sca-root.js";
import { relativeInside } from "../addon/load.js";
import { runCache, workPaths } from "../util/dest.js";
import { defaultNet } from "../vendor/verify.js";
import { withOsvCache } from "../vendor/osv-cache.js";
import { rethrowIfFatal } from "../lib/errors.js";
import {
  HandbackRefused,
  SLOT,
  answersOf,
  readHandback,
  reviewFile,
  writeReviewFile,
} from "../report/handback.js";
import { displayLine } from "../util/text.js";

/** The review file's entries for the roots, keyed by the names the prompt gives them. */
const ROOT = "SCA_ROOT";
const EXP_SOURCE = "SCA_EXP_SOURCE";

/**
 * What a hand-back hands out next: the prompt for a rescued copy's step (`step`), or the
 * review (`review`), which the hand-back starts in that folder from that record.
 * @typedef {{next: "step"|"review", work: string,
 *   record: import("./state.js").PrepareRecord}} Handout
 */

/**
 * Start the preparation in a work folder just created for it: its record, at `extract`, and
 * the review file its reader hands the roots back in.
 * @param {string} work  The work folder, absolute and real.
 * @param {import("./state.js").PrepareRecord} record  From startRecord.
 * @returns {void}
 */
export function startPreparation(work, record) {
  writePrepare(work, record);
  writeReviewFile(workPaths(work).review, reviewFile(rootEntries(record)));
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
 * Take the next step of the preparation in `work`, and say what comes next.
 * @param {string} work  The work folder handed back, absolute and real, holding a record.
 * @param {{net?: import("../vendor/verify.js").VendorNet}} [context]  The network the
 *   audit asks; the real one unless a test hands in its own.
 * @returns {Promise<Handout>}
 * @throws {HandbackRefused}
 */
export async function handBack(work, { net } = {}) {
  const record = readPrepare(work);
  if (!record) {
    throw new HandbackRefused(`"${work}" holds no preparation`);
  }
  // The audit reads the npm registry cache the review it starts will read, and asks OSV
  // through the run's cache, which every step of the preparation and its review share.
  const context = {
    net: withOsvCache(net ?? defaultNet, runCache(work).osv),
    cacheDir: record.flags?.["cache-npm-registry-dir"] || undefined,
  };
  switch (record.step) {
    case PREPARE_STEP.extract:
      return extract(work, record, context);
    case PREPARE_STEP.reduce:
    case PREPARE_STEP.fix:
      return rescueStep(work, record, context);
    default:
      return doneAgain(work, record);
  }
}

/**
 * The first step: the roots the reader handed back, settled, and their lock audited.
 * @param {string} work
 * @param {import("./state.js").PrepareRecord} record
 * @param {{net?: import("../vendor/verify.js").VendorNet, cacheDir?: string}} context
 * @returns {Promise<Handout>}
 */
async function extract(work, record, context) {
  const roots = answeredRoots(work, record);
  const settled = { ...record, roots };
  const found = await auditRoot(roots, context);
  if (!isRescuable(found)) {
    return done(work, settled);
  }
  return rescue(work, settled);
}

/**
 * The roots the reader handed back in the review file, held to the folder the source was
 * extracted into and settled as the review settles them. Every way they can be wrong is
 * refused, with nothing changed, so the reader can correct the file and hand it back again.
 *
 * Both are taken as the folders they really are, links followed, and asked of that target:
 * the root must lie inside `sca/`, which is what this preparation audits and copies, and
 * the Experiment folder inside the root, resolved against it as the review resolves it.
 * @param {string} work
 * @param {import("./state.js").PrepareRecord} record
 * @returns {{scaRoot: string, scaExpSource: ?string}}
 * @throws {HandbackRefused}
 */
function answeredRoots(work, record) {
  const paths = workPaths(work);
  const asked = rootEntries(record);
  const handed = readHandback(paths.review).entries;
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
    (e) => String(e?.index)
  );
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
    scaRoot: settled.scaRoot,
    scaExpSource: settled.scaExpSource ?? null,
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
  const paths = workPaths(work);
  const sca = realSca(paths);
  const copy = realFolder(paths.rescued);
  const root = realFolder(roots.scaRoot);
  const inside = (tree) => tree !== null && relativeInside(root, tree) !== null;
  if (!root || !(inside(sca) || inside(copy))) {
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
 * Make the rescued copy of the work folder's source, in its `rescued/`, and hand it the
 * first step.
 *
 * The copy is made first and the record moved on after, so a run cut short in between
 * leaves the record at `extract`, and handing the folder back makes the copy again - over
 * whatever the cut-short run left there, which is this run's own. Symbolic links are copied
 * as they are written: one the submission points out of itself stays pointing out, for the
 * review to report, rather than being followed into a copy of whatever it names.
 *
 * A copy that cannot be made ends the run as the tool's failure, before any prompt names it.
 * @param {string} work
 * @param {import("./state.js").PrepareRecord} record  Settled.
 * @returns {Handout}
 * @throws {Error}  The copy could not be made.
 */
function rescue(work, record) {
  const { sca: from, rescued: to } = workPaths(work);
  const real = fs.realpathSync(from);
  const into = (p) => (p ? path.join(to, path.relative(real, p)) : p);
  try {
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  } catch (err) {
    rethrowIfFatal(err);
    throw new Error(
      `The rescued copy "${to}" could not be made (${err.code ?? err.message}). ` +
        "Hand the work folder back once that is fixed."
    );
  }
  const copied = markPrepare(work, {
    ...record,
    step: PREPARE_STEP.reduce,
    roots: {
      scaRoot: fs.realpathSync(into(record.roots.scaRoot)),
      scaExpSource: record.roots.scaExpSource
        ? fs.realpathSync(into(record.roots.scaExpSource))
        : null,
    },
  });
  return { next: "step", work, record: copied };
}

/**
 * A rescued copy's step, handed back: audited, then done when clean, on to `fix` after a
 * `reduce` that was not enough, and given up after a `fix` that was not either - the
 * folder is then done and marked unrescued, its roots back in `sca/`, before the copy is
 * removed.
 * @param {string} work
 * @param {import("./state.js").PrepareRecord} record
 * @param {{net?: import("../vendor/verify.js").VendorNet, cacheDir?: string}} context
 * @returns {Promise<Handout>}
 */
async function rescueStep(work, record, context) {
  const found = await auditRoot(record.roots, context);
  if (isClean(found)) {
    return done(work, record);
  }
  if (record.step === PREPARE_STEP.reduce) {
    const fix = markPrepare(work, { ...record, step: PREPARE_STEP.fix });
    return { next: "step", work, record: fix };
  }
  const { sca, rescued } = workPaths(work);
  const real = fs.realpathSync(rescued);
  const back = (p) =>
    p ? path.join(fs.realpathSync(sca), path.relative(real, p)) : p;
  const unrescued = markPrepare(work, {
    ...record,
    step: PREPARE_STEP.done,
    unrescued: true,
    roots: {
      scaRoot: back(record.roots.scaRoot),
      scaExpSource: back(record.roots.scaExpSource),
    },
  });
  fs.rmSync(rescued, { recursive: true, force: true });
  return { next: "review", work, record: unrescued };
}

/**
 * A done folder handed back again before its review started - the start before was refused,
 * failed, or was cut short: its review is started once more. Where it gave its rescue up and
 * the copy is still there - the give-up was cut short - the copy's removal is finished first.
 * And the review file the review claims is deleted again, in case the run that marked the
 * folder was cut short before it could.
 * @param {string} work
 * @param {import("./state.js").PrepareRecord} record
 * @returns {Handout}
 */
function doneAgain(work, record) {
  if (record.unrescued === true) {
    fs.rmSync(workPaths(work).rescued, { recursive: true, force: true });
  }
  return { next: "review", work, record: markPrepare(work, record) };
}
