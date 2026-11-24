// The REVIEW LOOP, driven end to end with no agent: every phase handed out, answered from
// a canned decision, and handed back.
//
// This file is the safety net for the whole round trip. The goldens contain no prompt
// output at all, so the golden suite cannot catch a regression here and will not need
// regenerating either. Everything this half of the tool does that is testable
// is testable because `record + a filled answers file -> the next record + answers file`
// is a file-to-file transformation.
//
// A test holds the record in memory, as the hand-back holds what it read: each pass is
// "advance the review" over the record (which writes state.json and answers.json and prints
// the prompt), and each hand-back is `accept`, which returns the accepted copy and its
// settled review for the next pass, as the review case of the hand-back does.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRegistry } from "../../src/checks/registry.js";
import { REVIEW_MODE } from "../../src/lib/enum.js";
import { ARTIFACT_SCA, ARTIFACT_XPI } from "../../src/lib/artifacts.js";
import { renderFindings } from "../../src/report/responses.js";
import { assignRefs, orderReview } from "../../src/report/order.js";
import {
  accept,
  advanceReview,
  closeAt,
  restartAnswer,
  loopSlots,
  reviewDetails,
  HandbackRefused,
} from "../../src/report/loop.js";
import { settleReview } from "../../src/review/settle.js";
import { MODE, readRecord } from "../../src/review/record.js";
import { workPaths } from "../../src/util/dest.js";
import { answersOf } from "../../src/report/handback.js";
import { MAX_NOTE } from "../../src/config.js";
import { schemaLines, summaryBodyLines } from "../../src/report/format.js";
import { sweepRequests } from "../../src/report/sweep-files.js";

const REGISTRY = loadRegistry();
const PHASES = REGISTRY.llmPhases().phases;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wxl-loop-"));

/** A source review's folders, all at `folder`, made there as a review finds them: every
 *  hand-back expects the source it read to be the folder it was. */
function sourceFolders(folder) {
  fs.mkdirSync(folder, { recursive: true });
  return { source: folder, used: folder, packageRoot: folder };
}

/** A test's review: the work folder and the record as the hand-back holds it, mode review's
 *  own part (`state`) read off the record's current part. `settled` is the review an
 *  accepted pass settled, handed to the next pass. */
function held(work, record) {
  return {
    work,
    record,
    settled: null,
    get state() {
      return this.record.current;
    },
  };
}

/** A review small enough to read, carrying one of each kind the loop routes:
 *  two findings (verify), one code-review case (settle), two questions (ask). */
