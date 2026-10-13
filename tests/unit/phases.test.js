// The REVIEW LOOP's authored text, checked the way it will be read: a phase the linter
// hands out one per pass, plus the four texts the linter itself owns.
//
// Every test here mutates a freshly loaded registry and asserts the LOAD refuses it. That
// is the whole point of the file: this text reaches an agent verbatim, nothing downstream
// reads it back, and a run that prints a prompt with a hole in it produces a review that
// looks finished. Each rule below is one way that can happen.
import test from "node:test";
import assert from "node:assert/strict";
import { stepsOf } from "../../src/report/phases.js";
import {
  callsOf,
  namesOf,
  parseCondition,
} from "../../src/checks/condition.js";
import {
  loadRegistry,
  assertAskedIn,
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
  for (const key of ["frame", "handover", "refused"]) {
    assert.equal(typeof p[key], "string", key);
    assert.ok(p[key].length > 0, key);
  }
  for (const name of ["permission", "built", "ask"]) {
    assert.ok(p.waiting(name).length > 0, name);
  }
  // The preamble is parts, loaded like steps: text, and a parsed condition or none.
  assert.ok(p.preamble.length > 0, "the preamble has parts");
  for (const part of p.preamble) {
    assert.ok(part.text.length > 0);
    assert.ok(part.when === null || typeof part.when === "object");
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
      // A parsed condition, or null for a step printed in every run - one shape, so one
      // filter handles every step.
      assert.ok(step.when === null || typeof step.when === "object");
      assert.equal("skip" in step || "run" in step, false);
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
  for (const key of ["preamble", "frame", "handover", "waiting", "refused"]) {
    const registry = fresh();
    delete registry.doc["llm-phases"][key];
    assert.throws(
      () => check(registry),
      new RegExp(`authors no \`${key}\``),
      key
    );
  }
});

// An error whose message carries `text`.
const saying = (text) => (err) => err.message.includes(text);

// The waiting line is appended to the block a turn-ending phase shows, so the reviewer
// reads it as the end of that block.
test("the shipped turn-ending phases are the two questions that show a block", () => {
  const p = fresh().llmPhases();
  assert.equal(
    p.waiting("ask"),
    'Reply "next" to continue the review with the questions on the findings left to ' +
      "your judgement."
  );
  assert.deepEqual(
    p.phases.filter((phase) => phase.endsTurn).map((phase) => phase.name),
    ["built", "ask"]
  );
});

test("a blank waiting line is refused", () => {
  const registry = fresh();
  registry.doc["llm-phases"].waiting.text = "  ";
  assert.throws(() => check(registry), saying("`waiting`"));
});

// The waiting line names what the reply leads to, so every block it ends needs that named,
// and a named step no block ends with is a drafting error.
test("a turn-ending phase with no next step is refused", () => {
  const registry = fresh();
  delete registry.doc["llm-phases"].waiting.next.built;
  assert.throws(
    () => check(registry),
    saying("phase `built` ends the turn but `waiting` has no `next` entry")
  );
});

test("a next step for no block is refused", () => {
  const registry = fresh();
  registry.doc["llm-phases"].waiting.next.settle = "the settling";
  assert.throws(
    () => check(registry),
    saying("`next` entry for `settle`, which is neither `permission`")
  );
});

