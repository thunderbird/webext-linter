// Unit tests for small shared helpers: src/checks/lib/util.js and src/util/log.js.

import { test } from "node:test";
import assert from "node:assert/strict";

import { llmEnabled } from "../../src/checks/lib/util.js";
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
