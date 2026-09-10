// Renders a finished review (findings + metadata) as either human-readable text
// or JSON. Text goes to stdout so it can be read directly. JSON is
// machine-consumable for CI.
//
// Belongs here: report LAYOUT and chrome - the ReviewMeta typedef, section
// titles, ordering/sorting, line wrapping, the summary line, and the text +
// JSON serialization (including stripping the internal data and the human-only
// manualReview from JSON). Section/structural strings are code-owned here.
//
// Does NOT belong here: per-finding review wording - resolving ruleId/item into
// a `message` is the resolver's job (src/report/responses.js), and that prose
// lives in assets/registry.yaml. The finding data shape is defined in
// src/report/finding.js. Verdict/escalation decisions live in
// src/checks/escalation.js. Reuse the shared sortKeys/canonicalJson helpers in
// src/util/json.js rather than adding JSON utilities here.

import {
  SEVERITY,
  SEVERITY_ORDER,
  sortFindings,
  countByRule,
  hasErrors,
} from "./finding.js";
import { artifactLabel } from "./artifact.js";
import { red, yellow, blue, brightCyan, grey } from "../util/color.js";
import { displayLine, wrapText } from "../util/text.js";
import { MAX_ENTRIES_PER_CATEGORY } from "../config.js";

/** @param {string} s @returns {string} */
const identity = (s) => s;

// On an interactive screen, error findings are red and warnings yellow (info
// stays plain). A no-op unless the CLI enabled color (color.js).
const SEV_COLOR = {
  [SEVERITY.ERROR]: red,
  [SEVERITY.WARNING]: yellow,
  [SEVERITY.INFO]: identity,
};

/**
 * @typedef {object} ReviewResult
 * @property {import("./finding.js").Finding[]} findings
 * @property {ReviewMeta} meta   Run metadata (addon path, schema source, etc.).
 * @property {Record<string, string>} [issueHeadings]  Per-severity Issues
 *   headings ({ error?, warning?, info? }), registry-owned.
 * @property {Record<string, string>} [verdictIntros]  Issues-section preamble
 *   ({ none?, feedback?, rejected? }), registry-owned.
 * @property {string} [mode]  Review mode ("sca" | "xpi"). In "sca" each finding's
 *   file:line is labelled by artifact ([XPI]/[SCA]) and the Issues section gets a
 *   legend footer; XPI reviews add neither. See src/report/artifact.js.
 * @property {Map<string, string>} [ruleInputs]  ruleId -> routed input
 *   ("xpi"|"build"|"source"|"manifest"), from registry.checkInputs(); the artifact label reads it.
 */

/**
 * @typedef {object} ReviewMeta
 * @property {string} action
 * @property {string} addon
 * @property {"dir"|"zip"} [addonKind]
 * @property {boolean} reviewed
 * @property {string} [schemaBranch]
 * @property {string} [schemaSource]
 * @property {string} [schemaChannel]  The auto-detected schema channel used.
 * @property {string} [applicationVersion]
 * @property {number} [manifestVersion]
 * @property {string[]} [checksRun]  Ids of the checks that ran.
 * @property {import("./finding.js").ManualItem[]} [manualReview]  The manual-review
 *   to-do list, each item tagged with `extended` (it escalated from a check) and
 *   `manualReview` (reading the code cannot settle it). The report splits it into
 *   three sections on those two tags - see buckets(). Text-only; dropped from JSON.
 */

/**
 * Render the review result as human-readable text.
 *
 * @param {ReviewResult} review
 * @returns {string}
 */
export function formatText(review) {
  const manual = review.meta.manualReview ?? [];
  const counts = bucketCounts(manual);
  // The complete text report: the body, then the verdict tally LAST, so the verdict
  // closes the report.
  const lines = [
    ...reviewBodyLines(review),
    ...summaryLines(review.findings, counts),
  ];
  // The "Reviewing …" header is now printed live before the review
  // (src/pipeline.js), not here, so drop the blank that section() prepends to
  // the first (Issues) section, opening the report body at "── Issues ──".
  if (lines[0] === "") {
    lines.shift();
  }
  return lines.join("\n");
}

