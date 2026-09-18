// The ONE order of a finished review: every finding and every to-do item, in the
// sequence the report lists them, each carrying the number the report lists it under.
// The renderer prints this sequence and --llm-verdict indexes into it, so an item's
// number is assigned once and nothing has to re-derive it.
//
// That is the whole point of this module. While the order lived inside the renderer and
// a second walk reproduced it for the verdicts, the two drifted three separate ways - a
// group's locus filter, the display cap, and whether the messages had been filled yet -
// and each drift silently moved every later number.
//
// EVERY item is numbered, including one the page will not have room to print. The
// display cap is a property of the page, not of the review: the phase that asks about an
// item must be handed every one of them, or the agent settles the ones it was given and
// the rest pass unexamined, and an answer naming one must resolve rather than fail.
// `shown` carries the page's decision separately, for the renderer to act on. A case
// folded into another's line (`collapse: subject`) is the same bargain for the same
// reason: it is asked and settled like any other, it just does not print.
//
// Belongs here: the sequence, the entry boundaries within it, the numbering, which items
// the page has room for, which of them say the same thing as another (collapse), and
// which sections of it a reviewer answers.
//
// Does NOT belong here: how an entry is drawn (src/report/format.js), what it says
// (assets/registry.yaml), or which items a verdict changes (src/report/verdicts.js).

import { SECTION, SEVERITY_ORDER, sortFindings } from "./finding.js";
import { MAX_ENTRIES_PER_CATEGORY } from "../config.js";

/**
 * Whether an entry has anything to put on a location line: a file, a subject surfaced
 * for display, a supplementary detail, or a reviewer's note. One of the four is required
 * because locationLine has nothing to print without them - it is this gate, not a
 * placeholder, that keeps an empty line out of the report. An entry with none of them - a
 * finding whose subject is the submission as a whole, and whose message already says
 * everything - is listed with no location line rather than a line naming nothing.
 *
 * A note counts on its own: a reported case that named no location still carries what the
 * reviewer said about it, and that line is the only place it can appear.
 * @param {object} x  A finding or manual item.
 * @returns {boolean}
 */
export function hasLocus(x) {
  return Boolean(x.file || (x.listItem && x.item) || x.hint || x.note);
}

/**
 * One line out of authored prose. The registry wraps its texts, and those wraps are the
 * YAML's layout rather than the sentence's, so anything rendering an item's instructions
 * as a body flattens them the same way. Shared with the question an `ask` entry carries
 * (src/report/format.js manualQuestion): the report and the reviewer's question say the
 * same sentence, and one definition is what keeps them from flattening it differently.
 * @param {?string} text
 * @returns {string}
 */
