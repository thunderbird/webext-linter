// The fixed Claude protocol for LLM checks: the forced structured-result tool,
// the call itself, and the defensive coercion of the model's answer. The
// reviewer system intro is fixed per review too, but now lives in the registry
// (prompts.system-intro) and is passed in. The per-review half - the cached
// add-on context and the batched evaluate() transport - lives in
// checks/llm-client.js, which calls callClaude() once per batch of candidates
// when the reviewer supplies an Anthropic API token (the LLM_API_KEY
// environment variable). With no token, ctx.llm is absent and the whole LLM path
// is skipped, so the tool stays deterministic by default.
//
//   - @anthropic-ai/sdk is imported lazily (only when a token is present), so a
//     deterministic-only run never loads it,
//   - the result is forced into a single tool-use shape (this SDK version
//     predates messages.parse), so callers get a typed result, not prose,
//   - RESULT_SCHEMA defines the per-id fail/pass/unsure verdict shape the model
//     must return - the prose explaining those verdicts is the registry's
//     prompts.system-intro prompt (kept in sync there),
//   - ADDON_REVIEW_SCHEMA is the second forced-tool shape: the --full-summary
//     pass returns prose plus a structured list of likely-unused permissions
//     (callClaudeReview), so the tool can raise them as Issues,
//   - the token and add-on contents are never sent anywhere but the API.
//
// Belongs here: the fixed protocols - RESULT_SCHEMA / ADDON_REVIEW_SCHEMA, the
// callClaude / callClaudeReview / listModels calls, the lazy SDK import, and
// coerceResult / coerceReview, none of which change per review.
//
// Does NOT belong here: the per-review add-on context block, the verdict ->
// finding mapping, and the transport client on ctx.llm, which all live in
// src/checks/llm-client.js. The verdict -> outcome and LLM-or-manual decision
// is src/checks/escalation.js. Deciding when LLM checks run, and every
// model-facing prompt (the reviewer intro included), is the registry
// (src/checks/registry.js, assets/registry.yaml). The --claude-* flags and
// list-models command wiring is src/cli.js.

import { DEFAULT_MODEL, MAX_RESPONSE_TOKENS } from "../config.js";

const RESULT_TOOL = "report_verdicts";
const REVIEW_TOOL = "report_addon_review";

// The structured result every LLM check must return (forced via tool_choice).
// The orchestrator gives the model a list of CANDIDATES, each with an id; the
// model returns one verdict per id and nothing else. It has no field in which to
// name a file or subject, so it cannot redirect an outcome to something it was
// not asked about - the identity of every finding/note is owned by the
// orchestrator. The verdict is three-way so an unsure model defers to a human
// instead of silently passing. The optional per-id reason is shown in the
// activity feed only (never the developer-facing text).
const RESULT_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      description: "One entry per candidate id you were given.",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The exact candidate id from the CANDIDATES list.",
          },
          verdict: {
            type: "string",
            enum: ["fail", "pass", "unsure"],
            description:
              "fail = confident the issue this check looks for is present at " +
              "this candidate; pass = confident it is absent; unsure = not " +
              "confident either way (a human reviews). Only use fail/pass when " +
              "genuinely confident.",
          },
          reason: {
            type: "string",
            description: "A short one-line reason for this verdict.",
          },
        },
        required: ["id", "verdict"],
      },
    },
  },
  required: ["verdicts"],
};

// Allowed verdict values the model may return - anything else coerces to the
// safe "unsure". Distinct from DETERMINISTIC_VERDICTS (the feed-note verdicts in
// registry.js): the LLM never returns "skipped".
const LLM_VERDICTS = new Set(["fail", "pass", "unsure"]);

