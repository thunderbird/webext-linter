// The machine-readable form of a review, written for --llm-review: one entry per item
// the report lists, as an ARRAY in the order the report lists them. A position in the
// array IS the item's number, so whoever settles the review addresses an item by reading
// a field instead of counting lines, which is where off-by-ones come from.
//
// It carries what settling an item needs and nothing more: the locus, the wording the
// report showed, and for a to-do item the instructions and what a reported case would
// become. It is NOT the `--report-format json` document: that one is the upload filter
// ATN auto-verifies against, deliberately free of unsettled to-do items. This one exists
// for the opposite purpose, so it is a separate file with a separate contract.
//
// EVERY item the reader is asked to settle is here, including one the page had no room to
// print. The cap bounds the PAGE, and a reader working from this file would otherwise
// settle the items they were handed while the rest passed unexamined - and a verdict
// naming one of them would be refused as out of range. The two documents still number
// identically, because the numbering counts every item on both sides.
//
// --llm-skip-manual is the one case where "asked to settle" is narrower than "listed":
// its prompt does not put the two MANUAL sections to a reviewer, so the file does not
// carry them either - the rest passing unexamined is the point there, and they stay in the
// report for the reviewer to work through later. It TRUNCATES the numbering and never
// renumbers: those are the last sections orderReview numbers, so what survives is still
// 1..M at positions 0..M-1, and an index means the same item in a skipped file, a whole
// file and the report alike.
//
// An item of the two MANUAL sections carries the question it is put to the reviewer as:
// `message` is what they are asked (src/report/format.js manualQuestion writes it, as it
// writes every other user-facing string) and `label` says how far through the questions
// they are ("3/13"). `label` is theirs alone - the only items a reviewer is asked - and a
// progress label on anything else would count a question nobody asks. `message` is not:
// a finding carries one too, the wording the report showed for it, and which of the two a
// `message` is follows from the item's `kind`.
//
// The label is the progress, NOT the number a verdict names - that is still `index`, and
// the two differ by every finding and code-review item ahead of the questions.
//
// A question carries no `title` and no `instructions`. They are what `message` was
// composed FROM, and the prompt tells its reader to ask the question as written - so
// handing over the parts as well is handing over the means to write a different one. The
// items settled by reading the add-on keep their `instructions`, which is the one thing
// their reader follows.
//
// Each question also carries the `answers` it offers - every label and description the
// reviewer will read, in order. They are the same for every question, and they are
// repeated on every question all the same: what it takes to ask one is then in one place,
// and a reader assembling a question from two places is a reader that can assemble it
// from one of them alone.
//
// The one exception to "a position IS the number" is the PRE-SWEEP tail. Those entries
// are not items of the review: they settle nothing, they are jobs to do BEFORE settling
// it, and what they produce is addressed by check and locus rather than by a number. So
// they carry no `index` and no `entry`, and they sit at the END, which keeps positions
// 0..N-1 aligned with indices 1..N for everything that does have one.
//
// Belongs here: the shape of that file, and the paths this run names - the item file it
// writes, and the description and build-report files its reader writes (reviewFilePaths),
// which share one name so none can drift from the review it belongs to.
//
// Does NOT belong here: the ORDER and the numbering (src/report/order.js), the wording
// (assets/registry.yaml, resolved before this runs), and when the file is claimed and
// filled (src/pipeline.js, which owns both moments).

import os from "node:os";
import path from "node:path";

import { orderReview, isQuestion } from "./order.js";
import { SECTION_TITLES, manualQuestion } from "./format.js";

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
 * @param {?{agentIntro: string, items: object[]}} [args.preSweep]  The blind-spot sweep,
 *   appended as the unnumbered tail: one entry carrying the shared method and the bare
 *   items.
 * @param {boolean} [args.skipManual]  --llm-skip-manual: omit the two manual sections,
 *   which the prompt does not ask about either under that flag.
 * @param {(x: object) => string} [args.labelOf]  Artifact label ([XPI]/[SCA]) for a
 *   question's locus, from src/report/format.js locusLabeler - in an SCA review
 *   "package.json" alone names a file in either artifact, and the question has to say
 *   which.
 * @returns {object[]}
 */
