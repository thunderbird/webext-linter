// The REVIEW LOOP, driven end to end with no agent: every phase handed out, answered from
// a canned decision, and handed back.
//
// This file is the safety net for the whole round trip. 182 goldens contain no prompt
// output at all, so the golden suite cannot catch a regression here and will not need
// regenerating either. Everything this half of the tool does that is testable
// is testable because `state + a filled review file -> the next state` is a pure
// transformation.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRegistry } from "../../src/checks/registry.js";
import { REVIEW_MODE } from "../../src/lib/enum.js";
import { ARTIFACT_SCA, ARTIFACT_XPI } from "../../src/lib/artifacts.js";
import { renderFindings } from "../../src/report/responses.js";
import { STATE_VERSION, readState } from "../../src/report/state.js";
import { orderReview } from "../../src/report/order.js";
import { writeReportFile } from "../../src/report/report-file.js";
import {
  issue,
  accept,
  settle,
  reviewDetails,
  HandbackRefused,
} from "../../src/report/loop.js";

const REGISTRY = loadRegistry();
const PHASES = REGISTRY.llmPhases().phases;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wxl-loop-"));

/** A review small enough to read, carrying one of each kind the loop routes:
 *  two findings (verify), one code-review case (settle), two questions (ask). */
function review(
  dir,
  { sweep = true, findings = true, code = true, questions = true } = {}
) {
  const base = path.join(dir, "r");
  const finding = (i, ruleId) => ({
    ruleId,
    severity: "error",
    file: `f${i}.js`,
    loc: { line: i },
    // Every finding carries the artifact its path is in, as its holder minted it
    // (src/checks/registry.js runOneCheck). A v6 state without it is not one the loop
    // can hand out: entriesFor has no root to resolve the path against.
    artifact: "XPI",
    message: `finding ${i}`,
  });
  // `bucketOf` (src/report/order.js) reads `extended` and the ESCALATION, not a section
  // name: an escalated code-review case, and the standard checks a person always answers.
  const todo = (
    ruleId,
    { extended = true, section = "code-review", ...extra } = {}
  ) => ({
    ruleId,
    title: ruleId,
    extended,
    section,
    verdict: "error",
    // A case names no file here, but it still names the artifact it is about - every
    // one does, whether it came from a check, a sweep or the by-hand list, because
    // that is what gives whoever settles it a tree to look in.
    file: null,
    loc: null,
    artifact: "XPI",
    ...extra,
  });
  return {
    stateFile: `${base}.state.json`,
    state: {
      version: STATE_VERSION,
      review: `${base}.review.json`,
      report: {
        findings: findings ? [finding(1, "a"), finding(2, "b")] : [],
        // What the Review Details block is built from - the artifacts this review is of,
        // which is the whole reason a phase hands that block over.
        meta: {
          xpi: `${dir}/a.xpi`,
          xpiRoot: `${dir}/a.xpi.extracted/`,
          xpiFile: "a.xpi",
          // The report the reviewer sends. Named here because it is a row of that block
          // like any other, and the one the last prompt exists to leave them holding.
          reportFile: `${base}.report.md`,
        },
        mode: "xpi",
      },
      manual: [
        ...(code
          ? [
              todo("unknown-api", {
                instructions: "settle me",
                // What the ENTRY offers, which is what answersOf checks against. All
                // three here so the routing `ask` performs is testable; the narrowing
                // itself is pinned separately below.
                settleVerbs: ["reported", "cleared", "ask"],
              }),
            ]
          : []),
        ...(questions
          ? [
              todo("q1", { extended: false, instructions: "ask me" }),
              todo("q2", { extended: false, instructions: "ask me too" }),
            ]
          : []),
      ],
      preSweep: sweep
        ? {
            items: [
              {
                label: 1,
                check: "privacy-policy",
                title: "t1",
                instruction: "i1",
                artifact: ARTIFACT_XPI,
              },
              {
                label: 2,
                check: "data-exfiltration",
                title: "t2",
                instruction: "i2",
                artifact: ARTIFACT_XPI,
              },
            ],
          }
        : null,
      // One condition per tree with a sweep to run, named the way the step naming it is.
      run: { skip: [], sca: false, ...(sweep ? { "sweep-xpi": true } : {}) },
      paths: {
        description: `${base}.summary.md`,
        build: null,
        report: `${base}.report.md`,
        // The roots an entry's paths are resolved against (handback.js entriesFor). A v6
        // state carries both; without xpiRoot the loop would hand out relative paths.
        xpiRoot: "/tmp/pkg.xpi.extracted/",
        scaRoot: null,
        // Each tree's sweep pair, which is also what says WHICH trees were asked. The
        // request is never read back; the answers file is the one this loop opens.
        ...(sweep
          ? {
              sweeps: {
                [ARTIFACT_XPI]: {
                  request: `${base}.sweep-xpi.yaml`,
                  answers: `${base}.sweep-xpi.answers.json`,
                },
              },
            }
          : {}),
      },
      answers: {},
      route: {},
      sweep: null,
    },
  };
}

// The report is the one review document the LINTER writes. It is refreshed when the `ask`
// phase goes out - that phase hands the reviewer the Review Details block, which links the
// file, and they read it to answer the very questions it puts - and written again from the
// settled review once those answers are in. Asking the agent to reproduce the report in the
// chat is what this replaced, so the two writes are what the reviewer actually gets.
test("the report file is written for the questions and rewritten once they are answered", () => {
  const dir = tmp();
  const { state, stateFile } = review(dir);
  const file = state.paths.report;

  // Nothing yet: the path is named, but no phase has handed it to anyone.
  assert.equal(fs.existsSync(file), false);

  const seen = [];
  for (let pass = 0; pass < 10; pass++) {
    const out = issue(state, stateFile, PHASES, REGISTRY);
    if (out.phase.answer === "end") {
      break;
    }
    seen.push(out.phase.name);
    // Written exactly when `details` hands the reviewer its link, and not before it.
    assert.equal(
      fs.existsSync(file),
      seen.includes("details"),
      `after issuing ${out.phase.name}`
    );
    if (out.phase.name === "spawn") {
      swept(state, ARTIFACT_XPI);
    }
    const handed = handBack(state, (e) => {
      if (out.phase.name === "verify")
        return e.index === 1 ? "withdrawn" : "reported";
      if (out.phase.name === "settle") return "ask";
      return "Clear";
    });
    accept(state, handed, PHASES, REGISTRY);
  }
  assert.ok(seen.includes("ask"), "the fixture reaches the ask phase");

  // What the reviewer opened while answering, and what the same file says afterwards. The
  // settled copy is the authority: it is written from the review the answers produced.
  const asked = fs.readFileSync(file, "utf8");
  const settled = settle(state, REGISTRY);
  writeReportFile(file, settled.report);
  // The file starts and ends on its text: the empty lines that set the body apart from a
  // section heading in the terminal have nothing to set it apart from here.
  const written = fs.readFileSync(file, "utf8");
  assert.equal(written, `${settled.report.replace(/^\n+|\n+$/g, "")}\n`);
  assert.ok(!written.startsWith("\n"), "no leading empty line");
  assert.notEqual(asked, "", "the copy handed to the reviewer is not empty");
});

/** Fill every slot the way an obedient agent would, and hand it back. */
function handBack(state, answerFor) {
  const file = state.review;
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  doc.entries = doc.entries.map((e) => ({ ...e, answer: answerFor(e) }));
  fs.writeFileSync(file, JSON.stringify(doc, null, 1));
  return file;
}

/**
 * Play the sweeping sub-agent for one tree: fill in its answers file the way the request
 * tells it to. `found` is what it found, by label; every other label it was asked about
 * answers with the empty list.
 */
function swept(state, artifact, found = {}) {
  const paths = state.paths.sweeps[artifact];
  const labels = state.preSweep.items
    .filter((i) => i.artifact === artifact)
    .map((i) => i.label);
  fs.writeFileSync(
    paths.answers,
    JSON.stringify({
      answers: Object.fromEntries(labels.map((l) => [l, found[l] ?? []])),
    })
  );
  return paths.answers;
}