/**
 * The report body lines - Issues, the three manual-review sections, and the ATN tail
 * - WITHOUT the trailing Summary tally. The findings here are issues only; the
 * manual-review to-dos live in meta.manualReview and are split by buckets().
 * @param {ReviewResult} review
 * @returns {string[]}
 */
function reviewBodyLines(review) {
  const {
    findings: issues,
    meta,
    issueHeadings,
    verdictIntros,
    mode,
    ruleInputs,
  } = review;
  const manual = meta.manualReview ?? [];
  // Three buckets. An escalation a reviewer can settle by reading the code is a code
  // review step; one needing information from outside the package, an action only a
  // person can take, or a decision a person must own is a manual one. The standard
  // list is the checks done by hand on every submission, escalated or not.
  const { code, extendedManual, standard } = buckets(manual);
  // The artifact label ([XPI]/[SCA]) for one finding/manual item's file:line - "" in
  // an XPI review (one artifact). Applied wherever locationLine renders a locus.
  const labelOf = (f) =>
    artifactLabel({ file: f.file, input: ruleInputs?.get(f.ruleId), mode });
  return [
    ...issuesLines(issues, issueHeadings, verdictIntros, labelOf, mode),
    ...manualSection(code, "Extended code review", brightCyan, labelOf),
    ...manualSection(
      extendedManual,
      "Extended manual review",
      brightCyan,
      labelOf
    ),
    ...manualSection(standard, "Standard manual review", blue, labelOf),
  ];
}

/**
 * Header: what ran, against which schema.
 * @param {ReviewMeta} meta
 * @returns {string[]}
 */
export function headerLines(meta) {
  return [
    `Reviewing ${meta.addon}`,
    `schema ${meta.schemaBranch} · Thunderbird ${meta.applicationVersion ?? "?"}` +
      (meta.manifestVersion != null
        ? ` · manifest_version ${meta.manifestVersion}`
        : ""),
  ];
}

/**
 * Issues: one numbered entry per distinct message (see renderGroup and
 * groupByMessage) - the response printed VERBATIM, then its "- file:line"
 * locations. Grouped by severity under registry-defined headings (numbering
 * continuous across the severity groups) when headings are supplied, otherwise
 * a single flat list.
 *
 * A registry-owned verdict preamble opens the section: with no findings it is
 * the whole body (`verdictIntros.none`). With findings it is `rejected` (any
 * error) or `feedback` (warnings/info only), glued directly to the FIRST
 * severity heading - one space, no blank line - and printed verbatim (no
 * rewrap), like the findings below it.
 * @param {import("./finding.js").Finding[]} issues
 * @param {Record<string, string>} [issueHeadings]
 * @param {Record<string, string>} [verdictIntros]
 * @param {(f: import("./finding.js").Finding) => string} [labelOf]  Artifact label
 *   ([XPI]/[SCA]) for a finding's file:line, "" when none (see reviewBodyLines).
 * @param {string} [mode]  Review mode; "sca" appends the label legend footer.
 * @returns {string[]}
 */
function issuesLines(issues, issueHeadings, verdictIntros, labelOf, mode) {
  const out = section("Issues");
  const intros = verdictIntros ?? {};
  if (issues.length === 0) {
    out.push(intros.none ?? "The automated review did not find any issues.");
    return out;
  }
  // One preamble for the whole section, glued onto the first rendered heading.
  const intro = hasErrors(issues) ? intros.rejected : intros.feedback;
  if (issueHeadings) {
    let n = 0;
    let first = true;
    for (const sev of SEVERITY_ORDER) {
      const group = sortFindings(issues.filter((f) => f.severity === sev));
      if (group.length === 0) {
        continue;
      }
      const tint = SEV_COLOR[sev] ?? identity;
      out.push("");
      const heading = issueHeadings[sev];
      const text = first && intro ? `${intro} ${heading ?? ""}` : heading;
      if (text) {
        // Verbatim, like the findings: no 80-column rewrap. The registry owns
        // the intro/heading wording on one line. Any authored break is kept.
        out.push(...text.split("\n").map(tint));
      }
      first = false;
      for (const entry of groupByMessage(group)) {
        out.push("");
        out.push(...renderGroup(++n, entry, labelOf));
      }
    }
  } else {
    groupByMessage(sortFindings(issues)).forEach((entry, i) => {
      if (i > 0) {
        out.push(""); // blank line between entries
      }
      out.push(...renderGroup(i + 1, entry, labelOf));
    });
  }
  // In an SCA review a finding's file:line is prefixed with the artifact it lives in;
  // a legend explains the labels. XPI reviews (one artifact) omit it.
  if (mode?.sca) {
    out.push("");
    out.push(grey("[XPI] = source file in the submitted XPI"));
    out.push(grey("[SCA] = source file in the submitted source code archive"));
  }
  // A pointer to the tool: the developer can run this same automated review before
  // submitting and fix the findings above first. Shown in both modes.
  out.push("");
  out.push(
    grey("You can run this automated review yourself before submitting:")
  );
  out.push(grey("https://github.com/thunderbird/webext-linter"));
  return out;
}

