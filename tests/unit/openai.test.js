// Deterministic tests for the OpenAI (ChatGPT) adapter: the request it builds on
// each of its two endpoints (chat/completions and responses), the coercion of the
// result, and the negotiation - when the server rejects a request shape, the
// adapter must repair it from the rejection, remember the repair, and write it
// back to the model table. Fake clients record the requests, so nothing reaches
// the network and the openai SDK is never loaded; resetLlmSettings() points the
// table at a tmp copy, so no test can rewrite the shipped assets/llm files.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { callVerdicts, callText, callReview } from "../../src/llm/openai.js";
import { resetLlmSettings } from "../../src/llm/settings.js";
import { copyLlmTable } from "./llm-table.js";

// A private copy of the shipped table per test: the negotiation WRITES to it.
let dir;
beforeEach(() => {
  dir = copyLlmTable();
  resetLlmSettings(dir);
});

/** A chat-only client (no `responses` resource), like a local OpenAI-compatible server. */
function fakeClient(onCreate) {
  return { chat: { completions: { create: async (r) => onCreate(r) } } };
}

/** A client that serves both endpoints, recording which one was asked. */
function bothClient({ chat, responses }) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create: async (r) => {
          calls.push({ endpoint: "chat", req: r });
          return chat(r);
        },
      },
    },
    responses: {
      create: async (r) => {
        calls.push({ endpoint: "responses", req: r });
        return responses(r);
      },
    },
  };
}

/** The openai SDK's APIError, duck-typed (the SDK is never loaded here). */
function apiError(status, { param = null, message = "" } = {}) {
  return Object.assign(new Error(message), {
    status,
    param,
    type: "invalid_request_error",
  });
}

/** A forced function call on chat/completions. */
function toolCall(name, args) {
  return {
    choices: [
      {
        message: {
          tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  };
}

/** The same, on the responses endpoint. */
function fnCall(name, args) {
  return {
    status: "completed",
    output: [
      {
        type: "function_call",
        name,
        call_id: "c1",
        arguments: JSON.stringify(args),
      },
    ],
  };
}

const VERDICTS = { verdicts: [{ id: "E1", verdict: "pass" }] };
const COERCED = [
  { id: "E1", verdict: "pass", reason: null, additionalInformation: "" },
];

test("callVerdicts forces the report_verdicts function and coerces the result", async () => {
  let req;
  const client = fakeClient((r) => {
    req = r;
    return toolCall("report_verdicts", VERDICTS);
  });
  const result = await callVerdicts({
    token: "t",
    type: "chatgpt",
    model: "gpt-4.1",
    system: [{ type: "text", text: "sys" }],
    criterion: "the rubric",
    client,
  });
  // Forced function-call on the structured tool, schema passed through.
  assert.deepEqual(req.tool_choice, {
    type: "function",
    function: { name: "report_verdicts" },
  });
  assert.equal(req.tools[0].function.name, "report_verdicts");
  assert.ok(req.tools[0].function.parameters.required.includes("verdicts"));
  // The Anthropic-style system blocks are flattened to one system message.
  assert.deepEqual(req.messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "the rubric" },
  ]);
  assert.equal(req.model, "gpt-4.1");
  // The model's parameters, straight from assets/llm/chatgpt.yaml.
  assert.equal(req.max_tokens, 8192);
  assert.deepEqual(result.verdicts, COERCED);
});

test("callText returns the message content with no tools, no system when absent", async () => {
  let req;
  const client = fakeClient((r) => {
    req = r;
    return { choices: [{ message: { content: "  a summary  " } }] };
  });
  const out = await callText({
    token: "t",
    type: "chatgpt",
    model: "gpt-4.1",
    prompt: "summarize",
    client,
  });
  assert.equal(out, "a summary");
  assert.equal(req.tools, undefined);
  assert.deepEqual(req.messages, [{ role: "user", content: "summarize" }]);
});

test("callReview forces the review function and coerces", async () => {
  const client = fakeClient(() =>
    toolCall("report_addon_review", {
      summary: "S",
      recheck: [
        { check: "unused-permission-recheck", item: "tabs", verdict: "fail" },
      ],
    })
  );
  const out = await callReview({
    token: "t",
    type: "chatgpt",
    model: "gpt-4.1",
    prompt: "x",
    client,
  });
  assert.equal(out.summary, "S");
  assert.deepEqual(out.recheck, [
    {
      check: "unused-permission-recheck",
      item: "tabs",
      verdict: "fail",
      reason: "",
    },
  ]);
});

test("a missing function call surfaces as an error, not a silent verdict", async () => {
  const client = fakeClient(() => ({
    choices: [{ message: { content: "prose, no tool call" } }],
  }));
  await assert.rejects(
    () =>
      callVerdicts({
        token: "t",
        type: "chatgpt",
        model: "gpt-4.1",
        system: [],
        criterion: "c",
        client,
      }),
    /did not return a structured function call/
  );
});

test("an exhausted output-token cap says so, rather than blaming the model", async () => {
  const client = fakeClient(() => ({
    choices: [{ message: { content: "" }, finish_reason: "length" }],
  }));
  await assert.rejects(
    () =>
      callVerdicts({
        token: "t",
        type: "chatgpt",
        model: "gpt-4.1",
        system: [],
        criterion: "c",
        client,
      }),
    /output-token limit/
  );
});

test("a reasoning model is sent max_completion_tokens, never max_tokens", async () => {
  let req;
  const client = fakeClient((r) => {
    req = r;
    return toolCall("report_verdicts", VERDICTS);
  });
  await callVerdicts({
    token: "t",
    type: "chatgpt",
    model: "gpt-5.1",
    system: [],
    criterion: "c",
    client,
  });
  assert.equal(req.max_completion_tokens, 32768);
  assert.equal(req.max_tokens, undefined);
});

test("a codex model goes to the responses endpoint, in its own request shape", async () => {
  const client = bothClient({
    chat: () => assert.fail("chat/completions must not be called for codex"),
    responses: () => fnCall("report_verdicts", VERDICTS),
  });
  const result = await callVerdicts({
    token: "t",
    type: "chatgpt",
    model: "gpt-5.1-codex-max",
    system: [{ type: "text", text: "sys" }],
    criterion: "the rubric",
    client,
  });
  const { req } = client.calls[0];
  assert.deepEqual(
    client.calls.map((c) => c.endpoint),
    ["responses"]
  );
  assert.equal(req.instructions, "sys");
  assert.equal(req.input, "the rubric");
  assert.equal(req.max_output_tokens, 32768);
  assert.equal(req.max_tokens, undefined);
  // The Responses function tool is flat, and must opt out of `strict` - our
  // schemas have optional properties, which a strict tool rejects.
  assert.equal(req.tools[0].type, "function");
  assert.equal(req.tools[0].name, "report_verdicts");
  assert.equal(req.tools[0].strict, false);
  assert.ok(req.tools[0].parameters.required.includes("verdicts"));
  assert.deepEqual(req.tool_choice, {
    type: "function",
    name: "report_verdicts",
  });
  assert.deepEqual(result.verdicts, COERCED);
});

test("callText and callReview read the responses endpoint's output items", async () => {
  const client = bothClient({
    chat: () => assert.fail("chat/completions must not be called for codex"),
    responses: (r) =>
      r.tools
        ? fnCall("report_addon_review", { summary: "S", recheck: [] })
        : {
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "  a summary  " }],
              },
            ],
          },
  });
  const model = "gpt-5.1-codex-max";
  const text = await callText({
    token: "t",
    type: "chatgpt",
    model,
    prompt: "summarize",
    client,
  });
  assert.equal(text, "a summary");
  assert.equal(client.calls[0].req.tools, undefined);

  const review = await callReview({
    token: "t",
    type: "chatgpt",
    model,
    prompt: "x",
    client,
  });
  assert.equal(review.summary, "S");
});

