// The report-assembly resolver: the single place that turns the registry into
// the strings shown to the user. A Finding carries only structured data
// (ruleId, a single `item`/subject, and optional `data` slots describing that
// item). The entry's `response` is the frame: `{{item}}` is filled with the
// finding's item and each named `{{slot}}` with the matching `data` value - so
// the check authors no prose, and `data` only adds detail ABOUT the one item
// (never a second subject; one finding has one item). A manual ref resolves to a
// {title, instructions} pair. `{{item}}` and `{{slot}}` are the only injection
// points, so all prose lives in the registry.
//
// Belongs here: template resolution only - filling {{item}}/{{slot}} and
// resolving a manual ref to {title, instructions}. Reads the registry via
// src/checks/registry.js.
//
// Does NOT belong here: the authored wording itself, which lives in
// assets/registry.yaml. Section chrome, ordering and text/JSON output belong to
// src/report/format.js. The finding data shape is in src/report/finding.js.
// Whether a check escalates to manual review (vs a reviewer) is decided in
// src/checks/escalation.js - here a manual ref is only rendered, not chosen.

import { displayLine, displayText } from "../util/text.js";

const PLACEHOLDER = "{{item}}";

/**
 * Tidy a filled registry template for display: collapse runs of spaces/tabs to a
 * single space and trim, but PRESERVE newlines. Found Issues responses are printed
 * VERBATIM (src/report/format.js renderGroup), so a line break authored in the
 * response - e.g. the deliberate one before "Read more:" - shows in the report.
 * Keep each registry response on one physical line except such breaks.
 * Manual-review instructions are re-collapsed by manualBody, so their wraps
 * don't survive there regardless.
 * @param {string} s
 * @returns {string}
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
  if (template.includes(PLACEHOLDER) && item == null) {
    return null;
  }
  // Substitute every {{name}} in ONE pass from a fixed lookup: a slot value that
  // itself contains "{{other}}" is emitted literally, never re-scanned - so two
  // submission-derived slots in one template can't bleed into each other, and a
  // "$&"-style value can't trigger a replacement pattern. Unknown {{names}} are left
  // untouched.
  // Every substituted value is submission-derived - an item, a path, a URL, a
  // developer's words - so each is made safe to show. The TEMPLATE is ours and is left
  // as authored.
  const values = new Map();
  if (data) {
    for (const [name, value] of Object.entries(data)) {
      values.set(name, displayText(value));
    }
  }
  if (item != null) {
    values.set("item", displayLine(item));
  }
  const out = template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    values.has(name) ? values.get(name) : match
  );
  return collapse(out);
}

/**
 * Fill each Found Issues finding's display `message` from the registry, keyed by its
 * ruleId: substitute the finding's `item` into the entry's `response` `{{item}}`
 * and any `data` values into the response's named `{{slot}}`s. Mutates in place.
 *
 * Also sets `listItem` - the item-on-locus mechanism, which is NOT the same as a
 * `hint`. `item` is the finding's SUBJECT; when the response has NO `{{item}}`
 * placeholder the subject is not in the prose, so the report surfaces it on the
 * location line ("file:line - item", src/report/format.js). A `hint` (a separate
 * DETAIL, e.g. a version or URL) is always appended after that, so a finding with
 * both renders "file:line - item - hint". See FindingOpts in report/finding.js.
 * @param {import("./finding.js").Finding[]} findings
 * @param {import("../checks/registry.js").Registry} registry
 */
export function renderFindings(findings, registry) {
  for (const f of findings) {
    const template = registry.responseFor(f.ruleId);
    f.message = fill(template, f.item, f.data) ?? f.message;
    f.listItem =
      f.item != null && template != null && !template.includes(PLACEHOLDER);
    // How its entry asks for repeats to be LISTED, resolved here beside the other two
    // display decisions rather than where the review is numbered - orderReview reads it
    // off the item and needs no registry, so its six callers cannot order differently.
    f.collapse = registry.collapseOf(f.ruleId);
  }
}

