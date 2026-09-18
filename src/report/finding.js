// A Finding is the single unit of output produced by every check. It is a pure
// verdict record: where the check fired and the structured data to fill the
// registry text - never prose. A check authors no user-facing string; it calls
// finding({ file, loc, item, hint }) only. The orchestrator stamps `ruleId` and
// `severity` (from the registry), and the report resolver fills `message` from
// the registry response. Keeping one shape lets the reporter, pipeline and test
// harness treat findings uniformly.
//
// Belongs here: the Finding/FindingOpts/ManualItem typedefs and the small
// data-only helpers over a finding set - the finding() factory, hasErrors,
// sortFindings and countByRule. This file defines the data SHAPE only.
//
// Does NOT belong here: how a finding reads - turning ruleId/item/data into a
// `message` string is the resolver's job (src/report/responses.js), and the
// authored wording itself lives in assets/registry.yaml. Layout, section chrome
// and JSON shaping live in src/report/format.js. Which severity a rule gets, and
// verdict/escalation decisions, live in the registry and
// src/checks/escalation.js - not here.

/** The two sections an escalated case is listed under, and the ONE spelling of each.
 *  A check does not declare which: it declares who its question is for, and the section
 *  follows (src/checks/registry.js sectionFor). Both ends are here because one produces
 *  these strings and another compares them (src/report/order.js bucketOf), and a section
 *  spelled twice is a case that quietly stops being listed anywhere. */
export const SECTION = Object.freeze({
  CODE_REVIEW: "code-review",
  MANUAL_REVIEW: "manual-review",
});

/** @typedef {"error" | "warning" | "info"} Severity */

export const SEVERITY = Object.freeze({
  ERROR: "error",
  // Blocks the review without rejecting the add-on: the fix is outside the package
  // (a disclosure on the ATN listing, a privacy policy pasted into its field), so no
  // rebuild would help. Same blocking weight as an error, a different actor - which is
  // why neither `error` ("the code must change") nor `warning` ("next release") fits.
  HOLD: "hold",
  WARNING: "warning",
  INFO: "info",
});

// The one severity ordering (most severe first), for sorting, the report's Issues
// sections, and "does this fail the run" decisions - so a new/reordered severity is
// changed in exactly one place. SEVERITY_RANK is derived from it.
export const SEVERITY_ORDER = Object.freeze([
  SEVERITY.ERROR,
  SEVERITY.HOLD,
  SEVERITY.WARNING,
  SEVERITY.INFO,
]);
const SEVERITY_RANK = Object.fromEntries(
  SEVERITY_ORDER.map((sev, i) => [sev, i])
);

/**
 * @typedef {object} FindingOpts  What a check supplies - locus + data, no prose.
 * @property {string} [file]  Path relative to the add-on root.
 * @property {{line?: number, column?: number}} [loc]
 * `item` and `hint` are the TWO distinct locus fields - do not conflate them:
 * @property {string} [item]  The finding's SUBJECT: the offending token
 *   (API / permission / manifest-key / host / symbol). It is machine-meaningful -
 *   it fills the response's `{{item}}` slot and is the dedup key (lib/util.js
 *   dedupe). For DISPLAY
 *   it is surfaced on the location line only when the message did not already name
 *   it (the response/instructions has no `{{item}}`; see `listItem`).
 * @property {string} [hint]  A supplementary per-location DETAIL, ALWAYS appended
 *   after the locus ("file:line - hint"): an MDN URL, a Thunderbird version, a
 *   transmission method, a remote/source URL, a reason. Display only - no dedup or
 *   match role. Distinct from `item`: a finding may carry BOTH, rendering
 *   "file:line - <item> - <hint>" (e.g. an unsupported API call AND the version
 *   that added it). Use `item` for the subject (the thing identified/keyed), `hint`
 *   for extra colour about it. THE TEST: a value is an `item` only if it is the
 *   finding's UNIQUE offending identity - what dedup would key on (an API name, a
 *   remote URL, a manifest key); everything else is a `hint`. A per-site descriptor
 *   (a transmission method/channel) MUST stay `hint`: every site would otherwise
 *   carry the same `item` and collapse into one.
 * @property {Record<string, string|number>} [data]  Extra named values for
 *   `{{slot}}` placeholders in the response - additional detail ABOUT this
 *   finding's single `item`/subject (e.g. a source URL, an ajv message), data
 *   not prose. Never a second independent subject: one finding has one item.
 * @property {string} [ruleId]  Set only by the orchestrator (e.g. its own
 *   "check-failed" system finding); checks leave it unset.
 * @property {Severity} [severity]  Set by the orchestrator/lint channel, or by a
 *   check ONLY under a `severity: auto` registry entry (the check then owns each
 *   finding's severity). Under a fixed registry severity a check's value is
 *   ignored - the orchestrator overwrites it with the entry's severity.
 */

