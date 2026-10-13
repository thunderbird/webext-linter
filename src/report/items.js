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
// pass unexamined. The two still number identically, because the numbering counts every
// item on both sides.
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
// the same for every item a phase hands out, and repeated on every item all the same: what it takes to ask
// one is then in one place, and a reader assembling a question from two places is a reader
// that can assemble it from one of them alone.
//
// Belongs here: what an item carries.
//
// Does NOT belong here: WHICH of the two wordings an entry is handed over with, and the
// progress label counting what a hand-over puts to a person - both are the phase's, at the
// moment it hands out (src/report/handback.js entriesFor). Nor the ORDER and the numbering
// (src/report/order.js), WHICH entries a phase asks about (src/report/phases.js), the
// wording (assets/registry.yaml, resolved before this runs), or the files a review names
// (src/util/dest.js workPaths) and when they are claimed (src/pipeline.js).

import { orderReview } from "./order.js";
import { SECTION_TITLES, manualQuestion } from "./format.js";

/**
 * The item array for a finished review.
 *
 * Each entry carries its `ref` (the fixed reference answers are recorded under), the
 * `entry` it shares with
 * its siblings - the numbered entry a collapsed group renders as, which the prose conveys
 * by layout and a flat array would otherwise lose - and the fields that decide it.
 * Named arguments, as applyVerdicts takes them: enough of them decide layout rather than
 * content that a call site listing them by position says nothing about what it passes.
 * @param {object} args
 * @param {import("./finding.js").Finding[]} args.findings
 * @param {import("./finding.js").ManualItem[]} args.manual
 * @param {{label: string, description: string}[]} args.choices  The answers a question
 *   offers, from registry.answerChoices() for the phase handing it out, in the order the
 *   reviewer sees them.
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
  // The WHOLE review, never a filtered `manual`: the entry numbers count what they are
  // GIVEN, so a pre-filtered list would number the survivors differently from the report.
  // A phase picks the entries it asks about afterwards, by reference
  // (src/report/loop.js phaseEntries).
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
      // WHICH artifact `file` is in, carried from the finding or the escalated case.
      // The path stays relative here, as the report prints it; what an agent is handed
      // is resolved against this when the entry is rendered (handback.js entriesFor),
      // because only there is a path being given to something that will open it.
      artifact: t.artifact ?? null,
    };
    // The section the report lists it under, by the name it prints - not the internal
    // key. A finding's own band is already on `severity`.
    const title =
      x.kind === "finding" ? SECTION_TITLES.issues : SECTION_TITLES[x.section];
    return x.kind === "finding"
      ? {
          ref: x.ref,
          kind: "finding",
          section: title,
          entry: entryNumbers.get(key),
          ruleId: t.ruleId,
          severity: t.severity,
          ...locus,
          message: t.message,
        }
      : {
          ref: x.ref,
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