export function collapseBody(text) {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The "Title: instructions" line of a to-do item - its entry body, and so its grouping
 * key: repeats of one check collapse into a single numbered entry with a locus list.
 * @param {import("./finding.js").ManualItem} m
 * @returns {string}
 */
export function manualBody(m) {
  return m.instructions
    ? `${m.title}: ${collapseBody(m.instructions)}`
    : m.title;
}

/**
 * Which of the three to-do sections an item is listed under. An escalation a reviewer
 * can settle by reading the code is a code review step; one needing information from
 * outside the package, an action only a person can take, or a decision a person must
 * own is a manual one. The standard list is the checks done by hand on every
 * submission, escalated or not.
 * @param {import("./finding.js").ManualItem} m
 * @returns {"code"|"extendedManual"|"standard"}
 */
function bucketOf(m) {
  if (!m.extended) {
    return "standard";
  }
  return m.section === SECTION.MANUAL_REVIEW ? "extendedManual" : "code";
}

/** The to-do sections, in the order the report prints them. */
const TODO_SECTIONS = Object.freeze(["code", "extendedManual", "standard"]);

/** The to-do sections a person answers, as opposed to the ones settled by reading the
 *  add-on. It has ONE reader, `isQuestion` below, and through it decides the phase an item
 *  starts in. They are the LAST sections TODO_SECTIONS numbers, which is what makes
 *  omitting them truncate the numbering rather than punch a hole in it. */
const MANUAL_SECTIONS = Object.freeze(["extendedManual", "standard"]);

/**
 * Whether this ordered entry is a question only a REVIEWER can answer, as opposed to a
 * case settled by reading the add-on. It decides ONE thing: which phase an item starts in
 * (src/report/phases.js phaseOf).
 *
 * Where an item STARTS, never where it is now. The `ask` verdict sends a case on to a
 * reviewer without changing the section it was filed under, so anything asking "is a
 * person answering this" reads the item's current phase instead (phases.js phaseNow) -
 * which is what the file a phase hands out and the answer it takes back are both built
 * from.
 * @param {OrderedItem} x
 * @returns {boolean}
 */
export function isQuestion(x) {
  return x.kind === "todo" && MANUAL_SECTIONS.includes(x.section);
}

/**
 * @typedef {object} OrderedItem
 * @property {"finding"|"todo"} kind
 * @property {string} section  A severity band for a finding, a to-do section otherwise.
 * @property {string} entry  Entry key: consecutive items sharing it are one numbered
 *   entry with a shared body and a list of locations.
 * @property {number} index  The number this item is listed under. Every item has one,
 *   whether or not the page prints its line.
 * @property {boolean} shown  Whether the report prints a location line for it, or folds
 *   it into the entry's "and N more" marker (past the per-entry display cap), or prints
 *   nothing because another case of the same subject stands for it (`collapse: subject`).
 * @property {boolean} folded  Whether it is the second kind: another case's line stands
 *   for it, so it is not one of the ones an "and N more" marker speaks for.
 * @property {number} collapsed  How many OTHER cases this one's line stands for, when its
 *   entry collapses on the subject; 0 everywhere else. The renderer appends it to the
 *   line, so the count a reader sees is the one counted here.
 * @property {object} target  The Finding or ManualItem itself.
 */

/**
 * The review as one ordered, numbered sequence.
 *
 * Findings come first, by severity band and sorted within it, with the items of an
 * entry adjacent. The to-do sections follow in the order they print, their repeats
 * collapsed the same way.
 *
 * An entry groups items sharing a body AND a locus: a locus-less item never joins an
 * entry that lists locations, because it would contribute no line there and become an
 * item nobody could see or point at.
 *
 * Idempotent - ordering an ordered review returns the same sequence - so the renderer
 * can call it defensively without the caller having to.
 * @param {import("./finding.js").Finding[]} findings
 * @param {import("./finding.js").ManualItem[]} [manual]
 * @returns {OrderedItem[]}
 */
export function orderReview(findings, manual = []) {
  const items = [];
  let n = 0;
  const push = (kind, section, key, members) => {
    // An entry whose check declares `collapse: subject` prints one line per SUBJECT: the
    // first case keeps its line and carries a count of the others, the rest do not print.
    // Decided HERE, with the cap, because both answer the same question - does this item's
    // line print - and one answer in one place is what keeps the printed numbers and the
    // addressable ones together. The renderer prints what this decided; it decides nothing.
    //
    // This is NOT the entry grouping, which is settled above and reads only the body and
    // whether an item has a locus at all. Grouping decides what is ONE entry; this decides
    // which of that entry's lines print. Nothing here changes what was found, what is
    // asked, or what a verdict can settle - every case keeps its index either way.
    const keeperOf = new Map();
    const collapsed = new Array(members.length).fill(0);
    const folded = members.map((m, i) => {
      if (m.collapse !== "subject") {
        return false;
      }
      // Everything the line would say EXCEPT where it is: subject, detail, and a
      // reviewer's own words. A line may stand for another only when the two would have
      // said the same thing - a differing detail is a different case, and a differing
      // NOTE is a person having written something about this one that is theirs alone.
      // The display cap does lose a note, and that is settled (26 cases of one check is
      // not a review anyone finishes); this must not, because two places for one host is
      // an ordinary submission.
      const subject = JSON.stringify([m.item, m.hint, m.note]);
      const keeper = keeperOf.get(subject);
      if (keeper === undefined) {
        keeperOf.set(subject, i);
        return false;
      }
      collapsed[keeper]++;
      return true;
    });
    // The cap counts LINES, so a folded case never uses one of them up.
    let printed = 0;
    members.forEach((target, i) => {
      // Past the cap the page prints a marker instead of the line, and a folded case
      // prints none at all. The item is numbered either way: it is still part of the
      // review, still asked about, and still addressable by an answer.
      const shown = !folded[i] && printed < MAX_ENTRIES_PER_CATEGORY;
      if (shown) {
        printed++;
      }
      items.push({
        kind,
        section,
        entry: key,
        index: ++n,
        shown,
        folded: folded[i],
        collapsed: collapsed[i],
        target,
      });
    });
  };
  for (const severity of SEVERITY_ORDER) {
    const band = sortFindings(findings.filter((f) => f.severity === severity));
    for (const { key, members } of groupBy(band, (f) => f.message)) {
      push("finding", severity, key, members);
    }
  }
  for (const section of TODO_SECTIONS) {
    const bucket = manual.filter((m) => bucketOf(m) === section);
    for (const { key, members } of groupBy(bucket, manualBody)) {
      push("todo", section, key, members);
    }
  }
  return items;
}

/**
 * Group a band or bucket into entries: items sharing `bodyOf` AND their locus status,
 * in first-appearance order, so the input's sort survives into and within the groups.
 * The key travels beside the members rather than on them - a group is a view of the
 * review, never a change to it.
 * @param {object[]} list
 * @param {(x: object) => string} bodyOf
 * @returns {{key: string, members: object[]}[]}
 */
function groupBy(list, bodyOf) {
  const byKey = new Map();
  for (const x of list) {
    // The locus status is part of the key: see orderReview.
    const key = `${hasLocus(x) ? "L" : "-"} ${bodyOf(x)}`;
    const group = byKey.get(key);
    if (group) {
      group.members.push(x);
    } else {
      byKey.set(key, { key, members: [x] });
    }
  }
  return [...byKey.values()];
}
