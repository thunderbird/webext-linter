// Unit tests for the text / JSON report renderers.

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatText, formatJson } from "../../src/report/format.js";

function review() {
  return {
    findings: [],
    meta: {
      action: "review",
      addon: "x",
      reviewed: false,
      manualReview: [
        {
          title: "Source Archive required",
          instructions: "Confirm sources were uploaded and rebuild matches.",
        },
      ],
    },
  };
}

// Text render surfaces the Manual review header, the "continue manual review"
// heading, and each item as an enumerated "N) title: instructions" entry, so a
// human knows both what to check (e.g. Source Archive) and how.
test("text report includes the Manual review section", () => {
  const out = formatText(review());
  // A blank line sits between the header and the "Continue ..." intro.
  assert.match(out, /── Manual review ──\n\nContinue manual review/);
  assert.match(
    out,
    /1\) Source Archive required: Confirm sources were uploaded and rebuild matches\./
  );
});

// JSON render drops manualReview entirely - both the meta key and the item
// title are absent - since automated consumers should not see manual steps.
test("JSON output omits manual-review items (ATN auto-verification)", () => {
  const json = JSON.parse(formatJson(review()));
  assert.equal(json.meta.manualReview, undefined);
  assert.ok(!formatJson(review()).includes("Source Archive required"));
});

// The report keeps issues (findings) and manual-review items in separate lists:
// a manual item shows under Manual review (title: instructions), an issue under
// Issues, and JSON carries the issue but drops the manual list.
test("issues render under Issues/JSON; manual items under Manual review", () => {
  const r = {
    findings: [
      {
        ruleId: "eval-usage",
        severity: "error",
        message: "eval used",
        file: "bg.js",
        loc: { line: 2 },
        item: null,
        hint: null,
      },
    ],
    meta: {
      action: "review",
      addon: "x",
      reviewed: true,
      manualReview: [
        {
          title: "old.js",
          instructions: "old.js may be loaded dynamically - confirm by hand.",
        },
      ],
    },
  };
  const out = formatText(r);
  assert.match(out, /old\.js: old\.js may be loaded dynamically/); // Manual review
  const issuesSection = out
    .split("── Issues ──")[1]
    .split("── Manual review ──")[0];
  assert.ok(!issuesSection.includes("old.js")); // not in Issues
  assert.match(issuesSection, /bg\.js:2 - eval used/);
  assert.match(
    out,
    /1 error\(s\), 0 warning\(s\), 0 info, 1 manual review step\(s\)/
  );
  const json = JSON.parse(formatJson(r));
  assert.equal(json.findings.length, 1);
  assert.equal(json.findings[0].ruleId, "eval-usage");
  assert.equal(json.meta.manualReview, undefined);
});

// When reviewing with issueHeadings, the Issues section groups findings by
// severity (error, then warning, then info) under each heading, with numbering
// continuous across the groups.
test("Issues are grouped by severity under headings with continuous numbering", () => {
  const mk = (severity, message, file, line) => ({
    ruleId: "r",
    severity,
    message,
    file,
    loc: line != null ? { line } : null,
    item: null,
    responseTitle: null,
    manualReview: false,
  });
  const r = {
    findings: [
      mk("warning", "warn one", "b.js", 2),
      mk("error", "err two", "a.js", 5),
      mk("info", "info one", "c.js", null),
      mk("error", "err one", "a.js", 1),
    ],
    meta: { action: "review", addon: "x", reviewed: true },
    issueHeadings: {
      error: "ERR HEADING:",
      warning: "WARN HEADING:",
      info: "INFO HEADING:",
    },
  };
  const out = formatText(r);
  // Continuous numbering, errors first (sorted by line within the group), then
  // the warning, then the info.
  assert.match(out, /1\) a\.js:1 - err one/);
  assert.match(out, /2\) a\.js:5 - err two/);
  assert.match(out, /3\) b\.js:2 - warn one/);
  assert.match(out, /4\) \(add-on\) - info one|4\) c\.js - info one/);
  // Headings appear in severity order, above their group.
  assert.ok(
    out.indexOf("ERR HEADING:") < out.indexOf("WARN HEADING:") &&
      out.indexOf("WARN HEADING:") < out.indexOf("INFO HEADING:")
  );
  assert.ok(out.indexOf("ERR HEADING:") < out.indexOf("1) a.js:1"));
  // A blank line sits between the Summary header and its counts line.
  assert.match(
    out,
    /── Summary ──\n\n2 error\(s\), 1 warning\(s\), 1 info, 0 manual review step\(s\)/
  );
});

// ---- verdict intros (the Issues-section preamble) ----
// A registry-owned preamble opens the Issues section: `none` is the whole body
// when empty, else `rejected` (any error) / `feedback` (warnings/info only) is
// glued to the FIRST severity heading - one space, no blank line.
const mkFinding = (severity, message, file = "a.js", line = 1) => ({
  ruleId: "r",
  severity,
  message,
  file,
  loc: line != null ? { line } : null,
  item: null,
  hint: null,
});
const withReview = (findings, verdictIntros) => ({
  findings,
  meta: { action: "review", addon: "x", reviewed: true },
  issueHeadings: { error: "ERR:", warning: "WARN:", info: "INFO:" },
  verdictIntros,
});

test("empty review shows the registry 'none' intro as the Issues body", () => {
  const out = formatText(withReview([], { none: "NONE-MSG" }));
  assert.match(out, /── Issues ──\nNONE-MSG/);
});

test("an error finding glues the 'rejected' intro to the first heading", () => {
  const out = formatText(
    withReview([mkFinding("error", "boom")], {
      rejected: "REJECTED-MSG",
      feedback: "FEEDBACK-MSG",
    })
  );
  assert.match(out, /REJECTED-MSG ERR:/); // glued with one space
  assert.ok(!out.includes("FEEDBACK-MSG"));
});

test("warnings/info only glue the 'feedback' intro to the first heading", () => {
  const out = formatText(
    withReview(
      [mkFinding("warning", "w", "b.js", 2), mkFinding("info", "i", "c.js", 3)],
      { rejected: "REJECTED-MSG", feedback: "FEEDBACK-MSG" }
    )
  );
  assert.match(out, /FEEDBACK-MSG WARN:/);
  assert.ok(!out.includes("REJECTED-MSG"));
});

test("an error among warnings shows only 'rejected'; later headings stay plain", () => {
  const out = formatText(
    withReview(
      [mkFinding("error", "e"), mkFinding("warning", "w", "b.js", 2)],
      {
        rejected: "REJECTED-MSG",
        feedback: "FEEDBACK-MSG",
      }
    )
  );
  assert.match(out, /REJECTED-MSG ERR:/);
  assert.ok(!out.includes("FEEDBACK-MSG"));
  assert.match(out, /\nWARN:/); // warning heading rendered, no intro glued
  assert.ok(out.indexOf("REJECTED-MSG") < out.indexOf("WARN:"));
});