// The block is the turn-ending phase's FIRST step, past a wait for spawned agents: the turn
// ends on it, so nothing of the phase is asked or handed back before the reviewer has read
// it. A question phase may end the turn that way.
test("a turn-ending phase shows its block", () => {
  const asking = fresh();
  phaseNamed(asking, "built")["ends-turn"] = true;
  assert.doesNotThrow(() => check(asking), "a question phase may end the turn");

  const blockless = fresh();
  for (const step of phaseNamed(blockless, "ask").steps) {
    step.text = step.text.replace("{{details}}", "the block");
  }
  assert.throws(
    () => check(blockless),
    saying(
      "phase `ask` ends the turn but shows no {{buildDetails}} or {{details}}"
    )
  );

  const verifying = fresh();
  phaseNamed(verifying, "verify")["ends-turn"] = true;
  assert.throws(
    () => check(verifying),
    saying("phase `verify` ends the turn but shows no")
  );

  const notTrue = fresh();
  phaseNamed(notTrue, "ask")["ends-turn"] = "yes";
  assert.throws(() => check(notTrue), saying("non-boolean `ends-turn`"));
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
  assert.throws(() => check(noName), /phases` entry \d+ .* authors no `name`/);

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
  // Named by its phase and its place in that phase's steps - the list it is actually in.
  assert.throws(
    () => check(numbered),
    /llm-phases \(t\.yaml\) phase `verify` step 1 numbers itself/
  );

  // A condition naming a fact nothing answers would be false in every run.
  const unknown = fresh();
  phaseNamed(unknown, "ask").steps[0].when = "NOT aborted AND nonsense";
  assert.throws(
    () => check(unknown),
    /is conditioned on `nonsense`, which this prompt does not know/
  );

  const unparsed = fresh();
  phaseNamed(unparsed, "ask").steps[0].when = "NOT aborted AND";
  assert.throws(
    () => check(unparsed),
    /`when` that does not parse: expected a name/
  );

  // The markers `when:` replaced are refused, not read as a step printed in every run.
  for (const key of ["skip", "run"]) {
    const stale = fresh();
    phaseNamed(stale, "ask").steps[0][key] = "aborted";
    assert.throws(
      () => check(stale),
      new RegExp(`authors \`${key}\`, which this prompt cannot act on`),
      key
    );
  }
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

// Every step that starts a sub-agent says whether to wait for it.
//
// Each step also has to stand alone: each carries a marker, so any of them can be the only
// one printed, and a step referring to another that did not print is an instruction about
// nothing.
test("the steps that start an agent each say whether it is waited for", () => {
  const spawn = phaseNamed(fresh(), "spawn");
  // Found by the fact its condition reads, not by position.
  const by = (fact) =>
    spawn.steps.find(
      (x) => x.when && namesOf(parseCondition(x.when)).includes(fact)
    );
  const UNATTENDED =
    "Do not wait for it. When it comes back, write its reply unchanged to";

  // The description is not waited for. The build report is written before any agent
  // starts (build-safety), so no spawn step asks for one.
  assert.ok(
    by("llm-skip-summary").text.includes(UNATTENDED),
    "the description step says it is not waited for"
  );
  assert.ok(
    !spawn.steps.some((x) => x.text.includes("{{build}}")),
    "no spawn step writes the build report"
  );
  // A sweep is the opposite, and each says so in the SAME words: one agent per tree, and
  // two instructions a reader has to tell apart would be two things to interpret.
  const sweeps = ["sweep-xpi", "sweep-sca"].map(by);
  for (const step of sweeps) {
    assert.match(step.text, /Wait for it before going on/);
  }
  const waits = sweeps.map((x) =>
    x.text.split("\n\n").find((p) => p.startsWith("Wait for it"))
  );
  assert.equal(new Set(waits).size, 1, "both sweep steps say it the same way");
  // And each is handed its own tree's request, inline and nothing else, and names the file
  // its reply is written to.
  assert.match(sweeps[0].text, /\{\{sweepXpi\}\}/);
  assert.match(sweeps[0].text, /\{\{sweepXpiAnswers\}\}/);
  assert.match(sweeps[1].text, /\{\{sweepSca\}\}/);
  assert.match(sweeps[1].text, /\{\{sweepScaAnswers\}\}/);

  // Nothing leans on a sibling having printed.
  for (const step of spawn.steps) {
    assert.doesNotMatch(
      step.text,
      /\b(the (step|agents) (above|below)|spawned above)\b/,
      `a spawn step refers to another: ${step.text.slice(0, 60)}`
    );
  }
});

// A phase declares what one of its entries is answered WITH, beside the vocabulary that
// answer may use. The two are one decision in two halves - a `verdict` phase names the
// verbs it accepts, and every other kind accepts none - so a pair that disagrees is refused
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
      ["build-safety", "value", 0],
      ["built", "value", 0],
      ["spawn", "hints", 0],
      ["verify", "verdict", 2],
      ["settle", "verdict", 3],
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
    /invalid `answer` "verdicts" \(expected one of: hints, verdict, words, value, end\)/
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

// ---- process values ----

/** A registry with one process-value phase ahead of the closing one, the way the loop
 *  authors one: values with an id, a label and a description, one of them reporting a
 *  check that aborts the review. */