test("an unlisted model gets the table's catch-all: chat + max_tokens", async () => {
  let req;
  const client = fakeClient((r) => {
    req = r;
    return toolCall("report_verdicts", VERDICTS);
  });
  await callVerdicts({
    token: "t",
    type: "chatgpt",
    model: "some-unknown-model",
    system: [],
    criterion: "c",
    client,
  });
  assert.equal(req.max_tokens, 8192);
});

test("a local ollama model is sent the same request as always: chat + max_tokens", async () => {
  const client = bothClient({
    chat: () => toolCall("report_verdicts", VERDICTS),
    responses: () => assert.fail("a local server has no responses endpoint"),
  });
  await callVerdicts({
    token: "",
    type: "ollama",
    model: "llama3.1",
    baseURL: "http://localhost:11434/v1",
    system: [],
    criterion: "c",
    client,
  });
  assert.deepEqual(
    client.calls.map((c) => c.endpoint),
    ["chat"]
  );
  assert.equal(client.calls[0].req.max_tokens, 8192);
});

test("a rejected max_tokens is renamed, and the repair is remembered", async () => {
  const client = bothClient({
    chat: (r) => {
      if (r.max_tokens !== undefined) {
        throw apiError(400, {
          param: "max_tokens",
          message:
            "Unsupported parameter: 'max_tokens' is not supported with this " +
            "model. Use 'max_completion_tokens' instead.",
        });
      }
      return toolCall("report_verdicts", VERDICTS);
    },
    responses: () =>
      assert.fail("a parameter rejection is not an endpoint problem"),
  });
  const call = () =>
    callVerdicts({
      token: "t",
      type: "chatgpt",
      model: "gpt-4.1",
      system: [],
      criterion: "c",
      client,
    });

  await call();
  // Rejected once, repaired, sent again - and the second request carries the
  // other parameter name, not both.
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].req.max_completion_tokens, 8192);
  assert.equal(client.calls[1].req.max_tokens, undefined);

  await call();
  // The repair held: no second probe.
  assert.equal(client.calls.length, 3);
  assert.equal(client.calls[2].req.max_completion_tokens, 8192);
});

