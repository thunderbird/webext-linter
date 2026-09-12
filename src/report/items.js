// The machine-readable form of a review, written for --llm-review: one entry per item
// the report lists, as an ARRAY in the order the report lists them. A position in the
// array IS the item's number, so whoever settles the review addresses an item by reading
// a field instead of counting lines - which is where every off-by-one came from.
//
// It carries what settling an item needs and nothing more: the locus, the wording the
// report showed, and for a to-do item the instructions and what a reported case would
// become. It is NOT the `--report-format json` document: that one is the upload filter
// ATN auto-verifies against, deliberately free of unsettled to-do items. This one exists
// for the opposite purpose, so it is a separate file with a separate contract.
//
// EVERY item is here, including one the page had no room to print. The cap bounds the
// PAGE, and a reader working from this file would otherwise settle the items they were
// handed while the rest passed unexamined - and a verdict naming one of them would be
// refused as out of range. The two documents still number identically, because the
// numbering counts every item on both sides.
//
// The one exception to "a position IS the number" is the PRE-SWEEP tail. Those entries
// are not items of the review: they settle nothing, they are jobs to do BEFORE settling
// it, and what they produce is addressed by check and locus rather than by a number. So
// they carry no `index` and no `entry`, and they sit at the END, which keeps positions
// 0..N-1 aligned with indices 1..N for everything that does have one.
//
// Belongs here: the shape of that file, and the temp path it is written to.
//
// Does NOT belong here: the ORDER and the numbering (src/report/order.js), the wording
// (assets/registry.yaml, resolved before this runs), and when the file is claimed and
// filled (src/pipeline.js, which owns both moments).

import os from "node:os";
import path from "node:path";

import { orderReview } from "./order.js";
import { SECTION_TITLES } from "./format.js";

/**
 * The item array for a finished review.
 *
 * Each entry carries its `index` (its number in the report), the `entry` it shares with
 * its siblings - the numbered entry a collapsed group renders as, which the prose conveys
 * by layout and a flat array would otherwise lose - and the fields that decide it.
 * @param {import("./finding.js").Finding[]} findings
 * @param {import("./finding.js").ManualItem[]} manual
 * @param {?{intro: string, items: object[]}} [preSweep]  The blind-spot sweep, appended
 *   as the unnumbered tail: one entry carrying the shared method and the bare items.
 * @returns {object[]}
 */
export function reviewItems(findings, manual, preSweep = null) {
  const entryNumbers = new Map();
  const counters = new Map();
  const items = orderReview(findings, manual).map((x) => {
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
          title: t.title,
          instructions: t.instructions ?? null,
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
 * Where the item file is written: the system temp directory, named after the add-on it
 * describes so reviewing two add-ons in one session cannot have them clobber each other.
 * Not beside the submission - a review does not write into what it is reviewing.
 * @param {import("../addon/load.js").Addon} addon  The shipped add-on.
 * @returns {string}
 */
export function itemsFilePath(addon) {
  const m = addon?.manifest;
  const id =
    m?.browser_specific_settings?.gecko?.id ??
    m?.applications?.gecko?.id ??
    m?.name ??
    "addon";
  const name = `webext-linter-${id}-${m?.version ?? "0"}.items.json`;
  // Anything outside this set could escape the directory or upset a shell, and the id
  // comes from the submission.
  return path.join(os.tmpdir(), name.replace(/[^A-Za-z0-9._@-]/g, "_"));
}
