// Unit tests for the text / JSON report renderers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { VERDICT, REVIEW_MODE } from "../../src/lib/enum.js";

import {
  formatText,
  formatJson,
  formatReviewBody,
  formatSummary,
} from "../../src/report/format.js";

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

// Manual review splits into two sections - Extended (escalated checks) FIRST,
// then Standard (the always-by-hand manual-checks) - each with its "continue
// manual review" intro and enumerated "N) title: instructions" entries.
test("manual review splits into Extended then Standard sections", () => {
  const r = {
    findings: [],
    meta: {
      action: "review",
      addon: "x",
      reviewed: true,
      manualReview: [
        {
          title: "Source Archive required",
          instructions: "Confirm sources were uploaded and rebuild matches.",
          file: "x.js",
          loc: { line: 1 },
          item: null,
          listItem: false,
          extended: true,
        },
        {
          title: "Check the submission for spam",
          instructions: "Inspect it.",
          extended: false,
        },
      ],
    },
  };
  const out = formatText(r);
  const ext = out.indexOf("── Extended manual review ──");
  const std = out.indexOf("── Standard manual review ──");
  assert.ok(ext !== -1 && std !== -1 && ext < std); // Extended precedes Standard
  // A blank line sits between each header and its "Continue ..." intro.
  assert.match(out, /── Extended manual review ──\n\nContinue manual review/);
  assert.match(out, /── Standard manual review ──\n\nContinue manual review/);
  // The escalated item (with its locus) under Extended, the checklist item
  // (standalone reminder) under Standard.
  const extended = out.slice(ext, std);
  const standard = out.slice(std);
  assert.match(
    extended,
    /1\) Source Archive required: Confirm sources were uploaded and rebuild matches\./
  );
  assert.match(extended, /\n - x\.js:1/);
  assert.match(standard, /1\) Check the submission for spam: Inspect it\./);
});

// Manual review uses the Issues grouping: items sharing a "Title: instructions"
// body collapse into one entry, each locus listed beneath as "- file:line"; a
// standalone reminder (no locus) renders as the wrapped body alone.
test("Manual review groups by message and lists each item's locus", () => {
  const exfil = (file, line) => ({
    title: "User-data exfiltration",
    instructions: "Confirm opt-in.",
    file,
    loc: { line },
    item: null,
    listItem: false,
    extended: true,
  });
  const r = {
    findings: [],
    meta: {
      action: "review",
      addon: "x",
      reviewed: true,
      manualReview: [
        exfil("bg.js", 80),
        exfil("lib/x.js", 12),
        {
          title: "Check the submission for spam",
          instructions: "Inspect it.",
          extended: false,
        },
      ],
    },
  };
  const out = formatText(r);
  const extended = out
    .split("── Extended manual review ──")[1]
    .split("── Standard manual review ──")[0];
  const standard = out.split("── Standard manual review ──")[1];
  // The two exfiltration items (Extended) collapse into ONE entry with both loci.
  assert.equal(
    extended.match(/User-data exfiltration: Confirm opt-in\./g).length,
    1
  );
  assert.match(extended, /\n - bg\.js:80\n - lib\/x\.js:12/);
  // The standalone reminder is its own entry (Standard) with no locus line.
  assert.match(standard, /Check the submission for spam: Inspect it\./);
  assert.ok(!out.includes("(add-on)"));
});

// A manual entry's developer response prints under the instructions and above
// the locus list, flush-left at column 0 and verbatim (its own line breaks kept).
// An entry without a response is unchanged (no extra line).
test("Manual review prints the response between instructions and the locus list", () => {
  const r = {
    findings: [],
    meta: {
      action: "review",
      addon: "x",
      reviewed: true,
      manualReview: [
        {
          title: "Needs a privacy policy",
          instructions: "Confirm a policy exists.",
          response: "Please add a privacy policy.\nSee [1].",
          file: "bg.js",
          loc: { line: 4 },
          item: null,
          listItem: false,
          extended: true,
        },
        {
          title: "Forked add-on",
          instructions: "Check for a fork.",
          extended: true,
        },
      ],
    },
  };
  const manual = formatText(r).split("── Extended manual review ──")[1];
  // Response: after the instructions, before the locus, flush-left, verbatim.
  assert.match(
    manual,
    /Needs a privacy policy: Confirm a policy exists\.\nSuggested response: Please add a privacy policy\.\nSee \[1\]\.\n - bg\.js:4/
  );
  // The entry with no response carries no extra line.
  assert.match(manual, /Forked add-on: Check for a fork\./);
  assert.ok(!manual.includes("undefined"));
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
          extended: true,
        },
      ],
    },
  };
  const out = formatText(r);
  assert.match(out, /old\.js: old\.js may be loaded dynamically/); // Manual review
  const issuesSection = out
    .split("── Issues ──")[1]
    .split("── Extended manual review ──")[0];
  assert.ok(!issuesSection.includes("old.js")); // not in Issues
  // Message first, then the "- file:line" location beneath it.
  assert.match(issuesSection, /1\) eval used/);
  assert.match(issuesSection, /\n - bg\.js:2/);
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
  // the warning, then the info. Each distinct message is its own entry, with the
  // location listed beneath it.
  assert.match(out, /1\) err one\n - a\.js:1/);
  assert.match(out, /2\) err two\n - a\.js:5/);
  assert.match(out, /3\) warn one\n - b\.js:2/);
  assert.match(out, /4\) info one\n - c\.js/);
  // Headings appear in severity order, above their group.
  assert.ok(
    out.indexOf("ERR HEADING:") < out.indexOf("WARN HEADING:") &&
      out.indexOf("WARN HEADING:") < out.indexOf("INFO HEADING:")
  );
  assert.ok(out.indexOf("ERR HEADING:") < out.indexOf("1) err one"));
  // A blank line sits between the Summary header and its counts line.
  assert.match(
    out,
    /── Summary ──\n\n2 error\(s\), 1 warning\(s\), 1 info, 0 manual review step\(s\)/
  );
});

