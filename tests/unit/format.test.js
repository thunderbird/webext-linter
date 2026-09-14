// Unit tests for the text / JSON report renderers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { REVIEW_MODE } from "../../src/lib/enum.js";

import {
  formatText,
  formatJson,
  headerLines,
  llmPromptLines,
  locusLabeler,
  locationLine,
} from "../../src/report/format.js";
import { orderReview, hasLocus } from "../../src/report/order.js";
import { renderManualItems } from "../../src/report/responses.js";
import { loadRegistry } from "../../src/checks/registry.js";
import { PROMPT_SKIPS } from "../../src/config.js";
import { resolveHolds, hasErrors } from "../../src/report/finding.js";

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

// Manual review splits into three sections in order - Extended Code Review (an
// escalation a reviewer settles by reading the code), Extended Manual Review (one
// needing a person to act or to own the decision), then Standard (the always-by-hand
// manual-checks) - each with its "continue manual review" intro and enumerated
// "N) title: instructions" entries.
test("manual review splits into code, manual, then standard sections", () => {
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
          title: "Build process review",
          instructions: "Reproduce the build by hand.",
          extended: true,
          section: "manual-review",
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
  const code = out.indexOf("── Extended Code Review ──");
  const ext = out.indexOf("── Extended Manual Review ──");
  const std = out.indexOf("── Standard Manual Review ──");
  assert.ok(code !== -1 && ext !== -1 && std !== -1);
  assert.ok(code < ext && ext < std); // code, then manual, then standard
  // A blank line sits between each header and its "Continue ..." intro.
  assert.match(out, /── Extended Code Review ──\n\nContinue manual review/);
  assert.match(out, /── Extended Manual Review ──\n\nContinue manual review/);
  assert.match(out, /── Standard Manual Review ──\n\nContinue manual review/);
  // The code-settleable escalation (with its locus) first, the one a person must own
  // second, the always-by-hand checklist item last.
  assert.match(
    out.slice(code, ext),
    /1\) Source Archive required: Confirm sources were uploaded and rebuild matches\./
  );
  assert.match(out.slice(code, ext), /\n - x\.js:1/);
  assert.match(
    out.slice(ext, std),
    /1\) Build process review: Reproduce the build by hand\./
  );
  assert.match(
    out.slice(std),
    /1\) Check the submission for spam: Inspect it\./
  );
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
    .split("── Extended Code Review ──")[1]
    .split("── Standard Manual Review ──")[0];
  const standard = out.split("── Standard Manual Review ──")[1];
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
  const manual = formatText(r).split("── Extended Code Review ──")[1];
  // Response: after the instructions, before the locus, flush-left, verbatim.
  assert.match(
    manual,
    /Needs a privacy policy: Confirm a policy exists\.\nSuggested response: Please add a privacy policy\.\nSee \[1\]\.\n - bg\.js:4/
  );
  // The entry with no response carries no extra line.
  assert.match(manual, /Forked add-on: Check for a fork\./);
  assert.ok(!manual.includes("undefined"));
});

// What a reviewer actually reads for a manual-review item, end to end from the real
// registry: the manual-review wording, the site and the release it was matched against on
// the locus line, and NO "Suggested response:" - the entry's response is the wording
// for rejecting this rule, and these cases are not a rejection anyone has made.
test("a manual-review item renders with its own wording and its response", () => {
  const registry = loadRegistry();
  const [item] = renderManualItems(
    [
      {
        ruleId: "vendored-remote-resources",
        item: "https://fonts.example/f.css",
        hint: "https://cdn.example/x@1.0.0/x.css",
        file: "lib/x.css",
        loc: { line: 1 },
        section: "manual-review",
      },
    ],
    registry
  );
  const out = formatText({
    findings: [],
    meta: {
      action: "review",
      addon: "x",
      reviewed: true,
      manualReview: [{ ...item, extended: true }],
    },
  });
  const manual = out.split("── Extended Manual Review ──")[1];
  assert.match(manual, /matches a published file of the upstream release/);
  // The suggested response rides along: if the reviewer settles the case against the
  // add-on, that is the text the developer receives.
  assert.match(manual, /Suggested response: /);
  // Both URLs survive whole onto the locus line - the site being judged, then the
  // release it was matched against.
  assert.match(
    manual,
    / - lib\/x\.css:1 - https:\/\/fonts\.example\/f\.css - https:\/\/cdn\.example\/x@1\.0\.0\/x\.css/
  );
});

