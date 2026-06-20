// Unit tests for src/checks/lib/util.js helpers.

import { test } from "node:test";
import assert from "node:assert/strict";

import { llmEnabled } from "../../src/checks/lib/util.js";

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
