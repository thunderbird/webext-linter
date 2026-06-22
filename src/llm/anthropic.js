// The Anthropic (Claude) provider adapter: the forced structured-result tool and
// the calls, over @anthropic-ai/sdk. Structured output is forced via tool_choice
// (this SDK version predates messages.parse), then run through the shared
// coercers in schema.js, so callers get a typed result regardless of provider.
//
//   - @anthropic-ai/sdk is imported lazily (only when a token is present), so a
//     deterministic-only run never loads it,
//   - the token and add-on contents are never sent anywhere but the API.
//
// Belongs here: the Anthropic request/response shape (callVerdicts / callText /
// callReview / listModels) and the lazy SDK import. Does NOT belong here: the
// schemas + coercion (-> schema.js), the per-review add-on context and transport
// (-> src/checks/llm-client.js), the provider selection (-> src/llm/provider.js)
// itself, or any model-facing prompt (-> the registry).

import { MAX_RESPONSE_TOKENS } from "../config.js";
import {
  RESULT_TOOL,
  REVIEW_TOOL,
  RESULT_SCHEMA,
  ADDON_REVIEW_SCHEMA,
  coerceResult,
  coerceReview,
} from "./schema.js";

/**
 * @typedef {InstanceType<typeof import("@anthropic-ai/sdk").default>} Anthropic
 */

/**
 * Build an Anthropic client from a token (+ optional baseURL), unless an
 * injectable one is supplied (tests pass a fake).
 * @param {string} token @param {string} [baseURL] @param {Anthropic} [client]
 * @returns {Promise<Anthropic>}
 */
async function clientFor(token, baseURL, client) {
  if (client) {
    return client;
  }
  if (!token) {
    throw new Error("the LLM call requires an API token.");
  }
  const Anthropic = await loadSdk();
  return new Anthropic({ apiKey: token, ...(baseURL ? { baseURL } : {}) });
}

/**
 * Evaluate one check criterion and return a structured verdict result.
 * @param {object} params
 * @param {string} params.token @param {string} [params.model]
 * @param {string} [params.baseURL]
 * @param {Array<object>|string} params.system  System prompt (text blocks; the
 *   last carries cache_control for the shared add-on context).
 * @param {string} params.criterion  The check's instruction/rubric.
 * @param {number} [params.maxTokens] @param {Anthropic} [params.client]
 * @returns {Promise<import("./schema.js").LlmResult>}
 */
export async function callVerdicts({
  token,
  model,
  baseURL,
  system,
  criterion,
  maxTokens = MAX_RESPONSE_TOKENS,
  client,
}) {
  client = await clientFor(token, baseURL, client);
  const message = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    tools: [
      {
        name: RESULT_TOOL,
        description: "Report the result of the review check.",
        input_schema: RESULT_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: RESULT_TOOL },
    messages: [{ role: "user", content: criterion }],
  });
  return coerceResult(toolInput(message, RESULT_TOOL));
}

/**
 * Free-form text completion (no forced tool): used for the advisory change
 * summary. Returns the model's joined text blocks, trimmed.
 * @param {object} params
 * @param {string} params.token @param {string} [params.model]
 * @param {string} [params.baseURL] @param {Array<object>|string} [params.system]
 * @param {string} params.prompt @param {number} [params.maxTokens]
 * @param {Anthropic} [params.client]
 * @returns {Promise<string>}
 */
export async function callText({
  token,
  model,
  baseURL,
  system,
  prompt,
  maxTokens = MAX_RESPONSE_TOKENS,
  client,
}) {
  client = await clientFor(token, baseURL, client);
  const message = await client.messages.create({
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: [{ role: "user", content: prompt }],
  });
  return (message.content || [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * The structured --full-summary review: a forced report_addon_review tool whose
 * input is { summary, recheck }.
 * @param {object} params
 * @param {string} params.token @param {string} [params.model]
 * @param {string} [params.baseURL] @param {Array<object>|string} [params.system]
 * @param {string} params.prompt @param {number} [params.maxTokens]
 * @param {Anthropic} [params.client]
 * @returns {Promise<import("./schema.js").AddonReview>}
 */
export async function callReview({
  token,
  model,
  baseURL,
  system,
  prompt,
  maxTokens = MAX_RESPONSE_TOKENS,
  client,
}) {
  client = await clientFor(token, baseURL, client);
  const message = await client.messages.create({
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    tools: [
      {
        name: REVIEW_TOOL,
        description:
          "Report the add-on summary and your verdict on each item listed in a " +
          "recheck section.",
        input_schema: ADDON_REVIEW_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: REVIEW_TOOL },
    messages: [{ role: "user", content: prompt }],
  });
  return coerceReview(toolInput(message, REVIEW_TOOL));
}

/**
 * @typedef {object} ContentBlock  One block in a Claude message's content.
 * @property {string} type  Block type, e.g. "text" or "tool_use".
 * @property {string} [name]  The tool name (tool_use blocks).
 * @property {*} [input]  The tool's input arguments (tool_use blocks).
 */
/**
 * @typedef {object} ClaudeMessage  A Claude messages.create response.
 * @property {ContentBlock[]} content  The response content blocks.
 */
/**
 * @typedef {object} ToolInput  The raw arguments of a forced tool_use block (a
 *   RESULT_SCHEMA or ADDON_REVIEW_SCHEMA shape, validated by the coercers).
 */
/**
 * The input of the forced tool_use block, or throw if the model returned none.
 * @param {ClaudeMessage} message @param {string} toolName
 * @returns {ToolInput}
 */
function toolInput(message, toolName) {
  const block = (message.content || []).find(
    (b) => b.type === "tool_use" && b.name === toolName
  );
  if (!block) {
    throw new Error("the model did not return a structured tool_use result.");
  }
  return block.input;
}

/**
 * List the Anthropic models available to the given token (newest first).
 * @param {{token: string, baseURL?: string}} params
 * @returns {Promise<{id: string, displayName: string, createdAt: string}[]>}
 */
export async function listModels({ token, baseURL }) {
  const client = await clientFor(token, baseURL);
  const models = [];
  for await (const m of client.models.list()) {
    models.push({
      id: m.id,
      displayName: m.display_name ?? "",
      createdAt: m.created_at ?? "",
    });
  }
  return models;
}

/**
 * Lazy-import the Anthropic SDK (a regular dependency), throwing an actionable
 * error if it fails to load (e.g. a broken install).
 * @returns {Promise<typeof import("@anthropic-ai/sdk").default>} SDK class.
 */
async function loadSdk() {
  try {
    const mod = await import("@anthropic-ai/sdk");
    return mod.default || mod.Anthropic || mod;
  } catch (err) {
    throw new Error(
      `@anthropic-ai/sdk failed to load (try reinstalling with "npm install"): ${err.message}`
    );
  }
}
