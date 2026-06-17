// Unit tests for the per-source AST reuse: parseApiUsage / scanRemoteJs /
// scanUnsafeHtml accept an optional pre-parsed result and use it instead of
// re-parsing `code`. buildRunContext parses each source once and passes it, so
// the same source is parsed a single time across all consumers.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseApiUsage } from "../../src/parse/api-usage.js";
import { scanRemoteJs } from "../../src/parse/remote-js.js";
import { scanUnsafeHtml } from "../../src/parse/unsafe-html.js";

// A sentinel parse result. `code` here parses fine (parseError would be null), so
// surfacing this parseError proves the parser used `parsed` and did NOT re-parse.
const SENTINEL = { ast: null, parseError: "SENTINEL" };
const CLEAN_CODE = "var ok = 1;";

test("parseApiUsage reuses a supplied parse instead of re-parsing code", () => {
  assert.equal(parseApiUsage(CLEAN_CODE, 0, SENTINEL).parseError, "SENTINEL");
});

test("scanRemoteJs reuses a supplied parse instead of re-parsing code", () => {
  assert.equal(scanRemoteJs(CLEAN_CODE, 0, SENTINEL).parseError, "SENTINEL");
});

test("scanUnsafeHtml reuses a supplied parse instead of re-parsing code", () => {
  assert.equal(scanUnsafeHtml(CLEAN_CODE, 0, SENTINEL).parseError, "SENTINEL");
});

test("with no supplied parse, the parsers still parse code themselves", () => {
  // Backward-compatible path (existing callers pass only code): clean code parses.
  assert.equal(parseApiUsage(CLEAN_CODE).parseError, null);
  assert.equal(scanRemoteJs(CLEAN_CODE).parseError, null);
  assert.equal(scanUnsafeHtml(CLEAN_CODE).parseError, null);
});