/**
 * Group findings that share an identical rendered `message` so a check that
 * fires many times (e.g. dozens of innerHTML sinks) shows its prose once, not
 * once per site. A Map preserves first-appearance order, and the input is
 * already sortFindings-ordered, so the groups and the locations within them
 * stay sorted. Findings whose message embeds the file (e.g. missing-library)
 * are simply singleton groups.
 * @param {import("./finding.js").Finding[]} findings
 * @returns {import("./finding.js").Finding[][]}
 */
function groupByMessage(findings) {
  const byMessage = new Map();
  for (const f of findings) {
    const bucket = byMessage.get(f.message);
    if (bucket) {
      bucket.push(f);
    } else {
      byMessage.set(f.message, [f]);
    }
  }
  return [...byMessage.values()];
}

/**
 * The display-capped locus lines for a group: ` - file:line` (with the artifact
 * label and any per-locus hint), then an "(+N more)" marker when the count exceeds
 * the per-category cap. Shared by the Issues entries and the manual-review sections.
 * @param {object[]} items  Findings or manual items, each with file/loc(/hint).
 * @param {(x: object) => string} [labelOf]  Artifact label prefix (SCA only).
 * @returns {string[]}
 */
function renderLocusList(items, labelOf) {
  const lines = [];
  for (const x of items.slice(0, MAX_ENTRIES_PER_CATEGORY)) {
    lines.push(` - ${locationLine(x, labelOf?.(x))}`);
  }
  if (items.length > MAX_ENTRIES_PER_CATEGORY) {
    lines.push(excludedMarker(items.length - MAX_ENTRIES_PER_CATEGORY));
  }
  return lines;
}

/**
 * Render one Issues entry: the shared registry response VERBATIM (no 80-column
 * rewrap, no hanging indent - a long line runs off, and the registry's own
 * break before "Read more:" lands at column 0), then one location line per finding that
 * HAS one (see hasLocus - an entry whose subject is the submission as a whole has none,
 * and renders as the message alone). The locus has up to two parts: `locationLine`
 * surfaces the SUBJECT (`item`) after "file:line" when the message did not name it
 * (`listItem`), then the DETAIL (`hint`) is appended after " - " - so a finding with
 * both renders "file:line - item - hint". Manual review still wraps - see manualLines.
 * @param {number} n  1-based entry number.
 * @param {import("./finding.js").Finding[]} findings  All sharing one message.
 * @param {(f: import("./finding.js").Finding) => string} [labelOf]  Artifact label.
 * @returns {string[]}
 */
function renderGroup(n, findings, labelOf) {
  const [first, ...rest] = findings[0].message.split("\n");
  const lines = [`${n}) ${first}`, ...rest];
  lines.push(...renderLocusList(findings.filter(hasLocus), labelOf));
  // Tint the whole entry by severity (error red, warning yellow) - a no-op
  // unless the CLI enabled color. Each line is tinted on its own, so the color
  // resets per line and stripColor cleans the --report-out copy.
  const tint = SEV_COLOR[findings[0].severity] ?? identity;
  return lines.map(tint);
}

/**
 * The capped-list marker that closes a grouped entry whose location list was
 * truncated to MAX_ENTRIES_PER_CATEGORY: a final "- ..." line standing in for
 * the omitted locations. Display only - the summary counts and JSON still see
 * every finding (see MAX_ENTRIES_PER_CATEGORY in src/config.js).
 * @param {number} n  How many locations were omitted.
 * @returns {string}
 */
