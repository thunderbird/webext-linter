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
import { renderFindings } from "../../src/report/responses.js";
import { reviewItems } from "../../src/report/items.js";
import { formatText } from "../../src/report/format.js";

const registry = loadRegistry();

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
    verdicts: verdicts({ [held + 1]: "reported", [held + 2]: "cleared" }),
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
  assert.throws(
    () =>
      readVerdicts(write('{"addon": "/x/a.xpi", "verdicts": {"1": "maybe"}}')),
    /has verdict "maybe"/
  );
  assert.deepEqual(readVerdicts(write(ok)), {
    addon: "/x/a.xpi",
    additions: [],
    verdicts: new Map([[2, "cleared"]]),
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
    verdicts: new Map(),
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
  const items = reviewItems([], manual);
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
    verdicts: new Map([[beyondCap.index, "cleared"]]),
    registry,
  });
  assert.equal(manual.length, 29, "the withheld item settled like any other");
});

// --llm-verify asks only for what reading the ADD-ON can settle, so its item file omits the
// two sections a person answers - the prompt does not mention them either, and they stay in
// the report for the reviewer. It TRUNCATES the numbering and never renumbers: those are the
// last sections orderReview numbers, so an index means the same item in a verify file, a
// full file and the report alike. Renumbering here would silently re-aim every verdict at
// its neighbour, which is why the filter runs AFTER orderReview and not on its input.
test("a verify item file omits the manual sections without renumbering", () => {
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

  const full = reviewItems(findings, manual, null, "full");
  assert.deepEqual(
    full.map((x) => [x.index, x.section]),
    [
      [1, "Found Issues"],
      [2, "Extended Code Review"],
      [3, "Extended Manual Review"],
      [4, "Standard Manual Review"],
    ]
  );

  const verify = reviewItems(findings, manual, null, "verify");
  assert.deepEqual(
    verify.map((x) => [x.index, x.section]),
    [
      [1, "Found Issues"],
      [2, "Extended Code Review"],
    ],
    "the manual sections are gone and the survivors keep their numbers"
  );
  // The surviving entries are byte-for-byte what the full file holds for them: dropping
  // the tail changed nothing about the items ahead of it.
  assert.deepEqual(verify, full.slice(0, 2));
});

// The pre-sweep block is appended AFTER the mode filter, so it is still the tail of a
// verify file and still unnumbered - the property that keeps positions 0..M-1 aligned with
// indices 1..M once the manual sections are gone.
test("the pre-sweep tail is still the tail in a verify file", () => {
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
  const items = reviewItems([], manual, preSweep, "verify");
  const numbered = items.filter((x) => x.index !== undefined);
  assert.deepEqual(
    numbered.map((x) => x.index),
    [1]
  );
  assert.equal(items.at(-1).kind, "pre-sweep");
  assert.equal(items.length, numbered.length + 1);
});

// The round trip closes from a verify file: an index copied out of it resolves against the
// FULL ordered review, and the manual items it never listed are left standing for the
// reviewer rather than being treated as settled.
test("a verdict written from a verify item file applies", () => {
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
  const items = reviewItems(findings, manual, null, "verify");
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
  const items = reviewItems(findings, manual);
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
    verdicts: new Map(),
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
        verdicts: new Map(),
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
  const items = reviewItems(findings, manual);

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
  const items = reviewItems([], manual);
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

// --llm-verify puts nothing to a reviewer, so its file holds no question - and no total
// counting questions that file never carried.
test("a verify item file asks nothing and so labels nothing", () => {
  const manual = [
    mkItem("unused-permission", "Perms", "manifest.json", 3, "compose"),
    mkManual("privacy-policy", "Policy", "api.example.com"),
    mkStandard("test-add-on", "Test it"),
  ];
  const items = reviewItems([], manual, null, "verify");
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
  const items = reviewItems([], manual, null, "full", () => "SCA");
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
    reviewItems([], manual)[0].message,
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
  const items = reviewItems([], manual);
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
