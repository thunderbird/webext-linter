// Selects the LLM provider adapter by LLM_API_TYPE. Both adapters expose the same
// four operations (callVerdicts / callText / callReview / listModels), so the rest
// of the tool is provider-agnostic - it asks getProvider(type) for the functions
// and never imports an adapter directly.
//
// Belongs here: the type -> adapter map, the per-type default model, and the
// type-name list/validation. Does NOT belong here: the request shapes (-> the
// adapters), the schemas (-> schema.js), or reading the env var (-> src/cli.js).

import { DEFAULT_MODEL, DEFAULT_MODEL_OPENAI } from "../config.js";
import * as anthropic from "./anthropic.js";
import * as openai from "./openai.js";

const PROVIDERS = {
  claude: { adapter: anthropic, defaultModel: DEFAULT_MODEL },
  chatgpt: { adapter: openai, defaultModel: DEFAULT_MODEL_OPENAI },
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