// A to-do item asks a reviewer to settle a case, and the answer has weight: the band a
// reported case lands in is printed above the response that would be sent. It comes from
// the owning entry's registry severity, never from the reviewer, so it is the same band a
// deterministic finding would have carried. All three sections work this way - an
// escalation and a by-hand manual-checks reminder are one kind of item with two origins.
test("an escalation prints the verdict a reported case carries", () => {
  const registry = loadRegistry();
  const items = renderManualItems(
    [
      // error + code-review
      { ruleId: "data-exfiltration", file: "a.js", loc: { line: 1 } },
      // warning + code-review
      { ruleId: "unused-permission", item: "compose", file: "manifest.json" },
      // hold-or-error + manual-review, suggested as the hold it is on its own
      {
        ruleId: "privacy-policy",
        file: "b.js",
        loc: { line: 2 },
        section: "manual-review",
      },
    ],
    registry
  );
  assert.deepEqual(
    items.map((i) => i.verdict),
    ["error", "warning", "hold"]
  );

  const out = formatText({
    findings: [],
    meta: {
      action: "review",
      addon: "x",
      reviewed: true,
      manualReview: [
        ...items.map((i) => ({ ...i, extended: true })),
        ...registry.manualChecks().map((m) => ({ ...m, extended: false })),
      ],
    },
  });
  const extended = out.split("── Extended Code Review ──")[1];
  assert.match(extended, /Suggested verdict: error\nSuggested response: /);
  assert.match(extended, /Suggested verdict: warning\nSuggested response: /);
  // A hold-or-error case is suggested as the hold it is on its own, not as the error it
  // would become beside a real one.
  const manualSection = out.split("── Extended Manual Review ──")[1];
  assert.match(
    manualSection.split("── Standard")[0],
    /Suggested verdict: hold\nSuggested response: /
  );
  // The by-hand reminders carry both, from their own registry entries.
  const standard = out.split("── Standard Manual Review ──")[1];
  assert.match(standard, /Suggested verdict: error\nSuggested response: /);
  assert.match(standard, /Suggested verdict: hold\nSuggested response: /);
});

// One sweep: the shared method, then the bare items it asks about.
const SWEEP = {
  intro: "Judge by EFFECT, never by the API used.",
  items: [
    {
      check: "data-exfiltration",
      title: "User-data exfiltration",
      severity: "error",
      instruction: "Read the add-on for other ways data reaches a remote host.",
    },
  ],
};

// JSON render drops manualReview entirely - both the meta key and the item
// title are absent - since automated consumers should not see manual steps.
test("JSON output omits manual-review items (ATN auto-verification)", () => {
  const json = JSON.parse(formatJson(review()));
  assert.equal(json.meta.manualReview, undefined);
  assert.ok(!formatJson(review()).includes("Source Archive required"));
});

// The pre-sweep list is an INSTRUCTION to a reader, not a statement about the add-on, so
// it says nothing this document is for - and the document is an upload filter ATN can
// auto-reject against. What a sweep FINDS does reach here, as a finding of the check that
// owns it; the asking never does.
test("JSON output omits the pre-sweep list (ATN auto-verification)", () => {
  const r = review();
  r.meta.preSweep = SWEEP;
  const json = JSON.parse(formatJson(r));
  assert.equal(json.meta.preSweep, undefined);
  assert.ok(!formatJson(r).includes("other ways data reaches"));
});

// Printed whether or not any check found something - a check that found nothing is
// exactly the one whose blind spot is worth reading - and absent entirely when no check
// that ran declares an instruction, so an ordinary review is unchanged.
test("the Standard Code Review section is one sweep, listing checks not cases", () => {
  const r = review();
  assert.ok(
    !formatText(r).includes("── Standard Code Review ──"),
    "absent when there is no sweep"
  );

  r.meta.preSweep = SWEEP;
  const out = formatText(r);
  assert.match(out, /── Standard Code Review ──/);
  // The shared method comes first: the items say only what each check looks for, so
  // without it the section is a list of subjects with no way to judge them.
  assert.match(
    out.replace(/\s+/g, " "),
    /Judge by EFFECT, never by the API used/
  );
  // "N) title: body", like a manual-review entry. The check id and its band are fields
  // of the item file, not prose - a reader of the page has the title instead.
  assert.match(out, /1\) User-data exfiltration: /);
  assert.ok(
    !out.includes("[data-exfiltration, error]"),
    "the rendered line does not repeat the check id or its band"
  );
  // Collapsed first: the item is re-wrapped to the report's width, so any phrase in it
  // can straddle a line break the next wording change happens to move.
  assert.match(
    out.replace(/\s+/g, " "),
    /Read the add-on for other ways data reaches a remote host/
  );
  // It sits with the other section carried by every submission, and before it.
  assert.ok(
    out.indexOf("── Standard Code Review ──") <
      out.indexOf("── Standard Manual Review ──"),
    "the two standard sections read as a pair, code before manual"
  );
});

