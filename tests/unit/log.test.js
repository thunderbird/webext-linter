// Unit tests for the logger's two streams. On stdout: the SECTION/STEP/DETAIL prefixes
// (callers pass a semantic level, never spaces), progress gated on progressOn while info
// (the run banner) is always shown, and quiet silencing the feed. On stderr: one channel,
// writeToStderr, that prints or - while recording - holds messages back for exitWith.

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
  setProgress,
  setQuiet,
  setRecording,
  writeToStderr,
  exitWith,
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

// What the logger writes to stderr while running fn, one entry per write.
function toStderr(fn) {
  const writes = [];
  const spy = mock.method(process.stderr, "write", (t) =>
    writes.push(String(t))
  );
  try {
    fn();
  } finally {
    spy.mock.restore();
  }
  return writes;
}

// The toggles are module globals; reset to a text-run state (feed on, not quiet, not
// recording) before each test so cases do not leak state into one another.
beforeEach(() => {
  setProgress(true);
  setQuiet(false);
  setRecording(false);
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

test("warn writes a DETAIL notice to stderr; info stays on stdout at column 0", () => {
  assert.deepEqual(
    toStderr(() => warn("Skipping symlink")),
    ["      Skipping symlink\n"]
  );
  assert.deepEqual(
    emitted(() => warn("Skipping symlink")),
    [],
    "never on stdout"
  );
  assert.deepEqual(
    emitted(() => info("> banner")),
    ["> banner"]
  );
});

// A warning says the run is degraded, so it reaches whoever runs it whatever the feed
// shows. Gating it with the feed is how one landed, unsectioned, above an --llm-review
// prompt on stdout.
test("warn ignores the feed switches; only quiet silences it", () => {
  setProgress(false);
  setFeed(false);
  try {
    assert.deepEqual(
      toStderr(() => warn("note")),
      ["      note\n"]
    );
  } finally {
    setFeed(true);
  }
});

test("progress is gated on progressOn; info is always shown", () => {
  setProgress(false);
  assert.deepEqual(
    emitted(() => progress("s", FEED.STEP)),
    []
  );
  // The run banner prints regardless of the progress feed.
  assert.deepEqual(
    emitted(() => info("> banner")),
    ["> banner"]
  );
});

test("quiet silences the feed and warnings, never a fatal message", () => {
  setQuiet(true);
  assert.deepEqual(
    emitted(() => progress("s", FEED.STEP)),
    []
  );
  assert.deepEqual(
    toStderr(() => warn("note")),
    []
  );
  // JSON keeps stdout clean, not stderr: a run that went wrong still says so.
  assert.deepEqual(
    toStderr(() => writeToStderr("boom\n")),
    ["boom\n"]
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

// The runs that print a prompt for an agent hold their stderr messages back and write them
// as one block at exit, after everything else - the agent's harness merges both streams,
// so a message printed in place would read as part of the prompt.
test("while recording, stderr messages are held back and dumped by exitWith", () => {
  const exit = mock.method(process, "exit", () => {});
  try {
    setRecording(true);
    const held = toStderr(() => {
      warn("degraded");
      writeToStderr("fatal\nverify failed\n");
    });
    assert.deepEqual(held, [], "nothing printed in place");
    const dumped = toStderr(() => exitWith(2)).join("");
    assert.equal(
      dumped,
      "\n── Tool messages ──\n\n      degraded\nfatal\nverify failed\n",
      "one block, under its header, in the order written"
    );
    assert.deepEqual(exit.mock.calls[0].arguments, [2]);
  } finally {
    exit.mock.restore();
  }
});

// Outside the recording runs there is nothing held back, so the exit is just the exit.
test("exitWith with nothing recorded writes nothing", () => {
  const exit = mock.method(process, "exit", () => {});
  try {
    assert.deepEqual(
      toStderr(() => exitWith(0)),
      []
    );
    setRecording(true);
    assert.deepEqual(
      toStderr(() => exitWith(0)),
      [],
      "recording, but empty"
    );
    assert.equal(exit.mock.callCount(), 2);
  } finally {
    exit.mock.restore();
  }
});
