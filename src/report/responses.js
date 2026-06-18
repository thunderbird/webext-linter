// The report-assembly resolver: the single place that turns the registry into
// the strings shown to the user. A Finding carries only structured data (ruleId,
// a single `item`/subject, and optional `data` slots describing that item). The
// entry's `response` is the frame: `{{item}}` is filled with the finding's item
// and each named `{{slot}}` with the matching `data` value - so the check authors
// no prose, and `data` only adds detail ABOUT the one item (never a second
// subject; one finding has one item). A manual ref resolves to a {title,
// instructions} pair. `{{item}}` and `{{slot}}` are the only injection points, so
// all prose lives in the registry.
//
// Belongs here: template resolution only - filling {{item}}/{{slot}} and
// resolving a manual ref to {title, instructions}. Reads the registry via
// src/checks/registry.js.
// Does NOT belong here: the authored wording itself, which lives in
// assets/registry.yaml. Section chrome, ordering and text/JSON output belong to
// src/report/format.js. The finding data shape is in src/report/finding.js.
// Whether a check escalates to manual review (vs the LLM) is decided in
// src/checks/escalation.js - here a manual ref is only rendered, not chosen.

const PLACEHOLDER = "{{item}}";

/**
 * Tidy a filled registry template for display: collapse runs of spaces/tabs to a
 * single space and trim, but PRESERVE newlines. Issues responses are printed
 * VERBATIM (src/report/format.js renderFinding), so a line break authored in the
 * response - e.g. the deliberate one before "Read more:" - shows in the report.
 * Keep each registry response on one physical line except such breaks. (Manual-
 * review instructions are re-collapsed by manualLines, so their wraps don't
 * survive there regardless.)
 */
const collapse = (s) =>
  s
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();

/**
 * Fill a registry template: substitute `{{item}}` with `item` and each
 * `{{name}}` with `data[name]`. Returns null if a `{{item}}` template has no
 * item (so the caller can fall back rather than emit a blank).
 * @param {?string} template
 * @param {?string} item
 * @param {Record<string, string|number>|null} [data]
 * @returns {?string}
 */
function fill(template, item, data) {
  if (template == null) {
    return null;
  }
  let out = template;
  if (out.includes(PLACEHOLDER)) {
    if (item == null) {
      return null;
    }
    out = out.replaceAll(PLACEHOLDER, item);
  }
  if (data) {
    for (const [name, value] of Object.entries(data)) {
      out = out.replaceAll(`{{${name}}}`, String(value));
    }
  }
  return collapse(out);
}

/**
 * Fill each Issues finding's display `message` from the registry, keyed by its
 * ruleId: substitute the finding's `item` into the entry's `response` `{{item}}`
 * and any `data` values into the response's named `{{slot}}`s. Mutates in place.
 *
 * Also sets `listItem`: when the entry's response has NO `{{item}}` placeholder
 * but the finding carries an `item`, that identifier is not in the prose, so the
 * report lists it on the finding's location line instead (src/report/format.js).
 * @param {import("./finding.js").Finding[]} findings
 * @param {import("../checks/registry.js").Registry} registry
 */
export function renderFindings(findings, registry) {
  for (const f of findings) {
    const template = registry.responseFor(f.ruleId);
    f.message = fill(template, f.item, f.data) ?? f.message;
    f.listItem =
      f.item != null && template != null && !template.includes(PLACEHOLDER);
  }
}

/**
 * Resolve manual-review refs to ManualItems: the owning entry's title plus its
 * `instructions` (or the `llm-unavailable` system message), filled with the case
 * item and any `data` slots (e.g. a reason). The ref's locus (file/loc/item) is
 * carried through, and `listItem` is set exactly as for findings - so the report
 * can list "file:line - item" under an item-free instructions message.
 * @param {{ruleId: string, item: ?string, file?: ?string, loc?: object|null,
 *   kind: string, data?: Record<string, string|number>|null}[]} refs
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {import("./finding.js").ManualItem[]}
 */
export function renderManualItems(refs, registry) {
  return refs.map((ref) => {
    const entry = registry.checkEntry(ref.ruleId);
    const template =
      ref.kind === "llm-error"
        ? registry.message("llm-unavailable")
        : entry?.instructions;
    return {
      title: entry?.title ?? ref.ruleId,
      instructions: fill(template, ref.item, ref.data) ?? "",
      file: ref.file ?? null,
      loc: ref.loc ?? null,
      item: ref.item ?? null,
      listItem:
        ref.item != null && template != null && !template.includes(PLACEHOLDER),
    };
  });
}
