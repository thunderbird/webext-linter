// Unit tests for the per-source AST reuse: the per-concern scanners accept an
// optional pre-parsed result and use it instead of re-parsing `code`. The
// extraction pass parses each source once and passes that result, so the review
// pass's consumers reuse it rather than re-parsing.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseApiUsage } from "../../src/parse/api-usage.js";
import { scanRemoteJs } from "../../src/parse/remote-js.js";
import { scanUnsafeHtml } from "../../src/parse/unsafe-html.js";
import { scanLocalImports } from "../../src/parse/local-imports.js";
import { scanLoaderRefs } from "../../src/parse/loader-files.js";
import { scanExperimentInjectedRefs } from "../../src/parse/core-loaders.js";
import { scanCoreSymbols } from "../../src/parse/core-symbols.js";
import { scanSyncXhr } from "../../src/parse/sync-xhr.js";
import { scanDebugger } from "../../src/parse/debugger-statement.js";
import { scanAsyncOnMessage } from "../../src/parse/async-onmessage.js";
import { scanWebApiCalls } from "../../src/parse/web-api-calls.js";
import { parseJs } from "../../src/parse/ast.js";

// A sentinel parse result. `code` here parses fine (parseError would be null), so
// surfacing this parseError proves the parser used `parsed` and did NOT re-parse.
const SENTINEL = { ast: null, parseError: "SENTINEL" };
const CLEAN_CODE = "var ok = 1;";

// Each scanner: [name, (code, parsed) => result]. The wrapper places `parsed` at
// the scanner's own parameter position and supplies any required middle args.
const REUSERS = [
  ["parseApiUsage", (c, p) => parseApiUsage(c, 0, p)],
  ["scanRemoteJs", (c, p) => scanRemoteJs(c, 0, p)],
  ["scanUnsafeHtml", (c, p) => scanUnsafeHtml(c, 0, p)],
  ["scanLocalImports", (c, p) => scanLocalImports(c, 0, p)],
  ["scanLoaderRefs", (c, p) => scanLoaderRefs(c, 0, null, null, p)],
  [
    "scanExperimentInjectedRefs",
    (c, p) => scanExperimentInjectedRefs(c, new Set(["ns"]), 0, p),
  ],
  ["scanCoreSymbols", (c, p) => scanCoreSymbols(c, 0, p)],
  ["scanSyncXhr", (c, p) => scanSyncXhr(c, 0, p)],
  ["scanDebugger", (c, p) => scanDebugger(c, 0, p)],
  ["scanAsyncOnMessage", (c, p) => scanAsyncOnMessage(c, 0, p)],
];

for (const [name, run] of REUSERS) {
  test(`${name} reuses a supplied parse instead of re-parsing code`, () => {
    assert.equal(run(CLEAN_CODE, SENTINEL).parseError, "SENTINEL");
  });

  test(`${name} still parses code itself with no supplied parse`, () => {
    // Backward-compatible path (existing callers pass only code): clean code parses.
    assert.equal(run(CLEAN_CODE, undefined).parseError, null);
  });
}

// scanWebApiCalls returns a Set (not {hits, parseError}), so it is outside the
// REUSERS loop; prove its reuse with a hit that could only come from the supplied
// AST, never from re-parsing CLEAN_CODE (which has no web-api call).
test("scanWebApiCalls reuses a supplied parse instead of re-parsing code", () => {
  const sigs = [
    {
      permission: "geolocation",
      receiver: "navigator.geolocation",
      methods: ["getCurrentPosition"],
    },
  ];
  const nav = parseJs("navigator.geolocation.getCurrentPosition();");
  assert.ok(scanWebApiCalls(CLEAN_CODE, sigs, nav).has("geolocation"));
  assert.equal(scanWebApiCalls(CLEAN_CODE, sigs).size, 0);
});
