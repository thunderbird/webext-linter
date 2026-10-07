// The REVIEW LOOP's authored text, checked the way it will be read: a phase the linter
// hands out one per pass, plus the five texts the linter itself owns.
//
// Every test here mutates a freshly loaded registry and asserts the LOAD refuses it. That
// is the whole point of the file: this text reaches an agent verbatim, nothing downstream
// reads it back, and a run that prints a prompt with a hole in it produces a review that
// looks finished. Each rule below is one way that can happen.
import test from "node:test";
import assert from "node:assert/strict";
import { stepsOf } from "../../src/report/phases.js";
import {
  loadRegistry,
  assertPhases,
  assertEntries,
  assertRequiredSections,
} from "../../src/checks/registry.js";

const fresh = () => loadRegistry();
// Production asks the SHAPE first (registry-schema.js, via assertEntries) and then the
// rules that read one value against another (assertPhases). Ask both here, in that order,
// so a case lands wherever it belongs without this file having to know which.
const check = (registry) => {
  assertEntries(registry, "t.yaml");
  assertPhases(registry, "t.yaml");
};
const phaseNamed = (registry, name) =>
  registry.doc["llm-phases"].phases.find((p) => p.name === name);

test("the shipped registry's phases load and are whole", () => {
  const p = fresh().llmPhases();
  for (const key of ["preamble", "frame", "handover", "refused"]) {
    assert.equal(typeof p[key], "string", key);
    assert.ok(p[key].length > 0, key);
  }
  assert.ok(p.phases.length > 0, "at least one phase");
  for (const phase of p.phases) {
    assert.equal(typeof phase.name, "string");
    assert.equal(typeof phase.intro, "string");
    assert.ok(Array.isArray(phase.verbs));
    assert.ok(phase.steps.length > 0, `${phase.name} has steps`);
    for (const step of phase.steps) {
      assert.equal(typeof step.text, "string");
      assert.ok(step.text.length > 0);
      // Null when the step carries no marker, so one filter handles every step.
      assert.ok(step.skip === null || typeof step.skip === "string");
      assert.ok(step.run === null || typeof step.run === "string");
    }
  }
});

// Each placeholder is the ONLY way its value reaches the agent. A handover with no
// {{command}} leaves it holding a decision and no way to hand it back; a frame with no
// {{review}} names no file at all. Neither is visible by reading the prose.
test("a linter-owned text that loses its placeholder is refused", () => {
  // The preamble names no value at all - it is too early, and a path with no step behind
  // it reads as an assignment. The phase that READS the add-on names what to read.
  for (const [key, slot] of [
    ["frame", "{{review}}"],
    ["handover", "{{command}}"],
    ["refused", "{{problem}}"],
  ]) {
    const registry = fresh();
    const doc = registry.doc["llm-phases"];
    assert.ok(doc[key].includes(slot), `${key} carries ${slot} as shipped`);
    doc[key] = doc[key].replace(slot, "somewhere");
    assert.throws(
      () => check(registry),
      new RegExp(`\`${key}\` carries no `),
      key
    );
  }
});

test("a missing linter-owned text is refused by name", () => {
  for (const key of ["preamble", "frame", "handover", "refused"]) {
    const registry = fresh();
    delete registry.doc["llm-phases"][key];
    assert.throws(
      () => check(registry),
      new RegExp(`authors no \`${key}\``),
      key
    );
  }
});

// The rule that stops a phase from being half-authored in two directions at once. A verb
// the phase accepts but words nowhere is one an entry offers with nothing to choose on; a
// verb worded but not accepted is one the agent is refused for using after being told
// what it means. Reading either half alone shows nothing wrong.
test("a phase's verbs are checked against its own wordings, both ways", () => {
  const unworded = fresh();
  phaseNamed(unworded, "verify").verbs.push("cleared");
  assert.throws(
    () => check(unworded),
    /accepts `cleared` but its `verb-prose` says nothing about it/
  );

  const unaccepted = fresh();
  const settle = phaseNamed(unaccepted, "settle");
  settle.verbs = settle.verbs.filter((v) => v !== "ask");
  assert.throws(
    () => check(unaccepted),
    /words `ask` in its `verb-prose` but does not accept it/
  );

  // The variant wording is optional, but an authored one must be prose like the rest.
  const blank = fresh();
  phaseNamed(blank, "settle")["verb-prose"].reported["says-when-last-resort"] =
    "  ";
  assert.throws(() => check(blank), /missing or empty `says-when-last-resort`/);
});

test("a verb no verdict knows is refused", () => {
  const registry = fresh();
  phaseNamed(registry, "verify").verbs.push("maybe");
  assert.throws(() => check(registry), /not a verdict this review knows/);
});

