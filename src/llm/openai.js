// The OpenAI (ChatGPT) provider adapter: the same four operations as anthropic.js
// (callVerdicts / callText / callReview / listModels), over the openai SDK.
// Structured output is forced via function-calling (a forced tool_choice on a
// function whose `parameters` is the shared JSON schema), then run through the
// same coercers in schema.js, so callers get an identical typed result.
//
//   - the openai SDK is imported lazily (only when a token is present),
//   - the Anthropic-style `system` text-block array is flattened to one string
//     (OpenAI takes a single system message; prompt caching is automatic there),
//   - the token and add-on contents are never sent anywhere but the API.
//
// Belongs here: the OpenAI request/response shape and the lazy SDK import. Does
// NOT belong here: the schemas + coercion (-> schema.js), the provider selection
// (-> src/llm/provider.js), or any model-facing prompt (-> the registry).

import { DEFAULT_MODEL_OPENAI, MAX_RESPONSE_TOKENS } from "../config.js";
import {
  RESULT_TOOL,
  REVIEW_TOOL,
  RESULT_SCHEMA,
  ADDON_REVIEW_SCHEMA,
  coerceResult,
  coerceReview,
} from "./schema.js";

/** @typedef {InstanceType<typeof import("openai").default>} OpenAI */

// The openai SDK constructor requires a non-empty apiKey string. A keyless local
// server (Ollama, reached via baseURL) has no key, so fall back to this harmless
// placeholder - the server ignores it. Cloud callers always pass a real token
// (the pre-flight requires it), so this only ever applies to the keyless path.
const KEYLESS_PLACEHOLDER = "ollama";

/**
 * Build an OpenAI client from a token (+ optional baseURL), unless an injectable
 * one is supplied (tests pass a fake). A missing token uses the keyless
 * placeholder rather than failing, so an OpenAI-compatible local server works.
 * @param {string} [token] @param {string} [baseURL] @param {OpenAI} [client]
 * @returns {Promise<OpenAI>}
 */
async function clientFor(token, baseURL, client) {
  if (client) {
    return client;
  }
  const OpenAI = await loadSdk();
  return new OpenAI({
    apiKey: token || KEYLESS_PLACEHOLDER,
    ...(baseURL ? { baseURL } : {}),
  });
}

/**
 * The Anthropic-style system (an array of {type,text} blocks, or a string) as a
 * single OpenAI system-message string.
 * @param {Array<object>|string|undefined} system
 * @returns {string}
 */
function flattenSystem(system) {
  if (Array.isArray(system)) {
    return system
      .map((b) => (b && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n\n");
  }
  return typeof system === "string" ? system : "";
}

/**
 * @param {string} sys @param {string} user
 * @returns {Array<{role: string, content: string}>}
 */
function messagesFor(sys, user) {
  return [
    ...(sys ? [{ role: "system", content: sys }] : []),
    { role: "user", content: user },
  ];
}

/**
 * A forced function-call tool from a name + JSON schema.
 * @param {string} name @param {string} description @param {object} schema
 */
function functionTool(name, description, schema) {
  return {
    tools: [
      { type: "function", function: { name, description, parameters: schema } },
    ],
    tool_choice: { type: "function", function: { name } },
  };
}

/**
 * The arguments object of the model's forced function call, or throw if absent.
 * @param {object} res @returns {object}
 */
function callArgs(res) {
  const call = res?.choices?.[0]?.message?.tool_calls?.[0];
  if (!call?.function?.arguments) {
    throw new Error("the model did not return a structured function call.");
  }
  return JSON.parse(call.function.arguments);
}

/** @see import("./anthropic.js").callVerdicts */
export async function callVerdicts({
  token,
  model = DEFAULT_MODEL_OPENAI,
  baseURL,
  system,
  criterion,
  maxTokens = MAX_RESPONSE_TOKENS,
  client,
}) {
  client = await clientFor(token, baseURL, client);
  const res = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: messagesFor(flattenSystem(system), criterion),
    ...functionTool(
      RESULT_TOOL,
      "Report the result of the review check.",
      RESULT_SCHEMA
    ),
  });
  return coerceResult(callArgs(res));
}

/** @see import("./anthropic.js").callText */
export async function callText({
  token,
  model = DEFAULT_MODEL_OPENAI,
  baseURL,
  system,
  prompt,
  maxTokens = MAX_RESPONSE_TOKENS,
  client,
}) {
  client = await clientFor(token, baseURL, client);
  const res = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: messagesFor(flattenSystem(system), prompt),
  });
  return (res?.choices?.[0]?.message?.content ?? "").trim();
}

/** @see import("./anthropic.js").callReview */
export async function callReview({
  token,
  model = DEFAULT_MODEL_OPENAI,
  baseURL,
  system,
  prompt,
  maxTokens = MAX_RESPONSE_TOKENS,
  client,
}) {
  client = await clientFor(token, baseURL, client);
  const res = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: messagesFor(flattenSystem(system), prompt),
    ...functionTool(
      REVIEW_TOOL,
      "Report the add-on summary and the declared permissions that appear unused.",
      ADDON_REVIEW_SCHEMA
    ),
  });
  return coerceReview(callArgs(res));
}

/**
 * List the OpenAI models available to the given token.
 * @param {{token: string, baseURL?: string}} params
 * @returns {Promise<{id: string, displayName: string, createdAt: string}[]>}
 */
export async function listModels({ token, baseURL }) {
  const client = await clientFor(token, baseURL);
  const models = [];
  for await (const m of client.models.list()) {
    models.push({
      id: m.id,
      displayName: "",
      createdAt: m.created != null ? String(m.created) : "",
    });
  }
  return models;
}

/**
 * Lazy-import the openai SDK, throwing an actionable error if it fails to load.
 * @returns {Promise<typeof import("openai").default>} SDK class.
 */
async function loadSdk() {
  try {
    const mod = await import("openai");
    return mod.default || mod.OpenAI || mod;
  } catch (err) {
    throw new Error(
      `openai failed to load (try reinstalling with "npm install"): ${err.message}`
    );
  }
}
