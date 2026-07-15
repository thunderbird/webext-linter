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
import { defaultModel } from "../../src/llm/settings.js";

// The adapters are told apart by the client they drive: Anthropic sends
// messages.create, OpenAI chat.completions.create. A fake serves one shape only,
// so reaching the wrong adapter is a TypeError rather than a passing test.
function anthropicClient(onCreate) {
  return { messages: { create: async (r) => onCreate(r) } };
}
function openaiClient(onCreate) {
  return { chat: { completions: { create: async (r) => onCreate(r) } } };
}
const VERDICT_REPLY = {
  content: [
    {
      type: "tool_use",
      name: "report_verdicts",
      input: { verdicts: [{ id: "E1", verdict: "pass" }] },
    },
  ],
};

test("getProvider selects the adapter by type, defaulting to claude", async () => {
  const call = (type, client) =>
    getProvider(type).callVerdicts({
      token: "t",
      model: "m",
      system: [],
      criterion: "c",
      client,
    });
  await call(
    "claude",
    anthropicClient(() => VERDICT_REPLY)
  );
  await call(
    undefined,
    anthropicClient(() => VERDICT_REPLY)
  );
  await call(
    "chatgpt",
    openaiClient(() => toolCall())
  );
  // ollama is OpenAI-compatible, so it reuses the OpenAI adapter.
  await call(
    "ollama",
    openaiClient(() => toolCall())
  );
});

test("getProvider binds the type in, so the adapter reads that type's model table", async () => {
  // gpt-5.6-luna is a chatgpt entry (the responses endpoint, max_output_tokens); under
  // ollama the same id is a stranger and gets that file's catch-all (chat, max_tokens).
  const seen = {};
  await getProvider("chatgpt").callVerdicts({
    token: "t",
    model: "gpt-5.6-luna",
    system: [],
    criterion: "c",
    client: {
      chat: {
        completions: {
          create: async () =>
            assert.fail("chatgpt gpt-5.6-luna must use the responses endpoint"),
        },
      },
      responses: {
        create: async (r) => {
          seen.chatgpt = r;
          return fnCall();
        },
      },
    },
  });
  await getProvider("ollama").callVerdicts({
    token: "t",
    model: "gpt-5.6-luna",
    system: [],
    criterion: "c",
    client: openaiClient((r) => {
      seen.ollama = r;
      return toolCall();
    }),
  });
  assert.equal(seen.chatgpt.max_output_tokens, 32768);
  assert.equal(seen.chatgpt.max_tokens, undefined);
  assert.equal(seen.ollama.max_tokens, 8192);
  assert.equal(seen.ollama.max_output_tokens, undefined);
});

function toolCall() {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            {
              function: {
                name: "report_verdicts",
                arguments: JSON.stringify({
                  verdicts: [{ id: "E1", verdict: "pass" }],
                }),
              },
            },
          ],
        },
      },
    ],
  };
}

/** A forced function call on the responses endpoint (what a responses model returns). */
function fnCall() {
  return {
    status: "completed",
    output: [
      {
        type: "function_call",
        name: "report_verdicts",
        call_id: "c1",
        arguments: JSON.stringify({
          verdicts: [{ id: "E1", verdict: "pass" }],
        }),
      },
    ],
  };
}

test("getProvider throws on an unknown type", () => {
  assert.throws(() => getProvider("bogus"), /unknown LLM_API_TYPE/);
});

test("isLlmType and LLM_TYPES cover claude, chatgpt, ollama", () => {
  assert.ok(isLlmType("claude") && isLlmType("chatgpt") && isLlmType("ollama"));
  assert.ok(!isLlmType("bogus") && !isLlmType(undefined));
  assert.deepEqual([...LLM_TYPES].sort(), ["chatgpt", "claude", "ollama"]);
});

test("defaultModelFor returns the per-type default (claude when unknown/absent)", () => {
  for (const type of LLM_TYPES) {
    assert.equal(defaultModelFor(type), defaultModel(type));
  }
  assert.equal(defaultModelFor(undefined), defaultModel("claude"));
  assert.equal(defaultModelFor("bogus"), defaultModel("claude"));
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
