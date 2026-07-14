// Tests for the model table (assets/llm/<type>.yaml + src/llm/settings.js): that the
// shipped tables parse and name the defaults the tool promises, that a model id
// resolves the way they promise (an exact name, else a pattern in file order), that a
// malformed table is refused when it is read rather than at request time, and that a
// negotiated shape (src/llm/negotiated.js) is laid over the table as a delta - so an
// edit to the table still reaches a model something was once learned about.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";

import {
  defaultModel,
  modelSettings,
  shippedSettings,
  resetLlmSettings,
} from "../../src/llm/settings.js";
import { learn, resetNegotiated } from "../../src/llm/negotiated.js";
import { LLM_TYPES } from "../../src/llm/provider.js";
import { isolateLlmCache, LLM_ASSETS } from "./llm-table.js";

beforeEach(() => {
  isolateLlmCache();
});

/** Write a table of our own, to state a resolution rule outright. */
function table(type, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webext-linter-table-"));
  fs.writeFileSync(path.join(dir, `${type}.yaml`), YAML.stringify(content));
  resetLlmSettings(dir);
}

test("every LLM_API_TYPE has a shipped table, and it names a default model", () => {
  for (const type of LLM_TYPES) {
    assert.ok(
      fs.existsSync(path.join(LLM_ASSETS, `${type}.yaml`)),
      `assets/llm/${type}.yaml is missing`
    );
    assert.ok(defaultModel(type), `${type} names no default model`);
  }
  // An LLM_API_TYPE with no table is a hard error, not a silent fall back to some
  // other provider's models: provider.js validates the name before anything asks.
  assert.throws(() => defaultModel("bogus"), /no model table/);
});

test("each table names its provider's default model, budget and token cap", () => {
  assert.equal(defaultModel("claude"), "claude-sonnet-4-6");
  assert.equal(defaultModel("chatgpt"), "gpt-4.1");
  assert.equal(defaultModel("ollama"), "llama3.1");
  for (const type of LLM_TYPES) {
    const settings = modelSettings(type, "", defaultModel(type));
    assert.equal(settings.maxRequests, 25);
    assert.equal(settings.parameters.max_tokens, 8192);
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
      fs.readFileSync(path.join(LLM_ASSETS, `${type}.yaml`), "utf8")
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

test("an exact name wins over a pattern, and the catch-all is the last resort", () => {
  table("chatgpt", {
    default: { model: "m", maxRequests: 25 },
    models: [
      { match: ".*", endpoint: "chat", parameters: { max_tokens: 1 } },
      { name: "exact", endpoint: "chat", parameters: { max_tokens: 2 } },
      { match: "^ex", endpoint: "chat", parameters: { max_tokens: 3 } },
    ],
  });
  // An exact name beats every pattern, including the catch-all above it.
  assert.equal(modelSettings("chatgpt", "", "exact").parameters.max_tokens, 2);
  // A model with no entry of its own falls to the first pattern that matches.
  assert.equal(modelSettings("chatgpt", "", "other").parameters.max_tokens, 1);
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

test("a malformed table, or a model nothing matches, is refused by name", () => {
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
    models: [{ match: "([", parameters: {} }],
  });
  assert.throws(() => defaultModel("chatgpt"), /invalid "match" regex/);

  table("chatgpt", {
    default: { model: "m" },
    models: [{ name: "known", parameters: { max_tokens: 1 } }],
  });
  assert.throws(
    () => modelSettings("chatgpt", "", "stranger"),
    /no entry for the model "stranger".*catch-all/s
  );
});

test("a negotiated shape is laid over the table, and the table still wins on the rest", () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "webext-linter-neg-"));
  resetNegotiated(cache);
  learn("chatgpt", "", "gpt-4.1", {
    endpoint: "responses",
    rename: { from: "max_tokens", to: "max_output_tokens" },
  });
  resetLlmSettings();

  const settings = modelSettings("chatgpt", "", "gpt-4.1");
  // What was learned: the endpoint, and the parameter's name.
  assert.equal(settings.endpoint, "responses");
  assert.deepEqual(settings.parameters, {
    // The VALUE is the table's, not a value frozen at the moment of the repair -
    // so raising the cap in assets/llm reaches a model whose parameter name was
    // once negotiated.
    max_output_tokens: shippedSettings("chatgpt", "gpt-4.1").parameters
      .max_tokens,
  });
  // And so is everything the negotiation never learned.
  assert.equal(
    settings.maxRequests,
    shippedSettings("chatgpt", "gpt-4.1").maxRequests
  );
  // Another server's request for the same model is untouched by it.
  assert.equal(
    modelSettings("chatgpt", "https://proxy/v1", "gpt-4.1").endpoint,
    "chat"
  );
});

test("a rename whose source the table no longer has is simply not applied", () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "webext-linter-neg-"));
  resetNegotiated(cache);
  // Learned when the entry still said max_tokens; the table has since been edited.
  learn("chatgpt", "", "gpt-5.1", {
    rename: { from: "max_tokens", to: "max_output_tokens" },
  });
  resetLlmSettings();
  // gpt-5.1's shipped entry carries max_completion_tokens, which the stale rename
  // does not name - so the request goes out as the table says and, if the server
  // still disagrees, it is negotiated again.
  assert.deepEqual(
    modelSettings("chatgpt", "", "gpt-5.1").parameters,
    shippedSettings("chatgpt", "gpt-5.1").parameters
  );
});