function review(
  dir,
  { sweep = true, findings = true, code = true, questions = true } = {}
) {
  // The work folder's own names, as a review lays them out (src/util/dest.js), with the
  // add-on's copy the load put there, which every hand-back finds first.
  const files = workPaths(dir);
  fs.mkdirSync(files.xpi, { recursive: true });
  const finding = (i, ruleId) => ({
    ruleId,
    severity: "error",
    file: `f${i}.js`,
    loc: { line: i },
    // Every finding carries the artifact its path is in, as its holder minted it
    // (src/checks/registry.js runOneCheck). A review without it is not one the loop can
    // hand out: entriesFor has no root to resolve the path against.
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
  const state = {
    mode: MODE.review,
    report: {
      findings: findings ? [finding(1, "a"), finding(2, "b")] : [],
      // What the Review Details block is built from - the artifacts this review is of,
      // which is the whole reason a phase hands that block over.
      meta: {
        xpi: `${dir}/a.xpi`,
        xpiRoot: `${files.xpi}/`,
        xpiFile: "a.xpi",
      },
      sca: false,
    },
    manual: [
      ...(code
        ? [
            todo("unknown-api", {
              instructions: "settle me",
              // What the ENTRY offers, which is what answersOf checks against. All
              // three here so the routing `ask` performs is testable. The narrowing
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
              "llm-verification": true,
              title: "t1",
              instruction: "i1",
              artifact: ARTIFACT_XPI,
            },
            {
              label: 2,
              check: "data-exfiltration",
              "llm-verification": true,
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
      // The roots an entry's paths are resolved against (handback.js entriesFor). The
      // review carries both, and without xpiRoot the loop would hand out relative paths.
      xpiRoot: `${files.xpi}${path.sep}`,
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
    issued: [],
    sweep: null,
    phase: null,
  };
  // The schema block a judging phase prints, as a review start makes it from the meta.
  state.paths.schema = schemaLines(state.report.meta).join("\n");
  refed(state);
  // The record's permanent part as the setup adds it (src/cli.js addGiven): the submission,
  // the kind of review, the forwarded flags and the folder xpi/.
  return held(dir, {
    submission: { xpi: `${dir}/a.xpi`, experiments: false },
    kind: "xpi",
    flags: {},
    folders: { xpi: files.xpi },
    current: state,
  });
}

/** Make a test's review a source review reading `roots`: the kind and the folder sca/ in the
 *  record's permanent part, and the roots in mode review's own part. */
function asSource(made, roots) {
  made.record.kind = "sca";
  made.record.folders.sca = roots.source;
  made.state.roots = roots;
  made.state.report.meta.scaFolders = roots;
  return made;
}

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

/** Give every item of a hand-built review its reference, as a review start does
 *  (src/report/order.js assignRefs). Called again by a test that adds items, which keep the
 *  references they already have. */
function refed(state) {
  assignRefs([...state.report.findings, ...state.manual], REGISTRY);
  return state;
}

/** What `fn` writes to stdout as text, beside its value. The test runner's own Buffers on
 *  the stream pass through untouched. */
function printed(fn) {
  const chunks = [];
  const real = process.stdout.write.bind(process.stdout);
  const spy = mock.method(process.stdout, "write", (t, ...rest) =>
    typeof t === "string" ? chunks.push(t) > 0 : real(t, ...rest)
  );
  try {
    return { value: fn(), text: chunks.join("") };
  } finally {
    spy.mock.restore();
  }
}

/** Every run of whitespace in `text` as one space, so wrapped prose reads as one line. */
function words(text) {
  return text.split("\n").join(" ").split(" ").filter(Boolean).join(" ");
}

/** The lines of `text`, each with its indent removed. */
function flat(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
}

/** Whether a printed line opens a numbered step: digits, then ". ", at the line's start. */
function opensStep(line) {
  const dot = line.indexOf(". ");
  return dot > 0 && [...line.slice(0, dot)].every((c) => c >= "0" && c <= "9");
}

/**
 * The numbered steps of a printed prompt, each as its lines without their indent, its text,
 * and its first paragraph as one line (`first`).
 * @param {string} text
 * @returns {{lines: string[], text: string, first: string}[]}
 */
function stepsIn(text) {
  const steps = [];
  for (const line of text.split("\n")) {
    if (opensStep(line)) {
      steps.push([line.slice(line.indexOf(". ") + 2)]);
    } else if (steps.length) {
      steps.at(-1).push(line.trim());
    }
  }
  return steps.map((lines) => {
    const end = lines.indexOf("");
    return {
      lines,
      text: lines.join("\n"),
      first: words(lines.slice(0, end === -1 ? lines.length : end).join(" ")),
    };
  });
}

/** The preamble parts a printed prompt opens with, counted by the registry's own parts. */
function preambleIn(text, reg) {
  const header = text.indexOf("LLM Prompt");
  const ends = [
    text.indexOf("The review you are working on"),
    text.indexOf("\n1. "),
  ].filter((at) => at > header);
  const preamble = words(text.slice(header, Math.min(...ends)));
  return reg
    .llmPhases()
    .preamble.map((part) =>
      words(part.text.split("{{proseStyle}}").join(reg.proseStyle()))
    )
    .filter((part) => preamble.includes(part)).length;
}

/**
 * One pass of the loop: the review advanced with the verdicts so far, as the hand-back hands
 * it the review the accepted pass settled (or, on the first pass, the review settled with
 * the answers it holds). The record is read back as the pass wrote it.
 * @returns {{issued: string, settled: object, phase: object, entries: object[],
 *   text: string, steps: object[], preamble: number}}  The phase, or the closing phase, or
 *   the restart prompt, and the prompt printed: its steps without the hand-over step.
 */
function pass(made, reg = REGISTRY) {
  const settled =
    made.settled ?? settleReview(made.state, made.state.answers ?? {}, reg);
  const { value, text } = printed(() =>
    advanceReview(made.work, made.record, settled, reg)
  );
  made.settled = null;
  made.record = readRecord(made.work);
  return issuedPrompt(made, value, text, reg);
}

/** What a pass issued, read off the record it wrote, the answers file and the prompt. */
function issuedPrompt(made, value, text, reg) {
  const texts = reg.llmPhases();
  const closing = value.issued === "close";
  const phase = closing
    ? texts.phases.find((p) => p.answer === "end")
    : value.issued === "restart"
      ? texts.restart
      : texts.phases.find((p) => p.name === made.record.current.phase);
  const steps = stepsIn(text);
  return {
    ...value,
    phase,
    entries: closing
      ? []
      : JSON.parse(fs.readFileSync(reviewFileOf(made.work), "utf8")).entries,
    text,
    steps: closing ? steps : steps.slice(0, -1),
    preamble: preambleIn(text, reg),
  };
}

/** Take a phase back: the accepted copy becomes the record held, and its settled review is
 *  the one the next pass is handed. */
function take(made, reg = REGISTRY) {
  const accepted = accept(made.record, made.work, reg);
  made.record = accepted.record;
  made.settled = accepted.settled;
  return accepted;
}

/** The review the record holds: mode review's own part in the loop, else the permanent
 *  part's review once the loop ended. */
function reviewOf(made) {
  return made.record.current?.report ? made.record.current : made.record.review;
}

/** The review file in the review's work folder, where a pass writes it and `accept` reads
 *  it back. */
function reviewFileOf(work) {
  return workPaths(work).answers;
}

/** Fill every slot the way an obedient agent would, in the review's own file. */
function handBack(work, answerFor) {
  const file = reviewFileOf(work);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  doc.entries = doc.entries.map((e) => ({ ...e, answer: answerFor(e) }));
  fs.writeFileSync(file, JSON.stringify(doc, null, 1));
}

/**
 * Play the sweep agent for one tree: fill in its answers file the way the request
 * tells it to. `found` is what it found, by label, and every other label it was asked about
 * answers with the empty list. A hit's file given relative is named by its absolute path in
 * the tree, the way the agent names the file it opened.
 */
function swept(state, artifact, found = {}) {
  const paths = state.paths.sweeps[artifact];
  const labels = (state.preSweep?.items ?? [])
    .filter((i) => i.artifact === artifact)
    .map((i) => i.label);
  const root =
    artifact === ARTIFACT_XPI ? state.paths.xpiRoot : state.roots.used;
  const named = (hit) =>
    typeof hit?.file === "string" && !path.isAbsolute(hit.file)
      ? { ...hit, file: path.join(root, hit.file) }
      : hit;
  fs.writeFileSync(
    paths.answers,
    JSON.stringify({
      answers: Object.fromEntries(
        labels.map((l) => [l, (found[l] ?? []).map(named)])
      ),
    })
  );
  return paths.answers;
}

/** Put a file of `lines` lines into a swept tree, for a hint to name. */
function planted(root, rel, lines) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), "x\n".repeat(lines));
}

// The report is the one review document the LINTER writes, at its fixed path. It is written
// before every hand-back prompt, from the review settled with the verdicts so far, so it is
// current whenever a prompt links it, and the closing prompt writes it from the settled
// review.
test("the report file is written with every prompt and from the settled review at the close", () => {
  const made = review(tmp());
  const file = workPaths(made.work).report;

  // Nothing yet: no pass has gone out.
  assert.equal(fs.existsSync(file), false);

  let closing = null;
  for (let p = 0; p < 10; p++) {
    const out = pass(made);
    assert.ok(fs.existsSync(file), `after issuing ${out.phase.name}`);
    if (out.issued === "close") {
      closing = out;
      break;
    }
    if (out.phase.name === "spawn") {
      swept(made.state, ARTIFACT_XPI);
    }
    handBack(made.work, (e) => {
      if (out.phase.name === "verify") {
        return e.index === "0.1" ? "withdrawn" : "reported";
      }
      if (out.phase.name === "settle") {
        return "ask";
      }
      return "Clear";
    });
    take(made);
  }
  assert.ok(closing, "the review closes");

  // The file starts and ends on its text: the empty lines that set the body apart from a
  // section heading in the terminal have nothing to set it apart from here.
  const written = fs.readFileSync(file, "utf8");
  assert.equal(
    written,
    `${closing.settled.report.replace(/^\n+|\n+$/g, "")}\n`
  );
  assert.ok(!written.startsWith("\n"), "no leading empty line");
  assert.notEqual(written, "", "the report is not empty");
});

// The shape of a whole review: which phases are issued, in what order, and what each one
// asks about. Every route the loop has is exercised here - a sweep answered by check, a
// finding withdrawn, a case settled, a case that becomes a question, and a person's own
// words coming back.
test("a review runs spawn -> verify -> settle -> ask and then settles", () => {
  const made = review(tmp());
  const seen = [];
  const answered = [];
  for (let p = 0; p < 10; p++) {
    const out = pass(made);
    if (out.phase.answer === "end") {
      break;
    }
    seen.push(out.phase.name);
    if (out.phase.name === "spawn") {
      swept(made.state, ARTIFACT_XPI);
    }
    handBack(made.work, (e) => {
      if (out.phase.name === "verify") {
        return e.index === "0.1" ? "withdrawn" : "reported";
      }
      if (out.phase.name === "settle") {
        return "ask";
      } // -> becomes a question
      return "Clear"; // the reviewer's own word
    });
    const { answers } = take(made);
    answered.push([out.phase.name, [...answers.keys()].join(",")]);
  }
  assert.deepEqual(seen, ["spawn", "verify", "settle", "ask"]);
  // The settle case became a question and was asked WITH its own index, beside the two
  // standard ones - three questions, not two.
  assert.equal(answered[3][1].split(",").length, 3);
  // At the close the loop's review is the record's permanent part's.
  const done = made.record.review;
  assert.deepEqual(done.answers, {
    0.1: "withdrawn",
    0.2: "reported",
    0.3: "Clear",
    0.4: "Clear",
    [CASE]: "Clear",
  });
  // Moved by the case itself, not by its number: the item carries where it is asked now.
  const moved = done.manual.filter((m) => m.askedIn === "ask");
  assert.deepEqual(
    moved.map((m) => m.ruleId),
    ["unknown-api"]
  );
  assert.deepEqual(done.sweep, [], "both sweeps ran and found nothing");
  assert.deepEqual(made.record.current, {
    mode: MODE.review,
    phase: "close",
  });
});

// An answer follows its item's reference, not where the item sorts. A sweep accepted AFTER
// a question was answered files new cases ahead of it, and the answer must stay on the
// question: the new case is open for its own phase, and nothing is asked twice.
test("an answer recorded before the sweep stays on its item", () => {
  const made = review(tmp());
  const q1 = made.state.manual.find((m) => m.ruleId === "q1").ref;
  const placeOf = (ref) =>
    orderReview(made.state.report.findings, made.state.manual).findIndex(
      (x) => x.ref === ref
    );
  const before = placeOf(q1);
  made.state.answers[q1] = "Clear";

  const out = pass(made);
  assert.equal(out.phase.name, "spawn");
  planted(made.state.paths.xpiRoot, "lib/net.js", 7);
  swept(made.state, ARTIFACT_XPI, {
    2: [{ file: "lib/net.js", line: 7, hint: "sends it" }],
  });
  handBack(made.work, () => null);
  take(made);

  const added = made.state.manual.find((m) => m.ruleId === "data-exfiltration");
  assert.ok(added, "the sweep filed a case");
  assert.equal(added.ref, `${REGISTRY.refBase("data-exfiltration")}.1`);
  assert.ok(placeOf(q1) > before, "the new case sorts ahead of the question");
  assert.deepEqual(made.state.answers, { [q1]: "Clear" });
  const open = (ref) => !(ref in made.state.answers);
  assert.equal(open(q1), false, "the question stays answered");
  assert.equal(open(added.ref), true, "the new case is open");
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
    { ruleId: "no-such-check" },
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
          reports: "build-not-reproduced",
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
  return { reg };
}

// A process value steers the review and settles nothing: it is asked once, by its own
// entry, accepted only as one of the labels offered, and recorded where a `when:` reads it,
// never among the answers that settle items.
test("a process value is asked once and read by value(phase, id)", () => {
  const { reg } = valueLoop();
  const made = review(tmp(), { sweep: false });
  const out = pass(made, reg);
  assert.equal(out.phase.name, "safety");
  assert.deepEqual(out.entries, [
    {
      index: "safety",
      answers: [
        { label: "Safe", description: "nothing remote" },
        { label: "Unsafe", description: "something remote" },
      ],
      answer: null,
    },
  ]);
  handBack(made.work, () => "Maybe");
  assert.throws(
    () => take(made, reg),
    /answers "Maybe", which this entry does not accept \(expected one of: Safe, Unsafe\)/
  );
  assert.equal(made.state.values, undefined, "a refusal records nothing");

  handBack(made.work, () => "Safe");
  take(made, reg);
  assert.deepEqual(made.state.values, { safety: "safe" });
  assert.deepEqual(made.state.answers, {}, "it settles no item");
  const next = pass(made, reg);
  assert.equal(next.phase.name, "after", "its reader prints");
  assert.deepEqual(
    next.steps.map((x) => x.first),
    ["Only when safe."]
  );
});

// A value that reports a check aborts the review through that check: its finding is in
// the review, and the report names its reason. The check aborts late, so the review still
// runs to the end of settle, and the finding is the person's answer: its check is one the
// agent does not verify, so it is answered by nobody, and withdrawing everything withdraws
// nothing of it.
test("a process value that reports a check aborts the review", () => {
  const { reg } = valueLoop();
  const made = review(tmp(), { sweep: false });
  pass(made, reg);
  handBack(made.work, () => "Unsafe");
  take(made, reg);
  assert.deepEqual(made.state.values, { safety: "unsafe" });
  const reported = made.state.report.findings.find(
    (f) => f.ruleId === "build-not-reproduced"
  );
  assert.ok(reported, "the reported check's finding is in the review");
  assert.equal(reported.ref, `${reg.refBase("build-not-reproduced")}.1`);
  assert.equal(reported.artifact, ARTIFACT_SCA, "the artifact its check reads");
  assert.equal(reported.llmVerification, false);
  assert.ok(
    !(reported.ref in made.state.answers),
    "nobody answers the person's answer"
  );
  const seen = [];
  let closing = null;
  for (let p = 0; p < 8; p++) {
    const out = pass(made, reg);
    if (out.phase.answer === "end") {
      closing = out;
      break;
    }
    seen.push(out.phase.name);
    if (out.phase.name === "verify") {
      assert.ok(
        !out.entries.some((e) => e.index === reported.ref),
        "verify is not asked about the person's answer"
      );
    }
    handBack(made.work, () =>
      out.phase.name === "verify" ? "withdrawn" : "cleared"
    );
    take(made, reg);
  }
  assert.ok(!seen.includes("ask"), seen.join(", "));
  assert.ok(seen.includes("verify"), seen.join(", "));
  assert.ok(closing.steps[0].first.startsWith("The review was aborted"));
  assert.ok(closing.text.includes("Build process issues"));
});

// The finding a value reports names no file, so the artifact it is about is the one its check
// reads: a check of the XPI files it against the XPI.
test("a process value's finding is about the artifact its check reads", () => {
  const { reg } = valueLoop();
  // The raw entry, in whichever registry section holds it.
  Object.values(reg.doc)
    .filter(Array.isArray)
    .flat()
    .find((e) => e?.check === "build-not-reproduced").input = "xpi";
  const made = review(tmp(), { sweep: false });
  pass(made, reg);
  handBack(made.work, () => "Unsafe");
  take(made, reg);
  const reported = made.state.report.findings.find(
    (f) => f.ruleId === "build-not-reproduced"
  );
  assert.equal(reported.artifact, ARTIFACT_XPI);
});

/** The slots a pass fills, from the review and the record as they stand. */
const slotsOf = (made, reg = REGISTRY) =>
  loopSlots(made.state, made.record, {}, made.work, reg);

// The Build Review Details block names the submitted XPI and where it was unpacked, the
// source the review read, the build report once back, the judgement, the vulnerable packages
// the review's own audit counted in the lock, what came of the build, and the output where
// the agent built it, by the same rows the Review Details block uses. The XPI and the output
// are named by their own names. The build results are the record's permanent part's.
test("the build details name the XPI, the source, the report, the judgement, the audit, the result and the output", () => {
  const dir = tmp();
  const made = scaReview(dir);
  made.state.report.meta.xpi = path.join(dir, "addon-1.0.xpi");
  made.state.report.meta.xpiFile = "addon-1.0.xpi";
  const rescuedSrc = path.join(dir, "rescued", "src");
  asSource(made, {
    source: rescuedSrc,
    used: rescuedSrc,
    packageRoot: rescuedSrc,
  });
  made.state.paths.build = path.join(dir, "build.md");
  made.state.report.meta.buildFile = made.state.paths.build;
  const rows = () => slotsOf(made).buildDetails.split("\n");
  const meta = made.state.report.meta;
  const xpi = `* XPI_FILE: [addon-1.0.xpi](${meta.xpi})`;
  const unpacked = `* XPI_ROOT: [extracted addon](${meta.xpiRoot})`;
  const source = `* SCA_SOURCE: [source archive](${rescuedSrc})`;
  const report = `* SCA_BUILD_REPORT: [build.md](${made.state.paths.build})`;
  assert.deepEqual(rows(), [xpi, unpacked, source]);
  made.state.products = ["build"];
  made.record.build = {
    result: "built",
    output: path.join(dir, "build", "addon-1.0.xpi"),
    match: "no match",
    vulnerabilities: { moderate: 1, high: 0, critical: 0 },
    safety: "safe",
  };
  assert.deepEqual(rows(), [
    xpi,
    unpacked,
    source,
    report,
    "* SCA_BUILD_SAFETY_ASSESSMENT: safe",
    "* SCA_VULNERABILITIES: 1 moderate, 0 high, 0 critical",
    `* LLM_BUILD_OUTPUT: [addon-1.0.xpi](${made.record.build.output})`,
    "* LLM_BUILD_RESULT: build succeeded",
    "* LLM_BUILD_XPI_MATCH: no match",
  ]);
});

// LLM_BUILD_XPI_MATCH is the linter's comparison of the agent's output with the submitted XPI,
// shown after LLM_BUILD_OUTPUT and only beside it: a build that produced nothing compared nothing.
test("the build details show the linter's comparison only beside its output", () => {
  for (const [build, shown] of [
    [{ result: "built", output: "/w/build/dist", match: "match" }, "match"],
    [
      { result: "built", output: "/w/build/dist", match: "no match" },
      "no match",
    ],
    [{ result: "failed", output: null, match: "match" }, null],
    [{ result: null, output: null, match: null }, null],
  ]) {
    const made = review(tmp(), { sweep: false });
    made.record.build = build;
    const rows = slotsOf(made).buildDetails.split("\n");
    const at = rows.findIndex((row) => row.startsWith("* LLM_BUILD_XPI_MATCH"));
    if (shown === null) {
      assert.equal(at, -1, rows.join("\n"));
      continue;
    }
    assert.equal(rows[at], `* LLM_BUILD_XPI_MATCH: ${shown}`);
    assert.ok(rows[at - 1].startsWith("* LLM_BUILD_OUTPUT: "), rows.join("\n"));
  }
});

// SCA_SOURCE names the copy of the submitted source, and SCA_RESCUED the rescued copy where the
// review read one instead. SCA_BUILD names the copy the agent built in, where it built or tried
// to, and nowhere else. The Review Details name the same rows.
test("the details name the source copy, the rescued copy and the build copy", () => {
  const dir = tmp();
  const made = scaReview(dir);
  const sca = path.join(dir, "sca");
  const rescued = path.join(dir, "rescued");
  const buildCopy = path.join(dir, "build");
  const rootRows = (block) =>
    block
      .split("\n")
      .filter((row) =>
        ["* SCA_SOURCE", "* SCA_RESCUED", "* SCA_BUILD:"].some((n) =>
          row.startsWith(n)
        )
      );
  const source = `* SCA_SOURCE: [source archive](${sca})`;
  const copy = `* SCA_BUILD: [build copy](${buildCopy})`;
  const inSource = {
    source: sca,
    used: sca,
    packageRoot: path.join(sca, "src"),
  };
  const cases = [
    [
      "the source archive, not built",
      inSource,
      { result: null, output: null },
      [source],
    ],
    [
      "the source archive, built",
      inSource,
      {
        result: "built",
        copy: buildCopy,
        output: path.join(buildCopy, "dist"),
      },
      [source, copy],
    ],
    [
      "the source archive, its build failed",
      inSource,
      { result: "failed", copy: buildCopy, output: null },
      [source, copy],
    ],
    [
      "the rescued copy, built",
      { source: sca, used: rescued, packageRoot: path.join(rescued, "src") },
      {
        result: "built",
        copy: buildCopy,
        output: path.join(buildCopy, "dist"),
      },
      [
        source,
        `* SCA_RESCUED: [rescued source (reduced/fixed dependencies)](${rescued})`,
        copy,
      ],
    ],
  ];
  for (const [name, scaFolders, build, rows] of cases) {
    made.state.roots = scaFolders;
    made.state.report.meta.scaFolders = scaFolders;
    made.record.build = build;
    assert.deepEqual(rootRows(slotsOf(made).buildDetails), rows, name);
    assert.deepEqual(
      rootRows(reviewDetails(made.state, made.record, made.work, REGISTRY)),
      rows,
      name
    );
  }
});

// LLM_BUILD_RESULT reports the agent's attempt, one wording per build result: the agent built
// it, its build failed, its rescue failed, or the reviewer held the build unsafe so nothing
// was built. Where the reviewer builds it (the agent was not let build, or nothing was checked)
// the row is absent.
test("the build result is worded by what came of the agent's attempt", () => {
  const made = scaReview(tmp());
  const result = () =>
    slotsOf(made)
      .buildDetails.split("\n")
      .find((row) => row.startsWith("* LLM_BUILD_RESULT: "));
  const cases = [
    [{ result: "built", output: "/w/build/dist" }, true, "build succeeded"],
    [{ result: "failed" }, true, "build failed: see build.md"],
    [{ result: null }, false, "not built: unsafe"],
    [{ result: null }, true, null],
    [{ result: "rescue-failed" }, true, "not built: rescue failed"],
    [
      { result: "rescue-mismatch" },
      true,
      "not reviewed as rescued: its build does not reproduce the XPI",
    ],
    [undefined, undefined, null],
  ];
  for (const [build, safe, said] of cases) {
    made.record.build = build && { ...build, safe };
    assert.equal(
      result(),
      said === null ? undefined : `* LLM_BUILD_RESULT: ${said}`,
      String(build?.result)
    );
  }
});

// An entry says what it may be answered with, and that is what an answer is checked
// against - not what the phase accepts. Two entries of one phase can offer different
// answers, so a set read off the phase would accept, for one case, a verdict the check
// that raised it withheld.
test("an entry is answered from its own answers, not its phase's verbs", () => {
  const made = review(tmp(), { sweep: false, findings: false });
  // --llm-skip-summary with no sweep leaves spawn with nothing to start, so settle is
  // first once it has been issued.
  made.state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  // Marked done so this test starts where it means to - spawn has nothing to start here
  // anyway.
  made.state.issued = ["spawn"];
  // What most screened checks declare: settle it, or clear it. No handing it on.
  made.state.manual[0].settleVerbs = ["reported", "cleared"];

  const out = pass(made);
  assert.equal(out.phase.name, "settle");
  assert.deepEqual(
    out.entries[0].answers.map((a) => a.label),
    ["reported", "cleared"],
    "the entry offers what its check allows"
  );
  // `ask` is one of the phase's own verbs, and still refused here.
  assert.ok(PHASES.find((p) => p.name === "settle").verbs.includes("ask"));
  assert.throws(() => {
    handBack(made.work, () => "ask");
    return take(made);
  }, /this entry does not accept \(expected one of: reported, cleared\)/);
  assert.deepEqual(made.state.answers, {}, "a refusal settles nothing");

  handBack(made.work, () => "reported");
  take(made);
  assert.deepEqual(made.state.answers, { [CASE]: "reported" });
});

// What a verb MEANS is the phase's to word, but `reported` reads differently where the
// case could still have been handed on. An entry offering `cleared` and no `ask` has had
// its way out declined, which is a different sentence from the same verb chosen freely.
test("reporting reads as the last resort only where clearing was the way out", () => {
  const skipSetup = (r) => {
    r.state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
    r.state.issued = ["spawn"];
    return r;
  };
  const offered = (verbs) => {
    const fresh = skipSetup(review(tmp(), { sweep: false, findings: false }));
    fresh.state.manual[0].settleVerbs = verbs;
    const [e] = pass(fresh).entries;
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
    review(tmp(), { code: false, questions: false, sweep: false })
  );
  const [audit] = pass(findings).entries;
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
  const made = review(tmp(), { sweep: false });
  // --llm-skip-summary on an XPI review with no sweep starts no agent at all, so spawn
  // has nothing left to do.
  made.state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  assert.equal(pass(made).phase.name, "verify");
});

test("nothing to ask: the review settles after the last settle", () => {
  const made = review(tmp(), { sweep: false });
  made.state.manual = made.state.manual.filter((m) => m.extended);
  // spawn is skipped (nothing to start), so what this pins is that `ask` is not issued
  // either, once it has nothing to put to anyone - and neither is the details block, which
  // exists to answer questions with.
  made.state.run = {
    skip: ["llm-skip-summary"],
    sca: false,
    sweep: false,
  };
  const seen = [];
  let last = null;
  for (let p = 0; p < 10; p++) {
    last = pass(made);
    if (last.phase.answer === "end") {
      break;
    }
    seen.push(last.phase.name);
    const name = last.phase.name;
    handBack(made.work, () =>
      name === "spawn" ? [] : name === "verify" ? "reported" : "cleared"
    );
    take(made);
  }
  assert.deepEqual(seen, ["verify", "settle"]);
  assert.equal(last.phase.name, "close", "settled");
  assert.equal(last.issued, "close");
});

// Four ways a hand-back can be wrong. Each names the one thing to fix, and NONE of them
// touches the record: a corrected hand-back resumes exactly where it was, which is why the
// caller does not re-print the prompt.
test("a wrong hand-back is refused, and changes nothing", () => {
  const made = review(tmp(), { sweep: false });
  // --llm-skip-summary as well, so spawn starts nothing and verify is the phase in
  // flight: a refusal needs a pass that actually asked for something.
  made.state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  // Marked done so this test starts where it means to - spawn has nothing to start here
  // anyway.
  made.state.issued = ["spawn"];
  assert.equal(pass(made).phase.name, "verify");
  const before = JSON.stringify(made.record);
  // Each case starts from the file as it was HANDED OUT: mangling the last mangle would
  // test a file no pass ever produced.
  const handed = fs.readFileSync(reviewFileOf(made.work), "utf8");
  const mangle = (fn) => {
    const doc = JSON.parse(handed);
    fn(doc);
    fs.writeFileSync(reviewFileOf(made.work), JSON.stringify(doc, null, 1));
  };

  mangle((d) =>
    d.entries.forEach((e, i) => (e.answer = i ? "reported" : null))
  );
  assert.throws(() => take(made), /still has no "answer"/);

  mangle((d) => {
    d.entries.forEach((e) => (e.answer = "reported"));
    d.entries.push({ index: 99, answer: "reported" });
  });
  assert.throws(() => take(made), /99 is not one of the entries/);

  mangle((d) => {
    d.entries.forEach((e) => (e.answer = "reported"));
    d.entries.pop();
  });
  assert.throws(() => take(made), /missing from the file/);

  mangle((d) => d.entries.forEach((e) => (e.answer = "cleared")));
  assert.throws(
    () => take(made),
    /this entry does not accept \(expected one of: reported, withdrawn\)/
  );

  assert.equal(
    JSON.stringify(made.record),
    before,
    "a refusal leaves the record untouched"
  );
  assert.deepEqual(
    readRecord(made.work),
    made.record,
    "and the record on disk as the pass wrote it"
  );
});

// An entry handed back twice is refused, even where every entry is answered: otherwise the
// later copy silently decides the item, whichever of the two the agent meant.
test("an entry handed back twice is refused, and changes nothing", () => {
  const made = review(tmp(), { sweep: false });
  made.state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  made.state.issued = ["spawn"];
  assert.equal(pass(made).phase.name, "verify");
  const before = JSON.stringify(made.record);
  const doc = JSON.parse(fs.readFileSync(reviewFileOf(made.work), "utf8"));
  doc.entries.forEach((e) => (e.answer = "reported"));
  doc.entries.push({ ...doc.entries[0], answer: "withdrawn" });
  fs.writeFileSync(reviewFileOf(made.work), JSON.stringify(doc, null, 1));
  assert.throws(() => take(made), /appears twice/);
  assert.equal(JSON.stringify(made.record), before);
});

// `accept` takes a pass on a copy: the record it is given is never changed, also where the
// pass is taken.
test("accept returns the accepted copy and leaves the record given as it was", () => {
  const made = review(tmp(), { sweep: false });
  made.state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  made.state.issued = ["spawn"];
  assert.equal(pass(made).phase.name, "verify");
  const given = made.record;
  const before = JSON.stringify(given);
  handBack(made.work, () => "reported");
  const accepted = accept(given, made.work, REGISTRY);
  assert.equal(JSON.stringify(given), before, "the record given is unchanged");
  assert.notEqual(accepted.record, given);
  assert.deepEqual(accepted.record.current.answers, {
    0.1: "reported",
    0.2: "reported",
  });
  assert.equal(accepted.phase.name, "verify");
  assert.ok(accepted.record.current.issued.includes("verify"));
  // Its settled review is the one the next pass is handed: settled with the new answers.
  assert.deepEqual(
    accepted.settled.findings.map((f) => f.ref),
    ["0.1", "0.2"]
  );
});

// A phase that asks a person takes their words, and an empty answer or one that is not
// text is none. Taken anyway, an empty one breaks the review only once it is settled, and
// anything else is reported as a note the reviewer never wrote.
test("a person's answer that is empty or not text is refused at the hand-back", () => {
  const made = review(tmp(), {
    sweep: false,
    findings: false,
    code: false,
  });
  made.state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  made.state.issued = ["spawn"];
  assert.equal(pass(made).phase.name, "ask");
  const before = JSON.stringify(made.record);
  for (const said of ["", { label: "Clear" }, 1]) {
    handBack(made.work, () => said);
    assert.throws(
      () => take(made),
      /answers with nothing a reviewer said/,
      JSON.stringify(said)
    );
  }
  assert.equal(JSON.stringify(made.record), before);
});

// A person's own words become the note their case is reported with, so they are held to the
// note's rule where the agent can still ask the question again: at the hand-back, not at
// settle, where the answer is already recorded and the run can only fail. The ask step
// states the limit before anything is asked, and the review stays at its phase until a
// corrected answer comes back.
test("a person's words too long or empty once cleaned up are refused at the hand-back", () => {
  const made = review(tmp(), {
    sweep: false,
    findings: false,
    code: false,
  });
  made.state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  made.state.issued = ["spawn"];
  // Real check ids: the pass is taken only where it settles, and a person's words report
  // the case as a finding of its own check, with the severity that check declares.
  made.state.manual.forEach((m, i) => {
    m.ruleId = ["testing-information", "no-surprises-policy"][i];
  });
  refed(made.state);
  const out = pass(made);
  assert.equal(out.phase.name, "ask");
  const text = words(out.text);
  assert.ok(
    text.includes(`at most ${MAX_NOTE} characters`),
    "the ask step states the limit"
  );
  assert.ok(!text.includes("{{maxNote}}"), "filled, not left as its slot");

  const before = JSON.stringify(made.record);
  for (const [said, problem] of [
    ["x".repeat(MAX_NOTE + 1), `the limit is ${MAX_NOTE}`],
    ["- \n  \n*", "carries an answer with nothing in it"],
  ]) {
    handBack(made.work, () => said);
    assert.throws(
      () => take(made),
      (err) => err instanceof HandbackRefused && err.problem.includes(problem),
      problem
    );
    assert.equal(
      JSON.stringify(made.record),
      before,
      "the review stays at its phase"
    );
  }
  handBack(made.work, () => "x".repeat(MAX_NOTE));
  const { answers } = take(made);
  assert.ok(answers.size > 0);
  for (const ref of answers.keys()) {
    assert.equal(
      made.state.answers[ref],
      "x".repeat(MAX_NOTE),
      "the stated limit is taken"
    );
  }
});

// The sweep asks nothing of the file every other phase uses: its work is starting the
// agents, and each of those answers in a file of its own. So what goes out is empty, and
// what makes the review whole is the answers files - where an empty list is a real answer
// and a null is not, which is the distinction a sweep quietly skipped would otherwise hide.
test("the sweep phase asks for nothing in the review file, and answers in its own", () => {
  const made = review(tmp());
  const out = pass(made);
  assert.equal(out.phase.name, "spawn");
  assert.deepEqual(out.entries, [], "nothing to fill in here");
  // It does hand over the steps that start the agents - a phase with no entries is
  // still issued when it has work.
  assert.ok(out.steps.length > 0);

  // Nothing written yet: the pass cannot be accepted, and the refusal names the file the
  // agent has to go and produce rather than anything in the hand-back.
  handBack(made.work, () => null);
  assert.throws(() => take(made), /sweep-xpi\.answers\.json could not be read/);

  // A null left behind is not an answer, and is refused by the label it belongs to.
  const before = JSON.stringify(made.record);
  fs.writeFileSync(
    made.state.paths.sweeps[ARTIFACT_XPI].answers,
    JSON.stringify({ answers: { 1: [], 2: null } })
  );
  assert.throws(() => take(made), /leaves label 2 unanswered/);
  assert.equal(
    JSON.stringify(made.record),
    before,
    "a refusal changes nothing"
  );

  swept(made.state, ARTIFACT_XPI);
  take(made);
  assert.deepEqual(made.state.sweep, [], "both ran, neither found anything");
});

// A hint is held to the tree its sweep read: the file is one that tree has, and the line
// one that file has. Refused at the hand-back, where the agent can correct it.
test("a swept result naming a file or line the tree lacks is refused", () => {
  const made = review(tmp());
  assert.equal(pass(made).phase.name, "spawn");
  handBack(made.work, () => null);
  planted(made.state.paths.xpiRoot, "lib/net.js", 7);
  const before = JSON.stringify(made.record);
  const refused = (found, says) => {
    swept(made.state, ARTIFACT_XPI, { 2: [found] });
    assert.throws(
      () => take(made),
      (err) => err instanceof HandbackRefused && err.problem.includes(says)
    );
    assert.equal(
      JSON.stringify(made.record),
      before,
      "a refusal changes nothing"
    );
  };
  const at = (rel) => path.join(made.state.paths.xpiRoot, rel);
  refused(
    { file: "lib/gone.js", line: 1 },
    `names file ${JSON.stringify(at("lib/gone.js"))}, which is not a file inside`
  );
  refused(
    { file: "lib/net.js", line: 501 },
    `names line 501 of ${JSON.stringify(at("lib/net.js"))}, which has 7 lines`
  );

  swept(made.state, ARTIFACT_XPI, { 2: [{ file: "lib/net.js", line: 7 }] });
  take(made);
  assert.deepEqual(
    made.state.sweep.map((r) => [r.file, r.line]),
    [["lib/net.js", 7]]
  );
});

// The sweep request travels INLINE: the step that spawns the agent prints the whole of it -
// the tree to read and each sweep's instruction under its label - and names the file the
// agent's reply is written to. No request file exists for it to name.
test("the spawn step hands the sweep request over inline and names the answers file", () => {
  const made = review(tmp(), { findings: false, questions: false });
  made.state.paths.sweeps = sweepRequests(
    workPaths(made.work),
    made.state.preSweep,
    { [ARTIFACT_XPI]: made.state.paths.xpiRoot },
    REGISTRY.proseStyle(),
    REGISTRY.readingRule()
  );
  const out = pass(made);
  assert.equal(out.phase.name, "spawn");
  const text = out.text;
  const step = text.slice(text.indexOf("to sweep the built add-on"));
  assert.ok(
    step.includes(`\n     ${made.state.paths.xpiRoot}\n`),
    "the folder to read"
  );
  assert.match(step, /Label 1: t1\n\s+i1\n/, "each label with its instruction");
  assert.match(step, /Label 2: t2\n\s+i2\n/);
  assert.match(
    step,
    /write\s+its\s+reply\s+unchanged,\s+exactly\s+as\s+it\s+returned\s+it,\s+to\n\n\s+\S+\/\.review\/sweep-xpi\.answers\.json\n/,
    "the answers file the reply is written to"
  );
  assert.doesNotMatch(text, /\.yaml/, "no request file is named");
});

// The report agent's request names the extracted XPI, as the sweep's does: a sub-agent
// handed only "this add-on" has to guess which one, and a folder of reviews holds many.
test("the spawn step tells the report agent which folder to describe", () => {
  const made = review(tmp(), { findings: false, questions: false });
  const out = pass(made);
  assert.equal(out.phase.name, "spawn");
  const text = out.text;
  const request = text.slice(
    text.indexOf("Describe the add-on"),
    text.indexOf("Do not wait for it")
  );
  assert.ok(request.includes("read nothing outside"), request);
  assert.ok(request.includes(made.state.paths.xpiRoot), request);
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
  const made = review(dir, {
    findings: false,
    questions: false,
  });
  // Both trees exist for this one, so the review is a source-code review.
  asSource(made, sourceFolders(path.join(dir, "src")));
  made.state.paths.sweeps[ARTIFACT_SCA] = {
    request: "Sweep the source.",
    answers: path.join(dir, "r.sweep-sca.answers.json"),
  };
  made.state.run["sweep-sca"] = true;
  made.state.preSweep = {
    items: [ARTIFACT_XPI, ARTIFACT_SCA].map((artifact, i) => ({
      label: i + 1,
      check: "data-exfiltration",
      "llm-verification": true,
      title: "Data exfiltration",
      severity: "error",
      instruction: `look in the ${artifact}`,
      response: null,
      artifact,
    })),
  };

  const out = pass(made);
  assert.equal(out.phase.name, "spawn");
  // Two steps, one per tree, each starting an agent of its own.
  assert.equal(
    out.steps.filter((x) => x.text.includes("Spawn a sweep agent")).length,
    2
  );

  // Answered independently, at the SAME relative path in each tree.
  const hit = (tree) => [
    { file: "lib/net.js", line: 7, hint: `sends from the ${tree}` },
  ];
  planted(made.state.paths.xpiRoot, "lib/net.js", 7);
  planted(made.state.roots.used, "lib/net.js", 7);
  swept(made.state, ARTIFACT_XPI, { 1: hit(ARTIFACT_XPI) });
  swept(made.state, ARTIFACT_SCA, { 2: hit(ARTIFACT_SCA) });
  handBack(made.work, () => null);
  take(made);

  assert.deepEqual(
    made.state.sweep.map((r) => [r.check, r.artifact, r.file]),
    [
      ["data-exfiltration", ARTIFACT_XPI, "lib/net.js"],
      ["data-exfiltration", ARTIFACT_SCA, "lib/net.js"],
    ]
  );
  // data-exfiltration escalates, so both hints arrive as cases of it - one per tree, each
  // stamped with the tree the review asked about, and neither collapsed into the other.
  const cases = made.state.manual.filter(
    (m) => m.ruleId === "data-exfiltration"
  );
  assert.deepEqual(
    cases.map((m) => [m.artifact, m.file, m.hint]),
    [
      [ARTIFACT_XPI, "lib/net.js", "sends from the XPI"],
      [ARTIFACT_SCA, "lib/net.js", "sends from the SCA"],
    ]
  );
});

test("a refusal is its own class, so the caller can answer it differently", () => {
  const made = review(tmp(), { sweep: false });
  pass(made);
  fs.rmSync(reviewFileOf(made.work));
  try {
    take(made);
    assert.fail("expected a refusal");
  } catch (e) {
    assert.ok(e instanceof HandbackRefused);
    assert.match(e.problem, /could not be read/);
  }
});

// The same phase, reached the other way: nothing produced an ask verdict and there are no
// standard questions, so there is nothing to ask and the review goes straight to the
// report. Driven by the REVIEW having no questions, not by a flag emptying it.
test("no questions at all: the ask phase is not issued either", () => {
  const made = review(tmp(), { sweep: false });
  made.state.manual = made.state.manual.filter((m) => m.extended);
  made.state.run = { skip: [], sca: false, sweep: false };
  const seen = [];
  for (let p = 0; p < 8; p++) {
    const out = pass(made);
    if (out.phase.answer === "end") {
      break;
    }
    seen.push(out.phase.name);
    handBack(made.work, () =>
      out.phase.name === "verify" ? "reported" : "cleared"
    );
    take(made);
  }
  assert.ok(!seen.includes("ask"), `ask was issued: ${seen.join(", ")}`);
});

// A sweep that found nothing is over all the same: the list of what it was asked goes, as it
// does after a sweep with hints, so nothing later reads it as work still to do.
test("a sweep that finds nothing clears its list", () => {
  const made = review(tmp(), { findings: false, questions: false });
  made.state.paths.sweeps = sweepRequests(
    workPaths(made.work),
    made.state.preSweep,
    { [ARTIFACT_XPI]: made.state.paths.xpiRoot },
    REGISTRY.proseStyle(),
    REGISTRY.readingRule()
  );
  assert.equal(pass(made).phase.name, "spawn");
  swept(made.state, ARTIFACT_XPI);
  handBack(made.work, () => null);
  take(made);
  assert.deepEqual(made.state.sweep, [], "asked, and nothing found");
  assert.equal(made.state.preSweep, null, "the list is gone");
});

// --llm-skip-sweep leaves the instructions standing and withholds the ASKING, so the
// review never mentions a sweep: no agent is spawned for one, no rows are handed over, and
// the Standard Code Review section stays in the report for the reviewer to sweep by hand.
//
// Driven rather than asserted on a flag, because the two are different facts: the review
// still carries `preSweep`, and deriving "does this run sweep" from that would re-enable
// exactly what the flag withheld.
test("--llm-skip-sweep asks for no sweep, though the instructions still exist", () => {
  const made = review(tmp());
  assert.ok(made.state.preSweep, "the instructions are still there");
  // What the flag does in the pipeline: no request is written, so no condition names one
  // and there is no answers file for the pass to read.
  made.state.run = { skip: [], sca: false };
  delete made.state.paths.sweeps;
  const first = pass(made);
  assert.deepEqual(first.entries, [], "no rows to fill in");
  const prose = first.steps.map((s) => s.text.toLowerCase()).join("\n");
  assert.ok(!prose.includes("sweep"), "and no step mentions one");
  assert.equal(made.state.sweep, null, "nothing was swept");

  // And the empty file IS the right hand-back. Both legs read the same fact, so the pass
  // that asked for nothing accepts nothing.
  handBack(made.work, () => null);
  const { answers } = take(made);
  assert.equal(answers.size, 0);
  // Null, not an empty list: no tree was asked, which is not every tree answering with
  // nothing - the same distinction the answers files themselves are built around.
  assert.equal(made.state.sweep, null, "and still nothing was swept");
  assert.ok(pass(made), "the review goes on");
});

/**
 * Run a whole review with a canned answer per phase, THROUGH to the close.
 *
 * Driven to the end rather than to the last hand-back, because applying the answers is its
 * own step: a phase can hand out and take back cleanly and still refuse what it took when
 * the report is built from it.
 * @returns {{seen: string[], closing: object}}  The phases issued, and the closing prompt
 *   with the settled review.
 */
function phasesOf(made) {
  const seen = [];
  for (let p = 0; p < 10; p++) {
    const out = pass(made);
    if (out.phase.answer === "end") {
      return { seen, closing: out };
    }
    seen.push(out.phase.name);
    // Whatever trees this run asked about, answered clean - the sweep agents' part of
    // the pass, without which it cannot be accepted.
    for (const artifact of Object.keys(made.state.paths.sweeps ?? {})) {
      swept(made.state, artifact);
    }
    handBack(made.work, () =>
      out.phase.name === "verify"
        ? "reported"
        : out.phase.name === "settle"
          ? "cleared"
          : "Clear"
    );
    take(made);
  }
  throw new Error(`never closed: ${seen.join(", ")}`);
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
    const made = review(tmp(), { ...holds, sweep: true });
    assert.deepEqual(phasesOf(made).seen, expected, JSON.stringify(holds));
  }
});

// Every combination of the two skips, over a review that holds something for every
// phase - so what drops out is the FLAG's doing and nothing else.
//
//   llm-skip-summary -> the description agent, and the link that hands it over
//   llm-skip-sweep   -> the sweep agent, the wait, and the rows it would have filled
test("every combination of the skips issues exactly the phases it should", () => {
  const SKIPS = ["llm-skip-summary", "llm-skip-sweep"];
  for (let bits = 0; bits < 4; bits++) {
    const skip = SKIPS.filter((_, i) => bits & (1 << i));
    const sweeps = !skip.includes("llm-skip-sweep");
    const made = review(tmp(), { sweep: sweeps });
    made.state.run = {
      skip: skip.filter((x) => x !== "llm-skip-sweep"),
      sca: false,
      ...(sweeps ? { "sweep-xpi": true } : {}),
    };
    // --llm-skip-sweep writes no request, so there is no file for a step to name and
    // none for the pass to read back.
    if (!sweeps) {
      delete made.state.paths.sweeps;
    }
    // A file is NAMED only where the step that writes it prints, as the pipeline names it:
    // --llm-skip-summary spawns no description agent, so there is no description to link.
    if (skip.includes("llm-skip-summary")) {
      made.state.paths.description = null;
    }
    // `spawn` runs only where it starts an agent (the linter extracts the package before
    // the review is printed), so a run that skips the summary agent and does not sweep
    // has nothing left to spawn.
    const expected = [
      ...(!skip.includes("llm-skip-summary") || sweeps ? ["spawn"] : []),
      "verify",
      "settle",
      "ask",
    ];
    const { seen, closing } = phasesOf(made);
    const where = `skips: ${skip.join(",") || "none"}`;
    assert.deepEqual(seen, expected, where);

    // The block ends EVERY settled review, whether or not `ask` showed the same
    // one earlier. That copy was for answering the questions with, and by the time they are
    // answered it is far above the reviewer - while the report they are about to send, and
    // the package it is about, are rows in this one.
    //
    // Written for a chat: a list of links, then what the verdicts mean anything against.
    const details = flat(closing.text);
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
  const made = review(tmp(), { sweep: false, findings: false });
  // Nothing for spawn to start either, so `settle` is the phase in flight.
  made.state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  // spawn has nothing to start in this config and is never issued - marked done here
  // anyway, so this test starts where it means to.
  made.state.issued = ["spawn"];
  assert.equal(pass(made).phase.name, "settle");
  handBack(made.work, () => "ask");
  take(made);

  const out = pass(made);
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
// THEIR answer settles it. Driven to the close, not only through `accept`, because accept
// takes the answer on the phase's word - the phase that asked declares no verbs, so any
// words are legal there - and it is applying it that has to know a person answered. A test
// stopping at accept passes while the review still refuses the reviewer at the close.
test("a case sent on with `ask` is settled by the reviewer's own answer", () => {
  const made = review(tmp(), { sweep: false, findings: false });
  made.state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  // Marked done so this test starts where it means to - spawn has nothing to start here
  // anyway.
  made.state.issued = ["spawn"];

  const sent = pass(made);
  assert.equal(sent.phase.name, "settle");
  // The case the agent gives up on, by the reference it keeps.
  const moved = sent.entries[0].index;
  handBack(made.work, () => "ask");
  take(made);

  const out = pass(made);
  assert.equal(out.phase.name, "ask");
  assert.ok(
    out.entries.some((e) => e.index === moved),
    "the moved case is asked under the reference the agent saw"
  );
  const [clear, report] = REGISTRY.manualReviewChoices().map((c) => c.label);
  handBack(made.work, (e) => (e.index === moved ? report : clear));
  take(made);

  // The reviewer's label reaches applyVerdicts as a reviewer's answer. Reading the section
  // it was filed under instead would demand a verb here and refuse them.
  const closing = pass(made);
  assert.equal(closing.issued, "close");
  const { applied, findings, manual } = closing.settled;
  assert.ok(
    applied.some((line) => line.startsWith(`${moved} reported`)),
    `the reviewer's "${report}" settled it: ${applied.join(", ")}`
  );
  assert.ok(
    findings.some((f) => f.ruleId === "unknown-api"),
    "a reported case becomes a finding of its own check"
  );
  // And the two the reviewer cleared leave nothing behind.
  assert.deepEqual(manual, []);
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
  const made = review(tmp(), {
    sweep: false,
    findings: false,
    code: false,
  });
  made.state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  // Marked done so this test starts where it means to - spawn has nothing to start here
  // anyway.
  made.state.issued = ["spawn"];
  // Real check ids, because a reported case becomes a finding of its own check and takes
  // the severity that check declares.
  made.state.manual.forEach((m, i) => {
    m.ruleId = ["testing-information", "no-surprises-policy"][i];
  });
  refed(made.state);

  const out = pass(made);
  assert.equal(out.phase.name, "ask");
  handBack(made.work, () => "ask");
  take(made);

  assert.ok(
    made.state.manual.every((m) => m.askedIn === undefined),
    "nobody was moved"
  );
  assert.deepEqual(
    made.state.answers,
    Object.fromEntries(made.state.manual.map((m) => [m.ref, "ask"])),
    "both were answered"
  );
  const closing = pass(made);
  assert.equal(closing.phase.name, "close", "and it is over");

  // Their word reports the case and travels with it, like any other answer they type.
  const { applied } = closing.settled;
  assert.ok(
    applied.every((line) => line.includes("reported + note")),
    applied.join(", ")
  );
});

// ---- the early exit ----

/** How a source review's build question is answered where a test does not say otherwise:
 *  the source builds and reproduces the XPI. */
const BUILDS = {
  built: "Builds and reproduces",
};

/**
 * Drive the whole loop, answering each phase, to its close or its restart prompt, and
 * report which phases were issued beside that last prompt.
 * @param {object} made
 * @param {(phase: string) => string} answer
 * @returns {{seen: string[], closing: object, settled: object}}
 */
function driveLoop(made, answer, reg = REGISTRY) {
  const seen = [];
  // `ask` takes a REVIEWER's answer, not a verb: the phase that asks declares none, and
  // handing it one would be refused where it is applied rather than where it is taken.
  const [clear] = REGISTRY.manualReviewChoices().map((c) => c.label);
  for (let p = 0; p < 8; p++) {
    const out = pass(made, reg);
    if (out.issued !== "prompt") {
      return { seen, closing: out, settled: out.settled };
    }
    seen.push(out.phase.name);
    handBack(made.work, () =>
      out.phase.name === "ask"
        ? clear
        : (BUILDS[out.phase.name] ?? answer(out.phase.name))
    );
    take(made, reg);
  }
  throw new Error(`never closed: ${seen.join(", ")}`);
}

/** Whether a settled review was aborted, early or late. */
const aborted = (settled) => Boolean(settled.exits.late);

/** The review above, with its findings reported by a check that aborts the review early. */
function blockingReview(dir) {
  const made = review(dir, { sweep: false });
  for (const f of made.state.report.findings) {
    f.ruleId = "experiment-not-allowed";
  }
  made.state.run = { skip: [], sca: true, sweep: false };
  return made;
}

// A review the deterministic checks aborted early asks nothing at all: what it hands over is
// decided before any pass, so its first prompt is the closing one - no preamble, no agent
// started, nothing verified or settled - and it names no file an agent was never asked to
// write.
test("a blocking finding closes the review on its first prompt", () => {
  const dir = tmp();
  const made = blockingReview(dir);
  made.state.report.meta.summaryFile = path.join(dir, "summary.md");
  made.state.report.meta.buildFile = path.join(dir, "build.md");
  const first = pass(made);
  assert.equal(first.issued, "close");
  assert.equal(first.phase.name, "close");
  assert.equal(first.preamble, 0);
  assert.ok(first.steps[0].first.startsWith("The review was aborted"));
  assert.ok(
    !first.steps.some((step) => step.first.includes("Wait for every agent")),
    "no agent was started to wait for"
  );
  assert.equal(aborted(first.settled), true);
  assert.ok(first.settled.exits.early, "aborted early");
  const text = flat(first.text);
  assert.ok(text.includes("0 extended code review item(s)"), text);
  assert.ok(!text.includes("summary.md"), text);
  assert.ok(!text.includes("build.md"), text);
  assert.ok(text.includes("\n- Experiment APIs not accepted\n"), text);
});

// The Review Details block goes out in `ask`, before its questions - and only where they
// are put: not in an aborted review.
test("the details block is handed over by the ask phase, before its questions", () => {
  const blocks = (made) => {
    const shown = [];
    for (let p = 0; p < 10; p++) {
      const out = pass(made);
      if (out.phase.answer === "end") {
        break;
      }
      if (out.text.includes("* XPI_FILE: ")) {
        shown.push(out.phase.name);
      }
      handBack(made.work, () => {
        if (BUILDS[out.phase.name]) {
          return BUILDS[out.phase.name];
        }
        if (out.phase.name === "verify") {
          return "withdrawn";
        }
        return out.phase.name === "settle" ? "cleared" : "Clear";
      });
      take(made);
    }
    return shown;
  };
  assert.deepEqual(blocks(review(tmp(), { sweep: false })), ["ask"]);

  const made = blockingReview(tmp());
  const { seen } = driveLoop(made, (phase) =>
    phase === "verify" ? "reported" : "cleared"
  );
  assert.ok(!seen.includes("ask"), seen.join(", "));
});

// The review ends with the closing phase, which carries the settled review and opens on
// what happened to it: settled, or aborted. Nothing is handed back after it.
test("the closing phase opens on how the review ended, and takes nothing back", () => {
  // The same review, its findings reported by checks that abort nothing.
  const ran = review(tmp(), { sweep: false });
  ran.state.run = { skip: [], sca: true, sweep: false };
  const { closing: settledClose } = driveLoop(ran, (phase) =>
    phase === "verify" ? "reported" : "cleared"
  );
  assert.ok(settledClose.steps[0].first.startsWith("The review is settled."));
  assert.equal(aborted(settledClose.settled), false);
  assert.throws(
    () => take(ran),
    /nothing is handed back after its closing prompt/
  );

  const abortedReview = blockingReview(tmp());
  const { closing: abortedClose } = driveLoop(abortedReview, (phase) =>
    phase === "verify" ? "reported" : "cleared"
  );
  assert.ok(abortedClose.steps[0].first.startsWith("The review was aborted"));
  assert.equal(aborted(abortedClose.settled), true);
  // The same hand-over either way: the abort rides in the details block.
  const handover = (close) =>
    close.steps.find((step) => step.first.startsWith("Give the reviewer"))
      .first;
  assert.equal(handover(abortedClose), handover(settledClose));
  assert.ok(
    flat(abortedClose.text).includes("\n- Experiment APIs not accepted\n")
  );
});

// A review with nothing to do at all still closes: its first pass is the closing one.
test("a review with no other work is closed on its first pass", () => {
  const made = review(tmp(), {
    sweep: false,
    findings: false,
    code: false,
    questions: false,
  });
  made.state.run = { skip: ["llm-skip-summary"], sca: false };
  const out = pass(made);
  assert.equal(out.phase.name, "close");
  assert.ok(out.settled, "it carries the settled review");
  assert.deepEqual(made.record.current, {
    mode: MODE.review,
    phase: "close",
  });
});

/** The Review Details block a closing prompt printed, its lines without their indent: from
 *  its XPI_FILE row to the last line before the next step. */
function closingDetails(closing) {
  const step = closing.steps.find((s) =>
    s.lines.some((line) => line.startsWith("* XPI_FILE: "))
  );
  const lines = step.lines.slice(
    step.lines.findIndex((line) => line.startsWith("* XPI_FILE: "))
  );
  while (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

// Whether the review was aborted is a fact about the review, so the hand-over carries it
// too - not just the developer's text. It rides in the details block, because only the
// block can list the reasons that aborted THIS review.
test("an aborted review closes its details block with the reason", () => {
  const made = blockingReview(tmp());
  const { closing } = driveLoop(made, (phase) =>
    phase === "verify" ? "reported" : "cleared"
  );
  const lines = closingDetails(closing);
  assert.ok(
    lines[0].startsWith("* XPI_FILE: "),
    "the block is still the block"
  );
  assert.equal(
    lines.at(-2),
    "The review was not completed and the report is incomplete due to the following issues:"
  );
  assert.equal(lines.at(-1), "- Experiment APIs not accepted");

  // ... and a review that ran to the end closes with the block itself. Nothing says a
  // review was aborted unless one was.
  const clean = review(tmp(), { sweep: false });
  const ran = driveLoop(clean, (phase) =>
    phase === "verify" ? "reported" : "cleared"
  );
  const block = closingDetails(ran.closing).join("\n");
  assert.ok(!block.includes("review was not completed"), block);
  assert.match(block, /^schema /m, "and ends where it always did");
});

// What an aborted review hands the reviewer: the closing line in the developer's text, and
// no to-do item - neither the questions nobody was asked nor the code-review cases nobody
// settled - so the tally does not advertise work nobody was asked to do.
test("an aborted review hands over the reason and drops the questions", () => {
  const made = blockingReview(tmp());
  const { closing, settled } = driveLoop(made, (phase) =>
    phase === "verify" ? "reported" : "cleared"
  );
  assert.ok(settled.report.includes("The review was not completed"));
  assert.ok(settled.report.includes("- Experiment APIs not accepted"));
  const text = flat(closing.text);
  assert.ok(text.includes("0 extended manual review item(s)"), text);
  assert.ok(text.includes("0 standard manual review item(s)"), text);
  assert.ok(text.includes("0 extended code review item(s)"), text);
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
  const made = lateReview(tmp());
  const { seen, closing } = driveLoop(made, (phase) =>
    phase === "verify" ? "reported" : "cleared"
  );
  assert.deepEqual(seen, ["spawn", "verify", "settle"]);
  assert.equal(closing.phase.name, "close");
  assert.equal(aborted(closing.settled), true);
  assert.equal(
    closingDetails(closing).at(-1),
    "- Code that cannot be reviewed"
  );
  assert.ok(
    flat(closing.text).includes("0 standard manual review item(s)"),
    "no to-do item is handed over"
  );
});

// Verify runs before a late abort is decided, so a finding it withdrew aborts nothing: the
// questions are asked, and the review closes settled.
test("a late-exit finding verify withdrew aborts nothing", () => {
  assert.equal(REGISTRY.lateExitFor("minified-code"), "unreviewable-code");
  const made = lateReview(tmp());
  const { seen, closing } = driveLoop(made, (phase) =>
    phase === "verify" ? "withdrawn" : "cleared"
  );
  assert.deepEqual(seen, ["spawn", "verify", "settle", "ask"]);
  assert.equal(aborted(closing.settled), false);
});

// ---- a case sent on to a phase of its own (`sent-on-to`) ----

/** Make the fixture's code-review case a privacy-policy case, as its check renders it. */
function asPolicyCase(made) {
  const id = "privacy-policy";
  Object.assign(
    made.state.manual.find((m) => m.ruleId === "unknown-api"),
    {
      ruleId: id,
      item: "api.example.com",
      settleVerbs: REGISTRY.settleVerbsFor(id),
      sentOnTo: REGISTRY.sentOnTo(id),
      sentOnInstruction: REGISTRY.sentOnInstruction(id),
    }
  );
  refed(made.state);
  return made;
}

/** The small review holding one privacy-policy case and nothing else to answer. */
function policyReview(dir) {
  const made = review(dir, { sweep: false, findings: false, questions: false });
  made.state.run = { skip: ["llm-skip-summary"], sca: false, sweep: false };
  // spawn has nothing to start here: marked done so the review opens at settle.
  made.state.issued = ["spawn"];
  return asPolicyCase(made);
}

// A privacy-policy case the agent sends on from settle is judged next against the policy the
// reviewer pastes: it carries the instruction written for that phase, and is offered that
// phase's answers, not the ones settle narrowed it to. What the policy does not let the agent
// tell goes on to `ask`, and the reviewer answers it there.
test("a privacy-policy case sent on from settle is judged against the pasted policy, then asked", () => {
  const made = policyReview(tmp());
  const settle = pass(made);
  assert.equal(settle.phase.name, "settle");
  assert.deepEqual(
    settle.entries[0].answers.map((a) => a.label),
    ["cleared", "ask"]
  );
  handBack(made.work, () => "ask");
  take(made);

  const policy = pass(made);
  assert.equal(policy.phase.name, "privacy-policy");
  assert.equal(policy.entries.length, 1);
  const [entry] = policy.entries;
  assert.equal(entry.index, settle.entries[0].index);
  assert.equal(entry.item, "api.example.com");
  assert.equal(
    entry.instructions,
    REGISTRY.sentOnInstruction("privacy-policy")
  );
  assert.deepEqual(
    entry.answers.map((a) => a.label),
    ["reported", "cleared", "ask"]
  );
  handBack(made.work, () => "ask");
  take(made);

  const ask = pass(made);
  assert.equal(ask.phase.name, "ask");
  assert.deepEqual(
    ask.entries.map((e) => e.index),
    [entry.index]
  );
});

// What the agent settles against the policy is settled: `ask` puts nothing of it to anyone,
// and a review whose cases settle cleared is never asked for the policy at all.
test("a privacy-policy case settled against the policy never reaches ask", () => {
  for (const [verdict, reported] of [
    ["reported", true],
    ["cleared", false],
  ]) {
    const { seen, settled } = driveLoop(policyReview(tmp()), (phase) =>
      phase === "settle" ? "ask" : verdict
    );
    assert.deepEqual(seen, ["settle", "privacy-policy"], verdict);
    assert.equal(
      settled.findings.some((f) => f.ruleId === "privacy-policy"),
      reported,
      verdict
    );
    assert.deepEqual(settled.manual, [], verdict);
  }
  const { seen } = driveLoop(policyReview(tmp()), () => "cleared");
  assert.deepEqual(seen, ["settle"]);
});

// A review a late exit ends asks the reviewer nothing, and a request for the policy is a
// question to them: it halts before that phase as before `ask`.
test("a late-exit finding halts the review before the privacy-policy phase", () => {
  const made = asPolicyCase(lateReview(tmp()));
  made.state.manual = made.state.manual.filter((m) => m.extended);
  refed(made.state);
  const { seen, closing } = driveLoop(made, (phase) =>
    phase === "verify" ? "reported" : "ask"
  );
  assert.deepEqual(seen, ["spawn", "verify", "settle"]);
  assert.equal(aborted(closing.settled), true);
});

/** The small review as a source review aborted by one error finding of each check in
 *  `ruleIds`, whose XPI could be reviewed on its own or not: the early-exit run's
 *  `xpiReviewable` in the record's permanent part. */
function abortedScaReview(dir, ruleIds, { reviewable = true } = {}) {
  const made = review(dir, { sweep: false, code: false, questions: false });
  made.record.kind = "sca";
  made.record.xpiReviewable = reviewable;
  made.state.report.sca = true;
  made.state.report.findings = ruleIds.map((ruleId, i) => ({
    ruleId,
    severity: "error",
    file: null,
    loc: null,
    artifact: ruleId === "experiment-not-allowed" ? ARTIFACT_XPI : ARTIFACT_SCA,
    message: `finding ${i}`,
  }));
  made.state.run = { skip: [], sca: true };
  refed(made.state);
  return made;
}

/**
 * Drive the loop until it issues the restart prompt or its close, answering each phase
 * plainly: verify keeps every finding, every other phase clears. Returns that prompt and the
 * phases before it.
 */
function untilEnd(made) {
  const { seen, closing } = driveLoop(made, (phase) =>
    phase === "verify" ? "reported" : "cleared"
  );
  return { out: closing, seen };
}

// A source review aborted only by a fault of its archive, whose XPI is readable, is asked
// whether to restart as an XPI review. Its archive faults abort it late, so the question
// comes once the review has run to the end of settle. The restart prompt is no phase of the
// loop: the review ends, is added to the record's permanent part, and the record is put in
// mode downgrade with no body. The prompt shows the aborted review's closing block, ends the
// turn, and then puts the question, which names what aborted the review.
test("a source review aborted by its archive, with a readable XPI, issues the restart prompt", () => {
  const made = abortedScaReview(tmp(), ["sca-package-file-missing"]);
  const { out: first, seen } = untilEnd(made);
  assert.equal(first.issued, "restart");
  assert.equal(first.phase.name, "downgrade");
  assert.deepEqual(made.record.current, {
    mode: MODE.downgrade,
    step: "downgrade",
  });
  assert.ok(made.record.review.report, "the review is the permanent part's");
  assert.equal(seen.at(-1), "verify", seen.join(", "));
  assert.equal(aborted(first.settled), true);
  const text = flat(first.text);
  // The aborted review's tally, none of its to-do items, and its details ending on what
  // aborted it, followed by the line saying the review waits for the reviewer.
  assert.ok(
    text.includes(
      summaryBodyLines(first.settled.findings, [], null).join("\n")
    ),
    text
  );
  assert.ok(
    text.includes(
      "- Build process issues\n\n" +
        REGISTRY.llmPhases().waiting("downgrade", 1)
    ),
    text
  );
  const [entry] = first.entries;
  assert.equal(
    entry.message,
    "The SCA review failed for build process issues, but it looks like this " +
      "submission does not actually need an SCA review. The XPI is not minified and " +
      "could be reviewed directly. Should the review be restarted as a pure XPI review?"
  );
  assert.deepEqual(
    entry.answers.map((a) => a.label),
    ["Restart as an XPI review", "Keep this result"]
  );
});

// Not where the XPI cannot be reviewed on its own, and not where any aborting check is one
// a review of the XPI does not cure: the review closes as it does without the question. The
// same review, readable and aborted by its archive alone, is asked. An early abort closes on
// the first prompt, the others once the agent's passes are done.
test("the restart prompt is not issued for an unreadable XPI or an abort the XPI shares", () => {
  const asked = abortedScaReview(tmp(), ["sca-package-file-missing"]);
  assert.equal(untilEnd(asked).out.issued, "restart");
  for (const [ruleIds, opts, before] of [
    [["sca-package-file-missing"], { reviewable: false }, "verify"],
    [["sca-package-file-missing", "experiment-not-allowed"], {}, undefined],
    [["sca-package-file-missing", "vendor-vulnerable-indirect"], {}, "verify"],
  ]) {
    const made = abortedScaReview(tmp(), ruleIds, opts);
    const { out, seen } = untilEnd(made);
    assert.equal(out.issued, "close", ruleIds.join(" "));
    assert.equal(seen.at(-1), before, `${ruleIds.join(" ")}: ${seen}`);
  }
});

// The cases a source review gets for the shape of its archive: a copy of the XPI with no
// lock is asked about the restart, as both faults are the archive's. Code a reviewer cannot
// read keeps it from being asked, whether the XPI cannot be read on its own or the
// unreadable file is the archive's alone (a minified file under tests/ that verify kept).
test("an archive holding the XPI and no lock is offered the restart, unreadable code is not", () => {
  const shape = ["sca-xpi-fully-included-in-archive", "sca-lock-file-missing"];
  const offered = abortedScaReview(tmp(), shape);
  const { out } = untilEnd(offered);
  assert.equal(out.issued, "restart");
  assert.equal(aborted(out.settled), true);

  const unreadableXpi = abortedScaReview(tmp(), shape, { reviewable: false });
  assert.equal(untilEnd(unreadableXpi).out.issued, "close");

  const dir = tmp();
  const archiveOnly = abortedScaReview(dir, [...shape, "minified-code"]);
  asSource(archiveOnly, sourceFolders(path.join(dir, "sca")));
  const minified = archiveOnly.state.report.findings.at(-1);
  minified.file = "tests/fixture.min.js";
  assert.equal(untilEnd(archiveOnly).out.issued, "close");
});

// A source review that did not abort is never asked, whatever its XPI. The restart prompt is
// the registry's own (llmPhases().restart), and no phase of the loop.
test("a review that did not abort never sees the restart prompt", () => {
  assert.ok(!PHASES.some((phase) => phase.name === "downgrade"));
  assert.equal(REGISTRY.llmPhases().restart.name, "downgrade");
  const made = review(tmp(), { sweep: false });
  made.record.kind = "sca";
  made.record.xpiReviewable = true;
  made.state.report.sca = true;
  made.state.run = { skip: [], sca: true };
  const { seen, closing } = driveLoop(made, (phase) =>
    phase === "verify" ? "reported" : "cleared"
  );
  assert.ok(!seen.includes("downgrade"), seen.join(" "));
  assert.equal(closing.issued, "close");
  assert.equal(aborted(closing.settled), false);
});

// "Keep this result": the reviewer's answer is read against the review the permanent part
// holds, and the review closes aborted, with its aborted line, and the close does not show
// the Summary and the Final Review Details a second time.
test("keeping the result closes the review aborted, without its block again", () => {
  const made = abortedScaReview(tmp(), ["sca-package-file-missing"]);
  assert.equal(untilEnd(made).out.issued, "restart");
  handBack(made.work, () => "Keep this result");
  const record = readRecord(made.work);
  const answer = restartAnswer(made.work, record, REGISTRY);
  assert.equal(answer, "keep");
  const settled = settleReview(
    record.review,
    record.review.answers ?? {},
    REGISTRY
  );
  const { value, text } = printed(() =>
    closeAt(made.work, record, settled, REGISTRY, { downgrade: answer })
  );
  made.record = readRecord(made.work);
  const closing = issuedPrompt(made, value, text, REGISTRY);
  assert.equal(closing.issued, "close");
  assert.deepEqual(made.record.current, {
    mode: MODE.review,
    phase: "close",
  });
  assert.equal(aborted(closing.settled), true);
  assert.ok(closing.steps[0].first.startsWith("The review was aborted"));
  const shown = flat(closing.text);
  assert.ok(!shown.includes("* XPI_FILE: "), "the details are not shown again");
  assert.ok(!shown.includes("extended code review item(s)"), "nor the tally");
});

// An answer to the restart prompt that is none of its labels is refused.
test("the restart prompt refuses an answer it does not offer", () => {
  const made = abortedScaReview(tmp(), ["sca-package-file-missing"]);
  assert.equal(untilEnd(made).out.issued, "restart");
  handBack(made.work, () => "Restart it");
  assert.throws(
    () => restartAnswer(made.work, readRecord(made.work), REGISTRY),
    (err) =>
      err instanceof HandbackRefused &&
      err.problem.includes('answers "Restart it"')
  );
  handBack(made.work, () => "Restart as an XPI review");
  assert.equal(
    restartAnswer(made.work, readRecord(made.work), REGISTRY),
    "xpi"
  );
});

/** The small review as a source code review whose build checks all ran: the build
 *  phases' paths named, as the pipeline names them for one. */
function buildReview(dir) {
  const made = review(dir, { sweep: false });
  made.state.run = { skip: [], sca: true, "build-guarded": true };
  made.state.paths.build = path.join(dir, "build.md");
  made.state.report.meta.buildFile = made.state.paths.build;
  asSource(made, sourceFolders(path.join(dir, "sca")));
  return made;
}

/**
 * The source review above, carrying two build items as the pipeline renders them: an
 * install hook (build-lifecycle-hook) for the agent to settle, and the build question,
 * naming the phase it is asked in (`asked-in`).
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
  asSource(made, sourceFolders(path.join(dir, "src")));
  made.state.manual.push(
    todo("build-lifecycle-hook", {
      section: "code-review",
      llmInstructions: "read the hook",
      settleVerbs: ["reported", "cleared"],
    }),
    todo("build-reproduces-xpi", { section: "manual-review" })
  );
  refed(made.state);
  return made;
}

/**
 * Drive the loop to its close, answering each phase with `answer(phase, entry)`. Returns the
 * phases issued, the rules each one handed out, the closing prompt and its settled review.
 */
function driveBuild(made, answer) {
  const seen = [];
  const handed = {};
  for (let p = 0; p < 12; p++) {
    const out = pass(made);
    if (out.issued !== "prompt") {
      return { seen, handed, closing: out, settled: out.settled };
    }
    seen.push(out.phase.name);
    handed[out.phase.name] = out.entries.map(
      (e) => ruleAt(made, e.index) ?? e.index
    );
    handBack(made.work, (e) => answer(out.phase.name, e));
    take(made);
  }
  throw new Error(`never closed: ${seen.join(", ")}`);
}

/** The build question's answer that lets the review go on, whichever the entry offers: after
 *  a self-build "Builds and reproduces", after an agent's build the override. */
const buildGoesOn = (e) =>
  (e?.answers ?? []).some((a) => a.label === BUILDS.built)
    ? BUILDS.built
    : "The XPI was correctly reproduced [override]";

/** Every phase answered the way a review that goes on answers it. */
const goesOn =
  (overrides = {}) =>
  (phase, e) =>
    overrides[phase]?.(e) ??
    (phase === "built" ? buildGoesOn(e) : BUILDS[phase]) ??
    (phase === "verify"
      ? "withdrawn"
      : phase === "settle"
        ? "cleared"
        : "Clear");

/** The reference of the build to-do in this review. */
function buildTodoRef(made) {
  const held = reviewOf(made);
  return orderReview(held.report.findings, held.manual).find(
    (x) => x.target.ruleId === "build-reproduces-xpi"
  ).ref;
}

/** The rule behind one reference in this review. */
function ruleAt(made, ref) {
  const held = reviewOf(made);
  return orderReview(held.report.findings, held.manual).find(
    (x) => x.ref === ref
  )?.target?.ruleId;
}

// A source review opens with its build: the reviewer reads the Build Review Details, and the
// build question follows in a phase of its own so it is put to the reviewer ALONE - all
// before the sweeps and the verify and settle passes. "Builds and reproduces" clears the build to-do and lets the review go on.
test("a source review opens with the build, and its questions come before the sweeps", () => {
  const made = buildQuestionsReview(tmp());
  const todo = buildTodoRef(made);
  const { seen, handed, settled } = driveBuild(made, goesOn());
  assert.deepEqual(seen, ["built", "spawn", "verify", "settle", "ask"]);
  const done = made.record.review;
  assert.deepEqual(done.values, { built: "reproduces" });
  assert.ok(
    !Object.values(done.answers).includes("reproduces"),
    "a process value is not an answer"
  );
  assert.deepEqual(handed.built, ["built"]);
  assert.equal(done.answers[todo], "cleared", "its to-do is cleared");
  const asked = handed.ask;
  assert.ok(!asked.includes("build-reproduces-xpi"), asked.join(", "));
  assert.ok(
    handed.settle.includes("build-lifecycle-hook"),
    "the agent settles the install hook"
  );
  assert.equal(aborted(settled), false);
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
  for (let p = 0; p < 12; p++) {
    const out = pass(made);
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
    take(made);
  }
  assert.ok("built" in entries, "the build question was issued");
  for (const [phase, rules] of Object.entries(entries)) {
    if (phase !== "built") {
      assert.ok(!rules.includes("build-reproduces-xpi"), phase);
    }
  }
});

/** Drive the loop until it issues `phase`, answering each phase before it as the build
 *  question's fixture goes on. Returns that pass. */
function untilPhase(made, phase) {
  for (let p = 0; p < 4; p++) {
    const out = pass(made);
    if (out.phase.name === phase) {
      return out;
    }
    handBack(made.work, () => BUILDS[out.phase.name]);
    take(made);
  }
  throw new Error(`${phase} was never issued`);
}

// Each answer but "Builds and reproduces" aborts the review for build issues, late: the
// sweeps, verify and settle still run, the questions still pending are never put, and the
// report ends on why. Its own check is the one build finding, carrying that check's response,
// and the build to-do is cleared rather than reported beside it. The finding is the
// reviewer's answer, so a verify that withdraws everything leaves it standing. Words a
// reviewer typed instead of a label are refused.
test("each build answer that stops the review reports its own check", () => {
  for (const [said, rule] of [
    ["The built add-on does not match the submitted XPI", "build-not-reproduced"],
    ["The build failed", "build-fails"],
  ]) {
    const made = buildQuestionsReview(tmp());
    const { seen, closing, settled } = driveBuild(
      made,
      goesOn({ built: () => said })
    );
    assert.ok(seen.includes("spawn"), `${said}: ${seen.join(", ")}`);
    assert.ok(!seen.includes("ask"), `${said}: ${seen.join(", ")}`);
    assert.equal(aborted(settled), true, said);
    assert.ok(closing.steps[0].first.startsWith("The review was aborted"));
    assert.ok(settled.report.includes("- Build process issues"));
    assert.deepEqual(
      settled.findings
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
      settled.manual
        .map((m) => m.ruleId)
        .filter((id) => id.startsWith("build-")),
      [],
      "no build question is left listed"
    );
  }

  const made = buildQuestionsReview(tmp());
  untilPhase(made, "built");
  handBack(made.work, () => "npm run build fails");
  assert.throws(
    () => take(made),
    /answers "npm run build fails", which this entry does not accept/
  );
});

// Whether the build is safe was the reviewer's decision in the build check, so the build
// question asks the outcome only: "Is unsafe to build" is no answer of it, and handed back
// anyway is refused, with nothing recorded.
test("the build question offers no 'Is unsafe to build'", () => {
  const made = buildQuestionsReview(tmp());
  untilPhase(made, "built");
  const before = JSON.stringify(made.record);
  handBack(made.work, () => "Is unsafe to build");
  assert.throws(
    () => take(made),
    /answers "Is unsafe to build", which this entry does not accept/
  );
  assert.equal(JSON.stringify(made.record), before, "nothing is recorded");
});

// The build question is a process value put while the build to-do is open. A review whose
// build check did not run holds no such to-do, so the question has nothing to put and is
// not issued, and the review goes on without the value.
test("the build question is issued only while its to-do is open", () => {
  const asked = buildQuestionsReview(tmp());
  const ran = driveBuild(asked, goesOn());
  assert.ok(ran.seen.includes("built"), ran.seen.join(", "));
  assert.equal(asked.record.review.values.built, "reproduces");

  const made = buildQuestionsReview(tmp());
  made.state.manual = made.state.manual.filter(
    (m) => m.ruleId !== "build-reproduces-xpi"
  );
  const { seen } = driveBuild(made, goesOn());
  assert.ok(!seen.includes("built"), seen.join(", "));
  assert.ok(seen.includes("spawn"), seen.join(", "));
  assert.equal(made.record.review.values?.built, undefined);
});

// A source no build can be made from asks nobody to build it: a finding of a check marked
// `review-unbuildable` (here the missing lock), or a failed rescue, skips the build question,
// and the review goes straight on to its passes and is aborted late. A source the review
// rejects but that can be built - a vulnerable tree with its lock - is still asked, with
// the vulnerabilities in the details its reviewer reads first.
test("an unbuildable source skips the build question, a buildable rejected one does not", () => {
  const withFinding = (ruleId) => {
    const made = buildQuestionsReview(tmp());
    made.state.report.findings.push({
      ruleId,
      severity: "error",
      file: "package.json",
      loc: null,
      artifact: ARTIFACT_SCA,
      message: ruleId,
    });
    refed(made.state);
    return made;
  };
  // A failed rescue leaves the vulnerable tree it could not fix, which alone is buildable:
  // the failed rescue is what makes it unbuildable. So does a rescue whose build did not
  // reproduce the XPI: the vulnerable code may ship, and nobody is asked to build it.
  const failed = withFinding("vendor-vulnerable-dev");
  failed.record.build = { result: "rescue-failed" };
  const mismatched = withFinding("vendor-vulnerable-dev");
  mismatched.record.build = { result: "rescue-mismatch" };
  for (const made of [
    withFinding("sca-lock-file-missing"),
    failed,
    mismatched,
  ]) {
    const { seen, settled } = driveBuild(
      made,
      goesOn({ verify: () => "reported" })
    );
    assert.ok(!seen.includes("built"), seen.join(", "));
    assert.equal(seen[0], "spawn", seen.join(", "));
    assert.ok(!seen.includes("ask"), seen.join(", "));
    assert.equal(made.record.review.values?.built, undefined);
    assert.equal(aborted(settled), true);
  }
  const buildable = withFinding("vendor-vulnerable-dev");
  const { seen, settled } = driveBuild(
    buildable,
    goesOn({ verify: () => "reported" })
  );
  assert.equal(seen[0], "built", seen.join(", "));
  assert.ok(!seen.includes("ask"), seen.join(", "));
  assert.equal(aborted(settled), true);
});

// The build check built nothing on an unreadable lock, one installing from a source the audit
// cannot read, or one declaring a package nobody can review, so the agent may not withdraw
// that finding: it opens in no verify, and the build question stays skipped, however the
// agent would have answered.
test("a finding that stopped the build check is not verified, and the build is not asked", () => {
  const registry = loadRegistry();
  for (const ruleId of [
    "sca-lock-file-invalid",
    "lock-foreign-source",
    "unpopular-source-dependency",
  ]) {
    assert.equal(registry.unbuildable(ruleId), true, ruleId);
    assert.equal(registry.verifiedByLlm(ruleId), false, ruleId);
    const made = buildQuestionsReview(tmp());
    made.state.report.findings.push({
      ruleId,
      severity: "error",
      file: "package-lock.json",
      loc: null,
      artifact: ARTIFACT_SCA,
      message: ruleId,
      llmVerification: false,
    });
    refed(made.state);
    const { seen, handed, settled } = driveBuild(
      made,
      goesOn({ verify: () => "withdrawn" })
    );
    assert.ok(!(handed.verify ?? []).includes(ruleId), handed.verify);
    assert.ok(!seen.includes("built"), seen.join(", "));
    assert.equal(aborted(settled), true);
  }
});

// An install hook is still settled in `settle`, after the build, and reported there it
// still aborts the review.
test("an install hook reported in settle aborts the review", () => {
  const made = buildQuestionsReview(tmp());
  const { seen, settled } = driveBuild(
    made,
    goesOn({
      settle: (e) =>
        ruleAt(made, e.index) === "build-lifecycle-hook"
          ? "reported"
          : "cleared",
    })
  );
  assert.deepEqual(seen.slice(-3), ["spawn", "verify", "settle"]);
  assert.equal(aborted(settled), true);
  assert.ok(settled.findings.some((f) => f.ruleId === "build-lifecycle-hook"));
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
  assert.equal(made.record.review.answers[todo], "cleared");
});

// The agent's `ask` verdict moves the case itself, found by its reference. A verdict that
// removes an earlier item renumbers nothing, and once the review is aborted no to-do item is
// handed over, the routed case among them.
test("a case sent on with ask is dropped by an abort even after an earlier item is cleared", () => {
  const made = buildQuestionsReview(tmp());
  made.state.manual.unshift({
    ...made.state.manual[0],
    ruleId: "unknown-api",
    instructions: "cleared first",
    settleVerbs: ["reported", "cleared", "ask"],
    ref: null,
  });
  refed(made.state);
  const instructionsAt = (ref) =>
    made.state.manual.find((m) => m.ref === ref)?.instructions;
  const { closing, settled } = driveBuild(
    made,
    goesOn({
      settle: (e) =>
        instructionsAt(e.index) === "settle me" ? "ask" : "cleared",
      built: () => "The build failed",
    })
  );
  assert.equal(aborted(settled), true);
  const routed = made.record.review.manual.find(
    (m) => m.instructions === "settle me"
  );
  assert.equal(routed.askedIn, "ask", "the routed case is the one moved");
  const text = flat(closing.text);
  assert.ok(text.includes("0 extended code review item(s)"), text);
  assert.ok(!text.includes("settle me"), "the routed case is not handed over");
});

/**
 * Drive the loop, answering each phase plainly, and return the first paragraph of each step
 * of every prompt it printed - by phase, with the preamble the prompt carried.
 */
function promptsOf(made) {
  const prompts = {};
  for (let p = 0; p < 12; p++) {
    const out = pass(made);
    prompts[out.phase.name] = {
      steps: out.steps.map((x) => x.first),
      preamble: out.preamble,
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
    take(made);
  }
  return prompts;
}

const WAIT = "Wait for every agent you spawned to come back.";

// A review whose first prompt is already the closing one ran nothing before it, so that
// prompt says nothing about passes, agents or decisions: no preamble, no "settled", no
// wait, no "LLM decisions" - just what to give the reviewer.
test("a one-pass review's only prompt says only what applies", () => {
  const made = review(tmp(), {
    sweep: false,
    findings: false,
    code: false,
    questions: false,
  });
  made.state.run = { skip: ["llm-skip-summary"], sca: false };
  const prompts = promptsOf(made);
  assert.deepEqual(Object.keys(prompts), ["close"]);
  assert.equal(prompts.close.preamble, 0, "no preamble above it");
  assert.deepEqual(prompts.close.steps, [
    "Give the reviewer what follows, each part under a heading of its own and in this order. Print nothing between the parts and nothing after them.",
    'Under "Summary", this, as it is written here:',
  ]);
});

// The preamble opens the first prompt and only that one, and the closing prompt of a review
// that ran says it is settled, waits for the agents it started, and asks for the account
// of what the agent decided.
test("the preamble opens the first prompt only, and close says what ran", () => {
  const made = review(tmp());
  const prompts = promptsOf(made);
  const order = Object.keys(prompts);
  // Two parts: how the passes work, and how the agent writes its prose, which a review no
  // build check started has not been told yet.
  assert.equal(prompts[order[0]].preamble, 2, `${order[0]} opens the review`);
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

// The writing rule is said once per reader: a review a build check started was told it in the
// build check's intro, so its first prompt opens without it. Whether a build check came first
// is read off the build results the record's permanent part holds. The description request
// carries the rule either way, since its sub-agent reads no other prompt.
test("the writing rule is said once per reader", () => {
  const style = words(REGISTRY.proseStyle());
  const plain = review(tmp());
  const first = pass(plain);
  assert.equal(first.preamble, 2);
  assert.equal(
    words(first.text).split(style).length - 1,
    2,
    "once in the preamble, and once in the description request"
  );
  const checked = review(tmp());
  checked.record.build = { safe: true };
  const opened = pass(checked);
  assert.equal(opened.preamble, 1, "only how the passes work");
  const slots = slotsOf(plain);
  assert.equal(slots.proseStyle, REGISTRY.proseStyle());
  const spawnText = words(first.steps.map((x) => x.text).join("\n"));
  assert.ok(spawnText.includes(style), "the description request names it");
  // The description sub-agent reads every line of the add-on: the request carries the reading
  // rule, filled from the registry.
  assert.ok(
    spawnText.includes(words(REGISTRY.readingRule())),
    "the description reads in full"
  );
  assert.equal(slots.readingRule, REGISTRY.readingRule());
});

// The wait for spawned agents is its own step, printed only where an agent was started -
// and never on its own: a phase whose only surviving step is the wait is not issued.
test("the agent wait prints only where an agent was started, and never alone", () => {
  // A source review's build question comes before any agent is started, so it does not
  // wait. The details block of `ask`, after the description agent started, does.
  const source = promptsOf(buildQuestionsReview(tmp()));
  assert.ok(!source.built.steps.includes(WAIT), source.built.steps.join(", "));
  assert.deepEqual(source.ask.steps[0], WAIT);
  assert.ok(source.ask.steps[1].startsWith("Give the reviewer this block"));

  // An XPI review that started a sweep waits before the details block, and never builds.
  const sweeping = promptsOf(review(tmp()));
  assert.equal(sweeping.ask.steps[0], WAIT);
  assert.ok(!("build" in sweeping), "no build phase made of a wait alone");

  // An XPI review that started nothing does not wait.
  const quiet = review(tmp(), { sweep: false });
  quiet.state.run = { skip: ["llm-skip-summary"], sca: false };
  const prompts = promptsOf(quiet);
  assert.ok(!("spawn" in prompts));
  assert.deepEqual(prompts.ask.steps.length, 2);
  assert.ok(prompts.ask.steps[0].startsWith("Give the reviewer this block"));
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

// The review builds nothing itself, and works out nothing about the build: it starts with the
// judgement its build check recorded, and opens on the build question, whose first step is
// the Build Review Details. No other phase asks about the build.
test("a review asks only the build question, and builds nothing", () => {
  for (const safety of ["safe", "unsafe"]) {
    const made = buildQuestionsReview(tmp());
    made.record.build = { ...made.record.build, safety };
    const { seen } = driveBuild(made, goesOn());
    assert.deepEqual(seen.slice(0, 2), ["built", "spawn"]);
  }
});

// The build question's step after the Build Review Details says who built the add-on, by
// what came of the build: the agent built it, its build failed, or the reviewer builds it.
// Exactly one of the three prints. A build the reviewer held unsafe is never asked about.
test("the build question's step text is worded by what came of the build", () => {
  const wordedStep = (build, safety) => {
    const made = buildQuestionsReview(tmp());
    made.record.build = { ...build, safety };
    const out = untilPhase(made, "built");
    assert.equal(
      out.steps.length,
      3,
      "the block, one worded step and the question"
    );
    return out.steps[1].first;
  };
  for (const [build, safety, opening] of [
    [
      { result: "built", output: "/w/build/dist" },
      "safe",
      "The agent built the add-on: LLM_BUILD_OUTPUT",
    ],
    [{ result: "failed", output: null }, "safe", "The agent's build failed"],
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

// The build question offers its own answers, and not the manual review's: whether the
// source builds and reproduces the XPI, and if not, why. After a self-build, reproducing it
// comes first. After an agent's build the linter could not confirm, the two reasons come
// first and the override last, which lets the review go on and reports nothing.
test("the build question offers its own three answers", () => {
  const made = buildQuestionsReview(tmp());
  const out = untilPhase(made, "built");
  assert.deepEqual(
    out.entries[0].answers.map((a) => a.label),
    [
      "Builds and reproduces",
      "The built add-on does not match the submitted XPI",
      "The build failed",
    ]
  );
  for (const build of [
    { result: "built", output: "/w/build/dist", match: "no match" },
    { result: "failed", output: null, match: null },
  ]) {
    const agent = buildQuestionsReview(tmp());
    agent.record.build = build;
    const asked = untilPhase(agent, "built");
    assert.deepEqual(
      asked.entries[0].answers.map((a) => a.label),
      [
        "The built add-on does not match the submitted XPI",
        "The build failed",
        "The XPI was correctly reproduced [override]",
      ],
      build.result
    );
    const { settled } = driveBuild(agent, goesOn());
    assert.equal(agent.record.review.values.built, "override", build.result);
    assert.equal(aborted(settled), false, build.result);
  }
});

// Where nobody decided about the build in the build check (a build-guard check switched
// off), build-review asks the whole build question in `ask`, with its own answers: builds fine
// and reproduces clears it, build issues reports it, and the reviewer's own words report it
// with those words as its note. Nothing asks `built` then.
test("build-review is asked in ask, with its own answers", () => {
  const said = "npm ci fails on a missing peer dependency.";
  for (const [answer, reported, note] of [
    ["Builds fine and reproduces", false, null],
    ["Build issues", true, null],
    [said, true, said],
  ]) {
    const made = buildReview(tmp());
    made.state.manual.push({
      ruleId: "build-review",
      title: "Build process review",
      extended: true,
      section: "manual-review",
      verdict: "error",
      instructions: "build-review?",
      file: "package.json",
      loc: null,
      artifact: "SCA",
    });
    refed(made.state);
    const offered = [];
    const { seen, settled } = driveBuild(
      made,
      goesOn({
        ask: (e) => {
          const labels = e.answers.map((a) => a.label);
          if (!labels.includes("Build issues")) {
            return "Clear";
          }
          offered.push(labels);
          return answer;
        },
      })
    );
    assert.ok(!seen.includes("built"), seen.join(", "));
    assert.ok(seen.includes("ask"), seen.join(", "));
    assert.deepEqual(offered, [["Builds fine and reproduces", "Build issues"]]);
    const found = settled.findings.find((f) => f.ruleId === "build-review");
    assert.equal(Boolean(found), reported, answer);
    if (found) {
      assert.equal(found.note, note, answer);
    }
  }
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
  const made = review(tmp(), { sweep: false });
  const { seen } = driveLoop(made, (phase) =>
    phase === "verify" ? "withdrawn" : "cleared"
  );
  assert.ok(!seen.includes("built"), seen.join(", "));
});

test("an aborted review never asks about a build", () => {
  const made = blockingReview(tmp());
  const { seen } = driveLoop(made, (phase) =>
    phase === "verify" ? "reported" : "cleared"
  );
  assert.ok(!seen.includes("built"), seen.join(", "));
});

// The Review Details link the build output where the agent built the add-on, and only
// there: a build that failed, or one nobody let the agent make, produced nothing to link.
// The closing prompt's details are the same block.
test("the details link the build output only where the agent built the add-on", () => {
  for (const build of [
    { result: "built", output: "/w/build/dist/addon.xpi" },
    { result: "failed", output: null },
    { result: null, output: null },
  ]) {
    const made = buildQuestionsReview(tmp());
    made.record.build = build;
    const linked = `* LLM_BUILD_OUTPUT: [addon.xpi](${build.output})`;
    const before = reviewDetails(made.state, made.record, made.work, REGISTRY);
    const { closing } = driveBuild(made, goesOn());
    for (const block of [before, closingDetails(closing).join("\n")]) {
      assert.equal(block.includes(linked), Boolean(build.output), block);
      assert.equal(block.includes("LLM_BUILD_OUTPUT"), Boolean(build.output));
    }
  }
});

// The build report is the build check's, and the review holds it as a product where it was
// written (src/report/loop.js startReview): the blocks the reviewer reads before the build
// question link the report it rests on, and only where it exists.
test("the build report is linked where the review holds it", () => {
  for (const wrote of [true, false]) {
    const made = buildQuestionsReview(tmp());
    made.state.products = wrote ? ["build"] : [];
    const next = pass(made);
    assert.equal(next.phase.name, "built");
    const linked = /^\* SCA_BUILD_REPORT: \[build\.md\]/m;
    for (const block of [
      slotsOf(made).buildDetails,
      reviewDetails(made.state, made.record, made.work, REGISTRY),
    ]) {
      if (wrote) {
        assert.match(block, linked);
      } else {
        assert.ok(!block.includes("SCA_BUILD_REPORT"), block);
      }
    }
    // The block the prompt printed is the same.
    assert.equal(
      flat(next.text).includes("\n* SCA_BUILD_REPORT: [build.md]("),
      wrote
    );
  }
});

/**
 * Drive a source review to its close the way `driveBuild` does, and keep each phase's
 * printed steps, its entries, and the slots of that pass.
 */
function stepsByPhase(made, answer) {
  const issued = [];
  for (let p = 0; p < 12; p++) {
    const out = pass(made);
    if (out.phase.answer === "end") {
      break;
    }
    issued.push({
      name: out.phase.name,
      slots: slotsOf(made),
      entries: out.entries.length,
      steps: out.steps.map((step) => ({
        ...step,
        rendered: words(step.text),
      })),
    });
    handBack(made.work, (e) => answer(out.phase.name, e));
    take(made);
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
    const block = phase.slots[slot]
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    assert.ok(block.length > 0, `${name}: a block to show`);
    const at = phase.steps.findIndex((step) => step.rendered.includes(heading));
    assert.ok(at >= 0, `${name} shows its block`);
    assert.ok(
      phase.steps.slice(0, at).every((step) => step.first === WAIT),
      `${name}: only a wait comes before the block`
    );
    const shown = phase.steps[at];
    assert.ok(
      shown.rendered.includes(END),
      `${name} ends the turn on its block`
    );
    assert.ok(shown.rendered.includes(ON), `${name} waits for the reply`);
    assert.ok(
      block.every((line) => shown.lines.includes(line)),
      `${name} shows its whole block`
    );
    const asks = phase.steps.findIndex((step) =>
      step.first.startsWith(question)
    );
    assert.ok(asks > at, `${name} puts its question after the block`);
    for (const step of phase.steps.filter((_, i) => i !== at)) {
      assert.ok(!step.rendered.includes(heading), name);
    }
  }
});

// The agent built the add-on in the build check and the linter compared it, and the review asks
// it only to put the question: the reviewer reads LLM_BUILD_XPI_MATCH beside LLM_BUILD_OUTPUT and
// XPI_FILE.
test("the build question tells the agent to build and compare nothing", () => {
  const made = buildQuestionsReview(tmp());
  made.record.build = { result: "built", output: "/w/build/dist" };
  const built = stepsByPhase(made, goesOn()).find((x) => x.name === "built");
  const worded = built.steps.find((step) =>
    step.first.startsWith("The agent built the add-on")
  );
  assert.ok(worded, built.steps.map((step) => step.first).join(" | "));
  assert.ok(
    worded.rendered.includes(
      "LLM_BUILD_XPI_MATCH is the linter's comparison of it with XPI_FILE, which the reviewer reads beside both. Build nothing and compare nothing, only put the question below."
    ),
    worded.rendered
  );
  assert.ok(!worded.rendered.includes("for the reviewer to compare"));
});

// The block a turn-ending phase shows ends with the line telling the reviewer the review
// waits for them and what their reply leads to, inside the text the agent prints verbatim.
// The `ask` line says how many questions follow: the entries that prompt handed out.
test("each turn-ending block ends with the line asking the reviewer to reply", () => {
  const WAITING = 'Reply "next" to continue the review';
  const issued = stepsByPhase(buildQuestionsReview(tmp()), goesOn());
  const asked = issued.find((x) => x.name === "ask").entries;
  assert.ok(asked > 1, String(asked));
  for (const [name, slot, line] of [
    [
      "built",
      "buildDetails",
      `${WAITING} with the question whether the source builds and reproduces ` +
        "the submitted XPI.",
    ],
    ["ask", "details", `${WAITING} with the ${asked} manual review questions.`],
  ]) {
    const phase = issued.find((x) => x.name === name);
    assert.ok(phase, name);
    const block = phase.slots[slot].split("\n").map((l) => l.trim());
    const shown = phase.steps.find((step) => step.lines.includes(block[0]));
    assert.ok(shown, `${name} shows its block`);
    const start = shown.lines.indexOf(block[0]);
    assert.deepEqual(
      shown.lines.slice(start, start + block.length + 2),
      [...block, "", line],
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
  const made = review(tmp());
  made.state.report.meta.summaryFile = made.state.paths.description;
  const details = () =>
    reviewDetails(made.state, made.record, made.work, REGISTRY);
  assert.equal(pass(made).phase.name, "spawn");
  assert.ok(!details().includes("ADDON_SUMMARY_REPORT"));
  swept(made.state, ARTIFACT_XPI);
  handBack(made.work, () => null);
  take(made);
  assert.match(details(), /^\* ADDON_SUMMARY_REPORT: \[summary\.md\]/m);
});

// The closing prompt hands over the FINISHED review's tally and details, the reasons an
// abort lists among them. The closing ends no turn the review waits on, so its block
// carries no waiting line.
test("the closing prompt carries the settled tally and details", () => {
  const made = blockingReview(tmp());
  const out = pass(made);
  assert.equal(out.phase.name, "close");
  const details = closingDetails(out);
  assert.equal(details.at(-1), "- Experiment APIs not accepted");
  const text = flat(out.text);
  assert.ok(
    text.includes(summaryBodyLines(out.settled.findings, [], null).join("\n")),
    "the tally of what stands, none of the to-do items"
  );
  assert.ok(text.includes("extended code review item"));
  assert.ok(!text.includes('Reply "next" to continue the review'));
});

// A per-mode response must read the same on the pass that FOUND the case and on the pass
// that re-renders it. The loop never sees a REVIEW_MODE: it rebuilds the one fact its
// review carries (`report.sca`), so this is the only place that can prove the two agree.
// No shipped check words itself per mode today, so the wording is put on one for the length
// of the test, the way the registry rules are.
test("settle words a per-mode response from the review's mode", () => {
  const reg = loadRegistry();
  const entry = reg.doc["deterministic-phase"].find(
    (e) => e.check === "untrusted-library"
  );
  delete entry.response;
  entry["response-for-xpi"] = "worded for an XPI review";
  entry["response-for-sca"] = "worded for a source code review";
  const worded = (sca) => {
    const made = review(tmp(), {
      sweep: false,
      code: false,
      questions: false,
    });
    made.state.report.sca = sca;
    // A source review has both roots, and every finding says which one its path is in
    // - the loop resolves the path for the agent from exactly that pair.
    if (sca) {
      asSource(made, sourceFolders(path.join(tmp(), "src")));
    }
    made.state.report.findings = [
      {
        ruleId: "untrusted-library",
        severity: "info",
        file: "lib/widget.js",
        loc: { line: 1 },
        artifact: sca ? "SCA" : "XPI",
        message: null,
      },
    ];
    refed(made.state);
    const { settled } = driveLoop(made, () => "reported", reg);
    return settled.findings[0].message;
  };

  assert.equal(worded(true), "worded for a source code review");
  assert.equal(worded(false), "worded for an XPI review");
  // And it is the text the run that FOUND it would have printed.
  const live = { ruleId: "untrusted-library", item: null, message: null };
  renderFindings([live], reg, REVIEW_MODE.SCA);
  assert.equal(worded(true), live.message);
});

// A `list` answer is checked for its shape only: what each item may say is the caller's.
test("a list answer takes an array and refuses anything else", () => {
  const asked = [{ index: "ISSUES", answer: null }];
  const phase = { name: "analyze", answer: "list" };
  const keyOf = (e) => String(e?.index);
  const items = [{ file: "a.js" }];
  assert.deepEqual(
    answersOf([{ index: "ISSUES", answer: items }], asked, phase, keyOf).get(
      "ISSUES"
    ),
    items
  );
  assert.throws(
    () => answersOf([{ index: "ISSUES", answer: "fine" }], asked, phase, keyOf),
    /ISSUES answers with no list/
  );
});
