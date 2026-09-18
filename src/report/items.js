// Renders the review into the material a phase hands the agent: one per item the report
// lists, in the order the report lists them, each carrying the locus, the wording the
// report showed, and for a to-do item BOTH wordings its two possible readers need.
//
// This is NOT the `--report-format json` document: that one is the upload filter ATN
// auto-verifies against, deliberately free of unsettled to-do items. This renders the
// opposite thing, for the opposite reader.
//
// EVERY item is rendered, including one the page had no room to print. The cap bounds the
// PAGE; a phase that asked about only the printed ones would settle those and let the rest
// pass unexamined, and an answer naming one of them would be refused as out of range. The
// two still number identically, because the numbering counts every item on both sides.
//
// Every to-do item is worded BOTH ways: `instructions`, which the agent follows to settle
// it, and `message` plus the `answers` it offers, which is how a person is asked about it
// (src/report/format.js manualQuestion writes the question, as it writes every other
// user-facing string). Both, on every one of them, because an item cannot know who will be
// asked about it - a case the agent sends on with `ask` is put to a reviewer while keeping
// the section it was filed under.
//
// `message` on a FINDING is a different thing: the wording the report showed for it, which
// is the developer's. Which of the two it is follows from the item's `kind`.
//
// `answers` carries every label and description the reviewer will read, in order. They are
// the same for every item, and repeated on every item all the same: what it takes to ask
// one is then in one place, and a reader assembling a question from two places is a reader
// that can assemble it from one of them alone.
//
// Belongs here: what an item carries, and the paths this run names - the two loop files,
// and the description and build-report files its agents write (reviewFilePaths), which
// share one name so none can drift from the review it belongs to.
//
// Does NOT belong here: WHICH of the two wordings an entry is handed over with, and the
// progress label counting what a hand-over puts to a person - both are the phase's, at the
// moment it hands out (src/report/handback.js entriesFor). Nor the ORDER and the numbering
// (src/report/order.js), WHICH entries a phase asks about (src/report/phases.js), the
// wording (assets/registry.yaml, resolved before this runs), or when the files are claimed
// (src/pipeline.js).

import os from "node:os";
import path from "node:path";

import { orderReview } from "./order.js";
import { SECTION_TITLES, manualQuestion } from "./format.js";
import { STATE_SUFFIX, REVIEW_SUFFIX } from "./state.js";

/**
 * The item array for a finished review.
 *
 * Each entry carries its `index` (its number in the report), the `entry` it shares with
 * its siblings - the numbered entry a collapsed group renders as, which the prose conveys
 * by layout and a flat array would otherwise lose - and the fields that decide it.
 * Named arguments, as applyVerdicts takes them: enough of them decide layout rather than
 * content that a call site listing them by position says nothing about what it passes.
 * @param {object} args
 * @param {import("./finding.js").Finding[]} args.findings
 * @param {import("./finding.js").ManualItem[]} args.manual
 * @param {{label: string, description: string}[]} args.choices  The answers a question
 *   offers, from registry.manualReviewChoices(), in the order the reviewer sees them.
 *   REQUIRED, and not defaulted: a question with no answers is one a reviewer cannot
 *   answer, which the registry itself refuses to author.
 * @param {(x: object) => string} [args.labelOf]  Artifact label ([XPI]/[SCA]) for a
 *   question's locus, from src/report/format.js locusLabeler - in an SCA review
 *   "package.json" alone names a file in either artifact, and the question has to say
 *   which.
 * @returns {object[]}
 */
export function reviewItems({ findings, manual, choices, labelOf }) {
  const entryNumbers = new Map();
  const counters = new Map();
  // The WHOLE review, never a filtered `manual`: orderReview numbers what it is GIVEN, so
  // a pre-filtered list would renumber the survivors and every index here would name a
  // different item than the report does. A phase picks the entries it asks about
  // afterwards, by index (src/report/loop.js phaseEntries).
  const listed = orderReview(findings, manual);
  const items = listed.map((x) => {
    const t = x.target;
    // The entry number the report shows for it. Found Issues numbers continuously across
    // its severity bands and each to-do section restarts at 1, so the counter is keyed
    // the same way - "entry 2" then means the same thing in both documents.
    const scope = x.kind === "finding" ? "finding" : x.section;
    const key = `${scope}/${x.entry}`;
    if (!entryNumbers.has(key)) {
      counters.set(scope, (counters.get(scope) ?? 0) + 1);
      entryNumbers.set(key, counters.get(scope));
    }
    const locus = {
      file: t.file ?? null,
      loc: t.loc ?? null,
      item: t.item ?? null,
      hint: t.hint ?? null,
    };
    // The section the report lists it under, by the name it prints - not the internal
    // key. A finding's own band is already on `severity`.
    const title =
      x.kind === "finding" ? SECTION_TITLES.issues : SECTION_TITLES[x.section];
    return x.kind === "finding"
      ? {
          index: x.index,
          kind: "finding",
          section: title,
          entry: entryNumbers.get(key),
          ruleId: t.ruleId,
          severity: t.severity,
          ...locus,
          message: t.message,
        }
      : {
          index: x.index,
          kind: "todo",
          section: title,
          entry: entryNumbers.get(key),
          ruleId: t.ruleId ?? null,
          // What a reported case becomes, or null when settling it produces no
          // finding however it goes.
          suggestedVerdict: t.verdict ?? null,
          ...locus,
          // BOTH wordings, on every item: the instruction addressed to the agent, and
          // the question addressed to a person. WHICH of them an entry carries is the
          // phase's to decide as it hands the item out (handback.js entriesFor). An item
          // cannot know who will be asked about it - a case the agent sends on with `ask`
          // is put to a reviewer while keeping the section it was filed under - so
          // deciding it here, from the item, could only ever be a guess.
          instructions: t.llmInstructions ?? null,
          settleVerbs: t.settleVerbs ?? null,
          message: manualQuestion(t, labelOf),
          // Label and description only: the verdict each answer settles the item
          // with never leaves this process.
          answers: choices.map(({ label, description }) => ({
            label,
            description,
          })),
          suggestedResponse: t.response ?? null,
        };
  });
  return items;
}

