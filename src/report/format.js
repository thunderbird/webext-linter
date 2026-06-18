// Renders a finished review (findings + metadata) as either human-readable text
// or JSON. Text goes to stdout so it can be read directly. JSON is
// machine-consumable for CI.
//
// Belongs here: report LAYOUT and chrome - the ReviewMeta typedef, section
// titles, ordering/sorting, line wrapping, the summary line, and the text +
// JSON serialization (including stripping the internal data and the
// human-only manualReview from JSON). Section/structural strings are code-owned
// here.
//
// Does NOT belong here: per-finding review wording - resolving ruleId/item into
// a `message` is the resolver's job (src/report/responses.js), and that prose
// lives in assets/registry.yaml. The finding data shape is defined in
// src/report/finding.js. Verdict/escalation decisions live in
// src/checks/escalation.js. Reuse the shared sortKeys/canonicalJson helpers in
// src/util/json.js rather than adding JSON utilities here.

import { SEVERITY, sortFindings, countByRule, hasErrors } from "./finding.js";
import { red, yellow, blue, white } from "../util/color.js";
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
 */

/**
 * @typedef {object} ReviewMeta
 * @property {string} action
 * @property {string} addon
 * @property {"dir"|"zip"} [addonKind]
 * @property {boolean} reviewed
 * @property {string} [schemaBranch]
 * @property {string} [schemaSource]
 * @property {string|null} [schemaChannel]  Channel used (null for --schema-zip).
 * @property {string} [applicationVersion]
 * @property {number} [manifestVersion]
 * @property {string[]} [checksRun]  Ids of the checks that ran.
 * @property {string} [reviewUrl]  ATN reviewer review-page URL, appended to the
 *   Manual review section. Text reports only; dropped from JSON.
 * @property {import("./finding.js").ManualItem[]} [manualReview]  The single
 *   manual-review to-do list (the pipeline merges manual-checks, whole-check
 *   escalations and per-item escalations into it). Text-only; dropped from JSON.
 */

/**
 * Render the review result as human-readable text.
 *
 * @param {ReviewResult} review
 * @returns {string}
 */
export function formatText(review) {
  const { findings: issues, meta, issueHeadings, verdictIntros } = review;
  // The findings here are issues only - the manual-review to-dos live in
  // meta.manualReview (the pipeline routed every kind into it). Section order
  // below is the pipeline order.
  const manual = meta.manualReview ?? [];
  return [
    ...headerLines(meta),
    ...issuesLines(issues, issueHeadings, verdictIntros),
    ...manualLines(manual, meta.reviewUrl),
    ...summaryLines(issues, manual.length),
  ].join("\n");
}

/**
 * Header: what ran, against which schema.
 * @param {ReviewMeta} meta
 * @returns {string[]}
 */
function headerLines(meta) {
  const schema = meta.schemaBranch || meta.schemaSource;
  return [
    `Reviewing ${meta.addon}`,
    `schema ${schema} · Thunderbird ${meta.applicationVersion ?? "?"}` +
      (meta.manifestVersion != null
        ? ` · manifest_version ${meta.manifestVersion}`
        : ""),
  ];
}

/**
 * Issues: one numbered entry per distinct message (see renderGroup/groupByMessage)
 * - the response printed VERBATIM, then its "- file:line" locations. Grouped by
 * severity under registry-defined headings (numbering continuous across the
 * severity groups) when headings are supplied, otherwise a single flat list.
 *
 * A registry-owned verdict preamble opens the section: with no findings it is
 * the whole body (`verdictIntros.none`); with findings it is `rejected` (any
 * error) or `feedback` (warnings/info only), glued directly to the FIRST
 * severity heading - one space, no blank line - and printed verbatim (no
 * rewrap), like the findings below it.
 * @param {import("./finding.js").Finding[]} issues
 * @param {Record<string, string>} [issueHeadings]
 * @param {Record<string, string>} [verdictIntros]
 * @returns {string[]}
 */