// The report keeps issues (findings) and manual-review items in separate lists:
// a manual item shows under Manual review (title: instructions), an issue under
// Issues, and JSON carries the issue but drops the manual list.
// The locus line joins path, surfaced subject and detail with " - ", and DROPS a segment
// equal to one already on it. A check whose subject is its own locus repeats the path
// otherwise: untrusted-library falls back to the file when no library name was
// identified, which rendered "lib/x.js - lib/x.js - <source>". Dropped for PRINTING only
// - the finding still records both fields, so the JSON report is unaffected.
test("a locus segment that repeats another is not printed, but is still recorded", () => {
  const locus = (f) => {
    const r = review();
    r.meta.reviewed = true;
    r.findings = [
      {
        ruleId: "untrusted-library",
        severity: "info",
        message: "m",
        loc: null,
        ...f,
      },
    ];
    const line = formatText(r)
      .split("\n")
      .find((l) => l.startsWith(" - "));
    return { line, json: JSON.parse(formatJson(r)).findings[0] };
  };

  // The subject repeats the path: printed once, recorded twice.
  const same = locus({
    file: "lib/x.js",
    item: "lib/x.js",
    listItem: true,
    hint: "https://cdn.example/x.js",
  });
  assert.equal(same.line, " - lib/x.js - https://cdn.example/x.js");
  assert.equal(same.json.item, "lib/x.js"); // the data is untouched
  assert.equal(same.json.file, "lib/x.js");

  // A subject that ADDS something is kept, and all three segments render.
  const differs = locus({
    file: "lib/x.js",
    item: "x 1.0.0",
    listItem: true,
    hint: "https://cdn.example/x.js",
  });
  assert.equal(
    differs.line,
    " - lib/x.js - x 1.0.0 - https://cdn.example/x.js"
  );

  // The same guard covers a hint that repeats the subject, or the path.
  assert.equal(
    locus({ file: "lib/x.js", item: "dup", listItem: true, hint: "dup" }).line,
    " - lib/x.js - dup"
  );
  assert.equal(
    locus({ file: "lib/x.js", item: null, hint: "lib/x.js" }).line,
    " - lib/x.js"
  );

  // With no path, whichever of subject/detail exists leads - hasLocus guarantees one
  // does, so there is no placeholder to stand in.
  assert.equal(
    locus({ file: null, item: "storage", listItem: true, hint: "why" }).line,
    " - storage - why"
  );
  assert.equal(locus({ file: null, item: null, hint: "why" }).line, " - why");
});

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
    .split("── Found Issues ──")[1]
    .split("── Extended Code Review ──")[0];
  assert.ok(!issuesSection.includes("old.js")); // not in Issues
  // Message first, then the "- file:line" location beneath it.
  assert.match(issuesSection, /1\) eval used/);
  assert.match(issuesSection, /\n - bg\.js:2/);
  assert.match(
    out,
    /1 error\(s\), 0 hold, 0 warning\(s\), 0 info,\n1 extended code review item\(s\), 0 extended manual review item\(s\),\n0 standard code review item\(s\), 0 standard manual review item\(s\)/
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
    /── Summary ──\n\n2 error\(s\), 0 hold, 1 warning\(s\), 1 info,\n0 extended code review item\(s\), 0 extended manual review item\(s\),\n0 standard code review item\(s\), 0 standard manual review item\(s\)/
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
  const issues = out.split("── Found Issues ──")[1].split("── Summary ──")[0];
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

// A location line is printed only when there is something to put on it: a file, a
// surfaced item, or a hint. A finding whose subject is the submission as a whole
// (sca-not-required, manifest-missing) carries none of the three, and its message
// already says everything - so it is listed with no location line rather than one
// naming nothing. A hint with no file still prints, on its own, because finding.js
// promises a hint is ALWAYS shown.
test("Issues print a location line only when it carries something", () => {
  const mk = (extra) => ({
    ruleId: "r",
    severity: "error",
    message: "shared message",
    file: null,
    loc: null,
    item: null,
    hint: null,
    listItem: false,
    ...extra,
  });
  const body = (f) => {
    const out = formatText({
      findings: [f],
      meta: { action: "review", addon: "x", reviewed: true },
    }).split("── Found Issues ──")[1];
    return out.split("\n").filter((l) => l.trim().startsWith("- "));
  };
  // Nothing to say -> no line at all.
  assert.deepEqual(body(mk({})), []);
  // A hint alone still has to reach the reader; it leads the line by itself.
  assert.deepEqual(body(mk({ hint: "added in Thunderbird 137" })), [
    " - added in Thunderbird 137",
  ]);
  // An item the message did not consume is a locus of its own.
  assert.deepEqual(body(mk({ item: "tabs", listItem: true })), [" - tabs"]);
  // An item the message DID consume is not, so that finding has nothing to list.
  assert.deepEqual(body(mk({ item: "tabs", listItem: false })), []);
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
  const issues = formatText(r).split("── Found Issues ──")[1];
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

// The tally CLOSES the report: it is the last section, so the verdict is the final
// thing a reader sees. Nothing is printed after it.
test("the Summary tally is the report's last section", () => {
  const r = {
    findings: [mkFinding("info", "an info finding", "manifest.json", null)],
    meta: { action: "review", addon: "x", reviewed: true, manualReview: [] },
    issueHeadings: { error: "E:", warning: "W:", info: "I:" },
  };
  const out = formatText(r);
  const sections = [...out.matchAll(/── (.+?) ──/g)].map((m) => m[1]);
  assert.equal(sections.at(-1), "Summary");
  assert.match(
    out.slice(out.indexOf("── Summary ──")),
    /^── Summary ──\n\n0 error\(s\), 0 hold, 0 warning\(s\), 1 info,\n[^\n]* item\(s\),\n[^\n]* item\(s\)$/
  );
});

test("empty review shows the registry 'none' intro as the Issues body", () => {
  const out = formatText(withReview([], { none: "NONE-MSG" }));
  assert.match(out, /── Found Issues ──\nNONE-MSG/);
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
  const issues = out.split("── Found Issues ──")[1].split("── Summary ──")[0];
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
  const issues = out.split("── Found Issues ──")[1].split("── Summary ──")[0];
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
    .split("── Extended Code Review ──")[1]
    .split("── Standard Manual Review ──")[0];
  assert.equal((extended.match(/^ - manifest\.json:/gm) || []).length, 25);
  assert.match(extended, /- … and 5 more, excluded from this list/);
  // The standalone reminder (Standard) is unaffected by the Extended cap.
  const standard = out.split("── Standard Manual Review ──")[1];
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

// Submission text reaches a person through four sinks - a substituted {{slot}}, the
// locus line, the machine-readable report and the live feed. An escape sequence in
// any of them repaints the terminal around the finding, erasing what sits above it.
// displayText guards each sink rather than the hundreds of places a check composes a
// finding, so a check added later inherits it.
//
// `message` is NOT guarded here, and must not be: it is authored registry prose whose
// deliberate line breaks would be collapsed. It is safe by construction instead - no
// check writes it, it only ever comes out of fill(), and fill() cleans every value it
// substitutes (see responses.test.js).
test("control characters from the submission never reach the report", () => {
  const ESC = "\u001B";
  const evil = `${ESC}[2K${ESC}[1A`;
  const r = {
    findings: [
      {
        ruleId: "unused-files",
        severity: "error",
        message: "A file is unused.",
        file: `lib/${evil}x.js`,
        item: `lib/${evil}x.js`,
        listItem: true,
        hint: `taken from https://x/${evil}y.js`,
        loc: { line: 3 },
      },
    ],
    meta: { action: "review", addon: "x", reviewed: false, manualReview: [] },
  };
  const text = formatText(r);
  assert.ok(!text.includes(ESC), "no escape survived into the text report");
  // The characters are removed, not the value.
  assert.ok(text.includes("x.js") && text.includes("y.js"));

  const json = formatJson(r);
  assert.ok(!json.includes(ESC), "no escape survived into the JSON report");
  const parsed = JSON.parse(json);
  for (const field of ["file", "item", "hint"]) {
    assert.ok(!parsed.findings[0][field].includes(ESC), field);
  }

  // Every C0 control and every format character, not just the escape.
  for (const ch of [
    "\u0000",
    "\u0008",
    "\u000C",
    "\u202E",
    "\u200B",
    "\u001B",
  ]) {
    const one = {
      ...r,
      findings: [
        { ...r.findings[0], file: `lib/${ch}x.js`, item: null, hint: null },
      ],
    };
    assert.ok(!formatText(one).includes(ch), JSON.stringify(ch));
    assert.ok(!formatJson(one).includes(ch), JSON.stringify(ch));
  }
});

// ---- the item enumeration a verdict file indexes into ----
// A verdict names an item by its position in the printed report, so the enumeration has
// to BE the printed order - not merely resemble it. This asserts that against the report
// itself: every locus line the renderer emits, in order, is what the sequence numbered.
// Grouping reorders findings (they collapse by message), the to-do sections follow the
// body groups, and the display cap hides the tail of a long list - all three are ways the
// two could drift, and all three are covered here. The cap bounds the PAGE only: a
// withheld item is still numbered, so it is still in the item file and still settleable.
test("the enumeration is exactly the order the report prints", () => {
  const registry = loadRegistry();
  const mk = (ruleId, severity, message, file, line, item) => ({
    ruleId,
    severity,
    message,
    file,
    loc: line == null ? null : { line },
    item: item ?? null,
    listItem: Boolean(item),
    hint: null,
  });
  // Two checks interleaved by file order, so collapsing by message MUST reorder them.
  const findings = [
    mk("a", "error", "A", "a.js", 1),
    mk("b", "error", "B", "b.js", 2),
    mk("a", "error", "A", "c.js", 3),
    mk("c", "info", "C", "d.js", 4),
  ];
  // One long group, past the display cap, plus a reminder that prints no locus at all.
  const manual = [
    ...Array.from({ length: 30 }, (_, i) => ({
      extended: true,
      section: "code-review",
      ruleId: "p",
      title: "P",
      instructions: "inspect",
      file: `f${String(i).padStart(2, "0")}.js`,
      loc: { line: i },
    })),
    { extended: false, title: "Standing", instructions: "do it" },
  ];
  const out = formatText({
    findings,
    meta: {
      action: "review",
      addon: "x",
      reviewed: true,
      manualReview: manual,
    },
    issueHeadings: registry.issueHeadings(),
    verdictIntros: registry.verdictIntros(),
  });
  const printed = out
    .split("\n")
    .filter((l) => l.startsWith(" - "))
    .map((l) => l.slice(3))
    // The "and N more" marker is chrome, not an item - nothing can be said about a
    // locus the report withheld.
    .filter((l) => !l.startsWith("… and "));
  const label = locusLabeler();
  const enumerated = orderReview(findings, manual);
  // The SHOWN items are exactly the printed ones, in the printed order.
  assert.deepEqual(
    enumerated
      .filter((x) => x.shown && hasLocus(x.target))
      .map((x) => locationLine(x.target, label(x.target))),
    printed
  );
  // Every item is numbered, 1..N with no gaps - including the ones the page had no room
  // for. The item file carries them and a verdict can address them, which is what keeps
  // a reader from settling the items they were handed while the rest pass unexamined.
  assert.deepEqual(
    enumerated.map((x) => x.index),
    enumerated.map((_, i) => i + 1)
  );
  // The collapse really did reorder: c.js is listed second, not third.
  assert.deepEqual(printed.slice(0, 3), ["a.js:1", "c.js:3", "b.js:2"]);
  // The cap really did bite: 30 loci, 25 listed.
  assert.equal(printed.filter((l) => l.startsWith("f")).length, 25);
  // The locus-less reminder is still a numbered item - it IS printed, as an entry with
  // no location line - so a verdict can address it.
  assert.equal(hasLocus(enumerated.at(-1).target), false);
  assert.equal(enumerated.at(-1).kind, "todo");
  assert.equal(typeof enumerated.at(-1).index, "number");
  // The five the cap withheld are in the sequence, numbered, and marked unprinted.
  const withheld = enumerated.filter((x) => !x.shown);
  assert.equal(withheld.length, 5);
  assert.ok(withheld.every((x) => typeof x.index === "number"));
});

// The regression that forced the one-sequence design. A finding with no locus used to
// join the entry of findings that DO have one, where it contributed no line: an item in
// the sequence that the page never showed, silently pushing every later number out of
// step with what a reader counts. Locus status is now part of the entry key, so such a
// finding is its own entry and IS printed - as its message alone, which is how a
// whole-add-on finding has always rendered.
test("a locus-less finding is its own entry, so every item is on the page", () => {
  const registry = loadRegistry();
  const f = (message, file) => ({
    ruleId: "r",
    severity: "error",
    message,
    file,
    loc: file ? { line: 1 } : null,
    item: null,
    hint: null,
    listItem: false,
  });
  // Same message, one with a location and one without - the shape that used to hide it.
  const findings = [f("A", "a.js"), f("A", null), f("B", "b.js")];
  const out = formatText({
    findings,
    meta: { action: "review", addon: "x", reviewed: true },
    issueHeadings: registry.issueHeadings(),
    verdictIntros: registry.verdictIntros(),
  });
  const issues = out.split("── Found Issues ──")[1];
  // Three entries, not two: the locus-less one is listed in its own right.
  assert.match(issues, /1\) A\n\n2\) A\n - a\.js:1\n\n3\) B\n - b\.js:1/);
  const ordered = orderReview(findings);
  assert.equal(ordered.length, 3);
  assert.deepEqual(
    ordered.map((x) => x.index),
    [1, 2, 3]
  );
  // What a reader counts - location lines, plus entries showing none - is what the
  // sequence numbered.
  const countable =
    issues.split("\n").filter((l) => l.startsWith(" - ")).length +
    ordered.filter((x) => !hasLocus(x.target)).length;
  assert.equal(countable, ordered.filter((x) => x.index != null).length);
});

// ---- the hold band ----
// A hold blocks the review without rejecting the add-on: the fix is on the ATN listing,
// not in the package, so no rebuild would help. On its own it IS the verdict - its own
// intro, its own heading, and it leads the sections so warning/info follow it.
test("a hold alone opens the section with the hold verdict", () => {
  const registry = loadRegistry();
  const findings = [
    {
      ruleId: "privacy-policy",
      severity: "hold",
      message: "POLICY",
      file: "a.js",
    },
    { ruleId: "eval-call", severity: "warning", message: "WARN", file: "b.js" },
  ];
  resolveHolds(findings);
  assert.deepEqual(
    findings.map((f) => f.severity),
    ["hold", "warning"]
  );
  const out = formatText({
    findings,
    meta: { action: "review", addon: "x", reviewed: true },
    issueHeadings: registry.issueHeadings(),
    verdictIntros: registry.verdictIntros(),
  });
  const issues = out.split("── Found Issues ──")[1];
  assert.match(
    issues,
    /Thank you for your contribution\. To continue the review, a few issues still need to be addressed:/
  );
  // Hold leads, warning follows.
  assert.ok(issues.indexOf("POLICY") < issues.indexOf("WARN"));
  assert.match(out, /0 error\(s\), 1 hold, 1 warning\(s\)/);
  // It is not a rejection, so the run does not fail - a human continues the review.
  assert.equal(hasErrors(findings), false);
});

// With a real error the submission is rejected anyway, so the hold is not the verdict:
// it becomes one more item on the rejection list. Settled ONCE, before anything reads a
// severity, so the heading, the tally and the JSON cannot tell different stories.
test("a hold beside an error becomes an error, everywhere at once", () => {
  const registry = loadRegistry();
  const findings = [
    {
      ruleId: "privacy-policy",
      severity: "hold",
      message: "POLICY",
      file: "a.js",
    },
    {
      ruleId: "unused-files",
      severity: "error",
      message: "DEAD",
      file: "b.js",
    },
  ];
  resolveHolds(findings);
  assert.deepEqual(
    findings.map((f) => f.severity),
    ["error", "error"]
  );
  const review = {
    findings,
    meta: { action: "review", addon: "x", reviewed: true },
    issueHeadings: registry.issueHeadings(),
    verdictIntros: registry.verdictIntros(),
  };
  const out = formatText(review);
  assert.match(out, /cannot be accepted and hosted/); // the rejected intro
  assert.ok(!out.includes("To continue the review")); // no hold heading
  assert.match(out, /2 error\(s\), 0 hold/); // counted where they are printed
  assert.equal(JSON.parse(formatJson(review)).summary.hold, 0);
});

// ---- the --llm-review verification prompt ----
// The prompt asks for the work the report contains and for all of it: the issues ask needs
// a finding, the code-review ask needs an Extended Code Review item, and the manual ask
// needs an item in either of the other two to-do sections. Asking for an absent section
// sends the reader hunting for something never printed; leaving one out hands over a
// section of the review unasked.
test("the prompt asks only for the sections the report actually has", () => {
  const prompt = {
    intro: "INTRO.",
    issues: "ISSUES.",
    codeReview: "CODE.",
    extendedManualReview: "EXT.",
    standardManualReview: "STD.",
    outcomeIntro: "HOW.",
    outcome: [
      { skip: null, text: "A." },
      { skip: "manual", text: "B." },
      { skip: null, text: "C." },
    ],
  };
  const finding = { ruleId: "r", severity: "error", message: "m" };
  const codeItem = { extended: true, section: "code-review", title: "t" };
  const manualItem = { extended: true, section: "manual-review", title: "t" };
  const standardItem = { extended: false, section: null, title: "t" };

  // Its own section, like every other block in the report. `outcome` - how the verdicts
  // come back - closes it whenever something was asked, and is absent when nothing was.
  const head = ["", "── LLM Prompt ──", "", "INTRO.", ""];
  // The steps, numbered over what a full run prints - all of them.
  const tail = ["", "HOW.", "", "1. A.", "", "2. B.", "", "3. C."];
  assert.deepEqual(llmPromptLines(prompt, [], []), head);
  assert.deepEqual(llmPromptLines(prompt, [finding], []), [
    ...head,
    "- ISSUES.",
    ...tail,
  ]);
  assert.deepEqual(llmPromptLines(prompt, [], [codeItem]), [
    ...head,
    "- CODE.",
    ...tail,
  ]);
  assert.deepEqual(llmPromptLines(prompt, [finding], [codeItem]), [
    ...head,
    "- ISSUES.",
    "- CODE.",
    ...tail,
  ]);
  // One ask per to-do section, so a review with no Extended Manual Review items is not
  // told to work them.
  assert.deepEqual(llmPromptLines(prompt, [], [manualItem]), [
    ...head,
    "- EXT.",
    ...tail,
  ]);
  assert.deepEqual(llmPromptLines(prompt, [], [standardItem]), [
    ...head,
    "- STD.",
    ...tail,
  ]);
  // All four at once, in the order the report prints their sections.
  assert.deepEqual(
    llmPromptLines(prompt, [finding], [codeItem, manualItem, standardItem]),
    [...head, "- ISSUES.", "- CODE.", "- EXT.", "- STD.", ...tail]
  );
});

// The registry is the only place this wording lives, and all three texts are needed the
// moment the flag is used - which one a review prints depends on its own content, so a
// missing text would quietly drop an instruction instead of failing.
test("the prompt texts come from the registry and all three are required", () => {
  const prompt = loadRegistry().llmReviewPrompt();
  for (const key of [
    "intro",
    "issues",
    "codeReview",
    "extendedManualReview",
    "standardManualReview",
    "outcomeIntro",
  ]) {
    assert.equal(typeof prompt[key], "string");
    assert.ok(prompt[key].length > 0, key);
  }
  const registry = loadRegistry();
  delete registry.doc["llm-review-prompt"].issues;
  assert.throws(() => registry.llmReviewPrompt(), /authors no `issues`/);
});

// The answers a question offers are authored once and asked of every reviewer, so a run
// that cannot read them has no question to ask. Each way the yaml can be wrong refuses by
// name, rather than reaching the reviewer as an answer with no label or no description.
test("the manual review answers come from the registry and are whole", () => {
  const choices = loadRegistry().manualReviewChoices();
  assert.ok(
    choices.length >= 2,
    "a question offers something to choose between"
  );
  for (const c of choices) {
    for (const key of ["label", "verdict", "description"]) {
      assert.equal(typeof c[key], "string");
      assert.ok(c[key].length > 0, key);
    }
  }

  const missing = loadRegistry();
  delete missing.doc["llm-manual-review-choices"];
  assert.throws(() => missing.manualReviewChoices(), /authors no answers/);

  const empty = loadRegistry();
  empty.doc["llm-manual-review-choices"] = [];
  assert.throws(() => empty.manualReviewChoices(), /authors no answers/);

  // One test per field, because each is a different thing the reviewer loses: the answer
  // they pick, the verdict it settles the item with, and what it means.
  for (const [i, key] of [
    [0, "label"],
    [1, "verdict"],
    [0, "description"],
  ]) {
    const broken = loadRegistry();
    delete broken.doc["llm-manual-review-choices"][i][key];
    assert.throws(
      () => broken.manualReviewChoices(),
      new RegExp(`answer ${i + 1} authors no \\\`${key}\\\``),
      key
    );
  }
});

// The SCA prompt is the whole output of its own flag - no review runs beside it - so a
// missing key there is a run with nothing to print, and it refuses rather than printing
// half an instruction.
test("the SCA prompt comes from the registry and both parts are required", () => {
  const prompt = loadRegistry().llmScaReviewPrompt();
  assert.ok(prompt.intro.length > 0);
  assert.ok(prompt.outcome.length > 0);
  for (const step of prompt.outcome) {
    assert.equal(typeof step.text, "string");
    assert.ok(step.text.length > 0);
    assert.equal(typeof step.experiments, "boolean");
  }
  // Exactly one step is the Experiment one, and it is printed only when they are allowed.
  assert.equal(prompt.outcome.filter((s) => s.experiments).length, 1);
  const noIntro = loadRegistry();
  delete noIntro.doc["llm-sca-review-prompt"].intro;
  assert.throws(() => noIntro.llmScaReviewPrompt(), /authors no `intro`/);

  const noSteps = loadRegistry();
  noSteps.doc["llm-sca-review-prompt"].outcome = [];
  assert.throws(
    () => noSteps.llmScaReviewPrompt(),
    /authors no `outcome` steps/
  );

  const blankStep = loadRegistry();
  blankStep.doc["llm-sca-review-prompt"].outcome = [
    { text: "fine" },
    { text: "" },
  ];
  assert.throws(() => blankStep.llmScaReviewPrompt(), /step 2 authors no text/);
});

// Every step must declare a `skip` a flag can actually give, the way every check entry
// must declare its severity: a typo in the marker would silently leave the step in every
// prompt, and nothing downstream validates this wording. The steps must not number
// themselves either - the prompt numbers what survives, so a literal number would render
// twice.
test("every outcome step authors text and a skip a flag can give", () => {
  const prompt = loadRegistry().llmReviewPrompt();
  assert.ok(Array.isArray(prompt.outcome) && prompt.outcome.length > 0);
  for (const [i, step] of prompt.outcome.entries()) {
    assert.ok(
      step.skip === null || PROMPT_SKIPS.includes(step.skip),
      `step ${i + 1} skip`
    );
    assert.equal(typeof step.text, "string", `step ${i + 1} text`);
    assert.ok(step.text.length > 0, `step ${i + 1} text`);
    assert.doesNotMatch(step.text, /^\d+[.)]\s/, `step ${i + 1} self-numbers`);
  }
  for (const skip of PROMPT_SKIPS) {
    assert.ok(
      prompt.outcome.some((step) => step.skip === skip),
      `--llm-skip-${skip} would withhold nothing`
    );
  }
});

// The clause MOVES that let a one-word marker carry the whole feature: the instructions
// about the description agent and about the reviewer's answers live in the steps their own
// skip drops, never in one it keeps. Left behind, a cut-down prompt would command work it
// never asked for - which no other test would catch.
test("no step a skip keeps refers to the work that skip drops", () => {
  const dropped = {
    summary: ["describe the add-on", "description agent", "Add-on description"],
    manual: [
      "to the reviewer in index order",
      "the words they typed",
      "the label they picked",
    ],
  };
  const steps = loadRegistry().llmReviewPrompt().outcome;
  for (const skip of PROMPT_SKIPS) {
    for (const step of steps.filter((step) => step.skip !== skip)) {
      for (const stray of dropped[skip]) {
        assert.ok(
          !step.text.includes(stray),
          `a --llm-skip-${skip} step still mentions "${stray}"`
        );
      }
    }
  }
});

test("a malformed outcome step is refused", () => {
  const bad = (mutate, re) => {
    const registry = loadRegistry();
    mutate(registry.doc["llm-review-prompt"]);
    assert.throws(() => registry.llmReviewPrompt(), re);
  };
  bad((p) => delete p.outcome, /authors no `outcome` steps/);
  bad((p) => (p.outcome = []), /authors no `outcome` steps/);
  bad(
    (p) => (p.outcome = [{ text: "a" }, "nope"]),
    /step 2 is not a step mapping/
  );
  bad((p) => (p.outcome[0].skip = "nonsense"), /step 1 has `skip: nonsense`/);
  bad((p) => (p.outcome[0].skip = true), /step 1 has `skip: true`/);
  bad((p) => (p.outcome[1].text = ""), /step 2 authors no `text`/);
  bad(
    (p) => (p.outcome[0].text = "1. Run the sweep."),
    /step 1 numbers itself/
  );
  bad(
    (p) => p.outcome.forEach((s) => delete s.skip),
    /has no `skip: summary` step/
  );
  bad((p) => delete p["outcome-intro"], /authors no `outcome-intro`/);
});

// --llm-skip-manual asks only for what reading the ADD-ON can settle: the two manual asks
// are withheld, and so are the steps that need a person. What is left is renumbered, which
// is the whole reason no step authors its own number.
test("--llm-skip-manual drops the manual asks and renumbers the steps", () => {
  const prompt = {
    intro: "INTRO.",
    issues: "ISSUES.",
    preSweep: "SWEEP.",
    codeReview: "CODE.",
    extendedManualReview: "EXT.",
    standardManualReview: "STD.",
    outcomeIntro: "HOW.",
    outcome: [
      { skip: null, text: "A." },
      { skip: "manual", text: "B." },
      { skip: null, text: "C." },
    ],
  };
  const finding = { ruleId: "r", severity: "error", message: "m" };
  const codeItem = { extended: true, section: "code-review", title: "t" };
  const manualItem = { extended: true, section: "manual-review", title: "t" };
  const standardItem = { extended: false, section: null, title: "t" };
  const head = ["", "── LLM Prompt ──", "", "INTRO.", ""];

  // The manual items are in the review and still print in the report - they are simply
  // not asked about, and step B (which would put them to a reviewer) is gone with them.
  assert.deepEqual(
    llmPromptLines(
      prompt,
      [finding],
      [codeItem, manualItem, standardItem],
      null,
      ["manual"]
    ),
    [...head, "- ISSUES.", "- CODE.", "", "HOW.", "", "1. A.", "", "2. C."]
  );
  // The same call in a full run asks for everything and prints every step.
  assert.deepEqual(
    llmPromptLines(prompt, [finding], [codeItem, manualItem, standardItem]),
    [
      ...head,
      "- ISSUES.",
      "- CODE.",
      "- EXT.",
      "- STD.",
      "",
      "HOW.",
      "",
      "1. A.",
      "",
      "2. B.",
      "",
      "3. C.",
    ]
  );
  // A cut-down run whose only ask is the sweep still closes with the steps: the work it
  // asks for is the sweep's, and the hand-back instruction is in a surviving step.
  assert.deepEqual(
    llmPromptLines(prompt, [], [standardItem], { items: [{}] }, ["manual"]),
    [...head, "- SWEEP.", "", "HOW.", "", "1. A.", "", "2. C."]
  );
});

// A step may carry a literal example, whose authored line breaks ARE the layout. Unlike an
// ask, a step is never whitespace-collapsed, and each is wrapped in ONE call - wrapping it
// paragraph by paragraph would lose the blank lines inside it.
test("a step's authored line breaks survive the per-step wrap", () => {
  const prompt = {
    intro: "Go.",
    issues: "i",
    outcomeIntro: "HOW.",
    outcome: [{ text: 'lead in\n\n{"a": 1,\n"b": 2}\n\ntail out' }],
  };
  const lines = llmPromptLines(prompt, [{ ruleId: "r" }], []);
  // Each SOURCE line is wrapped on its own and only the first carries the marker, so the
  // example keeps its own line breaks and stays flush - exactly as it renders today.
  assert.deepEqual(lines.slice(-6), [
    "1. lead in",
    "",
    '{"a": 1,',
    '"b": 2}',
    "",
    "tail out",
  ]);
});

// A registry text is authored as wrapped YAML, so its source line breaks must not survive
// into the prompt - the bullet is re-wrapped to the report width, hanging-indented under
// its marker like every other wrapped list in the report.
test("a prompt bullet is re-wrapped and hanging-indented", () => {
  const prompt = {
    intro: "Go.",
    issues: "one two\nthree " + "w".repeat(70) + " tail",
    codeReview: "c",
    outcomeIntro: "HOW.",
    outcome: [{ text: "o" }],
  };
  const lines = llmPromptLines(prompt, [{ ruleId: "r" }], []).slice(3);
  assert.deepEqual(lines[0], "Go.");
  assert.equal(lines[1], "");
  assert.equal(lines[2], "- one two three");
  assert.equal(lines[3], "  " + "w".repeat(70) + " tail");
  for (const line of lines) {
    assert.ok(!line.includes("\n"));
  }
});

// ---- the Review Details section ----
// An SCA review spans TWO artifacts and labels every locus [XPI]/[SCA], so the section has
// to say what those are. Naming only the review target left the shipped XPI - the thing
// users install - unnamed in the header AND in meta. A one-artifact review keeps one line:
// there is nothing to disambiguate, and a downgraded SCA is one of those, because only the
// XPI was reviewed.
test("the header names both artifacts in an SCA review, one otherwise", () => {
  const base = {
    schemaBranch: "release-mv3",
    applicationVersion: "155.0",
    manifestVersion: 3,
  };
  const head = ["", "── Review Details ──", ""];
  assert.deepEqual(
    headerLines({ ...base, addon: "/x/src", shippedAddon: "/x/a.xpi" }),
    [
      ...head,
      "Reviewed XPI: /x/a.xpi",
      "Reviewed SCA: /x/src",
      "schema release-mv3 · Thunderbird 155.0 · manifest_version 3",
    ]
  );
  assert.deepEqual(headerLines({ ...base, addon: "/x/a.xpi" }), [
    ...head,
    "Reviewed XPI: /x/a.xpi",
    "schema release-mv3 · Thunderbird 155.0 · manifest_version 3",
  ]);
  // --llm-review writes an item file, and this section is where the review says what it
  // consists of - so the path is named here, not only in the prompt. The counts are NOT
  // here: they are the Summary's, which closes every run.
  const llm = headerLines({
    ...base,
    addon: "/x/a.xpi",
    itemsFile: "/tmp/i.json",
  });
  assert.equal(llm.at(-1), "Review items: /tmp/i.json");
  assert.ok(!llm.some((l) => l.includes("error(s)")));
});