// The --full-summary structured result (forced via tool_choice): the prose
// summary the reviewer reads, plus the subset of declared permissions the model
// judged unused or could not confirm. The tool turns each into an Issue (a
// warning for "unused", a manual-review note for "unsure" - see the
// unused-permission check), with the per-entry reason as the developer-facing
// why. The prose summary still carries the full permission review; this list is
// the machine-readable extract of the unused subset.
const ADDON_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "The prose add-on summary for the reviewer: what the add-on does, " +
        "notable APIs, network/data use, security notes, and the full " +
        "permission review covering every declared permission.",
    },
    unusedPermissions: {
      type: "array",
      description:
        "Every declared permission (or host match pattern) you judged unused " +
        "or could not confirm is used. Omit permissions that are clearly " +
        "justified.",
      items: {
        type: "object",
        properties: {
          permission: {
            type: "string",
            description:
              "The exact declared permission or host match pattern, as written " +
              "in the manifest.",
          },
          status: {
            type: "string",
            enum: ["unused", "unsure"],
            description:
              "unused = confident the add-on does not need it; unsure = cannot " +
              "tell either way (a human then reviews it).",
          },
          reason: {
            type: "string",
            description:
              "One short sentence on why it appears unused, or what you could " +
              "not determine.",
          },
        },
        required: ["permission", "status"],
      },
    },
  },
  required: ["summary", "unusedPermissions"],
};

// Allowed unused-permission statuses - anything else coerces to the safe
// "unsure" (a human reviews rather than the tool raising a warning).
const REVIEW_STATUSES = new Set(["unused", "unsure"]);

/**
 * @typedef {object} LlmVerdict  One verdict, keyed to a candidate id.
 * @property {string} id  The candidate id this verdict is for.
 * @property {"fail"|"pass"|"unsure"} verdict
 * @property {string|null} reason  Short feed-only reason, or null.
 */

/**
 * @typedef {object} LlmResult
 * @property {LlmVerdict[]} verdicts  One entry per candidate id (others dropped).
 */

/**
 * @typedef {object} UnusedPermission  One declared permission the model flagged.
 * @property {string} permission  The exact declared permission / match pattern.
 * @property {"unused"|"unsure"} status  unused = warning, unsure = manual review.
 * @property {string} reason  Short developer-facing why (may be "").
 */

/**
 * @typedef {object} AddonReview  The --full-summary structured result.
 * @property {string} summary  The prose add-on summary (incl. permission review).
 * @property {UnusedPermission[]} unusedPermissions  The flagged subset.
 */

/**
 * @typedef {InstanceType<typeof import("@anthropic-ai/sdk").default>} Anthropic
 */

/**
 * Evaluate one check criterion against Claude and return a structured result.
 * @param {object} params
 * @param {string} params.token  Anthropic API token.
 * @param {string} [params.model]
 * @param {Array<object>|string} params.system  System prompt (text blocks; the
 *   last carries cache_control for the shared add-on context).
 * @param {string} params.criterion  The check's instruction/rubric.
 * @param {number} [params.maxTokens]
 * @param {Anthropic} [params.client]  Injectable client (for tests); built
 *   from the token when omitted, so the production path is unchanged.
 * @returns {Promise<LlmResult>}
 */
export async function callClaude({
  token,
  model = DEFAULT_MODEL,
  system,
  criterion,
  maxTokens = MAX_RESPONSE_TOKENS,
  client,
}) {
  if (!token) {
    throw new Error("callClaude requires an Anthropic API token.");
  }
  if (!client) {
    const Anthropic = await loadSdk();
    client = new Anthropic({ apiKey: token });
  }
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
  const block = (message.content || []).find(
    (b) => b.type === "tool_use" && b.name === RESULT_TOOL
  );
  if (!block) {
    throw new Error("Claude did not return a structured tool_use result.");
  }
  return coerceResult(block.input);
}

/**
 * Free-form text completion (no forced result tool): used for the advisory
 * change summary, which is prose rather than a verdict. Returns the model's
 * joined text blocks, trimmed.
 * @param {object} params
 * @param {string} params.token  Anthropic API token.
 * @param {string} [params.model]
 * @param {Array<object>|string} [params.system]  Optional system prompt.
 * @param {string} params.prompt  The user message (instruction plus material).
 * @param {number} [params.maxTokens]
 * @param {Anthropic} [params.client]  Injectable client (for tests).
 * @returns {Promise<string>}
 */
