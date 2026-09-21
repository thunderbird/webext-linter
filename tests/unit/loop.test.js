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
import { STATE_VERSION } from "../../src/report/state.js";
import {
  issue,
  accept,
  settle,
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
    file: null,
    loc: null,
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
              { check: "privacy-policy", instruction: "i1" },
              { check: "data-exfiltration", instruction: "i2" },
            ],
          }
        : null,
      run: { skip: [], sca: false, sweep },
      paths: { description: `${base}.summary.md`, build: null },
      answers: {},
      route: {},
      sweep: null,
    },
  };
}

/** Fill every slot the way an obedient agent would, and hand it back. */
function handBack(state, answerFor) {
  const file = state.review;
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  doc.entries = doc.entries.map((e) => ({ ...e, answer: answerFor(e) }));
  fs.writeFileSync(file, JSON.stringify(doc, null, 1));
  return file;
}

// The shape of a whole review: which phases are issued, in what order, and what each one
// asks about. Every route the loop has is exercised here - a sweep answered by check, a
// finding withdrawn, a case settled, a case that becomes a question, and a person's own
// words coming back.
test("a review runs spawn -> verify -> settle -> ask and then settles", () => {
  const dir = tmp();
  const { state, stateFile } = review(dir);
  const seen = [];
  const answered = [];
  for (let pass = 0; pass < 10; pass++) {
    const out = issue(state, stateFile, PHASES, REGISTRY);
    if (!out) break;
    seen.push(out.phase.name);
    const file = handBack(state, (e) => {
      if (out.phase.name === "spawn") return [];
      if (out.phase.name === "verify")
        return e.index === 1 ? "withdrawn" : "reported";
      if (out.phase.name === "settle") return "ask"; // -> becomes a question
      return "Clear"; // the reviewer's own word
    });
    const { answers } = accept(state, file, PHASES, REGISTRY);
    answered.push([out.phase.name, [...answers.keys()].join(",")]);
  }
  assert.deepEqual(seen, ["spawn", "verify", "settle", "ask"]);
  // The settle case became a question and was asked WITH its own index, beside the two
  // standard ones - three questions, not two.
  assert.equal(answered[3][1].split(",").length, 3);
  assert.deepEqual(state.answers, {
    1: "withdrawn",
    2: "reported",
    3: "Clear",
    4: "Clear",
    5: "Clear",
  });
  assert.deepEqual(state.route, { 3: "ask" });
  assert.deepEqual(state.sweep, {
    "privacy-policy": [],
    "data-exfiltration": [],
  });
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
  state.run = { skip: ["summary"], sca: false, sweep: false };
  // Spawn unpacks the package whatever else it does, so it is issued in every review;
  // marked done here so this test starts where it means to.
  state.issued = ["spawn"];
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
    r.state.run = { skip: ["summary"], sca: false, sweep: false };
    r.state.issued = ["spawn"];
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
  state.run = { skip: ["summary"], sca: false, sweep: false };
  const out = issue(state, stateFile, PHASES, REGISTRY);
  assert.equal(out.phase.name, "verify");
});