/**
 * @typedef {object} Finding
 * @property {string} ruleId
 * @property {Severity} severity
 * @property {string|null} file
 * @property {{line?: number, column?: number}|null} loc
 * @property {string|null} item
 * @property {string|null} hint
 * @property {Record<string, string|number>|null} data  Resolution input (named
 *   slot values describing the item); stripped from JSON output.
 * @property {string|null} message  Filled by the report resolver from the
 *   registry; never set by a check.
 * @property {boolean} listItem  Resolver flag: surface the SUBJECT (`item`) on the
 *   location line because the message did not consume `{{item}}` (else the subject
 *   would be invisible). This is the item-on-locus mechanism; `hint` (a DETAIL) is
 *   appended separately and unconditionally. Never set by a check.
 * @property {string|null} note  The REVIEWER's own words about this one case, attached
 *   when they answered its question in their own words instead of picking an answer
 *   (src/report/verdicts.js, the only thing that sets it - as with `message`, a check
 *   never does). Printed as the last part of the location line, after any `hint`: it is
 *   what a person added about THIS location, so it travels with the location rather
 *   than with the response paragraph, which stays wholly the registry's.
 */

/**
 * Create a finding. A check passes only locus and structured data (an `item`
 * plus optional `data` slots describing it), so `message` is not a parameter and
 * a check cannot author prose.
 *
 * @param {FindingOpts} opts
 * @returns {Finding}
 */
export function finding({ ruleId, severity, file, loc, item, hint, data }) {
  return {
    ruleId: ruleId ?? null,
    severity: severity ?? null,
    file: file ?? null,
    loc: loc ?? null,
    item: item ?? null,
    hint: hint ?? null,
    data: data ?? null,
    message: null,
    listItem: false,
    note: null,
  };
}

/**
 * Return true if the finding set contains at least one error (used for the
 * process exit code).
 *
 * @param {Finding[]} findings
 * @returns {boolean}
 */
export function hasErrors(findings) {
  return findings.some((f) => f.severity === SEVERITY.ERROR);
}

/**
 * Settle every `hold` in the set against the rest of it - the ONE moment a
 * hold-or-error check's band is decided, run once before anything reads a severity,
 * so the text report, the Summary tally and the JSON can never disagree about it.
 *
 * A hold is what its check emits provisionally. With any real error present the
 * submission is rejected anyway, so the hold is not the verdict - it is one more item
 * on the rejection list, and it becomes an error. On its own it stands, and the
 * review is on hold. Mutates in place, like renderFindings.
 * @param {Finding[]} findings
 * @returns {void}
 */
export function resolveHolds(findings) {
  if (!hasErrors(findings)) {
    return;
  }
  for (const f of findings) {
    if (f.severity === SEVERITY.HOLD) {
      f.severity = SEVERITY.ERROR;
    }
  }
}

/** The keys verdictKey can return - the vocabulary `verdict-intros` must author one
 *  preamble for. Named so the registry can assert that map against it rather than against
 *  a second list of the same four words. */
