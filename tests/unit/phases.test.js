// The REVIEW LOOP's authored text, checked the way it will be read: a phase the linter
// hands out one per pass, plus the five texts the linter itself owns.
//
// Every test here mutates a freshly loaded registry and asserts the LOAD refuses it. That
// is the whole point of the file: this text reaches an agent verbatim, nothing downstream
// reads it back, and a run that prints a prompt with a hole in it produces a review that
// looks finished. Each rule below is one way that can happen.
import test from "node:test";
import assert from "node:assert/strict";
import { loadRegistry, assertPhases } from "../../src/checks/registry.js";

const fresh = () => loadRegistry();
const phaseNamed = (registry, name) =>
  registry.doc["llm-phases"].phases.find((p) => p.name === name);

test("the shipped registry's phases load and are whole", () => {
  const p = fresh().llmPhases();
  for (const key of ["preamble", "frame", "handover", "refused", "final"]) {
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
      () => assertPhases(registry, "t.yaml"),
      new RegExp(`\`${key}\` carries no `),
      key
    );
  }
});

test("a missing linter-owned text is refused by name", () => {
  for (const key of ["preamble", "frame", "handover", "refused", "final"]) {
    const registry = fresh();
    delete registry.doc["llm-phases"][key];
    assert.throws(
      () => assertPhases(registry, "t.yaml"),
      new RegExp(`authors no \`${key}\``),
      key
    );
  }
});

// The rule that stops a phase from being half-authored in two directions at once. A verb
// the phase accepts but no step names is one the agent is never told it may use; a verb a
// step names but the phase does not accept is one the agent is refused for using after
// being told to. Reading either half alone shows nothing wrong.
test("a phase's verbs are checked against its own steps, both ways", () => {
  const unnamed = fresh();
  phaseNamed(unnamed, "verify").verbs.push("cleared");
  assert.throws(
    () => assertPhases(unnamed, "t.yaml"),
    /accepts `cleared` but no step names it/
  );

  const unaccepted = fresh();
  const settle = phaseNamed(unaccepted, "settle");
  settle.verbs = settle.verbs.filter((v) => v !== "ask");
  assert.throws(
    () => assertPhases(unaccepted, "t.yaml"),
    /names `ask` in a step but does not accept it/
  );
});

test("a verb no verdict knows is refused", () => {
  const registry = fresh();
  phaseNamed(registry, "verify").verbs.push("maybe");
  assert.throws(
    () => assertPhases(registry, "t.yaml"),
    /not a verdict this review knows/
  );
});

test("a phase missing its own parts is refused by name", () => {
  const noName = fresh();
  delete phaseNamed(noName, "verify").name;
  assert.throws(
    () => assertPhases(noName, "t.yaml"),
    /authors a phase with no `name`/
  );

  const twice = fresh();
  phaseNamed(twice, "settle").name = "verify";
  assert.throws(() => assertPhases(twice, "t.yaml"), /authors `verify` twice/);

  // Empty is how a phase says it needs none; ABSENT is an author who forgot to decide.
  const noIntro = fresh();
  delete phaseNamed(noIntro, "spawn").intro;
  assert.throws(() => assertPhases(noIntro, "t.yaml"), /authors no `intro`/);

  const noVerbs = fresh();
  delete phaseNamed(noVerbs, "ask").verbs;
  assert.throws(() => assertPhases(noVerbs, "t.yaml"), /authors no `verbs`/);

  const noSteps = fresh();
  phaseNamed(noSteps, "verify").steps = [];
  assert.throws(() => assertPhases(noSteps, "t.yaml"), /authors no `steps`/);
});

// The prompt numbers what survives its markers, so an authored number renders twice - and
// a marker the run cannot evaluate would print the step unconditionally.
test("a step that numbers itself, or carries a marker nothing answers, is refused", () => {
  const numbered = fresh();
  phaseNamed(numbered, "verify").steps[0].text = "1. Verify every entry.";
  assert.throws(() => assertPhases(numbered, "t.yaml"), /numbers itself/);

  const badSkip = fresh();
  phaseNamed(badSkip, "ask").steps[0].skip = "nonsense";
  assert.throws(() => assertPhases(badSkip, "t.yaml"), /which no flag gives/);

  const badRun = fresh();
  phaseNamed(badRun, "spawn").steps[1].run = "nonsense";
  assert.throws(() => assertPhases(badRun, "t.yaml"), /cannot evaluate/);
});

test("the loop's phases are refused outright when absent", () => {
  const registry = fresh();
  delete registry.doc["llm-phases"];
  assert.throws(
    () => assertPhases(registry, "t.yaml"),
    /authors no loop prompts/
  );

  const noPhases = fresh();
  delete noPhases.doc["llm-phases"].phases;
  assert.throws(() => assertPhases(noPhases, "t.yaml"), /authors no `phases`/);
});

// A phase declares what one of its entries is answered WITH, beside the vocabulary that
// answer may use. The two are one decision in two halves - a `verdict` phase names the
// verbs it accepts, and the other two accept none - so a pair that disagrees is refused
// here rather than when a hand-back first arrives, which may be never.
//
// It is read as DATA everywhere the loop asks "what shape is this entry, and what may come
// back": src/report/handback.js entriesFor and answersOf, src/report/loop.js issue and
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
      ["ask", "words", 0],
    ]
  );

  const missing = fresh();
  delete phaseNamed(missing, "verify").answer;
  assert.throws(
    () => assertPhases(missing, "t.yaml"),
    /authors `answer: undefined`, which is not a kind of answer/
  );

  const unknown = fresh();
  phaseNamed(unknown, "verify").answer = "verdicts";
  assert.throws(
    () => assertPhases(unknown, "t.yaml"),
    /authors `answer: verdicts`/
  );

  // A verdict phase with nothing to say back, and a phase that names a verb nobody will
  // ever be offered: both halves of the pair, both refused.
  const noVocabulary = fresh();
  phaseNamed(noVocabulary, "verify").verbs = [];
  assert.throws(
    () => assertPhases(noVocabulary, "t.yaml"),
    /answers with `verdict` but accepts `` - only a `verdict` phase names verbs/
  );

  for (const name of ["ask", "spawn"]) {
    const stray = fresh();
    phaseNamed(stray, name).verbs = ["reported"];
    assert.throws(
      () => assertPhases(stray, "t.yaml"),
      /but accepts `reported` - only a `verdict` phase names verbs/,
      name
    );
  }
});