export async function callClaudeText({
  token,
  model = DEFAULT_MODEL,
  system,
  prompt,
  maxTokens = MAX_RESPONSE_TOKENS,
  client,
}) {
  if (!token) {
    throw new Error("callClaudeText requires an Anthropic API token.");
  }
  if (!client) {
    const Anthropic = await loadSdk();
    client = new Anthropic({ apiKey: token });
  }
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
 * input is { summary, unusedPermissions }. Mirrors callClaude (forced tool,
 * coerced result), but for the add-on summary rather than per-candidate
 * verdicts. The prompt is self-contained (the full add-on sources are in the
 * user message), so there is no shared cached system context.
 * @param {object} params
 * @param {string} params.token  Anthropic API token.
 * @param {string} [params.model]
 * @param {Array<object>|string} [params.system]  Optional system prompt.
 * @param {string} params.prompt  The user message (instruction plus sources).
 * @param {number} [params.maxTokens]
 * @param {Anthropic} [params.client]  Injectable client (for tests).
 * @returns {Promise<AddonReview>}
 */
export async function callClaudeReview({
  token,
  model = DEFAULT_MODEL,
  system,
  prompt,
  maxTokens = MAX_RESPONSE_TOKENS,
  client,
}) {
  if (!token) {
    throw new Error("callClaudeReview requires an Anthropic API token.");
  }
  if (!client) {
    const Anthropic = await loadSdk();
    client = new Anthropic({ apiKey: token });
  }
  const message = await client.messages.create({
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    tools: [
      {
        name: REVIEW_TOOL,
        description:
          "Report the add-on summary and the declared permissions that appear " +
          "unused.",
        input_schema: ADDON_REVIEW_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: REVIEW_TOOL },
    messages: [{ role: "user", content: prompt }],
  });
  const block = (message.content || []).find(
    (b) => b.type === "tool_use" && b.name === REVIEW_TOOL
  );
  if (!block) {
    throw new Error("Claude did not return a structured tool_use result.");
  }
  return coerceReview(block.input);
}

/**
 * List the Anthropic models available to the given token (newest first), so a
 * reviewer can pick one for --llm-model.
 * @param {{token: string}} params
 * @returns {Promise<{id: string, displayName: string, createdAt: string}[]>}
 */
export async function listModels({ token }) {
  if (!token) {
    throw new Error("listModels requires an Anthropic API token.");
  }
  const Anthropic = await loadSdk();
  const client = new Anthropic({ apiKey: token });
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

/**
 * Defensively normalize a tool_use input into a typed LlmResult.
 * @param {unknown} input
 * @returns {LlmResult}
 */
export function coerceResult(input) {
  const obj = input && typeof input === "object" ? input : {};
  const verdicts = (Array.isArray(obj.verdicts) ? obj.verdicts : [])
    .filter((v) => v && typeof v === "object" && typeof v.id === "string")
    .map((v) => ({
      id: v.id,
      verdict: LLM_VERDICTS.has(v.verdict) ? v.verdict : "unsure",
      reason: typeof v.reason === "string" ? v.reason : null,
    }));
  return { verdicts };
}

/**
 * Defensively normalize a report_addon_review tool_use input into an AddonReview:
 * a string summary (else ""), and an unusedPermissions list with each entry's
 * permission kept verbatim, an unknown status coerced to "unsure", and a string
 * reason (else ""). Entries with no permission string are dropped.
 * @param {unknown} input
 * @returns {AddonReview}
 */
export function coerceReview(input) {
  const obj = input && typeof input === "object" ? input : {};
  const summary = typeof obj.summary === "string" ? obj.summary : "";
  const unusedPermissions = (
    Array.isArray(obj.unusedPermissions) ? obj.unusedPermissions : []
  )
    .filter(
      (p) => p && typeof p === "object" && typeof p.permission === "string"
    )
    .filter((p) => p.permission)
    .map((p) => ({
      permission: p.permission,
      status: REVIEW_STATUSES.has(p.status) ? p.status : "unsure",
      reason: typeof p.reason === "string" ? p.reason : "",
    }));
  return { summary, unusedPermissions };
}