function excludedMarker(n) {
  return ` - … and ${n} more, excluded from this list`;
}

/**
 * The "Title: instructions" line of a manual item (its grouping key).
 * @param {import("./finding.js").ManualItem} m
 * @returns {string}
 */
function manualBody(m) {
  return m.instructions
    ? `${m.title}: ${m.instructions.replace(/\s+/g, " ").trim()}`
    : m.title;
}

/**
 * One manual-review section under `title`. Items sharing a "Title: instructions"
 * body collapse into one numbered entry (like Issues) - the body is still
 * 80-column wrapped. When the entry has a developer-facing `response`, it is
 * labelled "Suggested response:" and printed under the instructions in dim grey,
 * flush-left and verbatim (a ready-to-send block) so it does not pull focus
 * from the blue instructions. Each item that carries a locus is then listed
 * beneath as "- file:line - item", in the same grey as the response. Standalone
 * reminders (no locus) carry no list. Returns [] when there are no items, so an
 * absent section prints nothing.
 * @param {import("./finding.js").ManualItem[]} items
 * @param {string} title  Section heading, e.g. "Extended manual review".
 * @returns {string[]}
 */
function manualSection(items, title, accent = blue, labelOf) {
  if (!items.length) {
    return [];
  }
  const out = section(title);
  out.push("");
  // A manual-review section is all manual work, so it is all the section's accent
  // color (a no-op unless color is enabled) - Extended uses a vivid cyan, distinct
  // from Standard's blue, so the two are easy to tell apart. Each line is tinted on
  // its own for stripColor.
  out.push(accent("Continue manual review for the following checks:"));
  const byBody = new Map();
  for (const m of items) {
    const body = manualBody(m);
    const bucket = byBody.get(body);
    if (bucket) {
      bucket.push(m);
    } else {
      byBody.set(body, [m]);
    }
  }
  let n = 0;
  for (const [body, group] of byBody) {
    out.push("");
    // The reviewer-facing instructions (the section's accent, 80-col wrapped).
    out.push(...wrapText(`${++n}) ${body}`).map(accent));
    // The developer-facing response, if any: labelled "Suggested response:" and
    // printed in dim grey, flush-left at column 0 (verbatim, like the Issues
    // responses), sitting between the instructions and the locus list so it
    // reads as a ready-to-send block without pulling focus from the blue
    // instructions. Shared across the group, so taken from the first item.
    const response = group[0].response;
    if (response) {
      const lines = response.split("\n");
      lines[0] = `Suggested response: ${lines[0]}`;
      for (const line of lines) {
        out.push(grey(line));
      }
    }
    // List a locus only when there is one (escalated items). Standalone
    // reminders have no file/item and render as the wrapped body alone. The
    // list is display-capped like Issues (see renderGroup). Tinted in the same
    // grey as the response (not the instructions' blue), so it reads as detail.
    const loci = group.filter(hasLocus);
    out.push(...renderLocusList(loci, labelOf).map(grey));
  }
  return out;
}

/**
 * Summary: issue counts by severity plus one count per manual-review section, in the
 * body's section order (code review, manual review, then the always-shown checklist).
 * @param {import("./finding.js").Finding[]} issues
 * @param {{code: number, manual: number, standard: number}} counts
 * @returns {string[]}
 */
function summaryLines(issues, counts) {
  const c = tally(issues);
  const out = section("Summary");
  out.push("");
  out.push(
    `${c.error} error(s), ${c.warning} warning(s), ${c.info} info, ` +
      `${counts.code} extended code review step(s), ` +
      `${counts.manual} extended manual review step(s), ` +
      `${counts.standard} standard manual review step(s)`
  );
  return out;
}

/**
 * How many to-dos fall in each of the three buckets, for the Summary tally.
 * @param {import("./finding.js").ManualItem[]} manual
 * @returns {{code: number, manual: number, standard: number}}
 */
function bucketCounts(manual) {
  const b = buckets(manual);
  return {
    code: b.code.length,
    manual: b.extendedManual.length,
    standard: b.standard.length,
  };
}

/**
 * Split the to-do list into its three sections. The ONE definition of the buckets, so
 * the printed sections and the Summary tally can never disagree about them.
 * @param {import("./finding.js").ManualItem[]} manual
 * @returns {{code: ManualItem[], extendedManual: ManualItem[], standard: ManualItem[]}}
 */