// The shape of a whole review: which phases are issued, in what order, and what each one
// asks about. Every route the loop has is exercised here - a sweep answered by check, a
// finding withdrawn, a case settled, a case that becomes a question, and a person's own
// words coming back.
test("a review runs spawn -> verify -> settle -> details -> ask and then settles", () => {
  const dir = tmp();
  const { state, stateFile } = review(dir);
  const seen = [];
  const answered = [];
  for (let pass = 0; pass < 10; pass++) {
    const out = issue(state, stateFile, PHASES, REGISTRY);
    if (out.phase.answer === "end") break;
    seen.push(out.phase.name);
    if (out.phase.name === "spawn") {
      swept(state, ARTIFACT_XPI);
    }
    const file = handBack(state, (e) => {
      if (out.phase.name === "verify")
        return e.index === 1 ? "withdrawn" : "reported";
      if (out.phase.name === "settle") return "ask"; // -> becomes a question
      return "Clear"; // the reviewer's own word
    });
    const { answers } = accept(state, file, PHASES, REGISTRY);
    answered.push([out.phase.name, [...answers.keys()].join(",")]);
  }
  assert.deepEqual(seen, ["spawn", "verify", "settle", "details", "ask"]);
  // The settle case became a question and was asked WITH its own index, beside the two
  // standard ones - three questions, not two.
  assert.equal(answered[4][1].split(",").length, 3);
  assert.deepEqual(state.answers, {
    1: "withdrawn",
    2: "reported",
    3: "Clear",
    4: "Clear",
    5: "Clear",
  });
  // Moved by the case itself, not by its number: the item carries where it is asked now.
  const moved = state.manual.filter((m) => m.askedIn === "ask");
  assert.deepEqual(
    moved.map((m) => m.ruleId),
    ["unknown-api"]
  );
  assert.deepEqual(state.sweep, [], "both sweeps ran and found nothing");
});

// An entry says what it may be answered with, and that is what an answer is checked
// against - not what the phase accepts. Two entries of one phase can offer different
// answers, so a set read off the phase would accept, for one case, a verdict the check
// that raised it withheld.
test("an entry is answered from its own answers, not its phase's verbs", () => {
  const dir = tmp();
  const { state, stateFile } = review(dir, { sweep: false, findings: false });
  // --llm-skip-summary with no sweep leaves spawn with nothing to start, so settle is
  // first once it has been issued.
  state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  // Spawn unpacks the package whatever else it does, and `details` hands over the block,
  // so both are issued in every review; marked done here so this test starts where it
  // means to.
  state.issued = ["spawn", "details"];
  // What the 14 screened checks declare: settle it, or clear it. No handing it on.
  state.manual[0].settleVerbs = ["reported", "cleared"];

  const out = issue(state, stateFile, PHASES, REGISTRY);
  assert.equal(out.phase.name, "settle");
  const entry = JSON.parse(fs.readFileSync(state.review, "utf8")).entries[0];
  assert.deepEqual(
    entry.answers.map((a) => a.label),
    ["reported", "cleared"],
    "the entry offers what its check allows"
  );
  // `ask` is one of the phase's own verbs, and still refused here.
  assert.ok(PHASES.find((p) => p.name === "settle").verbs.includes("ask"));
  assert.throws(
    () =>
      accept(
        state,
        handBack(state, () => "ask"),
        PHASES,
        REGISTRY
      ),
    /this entry does not accept \(expected one of: reported, cleared\)/
  );
  assert.deepEqual(state.answers, {}, "a refusal settles nothing");

  accept(
    state,
    handBack(state, () => "reported"),
    PHASES,
    REGISTRY
  );
  assert.deepEqual(state.answers, { 1: "reported" });
});

// What a verb MEANS is the phase's to word, but `reported` reads differently where the
// case could still have been handed on. An entry offering `cleared` and no `ask` has had
// its way out declined, which is a different sentence from the same verb chosen freely.
test("reporting reads as the last resort only where clearing was the way out", () => {
  const dir = tmp();
  const skipSetup = (r) => {
    r.state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
    r.state.issued = ["spawn", "details"];
    return r;
  };
  const offered = (verbs) => {
    const fresh = skipSetup(review(dir, { sweep: false, findings: false }));
    fresh.state.manual[0].settleVerbs = verbs;
    issue(fresh.state, fresh.stateFile, PHASES, REGISTRY);
    const e = JSON.parse(fs.readFileSync(fresh.state.review, "utf8"))
      .entries[0];
    return Object.fromEntries(e.answers.map((a) => [a.label, a.description]));
  };
  assert.match(
    offered(["reported", "cleared"]).reported,
    /could not be cleared/,
    "clearing was on offer and was not taken"
  );
  assert.match(
    offered(["reported", "cleared", "ask"]).reported,
    /should be reported/,
    "a case that could still have been handed on"
  );
  assert.match(
    offered(["reported", "ask"]).reported,
    /should be reported/,
    "keyed on `cleared`, not on the absence of `ask`"
  );
  // A finding narrows nothing, so it is worded by its own phase and never picks this up.
  const findings = skipSetup(
    review(dir, { code: false, questions: false, sweep: false })
  );
  issue(findings.state, findings.stateFile, PHASES, REGISTRY);
  const audit = JSON.parse(fs.readFileSync(findings.state.review, "utf8"))
    .entries[0];
  assert.deepEqual(
    audit.answers.map((a) => a.label),
    ["reported", "withdrawn"]
  );
  assert.match(audit.answers[0].description, /claim holds/);
});

// A phase is issued when it has WORK - steps, or items. Neither, and it is skipped, which
// is also what ends the loop: "no item is still open" would block forever on an item
// routed to a phase this run never issues.
//
// `spawn`'s every step is now optional (summary/build/sweep, each gated by its own
// marker) - the package itself is extracted by the linter before the review is ever
// printed (src/addon/load.js), so `spawn` carries no unconditional step any more. A run
// that opts out of all three ends up with zero surviving steps, and is skipped like any
// other phase with nothing to do.
test("spawn with nothing to start is skipped, not issued empty", () => {
  const dir = tmp();
  const { state, stateFile } = review(dir, { sweep: false });
  // --llm-skip-summary on an XPI review with no sweep starts no agent at all, so spawn
  // has nothing left to do.
  state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  const out = issue(state, stateFile, PHASES, REGISTRY);
  assert.equal(out.phase.name, "verify");
});

test("nothing to ask: the review settles after the last settle", () => {
  const dir = tmp();
  const { state, stateFile } = review(dir, { sweep: false });
  state.manual = state.manual.filter((m) => m.extended);
  // skip:manual drops only the questions. spawn is skipped too (nothing to start) - so
  // what this pins is that `ask` is not issued either, once it has nothing to put to
  // anyone - and neither is the details block, which exists to answer questions with.
  state.run = {
    skip: ["llm-skip-manual", "llm-skip-summary"],
    sca: false,
    sweep: false,
  };
  const seen = [];
  for (let pass = 0; pass < 10; pass++) {
    const out = issue(state, stateFile, PHASES, REGISTRY);
    if (out.phase.answer === "end") break;
    seen.push(out.phase.name);
    accept(
      state,
      handBack(state, () =>
        out.phase.name === "spawn"
          ? []
          : out.phase.name === "verify"
            ? "reported"
            : "cleared"
      ),
      PHASES,
      REGISTRY
    );
  }
  assert.deepEqual(seen, ["verify", "settle"]);
  assert.equal(
    issue(state, stateFile, PHASES, REGISTRY).phase.name,
    "close",
    "settled"
  );
});

