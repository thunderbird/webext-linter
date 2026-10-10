// The Setup and Activity feeds, pinned line for line, so that a change to how a review
// computes its data has to reproduce them or declare itself.
//
// It locks what nothing else covers:
//   - the EAGER steps (SETUP_STEPS) and their [done/total] counter, sized before they run;
//   - the review data computed on first ask (src/review/products.js): which of it a review
//     computes, in what order, and under which check's line - the only thing a reviewer
//     sees while the tool is busy.
//
// The goldens cannot stand in for it: progress is a no-op for the harness, so no golden
// contains a feed line at all. They pin what a review FINDS; this pins how it got there.
//
// Driven through the CLI because that is the only place the feed is switched on
// (setProgress in src/cli.js), and against the seeded caches so every label is decided by
// the fixtures rather than by what a machine happens to have downloaded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SETUP_STEPS } from "../../src/pipeline.js";
import { REVIEW_MODE } from "../../src/lib/enum.js";
import {
  addonOutsideRepo,
  cdnMissCache,
  seedFixtureCache,
} from "../seed-caches.js";

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
  "--cache-npm-registry-dir",
  CACHE,
];

/**
 * The feed a reviewer sees, in two parts: the Setup section's lines, and the lines of the
 * review data computed while the checks ran - each printed where it was first needed, so
 * every check line is dropped and what remains is the data, in the order it was computed.
 * The add-on, `args[0]`, is reviewed as a copy outside the repository, since its work folder
 * is created beside it; its CDN lookups are answered by a cache that already holds them.
 */
function feed(args) {
  const [target, ...rest] = args;
  const copy = addonOutsideRepo(target);
  const r = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "verify.js"),
      copy,
      ...rest,
      ...OFFLINE,
      "--cache-cdn-lookup-dir",
      cdnMissCache(
        path.dirname(copy),
        ...rest.filter((a) => a.startsWith("/"))
      ),
    ],
    { encoding: "utf8", cwd: ROOT }
  );
  const [, after] = r.stdout.split("── Setup ──");
  assert.ok(after, `no Setup section in: ${args.join(" ")}\n${r.stderr}`);
  const [setupBlock, rest2 = ""] = after.split("── Activity ──");
  const activityBlock = rest2.split("── Review Details ──")[0];
  const lines = (block) =>
    block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  return {
    setup: lines(setupBlock),
    data: lines(activityBlock).filter(
      (l) => !l.startsWith("[") && !l.startsWith("•")
    ),
  };
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

// The totals the feeds below count towards, derived from the list the way the pipeline
// derives them. A silent step that was counted, or a narrated one that was not, moves a
// number here before anyone has to read a feed.
test("the narrated count per run is the total the feed shows", () => {
  const narrated = (facts) =>
    SETUP_STEPS.filter((s) => "label" in s && s.when(facts)).length;
  // The mode derived as the pipeline derives it (setupFacts.mode).
  const facts = (over) => ({
    sca: false,
    isExp: false,
    invalidExperiment: false,
    ...over,
    get mode() {
      return this.sca && !this.invalidExperiment
        ? REVIEW_MODE.SCA
        : REVIEW_MODE.XPI;
    },
  });
  assert.equal(narrated(facts()), 2, "an XPI review");
  assert.equal(narrated(facts({ sca: true })), 2, "a source code review");
  assert.equal(narrated(facts({ isExp: true })), 3, "an Experiment review");
  assert.equal(narrated(facts({ sca: true, isExp: true })), 3, "both");
  assert.equal(narrated(facts({ isExp: true, invalidExperiment: true })), 3);
  // The steps follow the mode: a rejected Experiment submitted as source has the XPI
  // review's target and no source archive.
  const keys = (f) => SETUP_STEPS.filter((s) => s.when(f)).map((s) => s.key);
  assert.deepEqual(keys(facts({ sca: true, isExp: true })), [
    "read",
    "schema",
    "experiments",
    "experiment-schema",
    "source-archive",
    "target-source",
    "meta",
  ]);
  assert.deepEqual(
    keys(facts({ sca: true, isExp: true, invalidExperiment: true })),
    ["read", "schema", "experiments", "target-xpi", "meta"]
  );
});

