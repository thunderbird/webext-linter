// Unit tests for --llm-verdict: settling a finished review against answers a reviewer
// (or a model) gave it. The answers carry no prose - every guard here exists because a
// verdict that lands on the wrong item, or brings its own wording, would corrupt a
// report that is otherwise entirely the linter's.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyVerdicts, readVerdicts } from "../../src/report/verdicts.js";
import { loadRegistry } from "../../src/checks/registry.js";
import { MAX_NOTE } from "../../src/config.js";
import {
  renderFindings,
  renderManualItems,
} from "../../src/report/responses.js";
import { reviewItems } from "../../src/report/items.js";
import { formatText, formatJson } from "../../src/report/format.js";

const registry = loadRegistry();
// The answers every question offers - what the pipeline hands reviewItems, so the tests
// see the file a review actually writes.
const choices = registry.manualReviewChoices();

/** A finding as it looks once renderFindings has run. */
function mkFinding(ruleId, severity, message, file, line) {
  return {
    ruleId,
    severity,
    message,
    file,
    loc: { line },
    item: null,
    hint: null,
    listItem: false,
  };
}

/** An escalated to-do item as renderManualItems leaves it. */
function mkItem(ruleId, title, file, line, item) {
  return {
    ruleId,
    title,
    instructions: `inspect ${title}`,
    response: null,
    verdict: registry.suggestedVerdict(ruleId),
    data: null,
    extended: true,
    section: "code-review",
    file,
    loc: { line },
    item: item ?? null,
    listItem: Boolean(item),
    hint: null,
  };
}

function review() {
  return {
    findings: [
      mkFinding("unused-files", "error", "DEAD", "junk.txt", 1),
      mkFinding("eval-call", "warning", "EVAL", "a.js", 2),
    ],
    manual: [
      mkItem("unused-permission", "Perms", "manifest.json", 3, "compose"),
      mkItem("privacy-policy", "Policy", "b.js", 4),
    ],
  };
}

// A verdict file carries what settles each item, as it was given: a verb for an item
// nobody was asked, and for a question the label the reviewer picked or the words they
// typed instead.
const verdicts = (obj) => new Map(Object.entries(obj).map(([k, v]) => [+k, v]));

// The three verbs, each on the kind of item it belongs to. A reported to-do item
// becomes a finding of its own check - same locus, the band the registry declares, and
// no message of its own, because renderFindings words it from the registry afterwards
// exactly as it words a finding the check emitted itself.
test("the three verbs edit the review the way the report reads them", () => {
  const r = review();
  const { applied, added } = applyVerdicts({
    findings: r.findings,
    manual: r.manual,
    verdicts: verdicts({ 2: "withdrawn", 3: "reported", 4: "cleared" }),
    registry,
  });
  // Counted apart from the verdicts: a file with no additions adds nothing.
  assert.deepEqual(added, []);
  assert.deepEqual(applied, [
    "2 withdrawn (a.js:2)",
    "3 reported (manifest.json:3 - compose)",
    "4 cleared (b.js:4)",
  ]);
  assert.deepEqual(
    r.findings.map((f) => [f.ruleId, f.severity, f.message]),
    [
      ["unused-files", "error", "DEAD"],
      // Reported: the check's own band, wording left to renderFindings.
      ["unused-permission", "warning", null],
    ]
  );
  assert.equal(r.manual.length, 0); // both to-do items settled
});

// privacy-policy is hold-or-error, so a reported case enters as a HOLD - resolveHolds
// decides afterwards whether it stays one. Stamping error here would auto-reject an
// add-on whose only fault is a missing disclosure on the ATN listing.
test("a reported hold-or-error case enters as a hold", () => {
  const r = review();
  applyVerdicts({
    findings: [],
    manual: r.manual,
    verdicts: verdicts({ 2: "reported" }),
    registry,
  });
  assert.equal(r.manual.length, 1);
});

// Each verb belongs to one kind of item, and an index past the end means the file was
// written against another review. Both refuse rather than being skipped, because a
// silently dropped answer is a report that understates what was settled.
test("an impossible verdict refuses the run", () => {
  const cases = [
    [{ 9: "cleared" }, /item 9 does not exist/],
    [{ 1: "reported" }, /item 1 is a finding, so it can only be "withdrawn"/],
    [
      { 3: "withdrawn" },
      /item 3 is a to-do item, so it is "reported" or "cleared"/,
    ],
  ];
  for (const [obj, re] of cases) {
    const r = review();
    assert.throws(
      () =>
        applyVerdicts({
          findings: r.findings,
          manual: r.manual,
          verdicts: verdicts(obj),
          registry,
        }),
      re
    );
  }
});