test("a phase missing its own parts is refused by name", () => {
  const noName = fresh();
  delete phaseNamed(noName, "verify").name;
  assert.throws(() => check(noName), /phases` entry 2 .* authors no `name`/);

  const twice = fresh();
  phaseNamed(twice, "settle").name = "verify";
  assert.throws(() => check(twice), /authors `verify` twice/);

  // Empty is how a phase says it needs none; ABSENT is an author who forgot to decide.
  const noIntro = fresh();
  delete phaseNamed(noIntro, "spawn").intro;
  assert.throws(() => check(noIntro), /authors no `intro`/);

  const noVerbs = fresh();
  delete phaseNamed(noVerbs, "ask").verbs;
  assert.throws(() => check(noVerbs), /authors no `verbs`/);

  const noSteps = fresh();
  phaseNamed(noSteps, "verify").steps = [];
  assert.throws(() => check(noSteps), /authors no `steps`/);
});

// The prompt numbers what survives its markers, so an authored number renders twice - and
// a marker the run cannot evaluate would print the step unconditionally.
test("a step that numbers itself, or carries a marker nothing answers, is refused", () => {
  const numbered = fresh();
  phaseNamed(numbered, "verify").steps[0].text = "1. Verify every entry.";
  assert.throws(() => check(numbered), /numbers itself/);

  const badSkip = fresh();
  phaseNamed(badSkip, "ask").steps[0].skip = "nonsense";
  assert.throws(() => check(badSkip), /which no flag gives/);

  const badRun = fresh();
  // Found by its marker, not by position: a step added to the phase should not decide
  // which one this mutates.
  phaseNamed(badRun, "spawn").steps.find((x) => x.run).run = "nonsense";
  assert.throws(() => check(badRun), /cannot evaluate/);
});

test("the loop's phases are refused outright when absent", () => {
  // Present but unusable is its shape's answer; GONE is presence, asked once of a whole
  // registry - the shape pass says nothing about a section nobody authored.
  const unusable = fresh();
  unusable.doc["llm-phases"] = "prose, not a mapping";
  assert.throws(() => check(unusable), /authors no loop prompts/);

  const gone = fresh();
  delete gone.doc["llm-phases"];
  assert.throws(
    () => assertRequiredSections(gone.doc, "t.yaml"),
    /the section "llm-phases" is missing/
  );

  const noPhases = fresh();
  delete noPhases.doc["llm-phases"].phases;
  assert.throws(() => check(noPhases), /authors no `phases`/);
});

// A phase declares what one of its entries is answered WITH, beside the vocabulary that
// answer may use. The two are one decision in two halves - a `verdict` phase names the
// verbs it accepts, and the other two accept none - so a pair that disagrees is refused
// here rather than when a hand-back first arrives, which may be never.
//
// It is read as DATA everywhere the loop asks "what shape is this entry, and what may come
// back": src/report/handback.js entriesFor and answersOf, src/report/loop.js issue and
// Every step that starts a sub-agent says whether to wait for it, and the two that are not
// waited for say it in the SAME words. Two spellings of one instruction is a difference for
// the agent to interpret, and it would interpret it - the files are named side by side in
// the same block and read by the same person.
//
// Each step also has to stand alone: all three carry a marker, so any of them can be the
// only one printed, and a step referring to another that did not print is an instruction
// about nothing.
test("the steps that start an agent each say whether it is waited for", () => {
  const spawn = phaseNamed(fresh(), "spawn");
  const by = (marker) =>
    spawn.steps.find((x) => x.skip === marker || x.run === marker);
  const UNATTENDED =
    "Do not wait for it. What it writes is the reviewer's, and it is not needed until " +
    "they are handed the review details.";

  // The description and the build report: one sentence, used twice.
  for (const marker of ["summary", "sca"]) {
    assert.ok(
      by(marker).text.includes(UNATTENDED),
      `the \`${marker}\` step says it is not waited for, in the shared words`
    );
  }
  // A sweep is the opposite, and each says so in the SAME words: one agent per tree, and
  // two instructions a reader has to tell apart would be two things to interpret.
  const sweeps = ["sweep-xpi", "sweep-sca"].map(by);
  for (const step of sweeps) {
    assert.match(step.text, /Wait for it before going on/);
  }
  assert.equal(
    new Set(sweeps.map((x) => x.text.split("\n\n").at(-1))).size,
    1,
    "both sweep steps say it the same way"
  );
  // And each is handed its own tree's request and nothing else - no instruction text
  // travels through the prompt.
  assert.match(sweeps[0].text, /\{\{sweepXpi\}\}/);
  assert.match(sweeps[1].text, /\{\{sweepSca\}\}/);

  // Nothing leans on a sibling having printed.
  for (const step of spawn.steps) {
    assert.doesNotMatch(
      step.text,
      /\b(the (step|agents) (above|below)|spawned above)\b/,
      `a spawn step refers to another: ${step.text.slice(0, 60)}`
    );
  }
});