/**
 * Every to-do item a REVIEWER answers, with each one's default note appended to the
 * response that ends on a list.
 *
 * Applied to the two kinds together - a check's escalation and a by-hand manual check are
 * one item with two origins - because the rule is about what a reviewer is handed, not
 * about where the entry was declared. Written once here rather than in each renderer: one
 * renderer appending it and another not is a reviewer reading a list introduction with
 * nothing beneath it.
 *
 * Null in, null out: a check that authors no response has nothing to append to, and one
 * that authors no default note keeps its response as written.
 * @param {import("./finding.js").ManualItem[]} items
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {import("./finding.js").ManualItem[]}
 */
export function withDefaultNotes(items, registry) {
  return items.map((item) => {
    const note = registry.defaultNote(item.ruleId);
    return item.response && note
      ? { ...item, response: `${item.response}\n\n${note}` }
      : item;
  });
}

/**
 * Resolve manual-review refs to ManualItems: the owning entry's title plus its
 * `instructions`, filled with the case
 * item and any `data` slots (e.g. a reason). The ref's locus (file/loc/item) is
 * carried through, and `listItem` is set exactly as for findings - so the report
 * can list "file:line - item" under an item-free instructions message.
 * @param {{ruleId: string, item: ?string, file?: ?string, loc?: object|null,
 *   section?: ?string, hint?: ?string,
 *   data?: Record<string, string|number>|null}[]} refs
 * @param {import("../checks/registry.js").Registry} registry
 * @returns {import("./finding.js").ManualItem[]}
 */
export function renderManualItems(refs, registry) {
  return refs.map((ref) => {
    const entry = registry.checkEntry(ref.ruleId);
    // One wording per READER, both resolved here. instructionsFor raises if the check
    // authors nothing a person could read, which an escalation always must.
    const template = registry.instructionsFor(ref.ruleId);
    const llmTemplate = registry.llmInstructionsFor(ref.ruleId);
    return {
      title: entry?.title ?? ref.ruleId,
      // The person's. Read by the report's own entry body and by the question a reviewer
      // is asked, which is what keeps those two saying one sentence.
      instructions: fill(template, ref.item, ref.data) ?? "",
      // The agent's, and null for a check that authors none - a question only a person
      // can answer. Filled from the same values, so a slot resolves the same either way.
      llmInstructions: llmTemplate
        ? (fill(llmTemplate, ref.item, ref.data) ?? null)
        : null,
      // The developer-facing response (printed under the instructions). Filled like
      // the instructions. Every escalation carries one: once a reviewer settles the
      // case against the add-on, this is the text that goes to the developer, so
      // withholding it would leave them with a decision and nothing to send.
      //
      // A check whose report IS what the reviewer found ends its response on a list, and
      // the `default-note` that stands in that list is appended by withDefaultNotes -
      // which sees this list and the by-hand manual checks together, so the two cannot
      // differ in what a reviewer is handed.
      response: fill(entry?.response, ref.item, ref.data),
      // The band a reported case lands in, printed above that response. Null for a
      // check whose cases produce no finding however they are settled.
      verdict: registry.suggestedVerdict(ref.ruleId),
      // The slot values behind {{name}} in the texts above. Kept so a REPORTED case
      // can be re-resolved as a finding from the same inputs (src/report/verdicts.js)
      // rather than from the already-rendered prose.
      data: ref.data ?? null,
      // Carried so the text report can label the item's file:line by artifact
      // ([XPI]/[SCA]) via ruleInputs - the corpus the owning check acts on. Without
      // it a non-manifest manual item has no ruleId and defaults to [SCA].
      ruleId: ref.ruleId,
      // Which of the two extended sections this is listed under, from the reader the
      // owning check authored wording for. The report groups on this.
      section: ref.section ?? null,
      file: ref.file ?? null,
      loc: ref.loc ?? null,
      item: ref.item ?? null,
      // Per-locus suffix shown after file:line (like a finding's hint), e.g. a
      // transmission method - independent of `item`/`listItem`.
      hint: ref.hint ?? null,
      listItem:
        ref.item != null && template != null && !template.includes(PLACEHOLDER),
      // As for findings: the entry's `collapse`, carried on the item so the sequence
      // that numbers the review reads it here rather than looking the check up again.
      collapse: registry.collapseOf(ref.ruleId),
    };
  });
}
