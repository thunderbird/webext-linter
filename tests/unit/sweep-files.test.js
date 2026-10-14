// The sweep's request and the door its answers come back through.
//
// This is the ONLY place a sweep's findings enter the review, and the agent that returns
// them is reading an add-on rather than the linter - so every guard here exists because a
// file that cannot be acted on has to be refused by name, at a point the agent can
// correct, rather than half-applied downstream.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ARTIFACT_SCA, ARTIFACT_XPI } from "../../src/lib/artifacts.js";
import {
  readSweepAnswers,
  sweepRequests,
  sweepSlots,
} from "../../src/report/sweep-files.js";
import { MAX_HINT } from "../../src/report/sweep.js";
import { workPaths } from "../../src/util/dest.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wxl-sweepfiles-"));

/** The swept tree these answers are read against: every file they name, each long
 *  enough for the line it is named at. */
const TREE = tmp();
for (const [rel, lines] of [
  ["a.js", 1],
  ["background.js", 40],
  ["bg.js", 40],
  ["lib/net.js", 12],
]) {
  fs.mkdirSync(path.dirname(path.join(TREE, rel)), { recursive: true });
  fs.writeFileSync(path.join(TREE, rel), "x\n".repeat(lines));
}

/** One tree's request, made the way the review makes it. */
function requested(sweeps, sweepTarget = "/tmp/tree/") {
  const asked = sweepRequests(
    workPaths("/w"),
    { items: sweeps },
    { [ARTIFACT_SCA]: sweepTarget, [ARTIFACT_XPI]: sweepTarget }
  );
  return asked[sweeps[0].artifact];
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

// The request has to stand alone: the agent is handed it and nothing else, so everything
// it needs to do the job is in it or nowhere.
test("the request names its tree and every sweep, and asks for the reply", () => {
  const { request } = requested(SWEEPS);
  // The folder on a line of its own, indented so the prompt keeps it whole.
  assert.match(request, /^ {2}\/tmp\/tree\/$/m);
  // The count is stated, so an agent can see whether it answered them all rather than
  // inferring it from a list it may have stopped reading.
  assert.match(request, /in 2 separate sweeps/);
  assert.match(
    request,
    /^Label 3: Unencrypted data transmission\nA remote endpoint/m
  );
  assert.match(request, /^Label 4: User-data exfiltration\nMessage content/m);
  // The answers come back as the reply, and nothing is written.
  assert.match(request, /Return your answers as your reply/);
  assert.match(request, /^ {2}\{"answers": \{"<label>": \[\.\.\.\]\}\}$/m);
  assert.match(request, /Write no file\.$/);
  assert.doesNotMatch(request, /answers\.json/, "it names no file to write");

  // Nothing of the review's own vocabulary reaches the agent: not a check id, not an
  // artifact. It is told which folder and what to look for, and answers by label.
  assert.ok(!request.includes("cleartext-transmission"), "no check id");
  assert.ok(!request.includes(ARTIFACT_SCA), "no artifact name");
});

// A sub-agent's reply cannot be edited by the agent that relays it, so a hint the door
// refuses as too long costs a whole sweep. The request states the limit the door holds it
// to, read from the one constant, and so does the refusal of a hint that is no phrase.
test("the request and the refusal name the hint's limit", () => {
  const { request } = requested(SWEEPS);
  assert.ok(
    request.includes(
      `a "hint" - a short phrase of at most ${MAX_HINT} characters naming what is there -`
    ),
    request
  );
  const dir = tmp();
  assert.throws(
    () =>
      readSweepAnswers(
        answered(dir, { 3: [{ file: "a.js", hint: "" }], 4: [] }),
        SWEEPS,
        TREE
      ),
    (err) => err.message.includes(`at most ${MAX_HINT} characters`)
  );
});

// A sweep reading several files at once can number its lines across all of them. The
// request says a line is the file's own, and that the file is one in the folder it read.
test("the request says a file is in the folder and a line is that file's own", () => {
  const { request } = requested(SWEEPS);
  assert.ok(
    request.includes(
      'a "file" (the path of a file in the folder above, relative to it)'
    ),
    request
  );
  assert.ok(
    request.includes(
      `a "line" - that file's own line number, counted from its first line, where it sits on one, left out where it does not.`
    ),
    request
  );
});

// The example is the part an agent copies, so it has to be the shape the door accepts -
// and it must not suggest what to go and find.
test("the worked example fixes the shape without suggesting a finding", () => {
  const { request } = requested(SWEEPS);
  // Every label appears, so the example doubles as the list of what must come back, and
  // the empty list is shown as well as a find.
  assert.match(request, /"3": \[/);
  assert.match(request, /"4": \[\]/);
  // A placeholder where the content would be. A plausible hint here is a suggestion.
  assert.match(request, /"hint": "<what is there>"/);
  // And the example parses as the JSON it claims to be, and as one the door accepts.
  const from = request.indexOf("Answered, your reply reads:");
  const example = request.slice(
    request.indexOf("{", from),
    request.lastIndexOf("}") + 1
  );
  assert.deepEqual(Object.keys(JSON.parse(example).answers), ["3", "4"]);
  const file = path.join(tmp(), "a.answers.json");
  fs.writeFileSync(file, example);
  assert.equal(readSweepAnswers(file, SWEEPS, TREE).length, 1);
});

// ---- one request per tree ----

test("one request is made per tree, grouped from the pre-sweep list", () => {
  const files = workPaths("/w");
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
  const asked = sweepRequests(files, preSweep, {
    [ARTIFACT_SCA]: "/src/",
    [ARTIFACT_XPI]: "/xpi/",
  });
  assert.deepEqual(Object.keys(asked).sort(), [ARTIFACT_SCA, ARTIFACT_XPI]);
  // Each request is about ONE tree and holds only that tree's sweeps, so a reader is
  // never asked to decide which folder a request is about.
  assert.match(asked[ARTIFACT_SCA].request, /^ {2}\/src\/$/m);
  assert.match(asked[ARTIFACT_XPI].request, /^ {2}\/xpi\/$/m);
  assert.match(asked[ARTIFACT_SCA].request, /^Label 3: /m);
  assert.doesNotMatch(asked[ARTIFACT_SCA].request, /^Label 9: /m);
  assert.match(asked[ARTIFACT_XPI].request, /^Label 9: /m);
  assert.doesNotMatch(asked[ARTIFACT_XPI].request, /^Label 3: /m);
  // Each names its own answers file, so the two trees cannot be answered into one
  // another - and nothing is written: the orchestrating agent writes the answers.
  assert.equal(asked[ARTIFACT_SCA].answers, files.sweep(ARTIFACT_SCA));
  assert.equal(asked[ARTIFACT_XPI].answers, files.sweep(ARTIFACT_XPI));
  assert.ok(!fs.existsSync("/w"), "nothing is written");
});

// The condition that prints a step and the slots that step names come from ONE map, so a
// step pointing nowhere and an unfilled slot are both impossible rather than caught later.
test("slots exist for each tree asked, and none for a tree that was not", () => {
  assert.deepEqual(
    sweepSlots({
      paths: {
        sweeps: {
          [ARTIFACT_XPI]: { request: "Sweep it.", answers: "/x.answers.json" },
        },
      },
    }),
    { sweepXpi: "Sweep it.", sweepXpiAnswers: "/x.answers.json" }
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
  assert.deepEqual(readSweepAnswers(file, SWEEPS, TREE), [
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
    readSweepAnswers(answered(dir, { 3: [], 4: [] }), SWEEPS, TREE),
    []
  );
});

// Every one of these is a file an agent wrote, so each is refused by name - the agent
// fixes the one thing and hands back, rather than redoing the pass blind.
test("a file that cannot be acted on is refused, saying which thing is wrong", () => {
  const dir = tmp();
  const refused = (found, re, what) =>
    assert.throws(
      () => readSweepAnswers(answered(dir, found), SWEEPS, TREE),
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
  // Every swept result is held to the path guards.
  refused(
    { 3: [{ file: "../../etc/passwd" }], 4: [] },
    /names a file INSIDE the add-on/,
    "a hit pointing out of the tree"
  );

  const dir2 = tmp();
  const bad = path.join(dir2, "a.answers.json");
  fs.writeFileSync(bad, "{ not json");
  assert.throws(
    () => readSweepAnswers(bad, SWEEPS, TREE),
    /is not readable JSON/
  );
  fs.writeFileSync(bad, JSON.stringify({ nope: {} }));
  assert.throws(
    () => readSweepAnswers(bad, SWEEPS, TREE),
    /names no "answers"/
  );
  // A list is an object too, and would read as "no labels at all" rather than as a file
  // written to the wrong shape.
  fs.writeFileSync(bad, JSON.stringify({ answers: [] }));
  assert.throws(
    () => readSweepAnswers(bad, SWEEPS, TREE),
    /names no "answers"/
  );
  assert.throws(
    () => readSweepAnswers(path.join(dir2, "gone.json"), SWEEPS, TREE),
    /could not be read/
  );
});

// The door holds every reply to the tree it was asked about, so a file that tree lacks,
// or a line past a file's end, is refused by the entry that names it.
test("a reply naming a file or line the tree lacks is refused by its entry", () => {
  const dir = tmp();
  const refused = (found, says) =>
    assert.throws(
      () =>
        readSweepAnswers(answered(dir, { 3: [found], 4: [] }), SWEEPS, TREE),
      (err) => err.message.includes(says)
    );
  refused(
    { file: "gone.js", line: 1 },
    'a.answers.json, label 3, entry 1 names file "gone.js", which is not a file in the folder the sweep read'
  );
  refused(
    { file: "lib/net.js", line: 13 },
    'a.answers.json, label 3, entry 1 names line 13 of "lib/net.js", which has 12 lines'
  );
  // The same file named many times in one reply is read against the same count.
  const many = Array.from({ length: 5 }, (_, i) => ({
    file: "lib/net.js",
    line: 12 - i,
  }));
  assert.equal(
    readSweepAnswers(answered(dir, { 3: many, 4: [] }), SWEEPS, TREE).length,
    5
  );
});
