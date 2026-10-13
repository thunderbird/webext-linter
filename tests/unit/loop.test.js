// The REVIEW LOOP, driven end to end with no agent: every phase handed out, answered from
// a canned decision, and handed back.
//
// This file is the safety net for the whole round trip. The goldens contain no prompt
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
import { assignRefs, orderReview } from "../../src/report/order.js";
import { writeReportFile } from "../../src/report/report-file.js";
import {
  issue,
  accept,
  settle,
  loopSlots,
  reviewDetails,
  HandbackRefused,
} from "../../src/report/loop.js";
import { workPaths } from "../../src/util/dest.js";
import { loopPromptLines } from "../../src/report/format.js";
import { sweepRequests } from "../../src/report/sweep-files.js";

const REGISTRY = loadRegistry();
const PHASES = REGISTRY.llmPhases().phases;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wxl-loop-"));

/** A review small enough to read, carrying one of each kind the loop routes:
 *  two findings (verify), one code-review case (settle), two questions (ask). */
function review(
  dir,
  { sweep = true, findings = true, code = true, questions = true } = {}
) {
  // The work folder's own names, as a review lays them out (src/util/dest.js).
  const files = workPaths(dir);
  const finding = (i, ruleId) => ({
    ruleId,
    severity: "error",
    file: `f${i}.js`,
    loc: { line: i },
    // Every finding carries the artifact its path is in, as its holder minted it
    // (src/checks/registry.js runOneCheck). A state without it is not one the loop
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
  const made = {
    work: dir,
    state: {
      version: STATE_VERSION,
      report: {
        findings: findings ? [finding(1, "a"), finding(2, "b")] : [],
        // What the Review Details block is built from - the artifacts this review is of,
        // which is the whole reason a phase hands that block over.
        meta: {
          xpi: `${dir}/a.xpi`,
          xpiRoot: `${files.xpi}/`,
          xpiFile: "a.xpi",
          // The report the reviewer sends. Named here because it is a row of that block
          // like any other, and the one the last prompt exists to leave them holding.
          reportFile: files.report,
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
        description: files.summary,
        build: null,
        report: files.report,
        // The roots an entry's paths are resolved against (handback.js entriesFor). The
        // state carries both; without xpiRoot the loop would hand out relative paths.
        xpiRoot: "/tmp/work/xpi/",
        scaRoot: null,
        // Each tree's sweep request and answers file, which is also what says WHICH trees
        // were asked. The request is printed by the step, and the answers file is the one
        // this loop opens.
        ...(sweep
          ? {
              sweeps: {
                [ARTIFACT_XPI]: {
                  request: "Sweep the add-on.",
                  answers: files.sweep(ARTIFACT_XPI),
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
  refed(made.state);
  return made;
}

/** Give every item of a hand-built state its reference, as the pipeline does when it
 *  writes a real one (src/report/order.js assignRefs). Called again by a test that adds
 *  items, which keep the references they already have. */
/** The reference the fixture's code-review case (unknown-api) gets: its check's registry
 *  position, first of its kind. The fixture's other items name no registered check. */
const CASE = `${REGISTRY.refBase("unknown-api")}.1`;

/** A source code review whose build every guard vouches for, so its details hold the build
 *  rows: the fixture's review, with no sweep. */
function scaReview(dir) {
  const made = review(dir, { sweep: false });
  made.state.run = { ...made.state.run, sca: true, "build-guarded": true };
  return made;
}

function refed(state) {
  assignRefs([...state.report.findings, ...state.manual], REGISTRY);
  return state;
}

// The report is the one review document the LINTER writes. It is written when the `ask`
// phase goes out - its first steps hand the reviewer the Review Details block, which links
// the file, and they read it to answer the questions that follow - and written again from
// the settled review once those answers are in.
test("the report file is written for the questions and rewritten once they are answered", () => {
  const dir = tmp();
  const { state, work } = review(dir);
  const file = state.paths.report;

  // Nothing yet: the path is named, but no phase has handed it to anyone.
  assert.equal(fs.existsSync(file), false);

  const seen = [];
  for (let pass = 0; pass < 10; pass++) {
    const out = issue(state, work, PHASES, REGISTRY);
    if (out.phase.answer === "end") {
      break;
    }
    seen.push(out.phase.name);
    // Written exactly when `ask` hands the reviewer its link, and not before it.
    assert.equal(
      fs.existsSync(file),
      seen.includes("ask"),
      `after issuing ${out.phase.name}`
    );
    if (out.phase.name === "spawn") {
      swept(state, ARTIFACT_XPI);
    }
    handBack(work, (e) => {
      if (out.phase.name === "verify")
        return e.index === "0.1" ? "withdrawn" : "reported";
      if (out.phase.name === "settle") return "ask";
      return "Clear";
    });
    accept(state, work, PHASES, REGISTRY);
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

/** The review file in the review's work folder, where `issue` writes it and `accept`
 *  reads it back. */
function reviewFileOf(work) {
  return workPaths(work).review;
}

/** Fill every slot the way an obedient agent would, in the review's own file. */
function handBack(work, answerFor) {
  const file = reviewFileOf(work);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  doc.entries = doc.entries.map((e) => ({ ...e, answer: answerFor(e) }));
  fs.writeFileSync(file, JSON.stringify(doc, null, 1));
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
test("a review runs spawn -> verify -> settle -> ask and then settles", () => {
  const dir = tmp();
  const { state, work } = review(dir);
  const seen = [];
  const answered = [];
  for (let pass = 0; pass < 10; pass++) {
    const out = issue(state, work, PHASES, REGISTRY);
    if (out.phase.answer === "end") break;
    seen.push(out.phase.name);
    if (out.phase.name === "spawn") {
      swept(state, ARTIFACT_XPI);
    }
    handBack(work, (e) => {
      if (out.phase.name === "verify")
        return e.index === "0.1" ? "withdrawn" : "reported";
      if (out.phase.name === "settle") return "ask"; // -> becomes a question
      return "Clear"; // the reviewer's own word
    });
    const { answers } = accept(state, work, PHASES, REGISTRY);
    answered.push([out.phase.name, [...answers.keys()].join(",")]);
  }
  assert.deepEqual(seen, ["spawn", "verify", "settle", "ask"]);
  // The settle case became a question and was asked WITH its own index, beside the two
  // standard ones - three questions, not two.
  assert.equal(answered[3][1].split(",").length, 3);
  assert.deepEqual(state.answers, {
    0.1: "withdrawn",
    0.2: "reported",
    0.3: "Clear",
    0.4: "Clear",
    [CASE]: "Clear",
  });
  // Moved by the case itself, not by its number: the item carries where it is asked now.
  const moved = state.manual.filter((m) => m.askedIn === "ask");
  assert.deepEqual(
    moved.map((m) => m.ruleId),
    ["unknown-api"]
  );
  assert.deepEqual(state.sweep, [], "both sweeps ran and found nothing");
});

// An answer follows its item's reference, not where the item sorts. A sweep accepted AFTER
// a question was answered files new cases ahead of it, and the answer must stay on the
// question: the new case is open for its own phase, and nothing is asked twice.
test("an answer recorded before the sweep stays on its item", () => {
  const dir = tmp();
  const { state, work } = review(dir);
  const q1 = state.manual.find((m) => m.ruleId === "q1");
  const placeOf = (item) =>
    orderReview(state.report.findings, state.manual).findIndex(
      (x) => x.target === item
    );
  const before = placeOf(q1);
  state.answers[q1.ref] = "Clear";

  const out = issue(state, work, PHASES, REGISTRY);
  assert.equal(out.phase.name, "spawn");
  swept(state, ARTIFACT_XPI, {
    2: [{ file: "lib/net.js", line: 7, hint: "sends it" }],
  });
  handBack(work, () => null);
  accept(state, work, PHASES, REGISTRY);

  const added = state.manual.find((m) => m.ruleId === "data-exfiltration");
  assert.ok(added, "the sweep filed a case");
  assert.equal(added.ref, `${REGISTRY.refBase("data-exfiltration")}.1`);
  assert.ok(placeOf(q1) > before, "the new case sorts ahead of the question");
  assert.deepEqual(state.answers, { [q1.ref]: "Clear" });
  const ordered = orderReview(state.report.findings, state.manual);
  const open = (item) =>
    !(ordered.find((x) => x.target === item).ref in state.answers);
  assert.equal(open(q1), false, "the question stays answered");
  assert.equal(open(added), true, "the new case is open");
});

// A reference is the registry position of the item's check and that check's own count,
// so it depends on nothing the review does: an item keeps one it has, a new case of a
// check continues that check's count, and a check that threw (no entry) counts under 0.
test("assignRefs numbers each check's items under its registry position", () => {
  const base = REGISTRY.refBase("unknown-api");
  assert.ok(base > 0);
  assert.equal(
    REGISTRY.refBase("suitability-for-listing"),
    REGISTRY.allEntries().findIndex(
      (e) => e.check === "suitability-for-listing"
    ) + 1,
    "manual checks count in the same file order"
  );
  const items = [
    { ruleId: "unknown-api" },
    { ruleId: "check-failed" },
    { ruleId: "unknown-api" },
  ];
  assignRefs(items, REGISTRY);
  assert.deepEqual(
    items.map((x) => x.ref),
    [`${base}.1`, "0.1", `${base}.2`]
  );
  items.push({ ruleId: "unknown-api" });
  assignRefs(items, REGISTRY);
  assert.deepEqual(
    items.map((x) => x.ref),
    [`${base}.1`, "0.1", `${base}.2`, `${base}.3`],
    "existing references stay, and the check's count continues"
  );
});

// ---- process values ----

/** The loop with a process-value phase first, and a phase after it whose one step prints
 *  only when that value came back `safe`. One value reports a check that aborts the
 *  review. */
function valueLoop() {
  const reg = loadRegistry();
  reg.doc["llm-phases"].phases.unshift(
    {
      name: "safety",
      answer: "value",
      verbs: [],
      intro: "",
      steps: [{ text: "Judge the build." }],
      values: [
        { value: "safe", label: "Safe", description: "nothing remote" },
        {
          value: "unsafe",
          label: "Unsafe",
          description: "something remote",
          reports: "build-reproduces-xpi",
        },
      ],
    },
    {
      name: "after",
      answer: "hints",
      verbs: [],
      intro: "",
      steps: [{ text: "Only when safe.", when: "value(safety, safe)" }],
    }
  );
  return { reg, phases: reg.llmPhases().phases };
}

// A process value steers the review and settles nothing: it is asked once, by its own
// entry, accepted only as one of the labels offered, and recorded where a `when:` reads it,
// never among the answers that settle items.
test("a process value is asked once and read by value(phase, id)", () => {
  const { reg, phases } = valueLoop();
  const { state, work } = review(tmp(), { sweep: false });
  const out = issue(state, work, phases, reg);
  assert.equal(out.phase.name, "safety");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(reviewFileOf(work), "utf8")).entries,
    [
      {
        index: "safety",
        answers: [
          { label: "Safe", description: "nothing remote" },
          { label: "Unsafe", description: "something remote" },
        ],
        answer: null,
      },
    ]
  );
  handBack(work, () => "Maybe");
  assert.throws(
    () => accept(state, work, phases, reg),
    /answers "Maybe", which this entry does not accept \(expected one of: Safe, Unsafe\)/
  );
  assert.equal(state.values, undefined, "a refusal records nothing");

  handBack(work, () => "Safe");
  accept(state, work, phases, reg);
  assert.deepEqual(state.values, { safety: "safe" });
  assert.deepEqual(state.answers, {}, "it settles no item");
  const next = issue(state, work, phases, reg);
  assert.equal(next.phase.name, "after", "its reader prints");
  assert.deepEqual(
    next.steps.map((x) => x.text),
    ["Only when safe."]
  );
});

// A value that reports a check aborts the review through that check: its finding is in
// the review, so the next prompt is the closing one and the report names its reason.
test("a process value that reports a check aborts the review", () => {
  const { reg, phases } = valueLoop();
  const { state, work } = review(tmp(), { sweep: false });
  issue(state, work, phases, reg);
  handBack(work, () => "Unsafe");
  accept(state, work, phases, reg);
  assert.deepEqual(state.values, { safety: "unsafe" });
  const reported = state.report.findings.find(
    (f) => f.ruleId === "build-reproduces-xpi"
  );
  assert.ok(reported, "the reported check's finding is in the review");
  assert.equal(reported.ref, `${reg.refBase("build-reproduces-xpi")}.1`);
  assert.equal(reported.artifact, ARTIFACT_SCA, "the artifact its check reads");
  const closing = issue(state, work, phases, reg);
  assert.equal(closing.phase.name, "close");
  assert.match(closing.steps[0].text, /^The review was aborted/);
  assert.match(closing.settled.details, /Build process issues/);
});

// The finding a value reports names no file, so the artifact it is about is the one its check
// reads: a check of the XPI files it against the XPI.
test("a process value's finding is about the artifact its check reads", () => {
  const { reg, phases } = valueLoop();
  // The raw entry, in whichever registry section holds it.
  Object.values(reg.doc)
    .filter(Array.isArray)
    .flat()
    .find((e) => e?.check === "build-reproduces-xpi").input = "xpi";
  const { state, work } = review(tmp(), { sweep: false });
  issue(state, work, phases, reg);
  handBack(work, () => "Unsafe");
  accept(state, work, phases, reg);
  const reported = state.report.findings.find(
    (f) => f.ruleId === "build-reproduces-xpi"
  );
  assert.equal(reported.artifact, ARTIFACT_XPI);
});

// The Build Review Details block names the submitted XPI and where it was unpacked, the
// source the review read, the build report once back, the judgement, the vulnerable packages
// the review's own audit counted in the lock, what came of the build, and the output where
// the agent built it, by the same rows the Review Details block uses. The XPI and the output
// are named by their own names.
test("the build details name the XPI, the source, the report, the judgement, the audit, the result and the output", () => {
  const dir = tmp();
  const { state, work } = scaReview(dir);
  state.report.meta.xpi = path.join(dir, "addon-1.0.xpi");
  state.report.meta.xpiFile = "addon-1.0.xpi";
  state.paths.scaRoot = path.join(dir, "rescued", "src");
  state.report.meta.scaRoot = state.paths.scaRoot;
  state.paths.build = path.join(dir, "build.md");
  state.report.meta.buildFile = state.paths.build;
  const rows = () =>
    loopSlots(state, {}, work, REGISTRY).buildDetails.split("\n");
  const xpi = `* XPI_FILE: [addon-1.0.xpi](${state.report.meta.xpi})`;
  const unpacked = `* XPI_ROOT: [extracted addon](${state.report.meta.xpiRoot})`;
  const root = `* SCA_ROOT: [source archive](${state.paths.scaRoot})`;
  const report = `* BUILD_PROCESS: [build.md](${state.paths.build})`;
  assert.deepEqual(rows(), [
    xpi,
    unpacked,
    root,
    "* BUILD_RESULT: not built: you build it",
  ]);
  state.products = ["build"];
  state.values = { "build-safety": "safe" };
  state.build = {
    result: "built",
    output: path.join(dir, "build", "addon-1.0.xpi"),
    match: "no match",
    vulnerabilities: { moderate: 1, high: 0, critical: 0 },
  };
  assert.deepEqual(rows(), [
    xpi,
    unpacked,
    root,
    report,
    "* BUILD_SAFETY: safe",
    "* BUILD_VULNERABILITIES: 1 moderate, 0 high, 0 critical",
    "* BUILD_RESULT: built by the agent",
    `* BUILD_OUTPUT: [addon-1.0.xpi](${state.build.output})`,
    "* BUILD_MATCH: no match",
  ]);
});

// BUILD_MATCH is the agent's comparison of its output with the submitted XPI, shown after
// BUILD_OUTPUT and only beside it: a build that produced nothing compared nothing.
test("the build details show the agent's comparison only beside its output", () => {
  for (const [build, shown] of [
    [{ result: "built", output: "/w/build/dist", match: "match" }, "match"],
    [
      { result: "built", output: "/w/build/dist", match: "no match" },
      "no match",
    ],
    [{ result: "failed", output: null, match: "match" }, null],
    [{ result: null, output: null, match: null }, null],
  ]) {
    const { state, work } = review(tmp(), { sweep: false });
    state.build = build;
    const rows = loopSlots(state, {}, work, REGISTRY).buildDetails.split("\n");
    const at = rows.findIndex((row) => row.startsWith("* BUILD_MATCH"));
    if (shown === null) {
      assert.equal(at, -1, rows.join("\n"));
      continue;
    }
    assert.equal(rows[at], `* BUILD_MATCH: ${shown}`);
    assert.ok(rows[at - 1].startsWith("* BUILD_OUTPUT: "), rows.join("\n"));
  }
});

// SCA_ROOT is labelled by where the reviewed source lies: the source archive, or the rescued
// copy, beside which SCA_ROOT_ORIG names the same root in the source archive. BUILD_ROOT names
// the root in the build copy where the agent built or tried to, and nowhere else. The Review
// Details name the same rows.
test("the details name the reviewed root, the original root and the build root", () => {
  const dir = tmp();
  const { state, work } = scaReview(dir);
  const sca = path.join(dir, "sca", "src");
  const rescued = path.join(dir, "rescued", "src");
  const built = path.join(dir, "build", "src");
  const rootRows = (block) =>
    block
      .split("\n")
      .filter((row) =>
        ["* SCA_ROOT", "* BUILD_ROOT"].some((n) => row.startsWith(n))
      );
  const cases = [
    [
      "the source archive, not built",
      sca,
      null,
      { result: null, root: null, output: null },
      [`* SCA_ROOT: [source archive](${sca})`],
    ],
    [
      "the source archive, built",
      sca,
      null,
      { result: "built", root: built, output: path.join(built, "dist") },
      [
        `* SCA_ROOT: [source archive](${sca})`,
        `* BUILD_ROOT: [build copy](${built})`,
      ],
    ],
    [
      "the source archive, its build failed",
      sca,
      null,
      { result: "failed", root: built, output: null },
      [
        `* SCA_ROOT: [source archive](${sca})`,
        `* BUILD_ROOT: [build copy](${built})`,
      ],
    ],
    [
      "the rescued copy, built",
      rescued,
      sca,
      { result: "built", root: built, output: path.join(built, "dist") },
      [
        `* SCA_ROOT: [rescued source (reduced/fixed dependencies)](${rescued})`,
        `* SCA_ROOT_ORIG: [source archive](${sca})`,
        `* BUILD_ROOT: [build copy](${built})`,
      ],
    ],
  ];
  for (const [name, scaRoot, scaRootOrig, build, rows] of cases) {
    state.paths.scaRoot = scaRoot;
    state.paths.scaRootOrig = scaRootOrig;
    state.report.meta.scaRoot = scaRoot;
    state.build = build;
    const { buildDetails } = loopSlots(state, {}, work, REGISTRY);
    assert.deepEqual(rootRows(buildDetails), rows, name);
    assert.deepEqual(rootRows(reviewDetails(state, REGISTRY)), rows, name);
  }
});

// BUILD_RESULT words what came of the build, one wording per build result: the agent built
// it, its build failed, the build was judged unsafe so nothing was built, or the reviewer
// builds it - where they did not let the agent build, or nothing was prepared.
test("the build result is worded by what came of the build", () => {
  const { state, work } = scaReview(tmp());
  const result = () =>
    loopSlots(state, {}, work, REGISTRY)
      .buildDetails.split("\n")
      .find((row) => row.startsWith("* BUILD_RESULT: "));
  const cases = [
    [
      { result: "built", output: "/w/build/dist" },
      "safe",
      "built by the agent",
    ],
    [{ result: "failed" }, "safe", "the agent's build failed: see build.md"],
    [{ result: null }, "unsafe", "not built: judged unsafe"],
    [{ result: null }, "safe", "not built: you build it"],
    [undefined, undefined, "not built: you build it"],
  ];
  for (const [build, safety, said] of cases) {
    state.build = build;
    state.values = safety ? { "build-safety": safety } : {};
    assert.equal(result(), `* BUILD_RESULT: ${said}`, String(build?.result));
  }
});

// An entry says what it may be answered with, and that is what an answer is checked
// against - not what the phase accepts. Two entries of one phase can offer different
// answers, so a set read off the phase would accept, for one case, a verdict the check
// that raised it withheld.
test("an entry is answered from its own answers, not its phase's verbs", () => {
  const dir = tmp();
  const { state, work } = review(dir, { sweep: false, findings: false });
  // --llm-skip-summary with no sweep leaves spawn with nothing to start, so settle is
  // first once it has been issued.
  state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  // Marked done so this test starts where it means to - spawn has nothing to start here
  // anyway.
  state.issued = ["spawn"];
  // What most screened checks declare: settle it, or clear it. No handing it on.
  state.manual[0].settleVerbs = ["reported", "cleared"];

  const out = issue(state, work, PHASES, REGISTRY);
  assert.equal(out.phase.name, "settle");
  const entry = JSON.parse(fs.readFileSync(reviewFileOf(work), "utf8"))
    .entries[0];
  assert.deepEqual(
    entry.answers.map((a) => a.label),
    ["reported", "cleared"],
    "the entry offers what its check allows"
  );
  // `ask` is one of the phase's own verbs, and still refused here.
  assert.ok(PHASES.find((p) => p.name === "settle").verbs.includes("ask"));
  assert.throws(() => {
    handBack(work, () => "ask");
    return accept(state, work, PHASES, REGISTRY);
  }, /this entry does not accept \(expected one of: reported, cleared\)/);
  assert.deepEqual(state.answers, {}, "a refusal settles nothing");

  handBack(work, () => "reported");
  accept(state, work, PHASES, REGISTRY);
  assert.deepEqual(state.answers, { [CASE]: "reported" });
});

// What a verb MEANS is the phase's to word, but `reported` reads differently where the
// case could still have been handed on. An entry offering `cleared` and no `ask` has had
// its way out declined, which is a different sentence from the same verb chosen freely.
test("reporting reads as the last resort only where clearing was the way out", () => {
  const dir = tmp();
  const skipSetup = (r) => {
    r.state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
    r.state.issued = ["spawn"];
    return r;
  };
  const offered = (verbs) => {
    const fresh = skipSetup(review(dir, { sweep: false, findings: false }));
    fresh.state.manual[0].settleVerbs = verbs;
    issue(fresh.state, fresh.work, PHASES, REGISTRY);
    const e = JSON.parse(fs.readFileSync(reviewFileOf(fresh.work), "utf8"))
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
  issue(findings.state, findings.work, PHASES, REGISTRY);
  const audit = JSON.parse(fs.readFileSync(reviewFileOf(findings.work), "utf8"))
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
// Every step of `spawn` is optional (the description agent and each tree's sweep) - the
// linter extracts the package before the review is printed (src/addon/load.js). A run
// that starts none of them is skipped like any other phase with nothing to do.
test("spawn with nothing to start is skipped, not issued empty", () => {
  const dir = tmp();
  const { state, work } = review(dir, { sweep: false });
  // --llm-skip-summary on an XPI review with no sweep starts no agent at all, so spawn
  // has nothing left to do.
  state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  const out = issue(state, work, PHASES, REGISTRY);
  assert.equal(out.phase.name, "verify");
});

test("nothing to ask: the review settles after the last settle", () => {
  const dir = tmp();
  const { state, work } = review(dir, { sweep: false });
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
    const out = issue(state, work, PHASES, REGISTRY);
    if (out.phase.answer === "end") break;
    seen.push(out.phase.name);
    handBack(work, () =>
      out.phase.name === "spawn"
        ? []
        : out.phase.name === "verify"
          ? "reported"
          : "cleared"
    );
    accept(state, work, PHASES, REGISTRY);
  }
  assert.deepEqual(seen, ["verify", "settle"]);
  assert.equal(
    issue(state, work, PHASES, REGISTRY).phase.name,
    "close",
    "settled"
  );
});

// Four ways a hand-back can be wrong. Each names the one thing to fix, and NONE of them
// touches the state: a corrected hand-back resumes exactly where it was, which is why the
// caller does not re-print the prompt.
test("a wrong hand-back is refused, and changes nothing", () => {
  const dir = tmp();
  const { state, work } = review(dir, { sweep: false });
  // --llm-skip-summary as well, so spawn starts nothing and verify is the phase in
  // flight: a refusal needs a pass that actually asked for something.
  state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  // Marked done so this test starts where it means to - spawn has nothing to start here
  // anyway.
  state.issued = ["spawn"];
  assert.equal(issue(state, work, PHASES, REGISTRY).phase.name, "verify");
  const before = JSON.stringify(state);
  // Each case starts from the file as it was HANDED OUT: mangling the last mangle would
  // test a file no pass ever produced.
  const handed = fs.readFileSync(reviewFileOf(work), "utf8");
  const mangle = (fn) => {
    const doc = JSON.parse(handed);
    fn(doc);
    fs.writeFileSync(reviewFileOf(work), JSON.stringify(doc, null, 1));
  };

  mangle((d) =>
    d.entries.forEach((e, i) => (e.answer = i ? "reported" : null))
  );
  assert.throws(
    () => accept(state, work, PHASES, REGISTRY),
    /still has no "answer"/
  );

  mangle((d) => {
    d.entries.forEach((e) => (e.answer = "reported"));
    d.entries.push({ index: 99, answer: "reported" });
  });
  assert.throws(
    () => accept(state, work, PHASES, REGISTRY),
    /99 is not one of the entries/
  );

  mangle((d) => {
    d.entries.forEach((e) => (e.answer = "reported"));
    d.entries.pop();
  });
  assert.throws(
    () => accept(state, work, PHASES, REGISTRY),
    /missing from the file/
  );

  mangle((d) => d.entries.forEach((e) => (e.answer = "cleared")));
  assert.throws(
    () => accept(state, work, PHASES, REGISTRY),
    /this entry does not accept \(expected one of: reported, withdrawn\)/
  );

  assert.equal(
    JSON.stringify(state),
    before,
    "a refusal leaves the review untouched"
  );
});

// An entry handed back twice is refused, even where every entry is answered: otherwise the
// later copy silently decides the item, whichever of the two the agent meant.
test("an entry handed back twice is refused, and changes nothing", () => {
  const { state, work } = review(tmp(), { sweep: false });
  state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  state.issued = ["spawn"];
  assert.equal(issue(state, work, PHASES, REGISTRY).phase.name, "verify");
  const before = JSON.stringify(state);
  const doc = JSON.parse(fs.readFileSync(reviewFileOf(work), "utf8"));
  doc.entries.forEach((e) => (e.answer = "reported"));
  doc.entries.push({ ...doc.entries[0], answer: "withdrawn" });
  fs.writeFileSync(reviewFileOf(work), JSON.stringify(doc, null, 1));
  assert.throws(() => accept(state, work, PHASES, REGISTRY), /appears twice/);
  assert.equal(JSON.stringify(state), before);
});

// A phase that asks a person takes their words, and an empty answer or one that is not
// text is none. Taken anyway, an empty one breaks the review only once it is settled, and
// anything else is reported as a note the reviewer never wrote.
test("a person's answer that is empty or not text is refused at the hand-back", () => {
  const { state, work } = review(tmp(), {
    sweep: false,
    findings: false,
    code: false,
  });
  state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  state.issued = ["spawn"];
  assert.equal(issue(state, work, PHASES, REGISTRY).phase.name, "ask");
  const before = JSON.stringify(state);
  for (const said of ["", { label: "Clear" }, 1]) {
    handBack(work, () => said);
    assert.throws(
      () => accept(state, work, PHASES, REGISTRY),
      /answers with nothing a reviewer said/,
      JSON.stringify(said)
    );
  }
  assert.equal(JSON.stringify(state), before);
});

// The sweep asks nothing of the file every other phase uses: its work is starting the
// agents, and each of those answers in a file of its own. So what goes out is empty, and
// what makes the review whole is the answers files - where an empty list is a real answer
// and a null is not, which is the distinction a sweep quietly skipped would otherwise hide.
test("the sweep phase asks for nothing in the review file, and answers in its own", () => {
  const dir = tmp();
  const { state, work } = review(dir);
  const out = issue(state, work, PHASES, REGISTRY);
  assert.equal(out.phase.name, "spawn");
  assert.deepEqual(out.entries, [], "nothing to fill in here");
  // It does hand over the steps that start the agents - a phase with no entries is
  // still issued when it has work.
  assert.ok(out.steps.length > 0);

  // Nothing written yet: the pass cannot be accepted, and the refusal names the file the
  // agent has to go and produce rather than anything in the hand-back.
  handBack(work, () => null);
  assert.throws(
    () => accept(state, work, PHASES, REGISTRY),
    /sweep-xpi\.answers\.json could not be read/
  );

  // A null left behind is not an answer, and is refused by the label it belongs to.
  const before = JSON.stringify(state);
  fs.writeFileSync(
    state.paths.sweeps[ARTIFACT_XPI].answers,
    JSON.stringify({ answers: { 1: [], 2: null } })
  );
  assert.throws(
    () => accept(state, work, PHASES, REGISTRY),
    /leaves label 2 unanswered/
  );
  assert.equal(JSON.stringify(state), before, "a refusal changes nothing");

  swept(state, ARTIFACT_XPI);
  accept(state, work, PHASES, REGISTRY);
  assert.deepEqual(state.sweep, [], "both ran, neither found anything");
});

// The sweep request travels INLINE: the step that spawns the agent prints the whole of it -
// the tree to read and each sweep's instruction under its label - and names the file the
// agent's reply is written to. No request file exists for it to name.
test("the spawn step hands the sweep request over inline and names the answers file", () => {
  const dir = tmp();
  const { state, work } = review(dir, { findings: false, questions: false });
  state.paths.sweeps = sweepRequests(workPaths(work), state.preSweep, {
    [ARTIFACT_XPI]: state.paths.xpiRoot,
  });
  const out = issue(state, work, PHASES, REGISTRY);
  assert.equal(out.phase.name, "spawn");
  const text = loopPromptLines(
    REGISTRY.llmPhases(),
    out.phase,
    out.steps,
    loopSlots(state, out, work, REGISTRY)
  ).join("\n");
  const step = text.slice(text.indexOf("to sweep the built add-on"));
  assert.match(step, /^\s+\/tmp\/work\/xpi\/$/m, "the folder to read");
  assert.match(step, /Label 1: t1\n\s+i1\n/, "each label with its instruction");
  assert.match(step, /Label 2: t2\n\s+i2\n/);
  assert.match(
    step,
    /write its reply unchanged, exactly as it returned it, to\n\n\s+\S+\/\.review\/sweep-xpi\.answers\.json\n/,
    "the answers file the reply is written to"
  );
  assert.doesNotMatch(text, /\.yaml/, "no request file is named");
});

// The description request names the extracted XPI, as the sweep's does: a sub-agent
// handed only "this add-on" has to guess which one, and a folder of reviews holds many.
test("the spawn step tells the description agent which folder to describe", () => {
  const dir = tmp();
  const { state, work } = review(dir, { findings: false, questions: false });
  const out = issue(state, work, PHASES, REGISTRY);
  assert.equal(out.phase.name, "spawn");
  const text = loopPromptLines(
    REGISTRY.llmPhases(),
    out.phase,
    out.steps,
    loopSlots(state, out, work, REGISTRY)
  ).join("\n");
  const request = text.slice(
    text.indexOf("Describe the add-on"),
    text.indexOf("Do not wait for it")
  );
  assert.ok(request.includes("read nothing outside"), request);
  assert.ok(request.includes(state.paths.xpiRoot), request);
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
  const { state, work } = review(dir, {
    findings: false,
    questions: false,
  });
  // Both trees exist for this one, so the review is a source-code review.
  state.paths.scaRoot = path.join(dir, "src");
  state.paths.sweeps[ARTIFACT_SCA] = {
    request: "Sweep the source.",
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

  const out = issue(state, work, PHASES, REGISTRY);
  assert.equal(out.phase.name, "spawn");
  // Two steps, one per tree, each starting an agent of its own.
  assert.equal(out.steps.filter((x) => /sweep/i.test(x.text)).length, 2);

  // Answered independently, at the SAME relative path in each tree.
  const hit = (tree) => [
    { file: "lib/net.js", line: 7, hint: `sends from the ${tree}` },
  ];
  swept(state, ARTIFACT_XPI, { 1: hit(ARTIFACT_XPI) });
  swept(state, ARTIFACT_SCA, { 2: hit(ARTIFACT_SCA) });
  handBack(work, () => null);
  accept(state, work, PHASES, REGISTRY);

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
  const { state, work } = review(dir, { sweep: false });
  issue(state, work, PHASES, REGISTRY);
  fs.rmSync(reviewFileOf(work));
  try {
    accept(state, work, PHASES);
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
  const { state, work } = review(dir, { sweep: false });
  state.run = { skip: ["llm-skip-manual"], sca: false, sweep: false };
  const seen = [];
  for (let pass = 0; pass < 8; pass++) {
    const out = issue(state, work, PHASES, REGISTRY);
    if (out.phase.answer === "end") break;
    seen.push(out.phase.name);
    handBack(work, () =>
      out.phase.name === "verify" ? "reported" : "cleared"
    );
    accept(state, work, PHASES, REGISTRY);
  }
  assert.ok(!seen.includes("ask"), `ask was issued: ${seen.join(", ")}`);
  // The two findings and the code-review case were settled; NEITHER question was. They
  // stay open, which is what puts them in the report rather than in a verdict.
  assert.deepEqual(Object.keys(state.answers).sort(), ["0.1", "0.2", CASE]);
});

// The same phase, reached the other way: nothing produced an ask verdict and there are no
// standard questions, so there is nothing to ask and the review goes straight to the
// report. Driven by the REVIEW having no questions, not by a flag emptying it.
test("no questions at all: the ask phase is not issued either", () => {
  const dir = tmp();
  const { state, work } = review(dir, { sweep: false });
  state.manual = state.manual.filter((m) => m.extended);
  state.run = { skip: [], sca: false, sweep: false };
  const seen = [];
  for (let pass = 0; pass < 8; pass++) {
    const out = issue(state, work, PHASES, REGISTRY);
    if (out.phase.answer === "end") break;
    seen.push(out.phase.name);
    handBack(work, () =>
      out.phase.name === "verify" ? "reported" : "cleared"
    );
    accept(state, work, PHASES, REGISTRY);
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
  const { state, work } = review(dir);
  assert.ok(state.preSweep, "the instructions are still there");
  // What the flag does in the pipeline: no request is written, so no condition names one
  // and there is no answers file for the pass to read.
  state.run = { skip: [], sca: false };
  delete state.paths.sweeps;
  const first = issue(state, work, PHASES, REGISTRY);
  assert.deepEqual(first.entries, [], "no rows to fill in");
  const prose = first.steps.map((s) => s.text).join("\n");
  assert.doesNotMatch(prose, /sweep/i, "and no step mentions one");
  assert.equal(state.sweep, null, "nothing was swept");

  // And the empty file IS the right hand-back. Both legs read the same fact, so the pass
  // that asked for nothing accepts nothing.
  handBack(work, () => null);
  const { answers } = accept(state, work, PHASES, REGISTRY);
  assert.equal(answers.size, 0);
  // Null, not an empty list: no tree was asked, which is not every tree answering with
  // nothing - the same distinction the answers files themselves are built around.
  assert.equal(state.sweep, null, "and still nothing was swept");
  assert.ok(issue(state, work, PHASES, REGISTRY), "the review goes on");
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
function phasesOf(state, work) {
  const seen = [];
  for (let pass = 0; pass < 10; pass++) {
    const out = issue(state, work, PHASES, REGISTRY);
    if (out.phase.answer === "end") break;
    seen.push(out.phase.name);
    // Whatever trees this run asked about, answered clean - the sweeping agents' part of
    // the pass, without which it cannot be accepted.
    for (const artifact of Object.keys(state.paths.sweeps ?? {})) {
      swept(state, artifact);
    }
    handBack(work, (e) =>
      out.phase.name === "verify"
        ? "reported"
        : out.phase.name === "settle"
          ? "cleared"
          : "Clear"
    );
    accept(state, work, PHASES, REGISTRY);
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
    // `ask` hands over the block only where a question is open: with none, the closing
    // hand-over is the one that carries it.
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
    const { state, work } = review(dir, { ...holds, sweep: true });
    assert.deepEqual(
      phasesOf(state, work).seen,
      expected,
      JSON.stringify(holds)
    );
  }
});

// Every combination of the three skips, over a review that holds something for every
// phase - so what drops out is the FLAG's doing and nothing else.
//
//   llm-skip-summary -> the description agent, and the link that hands it over
//   llm-skip-manual  -> `ask`, its details block and its questions: the entries as well
//                       as the step that asks them
//   llm-skip-sweep   -> the sweep agent, the wait, and the rows it would have filled
test("every combination of the skips issues exactly the phases it should", () => {
  const SKIPS = ["llm-skip-summary", "llm-skip-manual", "llm-skip-sweep"];
  for (let bits = 0; bits < 8; bits++) {
    const skip = SKIPS.filter((_, i) => bits & (1 << i));
    const sweeps = !skip.includes("llm-skip-sweep");
    const dir = tmp();
    const { state, work } = review(dir, { sweep: sweeps });
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
    // `spawn` runs only where it starts an agent (the linter extracts the package before
    // the review is printed), so a run that skips the summary agent and does not sweep
    // has nothing left to spawn.
    const expected = [
      ...(!skip.includes("llm-skip-summary") || sweeps ? ["spawn"] : []),
      "verify",
      "settle",
      // An XPI review asks nothing else, so --llm-skip-manual leaves no question for the
      // details block to serve and no entry for `ask`.
      ...(skip.includes("llm-skip-manual") ? [] : ["ask"]),
    ];
    const { seen, details } = phasesOf(state, work);
    const where = `skips: ${skip.join(",") || "none"}`;
    assert.deepEqual(seen, expected, where);

    // The block ends EVERY settled review, whether or not `ask` showed the same
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
  const { state, work } = review(dir, { sweep: false, findings: false });
  // Nothing for spawn to start either, so `settle` is the phase in flight.
  state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  // spawn has nothing to start in this config and is never issued - marked done here
  // anyway, so this test starts where it means to.
  state.issued = ["spawn"];
  assert.equal(issue(state, work, PHASES, REGISTRY).phase.name, "settle");
  handBack(work, () => "ask");
  accept(state, work, PHASES, REGISTRY);

  const out = issue(state, work, PHASES, REGISTRY);
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
  const { state, work } = review(dir, { sweep: false, findings: false });
  state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  // Marked done so this test starts where it means to - spawn has nothing to start here
  // anyway.
  state.issued = ["spawn"];

  const sent = issue(state, work, PHASES, REGISTRY);
  assert.equal(sent.phase.name, "settle");
  // The case the agent gives up on, by the reference it keeps.
  const moved = sent.entries[0].index;
  handBack(work, () => "ask");
  accept(state, work, PHASES, REGISTRY);

  const out = issue(state, work, PHASES, REGISTRY);
  assert.equal(out.phase.name, "ask");
  assert.ok(
    out.entries.some((e) => e.index === moved),
    "the moved case is asked under the reference the agent saw"
  );
  const [clear, report] = REGISTRY.manualReviewChoices().map((c) => c.label);
  handBack(work, (e) => (e.index === moved ? report : clear));
  accept(state, work, PHASES, REGISTRY);

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
  const { state, work } = review(dir, {
    sweep: false,
    findings: false,
    code: false,
  });
  state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  // Marked done so this test starts where it means to - spawn has nothing to start here
  // anyway.
  state.issued = ["spawn"];
  // Real check ids, because a reported case becomes a finding of its own check and takes
  // the severity that check declares.
  state.manual.forEach((m, i) => {
    m.ruleId = ["testing-information", "no-surprises-policy"][i];
  });

  const out = issue(state, work, PHASES, REGISTRY);
  assert.equal(out.phase.name, "ask");
  handBack(work, () => "ask");
  accept(state, work, PHASES, REGISTRY);

  assert.deepEqual(state.route, {}, "nobody was moved");
  assert.deepEqual(
    state.answers,
    { 0.1: "ask", 0.2: "ask" },
    "both were answered"
  );
  assert.equal(
    issue(state, work, PHASES, REGISTRY).phase.name,
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
 * @param {object} state @param {string} work
 * @param {(phase: string) => string} answer
 * @returns {{seen: string[], settled: object}}
 */
/** How a source review's build opening is answered where a test does not say otherwise:
 *  the agent judges the build safe, and the source builds and reproduces the XPI. */
const BUILDS = {
  "build-safety": "safe",
  built: "Builds and reproduces",
};

function driveLoop(state, work, answer, reg = REGISTRY) {
  const seen = [];
  // `ask` takes a REVIEWER's answer, not a verb: the phase that asks declares none, and
  // handing it one would be refused where it is applied rather than where it is taken.
  const [clear] = REGISTRY.manualReviewChoices().map((c) => c.label);
  let closing = null;
  for (let pass = 0; pass < 8; pass++) {
    const out = issue(state, work, PHASES, reg);
    if (out.phase.answer === "end") {
      closing = out;
      break;
    }
    seen.push(out.phase.name);
    handBack(work, () =>
      out.phase.name === "ask"
        ? clear
        : (BUILDS[out.phase.name] ?? answer(out.phase.name))
    );
    accept(state, work, PHASES, reg);
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
// reproduce a build the review has already rejected. A review the deterministic checks
// aborted asks nothing at all: what it hands over is decided before any pass, so its first
// prompt is the closing one - no preamble, no agent started, nothing verified or settled -
// and it names no file an agent was never asked to write.
test("a blocking finding closes the review on its first prompt", () => {
  const dir = tmp();
  const { state, work } = blockingReview(dir);
  state.report.meta.summaryFile = path.join(dir, "summary.md");
  state.report.meta.buildFile = path.join(dir, "build.md");
  const first = issue(state, work, PHASES, REGISTRY);
  assert.equal(first.phase.name, "close");
  assert.deepEqual(first.preamble, []);
  assert.match(first.steps[0].text, /^The review was aborted/);
  assert.ok(
    !first.steps.some((step) => /Wait for every agent/.test(step.text)),
    "no agent was started to wait for"
  );
  assert.equal(first.settled.earlyExit, true);
  assert.deepEqual(first.settled.review.meta.manualReview, []);
  assert.match(first.settled.tally, /0 extended code review item\(s\)/);
  assert.doesNotMatch(first.settled.details, /summary\.md|build\.md/);
  assert.match(first.settled.details, /- Known security vulnerabilities$/);
});

// The Review Details block goes out in `ask`, before its questions - and only where they
// are put: not in an aborted review, and not under --llm-skip-manual, whatever the review.
// A source review's build question comes first, with its own block.
test("the details block is handed over by the ask phase, before its questions", () => {
  const blocks = (made) => {
    const shown = [];
    for (let pass = 0; pass < 10; pass++) {
      const out = issue(made.state, made.work, PHASES, REGISTRY);
      if (out.phase.answer === "end") {
        break;
      }
      if (out.steps.some((step) => step.text.includes("{{details}}"))) {
        shown.push(out.phase.name);
      }
      handBack(made.work, () => {
        if (BUILDS[out.phase.name]) return BUILDS[out.phase.name];
        if (out.phase.name === "verify") return "withdrawn";
        return out.phase.name === "settle" ? "cleared" : "Clear";
      });
      accept(made.state, made.work, PHASES, REGISTRY);
    }
    return shown;
  };
  assert.deepEqual(blocks(review(tmp(), { sweep: false })), ["ask"]);

  const skipped = review(tmp(), { sweep: false });
  skipped.state.run.skip = ["llm-skip-manual"];
  assert.deepEqual(blocks(skipped), []);

  const source = buildQuestionsReview(tmp());
  source.state.run.skip = ["llm-skip-manual"];
  assert.deepEqual(blocks(source), []);

  const aborted = blockingReview(tmp());
  const shown = [];
  for (let pass = 0; pass < 10; pass++) {
    const out = issue(aborted.state, aborted.work, PHASES, REGISTRY);
    if (out.phase.answer === "end") {
      break;
    }
    shown.push(out.phase.name);
    handBack(aborted.work, () =>
      out.phase.name === "verify" ? "reported" : "cleared"
    );
    accept(aborted.state, aborted.work, PHASES, REGISTRY);
  }
  assert.ok(!shown.includes("ask"), shown.join(", "));
});

// The review ends with the closing phase, which carries the settled review and opens on
// what happened to it: settled, or aborted. Nothing is handed back after it.
test("the closing phase opens on how the review ended, and takes nothing back", () => {
  // The same review, its findings reported by checks that abort nothing.
  const ran = review(tmp(), { sweep: false });
  ran.state.run = { skip: [], sca: true, sweep: false };
  const { closing: settledClose } = driveLoop(ran.state, ran.work, (phase) =>
    phase === "verify" ? "reported" : "cleared"
  );
  assert.match(settledClose.steps[0].text, /^The review is settled\./);
  assert.equal(settledClose.settled.earlyExit, false);
  assert.throws(
    () => accept(ran.state, ran.work, PHASES, REGISTRY),
    /nothing is handed back after its closing prompt/
  );

  const aborted = blockingReview(tmp());
  const { closing: abortedClose } = driveLoop(
    aborted.state,
    aborted.work,
    (phase) => (phase === "verify" ? "reported" : "cleared")
  );
  assert.match(abortedClose.steps[0].text, /^The review was aborted/);
  assert.equal(abortedClose.settled.earlyExit, true);
  // The same body either way: the abort rides in the details block.
  const handover = (close) =>
    close.steps.find((step) => /^Give the reviewer/.test(step.text)).text;
  assert.equal(handover(abortedClose), handover(settledClose));
  assert.match(
    abortedClose.settled.details,
    /- Known security vulnerabilities$/
  );
});

// A review with nothing to do at all still closes: its first pass is the closing one.
test("a review with no other work is closed on its first pass", () => {
  const { state, work } = review(tmp(), {
    sweep: false,
    findings: false,
    code: false,
    questions: false,
  });
  state.run = { skip: ["llm-skip-summary", "llm-skip-manual"], sca: false };
  const out = issue(state, work, PHASES, REGISTRY);
  assert.equal(out.phase.name, "close");
  assert.ok(out.settled, "it carries the settled review");
});

// Whether the review was aborted is a fact about the review, so the hand-over carries it
// too - not just the developer's text. It rides in the details block, because only the
// block can list the reasons that aborted THIS review.
test("an aborted review closes its details block with the reason", () => {
  const dir = tmp();
  const { state, work } = blockingReview(dir);
  const { settled } = driveLoop(state, work, (phase) =>
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
  const clean = review(tmp(), { sweep: false });
  const ran = driveLoop(clean.state, clean.work, (phase) =>
    phase === "verify" ? "reported" : "cleared"
  );
  assert.doesNotMatch(ran.settled.details, /review was not completed/);
  assert.match(
    ran.settled.details,
    /^schema /m,
    "and ends where it always did"
  );
});

// What an aborted review hands the reviewer: the closing line in the developer's text, and
// no to-do item - neither the questions nobody was asked nor the code-review cases nobody
// settled - so the tally does not advertise work nobody was asked to do.
test("an aborted review hands over the reason and drops the questions", () => {
  const dir = tmp();
  const { state, work } = blockingReview(dir);
  const {
    settled: { report, tally, review: settled },
  } = driveLoop(state, work, (phase) =>
    phase === "verify" ? "reported" : "cleared"
  );
  assert.match(report, /The review was not completed/);
  assert.match(report, /- Known security vulnerabilities/);
  assert.match(tally, /0 extended manual review item\(s\)/);
  assert.match(tally, /0 standard manual review item\(s\)/);
  assert.match(tally, /0 extended code review item\(s\)/);
  assert.deepEqual(settled.meta.manualReview, []);
});

/** The small review, with its findings reported by a check that aborts the review late. */
function lateReview(dir) {
  const made = review(dir, { sweep: false });
  for (const f of made.state.report.findings) {
    f.ruleId = "minified-code";
  }
  made.state.run = { skip: [], sca: false };
  return made;
}

// A late abort lets the review run to the end of `settle`: the agent is started, the
// findings verified and the cases settled. Then nothing is put to the reviewer, and the
// close ends the aborted review with the reason.
test("a late-exit finding skips ask and closes the review aborted", () => {
  const { state, work } = lateReview(tmp());
  const { seen, closing } = driveLoop(state, work, (phase) =>
    phase === "verify" ? "reported" : "cleared"
  );
  assert.deepEqual(seen, ["spawn", "verify", "settle"]);
  assert.equal(closing.phase.name, "close");
  assert.equal(closing.settled.earlyExit, true);
  assert.equal(
    closing.settled.details.split("\n").at(-1),
    "- Code that cannot be reviewed"
  );
  assert.deepEqual(closing.settled.review.meta.manualReview, []);
});

// Verify runs before a late abort is decided, so a finding it withdrew aborts nothing: the
// questions are asked, and the review closes settled.
test("a late-exit finding verify withdrew aborts nothing", () => {
  assert.equal(REGISTRY.lateExitFor("minified-code"), "unreviewable-code");
  const { state, work } = lateReview(tmp());
  const { seen, closing } = driveLoop(state, work, (phase) =>
    phase === "verify" ? "withdrawn" : "cleared"
  );
  assert.deepEqual(seen, ["spawn", "verify", "settle", "ask"]);
  assert.equal(closing.settled.earlyExit, false);
});

/** The small review as a source code review whose build checks all ran: the build
 *  phases' paths named, as the pipeline names them for one. */
function buildReview(dir) {
  const made = review(dir, { sweep: false });
  made.state.run = { skip: [], sca: true, "build-guarded": true };
  made.state.paths.build = path.join(dir, "build.md");
  made.state.report.meta.buildFile = made.state.paths.build;
  made.state.paths.scaRoot = path.join(dir, "sca");
  return made;
}

/**
 * The source review above, carrying the two build items every source review raises, as the
 * pipeline renders them: undeclared-build-source for the agent to settle, and the build
 * question, naming the phase it is asked in (`asked-in`).
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
    todo("build-reproduces-xpi", { section: "manual-review" })
  );
  refed(made.state);
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
    const out = issue(made.state, made.work, PHASES, REGISTRY);
    if (out.phase.answer === "end") {
      closing = out;
      break;
    }
    seen.push(out.phase.name);
    handed[out.phase.name] = out.entries.map(
      (e) => ruleAt(made, e.index) ?? e.index
    );
    handBack(made.work, (e) => answer(out.phase.name, e));
    accept(made.state, made.work, PHASES, REGISTRY);
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
    BUILDS[phase] ??
    (phase === "verify"
      ? "withdrawn"
      : phase === "settle"
        ? "cleared"
        : "Clear");

/** The reference of the build to-do in this review. */
function buildTodoRef(made) {
  return orderReview(made.state.report.findings, made.state.manual).find(
    (x) => x.target.ruleId === "build-reproduces-xpi"
  ).ref;
}

/** The rule behind one reference in this review. */
function ruleAt(made, ref) {
  return orderReview(made.state.report.findings, made.state.manual).find(
    (x) => x.ref === ref
  )?.target?.ruleId;
}

// A source review opens with its build: the agent judges it where nothing was judged yet,
// the reviewer reads the Build Review Details, and the build question follows in a phase of
// its own so it is put to the reviewer ALONE - all before the sweeps and the verify and
// settle passes. "Builds and reproduces" clears the build to-do and lets the review go on.
test("a source review opens with the build, and its questions come before the sweeps", () => {
  const made = buildQuestionsReview(tmp());
  const todo = buildTodoRef(made);
  const { seen, handed, settled } = driveBuild(made, goesOn());
  assert.deepEqual(seen, [
    "build-safety",
    "built",
    "spawn",
    "verify",
    "settle",
    "ask",
  ]);
  assert.deepEqual(made.state.values, {
    "build-safety": "safe",
    built: "reproduces",
  });
  assert.ok(
    !Object.values(made.state.answers).includes("safe"),
    "a process value is not an answer"
  );
  assert.deepEqual(handed.built, ["built"]);
  assert.equal(made.state.answers[todo], "cleared", "its to-do is cleared");
  const asked = handed.ask;
  assert.ok(!asked.includes("build-reproduces-xpi"), asked.join(", "));
  assert.ok(
    handed.settle.includes("undeclared-build-source"),
    "the agent settles the build sources"
  );
  assert.equal(settled.earlyExit, false);
});

// The build is one question: whether the source builds into the submitted XPI. It is the
// single entry of `built`, worded by the build to-do as a words phase words it, and no
// other phase asks about the build's result.
test("the build question is the single entry of its own phase", () => {
  assert.deepEqual(
    PHASES.map((p) => p.name).filter(
      (n) => n.startsWith("built") || n === "reproduced"
    ),
    ["built"]
  );
  const made = buildQuestionsReview(tmp());
  const entries = {};
  for (let pass = 0; pass < 12; pass++) {
    const out = issue(made.state, made.work, PHASES, REGISTRY);
    if (out.phase.answer === "end") {
      break;
    }
    entries[out.phase.name] = out.entries.map((e) => ruleAt(made, e.index));
    if (out.phase.name === "built") {
      assert.deepEqual(
        out.entries.map((e) => [e.index, e.message]),
        [["built", "[build-reproduces-xpi] build-reproduces-xpi?"]],
        "the to-do's message is the question"
      );
    }
    handBack(made.work, (e) => goesOn()(out.phase.name, e));
    accept(made.state, made.work, PHASES, REGISTRY);
  }
  assert.ok("built" in entries, "the build question was issued");
  for (const [phase, rules] of Object.entries(entries)) {
    if (phase !== "built") {
      assert.ok(!rules.includes("build-reproduces-xpi"), phase);
    }
  }
});

// Each answer but "Builds and reproduces" aborts the review there for build issues: its
// own check is the one build finding, carrying that check's response, the build to-do is
// cleared rather than reported beside it, the questions still pending are never put, and
// the report ends on why. Words a reviewer typed instead of a label are refused.
test("each build answer that stops the review reports its own check", () => {
  for (const [said, rule] of [
    ["Does not reproduce", "build-not-reproduced"],
    ["Does not build", "build-fails"],
    ["Is unsafe to build", "build-unsafe"],
  ]) {
    const made = buildQuestionsReview(tmp());
    const { seen, closing, settled } = driveBuild(
      made,
      goesOn({ built: () => said })
    );
    for (const later of ["spawn", "ask"]) {
      assert.ok(!seen.includes(later), `${said}: ${seen.join(", ")}`);
    }
    assert.equal(settled.earlyExit, true, said);
    assert.match(closing.steps[0].text, /^The review was aborted/);
    assert.match(settled.report, /- Build process issues/);
    assert.deepEqual(
      settled.review.findings
        .map((f) => f.ruleId)
        .filter((id) => id.startsWith("build-")),
      [rule],
      said
    );
    assert.ok(
      settled.report.includes(
        REGISTRY.checkEntry(rule).response.split("\n")[0]
      ),
      `${said}: its own response`
    );
    assert.deepEqual(
      settled.review.meta.manualReview
        .map((m) => m.ruleId)
        .filter((id) => id.startsWith("build-")),
      [],
      "no build question is left listed"
    );
  }

  const made = buildQuestionsReview(tmp());
  for (let pass = 0; pass < 4; pass++) {
    const out = issue(made.state, made.work, PHASES, REGISTRY);
    if (out.phase.name === "built") {
      handBack(made.work, () => "npm run build fails");
      assert.throws(
        () => accept(made.state, made.work, PHASES, REGISTRY),
        /answers "npm run build fails", which this entry does not accept/
      );
      return;
    }
    handBack(made.work, () => BUILDS[out.phase.name]);
    accept(made.state, made.work, PHASES, REGISTRY);
  }
  throw new Error("the build question was never issued");
});

// The build question is a process value put while the build to-do is open. A review whose
// build check did not run holds no such to-do, so the question has nothing to put and is
// not issued, and the review goes on without the value.
test("the build question is issued only while its to-do is open", () => {
  const asked = buildQuestionsReview(tmp());
  const ran = driveBuild(asked, goesOn());
  assert.ok(ran.seen.includes("built"), ran.seen.join(", "));
  assert.equal(asked.state.values.built, "reproduces");

  const made = buildQuestionsReview(tmp());
  made.state.manual = made.state.manual.filter(
    (m) => m.ruleId !== "build-reproduces-xpi"
  );
  const { seen } = driveBuild(made, goesOn());
  assert.ok(!seen.includes("built"), seen.join(", "));
  assert.ok(seen.includes("spawn"), seen.join(", "));
  assert.equal(made.state.values.built, undefined);
});

// undeclared-build-source is still settled in `settle`, after the build, and reported there
// it still aborts the review.
test("undeclared build sources reported in settle abort the review", () => {
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
  assert.deepEqual(seen.slice(-3), ["spawn", "verify", "settle"]);
  assert.equal(settled.earlyExit, true);
  assert.ok(
    settled.review.findings.some((f) => f.ruleId === "undeclared-build-source")
  );
});

// --llm-skip-manual withholds the questions in `ask`, not the build question: it decides
// whether the review goes on at all.
test("--llm-skip-manual still asks the build question", () => {
  const made = buildQuestionsReview(tmp());
  made.state.run.skip = ["llm-skip-manual"];
  const { seen } = driveBuild(made, goesOn());
  assert.ok(seen.includes("built"), seen.join(", "));
  assert.ok(!seen.includes("ask"), seen.join(", "));
});

// A case is routed by what it IS, not by its number: a sweep that files cases ahead of the
// build question renumbers the review, and the question still opens in its own phase.
test("a renumbered review still asks the build question in its own phase", () => {
  const made = buildQuestionsReview(tmp());
  // Two cases filed ahead of everything, the way a sweep's escalations land in code review.
  made.state.manual.unshift(
    {
      ...made.state.manual[0],
      ruleId: "privacy-policy",
      instructions: "a",
      ref: null,
    },
    {
      ...made.state.manual[0],
      ruleId: "privacy-policy",
      instructions: "b",
      ref: null,
    }
  );
  refed(made.state);
  const todo = buildTodoRef(made);
  const { handed } = driveBuild(made, goesOn());
  assert.deepEqual(handed.built, ["built"]);
  assert.equal(made.state.answers[todo], "cleared");
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
    ref: null,
  });
  refed(made.state);
  const { settled } = driveBuild(
    made,
    goesOn({
      settle: (e) => {
        const instr = made.state.manual.find(
          (m) =>
            orderReview(made.state.report.findings, made.state.manual).find(
              (x) => x.ref === e.index
            )?.target === m
        )?.instructions;
        return instr === "settle me" ? "ask" : "cleared";
      },
      built: () => "Does not build",
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
    const out = issue(made.state, made.work, PHASES, REGISTRY);
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
    handBack(
      made.work,
      () =>
        BUILDS[out.phase.name] ??
        (out.phase.name === "verify"
          ? "withdrawn"
          : out.phase.name === "settle"
            ? "cleared"
            : "Clear")
    );
    accept(made.state, made.work, PHASES, REGISTRY);
  }
  return prompts;
}

const WAIT = "Wait for every agent you spawned to come back.";

// A review whose first prompt is already the closing one ran nothing before it, so that
// prompt says nothing about passes, agents or decisions: no preamble, no "settled", no
// wait, no "LLM decisions" - just what to give the reviewer.
test("a one-pass review's only prompt says only what applies", () => {
  const { state, work } = review(tmp(), {
    sweep: false,
    findings: false,
    code: false,
    questions: false,
  });
  state.run = { skip: ["llm-skip-summary", "llm-skip-manual"], sca: false };
  const prompts = promptsOf({ state, work });
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
  // A source review's build question comes before any agent is started, so it does not
  // wait; the details block of `ask`, after the description agent started, does.
  const source = promptsOf(buildQuestionsReview(tmp()));
  assert.ok(!source.built.steps.includes(WAIT), source.built.steps.join(", "));
  assert.deepEqual(source.ask.steps[0], WAIT);
  assert.match(source.ask.steps[1], /^Give the reviewer this block/);

  // An XPI review that started a sweep waits before the details block, and never builds.
  const swept = promptsOf(review(tmp()));
  assert.equal(swept.ask.steps[0], WAIT);
  assert.ok(!("build" in swept), "no build phase made of a wait alone");

  // An XPI review that started nothing does not wait.
  const quiet = review(tmp(), { sweep: false });
  quiet.state.run = { skip: ["llm-skip-summary"], sca: false };
  const prompts = promptsOf(quiet);
  assert.ok(!("spawn" in prompts));
  assert.deepEqual(prompts.ask.steps.length, 2);
  assert.match(prompts.ask.steps[0], /^Give the reviewer this block/);

  // An XPI review under --llm-skip-manual asks nothing, so no ask phase made of a wait.
  const skipped = review(tmp());
  skipped.state.run.skip = ["llm-skip-manual"];
  assert.ok(!("ask" in promptsOf(skipped)));
});

// With one of the checks a build relies on switched off, nothing vouches for what an install
// pulls in: the review builds nothing itself, and opens at the build question.
test("a review whose build checks did not all run opens at the build question", () => {
  const made = buildQuestionsReview(tmp());
  delete made.state.run["build-guarded"];
  const { seen } = driveBuild(made, goesOn());
  assert.deepEqual(seen.slice(0, 2), ["built", "spawn"]);
  assert.ok(!seen.includes("build"), seen.join(", "));
});

// The review builds nothing itself, whatever the judgement: the Build Review Details and the
// build question follow it at once, and no other phase asks about the build.
test("a review asks only the build question after its judgement, and builds nothing", () => {
  for (const safety of ["safe", "unsafe"]) {
    const made = buildQuestionsReview(tmp());
    const { seen } = driveBuild(made, goesOn({ "build-safety": () => safety }));
    assert.deepEqual(seen.slice(0, 3), ["build-safety", "built", "spawn"]);
  }
});

// A prepared review starts with the judgement its preparation recorded, so the review asks
// for none of its own: `build-safety` is not issued, and the review opens on the build
// question, whose first step is the Build Review Details.
test("a review holding a recorded judgement does not ask for one", () => {
  for (const safety of ["safe", "unsafe"]) {
    const made = buildQuestionsReview(tmp());
    made.state.values = { "build-safety": safety };
    const { seen } = driveBuild(made, goesOn());
    assert.deepEqual(seen.slice(0, 2), ["built", "spawn"]);
    assert.ok(!seen.includes("build-safety"), seen.join(", "));
  }
});

// The build question's step after the Build Review Details says who built the add-on, by
// what came of the build: the agent built it, its build failed, it was judged unsafe, or the
// reviewer builds it. Exactly one of the four prints.
test("the build question's step text is worded by what came of the build", () => {
  const wordedStep = (build, safety) => {
    const made = buildQuestionsReview(tmp());
    made.state.build = build;
    made.state.values = { "build-safety": safety };
    for (let pass = 0; pass < 4; pass++) {
      const out = issue(made.state, made.work, PHASES, REGISTRY);
      if (out.phase.name === "built") {
        assert.equal(
          out.steps.length,
          3,
          "the block, one worded step and the question"
        );
        return out.steps[1].text;
      }
      handBack(made.work, () => BUILDS[out.phase.name]);
      accept(made.state, made.work, PHASES, REGISTRY);
    }
    throw new Error("the build question was never issued");
  };
  for (const [build, safety, opening] of [
    [
      { result: "built", output: "/w/build/dist" },
      "safe",
      "The agent built the add-on: BUILD_OUTPUT",
    ],
    [{ result: "failed", output: null }, "safe", "The agent's build failed"],
    [
      { result: null, output: null },
      "unsafe",
      "The agent judged the build unsafe and built nothing",
    ],
    [
      { result: null, output: null },
      "safe",
      "The agent did not build the add-on",
    ],
  ]) {
    const text = wordedStep(build, safety);
    assert.ok(text.startsWith(opening), text);
  }
});

// The build question offers its own four answers, and not the manual review's: whether the
// source builds and reproduces the XPI, and if not, why.
test("the build question offers its own four answers", () => {
  const made = buildQuestionsReview(tmp());
  for (let pass = 0; pass < 4; pass++) {
    const out = issue(made.state, made.work, PHASES, REGISTRY);
    if (out.phase.name === "built") {
      assert.deepEqual(
        out.entries[0].answers.map((a) => a.label),
        [
          "Builds and reproduces",
          "Does not reproduce",
          "Does not build",
          "Is unsafe to build",
        ]
      );
      return;
    }
    handBack(made.work, () => BUILDS[out.phase.name]);
    accept(made.state, made.work, PHASES, REGISTRY);
  }
  throw new Error("the build question was never issued");
});

// The removed build phases are gone: the review has no phase that chooses who builds or
// builds.
test("the review has no build choice and no build phase", () => {
  const names = PHASES.map((p) => p.name);
  for (const gone of [
    "build-review",
    "build-choice",
    "build-choice-unsafe",
    "build",
    "build-result",
    "details",
  ]) {
    assert.ok(!names.includes(gone), gone);
  }
});

test("an XPI review never asks about a build", () => {
  const { state, work } = review(tmp(), { sweep: false });
  const { seen } = driveLoop(state, work, (phase) =>
    phase === "verify" ? "withdrawn" : "cleared"
  );
  for (const phase of ["build-safety", "built"]) {
    assert.ok(!seen.includes(phase), seen.join(", "));
  }
});

test("an aborted review never asks about a build", () => {
  const { state, work } = blockingReview(tmp());
  const { seen } = driveLoop(state, work, (phase) =>
    phase === "verify" ? "reported" : "cleared"
  );
  for (const phase of ["build-safety", "built"]) {
    assert.ok(!seen.includes(phase), seen.join(", "));
  }
});

// The Review Details link the build output where the agent built the add-on, and only
// there: a build that failed, or one nobody let the agent make, produced nothing to link.
test("the details link the build output only where the agent built the add-on", () => {
  for (const build of [
    { result: "built", output: "/w/build/dist/addon.xpi" },
    { result: "failed", output: null },
    { result: null, output: null },
  ]) {
    const { state } = buildQuestionsReview(tmp());
    state.build = build;
    const linked = `* BUILD_OUTPUT: [addon.xpi](${build.output})`;
    for (const block of [
      reviewDetails(state, REGISTRY),
      settle(state, REGISTRY).details,
    ]) {
      assert.equal(block.includes(linked), Boolean(build.output), block);
      assert.equal(block.includes("BUILD_OUTPUT"), Boolean(build.output));
    }
  }
});

// A process-value phase can have a product too: the build report is written by the phase
// that judges the build. Recorded as that phase comes back, so the blocks the reviewer
// reads before the build question link the report it rests on, and only once it exists.
test("the build report is linked once the judging phase wrote it", () => {
  for (const wrote of [true, false]) {
    const { state, work } = buildQuestionsReview(tmp());
    assert.equal(
      issue(state, work, PHASES, REGISTRY).phase.name,
      "build-safety"
    );
    if (wrote) {
      fs.writeFileSync(state.paths.build, "1. npm ci\n");
    }
    handBack(work, () => "safe");
    accept(state, work, PHASES, REGISTRY);
    const next = issue(state, work, PHASES, REGISTRY);
    assert.equal(next.phase.name, "built");
    const linked = /^\* BUILD_PROCESS: \[build\.md\]/m;
    for (const block of [
      loopSlots(state, next, work, REGISTRY).buildDetails,
      reviewDetails(state, REGISTRY),
    ]) {
      if (wrote) {
        assert.match(block, linked);
      } else {
        assert.doesNotMatch(block, /BUILD_PROCESS/);
      }
    }
  }
});

/**
 * Drive a source review to its close the way `driveBuild` does, and keep each phase's
 * steps: raw, and - for the phases that show a block or put a question to the reviewer -
 * each rendered alone into its prompt with the slots of that pass, its wrapped lines
 * joined back into one line.
 */
const REVIEWER_PHASES = ["built", "ask"];
function stepsByPhase(made, answer) {
  const issued = [];
  for (let pass = 0; pass < 12; pass++) {
    const out = issue(made.state, made.work, PHASES, REGISTRY);
    if (out.phase.answer === "end") {
      break;
    }
    const slots = loopSlots(made.state, out, made.work, REGISTRY);
    issued.push({
      name: out.phase.name,
      slots,
      steps: out.steps.map((step) => {
        const lines = REVIEWER_PHASES.includes(out.phase.name)
          ? loopPromptLines(REGISTRY.llmPhases(), out.phase, [step], slots).map(
              (line) => line.trim()
            )
          : [];
        return { raw: step.text, lines, rendered: lines.join(" ") };
      }),
    });
    handBack(made.work, (e) => answer(out.phase.name, e));
    accept(made.state, made.work, PHASES, REGISTRY);
  }
  return issued;
}

// A block the reviewer must read ends the agent's turn: text written before a tool call in
// the same turn is folded away by a client that collapses tool rows. So the block is the
// first step of the question phase that needs it, past a wait for spawned agents: the
// agent ends its turn on it and goes on to the question only once the reviewer replied.
// Nothing is handed back in between, so no pass of its own carries a block.
test("each block the reviewer reads opens its question phase and ends the turn there", () => {
  const END = "Then end your turn, and put no question to them in it";
  const ON = "Go on with the next step only once the reviewer has replied";
  const issued = stepsByPhase(buildQuestionsReview(tmp()), goesOn());
  const names = issued.map((x) => x.name);
  for (const gone of ["build-result", "details"]) {
    assert.ok(!names.includes(gone), names.join(", "));
  }
  for (const [name, slot, heading, question] of [
    [
      "built",
      "buildDetails",
      "Build review details",
      "Put the one entry in the file to the reviewer ALONE",
    ],
    ["ask", "details", "Review details", "Put every entry in the file"],
  ]) {
    const phase = issued.find((x) => x.name === name);
    assert.ok(phase, `${name} is issued: ${names.join(", ")}`);
    const block = phase.slots[slot].split("\n").map((line) => line.trim());
    assert.ok(block.length > 0 && block[0] !== "", `${name}: a block to show`);
    const at = phase.steps.findIndex((step) => step.rendered.includes(heading));
    assert.ok(
      phase.steps.slice(0, at).every((step) => step.raw === WAIT),
      `${name}: only a wait comes before the block`
    );
    const shown = phase.steps[at];
    assert.ok(
      shown.rendered.includes(END),
      `${name} ends the turn on its block`
    );
    assert.ok(shown.rendered.includes(ON), `${name} waits for the reply`);
    assert.ok(
      block.every((line) => shown.rendered.includes(line)),
      `${name} shows its whole block`
    );
    const asks = phase.steps.findIndex((step) => step.raw.startsWith(question));
    assert.ok(asks > at, `${name} puts its question after the block`);
    for (const step of phase.steps.filter((_, i) => i !== at)) {
      assert.ok(!step.raw.includes(`{{${slot}}}`), name);
      assert.ok(!step.rendered.includes(heading), name);
    }
  }
});

// The agent built the add-on and compared it in the preparation, and the review asks it only
// to put the question: the reviewer reads BUILD_MATCH beside BUILD_OUTPUT and XPI_FILE.
test("the build question tells the agent to build and compare nothing", () => {
  const made = buildQuestionsReview(tmp());
  made.state.build = { result: "built", output: "/w/build/dist" };
  const built = stepsByPhase(made, goesOn()).find((x) => x.name === "built");
  const worded = built.steps.find((step) =>
    step.raw.startsWith("The agent built the add-on")
  );
  assert.ok(worded, built.steps.map((step) => step.raw).join(" | "));
  assert.ok(
    worded.rendered.includes(
      "BUILD_MATCH is the agent's earlier comparison of it with XPI_FILE, which the reviewer reads beside both. Build nothing and compare nothing, only put the question below."
    ),
    worded.rendered
  );
  assert.ok(!worded.rendered.includes("for the reviewer to compare"));
});

// The block a turn-ending phase shows ends with the line telling the reviewer the review
// waits for them and what their reply leads to, inside the text the agent prints verbatim.
test("each turn-ending block ends with the line asking the reviewer to reply", () => {
  const WAITING = 'Reply "next" to continue the review';
  const issued = stepsByPhase(buildQuestionsReview(tmp()), goesOn());
  for (const [name, slot, line] of [
    [
      "built",
      "buildDetails",
      `${WAITING} with the question whether the source is safe to build, builds, ` +
        "and reproduces the submitted XPI.",
    ],
    [
      "ask",
      "details",
      `${WAITING} with the questions on the findings left to your judgement.`,
    ],
  ]) {
    const phase = issued.find((x) => x.name === name);
    assert.ok(phase, name);
    const block = phase.slots[slot].split("\n").map((line) => line.trim());
    assert.deepEqual(block.slice(-2), ["", line], name);
    const shown = phase.steps.find((step) => step.lines.includes(block[0]));
    assert.ok(shown, `${name} shows its block`);
    const start = shown.lines.indexOf(block[0]);
    assert.deepEqual(
      shown.lines.slice(start, start + block.length),
      block,
      `${name} shows its block followed by the waiting line`
    );
  }
  for (const phase of issued.filter(
    (x) => !["built", "ask"].includes(x.name)
  )) {
    for (const step of phase.steps) {
      assert.ok(!step.rendered.includes(WAITING), phase.name);
    }
  }
});

// The description is linked once the phase that starts its agent went back, and not
// before: a review that never started the agent has no description to read.
test("the details link the description only once spawn went out", () => {
  const { state, work } = review(tmp());
  state.report.meta.summaryFile = state.paths.description;
  assert.equal(issue(state, work, PHASES, REGISTRY).phase.name, "spawn");
  assert.doesNotMatch(reviewDetails(state, REGISTRY), /ADDON_DESCRIPTION/);
  swept(state, ARTIFACT_XPI);
  handBack(work, () => null);
  accept(state, work, PHASES, REGISTRY);
  assert.match(
    reviewDetails(state, REGISTRY),
    /^\* ADDON_DESCRIPTION: \[summary\.md\]/m
  );
});

// The closing prompt hands over the FINISHED review's tally and details, the reasons an
// abort lists among them. The block an earlier pass would build has neither.
test("the closing prompt's slots carry the settled tally and details", () => {
  const { state, work } = blockingReview(tmp());
  const out = issue(state, work, PHASES, REGISTRY);
  assert.equal(out.phase.name, "close");
  const slots = loopSlots(state, out, work, REGISTRY);
  assert.equal(slots.details, out.settled.details);
  assert.match(slots.details, /- Known security vulnerabilities$/);
  assert.equal(slots.tally, out.settled.tally);
  assert.match(slots.tally, /extended code review item/);
  // The closing ends no turn the review waits on, so its block carries no waiting line.
  const rendered = loopPromptLines(
    REGISTRY.llmPhases(),
    out.phase,
    out.steps,
    slots
  ).join("\n");
  assert.ok(rendered.includes(out.settled.details.split("\n")[0]));
  assert.ok(!rendered.includes('Reply "next" to continue the review'));
});

// The two suppressions of the `ask` phase are different facts and must stay so: the skip
// leaves the items in the report for a reviewer to work through later, the halt takes
// them out because nobody is going to.
test("a skip and a halt suppress the same phase and leave different reports", () => {
  const skipped = review(tmp(), { sweep: false });
  skipped.state.run = { skip: ["llm-skip-manual"], sca: false, sweep: false };
  const { settled: skippedOut } = driveLoop(
    skipped.state,
    skipped.work,
    (phase) => (phase === "verify" ? "reported" : "cleared")
  );
  assert.equal(skippedOut.earlyExit, false);
  assert.ok(
    skippedOut.review.meta.manualReview.some((m) => !m.extended),
    "a skip leaves the questions in the report"
  );

  const halted = blockingReview(tmp());
  halted.state.run = { skip: ["llm-skip-manual"], sca: true, sweep: false };
  const { settled } = driveLoop(halted.state, halted.work, (phase) =>
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
      const { state, work } = review(tmp(), {
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
      refed(state);
      const { settled } = driveLoop(state, work, () => "reported", reg);
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