// The three to-do sections are one kind of item with two origins: a by-hand
// manual-checks reminder settles exactly as an escalation does. It is confirmed into the
// band its own registry entry declares and worded by that entry's response, or cleared
// away - which is what lets a reviewer hold a review for test credentials, a case no
// detector can ever raise.
test("a by-hand reminder settles like an escalation", () => {
  const manual = registry
    .manualChecks()
    .map((m) => ({ ...m, extended: false }));
  const held = manual.findIndex((m) => m.ruleId === "test-add-on");
  assert.ok(held > -1);
  assert.equal(manual[held].verdict, "hold");

  const findings = [];
  const list = manual.map((m) => ({ ...m }));
  applyVerdicts({
    findings,
    manual: list,
    verdicts: verdicts({ [held + 1]: "Report", [held + 2]: "Clear" }),
    registry,
  });
  // One confirmed into a finding, one cleared away, the rest still to do.
  assert.equal(list.length, manual.length - 2);
  assert.deepEqual(
    findings.map((f) => [f.ruleId, f.severity]),
    [["test-add-on", "hold"]]
  );
  // Worded by its own registry entry, like any other finding.
  renderFindings(findings, registry);
  assert.match(
    findings[0].message,
    /Please provide us with detailed information/
  );
});

// A check that declares no band a reported case could carry cannot be reported: inventing
// one is the auto-reject this whole design exists to prevent. No registry entry reaches
// this - every escalating check declares a band, and a check that does not escalate cannot
// become a to-do item - so the guard is a backstop, pinned here because what it prevents is
// publishing a finding at a severity nobody chose.
test("reporting a case with no band to carry refuses the run", () => {
  const item = mkItem("vendor-vulnerable", "Vulnerable bundled library");
  item.file = null;
  item.loc = null;
  assert.throws(
    () =>
      applyVerdicts({
        findings: [],
        manual: [item],
        verdicts: verdicts({ 1: "reported" }),
        registry,
      }),
    /declares no severity a reported case could carry/
  );
});

