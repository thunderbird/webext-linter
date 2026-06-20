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
// Does NOT belong here: how a finding reads - turning ruleId/item/data
// into a `message` string is the resolver's job (src/report/responses.js), and
// the authored wording itself lives in assets/registry.yaml. Layout, section
// chrome and JSON shaping live in src/report/format.js. Which severity a rule
// gets, and verdict/escalation decisions, live in the registry and
// src/checks/escalation.js - not here.

/** @typedef {"error" | "warning" | "info"} Severity */

export const SEVERITY = Object.freeze({
  ERROR: "error",
  WARNING: "warning",
  INFO: "info",
});

// Severity ordering for sorting / "does this fail the run" decisions.
const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

/**
 * @typedef {object} FindingOpts  What a check supplies - locus + data, no prose.
 * @property {string} [file]  Path relative to the add-on root.
 * @property {{line?: number, column?: number}} [loc]
 * @property {string} [item]  Offending token (API/permission/path) for the
 *   response's `{{item}}` slot.
 * @property {string} [hint]  Structured remediation pointer (e.g. an MDN URL),
 *   appended by the renderer - a value from the schema, not authored text.
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
 * @property {boolean} listItem  Set by the report resolver: show `item` on the
 *   finding's location line (the message did not consume `{{item}}`, so the
 *   identifier is surfaced there instead). Never set by a check.
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
 * @property {string} [instructions]
 * @property {string|null} [response]  Developer-facing wording (the registry
 *   `response`), printed under the instructions in the report; null when none.
 * @property {string|null} [file]
 * @property {{line?: number, column?: number}|null} [loc]
 * @property {string|null} [item]
 * @property {boolean} [listItem]  List `item` on the location line (the
 *   instructions did not consume `{{item}}`); set by the resolver.
 * @property {boolean} [extended]  True for a check that escalated to manual review
 *   (rendered under "Extended manual review"); false/absent for a registry
 *   manual-checks entry (rendered under "Standard manual review"). Set by the
 *   pipeline when it assembles the list.
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
