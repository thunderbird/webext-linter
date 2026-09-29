// The orchestrator's escalation policy: how a case a check could not settle on its own
// becomes a to-do note. A check returns `escalations` of cases a person must inspect and
// manualEscalations repacks them as manual items. WHICH section they are listed under is
// the check's `section` - derived by the registry from the reader that check authored
// wording for - and never a property of the case: every case a check raises asks the same
// question, so a check needing two questions is two checks.
//
// Belongs here: manualEscalations and the ManualRef shape, and holding a case to the
// locus contract every producer shares. Does NOT belong here: building the escalations -
// that is a check under src/checks/rules/*. Looping over checks and narrating per-site
// verdicts to the live feed are runChecks (src/checks/registry.js). Turning a ManualRef
// into user text is src/report/responses.js via the registry.

/** @typedef {import("./registry.js").LoadedCheck} LoadedCheck */

import { assertLocus } from "../lib/artifacts.js";

/**
 * @typedef {object} Escalation  A deterministic case a human must inspect.
 * @property {?string} item  The offending token, for the `{{item}}` slot.
 * @property {Record<string, string|number>} [data]  Extra `{{slot}}` values for
 *   the manual instructions (e.g. a reason), filled like a finding's data.
 * @property {string} artifact  WHICH artifact `file` is in, from the holder that minted
 *   the locus (src/addon/load.js `at`). Required, with a file or without: a case reaches
 *   a reader with a tree to look in, and nothing downstream can work out which.
 * @property {?string} [file]  Locus, listed under the manual entry (like a
 *   finding) so the reviewer sees where; the report groups by message. Null for a case
 *   about the artifact rather than about a file in it.
 * @property {{line?: number, column?: number}} [loc]
 * @property {string} [hint]  Per-locus suffix shown after `file:line`, independent
 *   of `item`.
 * @property {{id: string, file: string, line: ?number, token: string}[]} [occurrences]
 *   The token sites the check located for this item.
 */

/**
 * @typedef {object} ManualRef  A pointer to a manual-review to-do (resolved to
 *   text from the registry later).
 * @property {string} ruleId  The owning check.
 * @property {?string} item  The offending token, for the `{{item}}` slot.
 * @property {?string} hint  Per-locus suffix shown after `file:line` (like a
 *   finding's hint), independent of `item`. Null when none.
 * @property {?string} file  Locus path, listed under the manual entry, or null.
 * @property {{line?: number, column?: number}|null} loc  Locus line, or null.
 * @property {?string} section  The to-do section this is listed under, from the owning
 *   check's `section` (src/checks/registry.js sectionFor derives it).
 * @property {?string} artifact  WHICH submitted artifact `file` is in, as a Finding's -
 *   so a reader is never left to work out which of two a path belongs to, and so what
 *   an agent is handed can be resolved to a real path (src/report/artifact.js).
 * @property {Record<string, string|number>|null} data  Extra `{{slot}}` values
 *   for the instructions template (null when the case carries none).
 * @property {?{id: string, file: string, line: ?number, token: string}[]}
 *   occurrences  The token sites a check located for this item (unused-permission
 *   records where each permission's usage tokens appear). Null when it located none.
 */

/**
 * @param {LoadedCheck} check
 * @param {{artifact: string, file?: ?string, loc?: ?object, item?: ?string,
 *   hint?: ?string, data?: object, occurrences?: object[]}} c  The manual case: the locus
 *   its holder minted (required - a case says which artifact it points into, with a file
 *   or without), its `{{item}}` token, an optional per-locus `hint`, data, and any token
 *   sites the check located.
 * @returns {ManualRef}
 */
function manualRef(check, c) {
  // The same contract a finding is held to, for the same reason: a case put to a reader
  // names a path, and which artifact that path is in is not the reader's to work out.
  // Checked here rather than threaded in from the orchestrator - a case that cannot say
  // where it points is the check being wrong, and the route it ran on is not the answer
  // (the one carrying two artifacts has none to give).
  assertLocus(c, `an escalation from ${check.id}`);
  return {
    ruleId: check.id,
    artifact: c.artifact,
    item: c.item ?? null,
    hint: c.hint ?? null,
    file: c.file ?? null,
    loc: c.loc ?? null,
    section: check.section ?? null,
    data: c.data ?? null,
    occurrences: c.occurrences ?? null,
  };
}

/**
 * Repack a check's escalations as manual refs. Nothing is adjudicated here: the check
 * already decided it cannot settle these, and its `section` - derived from who that check
 * wrote its question for - says which of the two to-do sections they are listed under.
 * @param {LoadedCheck} check
 * @param {Escalation[]} escalations
 * @returns {{findings: object[], manualItems: ManualRef[]}}
 */
export function manualEscalations(check, escalations) {
  return {
    findings: [],
    manualItems: escalations.map((e) => manualRef(check, e)),
  };
}