// Four ways a hand-back can be wrong. Each names the one thing to fix, and NONE of them
// touches the state: a corrected hand-back resumes exactly where it was, which is why the
// caller does not re-print the prompt.
test("a wrong hand-back is refused, and changes nothing", () => {
  const dir = tmp();
  const { state, stateFile } = review(dir, { sweep: false });
  // --llm-skip-summary as well, so spawn starts nothing and verify is the phase in
  // flight: a refusal needs a pass that actually asked for something.
  state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  // Spawn unpacks the package whatever else it does, and `details` hands over the block,
  // so both are issued in every review; marked done here so this test starts where it
  // means to.
  state.issued = ["spawn", "details"];
  assert.equal(issue(state, stateFile, PHASES, REGISTRY).phase.name, "verify");
  const before = JSON.stringify(state);
  // Each case starts from the file as it was HANDED OUT: mangling the last mangle would
  // test a file no pass ever produced.
  const handed = fs.readFileSync(state.review, "utf8");
  const mangle = (fn) => {
    const doc = JSON.parse(handed);
    fn(doc);
    fs.writeFileSync(state.review, JSON.stringify(doc, null, 1));
    return state.review;
  };

  const unfilled = mangle((d) =>
    d.entries.forEach((e, i) => (e.answer = i ? "reported" : null))
  );
  assert.throws(
    () => accept(state, unfilled, PHASES, REGISTRY),
    /still has no "answer"/
  );

  const extra = mangle((d) => {
    d.entries.forEach((e) => (e.answer = "reported"));
    d.entries.push({ index: 99, answer: "reported" });
  });
  assert.throws(
    () => accept(state, extra, PHASES, REGISTRY),
    /99 is not one of the entries/
  );

  const dropped = mangle((d) => {
    d.entries.forEach((e) => (e.answer = "reported"));
    d.entries.pop();
  });
  assert.throws(
    () => accept(state, dropped, PHASES, REGISTRY),
    /missing from the file/
  );

  const wrongVerb = mangle((d) =>
    d.entries.forEach((e) => (e.answer = "cleared"))
  );
  assert.throws(
    () => accept(state, wrongVerb, PHASES, REGISTRY),
    /this entry does not accept \(expected one of: reported, withdrawn\)/
  );

  // `base` is the linter's own value, so nothing checks it against anything else - only
  // that it is still there. `accept` never reads it (it wants `entries` alone), but
  // `readHandback` refuses before it gets that far, on the same file any other caller
  // would open.
  const noBase = mangle((d) => {
    d.entries.forEach((e) => (e.answer = "reported"));
    delete d.base;
  });
  assert.throws(
    () => accept(state, noBase, PHASES, REGISTRY),
    /names no "base"/
  );

  assert.equal(
    JSON.stringify(state),
    before,
    "a refusal leaves the review untouched"
  );
});

// The sweep asks nothing of the file every other phase uses: its work is starting the
// agents, and each of those answers in a file of its own. So what goes out is empty, and
// what makes the review whole is the answers files - where an empty list is a real answer
// and a null is not, which is the distinction a sweep quietly skipped would otherwise hide.
test("the sweep phase asks for nothing in the review file, and answers in its own", () => {
  const dir = tmp();
  const { state, stateFile } = review(dir);
  const out = issue(state, stateFile, PHASES, REGISTRY);
  assert.equal(out.phase.name, "spawn");
  assert.deepEqual(out.entries, [], "nothing to fill in here");
  // It does hand over the steps that start the agents - a phase with no entries is
  // still issued when it has work.
  assert.ok(out.steps.length > 0);

  // Nothing written yet: the pass cannot be accepted, and the refusal names the file the
  // agent has to go and produce rather than anything in the hand-back.
  const empty = handBack(state, () => null);
  assert.throws(
    () => accept(state, empty, PHASES, REGISTRY),
    /sweep-xpi\.answers\.json could not be read/
  );

  // A null left behind is not an answer, and is refused by the label it belongs to.
  const before = JSON.stringify(state);
  fs.writeFileSync(
    state.paths.sweeps[ARTIFACT_XPI].answers,
    JSON.stringify({ answers: { 1: [], 2: null } })
  );
  assert.throws(
    () => accept(state, empty, PHASES, REGISTRY),
    /leaves label 2 unanswered/
  );
  assert.equal(JSON.stringify(state), before, "a refusal changes nothing");

  swept(state, ARTIFACT_XPI);
  accept(state, empty, PHASES, REGISTRY);
  assert.deepEqual(state.sweep, [], "both ran, neither found anything");
});

// ONE check, TWO trees. A sweep is a request about exactly one artifact, and a check on
// `input: all` reads both - so it authors an instruction per tree and gets an independent
// sweep for each, in a different file, under a different label. The same relative path
// exists in both trees, so this is the pair that would fold into one case if the artifact
// were not carried with it.
//
// Driven the whole way round, because which tree a hint is in has to survive being
// written out and read back: nothing here re-derives it - the pre-sweep list said so when
// the artifacts still existed, and the label carries it back.
test("one check sweeping both trees answers per tree, and each is filed there", () => {
  const dir = tmp();
  const { state, stateFile } = review(dir, {
    findings: false,
    questions: false,
  });
  // Both trees exist for this one, so the review is a source-code review.
  state.paths.scaRoot = path.join(dir, "src");
  state.paths.sweeps[ARTIFACT_SCA] = {
    request: path.join(dir, "r.sweep-sca.yaml"),
    answers: path.join(dir, "r.sweep-sca.answers.json"),
  };
  state.run["sweep-sca"] = true;
  state.preSweep = {
    items: [ARTIFACT_XPI, ARTIFACT_SCA].map((artifact, i) => ({
      label: i + 1,
      check: "data-exfiltration",
      title: "Data exfiltration",
      severity: "error",
      instruction: `look in the ${artifact}`,
      response: null,
      artifact,
    })),
  };

  const out = issue(state, stateFile, PHASES, REGISTRY);
  assert.equal(out.phase.name, "spawn");
  // Two steps, one per tree, each starting an agent of its own.
  assert.equal(out.steps.filter((x) => /sweep/i.test(x.text)).length, 2);

  // Answered independently, at the SAME relative path in each tree.
  const hit = (tree) => [
    { file: "lib/net.js", line: 7, hint: `sends from the ${tree}` },
  ];
  swept(state, ARTIFACT_XPI, { 1: hit(ARTIFACT_XPI) });
  swept(state, ARTIFACT_SCA, { 2: hit(ARTIFACT_SCA) });
  accept(
    state,
    handBack(state, () => null),
    PHASES,
    REGISTRY
  );

  assert.deepEqual(
    state.sweep.map((r) => [r.check, r.artifact, r.file]),
    [
      ["data-exfiltration", ARTIFACT_XPI, "lib/net.js"],
      ["data-exfiltration", ARTIFACT_SCA, "lib/net.js"],
    ]
  );
  // data-exfiltration escalates, so both hints arrive as cases of it - one per tree, each
  // stamped with the tree the review asked about, and neither collapsed into the other.
  const cases = state.manual.filter((m) => m.ruleId === "data-exfiltration");
  assert.deepEqual(
    cases.map((m) => [m.artifact, m.file, m.hint]),
    [
      [ARTIFACT_XPI, "lib/net.js", "sends from the XPI"],
      [ARTIFACT_SCA, "lib/net.js", "sends from the SCA"],
    ]
  );
});

test("a refusal is its own class, so the caller can answer it differently", () => {
  const dir = tmp();
  const { state, stateFile } = review(dir, { sweep: false });
  issue(state, stateFile, PHASES, REGISTRY);
  try {
    accept(state, path.join(dir, "not-a-review-file.json"), PHASES);
    assert.fail("expected a refusal");
  } catch (e) {
    assert.ok(e instanceof HandbackRefused);
    assert.match(e.problem, /could not be read/);
  }
});

// --llm-skip-manual means those items are not put to ANYONE: they stay in the report for
// the reviewer to work through later. Withholding only the step that asks them would hand
// the agent the questions with no instruction about them - and a handover demanding an
// answer for each, which is the opposite of leaving them alone.
//
// With nothing left to ask, the phase is not issued at all: it exists to put questions to
// someone, and the Review Details block it would have handed over travels with the report
// instead.
test("--llm-skip-manual withholds the entries, so the ask phase is not issued", () => {
  const dir = tmp();
  const { state, stateFile } = review(dir, { sweep: false });
  state.run = { skip: ["llm-skip-manual"], sca: false, sweep: false };
  const seen = [];
  for (let pass = 0; pass < 8; pass++) {
    const out = issue(state, stateFile, PHASES, REGISTRY);
    if (out.phase.answer === "end") break;
    seen.push(out.phase.name);
    accept(
      state,
      handBack(state, () =>
        out.phase.name === "verify" ? "reported" : "cleared"
      ),
      PHASES,
      REGISTRY
    );
  }
  assert.ok(!seen.includes("ask"), `ask was issued: ${seen.join(", ")}`);
  // The two findings and the code-review case were settled; NEITHER question was. They
  // stay open, which is what puts them in the report rather than in a verdict.
  assert.deepEqual(Object.keys(state.answers).sort(), ["1", "2", "3"]);
});

// The same phase, reached the other way: nothing produced an ask verdict and there are no
// standard questions, so there is nothing to ask and the review goes straight to the
// report. Driven by the REVIEW having no questions, not by a flag emptying it.
test("no questions at all: the ask phase is not issued either", () => {
  const dir = tmp();
  const { state, stateFile } = review(dir, { sweep: false });
  state.manual = state.manual.filter((m) => m.extended);
  state.run = { skip: [], sca: false, sweep: false };
  const seen = [];
  for (let pass = 0; pass < 8; pass++) {
    const out = issue(state, stateFile, PHASES, REGISTRY);
    if (out.phase.answer === "end") break;
    seen.push(out.phase.name);
    accept(
      state,
      handBack(state, () =>
        out.phase.name === "verify" ? "reported" : "cleared"
      ),
      PHASES,
      REGISTRY
    );
  }
  assert.ok(!seen.includes("ask"), `ask was issued: ${seen.join(", ")}`);
});

