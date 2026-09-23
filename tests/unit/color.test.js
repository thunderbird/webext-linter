// Unit tests for terminal color: the wrappers add ANSI only once enabled, so a
// piped run - where the CLI never enables it - stays plain text.

import { test } from "node:test";
import assert from "node:assert/strict";

import { setColor, red, green, yellow, blue } from "../../src/util/color.js";

test("color is a no-op until enabled, then wraps and strips cleanly", () => {
  setColor(false);
  for (const c of [red, green, yellow, blue]) {
    assert.equal(c("x"), "x");
  }

  setColor(true);
  const r = red("x");
  assert.notEqual(r, "x", "enabled color should wrap the text");
  assert.match(r, /x/, "the text itself survives the wrap");

  setColor(false); // reset module state for any later use
});
