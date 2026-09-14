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
// display cap is a property of the page, not of the review: the item file --llm-review
// writes must carry every item, or the reader settles the ones they were handed and the
// rest pass unexamined, and a verdict naming one of them must resolve rather than fail.
// `shown` carries the page's decision separately, for the renderer to act on.
//
// Belongs here: the sequence, the entry boundaries within it, the numbering, and which
// items the page has room for.
//
// Does NOT belong here: how an entry is drawn (src/report/format.js), what it says
// (assets/registry.yaml), or which items a verdict changes (src/report/verdicts.js).

import { SEVERITY_ORDER, sortFindings } from "./finding.js";
import { MAX_ENTRIES_PER_CATEGORY } from "../config.js";

/**
 * Whether an entry has anything to put on a location line: a file, a subject surfaced
 * for display, or a supplementary detail. One of the three is required because
 * locationLine has nothing to print without them - it is this gate, not a placeholder,
 * that keeps an empty line out of the report. An entry with none of them - a finding
 * whose subject is the submission as a whole, and whose message already says everything -
 * is listed with no location line rather than a line naming nothing.
 * @param {object} x  A finding or manual item.
 * @returns {boolean}
 */
export function hasLocus(x) {
  return Boolean(x.file || (x.listItem && x.item) || x.hint);
}

/**
 * One line out of authored prose. The registry wraps its texts, and those wraps are the
 * YAML's layout rather than the sentence's, so anything rendering an item's instructions
 * as a body flattens them the same way. Shared with the question the item file carries
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
  return m.section === "manual-review" ? "extendedManual" : "code";
}

/** The to-do sections, in the order the report prints them. */
const TODO_SECTIONS = Object.freeze(["code", "extendedManual", "standard"]);

/** The to-do sections a person answers, as opposed to the ones settled by reading the
 *  add-on. --llm-verify withholds BOTH the prompt's asks for them (src/report/format.js)
 *  and their entries in the item file (src/report/items.js); named once here because those
 *  two must never disagree - an ask for a section the file omits sends the reader hunting
 *  for entries that are not there. They are the LAST sections TODO_SECTIONS numbers, which
 *  is what makes omitting them truncate the numbering rather than punch a hole in it. */
export const MANUAL_SECTIONS = Object.freeze(["extendedManual", "standard"]);

/**
 * @typedef {object} OrderedItem
 * @property {"finding"|"todo"} kind
 * @property {string} section  A severity band for a finding, a to-do section otherwise.
 * @property {string} entry  Entry key: consecutive items sharing it are one numbered
 *   entry with a shared body and a list of locations.
 * @property {number} index  The number this item is listed under. Every item has one,
 *   whether or not the page prints its line.
 * @property {boolean} shown  Whether the report prints a location line for it, or folds
 *   it into the entry's "and N more" marker (past the per-entry display cap).
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
    members.forEach((target, i) => {
      // Past the cap the page prints a marker instead of the line. The item is numbered
      // all the same: it is still part of the review, still in the item file, and still
      // addressable by a verdict.
      items.push({
        kind,
        section,
        entry: key,
        index: ++n,
        shown: i < MAX_ENTRIES_PER_CATEGORY,
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