function issuesLines(issues, issueHeadings, verdictIntros) {
  const out = section("Issues");
  const intros = verdictIntros ?? {};
  if (issues.length === 0) {
    out.push(intros.none ?? "No issues found.");
    return out;
  }
  // One preamble for the whole section, glued onto the first rendered heading.
  const intro = hasErrors(issues) ? intros.rejected : intros.feedback;
  if (issueHeadings) {
    let n = 0;
    let first = true;
    for (const sev of [SEVERITY.ERROR, SEVERITY.WARNING, SEVERITY.INFO]) {
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
        // the intro/heading wording on one line; any authored break is kept.
        out.push(...text.split("\n").map(tint));
      }
      first = false;
      for (const entry of groupByMessage(group)) {
        out.push("");
        out.push(...renderGroup(++n, entry));
      }
    }
  } else {
    groupByMessage(sortFindings(issues)).forEach((entry, i) => {
      if (i > 0) {
        out.push(""); // blank line between entries
      }
      out.push(...renderGroup(i + 1, entry));
    });
  }
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
 * Render one Issues entry: the shared registry response VERBATIM (no 80-column
 * rewrap, no hanging indent - a long line runs off, and the registry's own break
 * before "Read more:" lands at column 0), then one location line per finding -
 * any remediation hint is appended to that line after " - ". Every entry uses
 * this form, so a unique message is just a one-location list.
 * (Manual review still wraps - see manualLines.)
 * @param {number} n  1-based entry number.
 * @param {import("./finding.js").Finding[]} findings  All sharing one message.
 * @returns {string[]}
 */
