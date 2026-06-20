// Selects the LLM provider adapter by LLM_API_TYPE. Both adapters expose the same
// four operations (callVerdicts / callText / callReview / listModels), so the rest
// of the tool is provider-agnostic - it asks getProvider(type) for the functions
// and never imports an adapter directly. ollama reuses the OpenAI adapter (its
// endpoint is OpenAI-compatible), with a local default base URL and no API key.
//
// Belongs here: the type -> adapter map, every per-provider requirement (default
// model, default base URL, whether a key is required, whether the model can be
// verified up front), and the config/availability validators the CLI + pipeline
// call. Does NOT belong here: the request shapes (-> the adapters), the schemas
// (-> schema.js), or reading the env vars (-> src/cli.js).

import {
  DEFAULT_MODEL_CLAUDE,
  DEFAULT_MODEL_OPENAI,
  DEFAULT_MODEL_OLLAMA,
} from "../config.js";
import * as anthropic from "./anthropic.js";
import * as openai from "./openai.js";

const PROVIDERS = {
  claude: {
    adapter: anthropic,
    defaultModel: DEFAULT_MODEL_CLAUDE,
    requiresKey: true,
  },
  chatgpt: {
    adapter: openai,
    defaultModel: DEFAULT_MODEL_OPENAI,
    requiresKey: true,
  },
  // Local, OpenAI-compatible. No key; a local default endpoint; the chosen model
  // must be pulled, which checkModelAvailable verifies up front.
  ollama: {
    adapter: openai,
    defaultModel: DEFAULT_MODEL_OLLAMA,
    requiresKey: false,
    baseUrl: "http://localhost:11434/v1",
    checkModel: true,
  },
};

/** The supported LLM_API_TYPE values. */
export const LLM_TYPES = Object.keys(PROVIDERS);

/** The default LLM_API_TYPE when the env var is unset. */
export const DEFAULT_LLM_TYPE = "claude";

/**
 * Whether `type` is a supported LLM_API_TYPE.
 * @param {string} type @returns {boolean}
 */
export function isLlmType(type) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, type);
}

/**
 * The provider adapter (callVerdicts / callText / callReview / listModels) for an
 * LLM_API_TYPE. Defaults to claude; throws on an unknown type.
 * @param {string} [type]
 * @returns {{callVerdicts: Function, callText: Function, callReview: Function,
 *   listModels: Function}}
 */
export function getProvider(type = DEFAULT_LLM_TYPE) {
  const entry = PROVIDERS[type];
  if (!entry) {
    throw new Error(
      `unknown LLM_API_TYPE "${type}" (expected one of: ${LLM_TYPES.join(", ")})`
    );
  }
  return entry.adapter;
}

/**
 * The default model for an LLM_API_TYPE (used when LLM_API_MODEL is not set).
 * @param {string} [type]
 * @returns {string}
 */
export function defaultModelFor(type = DEFAULT_LLM_TYPE) {
  return (PROVIDERS[type] ?? PROVIDERS[DEFAULT_LLM_TYPE]).defaultModel;
}

/**
 * The default API base URL for an LLM_API_TYPE (used when LLM_API_URL is unset),
 * or undefined when the provider has none (the SDK's own default applies).
 * @param {string} [type]
 * @returns {string|undefined}
 */
export function defaultBaseUrlFor(type) {
  return PROVIDERS[type]?.baseUrl;
}

/**
 * Validate the (instant) LLM config for a type: an unknown type, or a provider
 * that requires an API key but has none. Returns an actionable error string, or
 * null when usable. Each provider owns its own key requirement, so callers never
 * branch by type.
 * @param {string} type @param {{apiKey?: string}} cfg
 * @returns {?string}
 */
export function validateLlmConfig(type, { apiKey } = {}) {
  if (!isLlmType(type)) {
    return (
      `Unknown LLM_API_TYPE "${type}" ` +
      `(expected one of: ${LLM_TYPES.join(", ")}).`
    );
  }
  if (PROVIDERS[type].requiresKey && !apiKey) {
    return "Enabling the LLM checks needs an API token (set LLM_API_KEY in the environment).";
  }
  return null;
}

/**
 * Confirm the chosen model is actually available, for providers that can be
 * checked cheaply up front (Ollama - a local list call). A no-op (null) for the
 * cloud providers, which validate the model at call time. Returns an actionable
 * error string, or null. `listModels` is injectable for tests.
 * @param {string} type
 * @param {{model: string, token?: string, baseURL?: string, listModels?: Function}} opts
 * @returns {Promise<?string>}
 */
export async function checkModelAvailable(
  type,
  { model, token, baseURL, listModels } = {}
) {
  const entry = PROVIDERS[type];
  if (!entry?.checkModel) {
    return null;
  }
  const list = listModels ?? entry.adapter.listModels;
  let models;
  try {
    models = await list({ token, baseURL });
  } catch (err) {
    return (
      `Could not reach the ${type} server at ${baseURL ?? "its default URL"} ` +
      `(${err.message}). Is it running?`
    );
  }
  const names = (models ?? []).map((m) => m.id);
  // Ollama lists a tagged id ("llama3.1:latest"); a bare "llama3.1" means ":latest".
  const ok = names.some(
    (n) => n === model || n.split(":")[0] === model.split(":")[0]
  );
  if (!ok) {
    return (
      `Model "${model}" is not available in your ${type} instance. ` +
      `Pull it (e.g. \`ollama pull ${model}\`) or set LLM_API_MODEL to a pulled ` +
      `model. Available: ${names.join(", ") || "(none)"}.`
    );
  }
  return null;
}