test("a chat 404 that names the responses endpoint moves the model - and the cap - there", async () => {
  const client = bothClient({
    chat: () => {
      throw apiError(404, {
        param: "model",
        message:
          "This model is not supported in the v1/chat/completions endpoint. " +
          "Use the v1/responses endpoint instead.",
      });
    },
    responses: () => fnCall("report_verdicts", VERDICTS),
  });
  const call = () =>
    callVerdicts({
      token: "t",
      type: "chatgpt",
      model: "gpt-4.1",
      system: [],
      criterion: "c",
      client,
    });

  await call();
  assert.deepEqual(
    client.calls.map((c) => c.endpoint),
    ["chat", "responses"]
  );
  // The cap came along, under the name that endpoint accepts.
  assert.equal(client.calls[1].req.max_output_tokens, 8192);
  assert.equal(client.calls[1].req.max_tokens, undefined);

  await call();
  assert.deepEqual(
    client.calls.map((c) => c.endpoint),
    ["chat", "responses", "responses"]
  );
});

test("a negotiated shape is written back to the model table", async () => {
  const client = bothClient({
    chat: (r) => {
      if (r.max_tokens !== undefined) {
        throw apiError(400, { param: "max_tokens", message: "Unsupported" });
      }
      return toolCall("report_verdicts", VERDICTS);
    },
    responses: () => assert.fail("not an endpoint problem"),
  });
  await callVerdicts({
    token: "t",
    type: "chatgpt",
    model: "gpt-4.1",
    baseURL: "https://proxy.example/v1",
    system: [],
    criterion: "c",
    client,
  });
  const file = YAML.parse(
    fs.readFileSync(path.join(dir, "chatgpt.yaml"), "utf8")
  );
  assert.deepEqual(file.learned, [
    {
      name: "gpt-4.1",
      baseURL: "https://proxy.example/v1",
      endpoint: "chat",
      maxRequests: 25,
      parameters: { max_completion_tokens: 8192 },
    },
  ]);
  // A run that needed no repair writes nothing.
  assert.equal(
    YAML.parse(fs.readFileSync(path.join(dir, "ollama.yaml"), "utf8")).learned
      .length,
    0
  );
});

test("a rejected max_completion_tokens is renamed back (an older or local server)", async () => {
  const client = bothClient({
    chat: (r) => {
      if (r.max_completion_tokens !== undefined) {
        throw apiError(400, {
          param: "max_completion_tokens",
          message: "Unsupported parameter",
        });
      }
      return toolCall("report_verdicts", VERDICTS);
    },
    responses: () => assert.fail("not an endpoint problem"),
  });
  await callVerdicts({
    token: "t",
    type: "chatgpt",
    model: "gpt-5.1",
    system: [],
    criterion: "c",
    client,
  });
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].req.max_tokens, 32768);
});

test("a 404 that is not an endpoint problem surfaces as itself, and changes nothing", async () => {
  const client = bothClient({
    chat: () => {
      throw apiError(404, {
        message: 'model "llama3.1" not found, try pulling it',
      });
    },
    responses: () =>
      assert.fail("a dead local server has no responses endpoint"),
  });
  const call = () =>
    callVerdicts({
      token: "",
      type: "ollama",
      model: "llama3.1",
      baseURL: "http://localhost:11434/v1",
      system: [],
      criterion: "c",
      client,
    });

  await assert.rejects(
    call,
    (err) => err.status === 404 && /not found/.test(err.message)
  );
  assert.equal(client.calls.length, 1);
  // Nothing was learned from it: the next call goes out exactly as before.
  await assert.rejects(call, (err) => err.status === 404);
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].req.max_tokens, 8192);
});

test("an error the adapter cannot repair is rethrown unchanged, without a retry", async () => {
  const client = bothClient({
    chat: () => {
      throw apiError(401, { message: "Incorrect API key provided" });
    },
    responses: () => assert.fail("not an endpoint problem"),
  });
  await assert.rejects(
    () =>
      callVerdicts({
        token: "bad",
        type: "chatgpt",
        model: "gpt-4.1",
        system: [],
        criterion: "c",
        client,
      }),
    (err) => err.status === 401 && /Incorrect API key/.test(err.message)
  );
  assert.equal(client.calls.length, 1);
});

test("a server that rejects every shape gives up instead of looping", async () => {
  const client = bothClient({
    chat: (r) => {
      throw apiError(400, {
        param:
          r.max_tokens !== undefined ? "max_tokens" : "max_completion_tokens",
        message: "Unsupported parameter",
      });
    },
    responses: () => assert.fail("not an endpoint problem"),
  });
  await assert.rejects(
    () =>
      callVerdicts({
        token: "t",
        type: "chatgpt",
        model: "gpt-4.1",
        system: [],
        criterion: "c",
        client,
      }),
    (err) => err.status === 400
  );
  // Both chat shapes tried, then it stops.
  assert.equal(client.calls.length, 2);
});
