// The sweep's own two files: what a sweeping sub-agent is handed, and the door its
// answers come back through.
//
// This is the ONLY place a sweep's findings enter the review, and the agent that writes
// them is reading an add-on rather than the linter - so every guard here exists because a
// file that cannot be acted on has to be refused by name, at a point the agent can
// correct, rather than half-applied downstream.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

import { ARTIFACT_SCA, ARTIFACT_XPI } from "../../src/lib/artifacts.js";
import {
  readSweepAnswers,
  sweepSlots,
  writeSweepFiles,
} from "../../src/report/sweep-files.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wxl-sweepfiles-"));

/** The review's paths, as reviewFilePaths answers them (src/report/items.js). */
const pathsIn = (dir) => ({
  sweep: (artifact) => ({
    request: path.join(dir, `r.sweep-${artifact.toLowerCase()}.yaml`),
    answers: path.join(dir, `r.sweep-${artifact.toLowerCase()}.answers.json`),
  }),
});

/** Write one tree's pair and read the request back, the way the review does. */
function requested(sweeps, sweepTarget = "/tmp/tree/") {
  const dir = tmp();
  const files = pathsIn(dir);
  const written = writeSweepFiles(
    files,
    { items: sweeps },
    { [ARTIFACT_SCA]: sweepTarget, [ARTIFACT_XPI]: sweepTarget }
  );
  const at = written[sweeps[0].artifact];
  return {
    yaml: fs.readFileSync(at.request, "utf8"),
    slots: JSON.parse(fs.readFileSync(at.answers, "utf8")),
  };
}

/** Two sweeps of one tree, labelled the way preSweepOf labels them: across the whole
 *  review, so a second tree's labels continue rather than restart. */
const SWEEPS = [
  {
    label: 3,
    check: "cleartext-transmission",
    artifact: ARTIFACT_SCA,
    title: "Unencrypted data transmission",
    instruction: "A remote endpoint reached over http://, ws:// or ftp://.",
  },
  {
    label: 4,
    check: "data-exfiltration",
    artifact: ARTIFACT_SCA,
    title: "User-data exfiltration",
    instruction:
      "Message content reaching a remote host without the user asking.",
  },
];

/** The answers file as an agent would leave it, given what it found per label. */
function answered(dir, found) {
  const file = path.join(dir, "a.answers.json");
  fs.writeFileSync(file, JSON.stringify({ answers: found }));
  return file;
}

// ---- the request ----

// The request has to stand alone: the agent is handed a path and nothing else, so
// everything it needs to do the job is in the file or nowhere.
test("the request names its tree, its answers file, and every sweep", () => {
  const { yaml } = requested(SWEEPS);
  const doc = YAML.parse(yaml);
  assert.equal(doc.sweepTarget, "/tmp/tree/");
  assert.match(doc.answerFile, /r\.sweep-sca\.answers\.json$/);
  assert.deepEqual(
    doc.sweeps.map((s) => s.label),
    [3, 4]
  );
  // The count is stated, so an agent can see whether it answered them all rather than
  // inferring it from a list it may have stopped reading.
  assert.match(doc.instructions, /holds 2 separate sweeps/);
  // Both paths are referred to BY FIELD NAME, so neither is buried in a sentence that
  // could go out of step with the value above it.
  assert.match(doc.instructions, /"sweepTarget"/);
  assert.match(doc.instructions, /"answerFile"/);

  // Nothing of the review's own vocabulary reaches the agent: not a check id, not an
  // artifact. It is told which folder and what to look for, and answers by label.
  assert.ok(!yaml.includes("cleartext-transmission"), "no check id");
  assert.ok(!yaml.includes(ARTIFACT_SCA), "no artifact name");
});

