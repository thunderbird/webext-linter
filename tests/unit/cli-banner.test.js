// Unit test for the run banner: the review run opens with the npm-run-style
// two-line header (`> name@version review` / `> node verify.js`).

import { test } from "node:test";
import assert from "node:assert/strict";

import { runBanner } from "../../src/cli.js";

test("runBanner mirrors the npm-run banner for review", () => {
  assert.match(
    runBanner([]),
    /^> webext-linter@\d+\.\d+\.\d+ review\n> node verify\.js$/
  );
});

test("runBanner echoes the run's args on the command line", () => {
  assert.match(
    runBanner(["sub.xpi", "--verbose"]),
    /node verify\.js sub\.xpi --verbose$/
  );
});
