// Unit tests for the LLM client (createLlmClient - the batched verdict
// transport). No network: the client uses an injected callClaude.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createLlmClient } from "../../src/checks/llm-client.js";
import { createLlmBudget } from "../../src/llm/budget.js";
import { MAX_FILES_PER_BATCH } from "../../src/config.js";

function clientWith(files, callClaude) {
  const map = new Map([["manifest.json", Buffer.from("{}")]]);
  for (const f of files) {
    map.set(f, Buffer.from(`// ${f}\n`));
  }
  const ctx = {
    addon: {
      files: map,
      manifest: { manifest_version: 3, name: "x", version: "1" },
    },
  };
  return createLlmClient({ ctx, token: "t", systemIntro: "intro", callClaude });
}

// evaluate returns one verdict per candidate id; the orchestrator maps those ids
// to outcomes, the client only relays verdicts keyed by id.
test("evaluate returns a verdict per candidate id", async () => {
  const llm = clientWith(["a.js", "b.js"], async () => ({
    verdicts: [
      { id: "E1", verdict: "fail", reason: "r1" },
      { id: "E2", verdict: "pass", reason: null },
    ],
  }));
  const out = await llm.evaluate({
    rubric: "R",
    candidates: [
      { id: "E1", file: "a.js" },
      { id: "E2", file: "b.js" },
    ],
  });
  assert.deepEqual(out.get("E1"), { verdict: "fail", reason: "r1" });
  assert.deepEqual(out.get("E2"), { verdict: "pass", reason: null });
});

// LLM_API_URL threads to every transport as `baseURL` (the SDK base-URL override).
test("createLlmClient forwards the url to the transports as baseURL", async () => {
  const seen = {};
  const ctx = {
    addon: {
      files: new Map([
        ["manifest.json", Buffer.from("{}")],
        ["a.js", Buffer.from("// a\n")],
      ]),
      manifest: { manifest_version: 3, name: "x", version: "1" },
    },
  };
  const llm = createLlmClient({
    ctx,
    token: "t",
    systemIntro: "intro",
    url: "https://proxy.example/v1",
    callClaude: async (p) => {
      seen.evaluate = p;
      return { verdicts: [] };
    },
    callClaudeText: async (p) => {
      seen.summarize = p;
      return "";
    },
    callClaudeReview: async (p) => {
      seen.review = p;
      return { summary: "", unusedPermissions: [] };
    },
  });
  await llm.evaluate({ rubric: "R", candidates: [{ id: "E1", file: "a.js" }] });
  await llm.summarize("p");
  await llm.reviewAddon("p");
  assert.equal(seen.evaluate.baseURL, "https://proxy.example/v1");
  assert.equal(seen.summarize.baseURL, "https://proxy.example/v1");
  assert.equal(seen.review.baseURL, "https://proxy.example/v1");
});

// An id the model omits defaults to unsure; an id it invents (not in the batch)
// is dropped. The model can never introduce a subject we did not ask about.
test("evaluate defaults missing ids to unsure and drops unknown ids", async () => {
  const llm = clientWith(["a.js"], async () => ({
    verdicts: [
      { id: "E1", verdict: "fail", reason: null },
      { id: "GHOST", verdict: "pass", reason: null },
    ],
  }));
  const out = await llm.evaluate({
    rubric: "R",
    candidates: [
      { id: "E1", file: "a.js" },
      { id: "E2", file: "a.js" },
    ],
  });
  assert.equal(out.get("E1").verdict, "fail");
  assert.equal(out.get("E2").verdict, "unsure"); // omitted -> unsure
  assert.ok(!out.has("GHOST")); // invented -> dropped
});

// Candidates split so each call's distinct corpus files stay within
// MAX_FILES_PER_BATCH; MAX+1 distinct files -> two calls.
test("evaluate splits candidates into file-bounded batches", async () => {
  const files = Array.from(
    { length: MAX_FILES_PER_BATCH + 1 },
    (_, i) => `f${i}.js`
  );
  const calls = [];
  const llm = clientWith(files, async ({ criterion }) => {
    calls.push(criterion);
    return { verdicts: [] };
  });
  const candidates = files.map((f, i) => ({ id: `E${i}`, file: f }));
  const out = await llm.evaluate({ rubric: "R", candidates });
  assert.equal(calls.length, 2);
  assert.equal(out.size, candidates.length);
  for (const c of candidates) {
    assert.equal(out.get(c.id).verdict, "unsure");
  }
});

// The run-wide request budget stops evaluate mid-stream: once it is spent, no
// more model calls are made and the remaining candidates default to "unsure"
// (so the orchestrator routes them to manual review, like a token-less run).
test("evaluate stops at the request budget; the rest are unsure", async () => {
  const files = Array.from(
    { length: MAX_FILES_PER_BATCH * 3 },
    (_, i) => `f${i}.js`
  );
  let calls = 0;
  // step:1 with no confirmMore -> one request, then a hard stop.
  const budget = createLlmBudget({ step: 1 });
  const map = new Map([["manifest.json", Buffer.from("{}")]]);
  for (const f of files) {
    map.set(f, Buffer.from(`// ${f}\n`));
  }
  const ctx = {
    addon: {
      files: map,
      manifest: { manifest_version: 3, name: "x", version: "1" },
    },
  };
  const llm = createLlmClient({
    ctx,
    token: "t",
    systemIntro: "intro",
    budget,
    callClaude: async () => {
      calls++;
      return { verdicts: [] };
    },
  });
  const candidates = files.map((f, i) => ({ id: `E${i}`, file: f }));
  const out = await llm.evaluate({ rubric: "R", candidates });
  assert.equal(calls, 1); // only the first batch ran; the budget stopped the rest
  assert.equal(out.size, candidates.length);
  for (const c of candidates) {
    assert.equal(out.get(c.id).verdict, "unsure");
  }
});

// A batch whose call errors never throws; its candidates fall back to unsure so
// the orchestrator routes them to manual review.
test("evaluate turns a batch error into unsure (never throws)", async () => {
  const llm = clientWith(["a.js"], async () => {
    throw new Error("boom");
  });
  const out = await llm.evaluate({
    rubric: "R",
    candidates: [{ id: "E1", file: "a.js" }],
  });
  assert.equal(out.get("E1").verdict, "unsure");
});

// The shared system context (reviewer intro + cached add-on block) is built once
// and reused across every batch; its add-on block is cache_control ephemeral.
test("client builds one cached system context, reused across batches", async () => {
  const files = Array.from(
    { length: MAX_FILES_PER_BATCH + 1 },
    (_, i) => `f${i}.js`
  );
  const systems = [];
  const llm = clientWith(files, async ({ system }) => {
    systems.push(system);
    return { verdicts: [] };
  });
  await llm.evaluate({
    rubric: "R",
    candidates: files.map((f, i) => ({ id: `E${i}`, file: f })),
  });
  assert.equal(systems.length, 2);
  assert.equal(systems[0], systems[1]);
  assert.equal(systems[0][1].cache_control.type, "ephemeral");
});