// --llm-skip-sweep leaves the instructions standing and withholds the ASKING, so the
// review never mentions a sweep: no agent is spawned for one, no rows are handed over, and
// the Standard Code Review section stays in the report for the reviewer to sweep by hand.
//
// Driven rather than asserted on a flag, because the two are different facts: the state
// still carries `preSweep`, and deriving "does this run sweep" from that would re-enable
// exactly what the flag withheld.
test("--llm-skip-sweep asks for no sweep, though the instructions still exist", () => {
  const dir = tmp();
  const { state, stateFile } = review(dir);
  assert.ok(state.preSweep, "the instructions are still there");
  // What the flag does in the pipeline: no request is written, so no condition names one
  // and there is no answers file for the pass to read.
  state.run = { skip: [], sca: false };
  delete state.paths.sweeps;
  const first = issue(state, stateFile, PHASES, REGISTRY);
  assert.deepEqual(first.entries, [], "no rows to fill in");
  const prose = first.steps.map((s) => s.text).join("\n");
  assert.doesNotMatch(prose, /sweep/i, "and no step mentions one");
  assert.equal(state.sweep, null, "nothing was swept");

  // And the empty file IS the right hand-back. Both legs read the same fact, so the pass
  // that asked for nothing accepts nothing.
  const { answers } = accept(
    state,
    handBack(state, () => null),
    PHASES,
    REGISTRY
  );
  assert.equal(answers.size, 0);
  // Null, not an empty list: no tree was asked, which is not every tree answering with
  // nothing - the same distinction the answers files themselves are built around.
  assert.equal(state.sweep, null, "and still nothing was swept");
  assert.ok(issue(state, stateFile, PHASES, REGISTRY), "the review goes on");
});

/**
 * Run a whole review with a canned answer per phase, THROUGH to the settled report.
 *
 * Driven to the end rather than to the last hand-back, because applying the answers is its
 * own step: a phase can hand out and take back cleanly and still refuse what it took when
 * the report is built from it.
 * @returns {{seen: string[], details: string}}  The phases issued, and the Review Details
 *   block the settled review hands over.
 */
function phasesOf(state, stateFile) {
  const seen = [];
  for (let pass = 0; pass < 10; pass++) {
    const out = issue(state, stateFile, PHASES, REGISTRY);
    if (out.phase.answer === "end") break;
    seen.push(out.phase.name);
    // Whatever trees this run asked about, answered clean - the sweeping agents' part of
    // the pass, without which it cannot be accepted.
    for (const artifact of Object.keys(state.paths.sweeps ?? {})) {
      swept(state, artifact);
    }
    accept(
      state,
      handBack(state, (e) =>
        out.phase.name === "verify"
          ? "reported"
          : out.phase.name === "settle"
            ? "cleared"
            : "Clear"
      ),
      PHASES,
      REGISTRY
    );
  }
  const { details } = settle(state, REGISTRY);
  return { seen, details };
}

// EVERY phase, not only `ask`: a phase exists to settle entries, so a review with none for
// it must not spend a pass on it. Reached by the REVIEW having nothing for that phase -
// never by a flag emptying it - because those are two different things and only one of
// them is being tested here.
test("a phase with no entries is not issued, whichever phase it is", () => {
  const cases = [
    // what the review holds                        which phases run
    // `details` hands over the block in every review that is not told to skip it.
    [{ findings: false, code: false, questions: false }, ["spawn", "details"]],
    [
      { findings: true, code: false, questions: false },
      ["spawn", "verify", "details"],
    ],
    [
      { findings: false, code: true, questions: false },
      ["spawn", "settle", "details"],
    ],
    [
      { findings: false, code: false, questions: true },
      ["spawn", "details", "ask"],
    ],
    [
      { findings: true, code: true, questions: true },
      ["spawn", "verify", "settle", "details", "ask"],
    ],
  ];
  for (const [holds, expected] of cases) {
    const dir = tmp();
    const { state, stateFile } = review(dir, { ...holds, sweep: true });
    assert.deepEqual(
      phasesOf(state, stateFile).seen,
      expected,
      JSON.stringify(holds)
    );
  }
});