// Findings that share an identical message collapse to ONE numbered entry, the
// prose shown once with each location listed beneath it; a distinct message is
// its own entry. JSON stays ungrouped (grouping is a text-layout concern).
test("Issues group findings by identical message into one entry", () => {
  const mk = (message, file, line) => ({
    ruleId: "r",
    severity: "warning",
    message,
    file,
    loc: { line },
    item: null,
    hint: null,
  });
  const r = {
    findings: [
      mk("same message", "a.js", 10),
      mk("other message", "b.js", 1),
      mk("same message", "a.js", 20),
      mk("same message", "c.js", 5),
    ],
    meta: { action: "review", addon: "x", reviewed: true },
  };
  const out = formatText(r);
  const issues = out.split("── Issues ──")[1].split("── Summary ──")[0];
  // The shared prose appears exactly once, as one entry listing all 3 locations.
  assert.equal(issues.match(/same message/g).length, 1);
  assert.match(
    issues,
    /\d\) same message\n - a\.js:10\n - a\.js:20\n - c\.js:5/
  );
  // The distinct message is its own entry.
  assert.match(issues, /\d\) other message\n - b\.js:1/);
  // JSON is ungrouped: every finding is still present.
  assert.equal(JSON.parse(formatJson(r)).findings.length, 4);
});

