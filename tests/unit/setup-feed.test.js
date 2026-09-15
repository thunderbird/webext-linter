// The Setup feed, pinned line for line - a CHARACTERIZATION test, written against the
// pipeline as it is so that a change to how setup is composed has to reproduce it or
// declare itself.
//
// It locks three things at once that nothing else covers:
//   - the ORDER the slow pre-review steps run in, which today is the order the statements
//     happen to sit in and is enforced by nothing;
//   - their LABELS, which are the only thing a reviewer sees while the tool is silent;
//   - the [done/total] counter, whose total is sized before the steps run.
//
// The goldens cannot stand in for it: progress is a no-op for the harness, so no golden
// contains a Setup line at all. They pin what a review FINDS; this pins how it got there.
//
// Driven through the CLI because that is the only place the feed is switched on
// (setProgress in src/cli.js), and against the seeded cache so every label is decided by
// the fixtures rather than by what a machine happens to have downloaded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SETUP_STEPS } from "../../src/pipeline.js";
import { seedFixtureCache } from "../seed-caches.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");
const CACHE = seedFixtureCache();
const OFFLINE = [
  "--cache-schema-dir",
  CACHE,
  "--cache-hash-db-dir",
  CACHE,
  "--cache-experiments-dir",
  CACHE,
];

/** The Setup section's lines, in order, as a reviewer sees them. */
function setupFeed(args) {
  const r = spawnSync(
    process.execPath,
    [path.join(ROOT, "verify.js"), ...args, ...OFFLINE],
    { encoding: "utf8", cwd: ROOT }
  );
  const block = r.stdout.split("── Setup ──")[1]?.split("── Activity ──")[0];
  assert.ok(block, `no Setup section in: ${args.join(" ")}`);
  return block
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

const addon = (name) => path.join(ROOT, "tests", "addons", name);

// The declaration, read on its own. The feed tests below prove what a RUN prints; these
// prove the list it is printed from is well formed - which is the cheaper place to catch a
// step that was declared without a way to narrate it, or a duplicated key.
test("every declared step is narratable and named once", () => {
  const keys = SETUP_STEPS.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, "keys are unique");
  for (const step of SETUP_STEPS) {
    assert.equal(
      typeof step.when,
      "function",
      `${step.key} declares a condition`
    );
    if (!("label" in step)) {
      continue; // silent: work with no feed line, and not counted
    }
    assert.ok(
      step.label === null || (typeof step.label === "string" && step.label),
      `${step.key} carries a label, or null for one it prints itself`
    );
  }
});

// The totals the four feeds below count towards, derived from the list the way the pipeline
// derives them. A silent step that was counted, or a narrated one that was not, moves a
// number here before anyone has to read a feed.
test("the narrated count per run is the total the feed shows", () => {
  const narrated = (facts) =>
    SETUP_STEPS.filter((s) => "label" in s && s.when(facts)).length;
  const facts = (over) => ({
    sca: false,
    isExp: false,
    invalidExperiment: false,
    ...over,
  });
  assert.equal(narrated(facts()), 7, "an XPI review");
  assert.equal(narrated(facts({ sca: true })), 13, "a source code review");
  assert.equal(narrated(facts({ isExp: true })), 8, "an Experiment review");
  assert.equal(narrated(facts({ sca: true, isExp: true })), 14, "both");
  // The rejection is decided by the third step, and the total is sized BEFORE the run: the
  // same conditions asked with it already decided say three, and the feed still counts
  // towards eight. That gap IS "the counter stops short".
  assert.equal(narrated(facts({ isExp: true, invalidExperiment: true })), 3);
});

// An XPI review: read the add-on, get the schema, then the three library passes, then
// parse. Seven steps, and the counter completes.
test("the setup feed of an XPI review", () => {
  assert.deepEqual(setupFeed([addon("clean")]), [
    "[1/7] Reading add-on",
    "[2/7] Fetching review schemas (release-mv3)",
    "[3/7] Fetching library hashes",
    "[4/7] Verifying vendored libraries",
    "[5/7] Identifying bundled libraries on a CDN",
    "[6/7] Auditing bundled libraries",
    "[7/7] Parsing add-on sources",
  ]);
});