// The file is a contract, so every shape error names what is wrong with it rather than
// being silently ignored - an ignored answer is a report that understates.
test("a malformed verdict file is rejected with a reason", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-verdict-"));
  const write = (content) => {
    const p = path.join(dir, "v.json");
    fs.writeFileSync(p, content);
    return p;
  };
  const ok = '{"addon": "/x/a.xpi", "verdicts": {"2": "cleared"}}';
  assert.throws(() => readVerdicts(write("{")), /is not readable JSON/);
  assert.throws(() => readVerdicts(write("[]")), /must be an object/);
  // The add-on is the whole guard, so a file without it is refused.
  assert.throws(
    () => readVerdicts(write('{"verdicts": {"2": "cleared"}}')),
    /names no "addon"/
  );
  // Either block alone is a legitimate answer, but a file with neither settles nothing.
  assert.throws(
    () => readVerdicts(write('{"addon": "/x/a.xpi"}')),
    /carries neither "verdicts" nor "additions"/
  );
  assert.throws(
    () =>
      readVerdicts(
        write('{"addon": "/x/a.xpi", "verdicts": {"x": "cleared"}}')
      ),
    /"x" is not an item index/
  );
  // What an answer means needs the review it settles, so the file reader refuses only
  // what is not an answer at all - applyVerdicts is where "maybe" meets its item.
  assert.throws(
    () => readVerdicts(write('{"addon": "/x/a.xpi", "verdicts": {"1": ""}}')),
    /item 1 has ""/
  );
  assert.throws(
    () => readVerdicts(write('{"addon": "/x/a.xpi", "verdicts": {"1": 7}}')),
    /item 1 has 7/
  );
  assert.deepEqual(readVerdicts(write(ok)), {
    addon: "/x/a.xpi",
    additions: [],
    verdicts: verdicts({ 2: "cleared" }),
  });

  // An addition is addressed by check and locus, never by an index, so it is read into
  // its own list. `file` is required: a swept finding with nowhere to look is the exact
  // failure the per-check instructions exist to end.
  const withAdd = JSON.stringify({
    addon: "/x/a.xpi",
    additions: [{ check: "data-exfiltration", file: "bg.js", line: 40 }],
  });
  assert.deepEqual(readVerdicts(write(withAdd)), {
    addon: "/x/a.xpi",
    additions: [
      { check: "data-exfiltration", file: "bg.js", line: 40, hint: null },
    ],
    verdicts: verdicts({}),
  });
  assert.throws(
    () =>
      readVerdicts(
        write('{"addon": "/x/a.xpi", "additions": [{"check": "x"}]}')
      ),
    /names no "file"/
  );
  assert.throws(
    () =>
      readVerdicts(
        write(
          '{"addon": "/x/a.xpi", "additions": [{"check": "x", "file": "a.js", "verdict": "reported"}]}'
        )
      ),
    /may only set "check", "file", "line", "hint"/
  );
  assert.throws(
    () =>
      readVerdicts(
        write(
          `{"addon": "/x/a.xpi", "additions": [{"check": "x", "file": "a.js", "hint": "${"x".repeat(201)}"}]}`
        )
      ),
    /201-character hint/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// The display cap bounds the PAGE, not the review. An add-on with more sites than one
// entry can print still hands the reader every one of them, and a verdict naming a site
// the page folded into its "and N more" marker applies like any other. Capping the file
// too would mean the reader settles what they were handed while the rest pass unexamined,
// and the review reports no issue for sites nobody ever looked at.
test("an item the page withheld is in the file and can be settled", () => {
  const manual = Array.from({ length: 30 }, (_, i) =>
    mkItem("unused-permission", "Perms", "m.json", i + 1, `perm${i}`)
  );
  const items = reviewItems({ findings: [], manual, choices });
  assert.equal(items.length, 30, "every site reaches the item file");
  assert.deepEqual(
    items.map((x) => x.index),
    Array.from({ length: 30 }, (_, i) => i + 1),
    "numbered 1..N with no gaps, so no index is unaddressable"
  );
  // The last one is past the 25-line cap, so the report shows it only as "and N more".
  const beyondCap = items.at(-1);
  applyVerdicts({
    findings: [],
    manual,
    verdicts: verdicts({ [beyondCap.index]: "cleared" }),
    registry,
  });
  assert.equal(manual.length, 29, "the withheld item settled like any other");
});

// --llm-skip-manual asks only for what reading the ADD-ON can settle, so its item file omits
// the two sections a person answers - the prompt does not mention them either, and they stay
// in the report for the reviewer. It TRUNCATES the numbering and never renumbers: those are
// the last sections orderReview numbers, so an index means the same item in a cut-down file,
// a full file and the report alike. Renumbering here would silently re-aim every verdict at
// its neighbour, which is why the filter runs AFTER orderReview and not on its input.
test("--llm-skip-manual omits the manual sections without renumbering", () => {
  const findings = [mkFinding("unused-files", "error", "DEAD", "junk.txt", 1)];
  const code = mkItem("unused-permission", "Perms", "manifest.json", 3, "tabs");
  const extendedManual = {
    ...mkItem("privacy-policy", "Policy", null, 0),
    extended: true,
    section: "manual-review",
    file: null,
    loc: null,
  };
  const standard = {
    ...mkItem("test-add-on", "Test it", null, 0),
    extended: false,
    section: null,
    file: null,
    loc: null,
  };
  const manual = [code, extendedManual, standard];

  const full = reviewItems({ findings, manual, choices });
  assert.deepEqual(
    full.map((x) => [x.index, x.section]),
    [
      [1, "Found Issues"],
      [2, "Extended Code Review"],
      [3, "Extended Manual Review"],
      [4, "Standard Manual Review"],
    ]
  );

  const cut = reviewItems({ findings, manual, choices, skipManual: true });
  assert.deepEqual(
    cut.map((x) => [x.index, x.section]),
    [
      [1, "Found Issues"],
      [2, "Extended Code Review"],
    ],
    "the manual sections are gone and the survivors keep their numbers"
  );
  // The surviving entries are byte-for-byte what the full file holds for them: dropping
  // the tail changed nothing about the items ahead of it.
  assert.deepEqual(cut, full.slice(0, 2));
});

// The pre-sweep block is appended AFTER the skip filter, so it is still the tail of a
// cut-down file and still unnumbered - the property that keeps positions 0..M-1 aligned
// with indices 1..M once the manual sections are gone.
test("the pre-sweep tail is still the tail in a cut-down file", () => {
  const manual = [
    mkItem("unused-permission", "Perms", "manifest.json", 3, "tabs"),
    {
      ...mkItem("test-add-on", "Test it", null, 0),
      extended: false,
      section: null,
      file: null,
      loc: null,
    },
  ];
  const preSweep = { intro: "sweep", items: [{ check: "x", title: "t" }] };
  const items = reviewItems({
    findings: [],
    manual,
    choices,
    preSweep,
    skipManual: true,
  });
  const numbered = items.filter((x) => x.index !== undefined);
  assert.deepEqual(
    numbered.map((x) => x.index),
    [1]
  );
  assert.equal(items.at(-1).kind, "pre-sweep");
  assert.equal(items.length, numbered.length + 1);
});

// The round trip closes from a cut-down file: an index copied out of it resolves against
// the FULL ordered review, and the manual items it never listed are left standing for the
// reviewer rather than being treated as settled.
test("a verdict written from a cut-down item file applies", () => {
  const findings = [mkFinding("unused-files", "error", "DEAD", "junk.txt", 1)];
  const code = mkItem("unused-permission", "Perms", "manifest.json", 3, "tabs");
  const standard = {
    ...mkItem("test-add-on", "Test it", null, 0),
    extended: false,
    section: null,
    file: null,
    loc: null,
  };
  const manual = [code, standard];
  const items = reviewItems({ findings, manual, choices, skipManual: true });
  assert.equal(items.length, 2, "the standard item is not in the file");

  applyVerdicts({
    findings,
    manual,
    verdicts: verdicts({ [items[1].index]: "reported" }),
    registry,
  });
  assert.ok(
    !manual.includes(code),
    "the code item settled by its verify index"
  );
  assert.ok(
    manual.includes(standard),
    "the manual item is left for the reviewer"
  );
});

// The item file is what --llm-review hands over, so its indices must be the ones a verdict
// file keys by. Built from the same sequence the renderer walks, and its `ref` is the
// locus line the report prints - so a verdict copied out of the file is accepted, and the
// ref guard has nothing left to catch on this path.
test("a verdict written from the item file applies", () => {
  const findings = [
    mkFinding("unused-files", "error", "DEAD", "junk.txt", 1),
    mkFinding("eval-call", "warning", "EVAL", "a.js", 2),
  ];
  const manual = [
    mkItem("unused-permission", "Perms", "manifest.json", 3, "compose"),
  ];
  const items = reviewItems({ findings, manual, choices });
  assert.deepEqual(
    items.map((x) => [x.index, x.kind, x.file]),
    [
      [1, "finding", "junk.txt"],
      [2, "finding", "a.js"],
      [3, "todo", "manifest.json"],
    ]
  );
  // Keyed by the index the file states, which is all a verdict needs.
  applyVerdicts({
    findings,
    manual,
    verdicts: verdicts({
      [items[1].index]: "withdrawn",
      [items[2].index]: "reported",
    }),
    registry,
  });
  assert.deepEqual(
    findings.map((f) => [f.ruleId, f.severity]),
    [
      ["unused-files", "error"],
      ["unused-permission", "warning"],
    ]
  );
  assert.equal(manual.length, 0);
});

// An ADDITION is the other half of a verdict file: a case no check found, which a
// check's own sweep instruction sent a reader after. It carries no index - it was never
// in the numbered review - so it is addressed by the check it belongs to, and is filed
// as a finding OF that check, in that check's band. Nothing about it is the reader's
// except where they found it and a phrase naming what is there.
test("an addition is filed as a finding of the check it names", () => {
  const r = review();
  const { applied, added } = applyVerdicts({
    findings: r.findings,
    manual: r.manual,
    verdicts: verdicts({}),
    additions: [
      {
        check: "data-exfiltration",
        file: "background/background.js",
        line: 40,
        hint: "<a ping> attribute carries the digest",
      },
    ],
    registry,
  });
  assert.deepEqual(applied, []);
  assert.deepEqual(added, [
    "data-exfiltration (background/background.js:40 - <a ping> attribute carries the digest)",
  ]);
  const f = r.findings.at(-1);
  assert.equal(f.ruleId, "data-exfiltration");
  // The band is the registry's, never the answer's.
  assert.equal(f.severity, "error");
  assert.deepEqual(
    [f.file, f.loc, f.hint],
    [
      "background/background.js",
      { line: 40 },
      "<a ping> attribute carries the digest",
    ]
  );
  // No wording of its own: renderFindings gives it the owning check's response, the same
  // text a finding that check emitted itself would carry.
  assert.equal(f.message, null);
  renderFindings(r.findings, registry);
  assert.match(f.message, /send user data to a remote server/);
});

// The regression that matters most. orderReview numbers items AFTER sorting findings into
// severity bands, so an addition filed before the index map is built would push every
// later item down and silently re-aim each verdict at its neighbour. The map must be
// built from the review as the reader saw it.
test("an addition does not move the items a verdict names", () => {
  const before = review();
  const plain = applyVerdicts({
    findings: before.findings,
    manual: before.manual,
    verdicts: verdicts({ 4: "cleared" }),
    registry,
  });
  const after = review();
  const withAddition = applyVerdicts({
    findings: after.findings,
    manual: after.manual,
    verdicts: verdicts({ 4: "cleared" }),
    // An `error`, so it sorts to the top of the findings and would shift everything.
    additions: [
      { check: "data-exfiltration", file: "z.js", line: 1, hint: null },
    ],
    registry,
  });
  assert.deepEqual(withAddition.applied, plain.applied);
  assert.match(plain.applied[0], /^4 cleared /);
});

// An addition answers a question the review actually asked. A check that authors no
// sweep instruction asked nothing, so a finding filed under it came from nowhere.
test("an addition for a check that swept nothing refuses the run", () => {
  const r = review();
  assert.throws(
    () =>
      applyVerdicts({
        findings: r.findings,
        manual: r.manual,
        verdicts: verdicts({}),
        additions: [{ check: "eval-call", file: "a.js", line: 1, hint: null }],
        registry,
      }),
    /authors no `sweep-instruction`/
  );
  // Refused before anything was edited.
  assert.equal(r.findings.length, 2);
  assert.equal(r.manual.length, 2);
});

// Atomicity, both ways round: the file is checked whole before the review is touched, so
// a failure anywhere leaves it exactly as it was rather than half-settled.
test("a file that fails anywhere leaves the review untouched", () => {
  const r = review();
  assert.throws(
    () =>
      applyVerdicts({
        findings: r.findings,
        manual: r.manual,
        // Valid, and would apply on its own.
        verdicts: verdicts({ 4: "cleared" }),
        // Invalid, and comes after every verdict has already been checked.
        additions: [{ check: "eval-call", file: "a.js", line: 1, hint: null }],
        registry,
      }),
    /authors no `sweep-instruction`/
  );
  assert.equal(r.manual.length, 2, "the cleared to-do is still there");

  const r2 = review();
  assert.throws(
    () =>
      applyVerdicts({
        findings: r2.findings,
        manual: r2.manual,
        verdicts: verdicts({ 99: "cleared" }),
        additions: [
          { check: "data-exfiltration", file: "z.js", line: 1, hint: null },
        ],
        registry,
      }),
    /item 99 does not exist/
  );
  assert.equal(r2.findings.length, 2, "the addition was not filed either");
});

// ---- the question a manual item is put to the reviewer as ----
// The item file carries the FINISHED question: the reviewer's wording is the linter's, and
// a model composing it from the parts composes it differently each time. Only the two
// manual sections carry one - they are the only items a reviewer is asked - and its label
// is the progress through those questions, not the item's index in the review.

/** A manual-review to-do (the "Extended Manual Review" bucket). */
function mkManual(ruleId, title, item) {
  return {
    ...mkItem(ruleId, title, null, 0, item),
    extended: true,
    section: "manual-review",
    file: null,
    loc: null,
  };
}

/** A by-hand standard check: no locus of any kind. */
function mkStandard(ruleId, title) {
  return {
    ...mkItem(ruleId, title, null, 0),
    extended: false,
    section: null,
    file: null,
    loc: null,
  };
}

test("a manual item carries its question and its progress label", () => {
  const findings = [mkFinding("unused-files", "error", "DEAD", "junk.txt", 1)];
  const code = mkItem(
    "unused-permission",
    "Perms",
    "manifest.json",
    3,
    "compose"
  );
  const manual = [
    code,
    mkManual("privacy-policy", "Policy", "api.example.com"),
    mkStandard("test-add-on", "Test it"),
  ];
  const items = reviewItems({ findings, manual, choices });

  assert.deepEqual(
    items.filter((x) => x.label).map((x) => [x.label, x.section]),
    [
      ["1/2", "Extended Manual Review"],
      ["2/2", "Standard Manual Review"],
    ],
    "labelled 1..N over the QUESTIONS - the finding and the code-review item are not asked"
  );
  // The locus in parentheses is the string the report prints under the entry, so the
  // reviewer can find the case in the page in front of them.
  assert.equal(items[2].message, "[Policy] inspect Policy (api.example.com)");
  // A by-hand check points at nothing, and empty parentheses would say it does.
  assert.equal(items[3].message, "[Test it] inspect Test it");
  // Nothing else grew a question: a progress label on an item nobody asks would count a
  // question that is never put.
  assert.deepEqual(
    items.filter((x) => x.label === undefined).map((x) => x.section),
    ["Found Issues", "Extended Code Review"]
  );
  assert.equal(
    items[1].message,
    undefined,
    "the code-review item is settled, not asked"
  );
});

// The report collapses repeats of one check into ONE entry with a list of locations. The
// questions do not: each case is settled on its own, and its verdict is keyed by its own
// index - so a reviewer asked twice must be able to tell which case they are answering.
test("two cases of one check are two questions, told apart by their locus", () => {
  const manual = [
    mkManual("privacy-policy", "Policy", "api.example.com"),
    mkManual("privacy-policy", "Policy", "metrics.example.com"),
  ];
  const items = reviewItems({ findings: [], manual, choices });
  assert.deepEqual(
    items.map((x) => x.entry),
    [1, 1],
    "one entry in the report"
  );
  assert.deepEqual(
    items.map((x) => [x.label, x.message]),
    [
      ["1/2", "[Policy] inspect Policy (api.example.com)"],
      ["2/2", "[Policy] inspect Policy (metrics.example.com)"],
    ],
    "two questions here, identical but for the case they name"
  );
});

// --llm-skip-manual puts nothing to a reviewer, so its file holds no question - and no
// total counting questions that file never carried.
test("a cut-down item file asks nothing and so labels nothing", () => {
  const manual = [
    mkItem("unused-permission", "Perms", "manifest.json", 3, "compose"),
    mkManual("privacy-policy", "Policy", "api.example.com"),
    mkStandard("test-add-on", "Test it"),
  ];
  const items = reviewItems({
    findings: [],
    manual,
    choices,
    skipManual: true,
  });
  assert.deepEqual(
    items.map((x) => x.section),
    ["Extended Code Review"]
  );
  assert.equal(items[0].label, undefined);
  assert.equal(items[0].message, undefined);
});

// In an SCA review the report labels every locus by artifact, and the question has to say
// the same thing: "package.json" alone names a file in either of the two artifacts.
test("a question's locus carries the artifact label the report gives it", () => {
  const manual = [
    {
      ...mkItem("undeclared-build-source", "Build", "package.json", 0),
      extended: true,
      section: "manual-review",
      loc: null,
    },
  ];
  const items = reviewItems({
    findings: [],
    manual,
    choices,
    labelOf: () => "SCA",
  });
  assert.equal(items[0].message, "[Build] inspect Build ([SCA] package.json)");
});

// The registry authors its instructions wrapped, and those wraps are the YAML's layout,
// not the sentence's. The report already flattens them for its entry body; a question
// asked with them intact would reach the reviewer broken across lines mid-clause.
test("a question flattens the instructions the registry wrapped", () => {
  const manual = [
    {
      ...mkStandard("test-add-on", "Test it"),
      instructions: "Open the add-on\nin a test profile,\n  then exercise it.",
    },
  ];
  assert.equal(
    reviewItems({ findings: [], manual, choices })[0].message,
    "[Test it] Open the add-on in a test profile, then exercise it."
  );
});

// The point of composing the question here is that it names its case in the words the
// settled report uses - so a reviewer answering "which of these two?" and the developer
// reading the report are looking at one string. Rendered, not asserted against a literal:
// a change to locationLine or to the artifact label must move both or fail here.
test("a question's locus is the locus line the report prints", () => {
  const manual = [
    mkManual("privacy-policy", "Policy", "api.example.com"),
    mkManual("privacy-policy", "Policy", "metrics.example.com"),
  ];
  const items = reviewItems({ findings: [], manual, choices });
  const printed = formatText({
    findings: [],
    meta: {
      action: "review",
      addon: "x",
      reviewed: true,
      manualReview: manual,
    },
  })
    .split("── Extended Manual Review ──")[1]
    .split("── Standard")[0];
  for (const x of items) {
    const locus = x.message.slice(x.message.lastIndexOf("(") + 1, -1);
    assert.ok(
      printed.includes(`\n - ${locus}\n`),
      `the report lists "${locus}" as a location of its own`
    );
  }
});

// What an item of each kind carries, asserted as a whole key set: the file is a contract,
// and a field added or dropped is a change to it. A question carries the finished question
// and NOT the parts it was composed from - a reader told to ask it as written should not
// also hold the material to write a different one - while an item settled by reading the
// add-on carries the instructions its reader follows and no question at all.
test("each kind of item carries what settling it needs, and no more", () => {
  const findings = [mkFinding("unused-files", "error", "DEAD", "junk.txt", 1)];
  const code = mkItem(
    "unused-permission",
    "Perms",
    "manifest.json",
    3,
    "compose"
  );
  const manual = [
    code,
    mkManual("privacy-policy", "Policy", "api.example.com"),
  ];
  const items = reviewItems({ findings, manual, choices });
  const keys = (kind) => Object.keys(items.find(kind)).sort().join(",");

  assert.equal(
    keys((x) => x.label),
    "answers,entry,file,hint,index,item,kind,label,loc,message,ruleId,section,suggestedResponse,suggestedVerdict"
  );
  assert.equal(
    keys((x) => x.section === "Extended Code Review"),
    "entry,file,hint,index,instructions,item,kind,loc,ruleId,section,suggestedResponse,suggestedVerdict"
  );
  assert.equal(
    keys((x) => x.kind === "finding"),
    "entry,file,hint,index,item,kind,loc,message,ruleId,section,severity"
  );
  // The verdict each answer settles the item with is the linter's business: the file
  // carries only what the reviewer reads, so a reader cannot write a verdict of its own.
  assert.deepEqual(
    items.find((x) => x.answers).answers,
    choices.map(({ label, description }) => ({ label, description }))
  );
  assert.ok(
    choices.every((c) => c.verdict),
    "the registry knows the verdicts it did not hand over"
  );
});

// The registry's order IS the order a reviewer sees, and nothing else has a say: a rule
// living anywhere but that list would have to be kept in step with it by hand. Flipping
// the authoring flips what the question offers AND what the first position settles, so a
// reviewer answering by position is answering the list.
test("the authored answer order is the order a question offers", () => {
  const flipped = loadRegistry();
  flipped.doc["llm-manual-review-choices"] = [
    ...flipped.doc["llm-manual-review-choices"],
  ].reverse();
  const asAuthored = registry.manualReviewChoices();
  const other = flipped.manualReviewChoices();
  assert.deepEqual(
    other.map((c) => c.label),
    asAuthored.map((c) => c.label).reverse()
  );

  for (const choices of [asAuthored, other]) {
    const manual = [mkManual("privacy-policy", "Policy", "api.example.com")];
    const items = reviewItems({ findings: [], manual, choices });
    assert.deepEqual(
      items.find((x) => x.answers).answers.map((a) => a.label),
      choices.map((c) => c.label),
      "the file offers them in the authored order"
    );
    // ...and the first position settles what the list says it settles, either way round:
    // a reported case becomes a finding, a cleared one leaves nothing behind.
    const findings = [];
    applyVerdicts({
      findings,
      manual,
      verdicts: verdicts({ 1: choices[0].label }),
      registry: choices === other ? flipped : registry,
    });
    assert.equal(
      findings.length,
      choices[0].verdict === "reported" ? 1 : 0,
      `answer 1 settles as ${choices[0].verdict}`
    );
  }
});

// ---- what a reviewer answered ----
// A question offers the answers the registry authors, and the reviewer either picks one or
// types instead. The verdict file carries what they gave, verbatim; turning that into a
// verdict is the linter's job. Typed words are a report carrying them: they reach the
// developer on the case's LOCATION line, while the response paragraph above stays the
// registry's word for word.

/** The label of the answer that clears a case, and of the one that reports it. */
const [CLEAR, REPORT] = registry.manualReviewChoices().map((c) => c.label);

/** The settled report's Found Issues body, for a review of `manual` answered by `answers`. */
function settled(manual, answers) {
  const findings = [];
  applyVerdicts({ findings, manual, verdicts: verdicts(answers), registry });
  renderFindings(findings, registry);
  return {
    findings,
    body: formatText({
      findings,
      meta: {
        action: "review",
        addon: "x",
        reviewed: true,
        manualReview: manual,
      },
    })
      .split("── Found Issues ──")[1]
      .split("You can run")[0],
  };
}

/** Settle one question with `answer`, for the cases that must be refused. */
function answerQuestion(
  answer,
  item = mkManual("privacy-policy", "Policy", "api.example.com")
) {
  const manual = [item];
  return () =>
    applyVerdicts({
      findings: [],
      manual,
      verdicts: verdicts({ 1: answer }),
      registry,
    });
}

test("a typed answer closes the case's location line in parentheses", () => {
  const manual = [mkManual("privacy-policy", "Policy", "api.example.com")];
  const { body } = settled(manual, {
    1: "the German listing text is outdated too",
  });
  assert.match(
    body,
    /\n - api\.example\.com \(the German listing text is outdated too\)\n/
  );
});

// A case that names no location still carries what the reviewer said about it, and that
// line is the only place it can appear - so a note is a locus of its own.
test("a case with no location renders as the answer alone", () => {
  const manual = [mkStandard("test-add-on", "Test it")];
  const { body } = settled(manual, { 1: "the trial expires after two weeks" });
  assert.match(body, /\n - the trial expires after two weeks\n/);
});

// A reviewer asked what a check found answers with a list as often as with a sentence, so
// their lines are kept and each becomes an item of its own. The report opens every one with
// "- ", so the bullet they typed is dropped rather than printed twice.
test("a typed answer keeps the reviewer's lines, one item each", () => {
  const manual = [mkStandard("test-add-on", "Test it")];
  const { findings, body } = settled(manual, {
    1: "  - the BrowserShim is bad\n\n* today is monday  ",
  });
  assert.equal(findings[0].note, "the BrowserShim is bad\ntoday is monday");
  assert.match(body, /\n - the BrowserShim is bad\n - today is monday\n/);

  // Inside a line it is still one line: a wrapped sentence does not become two items.
  const one = settled([mkStandard("test-add-on", "Test it")], {
    1: "the listing text\tis   outdated",
  });
  assert.equal(one.findings[0].note, "the listing text is outdated");
});

// The answer travels on the location line, not in the response, so two cases of one check
// still share one paragraph - the developer reads it once, and only the line carrying the
// reviewer's words differs.
test("an answered case stays in its entry beside one that was only reported", () => {
  const manual = [
    mkManual("privacy-policy", "Policy", "api.example.com"),
    mkManual("privacy-policy", "Policy", "metrics.example.com"),
  ];
  const { body } = settled(manual, {
    1: "and the listing is out of date",
    2: REPORT,
  });
  assert.equal(
    body.match(/^\d+\) /gm).length,
    1,
    "one numbered entry, not one per answer"
  );
  assert.match(
    body,
    /\n - api\.example\.com \(and the listing is out of date\)\n - metrics\.example\.com\n/
  );
});

// The two vocabularies are keyed on the item, and crossing them is refused both ways. A
// verb on a question is a model answering for the reviewer; a reviewer's answer on an item
// nobody was asked is a model writing prose a developer reads.
test("an answer belongs to the kind of item it settles", () => {
  assert.throws(
    answerQuestion("cleared"),
    /was put to a reviewer and carries "cleared" - answer it as they did, with "Clear" or "Report"/
  );
  const code = mkItem(
    "unused-permission",
    "Perms",
    "manifest.json",
    3,
    "compose"
  );
  assert.throws(
    () =>
      applyVerdicts({
        findings: [],
        manual: [code],
        verdicts: verdicts({ 1: "I judged this myself" }),
        registry,
      }),
    /was not put to a reviewer - it is settled by reading the add-on/
  );
  // A label is not a verb either: the same guard, the other way round.
  assert.throws(
    () =>
      applyVerdicts({
        findings: [],
        manual: [code],
        verdicts: verdicts({ 1: CLEAR }),
        registry,
      }),
    /was not put to a reviewer/
  );
});

// The limit the reviewer is told about in the answer they read, and the limit the linter
// enforces, are ONE number - the answer's description is filled from it. Asserted against
// the constant rather than against a number parsed out of English, so the test survives a
// rewording and fails on what it is about: the two parting.
test("the limit the answers state is the limit the linter enforces", () => {
  const limit = MAX_NOTE;
  const stating = registry
    .manualReviewChoices()
    .filter((c) => c.description.includes(`${limit} characters`));
  assert.equal(stating.length, 1, "exactly one answer states the limit");
  assert.ok(
    !stating[0].description.includes("{{"),
    "and states it as a number, not as the slot it was filled from"
  );

  const manual = [mkStandard("test-add-on", "Test it")];
  const { findings } = settled(manual, { 1: "x".repeat(limit) });
  assert.equal(findings[0].note.length, limit, "the stated limit is accepted");
  assert.throws(
    answerQuestion("x".repeat(limit + 1)),
    new RegExp(`${limit + 1}-character answer and the limit is ${limit}`),
    "one character more is refused, naming the item so the question can be asked again"
  );
  // Counted as the reviewer counts: an emoji is one character, not the two UTF-16 units it
  // is stored as, so the refusal states a number they can act on.
  const emoji = settled([mkStandard("test-add-on", "Test it")], {
    1: "\u{1F600}".repeat(limit),
  });
  assert.equal(
    [...emoji.findings[0].note].length,
    limit,
    "counted in code points"
  );
});

// A reviewer who typed into the free-text box and thought better of it leaves a bullet
// behind. That says nothing, so it is the empty answer - not a note reading "-".
test("an answer that is only a bullet is no answer", () => {
  for (const typed of ["-", "- ", "  *  ", "\u2022", "-\n-\n"]) {
    assert.throws(
      answerQuestion(typed),
      /carries an answer with nothing in it/,
      JSON.stringify(typed)
    );
  }
  // A dash that is part of what they wrote stays.
  const { findings } = settled([mkStandard("test-add-on", "Test it")], {
    1: "-5 icons are missing",
  });
  assert.equal(findings[0].note, "-5 icons are missing");
});

// The machine document says what the report says. A review with no answers of that kind is
// the document it always was - the key appears only where a reviewer wrote something.
test("the JSON carries a note only where there is one", () => {
  const manual = [
    mkManual("privacy-policy", "Policy", "api.example.com"),
    mkManual("privacy-policy", "Policy", "metrics.example.com"),
  ];
  const { findings } = settled(manual, {
    1: "and the listing is out of date",
    2: REPORT,
  });
  const doc = JSON.parse(
    formatJson({
      findings,
      meta: { action: "review", addon: "x", reviewed: true },
    })
  );
  assert.deepEqual(
    doc.findings.map((f) => f.note ?? null),
    ["and the listing is out of date", null]
  );
  assert.ok(
    !Object.hasOwn(doc.findings[1], "note"),
    "absent, not null, on a finding nobody annotated"
  );
});

// ---- a check whose report IS what the reviewer found ----
// Such a check authors a `default-note`: its response ends on a list, and the list is the
// reviewer's words. Authoring that fallback is the declaration - it stands in when the case
// was reported with none, so the list is never an introduction with nothing under it.

test("a check that authors a default note falls back to it", () => {
  const item = {
    ...mkItem("experiment-manual-review", "Experiment", null, 0),
    extended: true,
    section: "manual-review",
    file: null,
    loc: null,
  };
  assert.ok(registry.defaultNote("experiment-manual-review"));

  // Reported with nothing written: the marker stands in, normalised like any answer, so
  // the report's own bullet is not doubled.
  const bare = settled([{ ...item }], { 1: REPORT });
  assert.equal(bare.findings[0].note, "...");
  assert.match(bare.body, /\n - \.\.\.\n/);

  // What the reviewer wrote wins over it.
  const written = settled([{ ...item }], {
    1: "the BrowserShim reaches too far",
  });
  assert.equal(written.findings[0].note, "the BrowserShim reaches too far");

  // A check that authors none gets none.
  const other = settled([mkStandard("test-add-on", "Test it")], { 1: REPORT });
  assert.equal(other.findings[0].note, null);
});

// The response a reviewer pastes by hand ends on the same list, so the marker is appended
// there too - a list introduction with nothing under it is half a sentence.
test("the default note completes the response the reviewer pastes", () => {
  const [rendered] = renderManualItems(
    [{ ruleId: "experiment-manual-review", item: null }],
    registry
  );
  assert.match(
    rendered.response,
    /The following need to be addressed:\n\n- \.\.\.$/
  );
});
