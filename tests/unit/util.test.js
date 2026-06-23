// Unit tests for small shared helpers: src/checks/lib/util.js and src/util/log.js.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  llmEnabled,
  parseVersion,
  cmpVersion,
  strictMinAtLeast,
} from "../../src/checks/lib/util.js";
import { llmErrorText } from "../../src/util/log.js";

// The LLM is enabled ONLY by ctx.options.llmEnabled (set from --llm-enabled),
// fully decoupled from the credentials - a keyless provider (Ollama) has no key
// yet is still enabled, and a stray key never enables it.
test("llmEnabled is driven solely by options.llmEnabled", () => {
  assert.equal(llmEnabled({ options: { llmEnabled: true } }), true);
  assert.equal(llmEnabled({ options: { llmEnabled: false } }), false);
  assert.equal(llmEnabled({ options: {} }), false);
  assert.equal(llmEnabled({}), false);
  // A key present without the flag does NOT enable; the flag without a key does.
  assert.equal(llmEnabled({ options: { llmApiKey: "sk-x" } }), false);
  assert.equal(
    llmEnabled({ options: { llmEnabled: true, llmApiKey: undefined } }),
    true
  );
});

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

// True only when a parsable strict_min_version compares >= the threshold; absent
// or unparsable is false (the relaxed / pre-D308076 default). Reads both the
// browser_specific_settings and legacy applications keys (via strictMinVersion).
test("strictMinAtLeast gates on a parsable, high-enough strict_min_version", () => {
  const bss = (v) => ({
    browser_specific_settings: { gecko: { strict_min_version: v } },
  });
  assert.equal(strictMinAtLeast(bss("154"), "154"), true);
  assert.equal(strictMinAtLeast(bss("200"), "154"), true);
  assert.equal(strictMinAtLeast(bss("153.9"), "154"), false);
  assert.equal(strictMinAtLeast(bss("128"), "154"), false);
  assert.equal(strictMinAtLeast(bss("abc"), "154"), false);
  assert.equal(strictMinAtLeast({}, "154"), false);
  assert.equal(strictMinAtLeast(undefined, "154"), false);
  // The legacy applications key is honored too.
  assert.equal(
    strictMinAtLeast(
      { applications: { gecko: { strict_min_version: "154" } } },
      "154"
    ),
    true
  );
});
