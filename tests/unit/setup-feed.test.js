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
// and analyses the build last. Thirteen steps and a total of thirteen: the total is
// SETUP_STEPS' own length, so it cannot fall behind the steps the way a typed constant did.
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
