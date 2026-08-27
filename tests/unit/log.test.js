// Unit tests for the feed logger's indentation levels + gating: the logger owns
// the SECTION/STEP/DETAIL prefixes (callers pass a semantic level, never spaces),
// progress and warn are gated on progressOn while info (the run banner) is always
// shown, and quiet silences everything. Capture records regardless of what shows.

import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  progress,
  warn,
  info,
  debug,
  llmErrorText,
  setVerbose,
  FEED,
  feedIndent,
  setProgress,
  setQuiet,
  setCapture,
  getCapture,
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

// The toggles are module globals; reset to a text-run state (feed on, not quiet,
// no capture) before each test so cases do not leak state into one another.
beforeEach(() => {
  setProgress(true);
  setQuiet(false);
  setCapture(false);
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

test("capture records the indented line even when nothing is shown", () => {
  // Progress off: nothing prints, but capture still records (for --report-out).
  setProgress(false);
  setCapture(true);
  const shown = emitted(() => progress("n", FEED.DETAIL));
  assert.deepEqual(shown, [], "not printed while progress is off");
  assert.equal(getCapture(), "      n\n", "recorded with its DETAIL indent");
  setCapture(false);
});

test("the level prefix sits OUTSIDE a color wrap (spaces are colorless)", () => {
  const colored = "\x1b[31mX\x1b[0m";
  assert.deepEqual(
    emitted(() => progress(colored, FEED.DETAIL)),
    [`      ${colored}`]
  );
});

// Verbose output is where the submission is quoted most freely - whole prompts, a
// model's raw reply, a path that failed to parse. The guard sits inside debug rather
// than at its ~30 call sites, so a caller added later inherits it. Newlines survive:
// these dumps have shape and none of them is a single line.
test("debug removes control characters from what it dumps", () => {
  const ESC = "\u001B";
  setVerbose(true);
  try {
    const lines = emitted(() => debug(`[llm] reply:\n${ESC}[2K${ESC}[1Afake`));
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes(ESC), "no escape reached the feed");
    assert.ok(lines[0].includes("\n"), "the dump kept its shape");
    assert.match(lines[0], /\[2K \[1Afake/);
  } finally {
    setVerbose(false);
  }
});

// The provider's error body can echo the submission - or the operator's own
// --llm-url proxy composes it - and all five callers print it on one feed line, so
// the guard is inside llmErrorText rather than at each of them.
test("llmErrorText guards the provider's message", () => {
  const ESC = "\u001B";
  assert.equal(llmErrorText({ message: `a${ESC}[2Kb` }), "a [2Kb");
  assert.equal(llmErrorText({ message: `a\nb`, status: 400 }), "HTTP 400: a b");
});
