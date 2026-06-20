// Unit tests for the provider dispatcher: getProvider picks the adapter by
// LLM_API_TYPE (default claude), rejects unknown types, and defaultModelFor /
// isLlmType report the per-type defaults and the supported names.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getProvider,
  defaultModelFor,
  isLlmType,
  LLM_TYPES,
} from "../../src/llm/provider.js";
import { DEFAULT_MODEL, DEFAULT_MODEL_OPENAI } from "../../src/config.js";
import * as anthropic from "../../src/llm/anthropic.js";
import * as openai from "../../src/llm/openai.js";

test("getProvider selects the adapter by type, defaulting to claude", () => {
  assert.equal(getProvider("claude").callVerdicts, anthropic.callVerdicts);
  assert.equal(getProvider("chatgpt").callVerdicts, openai.callVerdicts);
  assert.equal(getProvider(undefined).callVerdicts, anthropic.callVerdicts);
});

test("getProvider throws on an unknown type", () => {
  assert.throws(() => getProvider("bogus"), /unknown LLM_API_TYPE/);
});

test("isLlmType and LLM_TYPES cover exactly the two providers", () => {
  assert.ok(isLlmType("claude") && isLlmType("chatgpt"));
  assert.ok(!isLlmType("bogus") && !isLlmType(undefined));
  assert.deepEqual([...LLM_TYPES].sort(), ["chatgpt", "claude"]);
});

test("defaultModelFor returns the per-type default (claude when unknown/absent)", () => {
  assert.equal(defaultModelFor("claude"), DEFAULT_MODEL);
  assert.equal(defaultModelFor("chatgpt"), DEFAULT_MODEL_OPENAI);
  assert.equal(defaultModelFor(undefined), DEFAULT_MODEL);
  assert.equal(defaultModelFor("bogus"), DEFAULT_MODEL);
});