// When the message did not consume {{item}} (listItem), the identifier is shown
// on the location line: "file:line - item", or the bare item when there is no
// file. An item with listItem=false (already in the message) is NOT appended.
test("Issues list the identifier on the location line when listItem is set", () => {
  const mk = (file, line, item, listItem) => ({
    ruleId: "r",
    severity: "error",
    message: "shared message",
    file,
    loc: line != null ? { line } : null,
    item,
    hint: null,
    listItem,
  });
  const r = {
    findings: [
      mk("manifest.json", 13, "frobnicate", true), // file:line - item
      mk(null, null, "name", true), // bare item (no file)
      mk("bg.js", 4, "browser.x", false), // item already in message -> where only
    ],
    meta: { action: "review", addon: "x", reviewed: true },
  };
  const issues = formatText(r).split("── Issues ──")[1];
  assert.match(issues, /\n - manifest\.json:13 - frobnicate\n/);
  assert.match(issues, /\n - name\n/);
  assert.match(issues, /\n - bg\.js:4\n/);
  assert.ok(!issues.includes("bg.js:4 - browser.x"));
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

// formatReviewBody is the report without the tally; formatSummary is just the
// tally. For a no-LLM review they concatenate back to formatText (formatText
// additionally inserts the advisory "Summary of add-on"/"Summary of changes"
// sections between the two when --llm-review produced them).
test("formatReviewBody / formatSummary split the report and round-trip", () => {
  const r = {
    findings: [mkFinding("info", "an info finding", "manifest.json", null)],
    meta: { action: "review", addon: "x", reviewed: true, manualReview: [] },
    issueHeadings: { error: "E:", warning: "W:", info: "I:" },
  };
  const body = formatReviewBody(r);
  const summary = formatSummary(r);
  assert.ok(!body.includes("── Summary ──")); // body has no tally
  assert.match(
    summary,
    /── Summary ──\n\n0 error\(s\), 0 warning\(s\), 1 info/
  );
  assert.equal(formatText(r), body + "\n" + summary); // round-trips
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

// ---- display cap (MAX_ENTRIES_PER_CATEGORY) ----
// A grouped Issues entry lists at most 25 locations, then one "… and N more,
// excluded from this list" marker. The cap is display only: the summary count
// and JSON still reflect every finding.
test("Issues cap a grouped list at 25 locations with a 'more' marker", () => {
  const findings = Array.from({ length: 30 }, (_, i) => ({
    ruleId: "r",
    severity: "warning",
    message: "many locations",
    file: `f${i}.js`,
    loc: { line: i + 1 },
    item: null,
    hint: null,
  }));
  const r = {
    findings,
    meta: { action: "review", addon: "x", reviewed: true },
  };
  const out = formatText(r);
  const issues = out.split("── Issues ──")[1].split("── Summary ──")[0];
  // Exactly 25 location lines render, then the marker for the other 5.
  assert.equal((issues.match(/^ - f\d+\.js:/gm) || []).length, 25);
  assert.match(issues, /- … and 5 more, excluded from this list/);
  // Display only: the summary still counts all 30, and JSON carries them all.
  assert.match(out, /30 warning\(s\)/);
  assert.equal(JSON.parse(formatJson(r)).findings.length, 30);
});

// A group at or under the cap renders every location and shows no marker.
test("Issues add no marker for a list of 25 or fewer", () => {
  const findings = Array.from({ length: 25 }, (_, i) => ({
    ruleId: "r",
    severity: "warning",
    message: "exactly at the cap",
    file: `f${i}.js`,
    loc: { line: i + 1 },
    item: null,
    hint: null,
  }));
  const out = formatText({
    findings,
    meta: { action: "review", addon: "x", reviewed: true },
  });
  const issues = out.split("── Issues ──")[1].split("── Summary ──")[0];
  assert.equal((issues.match(/^ - f\d+\.js:/gm) || []).length, 25);
  assert.ok(!issues.includes("excluded from this list"));
});

// Manual review caps a grouped locus list the same way; the standalone reminder
// (no locus) in the same report is unaffected.
test("Manual review caps a grouped locus list at 25 with a marker", () => {
  const manualReview = Array.from({ length: 30 }, (_, i) => ({
    title: "Unused permissions",
    instructions: "Review whether each is used.",
    file: "manifest.json",
    loc: { line: i + 1 },
    item: `perm${i}`,
    listItem: true,
    extended: true,
  }));
  manualReview.push({
    title: "Spam check",
    instructions: "Inspect it.",
    extended: false,
  });
  const out = formatText({
    findings: [],
    meta: { action: "review", addon: "x", reviewed: true, manualReview },
  });
  const extended = out
    .split("── Extended manual review ──")[1]
    .split("── Standard manual review ──")[0];
  assert.equal((extended.match(/^ - manifest\.json:/gm) || []).length, 25);
  assert.match(extended, /- … and 5 more, excluded from this list/);
  // The standalone reminder (Standard) is unaffected by the Extended cap.
  const standard = out.split("── Standard manual review ──")[1];
  assert.match(standard, /Spam check: Inspect it\./);
});

// SCA review: each finding's file:line is prefixed with the artifact it lives in -
// [XPI] for input:xpi and input:manifest checks (and always for manifest.json, the
// shipped manifest), [SCA] for the readable source (input:source/build) - and a legend
// footer closes the Issues section. An XPI review adds neither.
test("SCA review labels file:line by artifact ([XPI]/[SCA]) with a footer", () => {
  const r = {
    mode: REVIEW_MODE.SCA,
    ruleInputs: new Map([
      ["unused-files", "xpi"],
      ["unknown-api", "source"],
      ["manifest-unknown-permission", "manifest"],
    ]),
    findings: [
      {
        ruleId: "unused-files",
        severity: "error",
        file: "orphan.js",
        loc: { line: 2 },
        message: "Unused file in the built add-on.",
      },
      {
        ruleId: "unknown-api",
        severity: "error",
        file: "app.js",
        loc: { line: 5 },
        message: "Unknown API in the source.",
      },
      {
        ruleId: "manifest-unknown-permission",
        severity: "error",
        file: "manifest.json",
        loc: { line: 3 },
        message: "Unknown permission.",
      },
    ],
    meta: { action: "review", addon: "x", reviewed: false },
  };
  const out = formatText(r);
  assert.match(out, /\[XPI\] orphan\.js:2/); // input:xpi -> XPI
  assert.match(out, /\[SCA\] app\.js:5/); // input:source -> SCA
  assert.match(out, /\[XPI\] manifest\.json:3/); // manifest cross-over -> XPI
  // The artifact-label legend footer.
  assert.match(out, /\[XPI\] = source file in the submitted XPI/);
  assert.match(
    out,
    /\[SCA\] = source file in the submitted source code archive/
  );
  // The pre-flight pointer to the tool closes the section in every review.
  assert.match(out, /run this automated review yourself before submitting/);
  assert.match(out, /github\.com\/thunderbird\/webext-linter/);

  // The SAME result in XPI mode carries no artifact labels or legend, but still the
  // pre-flight pointer.
  const xpi = formatText({ ...r, mode: REVIEW_MODE.XPI });
  assert.doesNotMatch(xpi, /\[XPI\]|\[SCA\]/);
  assert.match(xpi, /orphan\.js:2/); // the bare file:line still renders
  assert.match(xpi, /run this automated review yourself/);
});

// The "run this yourself" pointer notes the --llm-review option only when the
// LLM review was active (meta.llmReviewed); the flag stays out of JSON.
test("run-it-yourself pointer reflects whether the LLM review ran", () => {
  const base = {
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
    meta: { action: "review", addon: "x", reviewed: true },
  };
  const off = formatText(base);
  assert.match(off, /run this automated review yourself before submitting:/);
  assert.doesNotMatch(off, /--llm-review option/);

  const on = formatText({ ...base, meta: { ...base.meta, llmReviewed: true } });
  assert.match(
    on,
    /run this automated review yourself before submitting \(this review was performed using the --llm-review option\):/
  );

  // Human-only: the flag never leaks into the machine JSON.
  const json = JSON.parse(
    formatJson({ ...base, meta: { ...base.meta, llmReviewed: true } })
  );
  assert.equal(json.meta.llmReviewed, undefined);
});

// The recheck-verdict list: below the "Summary of add-on" prose, one bullet per verdict
// (`* <check> - [LABEL] file:line - <subject> - <verdict>`) with the real source line beneath.
// Subject present for permission verdicts, omitted when null. Shown only with --verbose
// (review.verbose), so the fixture sets it.
function verdictReview() {
  return {
    findings: [],
    mode: REVIEW_MODE.SCA,
    verbose: true,
    meta: { action: "review", addon: "x", reviewed: true },
    summarizeAddon: { text: "Prose overview of the add-on." },
    recheckVerdictRows: [
      {
        check: "Unused permission",
        label: "source",
        file: "bg.js",
        line: 3,
        subject: "compose",
        verdict: VERDICT.PASS,
        content: "messenger.scripting.executeScript(t);",
      },
      {
        check: "Unused files",
        label: "xpi",
        file: "lib/x.js",
        line: 2,
        subject: null,
        verdict: VERDICT.UNSURE,
        content: "const UNUSED = 1;",
      },
      // A row with no content (unlocatable line) renders without the `->` line.
      {
        check: "Unused permission",
        label: "source",
        file: "gen.js",
        line: 9,
        subject: "tabs",
        verdict: VERDICT.UNSURE,
        content: null,
      },
    ],
  };
}

test("renders the recheck-verdict list under the add-on summary", () => {
  const out = formatText(verdictReview());
  const block = out.split("── Summary of add-on ──")[1];
  assert.match(block, /Prose overview of the add-on\./);
  assert.match(block, /Recheck verdicts:/);
  // permission verdict: [SCA] (source input in an sca review), subject = the permission.
  assert.match(
    block,
    /\* Unused permission - \[SCA\] bg\.js:3 - compose - pass/
  );
  assert.match(block, /-> messenger\.scripting\.executeScript\(t\);/);
  // non-permission verdict: [XPI] (xpi input), no subject segment.
  assert.match(block, /\* Unused files - \[XPI\] lib\/x\.js:2 - unsure/);
  assert.match(block, /-> const UNUSED = 1;/);
  // a null-content row: the bullet renders, no `->` line follows it.
  assert.match(
    block,
    /\* Unused permission - \[SCA\] gen\.js:9 - tabs - unsure\n(?! *->)/
  );
});

test("no verdicts adds nothing under the summary", () => {
  const r = verdictReview();
  r.recheckVerdictRows = [];
  assert.match(formatText(r), /── Summary of add-on ──/); // the prose still shows
  assert.doesNotMatch(formatText(r), /Recheck verdicts:/);
});

test("the recheck-verdict list is hidden without --verbose", () => {
  const r = verdictReview();
  r.verbose = false; // rows present, but not verbose
  assert.match(formatText(r), /── Summary of add-on ──/); // the prose still shows
  assert.doesNotMatch(formatText(r), /Recheck verdicts:/);
});

test("an XPI review omits the artifact label", () => {
  const r = verdictReview();
  r.mode = REVIEW_MODE.XPI;
  const block = formatText(r).split("── Summary of add-on ──")[1];
  assert.match(block, /\* Unused permission - bg\.js:3 - compose - pass/); // no [SCA]
  assert.doesNotMatch(block, /\[SCA\]|\[XPI\]/);
});
