// Unit tests for --llm-verdict: settling a finished review against answers a reviewer
// (or a model) gave it. The answers carry no prose - every guard here exists because a
// verdict that lands on the wrong item, or brings its own wording, would corrupt a
// report that is otherwise entirely the linter's.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyVerdicts } from "../../src/report/verdicts.js";
import { loadRegistry } from "../../src/checks/registry.js";
import { MAX_NOTE } from "../../src/config.js";
import {
  renderFindings,
  renderManualItems,
  withDefaultNotes,
} from "../../src/report/responses.js";
import { reviewItems } from "../../src/report/items.js";
import { isQuestion } from "../../src/report/order.js";
import { entriesFor } from "../../src/report/handback.js";
import { formatText, formatJson } from "../../src/report/format.js";

const registry = loadRegistry();
// The phase as the registry authors it: a hand-over's shape follows its `answer` kind, so
// a test naming a phase names the real one rather than a literal the code no longer reads.
const phase = (name) =>
  registry.llmPhases().phases.find((p) => p.name === name);
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
    llmInstructions: `inspect ${title}`,
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
  const { applied } = applyVerdicts({
    asking: isQuestion,
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
    asking: isQuestion,
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
//
// "reported" on a FINDING is not impossible: it is how a finding that holds is spelled,
// because the loop requires every slot to be filled. See the test below it.
test("an impossible verdict refuses the run", () => {
  const cases = [
    [{ 9: "cleared" }, /item 9 does not exist/],
    [
      { 1: "cleared" },
      /item 1 is a finding, so it is "reported" or "withdrawn"/,
    ],
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
          asking: isQuestion,
          findings: r.findings,
          manual: r.manual,
          verdicts: verdicts(obj),
          registry,
        }),
      re
    );
  }
});

// A finding that HOLDS is answered "reported": the review loop fills every slot, so
// standing has a word of its own. It changes nothing - the finding stays exactly as it
// was - and it is absent from the audit line for the same reason silence was, which is
// that the line says what a verdict DID.
test("a finding that holds is reported, and nothing happens to it", () => {
  const r = review();
  const before = JSON.stringify(r.findings);
  const { applied } = applyVerdicts({
    asking: isQuestion,
    findings: r.findings,
    manual: r.manual,
    verdicts: verdicts({ 1: "reported" }),
    registry,
  });
  assert.equal(JSON.stringify(r.findings), before, "the review is untouched");
  assert.deepEqual(applied, [], "nothing to report in the audit line");
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
    asking: isQuestion,
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
        asking: isQuestion,
        findings: [],
        manual: [item],
        verdicts: verdicts({ 1: "reported" }),
        registry,
      }),
    /declares no severity a reported case could carry/
  );
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
    asking: isQuestion,
    findings: [],
    manual,
    verdicts: verdicts({ [beyondCap.index]: "cleared" }),
    registry,
  });
  assert.equal(manual.length, 29, "the withheld item settled like any other");
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
    asking: isQuestion,
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
    // A by-hand check authors one text, for the person who works through it.
    llmInstructions: null,
    extended: false,
    section: null,
    file: null,
    loc: null,
  };
}