export function reviewItems({
  findings,
  manual,
  choices,
  preSweep = null,
  skipManual = false,
  labelOf,
}) {
  const entryNumbers = new Map();
  const counters = new Map();
  // Filtered AFTER orderReview, never by handing it a filtered `manual`: orderReview
  // numbers what it is GIVEN, so a pre-filtered list would renumber the survivors and
  // every index here would name a different item than the report does. Dropping them
  // afterwards leaves each survivor the index the report printed.
  const ordered = orderReview(findings, manual);
  const listed = skipManual ? ordered.filter((x) => !isQuestion(x)) : ordered;
  // The reviewer's questions, in the order they are asked: the two manual sections, which
  // are the last of the review and so are already contiguous. Their count is the total a
  // label states, taken from the LISTED items - a --llm-skip-manual file holds none,
  // and a total counting items that file never carried would be a progress bar for a
  // review nobody is being shown.
  const questions = listed.filter(isQuestion);
  const asked = new Map(
    questions.map((x, i) => [x, `${i + 1}/${questions.length}`])
  );
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
          // A question carries the finished text, its progress label and its answers;
          // an item settled by reading the add-on carries `instructions` instead (header).
          ...(asked.has(x)
            ? {
                label: asked.get(x),
                message: manualQuestion(t, labelOf),
                // Label and description only: the verdict each answer settles the item
                // with never leaves this process.
                answers: choices.map(({ label, description }) => ({
                  label,
                  description,
                })),
              }
            : { instructions: t.instructions ?? null }),
          suggestedResponse: t.response ?? null,
        };
  });
  if (!preSweep) {
    return items;
  }
  // The unnumbered tail: ONE entry, because it is one request. `intro` is the AGENT's
  // framing - how to judge, and what to hand back - and each item is only the class of
  // code its own check is looking for. The report prints the reviewer's framing instead;
  // the two differ only in the hand-back contract, which a person does not produce. `check` rather than `ruleId`, deliberately: it is the value
  // an addition copies verbatim into the verdict file, so both documents spell it the
  // same way. `severity` is the band an addition for that check would land in, stated up
  // front so a reader knows the weight of what they are being asked to look for.
  return [
    ...items,
    {
      kind: "pre-sweep",
      section: SECTION_TITLES.preSweep,
      intro: preSweep.agentIntro,
      items: preSweep.items.map((s) => ({
        check: s.check,
        severity: s.severity,
        title: s.title,
        instruction: s.instruction,
      })),
    },
  ];
}

/**
 * The three files this run names, sharing one name and one moment:
 *
 * - `items`, the machine-readable item file, in the system temp directory. Not beside the
 *   submission - a review does not write into what it is reviewing.
 * - `summary`, where the prompt's reader writes the add-on description for the reviewer.
 * - `build`, where it writes what building the add-on takes, in a source code review.
 *
 * The last two sit BESIDE the submitted .xpi, in the folder the reviewer is working out of,
 * so the links they are handed open where they are looking. This linter writes neither and
 * reads neither; it only says where they go, so a name cannot drift from the review it
 * belongs to.
 *
 * One base for all three: a name and a version do not identify a review - two submissions can
 * share both (a fork, a resubmission, an add-on reviewed twice in a session) - so the run's
 * own moment separates them, and a later run does not open what an earlier one left
 * behind. Millisecond resolution, which separates reviews a person runs; two started in
 * the same millisecond would still collide, and nothing here pretends otherwise.
 * @param {import("../addon/load.js").Addon} addon  The shipped add-on - read for the name
 *   it lends all three (its id and version).
 * @param {string} xpiPath  Where that add-on IS, absolute. An Addon carries no path of its
 *   own, so the caller passes the one the run was given (src/pipeline.js), which resolved
 *   it - nothing re-resolves it here.
 * @returns {{items: string, summary: string, build: string}}
 */
export function reviewFilePaths(addon, xpiPath) {
  const base = reviewFileBase(addon);
  // Beside the .xpi, which is the folder a reviewer downloaded it into. For an unpacked
  // submission that is the folder holding it, for the same reason: not inside what is being
  // reviewed. Taken once, so the two files cannot land in different folders.
  const beside = path.dirname(xpiPath);
  return {
    items: path.join(os.tmpdir(), `${base}.items.json`),
    summary: path.join(beside, `${base}.summary.md`),
    build: path.join(beside, `${base}.build.md`),
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
