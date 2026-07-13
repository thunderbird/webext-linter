// Unit tests for small shared helpers: src/lib/util.js and src/util/log.js.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseVersion, cmpVersion } from "../../src/lib/util.js";
import { llmErrorText } from "../../src/util/log.js";

// A failed LLM step reports this one-liner (in the feed and the summary notice):
// the HTTP status when the SDK error carries one (e.g. 400 for an over-long
// prompt), else the bare message.
test("llmErrorText prefixes the HTTP status when present", () => {
  assert.equal(
    llmErrorText({ status: 400, message: "maximum context length is 128000" }),
    "HTTP 400: maximum context length is 128000"
  );
  assert.equal(
    llmErrorText({ statusCode: 503, message: "down" }),
    "HTTP 503: down"
  );
  assert.equal(llmErrorText(new Error("boom")), "boom");
  assert.equal(llmErrorText("nope"), "nope");
});

// Version parsing: numeric tuples per component, leading non-digits dropped, and
// null for nothing-numeric or the "≤"/"<"-prefixed pre-WebExtension marker.
test("parseVersion reads numeric component tuples", () => {
  assert.deepEqual(parseVersion("115.0"), [115, 0]);
  assert.deepEqual(parseVersion("140.4.1"), [140, 4, 1]);
  assert.deepEqual(parseVersion(" 154 "), [154]);
  assert.deepEqual(parseVersion("0a1"), [0]);
  assert.equal(parseVersion("≤59"), null);
  assert.equal(parseVersion("<60"), null);
  assert.equal(parseVersion("abc"), null);
  assert.equal(parseVersion(undefined), null);
});

// Component-wise compare, missing components treated as 0.
test("cmpVersion compares component-wise", () => {
  assert.equal(cmpVersion([154], [154, 0]), 0);
  assert.equal(cmpVersion([153, 9], [154]), -1);
  assert.equal(cmpVersion([200], [154]), 1);
  assert.equal(cmpVersion([140, 4, 1], [140, 4]), 1);
});