function buckets(manual) {
  return {
    code: manual.filter((m) => m.extended && m.section !== "manual-review"),
    extendedManual: manual.filter(
      (m) => m.extended && m.section === "manual-review"
    ),
    standard: manual.filter((m) => !m.extended),
  };
}

/**
 * Render the review result as JSON.
 *
 * @param {ReviewResult} review
 * @returns {string}
 */
export function formatJson(review) {
  // The manual-review to-do list is human-only, not
  // machine-verifiable, so they are dropped from JSON (ATN consumes this for
  // auto-verification). findings are already issues only.
  const { manualReview: _omitted, ...meta } = review.meta;
  const issues = review.findings;
  // `data` (template-resolution input, baked into `message`) and `listItem` (a
  // text-layout flag) are internal, so they are dropped from the machine output.
  // Consumed by tooling rather than a terminal, but a consumer may print it, so the
  // submission-derived fields carry no more than the text report shows.
  const publicFindings = sortFindings(issues).map(
    ({ data: _d, listItem: _li, ...f }) => ({
      ...f,
      ...(f.file == null ? {} : { file: displayLine(f.file) }),
      ...(f.item == null ? {} : { item: displayLine(f.item) }),
      ...(f.hint == null ? {} : { hint: displayLine(f.hint) }),
    })
  );
  return JSON.stringify(
    {
      meta,
      summary: { ...tally(issues), byRule: countByRule(issues) },
      findings: publicFindings,
    },
    null,
    2
  );
}

/**
 * Return a titled section header preceded by a blank line.
 *
 * @param {string} title
 * @returns {string[]}
 */
function section(title) {
  return ["", `── ${title} ──`];
}

/**
 * The whole location line listed under an Issue: the path ("file:line", ":line" only
 * when a line is known), then the finding's identifier when its message did not consume
 * it (`listItem`), then the supplementary detail (`hint`) - each joined by " - ". With no
 * path at all whichever of those exists leads instead; hasLocus guarantees at least one
 * does, so there is nothing to stand in for.
 *
 * A segment equal to one already on the line is DROPPED rather than printed twice. A
 * check whose subject is its own locus repeats the path otherwise - an untrusted library
 * with no identified name falls back to its path, and the line read
 * "lib/x.js - lib/x.js - <source>". The guard lives here, not in the rules, so no rule
 * can reintroduce it and none has to know that its subject might BE the locus. The
 * finding still carries both fields: this decides what is printed, not what is recorded,
 * so the JSON report is unchanged.
 *
 * In an SCA review a `[XPI] `/`[SCA] ` artifact label prefixes the file (only when
 * there is a file - an item-only locus names no path to disambiguate).
 * @param {import("./finding.js").Finding} f
 * @param {string} [label]  Artifact label ("XPI"/"SCA"), or "" for none.
 * @returns {string}
 */
function locationLine(f, label = "") {
  // The path comes from an archive entry name, and the item and hint from the
  // submission, so all three are made safe to show. The label is ours.
  const file = f.file ? displayLine(f.file) : null;
  const where = file
    ? `${label ? `[${label}] ` : ""}${file}${f.loc?.line != null ? `:${f.loc.line}` : ""}`
    : null;
  // Compared against the bare path, not `where`: the label and :line are ours, and it is
  // the path a subject repeats.
  const seen = new Set(file ? [file] : []);
  const segments = where ? [where] : [];
  for (const value of [f.listItem ? f.item : null, f.hint]) {
    const text = value == null ? "" : displayLine(value);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    segments.push(text);
  }
  return segments.join(" - ");
}

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
function hasLocus(x) {
  return Boolean(x.file || (x.listItem && x.item) || x.hint);
}

/**
 * Count findings by severity.
 *
 * @param {import("./finding.js").Finding[]} findings
 * @returns {{error: number, warning: number, info: number}}
 */
function tally(findings) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }
  return counts;
}

/**
 * Render the review result in the requested format.
 *
 * @param {ReviewResult} review
 * @param {"text"|"json"} format
 * @returns {string}
 */
export function formatReview(review, format) {
  return format === "json" ? formatJson(review) : formatText(review);
}