// A source code review does the whole XPI pass FIRST (the shipped artifact is analysed in
// both modes), then the source's own library and dependency passes, then parses the source,
// and analyses the build last. Thirteen steps and a total of thirteen: the total is counted
// off the same list that runs them, so it cannot fall behind the way a typed constant did.
test("the setup feed of a source code review", () => {
  assert.deepEqual(
    setupFeed([
      path.join(addon("build-hygiene-sca"), "xpi"),
      "--sca-root",
      path.join(addon("build-hygiene-sca"), "src"),
      "--sca-source",
      ".",
    ]),
    [
      "[1/13] Reading add-on",
      "[2/13] Fetching review schemas (release-mv3)",
      "[3/13] Fetching library hashes",
      "[4/13] Verifying vendored libraries",
      "[5/13] Identifying bundled libraries on a CDN",
      "[6/13] Auditing bundled libraries",
      "[7/13] Parsing add-on sources",
      "[8/13] Verifying vendored source libraries",
      "[9/13] Auditing source dependencies",
      "[10/13] Identifying source libraries on a CDN",
      "[11/13] Auditing source libraries",
      "[12/13] Parsing add-on sources",
      "[13/13] Analyzing the build",
    ]
  );
});

// An accepted Experiment adds ONE step, and it runs where the classification is needed:
// after the schema, before anything reads code.
test("the setup feed of an accepted Experiment review", () => {
  assert.deepEqual(
    setupFeed([addon("experiment-core-code"), "--allow-experiments"]),
    [
      "[1/8] Reading add-on",
      "[2/8] Fetching review schemas (release-mv3)",
      "[3/8] Verifying bundled experiments",
      "[4/8] Fetching library hashes",
      "[5/8] Verifying vendored libraries",
      "[6/8] Identifying bundled libraries on a CDN",
      "[7/8] Auditing bundled libraries",
      "[8/8] Parsing add-on sources",
    ]
  );
});

// A REJECTED Experiment is the one path whose counter cannot complete: the rejection is
// decided by the experiment step itself, and everything after it is skipped, so the feed
// stops at 3 of a total sized for a review that would have continued. Pinned because it is
// the documented exception - if it ever completes, either the exception is gone or the
// review stopped being aborted.
test("a rejected Experiment stops the setup feed where the review stops", () => {
  const feed = setupFeed([addon("experiment-disallowed")]);
  assert.deepEqual(feed, [
    "[1/8] Reading add-on",
    "[2/8] Fetching review schemas (release-mv3)",
    "[3/8] Verifying bundled experiments",
  ]);
  const [done, total] = feed
    .at(-1)
    .match(/\[(\d+)\/(\d+)\]/)
    .slice(1);
  assert.notEqual(
    done,
    total,
    "the counter stops short, and that is the point"
  );
});

// A rejected Experiment submitted as SOURCE CODE: the total is sized for the source review
// this would have been (fourteen), the rejection is decided by step three, and the review
// that runs is an XPI review of the shipped add-on. The silent steps that name the reviewed
// artifact still run - the report has an add-on to name either way - which no feed line
// shows, so the golden pins the naming and this pins the stopping.
test("a rejected Experiment submitted as source stops at three of a source review's total", () => {
  const dir = addon("experiment-disallowed-sca");
  assert.deepEqual(
    setupFeed([
      path.join(dir, "xpi"),
      "--sca-root",
      path.join(dir, "src"),
      "--sca-source",
      ".",
    ]),
    [
      "[1/14] Reading add-on",
      "[2/14] Fetching review schemas (release-mv3)",
      "[3/14] Verifying bundled experiments",
    ]
  );
});