/**
 * The four files this run names, sharing one name and one moment:
 *
 * - `state`, the linter's own record of the review, and `review`, the file it hands the
 *   agent one phase at a time. Both in the system temp directory. They SHARE A STEM, which
 *   is what makes the pointer in the handed-back file checkable rather than trusted.
 * - `summary`, where a sub-agent writes the add-on description for the reviewer.
 * - `build`, where another writes what building the add-on takes, in a source code review.
 *
 * The last two sit BESIDE the submitted .xpi, in the folder the reviewer is working out of,
 * so the links they are handed open where they are looking. This linter writes neither and
 * reads neither; it only says where they go, so a name cannot drift from the review it
 * belongs to.
 *
 * One base for all four: a name and a version do not identify a review - two submissions can
 * share both (a fork, a resubmission, an add-on reviewed twice in a session) - so the run's
 * own moment separates them, and a later run does not open what an earlier one left
 * behind. Millisecond resolution, which separates reviews a person runs; two started in
 * the same millisecond would still collide, and nothing here pretends otherwise.
 * A review is named ONCE, by the run that builds it. Every pass after that is handed the
 * review file's path and finds the rest from it, so no later run has to recompute a moment
 * it does not have.
 * @param {import("../addon/load.js").Addon} addon  The shipped add-on - read for the name
 *   it lends all four (its id and version).
 * @param {string} xpiPath  Where that add-on IS, absolute. An Addon carries no path of its
 *   own, so the caller passes the one the run was given (src/pipeline.js), which resolved
 *   it - nothing re-resolves it here.
 * @returns {{summary: string, build: string, state: string, review: string}}
 */
export function reviewFilePaths(addon, xpiPath) {
  const base = reviewFileBase(addon);
  // Beside the .xpi, which is the folder a reviewer downloaded it into. For an unpacked
  // submission that is the folder holding it, for the same reason: not inside what is being
  // reviewed. Taken once, so the two files cannot land in different folders.
  const beside = path.dirname(xpiPath);
  return {
    summary: path.join(beside, `${base}.summary.md`),
    build: path.join(beside, `${base}.build.md`),
    // The REVIEW LOOP's pair. They share this stem so `base` in the file the agent hands
    // back is CHECKABLE rather than trusted: the linter derives the state path from the
    // review path it was given and compares the two.
    state: path.join(os.tmpdir(), `${base}${STATE_SUFFIX}`),
    review: path.join(os.tmpdir(), `${base}${REVIEW_SUFFIX}`),
  };
}

/**
 * The shared name: the add-on, its version, and the moment - made safe to put in a path.
 * @param {import("../addon/load.js").Addon} addon
 * @returns {string}
 */
function reviewFileBase(addon) {
  const m = addon?.manifest;
  const id =
    m?.browser_specific_settings?.gecko?.id ??
    m?.applications?.gecko?.id ??
    m?.name ??
    "addon";
  const at = new Date().toISOString().replace(/[:.]/g, "-");
  // The id is the submission's, and an add-on with no gecko id lends its NAME - which has
  // no length limit of its own, while the name this composes does (255 bytes on ext4, and
  // the timestamp and the suffix take 30 of them). Clamped rather than hashed: what the
  // first 80 characters name is still recognisable to whoever opens the file.
  // Anything outside [A-Za-z0-9._@-] could escape the directory or upset a shell, and
  // the id comes from the submission.
  return `webext-linter-${id.slice(0, 80)}-${m?.version ?? "0"}-${at}`.replace(
    /[^A-Za-z0-9._@-]/g,
    "_"
  );
}