// Every combination of the three skips, over a review that holds something for every
// phase - so what drops out is the FLAG's doing and nothing else.
//
//   llm-skip-summary -> the description agent, and the link that hands it over
//   llm-skip-manual  -> the details block and the questions: the entries as well as the
//                       step that asks them
//   llm-skip-sweep   -> the sweep agent, the wait, and the rows it would have filled
test("every combination of the skips issues exactly the phases it should", () => {
  const SKIPS = ["llm-skip-summary", "llm-skip-manual", "llm-skip-sweep"];
  for (let bits = 0; bits < 8; bits++) {
    const skip = SKIPS.filter((_, i) => bits & (1 << i));
    const sweeps = !skip.includes("llm-skip-sweep");
    const dir = tmp();
    const { state, stateFile } = review(dir, { sweep: sweeps });
    state.run = {
      skip: skip.filter((x) => x !== "llm-skip-sweep"),
      sca: false,
      ...(sweeps ? { "sweep-xpi": true } : {}),
    };
    // --llm-skip-sweep writes no request, so there is no file for a step to name and
    // none for the pass to read back.
    if (!sweeps) {
      delete state.paths.sweeps;
    }
    // A file is NAMED only where the step that writes it prints, as the pipeline names it:
    // --llm-skip-summary spawns no description agent, so there is no description to link.
    if (skip.includes("llm-skip-summary")) {
      state.paths.description = null;
    }
    // `spawn` runs only where it starts an agent: the package itself is no longer
    // unpacked by a step here (the linter extracts it before the review is printed), so
    // a run that skips the summary agent and does not sweep has nothing left to spawn.
    const expected = [
      ...(!skip.includes("llm-skip-summary") || sweeps ? ["spawn"] : []),
      "verify",
      "settle",
      // An XPI review asks nothing else, so --llm-skip-manual leaves no question for the
      // details block to serve and no entry for `ask`.
      ...(skip.includes("llm-skip-manual") ? [] : ["details", "ask"]),
    ];
    const { seen, details } = phasesOf(state, stateFile);
    const where = `skips: ${skip.join(",") || "none"}`;
    assert.deepEqual(seen, expected, where);

    // The block ends EVERY settled review, whether or not `details` showed the same
    // one earlier. That copy was for answering the questions with, and by the time they are
    // answered it is far above the reviewer - while the report they are about to send, and
    // the package it is about, are rows in this one.
    //
    // Written for a chat: a list of links, then what the verdicts mean anything against.
    // The heading above it is named by the text that carries it, so it is not in here.
    assert.match(details, /^\* XPI_FILE: /m, `${where}: every path it named`);
    assert.match(
      details,
      /^\* XPI_ROOT: \[/m,
      `${where}: and where to read it`
    );
    assert.match(
      details,
      /^\* REVIEW_REPORT: \[/m,
      `${where}: the report among them`
    );
    assert.match(details, /^schema /m, `${where}: and says what against`);
  }
});

// An `ask` verdict does not settle a case, it MOVES it: the agent could not settle it from
// the package, so a person is asked instead. It arrives in that phase as a question like
// any other - with the finished wording, the answers it offers, and a progress label that
// counts it - because "is this being asked" is a property of the PHASE it is in, never of
// the section it was settled under.
//
// Without that, the step tells the agent to ask the entry's "message" and offer its
// "answers", and the entry has neither.
test("a case sent on with `ask` arrives as a question, worded and answerable", () => {
  const dir = tmp();
  const { state, stateFile } = review(dir, { sweep: false, findings: false });
  // Nothing for spawn to start either, so `settle` is the phase in flight.
  state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  // spawn has nothing to start in this config and is never issued, and `details` comes
  // after `settle` - both marked done here anyway, so this test starts where it means to.
  state.issued = ["spawn", "details"];
  assert.equal(issue(state, stateFile, PHASES, REGISTRY).phase.name, "settle");
  accept(
    state,
    handBack(state, () => "ask"),
    PHASES,
    REGISTRY
  );

  const out = issue(state, stateFile, PHASES, REGISTRY);
  assert.equal(out.phase.name, "ask");
  // The code-review case and the two standard questions, all askable.
  assert.equal(out.entries.length, 3);
  for (const e of out.entries) {
    assert.ok(e.message, `entry ${e.index} has no question to put`);
    assert.ok(e.answers?.length, `entry ${e.index} offers no answers`);
  }
  // The label counts what is actually asked, so the moved case is in the total.
  assert.deepEqual(
    out.entries.map((e) => e.label),
    ["1/3", "2/3", "3/3"]
  );
});

// The whole round trip for a case the agent could not settle: it is asked of a person, and
// THEIR answer settles it. Driven through `settle`, not only `accept`, because accept takes
// the answer on the phase's word - the phase that asked declares no verbs, so any words are
// legal there - and it is applying it that has to know a person answered. A test stopping
// at accept passes while the review still refuses the reviewer at the end of the run.
test("a case sent on with `ask` is settled by the reviewer's own answer", () => {
  const dir = tmp();
  const { state, stateFile } = review(dir, { sweep: false, findings: false });
  state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  // Spawn unpacks the package whatever else it does, and `details` hands over the block,
  // so both are issued in every review; marked done here so this test starts where it
  // means to.
  state.issued = ["spawn", "details"];

  const sent = issue(state, stateFile, PHASES, REGISTRY);
  assert.equal(sent.phase.name, "settle");
  // The case the agent gives up on, by the index it will keep.
  const moved = sent.entries[0].index;
  accept(
    state,
    handBack(state, () => "ask"),
    PHASES,
    REGISTRY
  );

  const out = issue(state, stateFile, PHASES, REGISTRY);
  assert.equal(out.phase.name, "ask");
  assert.ok(
    out.entries.some((e) => e.index === moved),
    "the moved case is asked under the index the agent saw"
  );
  const [clear, report] = REGISTRY.manualReviewChoices().map((c) => c.label);
  accept(
    state,
    handBack(state, (e) => (e.index === moved ? report : clear)),
    PHASES,
    REGISTRY
  );

  // The reviewer's label reaches applyVerdicts as a reviewer's answer. Reading the section
  // it was filed under instead would demand a verb here and refuse them.
  const { applied, review: settled } = settle(state, REGISTRY);
  assert.ok(
    applied.some((line) => line.startsWith(`${moved} reported`)),
    `the reviewer's "${report}" settled it: ${applied.join(", ")}`
  );
  assert.ok(
    settled.findings.some((f) => f.ruleId === "unknown-api"),
    "a reported case becomes a finding of its own check"
  );
  // And the two the reviewer cleared leave nothing behind.
  assert.deepEqual(settled.meta.manualReview, []);
});

// A reviewer writes a sentence, and a sentence that happens to spell a verb is still a
// sentence. `ask` is the one verb that MOVES an item rather than settling it, so reading a
// person's "ask" as that verb routes their answer to the phase they are already in: the
// item never settles, and that phase is issued again, and again, with nothing refused.
//
// It cannot happen, because what a verdict phase hands back is crossed into a Verb once
// (src/report/verbs.js) and compared by identity after - and a phase answering with
// `words` never makes that crossing, so its answers are text and text is never a verb.
test("a reviewer who writes `ask` has answered, not asked for a move", () => {
  const dir = tmp();
  const { state, stateFile } = review(dir, {
    sweep: false,
    findings: false,
    code: false,
  });
  state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  // Spawn unpacks the package whatever else it does, and `details` hands over the block,
  // so both are issued in every review; marked done here so this test starts where it
  // means to.
  state.issued = ["spawn", "details"];
  // Real check ids, because a reported case becomes a finding of its own check and takes
  // the severity that check declares.
  state.manual.forEach((m, i) => {
    m.ruleId = ["testing-information", "no-surprises-policy"][i];
  });

  const out = issue(state, stateFile, PHASES, REGISTRY);
  assert.equal(out.phase.name, "ask");
  accept(
    state,
    handBack(state, () => "ask"),
    PHASES,
    REGISTRY
  );

  assert.deepEqual(state.route, {}, "nobody was moved");
  assert.deepEqual(state.answers, { 1: "ask", 2: "ask" }, "both were answered");
  assert.equal(
    issue(state, stateFile, PHASES, REGISTRY).phase.name,
    "close",
    "and it is over"
  );

  // Their word reports the case and travels with it, like any other answer they type.
  const { applied } = settle(state, REGISTRY);
  assert.ok(
    applied.every((line) => line.includes("reported + note")),
    applied.join(", ")
  );
});

// ---- the early exit ----

/**
 * Drive the whole loop, answering each phase, and report which phases were issued
 * alongside the settled review.
 *
 * `settle` is called ONCE, here: it applies every recorded verdict to the findings and the
 * manual list in place, so a second call would apply them all again.
 * @param {object} state @param {string} stateFile
 * @param {(phase: string) => string} answer
 * @returns {{seen: string[], settled: object}}
 */
function driveLoop(state, stateFile, answer, reg = REGISTRY) {
  const seen = [];
  // `ask` takes a REVIEWER's answer, not a verb: the phase that asks declares none, and
  // handing it one would be refused where it is applied rather than where it is taken.
  const [clear] = REGISTRY.manualReviewChoices().map((c) => c.label);
  let closing = null;
  for (let pass = 0; pass < 8; pass++) {
    const out = issue(state, stateFile, PHASES, reg);
    if (out.phase.answer === "end") {
      closing = out;
      break;
    }
    seen.push(out.phase.name);
    accept(
      state,
      handBack(state, () =>
        out.phase.name === "ask" ? clear : answer(out.phase.name)
      ),
      PHASES,
      reg
    );
  }
  return { seen, closing, settled: settle(state, reg) };
}

/** The review above, with its findings reported by a check that aborts the review. */
function blockingReview(dir) {
  const made = review(dir, { sweep: false });
  for (const f of made.state.report.findings) {
    f.ruleId = "vendor-vulnerable";
  }
  made.state.run = { skip: [], sca: true, sweep: false };
  return made;
}

// The case this exists for: the very next thing the loop would do is ask a reviewer to
// reproduce a build the review has already rejected. It must not get that far - and the
// phases BEFORE it still run, because what they settle is what the report is made of.
test("a blocking finding aborts the loop before the question block", () => {
  const dir = tmp();
  const { state, stateFile } = blockingReview(dir);
  const { seen, settled } = driveLoop(state, stateFile, (phase) =>
    phase === "verify" ? "reported" : "cleared"
  );
  assert.ok(!seen.includes("ask"), `ask was issued: ${seen.join(", ")}`);
  assert.ok(seen.includes("verify"), "the findings were still audited");
  assert.ok(seen.includes("settle"), "the cases were still settled");
  assert.equal(settled.earlyExit, true);
});

// The mirror image, and the reason the halt is derived every pass rather than recorded
// once: the agent audits those findings, and an agent that withdraws them has removed the
// thing that aborted the review. The question block comes back.
test("withdrawing the blocking findings puts the question block back", () => {
  const dir = tmp();
  const { state, stateFile } = blockingReview(dir);
  const { seen, settled } = driveLoop(state, stateFile, (phase) =>
    phase === "verify" ? "withdrawn" : "cleared"
  );
  assert.ok(seen.includes("ask"), `ask was not issued: ${seen.join(", ")}`);
  assert.equal(settled.earlyExit, false);
});

// The Review Details block goes out once, in a phase of its own, before the questions - and
// only where a question follows: not in an aborted review, and not in an XPI review under
// --llm-skip-manual. A source review keeps it under that flag, for its build questions.
test("the details block is handed over by its own phase, before the questions", () => {
  const blocks = (made) => {
    const shown = [];
    for (let pass = 0; pass < 10; pass++) {
      const out = issue(made.state, made.stateFile, PHASES, REGISTRY);
      if (out.phase.answer === "end") {
        break;
      }
      if (out.steps.some((step) => step.text.includes("{{details}}"))) {
        shown.push(out.phase.name);
      }
      accept(
        made.state,
        handBack(made.state, () => {
          if (out.phase.name === "verify") return "withdrawn";
          return out.phase.name === "settle" ? "cleared" : "Clear";
        }),
        PHASES,
        REGISTRY
      );
    }
    return shown;
  };
  assert.deepEqual(blocks(review(tmp(), { sweep: false })), ["details"]);

  const skipped = review(tmp(), { sweep: false });
  skipped.state.run.skip = ["llm-skip-manual"];
  assert.deepEqual(blocks(skipped), []);

  const source = buildQuestionsReview(tmp());
  source.state.run.skip = ["llm-skip-manual"];
  assert.deepEqual(blocks(source), ["details"]);

  const aborted = blockingReview(tmp());
  const shown = [];
  for (let pass = 0; pass < 10; pass++) {
    const out = issue(aborted.state, aborted.stateFile, PHASES, REGISTRY);
    if (out.phase.answer === "end") {
      break;
    }
    shown.push(out.phase.name);
    accept(
      aborted.state,
      handBack(aborted.state, () =>
        out.phase.name === "verify" ? "reported" : "cleared"
      ),
      PHASES,
      REGISTRY
    );
  }
  assert.ok(!shown.includes("details"), shown.join(", "));
});

// The review ends with the closing phase, which carries the settled review and opens on
// what happened to it: settled, or aborted. Nothing is handed back after it.
test("the closing phase opens on how the review ended, and takes nothing back", () => {
  const ran = blockingReview(tmp());
  const { closing: settledClose } = driveLoop(
    ran.state,
    ran.stateFile,
    (phase) => (phase === "verify" ? "withdrawn" : "cleared")
  );
  assert.match(settledClose.steps[0].text, /^The review is settled\./);
  assert.equal(settledClose.settled.earlyExit, false);
  assert.throws(
    () => accept(ran.state, ran.state.review, PHASES, REGISTRY),
    /nothing is handed back after its closing prompt/
  );

  const aborted = blockingReview(tmp());
  const { closing: abortedClose } = driveLoop(
    aborted.state,
    aborted.stateFile,
    (phase) => (phase === "verify" ? "reported" : "cleared")
  );
  assert.match(abortedClose.steps[0].text, /^The review was aborted/);
  assert.equal(abortedClose.settled.earlyExit, true);
  // The same body either way: the abort rides in the details block.
  assert.equal(abortedClose.steps[1].text, settledClose.steps[1].text);
  assert.match(
    abortedClose.settled.details,
    /- Known security vulnerabilities$/
  );
});

// A review with nothing to do at all still closes: its first pass is the closing one.
test("a review with no other work is closed on its first pass", () => {
  const { state, stateFile } = review(tmp(), {
    sweep: false,
    findings: false,
    code: false,
    questions: false,
  });
  state.run = { skip: ["llm-skip-summary", "llm-skip-manual"], sca: false };
  const out = issue(state, stateFile, PHASES, REGISTRY);
  assert.equal(out.phase.name, "close");
  assert.ok(out.settled, "it carries the settled review");
});

// Whether the review was aborted is a fact about the review, so the hand-over carries it
// too - not just the developer's text. It rides in the details block, because only the
// block can list the reasons that aborted THIS review.
test("an aborted review closes its details block with the reason", () => {
  const dir = tmp();
  const { state, stateFile } = blockingReview(dir);
  const { settled } = driveLoop(state, stateFile, (phase) =>
    phase === "verify" ? "reported" : "cleared"
  );
  const lines = settled.details.split("\n");
  assert.match(
    settled.details,
    /^\* XPI_FILE: /m,
    "the block is still the block"
  );
  assert.equal(
    lines.at(-2),
    "The review was not completed and the report is incomplete due to the following issues:"
  );
  assert.equal(lines.at(-1), "- Known security vulnerabilities");

  // ... and a review that ran to the end closes with the block itself. Nothing says a
  // review was aborted unless one was.
  const clean = blockingReview(tmp());
  const ran = driveLoop(clean.state, clean.stateFile, (phase) =>
    phase === "verify" ? "withdrawn" : "cleared"
  );
  assert.doesNotMatch(ran.settled.details, /review was not completed/);
  assert.match(
    ran.settled.details,
    /^schema /m,
    "and ends where it always did"
  );
});

// What an aborted review hands the reviewer: the closing line in the developer's text, no
// questions left listed under it, and a tally that does not advertise work nobody was
// asked to do. The code-review items it settled are still there.
test("an aborted review hands over the reason and drops the questions", () => {
  const dir = tmp();
  const { state, stateFile } = blockingReview(dir);
  const {
    settled: { report, tally, review: settled },
  } = driveLoop(state, stateFile, (phase) =>
    phase === "verify" ? "reported" : "cleared"
  );
  assert.match(report, /The review was not completed/);
  assert.match(report, /- Known security vulnerabilities/);
  assert.match(tally, /0 extended manual review item\(s\)/);
  assert.match(tally, /0 standard manual review item\(s\)/);
  assert.equal(
    settled.meta.manualReview.some((m) => !m.extended),
    false,
    "the standard questions are gone"
  );
});

// The case the item's SECTION cannot answer. A code-review case the agent could not
// settle is sent on to a reviewer keeping that section, so the halt has to ask where the
// item is answered NOW - otherwise it stays listed as reviewer work under a closing line
// saying nobody was asked.
test("a case the agent routed to a reviewer is dropped by the halt too", () => {
  const dir = tmp();
  const { state, stateFile } = blockingReview(dir);
  const [clear] = REGISTRY.manualReviewChoices().map((c) => c.label);
  const seen = [];
  for (let pass = 0; pass < 8; pass++) {
    const out = issue(state, stateFile, PHASES, REGISTRY);
    if (out.phase.answer === "end") {
      break;
    }
    seen.push(out.phase.name);
    accept(
      state,
      handBack(state, () => {
        if (out.phase.name === "verify") {
          return "reported";
        }
        // The agent gives up on the code-review case and sends it to a reviewer.
        return out.phase.name === "settle" ? "ask" : clear;
      }),
      PHASES,
      REGISTRY
    );
  }
  assert.ok(!seen.includes("ask"), `ask was issued: ${seen.join(", ")}`);
  const { tally, review: settled } = settle(state, REGISTRY);
  assert.deepEqual(
    settled.meta.manualReview,
    [],
    "the routed case is not left listed as reviewer work"
  );
  assert.match(tally, /0 extended code review item\(s\)/);
});

/** The small review as a source code review: the build phase's two paths named, as the
 *  pipeline names them for one. */
function buildReview(dir) {
  const made = review(dir, { sweep: false });
  made.state.run = { skip: [], sca: true };
  made.state.paths.buildCopy = path.join(dir, "r.build");
  made.state.paths.buildDiff = path.join(dir, "r.build-diff.md");
  return made;
}

/**
 * The source review above, carrying the three build items every source review raises, as
 * the pipeline renders them: undeclared-build-source for the agent to settle, and the two
 * build questions, each naming the phase it is asked in (`asked-in`).
 */
function buildQuestionsReview(dir) {
  const made = buildReview(dir);
  const todo = (ruleId, extra) => ({
    ruleId,
    title: ruleId,
    extended: true,
    verdict: "error",
    instructions: `${ruleId}?`,
    file: null,
    loc: null,
    artifact: "SCA",
    askedIn: REGISTRY.askedIn(ruleId),
    ...extra,
  });
  made.state.paths.scaRoot = path.join(dir, "src");
  made.state.manual.push(
    todo("undeclared-build-source", {
      section: "code-review",
      llmInstructions: "read the build",
      settleVerbs: ["reported", "cleared"],
    }),
    todo("build-succeeds", { section: "manual-review" }),
    todo("build-reproduces-xpi", { section: "manual-review" })
  );
  return made;
}

/**
 * Drive the loop to its close, answering each phase with `answer(phase, entry)`. Returns the
 * phases issued, the rules each one handed out, and the settled review.
 */
function driveBuild(made, answer) {
  const seen = [];
  const handed = {};
  let closing = null;
  for (let pass = 0; pass < 12; pass++) {
    const out = issue(made.state, made.stateFile, PHASES, REGISTRY);
    if (out.phase.answer === "end") {
      closing = out;
      break;
    }
    seen.push(out.phase.name);
    // Named at hand-out, while the numbers still mean what they meant to this pass.
    handed[out.phase.name] = out.entries.map((e) => ruleAt(made, e.index));
    accept(
      made.state,
      handBack(made.state, (e) => answer(out.phase.name, e)),
      PHASES,
      REGISTRY
    );
  }
  return {
    seen,
    handed,
    closing,
    settled: settle(made.state, REGISTRY),
  };
}

/** Every phase answered the way a review that goes on answers it. */
const goesOn =
  (overrides = {}) =>
  (phase, e) =>
    overrides[phase]?.(e) ??
    (phase === "verify"
      ? "withdrawn"
      : phase === "settle"
        ? "cleared"
        : "Clear");

/** The rule behind one ordered index in this review. */
function ruleAt(made, index) {
  const ordered = made.state.manual;
  return orderReview(made.state.report.findings, ordered).find(
    (x) => x.index === index
  )?.target?.ruleId;
}

// The build questions come after the build, each in a phase of its own so it is put to the
// reviewer ALONE: `ask` batches, and nobody may be asked to install an XPI beside the
// question whether the source reproduces it. undeclared-build-source is settled before
// anything is built.
test("the two build questions are asked alone, after the build and before ask", () => {
  const made = buildQuestionsReview(tmp());
  const { seen, handed, settled } = driveBuild(made, goesOn());
  assert.deepEqual(seen, [
    "spawn",
    "verify",
    "settle",
    "build",
    "details",
    "built",
    "reproduced",
    "ask",
  ]);
  assert.deepEqual(handed.built, ["build-succeeds"]);
  assert.deepEqual(handed.reproduced, ["build-reproduces-xpi"]);
  const asked = handed.ask;
  assert.ok(!asked.includes("build-succeeds"), asked.join(", "));
  assert.ok(!asked.includes("build-reproduces-xpi"), asked.join(", "));
  assert.ok(
    handed.settle.includes("undeclared-build-source"),
    "the agent settles the build sources"
  );
  assert.equal(settled.earlyExit, false);
});

// A "no" to either build question aborts the review there: the case is its finding, the
// questions still pending are never put, and the report ends on why. A build that failed
// is never also asked whether it reproduces the XPI.
test("a build question answered no aborts the review, and nothing after it is asked", () => {
  for (const [phase, said, rule, skipped] of [
    ["built", "Report", "build-succeeds", ["reproduced", "ask"]],
    ["built", "npm run build fails", "build-succeeds", ["reproduced", "ask"]],
    ["reproduced", "Report", "build-reproduces-xpi", ["ask"]],
  ]) {
    const made = buildQuestionsReview(tmp());
    const { seen, closing, settled } = driveBuild(
      made,
      goesOn({ [phase]: () => said })
    );
    for (const later of skipped) {
      assert.ok(!seen.includes(later), `${phase}/${said}: ${seen.join(", ")}`);
    }
    assert.equal(settled.earlyExit, true, `${phase}/${said}`);
    assert.match(closing.steps[0].text, /^The review was aborted/);
    assert.match(settled.report, /- Build process issues/);
    assert.deepEqual(
      settled.review.findings.map((f) => f.ruleId),
      [rule],
      `${phase}/${said}`
    );
    assert.deepEqual(
      settled.review.meta.manualReview
        .map((m) => m.ruleId)
        .filter((id) => id.startsWith("build-")),
      [],
      "no build question is left listed"
    );
  }
});

// The agent reads the build before anything is built: a build reaching for an undeclared
// source aborts the review in `settle`, so it is never run and never offered.
test("undeclared build sources reported in settle abort the review before the build", () => {
  const made = buildQuestionsReview(tmp());
  const { seen, settled } = driveBuild(
    made,
    goesOn({
      settle: (e) =>
        ruleAt(made, e.index) === "undeclared-build-source"
          ? "reported"
          : "cleared",
    })
  );
  assert.deepEqual(seen, ["spawn", "verify", "settle"]);
  assert.equal(settled.earlyExit, true);
  assert.deepEqual(
    settled.review.findings.map((f) => f.ruleId),
    ["undeclared-build-source"]
  );
});

// --llm-skip-manual withholds the questions in `ask`, not the build questions: those decide
// whether the review goes on at all.
test("--llm-skip-manual still asks the build questions", () => {
  const made = buildQuestionsReview(tmp());
  made.state.run.skip = ["llm-skip-manual"];
  const { seen } = driveBuild(made, goesOn());
  assert.deepEqual(seen.slice(-3), ["details", "built", "reproduced"]);
  assert.ok(!seen.includes("ask"), seen.join(", "));
});

// A case is routed by what it IS, not by its number: a sweep that files cases ahead of the
// build questions renumbers the review, and each question still opens in its own phase.
test("a renumbered review still asks each build question in its own phase", () => {
  const made = buildQuestionsReview(tmp());
  // Two cases filed ahead of everything, the way a sweep's escalations land in code review.
  made.state.manual.unshift(
    { ...made.state.manual[0], ruleId: "privacy-policy", instructions: "a" },
    { ...made.state.manual[0], ruleId: "privacy-policy", instructions: "b" }
  );
  const { handed } = driveBuild(made, goesOn());
  assert.deepEqual(handed.built, ["build-succeeds"]);
  assert.deepEqual(handed.reproduced, ["build-reproduces-xpi"]);
});

// The agent's `ask` verdict moves the case itself. A verdict that removes an earlier item
// renumbers the review before an abort decides what is dropped, and the routed case must
// still be the one that goes - not whatever now holds its old number.
test("a case sent on with ask is dropped by an abort even after a renumbering", () => {
  const made = buildQuestionsReview(tmp());
  made.state.manual.unshift({
    ...made.state.manual[0],
    ruleId: "unknown-api",
    instructions: "cleared first",
    settleVerbs: ["reported", "cleared", "ask"],
  });
  const { settled } = driveBuild(
    made,
    goesOn({
      settle: (e) => {
        const instr = made.state.manual.find(
          (m) =>
            orderReview(made.state.report.findings, made.state.manual).find(
              (x) => x.index === e.index
            )?.target === m
        )?.instructions;
        return instr === "settle me" ? "ask" : "cleared";
      },
      built: () => "Report",
    })
  );
  assert.equal(settled.earlyExit, true);
  const left = settled.review.meta.manualReview.map((m) => m.instructions);
  assert.ok(!left.includes("settle me"), `routed case kept: ${left}`);
});

/**
 * Drive the loop, answering each phase plainly, and return the first line of each step of
 * every prompt it printed - by phase, with the preamble the prompt carried.
 */
function promptsOf(made) {
  const prompts = {};
  for (let pass = 0; pass < 12; pass++) {
    const out = issue(made.state, made.stateFile, PHASES, REGISTRY);
    prompts[out.phase.name] = {
      steps: out.steps.map((x) => x.text.split("\n")[0]),
      preamble: out.preamble.length,
    };
    if (out.phase.answer === "end") {
      break;
    }
    for (const artifact of Object.keys(made.state.paths.sweeps ?? {})) {
      swept(made.state, artifact);
    }
    accept(
      made.state,
      handBack(made.state, () =>
        out.phase.name === "verify"
          ? "withdrawn"
          : out.phase.name === "settle"
            ? "cleared"
            : "Clear"
      ),
      PHASES,
      REGISTRY
    );
  }
  return prompts;
}

const WAIT = "Wait for every agent you spawned to come back.";

// A review whose first prompt is already the closing one ran nothing before it, so that
// prompt says nothing about passes, agents or decisions: no preamble, no "settled", no
// wait, no "LLM decisions" - just what to give the reviewer.
test("a one-pass review's only prompt says only what applies", () => {
  const { state, stateFile } = review(tmp(), {
    sweep: false,
    findings: false,
    code: false,
    questions: false,
  });
  state.run = { skip: ["llm-skip-summary", "llm-skip-manual"], sca: false };
  const prompts = promptsOf({ state, stateFile });
  assert.deepEqual(Object.keys(prompts), ["close"]);
  assert.equal(prompts.close.preamble, 0, "no preamble above it");
  assert.deepEqual(prompts.close.steps, [
    "Give the reviewer what follows, each part under a heading of its own and in this order. Print nothing between the parts and nothing after them.",
    'Under "Summary", this, as it is written here:',
  ]);
});

// The preamble opens the first prompt and only that one; the closing prompt of a review
// that ran says it is settled, waits for the agents it started, and asks for the account
// of what the agent decided.
test("the preamble opens the first prompt only, and close says what ran", () => {
  const made = review(tmp());
  const prompts = promptsOf(made);
  const order = Object.keys(prompts);
  assert.equal(prompts[order[0]].preamble, 1, `${order[0]} opens the review`);
  for (const name of order.slice(1)) {
    assert.equal(prompts[name].preamble, 0, `${name} carries no preamble`);
  }
  assert.deepEqual(prompts.close.steps.slice(0, 2), [
    "The review is settled.",
    WAIT,
  ]);
  assert.ok(
    prompts.close.steps.some((x) => x.startsWith('Under "LLM decisions"')),
    "the agent accounts for what it decided"
  );
});

// The wait for spawned agents is its own step, printed only where an agent was started -
// and never on its own: a phase whose only surviving step is the wait is not issued.
test("the agent wait prints only where an agent was started, and never alone", () => {
  // A source review always starts the build-report agent, so both phases wait.
  const source = promptsOf(buildQuestionsReview(tmp()));
  assert.equal(source.build.steps[0], WAIT);
  assert.match(
    source.build.steps[1],
    /^Ask the reviewer, with your question tool/
  );
  assert.deepEqual(source.details.steps[0], WAIT);
  assert.match(source.details.steps[1], /^Give the reviewer this block/);

  // An XPI review that started a sweep waits before the details block, and never builds.
  const swept = promptsOf(review(tmp()));
  assert.equal(swept.details.steps[0], WAIT);
  assert.ok(!("build" in swept), "no build phase made of a wait alone");

  // An XPI review that started nothing does not wait.
  const quiet = review(tmp(), { sweep: false });
  quiet.state.run = { skip: ["llm-skip-summary"], sca: false };
  const prompts = promptsOf(quiet);
  assert.ok(!("spawn" in prompts));
  assert.deepEqual(prompts.details.steps.length, 1);
  assert.match(prompts.details.steps[0], /^Give the reviewer this block/);

  // An XPI review under --llm-skip-manual asks nothing, so no details phase made of a wait.
  const skipped = review(tmp());
  skipped.state.run.skip = ["llm-skip-manual"];
  assert.ok(!("details" in promptsOf(skipped)));
});

// Building runs the submission's own code, so it comes after `settle` has had its say on
// every case that could abort the review, and before the questions the diff is read for.
test("a source code review builds once, after settle and before ask", () => {
  const { state, stateFile } = buildReview(tmp());
  const { seen } = driveLoop(state, stateFile, (phase) =>
    phase === "verify" ? "withdrawn" : "cleared"
  );
  assert.deepEqual(seen, [
    "spawn",
    "verify",
    "settle",
    "build",
    "details",
    "ask",
  ]);
});

test("an XPI review never builds", () => {
  const { state, stateFile } = review(tmp(), { sweep: false });
  const { seen } = driveLoop(state, stateFile, (phase) =>
    phase === "verify" ? "withdrawn" : "cleared"
  );
  assert.ok(!seen.includes("build"), seen.join(", "));
});

test("an aborted review never builds", () => {
  const { state, stateFile } = blockingReview(tmp());
  const { seen } = driveLoop(state, stateFile, (phase) =>
    phase === "verify" ? "reported" : "cleared"
  );
  assert.ok(!seen.includes("build"), seen.join(", "));
});

// The build phase asks about no entry, so a hand-back that adds one is answering a
// question nobody asked.
test("the build phase is handed back empty, or refused", () => {
  const { state, stateFile } = buildReview(tmp());
  driveLoop(state, stateFile, (phase) =>
    phase === "verify" ? "withdrawn" : "cleared"
  );
  const fresh = buildReview(tmp());
  fresh.state.phase = "build";
  fs.writeFileSync(
    fresh.state.review,
    JSON.stringify({ base: "r", entries: [{ index: 1, answer: "x" }] })
  );
  assert.throws(
    () => accept(fresh.state, fresh.state.review, PHASES, REGISTRY),
    HandbackRefused
  );
});

// The reviewer may decline the build, and then there is no diff to link. Whether there is
// one is read when the phase comes back, so the ask hand-over and the final both say the
// same thing.
test("the details link the build diff only when the build phase wrote one", () => {
  // A folder at the diff's path is not a diff the agent wrote.
  for (const wrote of ["file", "folder", null]) {
    const { state, stateFile } = buildReview(tmp());
    for (let pass = 0; pass < 8; pass++) {
      const out = issue(state, stateFile, PHASES, REGISTRY);
      if (!out || out.phase.name === "ask") {
        break;
      }
      if (out.phase.name === "build" && wrote === "file") {
        fs.writeFileSync(state.paths.buildDiff, "The build is identical.\n");
      }
      if (out.phase.name === "build" && wrote === "folder") {
        fs.mkdirSync(state.paths.buildDiff);
      }
      accept(
        state,
        handBack(state, () =>
          out.phase.name === "verify" ? "withdrawn" : "cleared"
        ),
        PHASES,
        REGISTRY
      );
    }
    const linked = /^\* BUILD_DIFF: \[build-diff\.md\]/m;
    const { details } = settle(state, REGISTRY);
    for (const block of [reviewDetails(state), details]) {
      if (wrote === "file") {
        assert.match(block, linked);
      } else {
        assert.doesNotMatch(block, /BUILD_DIFF/);
      }
    }
  }
});

// The two suppressions of the `ask` phase are different facts and must stay so: the skip
// leaves the items in the report for a reviewer to work through later, the halt takes
// them out because nobody is going to.
test("a skip and a halt suppress the same phase and leave different reports", () => {
  const skipped = review(tmp(), { sweep: false });
  skipped.state.run = { skip: ["llm-skip-manual"], sca: false, sweep: false };
  const { settled: skippedOut } = driveLoop(
    skipped.state,
    skipped.stateFile,
    (phase) => (phase === "verify" ? "reported" : "cleared")
  );
  assert.equal(skippedOut.earlyExit, false);
  assert.ok(
    skippedOut.review.meta.manualReview.some((m) => !m.extended),
    "a skip leaves the questions in the report"
  );

  const halted = blockingReview(tmp());
  halted.state.run = { skip: ["llm-skip-manual"], sca: true, sweep: false };
  const { settled } = driveLoop(halted.state, halted.stateFile, (phase) =>
    phase === "verify" ? "reported" : "cleared"
  );
  assert.equal(settled.earlyExit, true);
  assert.equal(
    settled.review.meta.manualReview.some((m) => !m.extended),
    false,
    "a halt takes them out, even with the skip also on"
  );
});

// A per-mode response must read the same on the pass that FOUND the case and on the pass
// that re-renders it. The loop never sees a REVIEW_MODE: it rebuilds the one fact its
// state file carries (`report.sca`), so this is the only place that can prove the two
// agree - `report.sca` is otherwise unset in every test here, i.e. every loop test has
// run as an XPI review until now. No shipped check words itself per mode today, so the
// wording is put on one for the length of the test, the way the registry rules are.
test("settle words a per-mode response from the state's review mode", () => {
  const reg = loadRegistry();
  const entry = reg.doc["deterministic-phase"].find(
    (e) => e.check === "untrusted-library"
  );
  delete entry.response;
  entry["response-for-xpi"] = "worded for an XPI review";
  entry["response-for-sca"] = "worded for a source code review";
  {
    const worded = (sca) => {
      const { state, stateFile } = review(tmp(), {
        sweep: false,
        code: false,
        questions: false,
      });
      state.report.sca = sca;
      // A source review has both roots, and every finding says which one its path is in
      // - the loop resolves the path for the agent from exactly that pair.
      state.paths.scaRoot = sca ? "/tmp/src/" : null;
      state.report.findings = [
        {
          ruleId: "untrusted-library",
          severity: "info",
          file: "lib/widget.js",
          loc: { line: 1 },
          artifact: sca ? "SCA" : "XPI",
          message: null,
        },
      ];
      const { settled } = driveLoop(state, stateFile, () => "reported", reg);
      return settled.review.findings[0].message;
    };

    assert.equal(worded(true), "worded for a source code review");
    assert.equal(worded(false), "worded for an XPI review");
    // And it is the text the run that FOUND it would have printed.
    const live = { ruleId: "untrusted-library", item: null, message: null };
    renderFindings([live], reg, REVIEW_MODE.SCA);
    assert.equal(worded(true), live.message);
  }
});

// A review in flight does not survive an upgrade, and the state file is where that is
// caught. Bumping STATE_VERSION is only half a change: without this, a state written by
// an older build would be read as if it carried what the new loop needs - and what it
// needs now (an `artifact` on every finding, `paths.xpiRoot`) is absent rather than
// wrong, so the loop would hand out unlabelled loci and relative paths instead of failing.
test("a state file from another version of the tool is refused, not read", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-"));
  const file = path.join(dir, "r.state.json");
  try {
    for (const version of [STATE_VERSION - 1, STATE_VERSION + 1, undefined]) {
      fs.writeFileSync(file, JSON.stringify({ version, review: {} }));
      assert.throws(
        () => readState(file),
        /written by another version of this tool/,
        `version ${version}`
      );
    }
    // The current one reads back.
    fs.writeFileSync(file, JSON.stringify({ version: STATE_VERSION, ok: 1 }));
    assert.equal(readState(file).ok, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