function withValuePhase(extra = {}) {
  const registry = fresh();
  const phases = registry.doc["llm-phases"].phases;
  phases.splice(phases.length - 1, 0, {
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
    ...extra,
  });
  return registry;
}

// A phase offers no answers of its own and puts no question of its own: a person is
// offered the manual review's answers, and a process-value phase's question is the to-do
// routed to it. Either key authored on a phase is refused at load.
test("a phase authors neither `choices` nor `question`", () => {
  for (const [name, key, value] of [
    [
      "ask",
      "choices",
      [{ label: "Yes", verdict: "cleared", description: "y" }],
    ],
    [
      "built",
      "choices",
      [{ label: "Yes", verdict: "cleared", description: "y" }],
    ],
    ["ask", "question", "Who builds?"],
    ["built", "question", "Does it build?"],
  ]) {
    const authored = fresh();
    phaseNamed(authored, name)[key] = value;
    assert.throws(
      () => check(authored),
      saying(`authors \`${key}\`, which nothing reads`),
      `${name} ${key}`
    );
  }
});

// What the Build Review Details say came of the agent's build is authored once per result
// of its attempt, and a result with no wording, or a wording for the reviewer's own build,
// is refused at load.
test("each result of the agent's attempt is worded", () => {
  assert.deepEqual(Object.keys(fresh().llmPhases().buildResults).sort(), [
    "agent-build-failed",
    "agent-built",
    "build-unsafe",
  ]);
  const missing = fresh();
  delete missing.doc["llm-phases"]["build-results"]["build-unsafe"];
  assert.throws(() => check(missing), saying("build-unsafe"));
  const extra = fresh();
  extra.doc["llm-phases"]["build-results"]["self-build"] = "not built";
  assert.throws(() => check(extra), saying("self-build"));
});