export const VERDICT_KEYS = Object.freeze([
  "none",
  "rejected",
  "hold",
  "feedback",
]);

/**
 * Which verdict preamble the Issues section opens with: no findings at all, any error
 * (rejected), any hold and no error (on hold), otherwise warnings/info only. One
 * definition, so the preamble and the headings below it always tell the same story.
 * @param {Finding[]} findings
 * @returns {"none"|"rejected"|"hold"|"feedback"}
 */
export function verdictKey(findings) {
  if (findings.length === 0) {
    return "none";
  }
  if (hasErrors(findings)) {
    return "rejected";
  }
  return findings.some((f) => f.severity === SEVERITY.HOLD)
    ? "hold"
    : "feedback";
}

/**
 * Stable sort: by file, then line, then column, then severity.
 *
 * @param {Finding[]} findings
 * @returns {Finding[]}
 */
export function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    const fa = a.file ?? "";
    const fb = b.file ?? "";
    if (fa !== fb) {
      return fa < fb ? -1 : 1;
    }
    const la = a.loc?.line ?? 0;
    const lb = b.loc?.line ?? 0;
    if (la !== lb) {
      return la - lb;
    }
    const ca = a.loc?.column ?? 0;
    const cb = b.loc?.column ?? 0;
    if (ca !== cb) {
      return ca - cb;
    }
    return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  });
}

/**
 * @typedef {object} ManualItem  A reviewer to-do shown in the Manual review
 *   section: a short title and (optionally) the instructions to carry out. Its
 *   text is resolved from the registry (see report/responses.js). The optional
 *   locus mirrors a Finding so escalated items list "file:line - item" beneath
 *   the message, grouped like Issues; standalone reminders carry none.
 * @property {string} title
 * @property {string} [ruleId]  The owning check's id (as a Finding's), so the report
 *   can label the locus by artifact ([XPI]/[SCA]) via ruleInputs. Absent for a
 *   standalone registry manual-checks reminder (which carries no locus).
 * @property {string} [instructions]  The wording a PERSON reads: the report's own entry
 *   body, and the question a reviewer is asked.
 * @property {string|null} [llmInstructions]  The wording an AGENT is handed, or null for
 *   a check whose question only a person can answer.
 * @property {string|null} [response]  Developer-facing wording (the registry
 *   `response`), printed under the instructions in the report; null when none.
 * @property {Record<string, string|number>|null} [data]  The slot values the item's
 *   texts were filled from, so a reported case can be resolved as a finding.
 * @property {string|null} [verdict]  The severity a reported case carries (the
 *   owning check's `severity`), printed above the response as the suggested
 *   verdict; null when settling the case produces no finding.
 * @property {string|null} [file]
 * @property {{line?: number, column?: number}|null} [loc]
 * @property {string|null} [item]  The SUBJECT, surfaced on the locus when the
 *   instructions don't name it (see `listItem`); as a Finding.
 * @property {string|null} [hint]  A supplementary per-locus DETAIL appended after
 *   `file:line`, always - distinct from `item`/`listItem` (as a Finding's hint).
 * @property {boolean} [listItem]  Surface the SUBJECT (`item`) on the location line
 *   (the instructions did not consume `{{item}}`); set by the resolver.
 * @property {boolean} [extended]  True for a check that escalated to manual
 *   review (rendered under "Extended Manual Review"); false/absent for a
 *   registry manual-checks entry (rendered under "Standard Manual Review"). Set
 *   by the pipeline when it assembles the list.
 */

/**
 * Count findings grouped by ruleId - used by the add-on test harness.
 *
 * @param {Finding[]} findings
 * @returns {Record<string, number>}
 */
export function countByRule(findings) {
  const counts = {};
  for (const f of findings) {
    counts[f.ruleId] = (counts[f.ruleId] ?? 0) + 1;
  }
  return counts;
}
