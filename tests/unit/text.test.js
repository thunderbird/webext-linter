// Unit tests for the text utilities: the wrapText width-wrapper (reflowing
// printed LLM prose to a column width) and the humanSize byte formatter.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  wrapText,
  humanSize,
  displayText,
  displayLine,
} from "../../src/util/text.js";

// A long single line wraps to multiple lines, none over the width, each carrying
// the requested indent.
test("wrapText wraps a long line within the width (including indent)", () => {
  const long = "word ".repeat(40).trim();
  const lines = wrapText(long, "  ", 80);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((l) => l.length <= 80));
  assert.ok(lines.every((l) => l.startsWith("  ")));
});

// The model's own structure is kept: each source line wraps on its own, blank
// lines survive (no re-fill across lines).
test("wrapText preserves source line breaks and blank lines", () => {
  assert.deepEqual(wrapText("first line\n\nsecond line", "", 80), [
    "first line",
    "",
    "second line",
  ]);
});

// A leading list marker hangs its continuations under the text, not the bullet.
test("wrapText hanging-indents a bullet's continuation", () => {
  const lines = wrapText(`- ${"alpha ".repeat(30).trim()}`, "  ", 40);
  assert.ok(lines.length > 1);
  assert.ok(lines[0].startsWith("  - alpha"));
  assert.ok(lines.slice(1).every((l) => /^ {4}\S/.test(l))); // 4-space hang
  assert.ok(lines.every((l) => l.length <= 40));
});

// A single word longer than the width is left intact on its own line rather
// than broken mid-word.
test("wrapText does not break an over-long word", () => {
  const url = `https://example.com/${"x".repeat(100)}`;
  const lines = wrapText(`see ${url} end`, "", 40);
  assert.ok(lines.some((l) => l.includes(url)));
});

// humanSize: bytes under 1 KB, then one-decimal KB / MB at the boundaries.
test("humanSize formats B / KB / MB", () => {
  assert.equal(humanSize(0), "0 B");
  assert.equal(humanSize(812), "812 B");
  assert.equal(humanSize(1024), "1.0 KB");
  assert.equal(humanSize(1536), "1.5 KB");
  assert.equal(humanSize(1024 * 1024), "1.0 MB");
  assert.equal(humanSize(2.4 * 1024 * 1024), "2.4 MB");
});

// The guard on everything the review shows a person. It removes what can alter the
// printed report - an escape sequence repaints the terminal around a finding, a bidi
// override makes a path read as something it is not - and nothing else. Tab, CR and
// LF are ordinary text and stay, so prose meant to have shape keeps it.
test("displayText removes what can alter the report, and nothing else", () => {
  const ESC = "\u001B";
  assert.equal(displayText(`a${ESC}[2Kb`), "a [2Kb");
  // Replaced with a space, not deleted - deleting would let "htt<ESC>ps://evil" fuse
  // into a working URL.
  assert.equal(displayText(`htt${ESC}ps://evil`), "htt ps://evil");
  for (const ch of ["\u0000", "\u0008", "\u000C", "\u202E", "\u200B"]) {
    assert.equal(displayText(`x${ch}y`), "x y", JSON.stringify(ch));
  }
  // Ordinary text, untouched.
  assert.equal(displayText("one\ntwo\tthree\r\n"), "one\ntwo\tthree\r\n");
  assert.equal(displayText("plain"), "plain");
  // Nullish is the empty string, never the word "null".
  assert.equal(displayText(null), "");
  assert.equal(displayText(undefined), "");
});

// A sink that emits ONE line needs more: there a newline is not text, it is a second
// line. A packaged file named "a.js\n - INJECTED.js" would otherwise render as two
// loci, indistinguishable from a real second finding.
test("displayLine collapses what would become a second line", () => {
  const ESC = "\u001B";
  assert.equal(displayLine("a.js\n - INJECTED.js"), "a.js - INJECTED.js");
  assert.equal(
    displayLine("harmless.js\rOVERWRITTEN.js"),
    "harmless.js OVERWRITTEN.js"
  );
  assert.equal(displayLine(`one\ntwo\tthree ${ESC}[2K`), "one two three [2K");
  assert.equal(displayLine("  padded  "), "padded");
  assert.equal(displayLine(null), "");
});
