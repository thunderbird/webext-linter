// Deterministic tests for the OpenAI (ChatGPT) adapter: the chat-completions
// request it builds (a forced function call for structured output, a plain
// completion for text) and the coercion of the result. A fake client records the
// request, so nothing reaches the network and the openai SDK is never loaded.

import { test } from "node:test";
import assert from "node:assert/strict";

import { callVerdicts, callText, callReview } from "../../src/llm/openai.js";

function fakeClient(onCreate) {
  return { chat: { completions: { create: async (r) => onCreate(r) } } };
}

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

test("callVerdicts forces the report_verdicts function and coerces the result", async () => {
  let req;
  const client = fakeClient((r) => {
    req = r;
    return toolCall("report_verdicts", {
      verdicts: [{ id: "E1", verdict: "pass" }],
    });
  });
  const result = await callVerdicts({
    token: "t",
    model: "m",
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
  assert.equal(req.model, "m");
  assert.deepEqual(result.verdicts, [
    { id: "E1", verdict: "pass", reason: null, additionalInformation: "" },
  ]);
});

test("callText returns the message content with no tools, no system when absent", async () => {
  let req;
  const client = fakeClient((r) => {
    req = r;
    return { choices: [{ message: { content: "  a summary  " } }] };
  });
  const out = await callText({
    token: "t",
    model: "m",
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
      recheck: [{ check: "unused-permission", item: "tabs", verdict: "fail" }],
    })
  );
  const out = await callReview({ token: "t", model: "m", prompt: "x", client });
  assert.equal(out.summary, "S");
  assert.deepEqual(out.recheck, [
    { check: "unused-permission", item: "tabs", verdict: "fail", reason: "" },
  ]);
});

test("a missing function call surfaces as an error, not a silent verdict", async () => {
  const client = fakeClient(() => ({
    choices: [{ message: { content: "prose, no tool call" } }],
  }));
  await assert.rejects(
    () => callVerdicts({ token: "t", system: [], criterion: "c", client }),
    /structured function call/
  );
});
