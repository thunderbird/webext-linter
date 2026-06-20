// Unit tests for the provider layer: getProvider picks the adapter by
// LLM_API_TYPE, the per-type defaults (model, base URL), and the config /
// model-availability validators the CLI + pipeline rely on.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getProvider,
  defaultModelFor,
  defaultBaseUrlFor,
  validateLlmConfig,
  checkModelAvailable,
  isLlmType,
  LLM_TYPES,
} from "../../src/llm/provider.js";
import {
  DEFAULT_MODEL_CLAUDE,
  DEFAULT_MODEL_OPENAI,
  DEFAULT_MODEL_OLLAMA,
} from "../../src/config.js";
import * as anthropic from "../../src/llm/anthropic.js";
import * as openai from "../../src/llm/openai.js";

test("getProvider selects the adapter by type, defaulting to claude", () => {
  assert.equal(getProvider("claude").callVerdicts, anthropic.callVerdicts);
  assert.equal(getProvider("chatgpt").callVerdicts, openai.callVerdicts);
  // ollama is OpenAI-compatible, so it reuses the OpenAI adapter.
  assert.equal(getProvider("ollama").callVerdicts, openai.callVerdicts);
  assert.equal(getProvider(undefined).callVerdicts, anthropic.callVerdicts);
});

test("getProvider throws on an unknown type", () => {
  assert.throws(() => getProvider("bogus"), /unknown LLM_API_TYPE/);
});

test("isLlmType and LLM_TYPES cover claude, chatgpt, ollama", () => {
  assert.ok(isLlmType("claude") && isLlmType("chatgpt") && isLlmType("ollama"));
  assert.ok(!isLlmType("bogus") && !isLlmType(undefined));
  assert.deepEqual([...LLM_TYPES].sort(), ["chatgpt", "claude", "ollama"]);
});

test("defaultModelFor returns the per-type default (claude when unknown/absent)", () => {
  assert.equal(defaultModelFor("claude"), DEFAULT_MODEL_CLAUDE);
  assert.equal(defaultModelFor("chatgpt"), DEFAULT_MODEL_OPENAI);
  assert.equal(defaultModelFor("ollama"), DEFAULT_MODEL_OLLAMA);
  assert.equal(defaultModelFor(undefined), DEFAULT_MODEL_CLAUDE);
  assert.equal(defaultModelFor("bogus"), DEFAULT_MODEL_CLAUDE);
});

test("defaultBaseUrlFor is the local endpoint for ollama, undefined for cloud", () => {
  assert.match(defaultBaseUrlFor("ollama"), /^http:\/\/localhost:11434\/v1$/);
  assert.equal(defaultBaseUrlFor("claude"), undefined);
  assert.equal(defaultBaseUrlFor("chatgpt"), undefined);
});

// The key requirement lives in the provider: claude/chatgpt need a key, ollama
// (keyless local) does not; an unknown type is rejected first.
test("validateLlmConfig enforces the per-provider key requirement", () => {
  assert.equal(validateLlmConfig("claude", { apiKey: "x" }), null);
  assert.equal(validateLlmConfig("ollama", { apiKey: undefined }), null);
  assert.match(
    validateLlmConfig("chatgpt", { apiKey: undefined }),
    /needs an API token/
  );
  assert.match(
    validateLlmConfig("bogus", { apiKey: "x" }),
    /Unknown LLM_API_TYPE/
  );
});

// Only providers with checkModel (ollama) verify the model up front; cloud is a
// no-op. listModels is injected so the test never touches the network.
test("checkModelAvailable verifies a pulled model for ollama only", async () => {
  const listed = async () => [{ id: "llama3.1:latest" }, { id: "qwen2.5" }];
  // Present (bare name matches the tagged id).
  assert.equal(
    await checkModelAvailable("ollama", {
      model: "llama3.1",
      listModels: listed,
    }),
    null
  );
  // Absent -> actionable "not available" error naming the pull command.
  const absent = await checkModelAvailable("ollama", {
    model: "mistral",
    listModels: listed,
  });
  assert.match(absent, /not available/);
  assert.match(absent, /ollama pull mistral/);
  // Unreachable server -> "could not reach" error.
  assert.match(
    await checkModelAvailable("ollama", {
      model: "llama3.1",
      baseURL: "http://localhost:11434/v1",
      listModels: async () => {
        throw new Error("ECONNREFUSED");
      },
    }),
    /Could not reach the ollama server/
  );
  // Cloud providers are a no-op (and never call listModels).
  let called = false;
  assert.equal(
    await checkModelAvailable("chatgpt", {
      model: "gpt-4o",
      listModels: async () => {
        called = true;
        return [];
      },
    }),
    null
  );
  assert.equal(called, false);
});