test("every to-do carries both wordings, and the phase picks between them", () => {
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

  // Every to-do is worded BOTH ways, whatever section it sits in: an item cannot know
  // who will be asked about it, so it carries what either reader would need and the
  // phase that hands it out chooses (entriesFor, asserted below).
  for (const x of items.filter((x) => x.kind === "todo")) {
    assert.ok(x.message, `${x.section} carries no question`);
    assert.ok(x.answers?.length, `${x.section} offers no answers`);
    assert.ok("instructions" in x, `${x.section} carries no instructions`);
  }
  // The locus in parentheses is the string the report prints under the entry, so the
  // reviewer can find the case in the page in front of them.
  assert.equal(items[2].message, "[Policy] inspect Policy (api.example.com)");
  // A by-hand check points at nothing, and empty parentheses would say it does.
  assert.equal(items[3].message, "[Test it] inspect Test it");
  // A finding is a claim, not a question: nobody is offered answers to it.
  const finding = items.find((x) => x.kind === "finding");
  assert.equal(finding.answers, undefined);
  assert.equal(finding.instructions, undefined);

  // And the phase is what picks. The same three to-dos, handed to a person, carry the
  // question and a label counting it; handed to the agent, the instructions instead.
  const todos = items.filter((x) => x.kind === "todo");
  const asked = entriesFor(todos, phase("ask"));
  assert.deepEqual(
    asked.map((e) => e.label),
    ["1/3", "2/3", "3/3"],
    "labelled 1..N over what this pass actually puts to a person"
  );
  assert.ok(asked.every((e) => e.message && !("instructions" in e)));
  const settled = entriesFor(todos, phase("settle"));
  assert.ok(settled.every((e) => !("message" in e) && !("label" in e)));
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
    entriesFor(items, phase("ask")).map((e) => [e.label, e.message]),
    [
      ["1/2", "[Policy] inspect Policy (api.example.com)"],
      ["2/2", "[Policy] inspect Policy (metrics.example.com)"],
    ],
    "two questions here, identical but for the case they name"
  );
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
      xpi: "x",
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

// What a phase hands over, asserted as a whole key set: the REVIEW file is a contract, and
// a field added or dropped is a change to it. A question carries the finished question and
// NOT the parts it was composed from - a reader told to ask it as written should not also
// hold the material to write a different one - while an item settled by reading the add-on
// carries the instructions its reader follows and no question at all.
//
// Both wordings sit on the item (reviewItems); the SEPARATION is made here, when a phase
// hands it out, which is why this is asserted against the entries and not the item.
test("each phase hands over what settling it needs, and no more", () => {
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
  const pick = (kind) => items.filter(kind);
  const keys = (entries) => Object.keys(entries[0]).sort().join(",");

  assert.equal(
    keys(
      entriesFor(
        pick((x) => x.kind === "todo"),
        phase("ask")
      )
    ),
    "answer,answers,index,label,message"
  );
  assert.equal(
    keys(
      entriesFor(
        pick((x) => x.section === "Extended Code Review"),
        phase("settle")
      )
    ),
    "answer,answers,file,index,instructions,item,line,ruleId"
  );
  assert.equal(
    keys(
      entriesFor(
        pick((x) => x.kind === "finding"),
        phase("verify")
      )
    ),
    "answer,answers,file,index,line,ruleId"
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
      asking: isQuestion,
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
  applyVerdicts({
    asking: isQuestion,
    findings,
    manual,
    verdicts: verdicts(answers),
    registry,
  });
  renderFindings(findings, registry);
  return {
    findings,
    body: formatText({
      findings,
      meta: {
        action: "review",
        xpi: "x",
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
      asking: isQuestion,
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

// The two vocabularies are keyed on the item, but the crossing is refused ONE way, not
// both. A verb on a question is a model answering for the reviewer, which is refused - it
// is not knowable that the words are theirs. The other direction needs no refusal: `picked`
// already found every answer that spells one of the labels offered, so anything left IS a
// sentence, whatever word it happens to read like. A reviewer's own "cleared" is their
// answer, not a verb that slipped past a label match.
test("an answer belongs to the kind of item it settles", () => {
  const { applied } = applyVerdicts({
    asking: isQuestion,
    findings: [],
    manual: [mkManual("privacy-policy", "Policy", "api.example.com")],
    verdicts: verdicts({ 1: "cleared" }),
    registry,
  });
  assert.deepEqual(applied, ["1 reported + note (api.example.com)"]);

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
        asking: isQuestion,
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
        asking: isQuestion,
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
      meta: { action: "review", xpi: "x", reviewed: true },
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

// The response a DETERMINISTIC run prints ends on the same list, so the marker completes it
// there too - a list introduction with nothing under it is half a sentence. Appended by
// withDefaultNotes, which sees the escalations and the by-hand manual checks together, so
// a reviewer is handed the same thing whichever list the item came from.
test("the default note completes the response a deterministic run prints", () => {
  const [rendered] = withDefaultNotes(
    renderManualItems(
      [{ ruleId: "experiment-manual-review", item: null }],
      registry
    ),
    registry
  );
  assert.match(
    rendered.response,
    /The following need to be addressed:\n\n- \.\.\.$/
  );
});

// What the reviewer said replaces the marker, whichever kind of item they said it about.
// The default note stands in for words they did not write, so an answer that carries words
// must leave no trace of it - and a bare "Report" must leave the marker, because the case
// still ends on a list somebody has to fill. Asserted for both origins, since the marker is
// resolved by ruleId and the two lists reach that lookup from different sides.
test("a reviewer's words replace the default note, for both kinds of item", () => {
  const reg = loadRegistry();
  // The shipped Experiment escalation authors one; a manual check is given one here,
  // because the shipped registry authors none and inventing one is a product decision.
  const manualEntry = reg.doc["manual-checks"].find(
    (e) => e.check === "test-add-on"
  );
  manualEntry["default-note"] = "- ...";
  const marker = "- ...";

  const kinds = [
    [
      "escalation",
      () => mkManual("experiment-manual-review", "Experiment", null),
    ],
    ["manual check", () => mkStandard(manualEntry.check, "By hand")],
  ];
  for (const [what, make] of kinds) {
    // Answered with their own words: the words are the note, and the marker is gone.
    const written = [make()];
    const findings = [];
    applyVerdicts({
      asking: isQuestion,
      findings,
      manual: written,
      verdicts: verdicts({ 1: "two icons are missing" }),
      registry: reg,
    });
    assert.equal(findings.length, 1, `${what} reported`);
    assert.equal(findings[0].note, "two icons are missing", `${what} note`);
    assert.ok(
      !(findings[0].note ?? "").includes(marker),
      `${what} marker gone`
    );

    // Answered by picking "Report": the marker stands in for the words they did not write.
    const silent = [make()];
    const fallback = [];
    applyVerdicts({
      asking: isQuestion,
      findings: fallback,
      manual: silent,
      verdicts: verdicts({ 1: "Report" }),
      registry: reg,
    });
    assert.equal(fallback.length, 1, `${what} reported by label`);
    assert.equal(fallback[0].note, "...", `${what} falls back to the marker`);

    // Cleared: nothing is filed at all, so no note of either kind can reach a developer.
    const cleared = [make()];
    const none = [];
    applyVerdicts({
      asking: isQuestion,
      findings: none,
      manual: cleared,
      verdicts: verdicts({ 1: "Clear" }),
      registry: reg,
    });
    assert.equal(none.length, 0, `${what} cleared`);
  }
});

// `asking` is the ONE thing that decides which vocabulary an answer is read in, and it is
// the caller's to state: the phase that answered an item knows, and the item does not. A
// case the agent sends on with `ask` is put to a reviewer while keeping the section it was
// filed under, so reading the item would refuse the very words they gave.
//
// Asserted against the SAME item both ways, so nothing but the predicate can explain the
// difference - an assertion that swapped the item too would pass on either.
test("`asking` decides the vocabulary, not the item's section", () => {
  const code = mkItem(
    "unused-permission",
    "Perms",
    "manifest.json",
    3,
    "compose"
  );
  const [clear] = registry.manualReviewChoices().map((c) => c.label);

  // Its section says "settled by reading the add-on", and answered in that phase it takes
  // a verb and refuses a reviewer's label.
  const asAgent = () =>
    applyVerdicts({
      asking: () => false,
      findings: [],
      manual: [{ ...code }],
      verdicts: verdicts({ 1: clear }),
      registry,
    });
  assert.throws(asAgent, /was not put to a reviewer/);

  // The same item, answered in the phase that asks a person: their label settles it, and
  // the audit line says so.
  const { applied } = applyVerdicts({
    asking: () => true,
    findings: [],
    manual: [{ ...code }],
    verdicts: verdicts({ 1: clear }),
    registry,
  });
  assert.deepEqual(applied, ["1 cleared (manifest.json:3 - compose)"]);

  // And it is required: nothing may fall back to reading the item.
  assert.throws(
    () =>
      applyVerdicts({
        findings: [],
        manual: [{ ...code }],
        verdicts: verdicts({ 1: clear }),
        registry,
      }),
    /asking is not a function/
  );
});
