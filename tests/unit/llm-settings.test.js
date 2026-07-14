// Tests for the model table (assets/llm/<type>.yaml + src/llm/settings.js): that
// the shipped files parse and still say what the code used to hard-code, that a
// model id resolves the way the files promise (learned -> name -> match, in file
// order), that a malformed entry is refused at load time, and that a learned entry
// is written back without flattening the hand-written file.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import {
  defaultModel,
  modelSettings,
  learnModel,
  resetLlmSettings,
} from "../../src/llm/settings.js";
import { LLM_TYPES, DEFAULT_LLM_TYPE } from "../../src/llm/provider.js";
import { copyLlmTable, LLM_ASSETS as ASSETS } from "./llm-table.js";

// A private copy of the table per test, since learnModel writes to it.
let dir;
beforeEach(() => {
  dir = copyLlmTable();
  resetLlmSettings(dir);
});

/** Write a table of our own, to state a resolution rule outright. */
function table(type, content) {
  fs.writeFileSync(path.join(dir, `${type}.yaml`), YAML.stringify(content));
  resetLlmSettings(dir);
}

test("every LLM_API_TYPE has a shipped file, and the fallback type is one of them", () => {
  resetLlmSettings();
  for (const type of LLM_TYPES) {
    assert.ok(
      fs.existsSync(path.join(ASSETS, `${type}.yaml`)),
      `assets/llm/${type}.yaml is missing`
    );
    assert.ok(defaultModel(type), `${type} names no default model`);
  }
  // settings.js answers for an unknown type out of the default type's file, so
  // the two must agree on which that is.
  assert.equal(defaultModel("bogus"), defaultModel(DEFAULT_LLM_TYPE));
});

test("the shipped defaults are the ones the code used to hard-code", () => {
  resetLlmSettings();
  assert.equal(defaultModel("claude"), "claude-sonnet-4-6");
  assert.equal(defaultModel("chatgpt"), "gpt-4.1");
  assert.equal(defaultModel("ollama"), "llama3.1");
  for (const type of LLM_TYPES) {
    const s = modelSettings(type, "", defaultModel(type));
    assert.equal(s.maxRequests, 25);
    assert.equal(s.parameters.max_tokens, 8192);
  }
});

test("every model entry's token parameter is one its endpoint accepts", () => {
  const legal = {
    chat: ["max_tokens", "max_completion_tokens"],
    responses: ["max_output_tokens"],
    // Anthropic names no endpoint: it has only one.
    undefined: ["max_tokens"],
  };
  for (const type of LLM_TYPES) {
    const file = YAML.parse(
      fs.readFileSync(path.join(ASSETS, `${type}.yaml`), "utf8")
    );
    for (const entry of file.models) {
      const caps = Object.keys(entry.parameters ?? {}).filter((k) =>
        k.startsWith("max_")
      );
      for (const cap of caps) {
        assert.ok(
          legal[entry.endpoint].includes(cap),
          `${type}: "${cap}" is not a parameter of the ${entry.endpoint} endpoint`
        );
      }
    }
  }
});

test("a model resolves learned first, then an exact name, then a pattern in file order", () => {
  table("chatgpt", {
    default: { model: "m", maxRequests: 25 },
    models: [
      { match: ".*", endpoint: "chat", parameters: { max_tokens: 1 } },
      { name: "exact", endpoint: "chat", parameters: { max_tokens: 2 } },
      { match: "^ex", endpoint: "chat", parameters: { max_tokens: 3 } },
    ],
    learned: [
      {
        name: "exact",
        baseURL: "http://proxy/v1",
        endpoint: "responses",
        parameters: { max_output_tokens: 4 },
      },
    ],
  });
  // An exact name beats every pattern, including the catch-all above it.
  assert.equal(modelSettings("chatgpt", "", "exact").parameters.max_tokens, 2);
  // A model with no entry of its own falls to the first pattern that matches.
  assert.equal(modelSettings("chatgpt", "", "other").parameters.max_tokens, 1);
  // What was learned against THIS server wins over the file's guess...
  assert.equal(
    modelSettings("chatgpt", "http://proxy/v1", "exact").endpoint,
    "responses"
  );
  // ...and only against that server.
  assert.equal(
    modelSettings("chatgpt", "http://other/v1", "exact").endpoint,
    "chat"
  );
});

test("an entry inherits maxRequests from the default block, and can override it", () => {
  table("chatgpt", {
    default: { model: "m", maxRequests: 25 },
    models: [
      { name: "cheap", endpoint: "chat", parameters: { max_tokens: 1 } },
      {
        name: "dear",
        endpoint: "chat",
        maxRequests: 5,
        parameters: { max_tokens: 1 },
      },
    ],
  });
  assert.equal(modelSettings("chatgpt", "", "cheap").maxRequests, 25);
  assert.equal(modelSettings("chatgpt", "", "dear").maxRequests, 5);
});

test("a malformed entry, or a model nothing matches, is refused by name", () => {
  table("chatgpt", {
    default: { model: "m" },
    models: [{ name: "x", match: "x", parameters: {} }],
  });
  assert.throws(
    () => defaultModel("chatgpt"),
    /models\[0\] must have exactly one of "name" .* or "match"/
  );

  table("chatgpt", {
    default: { model: "m" },
    models: [{ name: "known", parameters: { max_tokens: 1 } }],
  });
  assert.throws(
    () => modelSettings("chatgpt", "", "stranger"),
    /no entry for the model "stranger".*catch-all/s
  );
});

test("a learned shape is written back, and the hand-written file survives it", () => {
  const file = path.join(dir, "chatgpt.yaml");
  const before = fs.readFileSync(file, "utf8");

  const settings = modelSettings("chatgpt", "", "gpt-4.1");
  // What the negotiation would have done: a shape the file does not describe.
  learnModel("chatgpt", "", "gpt-4.1", settings);
  assert.equal(
    fs.readFileSync(file, "utf8"),
    before,
    "an unchanged shape must not write"
  );

  delete settings.parameters.max_tokens;
  settings.parameters.max_completion_tokens = 8192;
  learnModel("chatgpt", "", "gpt-4.1", settings);

  const after = fs.readFileSync(file, "utf8");
  assert.ok(
    after.startsWith("# LLM_API_TYPE=chatgpt"),
    "the comments were lost"
  );
  assert.ok(
    after.includes("# Codex is Responses-only"),
    "the curated table was lost"
  );
  assert.deepEqual(YAML.parse(after).learned, [
    {
      name: "gpt-4.1",
      baseURL: "",
      endpoint: "chat",
      maxRequests: 25,
      parameters: { max_completion_tokens: 8192 },
    },
  ]);

  // A second lesson about the same model replaces the entry rather than piling
  // another one on top of it.
  settings.parameters.max_completion_tokens = 4096;
  learnModel("chatgpt", "", "gpt-4.1", settings);
  const learned = YAML.parse(fs.readFileSync(file, "utf8")).learned;
  assert.equal(learned.length, 1);
  assert.equal(learned[0].parameters.max_completion_tokens, 4096);

  // And the next session reads it back.
  resetLlmSettings(dir);
  assert.deepEqual(modelSettings("chatgpt", "", "gpt-4.1").parameters, {
    max_completion_tokens: 4096,
  });
});
