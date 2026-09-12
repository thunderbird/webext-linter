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
  const applied = applyVerdicts({
    findings: r.findings,
    manual: r.manual,
    verdicts: verdicts({ 2: "withdrawn", 3: "reported", 4: "cleared" }),
    registry,
  });
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
  assert.throws(
    () => readVerdicts(write('{"addon": "/x/a.xpi"}')),
    /carries no "verdicts"/
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
    verdicts: new Map([[2, "cleared"]]),
  });
  fs.rmSync(dir, { recursive: true, force: true });
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
