// Deterministic tests for the LLM protocol that need no network: the request
// callVerdicts builds (B) and the exact prompt createLlmClient assembles (C).
// Both inject a fake transport so nothing reaches the Anthropic API. The
// coercion of the model's answer (A) lives in claude.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { callVerdicts, callText } from "../../src/llm/anthropic.js";
import { createLlmClient } from "../../src/checks/llm-client.js";
import { loadRegistry } from "../../src/checks/registry.js";
import { MAX_RESPONSE_TOKENS } from "../../src/config.js";
import { withManifest } from "./manifest-ctx.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === "1";

// B - request shape. The forced tool_choice is the load-bearing guarantee: it
// makes the model answer through the structured result tool instead of prose,
// which is what the coercion step relies on. A fake client records the request
// so we can assert it without a network call.
test("callVerdicts forces the structured result tool", async () => {
  let req;
  const fakeClient = {
    messages: {
      create: async (r) => {
        req = r;
        return {
          content: [
            {
              type: "tool_use",
              name: "report_verdicts",
              input: { verdicts: [{ id: "E1", verdict: "pass" }] },
            },
          ],
        };
      },
    },
  };

  const result = await callVerdicts({
    token: "test-token",
    model: "test-model",
    system: [{ type: "text", text: "sys" }],
    criterion: "the rubric",
    client: fakeClient,
  });

  // The model cannot free-form: it must answer through report_verdicts, one
  // entry per candidate id, with no field to name a subject of its own.
  assert.deepEqual(req.tool_choice, { type: "tool", name: "report_verdicts" });
  assert.equal(req.tools[0].name, "report_verdicts");
  const entry = req.tools[0].input_schema.properties.verdicts.items;
  assert.deepEqual(entry.properties.verdict.enum, ["fail", "pass", "unsure"]);
  assert.ok(
    entry.required.includes("id") && entry.required.includes("verdict")
  );
  assert.ok(req.tools[0].input_schema.required.includes("verdicts"));
  // The rest of the request is wired through verbatim.
  assert.equal(req.model, "test-model");
  assert.equal(req.max_tokens, MAX_RESPONSE_TOKENS);
  assert.deepEqual(req.system, [{ type: "text", text: "sys" }]);
  assert.deepEqual(req.messages, [{ role: "user", content: "the rubric" }]);
  // And the structured result is coerced on the way out.
  assert.deepEqual(result.verdicts, [
    { id: "E1", verdict: "pass", reason: null, additionalInformation: "" },
  ]);
});

// A malformed response (no tool_use block) must surface as an error, never a
// silent verdict - escalation.js maps a transport error to manual review.
test("callVerdicts throws when no tool_use block is returned", async () => {
  const fakeClient = {
    messages: {
      create: async () => ({ content: [{ type: "text", text: "hi" }] }),
    },
  };
  await assert.rejects(
    () =>
      callVerdicts({
        token: "test-token",
        system: [],
        criterion: "c",
        client: fakeClient,
      }),
    /structured tool_use/
  );
});

// callText (the change-summary path) is free-form: NO forced result tool,
// and it returns the joined text blocks - not a coerced verdict.
test("callText sends a free-form request and returns the text", async () => {
  let req;
  const fakeClient = {
    messages: {
      create: async (r) => {
        req = r;
        return {
          content: [
            { type: "text", text: "a summary" },
            { type: "text", text: "line two" },
          ],
        };
      },
    },
  };
  const out = await callText({
    token: "test-token",
    model: "test-model",
    prompt: "summarize this",
    client: fakeClient,
  });
  assert.equal(out, "a summary\nline two");
  assert.equal(req.tools, undefined); // no tool definition
  assert.equal(req.tool_choice, undefined); // not forced into a tool
  assert.deepEqual(req.messages, [{ role: "user", content: "summarize this" }]);
  assert.equal(req.model, "test-model");
});

// A deterministic add-on so the assembled context is byte-stable. __nonce pins the
// per-review nonce (normally random) so the wrapped-data markers are golden-stable.
const ctx = withManifest({
  __nonce: "0123456789abcdef",
  addon: {
    manifest: {
      manifest_version: 3,
      name: "Sample",
      version: "1.0",
      default_locale: "en",
      web_accessible_resources: [
        { resources: ["icon.png"], matches: ["<all_urls>"] },
      ],
    },
    files: new Map([
      ["manifest.json", Buffer.from("{}")],
      ["background.js", Buffer.from("console.log(1)")],
      ["_locales/en/messages.json", Buffer.from("{}")],
    ]),
  },
});

// C - prompt golden. Locks the exact text sent to the model (reviewer intro +
// rendered add-on context + criterion) so an edit to the system-intro prompt,
// the context framing, or the wiring shows up as a reviewable diff. The intro
// and the real rubrics live in the registry yaml; the criterion here is a fixed
// stand-in, so this golden isolates the assembly, not the rubric wording.
// Regenerate with UPDATE_GOLDEN=1.
test("createLlmClient assembles the documented prompt", async () => {
  let captured;
  const client = createLlmClient({
    ctx,
    token: "test-token",
    systemIntro: loadRegistry().prompt("system-intro"),
    model: "test-model",
    callVerdicts: async (params) => {
      captured = params;
      return { verdicts: [] };
    },
  });
  await client.evaluate({
    rubric: "Check that the add-on does not execute remote code.",
    candidates: [
      { id: "E1", file: "background.js", line: 1, note: "an example site" },
    ],
    addon: ctx.addon,
  });

  const rendered =
    [
      "=== SYSTEM (block 0: reviewer intro) ===",
      captured.system[0].text,
      "",
      "=== SYSTEM (block 1: add-on context, cache_control=ephemeral) ===",
      captured.system[1].text,
      "",
      "=== USER (criterion) ===",
      captured.criterion,
    ].join("\n") + "\n";

  const golden = path.join(here, "..", "golden", "llm-prompt.txt");
  if (UPDATE_GOLDEN || !fs.existsSync(golden)) {
    fs.writeFileSync(golden, rendered);
    return;
  }
  assert.equal(rendered, fs.readFileSync(golden, "utf8"));
});