test("nothing to ask: the review settles after the last settle", () => {
  const dir = tmp();
  const { state, stateFile } = review(dir, { sweep: false });
  state.manual = state.manual.filter((m) => m.extended);
  // skip:manual drops only the questions. spawn is skipped too (nothing to start) - so
  // what this pins is that `ask` is not issued either, once it has nothing to put to
  // anyone.
  state.run = { skip: ["manual", "summary"], sca: false, sweep: false };
  const seen = [];
  for (let pass = 0; pass < 10; pass++) {
    const out = issue(state, stateFile, PHASES, REGISTRY);
    if (!out) break;
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
  assert.equal(issue(state, stateFile, PHASES, REGISTRY), null, "settled");
});

// Four ways a hand-back can be wrong. Each names the one thing to fix, and NONE of them
// touches the state: a corrected hand-back resumes exactly where it was, which is why the
// caller does not re-print the prompt.
test("a wrong hand-back is refused, and changes nothing", () => {
  const dir = tmp();
  const { state, stateFile } = review(dir, { sweep: false });
  // --llm-skip-summary as well, so spawn starts nothing and verify is the phase in
  // flight: a refusal needs a pass that actually asked for something.
  state.run = { skip: ["summary"], sca: false, sweep: false };
  // Spawn unpacks the package whatever else it does, so it is issued in every review;
  // marked done here so this test starts where it means to.
  state.issued = ["spawn"];
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

// The sweep is the one phase whose answer is not a verb, and the one where an empty answer
// is a real answer. `null` is unanswered; `[]` is swept and clean. Today those are the same
// empty result, so a sweep that quietly covered two checks of eight reads like a clean one.
test("a sweep answers per check, and an empty list is not the same as no answer", () => {
  const dir = tmp();
  const { state, stateFile } = review(dir);
  const out = issue(state, stateFile, PHASES, REGISTRY);
  assert.equal(out.phase.name, "spawn");
  assert.deepEqual(
    out.entries.map((e) => e.check),
    ["privacy-policy", "data-exfiltration"]
  );
  assert.ok(
    out.entries.every((e) => e.answer === null),
    "handed over unanswered"
  );

  const half = handBack(state, (e) =>
    e.check === "privacy-policy" ? [] : null
  );
  assert.throws(
    () => accept(state, half, PHASES, REGISTRY),
    /data-exfiltration still has no "answer"/
  );

  const notList = handBack(state, () => "nothing found");
  assert.throws(
    () => accept(state, notList, PHASES, REGISTRY),
    /a sweep answers with a list/
  );

  const clean = handBack(state, () => []);
  accept(state, clean, PHASES, REGISTRY);
  assert.deepEqual(state.sweep, {
    "privacy-policy": [],
    "data-exfiltration": [],
  });
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

// The agent authors the sweep's rows, so they are held to a shape where they enter - and a
// refusal here is a refusal like any other: named exactly, and the state untouched.
test("a swept row that says too much, or too little, is refused", () => {
  const dir = tmp();
  const { state, stateFile } = review(dir);
  issue(state, stateFile, PHASES, REGISTRY);
  const before = JSON.stringify(state);
  const hand = (found) =>
    handBack(state, (e) => (e.check === "privacy-policy" ? [found] : []));

  assert.throws(
    () => accept(state, hand({ line: 3 }), PHASES, REGISTRY),
    /names no "file"/
  );
  assert.throws(
    () => accept(state, hand({ file: "a.js", line: 0 }), PHASES, REGISTRY),
    /has line 0/
  );
  // Where it lands and how it reads to a developer are the linter's: a row that tries to
  // say is an agent wording the report.
  assert.throws(
    () =>
      accept(
        state,
        hand({ file: "a.js", severity: "error" }),
        PHASES,
        REGISTRY
      ),
    /may only set/
  );
  assert.equal(JSON.stringify(state), before, "a refusal changes nothing");

  accept(
    state,
    hand({ file: "lib/sync.js", line: 88, hint: "posts to a fixed endpoint" }),
    PHASES,
    REGISTRY
  );
  assert.equal(state.sweep["privacy-policy"].length, 1);
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
  state.run = { skip: ["manual"], sca: false, sweep: false };
  const seen = [];
  for (let pass = 0; pass < 8; pass++) {
    const out = issue(state, stateFile, PHASES, REGISTRY);
    if (!out) break;
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
    if (!out) break;
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
  state.run = { skip: [], sca: false, sweep: false };
  const first = issue(state, stateFile, PHASES, REGISTRY);
  assert.deepEqual(first.entries, [], "no rows to fill in");
  const prose = first.steps.map((s) => s.text).join("\n");
  assert.doesNotMatch(prose, /sweep/i, "and no step mentions one");
  assert.equal(state.sweep, null, "nothing was swept");

  // And the empty file IS the right hand-back. Both legs read the same fact, so the pass
  // that asked for nothing accepts nothing; reading `preSweep` on the way back in would
  // demand the rows this one withheld, and no hand-back could satisfy it.
  const { answers } = accept(
    state,
    handBack(state, () => null),
    PHASES,
    REGISTRY
  );
  assert.equal(answers.size, 0);
  assert.ok(issue(state, stateFile, PHASES, REGISTRY), "the review goes on");
});

/**
 * Run a whole review with a canned answer per phase, THROUGH to the settled report.
 *
 * Driven to the end rather than to the last hand-back, because applying the answers is its
 * own step: a phase can hand out and take back cleanly and still refuse what it took when
 * the report is built from it.
 * @returns {{seen: string[], details: string}}  The phases issued, and the Review Details
 *   block the report carries - empty when a phase handed it over already.
 */
function phasesOf(state, stateFile) {
  const seen = [];
  for (let pass = 0; pass < 10; pass++) {
    const out = issue(state, stateFile, PHASES, REGISTRY);
    if (!out) break;
    seen.push(out.phase.name);
    accept(
      state,
      handBack(state, (e) =>
        out.phase.name === "spawn"
          ? []
          : out.phase.name === "verify"
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
    [{ findings: false, code: false, questions: false }, ["spawn"]],
    [{ findings: true, code: false, questions: false }, ["spawn", "verify"]],
    [{ findings: false, code: true, questions: false }, ["spawn", "settle"]],
    [{ findings: false, code: false, questions: true }, ["spawn", "ask"]],
    [
      { findings: true, code: true, questions: true },
      ["spawn", "verify", "settle", "ask"],
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
//   summary -> the description agent, and the link that hands it over
//   manual  -> the questions: the entries as well as the step that asks them
//   sweep   -> the sweep agent, the wait, and the rows it would have filled
test("every combination of the skips issues exactly the phases it should", () => {
  const SKIPS = ["summary", "manual", "sweep"];
  for (let bits = 0; bits < 8; bits++) {
    const skip = SKIPS.filter((_, i) => bits & (1 << i));
    const sweeps = !skip.includes("sweep");
    const dir = tmp();
    const { state, stateFile } = review(dir, { sweep: sweeps });
    state.run = {
      skip: skip.filter((x) => x !== "sweep"),
      sca: false,
      sweep: sweeps,
    };
    // A file is NAMED only where the step that writes it prints, as the pipeline names it:
    // --llm-skip-summary spawns no description agent, so there is no description to link.
    if (skip.includes("summary")) {
      state.paths.description = null;
    }
    // `spawn` runs only where it starts an agent: the package itself is no longer
    // unpacked by a step here (the linter extracts it before the review is printed), so
    // a run that skips the summary agent and does not sweep has nothing left to spawn.
    const expected = [
      ...(!skip.includes("summary") || sweeps ? ["spawn"] : []),
      "verify",
      "settle",
      // The questions are the only thing `ask` is for.
      ...(skip.includes("manual") ? [] : ["ask"]),
    ];
    const { seen, details } = phasesOf(state, stateFile);
    const where = `skips: ${skip.join(",") || "none"}`;
    assert.deepEqual(seen, expected, where);

    // The Review Details block is handed over ONCE, by whichever phase gets there first:
    // `ask` before it asks anything, or the report when that phase is never issued.
    // Never twice, and never not at all.
    if (seen.includes("ask")) {
      assert.equal(details, "", `${where}: the ask phase handed it over`);
    } else {
      // Written for a chat: a list of links, then what the verdicts mean anything
      // against. The heading above it is the agent's to write, so it is not in here.
      assert.match(
        details,
        /^\* XPI_FILE: /m,
        `${where}: the report hands it over`
      );
      assert.match(
        details,
        /^\* XPI_ROOT: \[/m,
        `${where}: and where to read it`
      );
      assert.match(details, /^schema /m, `${where}: and says what against`);
    }
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
  state.run = { skip: ["summary"], sca: false, sweep: false };
  // spawn has nothing to start in this config and is never issued - marked done here
  // anyway, so this test starts where it means to regardless.
  state.issued = ["spawn"];
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
  state.run = { skip: ["summary"], sca: false, sweep: false };
  // Spawn unpacks the package whatever else it does, so it is issued in every review;
  // marked done here so this test starts where it means to.
  state.issued = ["spawn"];

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
  state.run = { skip: ["summary"], sca: false, sweep: false };
  // Spawn unpacks the package whatever else it does, so it is issued in every review;
  // marked done here so this test starts where it means to.
  state.issued = ["spawn"];
  // Real check ids, because a reported case becomes a finding of its own check and takes
  // the severity that check declares.
  state.manual.forEach((m, i) => {
    m.ruleId = ["test-add-on", "no-surprises-policy"][i];
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
    issue(state, stateFile, PHASES, REGISTRY),
    null,
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
function driveLoop(state, stateFile, answer) {
  const seen = [];
  // `ask` takes a REVIEWER's answer, not a verb: the phase that asks declares none, and
  // handing it one would be refused where it is applied rather than where it is taken.
  const [clear] = REGISTRY.manualReviewChoices().map((c) => c.label);
  for (let pass = 0; pass < 8; pass++) {
    const out = issue(state, stateFile, PHASES, REGISTRY);
    if (!out) {
      break;
    }
    seen.push(out.phase.name);
    accept(
      state,
      handBack(state, () =>
        out.phase.name === "ask" ? clear : answer(out.phase.name)
      ),
      PHASES,
      REGISTRY
    );
  }
  return { seen, settled: settle(state, REGISTRY) };
}

/** The review above, with its findings reported by a check that stops the review. */
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
test("a blocking finding stops the loop before the question block", () => {
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
// thing that stopped the review. The question block comes back.
test("withdrawing the blocking findings puts the question block back", () => {
  const dir = tmp();
  const { state, stateFile } = blockingReview(dir);
  const { seen, settled } = driveLoop(state, stateFile, (phase) =>
    phase === "verify" ? "withdrawn" : "cleared"
  );
  assert.ok(seen.includes("ask"), `ask was not issued: ${seen.join(", ")}`);
  assert.equal(settled.earlyExit, false);
});

// What a stopped review hands the reviewer: the closing line in the developer's text, no
// questions left listed under it, and a tally that does not advertise work nobody was
// asked to do. The code-review items it settled are still there.
test("a stopped review hands over the reason and drops the questions", () => {
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
    if (!out) {
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

// The two suppressions of the `ask` phase are different facts and must stay so: the skip
// leaves the items in the report for a reviewer to work through later, the halt takes
// them out because nobody is going to.
test("a skip and a halt suppress the same phase and leave different reports", () => {
  const skipped = review(tmp(), { sweep: false });
  skipped.state.run = { skip: ["manual"], sca: false, sweep: false };
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
  halted.state.run = { skip: ["manual"], sca: true, sweep: false };
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