// The example is the part an agent copies, so it has to be the shape the door accepts -
// and it must not suggest what to go and find.
test("the worked example fixes the shape without suggesting a finding", () => {
  const doc = YAML.parse(requested(SWEEPS).yaml);
  // Every label appears, so the example doubles as the list of what must come back, and
  // the empty list is shown as well as a find.
  assert.match(doc.instructions, /"3": \[/);
  assert.match(doc.instructions, /"4": \[\]/);
  // A placeholder where the content would be. A plausible hint here is a suggestion.
  assert.match(doc.instructions, /"hint": "<what is there>"/);
  // And the example parses as the JSON it claims to be.
  const example = doc.instructions.slice(
    doc.instructions.indexOf("{"),
    doc.instructions.lastIndexOf("}") + 1
  );
  assert.deepEqual(Object.keys(JSON.parse(example).answers), ["3", "4"]);
});

// One convention for the whole file, chosen by key rather than by whether a value happens
// to hold a newline - a one-paragraph instruction holds none, and left to the emitter it
// becomes a plain scalar wrapped across lines, which is a second way of writing the same
// kind of thing in one file.
test("every piece of prose is written as a literal block, and round-trips", () => {
  const { yaml } = requested(SWEEPS);
  assert.match(yaml, /^instructions: \|-$/m);
  for (const _ of SWEEPS) {
    assert.ok(yaml.includes("instruction: |-"), "each sweep's text too");
  }
  const doc = YAML.parse(yaml);
  assert.deepEqual(
    doc.sweeps.map((s) => s.instruction),
    SWEEPS.map((s) => s.instruction)
  );
  // The paragraph breaks and the indented example survive being written and read back.
  assert.ok(doc.instructions.includes("\n\n"), "paragraphs stay paragraphs");
});

// ---- the slots ----

// Pre-created, because the slots are what the linter knows in advance: `null` is a sweep
// nobody has run, an empty list is one that was run and found nothing, and an agent
// inventing the file could answer three of eight with nothing to say so.
test("the answers file starts with every label and no answer", () => {
  assert.deepEqual(requested(SWEEPS).slots, { answers: { 3: null, 4: null } });
});

// ---- writing the pair ----

test("one pair is written per tree, grouped from the pre-sweep list", () => {
  const dir = tmp();
  const files = {
    sweep: (artifact) => ({
      request: path.join(dir, `r.sweep-${artifact.toLowerCase()}.yaml`),
      answers: path.join(dir, `r.sweep-${artifact.toLowerCase()}.answers.json`),
    }),
  };
  const preSweep = {
    items: [
      ...SWEEPS,
      {
        label: 9,
        check: "unacceptable-package-content",
        artifact: ARTIFACT_XPI,
        title: "Check the package for unacceptable content",
        instruction: "Content shipped inside the package.",
      },
    ],
  };
  const written = writeSweepFiles(files, preSweep, {
    [ARTIFACT_SCA]: "/src/",
    [ARTIFACT_XPI]: "/xpi/",
  });
  assert.deepEqual(Object.keys(written).sort(), [ARTIFACT_SCA, ARTIFACT_XPI]);
  // Each request is about ONE tree and holds only that tree's sweeps, so a reader is
  // never asked to decide which folder a request is about.
  const sca = YAML.parse(
    fs.readFileSync(written[ARTIFACT_SCA].request, "utf8")
  );
  const xpi = YAML.parse(
    fs.readFileSync(written[ARTIFACT_XPI].request, "utf8")
  );
  assert.equal(sca.sweepTarget, "/src/");
  assert.equal(xpi.sweepTarget, "/xpi/");
  assert.deepEqual(
    sca.sweeps.map((s) => s.label),
    [3, 4]
  );
  assert.deepEqual(
    xpi.sweeps.map((s) => s.label),
    [9]
  );
  // Each names its own answers file, and that file holds its own labels - so the two
  // trees cannot be answered into one another.
  assert.equal(sca.answerFile, written[ARTIFACT_SCA].answers);
  assert.deepEqual(
    Object.keys(JSON.parse(fs.readFileSync(xpi.answerFile, "utf8")).answers),
    ["9"]
  );
});

// The condition that prints a step and the slot that step names come from ONE map, so a
// step pointing nowhere and an unfilled slot are both impossible rather than caught later.
test("a slot exists for each tree asked, and none for a tree that was not", () => {
  assert.deepEqual(
    sweepSlots({
      paths: { sweeps: { [ARTIFACT_XPI]: { request: "/x.yaml" } } },
    }),
    { sweepXpi: "/x.yaml" }
  );
  assert.deepEqual(sweepSlots({ paths: {} }), {});
});

// ---- the door ----

test("answers come back resolved to their check and their tree", () => {
  const dir = tmp();
  // EVERY label answered, and each with something of its own: a reader that mapped them
  // all to the first sweep, or took the check off the wrong one, would pass if only one
  // label ever carried a hit.
  const file = answered(dir, {
    3: [{ file: "lib/net.js", line: 12, hint: "posts over http://" }],
    4: [{ file: "bg.js", line: 40, hint: "sends the digest onward" }],
  });
  assert.deepEqual(readSweepAnswers(file, SWEEPS), [
    {
      check: "cleartext-transmission",
      artifact: ARTIFACT_SCA,
      file: "lib/net.js",
      line: 12,
      hint: "posts over http://",
    },
    {
      check: "data-exfiltration",
      artifact: ARTIFACT_SCA,
      file: "bg.js",
      line: 40,
      hint: "sends the digest onward",
    },
  ]);
  // A sweep that found nothing contributes nothing, and says so by answering.
  assert.deepEqual(
    readSweepAnswers(answered(dir, { 3: [], 4: [] }), SWEEPS),
    []
  );
});

// Every one of these is a file an agent wrote, so each is refused by name - the agent
// fixes the one thing and hands back, rather than redoing the pass blind.
test("a file that cannot be acted on is refused, saying which thing is wrong", () => {
  const dir = tmp();
  const refused = (found, re, what) =>
    assert.throws(
      () => readSweepAnswers(answered(dir, found), SWEEPS),
      re,
      what
    );

  // THE one this whole shape exists for: a null is not an answer, and nothing else in
  // the review could tell it apart from a sweep that was run and found nothing.
  refused(
    { 3: null, 4: [] },
    /leaves label 3 unanswered/,
    "a null left behind"
  );
  refused({ 4: [] }, /leaves label 3 unanswered/, "a label dropped entirely");
  refused(
    { 3: [], 4: [], 42: [] },
    /answers label 42, which it was not asked about/,
    "a label nobody asked about"
  );
  refused(
    { 3: "nothing found", 4: [] },
    /answers label 3 with string/,
    "not a list"
  );
  refused(
    { 3: ["a hit"], 4: [] },
    /must be an object/,
    "a hit that is a bare string"
  );
  refused({ 3: [{ line: 3 }], 4: [] }, /names no "file"/, "a hit with no file");
  refused(
    { 3: [{ file: "a.js", severity: "error" }], 4: [] },
    /may only set/,
    "a hit wording the report"
  );
  // The path guards every swept result has always been held to still apply.
  refused(
    { 3: [{ file: "../../etc/passwd" }], 4: [] },
    /names a file INSIDE the add-on/,
    "a hit pointing out of the tree"
  );

  const dir2 = tmp();
  const bad = path.join(dir2, "a.answers.json");
  fs.writeFileSync(bad, "{ not json");
  assert.throws(() => readSweepAnswers(bad, SWEEPS), /is not readable JSON/);
  fs.writeFileSync(bad, JSON.stringify({ nope: {} }));
  assert.throws(() => readSweepAnswers(bad, SWEEPS), /names no "answers"/);
  // A list is an object too, and would read as "no labels at all" rather than as a file
  // written to the wrong shape.
  fs.writeFileSync(bad, JSON.stringify({ answers: [] }));
  assert.throws(() => readSweepAnswers(bad, SWEEPS), /names no "answers"/);
  assert.throws(
    () => readSweepAnswers(path.join(dir2, "gone.json"), SWEEPS),
    /could not be read/
  );
});