function renderGroup(n, findings) {
  const [first, ...rest] = findings[0].message.split("\n");
  const lines = [`${n}) ${first}`, ...rest];
  for (const f of findings.slice(0, MAX_ENTRIES_PER_CATEGORY)) {
    lines.push(` - ${locationLine(f)}${f.hint ? ` - ${f.hint}` : ""}`);
  }
  if (findings.length > MAX_ENTRIES_PER_CATEGORY) {
    lines.push(excludedMarker(findings.length - MAX_ENTRIES_PER_CATEGORY));
  }
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

/** The "Title: instructions" line of a manual item (its grouping key). */
function manualBody(m) {
  return m.instructions
    ? `${m.title}: ${m.instructions.replace(/\s+/g, " ").trim()}`
    : m.title;
}

/**
 * Manual review: the to-do list the pipeline assembled, ending (when known) with
 * the ATN review-page URL. Items sharing a "Title: instructions" body collapse
 * into one numbered entry (like Issues) - the body is still 80-column wrapped.
 * When the entry has a developer-facing `response`, it is printed under the
 * instructions in white, flush-left and verbatim (a ready-to-send block). Each
 * item that carries a locus is then listed beneath as "- file:line - item".
 * Standalone reminders (no locus) carry no list.
 * @param {import("./finding.js").ManualItem[]} manual
 * @param {string} [reviewUrl]  ATN reviewer review-page URL, or undefined.
 * @returns {string[]}
 */
function manualLines(manual, reviewUrl) {
  if (!manual.length) {
    return [];
  }
  const out = section("Manual review");
  out.push("");
  // The manual-review group is all manual work, so it is all blue (a no-op
  // unless color is enabled). Each line is tinted on its own for stripColor.
  out.push(blue("Continue manual review for the following checks:"));
  const byBody = new Map();
  for (const m of manual) {
    const body = manualBody(m);
    const bucket = byBody.get(body);
    if (bucket) {
      bucket.push(m);
    } else {
      byBody.set(body, [m]);
    }
  }
  let n = 0;
  for (const [body, items] of byBody) {
    out.push("");
    // The reviewer-facing instructions (blue, 80-col wrapped).
    out.push(...wrapEntry(++n, body).map(blue));
    // The developer-facing response, if any: white and flush-left at column 0
    // (verbatim, like the Issues responses), sitting between the instructions and
    // the locus list so it reads as a ready-to-send block. Shared across the
    // group, so taken from the first item.
    const response = items[0].response;
    if (response) {
      for (const line of response.split("\n")) {
        out.push(white(line));
      }
    }
    // List a locus only when there is one (escalated items); standalone
    // reminders have no file/item and render as the wrapped body alone. The
    // list is display-capped like Issues (see renderGroup).
    const where = [];
    const loci = items.filter((m) => m.file || (m.listItem && m.item));
    for (const m of loci.slice(0, MAX_ENTRIES_PER_CATEGORY)) {
      where.push(` - ${locationLine(m)}`);
    }
    if (loci.length > MAX_ENTRIES_PER_CATEGORY) {
      where.push(excludedMarker(loci.length - MAX_ENTRIES_PER_CATEGORY));
    }
    out.push(...where.map(blue));
  }
  // Last line of the section: where to complete the review (when resolved).
  if (reviewUrl) {
    out.push("");
    out.push(blue("Complete this review on ATN:"));
    out.push(blue(reviewUrl));
  }
  return out;
}

/**
 * Summary: issue counts by severity plus the manual-review step count.
 * @param {import("./finding.js").Finding[]} issues
 * @param {number} manualCount
 * @returns {string[]}
 */
function summaryLines(issues, manualCount) {
  const c = tally(issues);
  const out = section("Summary");
  out.push("");
  out.push(
    `${c.error} error(s), ${c.warning} warning(s), ${c.info} info, ${manualCount} manual review step(s)`
  );
  return out;
}

/**
 * Render the review result as JSON.
 *
 * @param {ReviewResult} review
 * @returns {string}
 */
export function formatJson(review) {
  // The manual-review to-do list and the reviewer URL are human-only, not
  // machine-verifiable, so they are dropped from JSON (ATN consumes this for
  // auto-verification). findings are already issues only.
  const { manualReview: _omitted, reviewUrl: _url, ...meta } = review.meta;
  const issues = review.findings;
  // `data` (template-resolution input, baked into `message`) and `listItem` (a
  // text-layout flag) are internal, so they are dropped from the machine output.
  const publicFindings = sortFindings(issues).map(
    ({ data: _d, listItem: _li, ...f }) => f
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
 * The location listed under an Issue: "file:line" ("(add-on)" when there is no
 * file, ":line" only when a line is known). When the finding's identifier was
 * not consumed by its message (`listItem`), append it: "file:line - item", or
 * show it alone when there is no file (e.g. a missing manifest key). This is how
 * the item-free, grouped checks surface the offending key/permission/path.
 *
 * @param {import("./finding.js").Finding} f
 * @returns {string}
 */
function locationLine(f) {
  const where = f.file
    ? `${f.file}${f.loc?.line != null ? `:${f.loc.line}` : ""}`
    : null;
  const item = f.listItem ? f.item : null;
  if (where && item) {
    return `${where} - ${item}`;
  }
  return where ?? item ?? "(add-on)";
}

/**
 * Render one numbered issue, wrapped at `width` columns with continuation lines
 * hanging-indented under the text (after the "N) " marker). A word longer
 * than the available width (e.g. a URL) is left on its own over-long line.
 *
 * @param {number} n  1-based issue number.
 * @param {string} body  "file:line - message" text.
 * @param {number} [width]
 * @returns {string[]}
 */
function wrapEntry(n, body, width = 80) {
  const firstPrefix = `${n}) `;
  const contIndent = " ".repeat(firstPrefix.length);
  const lines = [];
  let cur = firstPrefix;
  let started = false;
  for (const word of body.split(/\s+/).filter(Boolean)) {
    if (!started) {
      cur += word;
      started = true;
    } else if (cur.length + 1 + word.length <= width) {
      cur += ` ${word}`;
    } else {
      lines.push(cur);
      cur = contIndent + word;
    }
  }
  lines.push(cur);
  return lines;
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