// A process value is declared by the phase that asks for it, and every name a condition
// reads from it is checked at load: a typo in either name is refused rather than read as a
// step that never prints.
test("a process-value phase declares its values, and conditions read only those", () => {
  check(withValuePhase());
  const loaded = withValuePhase()
    .llmPhases()
    .phases.find((p) => p.name === "safety");
  assert.deepEqual(
    loaded.values.map((v) => [v.value, v.label, v.reports]),
    [
      ["safe", "Safe", null],
      ["unsafe", "Unsafe", "build-reproduces-xpi"],
    ]
  );

  const none = withValuePhase();
  delete phaseNamed(none, "safety").values;
  assert.throws(
    () => check(none),
    /answers with `value` but offers no `values`/
  );
  const stray = fresh();
  phaseNamed(stray, "ask").values = phaseNamed(stray, "built").values;
  assert.throws(
    () => check(stray),
    /answers with `words` but authors `values` - only a `value` phase/
  );
  const twice = withValuePhase();
  phaseNamed(twice, "safety").values[1].value = "safe";
  assert.throws(() => check(twice), /offers the value `safe` twice/);
  const label = withValuePhase();
  phaseNamed(label, "safety").values[1].label = "Safe";
  assert.throws(() => check(label), /offers the label `Safe` twice/);
  const upper = withValuePhase();
  phaseNamed(upper, "safety").values[0].value = "Safe";
  assert.throws(() => check(upper), /value `Safe` is not a lower-case name/);
  const notAborting = withValuePhase();
  phaseNamed(notAborting, "safety").values[1].reports = "unused-files";
  assert.throws(
    () => check(notAborting),
    /reports `unused-files`, which is not an error check with a review-early-exit/
  );

  // A check that reads no single artifact: the finding names no file, so nothing could say
  // which artifact it is about.
  const everywhere = withValuePhase();
  Object.values(everywhere.doc)
    .filter(Array.isArray)
    .flat()
    .find((e) => e?.check === "build-reproduces-xpi").input = "all";
  assert.throws(
    () => check(everywhere),
    (err) =>
      err.message.includes(
        "reports `build-reproduces-xpi`, whose `input: all` reads no single artifact"
      )
  );

  // A check that aborts the review but stamps no error of its own (`severity: auto`): its
  // finding could not abort, so the value would end nothing.
  const weak = withValuePhase();
  phaseNamed(weak, "safety").values[1].reports = "vendor-vulnerable";
  assert.throws(
    () => check(weak),
    /reports `vendor-vulnerable`, which is not an error check/
  );

  for (const [when, refusal] of [
    ["value(safety, safe)", null],
    [
      "value(safty, safe)",
      /no phase of this prompt returns a process value called `safty`/,
    ],
    [
      "value(safety, maybe)",
      /`safety` never returns \(expected one of: safe, unsafe\)/,
    ],
    [
      "value(ask, safe)",
      /no phase of this prompt returns a process value called `ask`/,
    ],
  ]) {
    const registry = withValuePhase();
    phaseNamed(registry, "close").steps[0].when = when;
    if (refusal) {
      assert.throws(() => check(registry), refusal, when);
    } else {
      check(registry);
    }
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
  phaseNamed(none, "close").answer = "hints";
  assert.throws(() => check(none), /needs exactly one phase answering `end`/);

  const notLast = fresh();
  const phases = notLast.doc["llm-phases"].phases;
  phases.splice(phases.length - 2, 0, phases.pop());
  assert.throws(() => check(notLast), /and it must be the last/);
});

// At most one of the two openings prints - the settled one, or the aborted one - and each
// later part only where it applies: the wait where an agent was started, "LLM decisions"
// where the agent judged anything. The summary and the details always.
test("the closing phase says only what applies to the review it closes", () => {
  const close = fresh()
    .llmPhases()
    .phases.find((p) => p.name === "close");
  const heads = (run) =>
    stepsOf(close, run).map((x) => x.text.split(/[.:]/)[0]);
  const full = { spawned: true, decided: true };
  assert.deepEqual(heads({ halted: false, ...full }), [
    "The review is settled",
    "Wait for every agent you spawned to come back",
    "Give the reviewer what follows, each part under a heading of its own and in this order",
    'Under "LLM decisions", your own account in two sections',
    'Under "Summary", this, as it is written here',
  ]);
  assert.match(
    stepsOf(close, { halted: true, ...full })[0].text,
    /^The review was aborted before it finished/
  );
  // A review whose first prompt is already the closing one: nothing ran before it.
  assert.deepEqual(heads({ halted: false, first: true }), [
    "Give the reviewer what follows, each part under a heading of its own and in this order",
    'Under "Summary", this, as it is written here',
  ]);
  // An abort is news even then.
  assert.match(
    stepsOf(close, { halted: true, first: true })[0].text,
    /^The review was aborted/
  );
});

// A step prints when its `when:` condition holds over the facts this run meets: the flags
// it was given, `aborted` once a finding aborted the review, and each fact the run record
// answers true. A step with no condition prints in every run.
test("a step prints when its condition holds over the run's facts", () => {
  const step = (when, text) => ({
    when: when === null ? null : parseCondition(when),
    text,
  });
  const phase = {
    steps: [
      step(null, "always"),
      step("NOT aborted", "running"),
      step("aborted", "aborted"),
      step("NOT aborted AND NOT llm-skip-manual", "asking"),
      step("sca AND NOT aborted", "building"),
      step("NOT aborted AND (sca OR NOT llm-skip-manual)", "either"),
    ],
  };
  const texts = (run) => stepsOf(phase, run).map((s) => s.text);
  assert.deepEqual(texts({ skip: [], halted: false, sca: false }), [
    "always",
    "running",
    "asking",
    "either",
  ]);
  assert.deepEqual(texts({ skip: [], halted: true, sca: true }), [
    "always",
    "aborted",
  ]);
  // --llm-skip-manual withholds a step that needs it off ...
  assert.deepEqual(
    texts({ skip: ["llm-skip-manual"], halted: false, sca: false }),
    ["always", "running"]
  );
  // ... while a step with an OR still prints where its other arm holds.
  assert.deepEqual(
    texts({ skip: ["llm-skip-manual"], halted: false, sca: true }),
    ["always", "running", "building", "either"]
  );
});

// The shipped conditions, loaded parsed: what each phase's steps read.
test("the shipped steps carry the conditions they are printed under", () => {
  const loaded = fresh().llmPhases().phases;
  const when = (name) =>
    loaded
      .find((p) => p.name === name)
      .steps.map((x) => (x.when ? namesOf(x.when).sort() : null));
  // A review the deterministic checks aborted starts no agent and verifies or settles
  // nothing: every step of the three phases before the questions carries `aborted`.
  assert.deepEqual(when("spawn"), [
    ["aborted", "llm-skip-summary"],
    ["aborted", "sweep-xpi"],
    ["aborted", "sweep-sca"],
  ]);
  assert.deepEqual(when("verify"), [["aborted"]]);
  assert.deepEqual(when("settle"), [["aborted"]]);
  // The build opening: only a source review whose install is vouched for, and the judgement
  // only where none is held yet. The Build Review Details show wherever the build was
  // vouched for, and the build question's first step is worded by the build result.
  const calls = (name) =>
    loaded
      .find((p) => p.name === name)
      .steps.map((x) => (x.when ? callsOf(x.when).map((c) => c.args) : null));
  assert.deepEqual(when("build-safety"), [
    ["aborted", "build-guarded", "sca"],
    ["aborted", "build-guarded", "sca"],
  ]);
  assert.deepEqual(calls("build-safety"), [
    [
      ["build-safety", "safe"],
      ["build-safety", "unsafe"],
    ],
    [
      ["build-safety", "safe"],
      ["build-safety", "unsafe"],
    ],
  ]);
  assert.deepEqual(when("built"), [
    ["aborted", "build-guarded", "sca"],
    ["aborted", "agent-built"],
    ["aborted", "agent-build-failed"],
    ["aborted", "build-unsafe"],
    ["aborted", "self-build"],
    ["aborted"],
  ]);
  // The wait step carries its phase's own condition beside `spawned`.
  assert.deepEqual(when("ask"), [
    ["aborted", "llm-skip-manual", "spawned"],
    ["aborted", "llm-skip-manual"],
    ["aborted", "llm-skip-manual"],
  ]);
  assert.deepEqual(when("close"), [
    ["aborted"],
    ["aborted", "first"],
    ["spawned"],
    null,
    ["decided"],
    null,
  ]);
  // The preamble: the first prompt only, and never above a first-pass close.
  assert.deepEqual(
    fresh()
      .llmPhases()
      .preamble.map((x) => namesOf(x.when).sort()),
    [["closing", "first"]]
  );
});

// A check asked in a phase of its own names one a PERSON answers, with their words or one of
// its values, and is itself a question only a person answers: a phase that does not exist
// would route its case where nothing opens it, one an agent answers with a verdict would
// hand a reviewer's question to a model, and a case an agent screens would be neither
// listed as a question nor dropped as one on an abort.
test("asked-in names a phase a person answers, on a question only a person answers", () => {
  // The raw entry in the document: allEntries hands out copies.
  const entry = (r) =>
    r.doc["deterministic-phase"].find(
      (e) => e.check === "build-reproduces-xpi"
    );
  assertAskedIn(fresh(), "t.yaml");
  for (const answer of ["value", "words"]) {
    const asked = fresh();
    phaseNamed(asked, "built").answer = answer;
    assertAskedIn(asked, "t.yaml");
  }

  for (const [phase, refusal] of [
    ["builds", /is asked in `builds`, which is not a phase a person answers/],
    ["settle", /is asked in `settle`, which is not a phase a person answers/],
  ]) {
    const wrong = fresh();
    entry(wrong)["asked-in"] = phase;
    assert.throws(() => assertAskedIn(wrong, "t.yaml"), refusal, phase);
  }

  const screened = fresh();
  entry(screened)["instructions-for-llm"] = "read the build log";
  assert.throws(
    () => assertAskedIn(screened, "t.yaml"),
    /is not a question only a person answers/
  );
});

// The preamble's parts are conditioned and printed like steps, so they are checked like
// them - a stray key, a condition naming an unknown fact, and a self-numbered part are all
// refused.
test("the preamble's parts are checked like steps", () => {
  for (const [mutate, refusal] of [
    [
      (part) => (part.skip = "first"),
      // Named as a part of the preamble, not as a step of some other list.
      /llm-phases \(t\.yaml\) `preamble` part 1 authors `skip`, which this prompt cannot act on/,
    ],
    [
      (part) => (part.when = "first AND nonsense"),
      /is conditioned on `nonsense`/,
    ],
    [
      (part) => (part.text = "1. This review runs in passes."),
      /numbers itself/,
    ],
  ]) {
    const registry = fresh();
    mutate(registry.doc["llm-phases"].preamble[0]);
    assert.throws(() => check(registry), refusal);
  }
});
