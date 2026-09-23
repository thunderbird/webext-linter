// Unit tests for the feed logger's indentation levels + gating: the logger owns
// the SECTION/STEP/DETAIL prefixes (callers pass a semantic level, never spaces),
// progress and warn are gated on progressOn while info (the run banner) is always
// shown, and quiet silences everything.

import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  progress,
  report,
  setFeed,
  warn,
  info,
  debug,
  setVerbose,
  FEED,
  feedIndent,
  setProgress,
  setQuiet,
} from "../../src/util/log.js";

// The lines the logger writes with console.log while running fn (its stdout feed).
function emitted(fn) {
  const lines = [];
  const spy = mock.method(console, "log", (...a) => lines.push(a.join(" ")));
  try {
    fn();
  } finally {
    spy.mock.restore();
  }
  return lines;
}

// The toggles are module globals; reset to a text-run state (feed on, not quiet)
// before each test so cases do not leak state into one another.
beforeEach(() => {
  setProgress(true);
  setQuiet(false);
});

test("feedIndent maps each level to its exact prefix width", () => {
  assert.equal(feedIndent(FEED.SECTION), "");
  assert.equal(feedIndent(FEED.STEP), "  ");
  assert.equal(feedIndent(FEED.DETAIL), "      ");
  // An out-of-range level degrades to column 0 rather than undefined-prefixing.
  assert.equal(feedIndent(99), "");
});

test("progress indents by its level; SECTION (the default) is column 0", () => {
  assert.deepEqual(
    emitted(() => progress("h", FEED.SECTION)),
    ["h"]
  );
  assert.deepEqual(
    emitted(() => progress("s", FEED.STEP)),
    ["  s"]
  );
  assert.deepEqual(
    emitted(() => progress("n", FEED.DETAIL)),
    ["      n"]
  );
  assert.deepEqual(
    emitted(() => progress("── Setup ──")),
    ["── Setup ──"]
  );
});

test("warn defaults to a DETAIL notice; info stays at column 0", () => {
  assert.deepEqual(
    emitted(() => warn("Skipping symlink")),
    ["      Skipping symlink"]
  );
  assert.deepEqual(
    emitted(() => info("> banner")),
    ["> banner"]
  );
});

test("progress and warn are gated on progressOn; info is always shown", () => {
  setProgress(false);
  assert.deepEqual(
    emitted(() => progress("s", FEED.STEP)),
    []
  );
  assert.deepEqual(
    emitted(() => warn("note")),
    []
  );
  // The run banner prints regardless of the progress feed.
  assert.deepEqual(
    emitted(() => info("> banner")),
    ["> banner"]
  );
});

test("quiet silences every channel", () => {
  setQuiet(true);
  assert.deepEqual(
    emitted(() => progress("s", FEED.STEP)),
    []
  );
  assert.deepEqual(
    emitted(() => warn("note")),
    []
  );
  assert.deepEqual(
    emitted(() => info("> banner")),
    []
  );
});

// setFeed governs the ACTIVITY FEED - the Setup and Activity sections - and is switched
// off for --llm-review / --llm-verdict, where the output is the document itself.
// report() is not feed and survives.
test("setFeed(false) silences the feed", () => {
  setProgress(true);
  setFeed(false);
  try {
    const feed = emitted(() => progress("step", FEED.STEP));
    const doc = emitted(() => report("Reviewed XPI: x"));
    assert.deepEqual(feed, [], "feed line not printed");
    assert.deepEqual(
      doc,
      ["Reviewed XPI: x"],
      "the report's own line still prints"
    );
  } finally {
    // Restored even on a failure: the toggles are module globals, so leaving the feed
    // off here would cascade into every test after this one.
    setFeed(true);
  }
});

test("the level prefix sits OUTSIDE a color wrap (spaces are colorless)", () => {
  const colored = "\x1b[31mX\x1b[0m";
  assert.deepEqual(
    emitted(() => progress(colored, FEED.DETAIL)),
    [`      ${colored}`]
  );
});

// Verbose output is where the submission is quoted most freely - a file body, a
// path that failed to parse, a provider's error body. The guard sits inside debug rather
// than at its ~30 call sites, so a caller added later inherits it. Newlines survive:
// these dumps have shape and none of them is a single line.
test("debug removes control characters from what it dumps", () => {
  const ESC = "\u001B";
  setVerbose(true);
  try {
    const lines = emitted(() => debug(`[scan] reply:\n${ESC}[2K${ESC}[1Afake`));
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes(ESC), "no escape reached the feed");
    assert.ok(lines[0].includes("\n"), "the dump kept its shape");
    assert.match(lines[0], /\[2K \[1Afake/);
  } finally {
    setVerbose(false);
  }
});