// An XPI review: read the add-on, get the schema - the eager steps. Then its checks ask for
// the data, and the first that needs the parsed sources computes everything behind them, in
// the order each stage depends on the one before: the library hashes, the vendor reading,
// the CDN identification, the parse; the audit of the identified libraries last, when the
// vulnerability check asks.
test("the feed of an XPI review", () => {
  assert.deepEqual(feed([addon("clean")]), {
    setup: [
      "[1/2] Reading add-on",
      "[2/2] Fetching review schemas (release-mv3)",
    ],
    data: [
      "Fetching library hashes",
      "Verifying vendored libraries",
      "Identifying bundled libraries on a CDN",
      "Parsing add-on sources",
      "Auditing libraries",
    ],
  });
});

// A source code review computes the shipped XPI's data and the source's own as its checks
// ask for each: the lock's install sources first, for the second check, then both
// artifacts' parsed sources, the XPI's first.
test("the feed of a source code review", () => {
  assert.deepEqual(
    feed([
      path.join(addon("build-hygiene-sca"), "xpi"),
      "--sca-root",
      path.join(addon("build-hygiene-sca"), "src"),
    ]),
    {
      setup: [
        "[1/2] Reading add-on",
        "[2/2] Fetching review schemas (release-mv3)",
      ],
      data: [
        "Checking the lock file's sources",
        "Fetching library hashes",
        "Verifying vendored libraries",
        "Identifying bundled libraries on a CDN",
        "Parsing add-on sources",
        "Verifying vendored source libraries",
        "Auditing source dependencies",
        "Identifying source libraries on a CDN",
        "Parsing add-on sources",
        "Auditing libraries",
        "Analyzing the build",
      ],
    }
  );
});

// A forged lock stops the review at the second check, which reads the lock's install sources
// and nothing else: no library is audited, nothing is looked up on a CDN, nothing is parsed.
test("a forged lock computes nothing but the lock's install sources", () => {
  const dir = addon("sca-lockfile-injection");
  assert.deepEqual(
    feed([path.join(dir, "xpi"), "--sca-root", path.join(dir, "src")]),
    {
      setup: [
        "[1/2] Reading add-on",
        "[2/2] Fetching review schemas (release-mv3)",
      ],
      data: ["Checking the lock file's sources"],
    }
  );
});

// An accepted Experiment adds ONE eager step, where the classification is needed: after
// the schema, before any check reads code.
test("the feed of an accepted Experiment review", () => {
  assert.deepEqual(
    feed([addon("experiment-core-code"), "--allow-experiments"]),
    {
      setup: [
        "[1/3] Reading add-on",
        "[2/3] Fetching review schemas (release-mv3)",
        "[3/3] Verifying bundled experiments",
      ],
      data: [
        "Fetching library hashes",
        "Verifying vendored libraries",
        "Identifying bundled libraries on a CDN",
        "Parsing add-on sources",
        "Auditing libraries",
      ],
    }
  );
});

// A REJECTED Experiment stops at its first check, experiment-not-allowed, which reads the
// manifest.json, the Experiment verdict and the schema - none of the review's data. So none of it is computed:
// no library hashes, no vendor reading, no parse.
test("a rejected Experiment computes none of the review's data", () => {
  assert.deepEqual(feed([addon("experiment-disallowed")]), {
    setup: [
      "[1/3] Reading add-on",
      "[2/3] Fetching review schemas (release-mv3)",
      "[3/3] Verifying bundled experiments",
    ],
    data: [],
  });
});

// The same when it was submitted as SOURCE CODE: the review is an XPI review of the shipped
// add-on, the source is never read, and nothing is computed.
test("a rejected Experiment submitted as source computes nothing either", () => {
  const dir = addon("experiment-disallowed-sca");
  assert.deepEqual(
    feed([path.join(dir, "xpi"), "--sca-root", path.join(dir, "src")]),
    {
      setup: [
        "[1/3] Reading add-on",
        "[2/3] Fetching review schemas (release-mv3)",
        "[3/3] Verifying bundled experiments",
      ],
      data: [],
    }
  );
});