// accept. A phase renamed in the yaml keeps its shape; nothing infers it from the name.
test("a phase declares the kind of answer its entries take", () => {
  assert.deepEqual(
    fresh()
      .llmPhases()
      .phases.map((p) => [p.name, p.answer, p.verbs.length]),
    [
      ["spawn", "hints", 0],
      ["verify", "verdict", 2],
      ["settle", "verdict", 3],
      ["build", "none", 0],
      ["details", "none", 0],
      ["ask", "words", 0],
      ["close", "end", 0],
    ]
  );

  const missing = fresh();
  delete phaseNamed(missing, "verify").answer;
  assert.throws(() => check(missing), /authors no `answer`/);

  // A NAMED kind that is not one: the closed set is what says so, and it says which.
  const unknown = fresh();
  phaseNamed(unknown, "verify").answer = "verdicts";
  assert.throws(
    () => check(unknown),
    /invalid `answer` "verdicts" \(expected one of: hints, verdict, words, none, end\)/
  );

  // A verdict phase with nothing to say back, and a phase that names a verb nobody will
  // ever be offered: both halves of the pair, both refused.
  const noVocabulary = fresh();
  phaseNamed(noVocabulary, "verify").verbs = [];
  assert.throws(
    () => check(noVocabulary),
    /answers with `verdict` but accepts `` - only a `verdict` phase names verbs/
  );

  for (const name of ["ask", "spawn"]) {
    const stray = fresh();
    phaseNamed(stray, name).verbs = ["reported"];
    assert.throws(
      () => check(stray),
      /but accepts `reported` - only a `verdict` phase names verbs/,
      name
    );
  }
});

// ---- the early exit's registry half ----

// The review ends with ONE closing phase, the last, and it hands over what the reviewer is
// left with. A second would never be reached, one that is not last would end the review with
// phases still to come, and one missing a slot would drop that part from every review.
test("the closing phase is the one last phase, and carries both hand-over slots", () => {
  for (const slot of ["{{details}}", "{{tally}}"]) {
    const registry = fresh();
    const body = phaseNamed(registry, "close").steps.at(-1);
    assert.ok(body.text.includes(slot), `close carries ${slot} as shipped`);
    body.text = body.text.replace(slot, "somewhere");
    assert.throws(
      () => check(registry),
      new RegExp(`phase \`close\` carries no ${slot.replace(/[{}]/g, "\\$&")}`),
      `close without ${slot}`
    );
  }

  const none = fresh();
  phaseNamed(none, "close").answer = "none";
  assert.throws(() => check(none), /needs exactly one phase answering `end`/);

  const notLast = fresh();
  const phases = notLast.doc["llm-phases"].phases;
  phases.splice(phases.length - 2, 0, phases.pop());
  assert.throws(() => check(notLast), /and it must be the last/);
});

// Exactly one of the two openings prints: the settled one, or the stopped one.
test("the closing phase opens one way for a settled review and another for a stopped one", () => {
  const close = fresh()
    .llmPhases()
    .phases.find((p) => p.name === "close");
  const opening = (halted) => stepsOf(close, { halted })[0].text;
  assert.match(opening(false), /^The review is settled\./);
  assert.match(opening(true), /^The review was stopped before it finished/);
  assert.equal(stepsOf(close, { halted: false }).length, 2);
  assert.equal(stepsOf(close, { halted: true }).length, 2);
});

// Whether the review stopped is read against every step: one flagged skip-if-stopped is
// left out of a stopped review, one flagged skip-if-not-stopped out of every other.
test("a step's stop flags decide whether it prints in a stopped review", () => {
  const phase = {
    steps: [
      { skip: null, run: null, text: "always" },
      { skip: null, run: null, skipIfStopped: true, text: "running" },
      { skip: null, run: null, skipIfNotStopped: true, text: "stopped" },
    ],
  };
  const texts = (halted) => stepsOf(phase, { halted }).map((s) => s.text);
  assert.deepEqual(texts(false), ["always", "running"]);
  assert.deepEqual(texts(true), ["always", "stopped"]);
});

// A stop flag is true or false, and it sits beside a marker rather than counting as one.
test("a stop flag is a boolean, and not a second marker", () => {
  const flagged = fresh();
  const step = phaseNamed(flagged, "ask").steps.find((x) => x.skip);
  step["skip-if-stopped"] = true;
  check(flagged);

  const wrong = fresh();
  phaseNamed(wrong, "ask").steps[0]["skip-if-stopped"] = "yes";
  assert.throws(
    () => check(wrong),
    /carries `skip-if-stopped: "yes"` - it is true or false/
  );

  const loaded = fresh()
    .llmPhases()
    .phases.find((p) => p.name === "build");
  assert.equal(loaded.steps[0].skipIfStopped, true);
  assert.equal(loaded.steps[0].skipIfNotStopped, false);
});
