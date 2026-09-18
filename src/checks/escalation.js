// The orchestrator's escalation policy: how a case a check could not settle on its own
// becomes a to-do note. A check returns `escalations` of cases a person must inspect and
// manualEscalations repacks them as manual items. WHICH section they are listed under is
// the check's `escalation` field - the section the registry derived from the reader that
// check authored wording for - and not a property of the case: every case a check raises
// asks the same question, so a check needing two questions is two checks.
//
// Belongs here: manualEscalations, the ManualRef shape, and narrating each check's
// per-site verdicts to the live feed. Does NOT belong here: building the escalations
// - that is a check under src/checks/rules/*. Looping over checks and stamping
// severity is runChecks (src/checks/registry.js). Turning a ManualRef into user text
// is src/report/responses.js via the registry.

/** @typedef {import("./registry.js").LoadedCheck} LoadedCheck */

/**
 * @typedef {object} Escalation  A deterministic case a human must inspect.
 * @property {?string} item  The offending token, for the `{{item}}` slot.
 * @property {Record<string, string|number>} [data]  Extra `{{slot}}` values for
 *   the manual instructions (e.g. a reason), filled like a finding's data.
 * @property {string} [file]  Locus, listed under the manual entry (like a
 *   finding) so the reviewer sees where; the report groups by message.
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
 *   check's `escalation` field (src/checks/registry.js sectionFor derives it).
 * @property {Record<string, string|number>|null} data  Extra `{{slot}}` values
 *   for the instructions template (null when the case carries none).
 * @property {?{id: string, file: string, line: ?number, token: string}[]}
 *   occurrences  The token sites a check located for this item (unused-permission
 *   records where each permission's usage tokens appear). Null when it located none.
 */

/**
 * @param {LoadedCheck} check
 * @param {{item?: ?string, hint?: ?string, file?: ?string, loc?: object,
 *   data?: object, occurrences?: object[]}} c  The manual case: its `{{item}}`
 *   token, an optional per-locus `hint`, an optional locus (file/loc), data, and any
 *   token sites the check located.
 * @returns {ManualRef}
 */
function manualRef(check, c) {
  return {
    ruleId: check.id,
    item: c.item ?? null,
    hint: c.hint ?? null,
    file: c.file ?? null,
    loc: c.loc ?? null,
    section: check.escalation ?? null,
    data: c.data ?? null,
    occurrences: c.occurrences ?? null,
  };
}

/**
 * Repack a check's escalations as manual refs. Nothing is adjudicated here: the check
 * already decided it cannot settle these, and its `escalation` field - derived from who
 * that check wrote its question for - says which of the two to-do sections they are
 * listed under.
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
