// The provider-agnostic LLM contract: the two forced structured-output schemas
// (RESULT_SCHEMA / ADDON_REVIEW_SCHEMA) and the defensive coercion of the
// model's answer into typed results. Both providers (anthropic.js, openai.js)
// drive the model to return JSON matching these schemas - Anthropic via a forced
// tool_use, OpenAI via a forced function call - and run the raw JSON through the
// same coercers, so the rest of the tool sees one shape regardless of provider.
//
// Belongs here: the schemas, the tool/function names, the allowed enum sets, the
// coercers, and the result typedefs. Does NOT belong here: the HTTP calls (->
// anthropic.js / openai.js), the per-review add-on context and transport (->
// src/checks/llm-client.js), or any prose prompt (-> the registry).

export const RESULT_TOOL = "report_verdicts";
export const REVIEW_TOOL = "report_addon_review";

// The structured result every LLM check must return. The orchestrator gives the
// model a list of CANDIDATES, each with an id. The model returns one verdict per
// id and nothing else. It has no field in which to name a file or subject, so it
// cannot redirect an outcome to something it was not asked about - the identity
// of every finding/note is owned by the orchestrator. The verdict is three-way
// so an unsure model defers to a human instead of silently passing. The optional
// per-id reason is shown in the activity feed only (never the developer-facing
// text).
export const RESULT_SCHEMA = {
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
export const LLM_VERDICTS = new Set(["fail", "pass", "unsure"]);

// The --full-summary structured result: the prose summary the reviewer reads,
// plus the subset of declared permissions the model judged unused or could not
// confirm. The tool turns each into an Issue (a warning for "unused", a
// manual-review note for "unsure" - see the unused-permission check), with the
// per-entry reason as the developer-facing why.
export const ADDON_REVIEW_SCHEMA = {
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
              "unused = confident the current code does not need it (ignore " +
              "future/planned use); unsure = cannot tell whether the current " +
              "code uses it (a human then reviews it).",
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
export const REVIEW_STATUSES = new Set(["unused", "unsure"]);

/**
 * @typedef {object} LlmVerdict  One verdict, keyed to a candidate id.
 * @property {string} id  The candidate id this verdict is for.
 * @property {"fail"|"pass"|"unsure"} verdict
 * @property {string|null} reason  Short feed-only reason, or null.
 */

/**
 * @typedef {object} LlmResult
 * @property {LlmVerdict[]} verdicts  One entry per candidate id (others
 *   dropped).
 */

/**
 * @typedef {object} UnusedPermission  One declared permission the model flagged.
 * @property {string} permission  The exact declared permission / match pattern.
 * @property {"unused"|"unsure"} status  unused = warning, unsure = manual
 *   review.
 * @property {string} reason  Short developer-facing why (may be "").
 */

/**
 * @typedef {object} AddonReview  The --full-summary structured result.
 * @property {string} summary  The prose add-on summary (incl. permission
 *   review).
 * @property {UnusedPermission[]} unusedPermissions  The flagged subset.
 */

/**
 * Defensively normalize a structured verdict result into a typed LlmResult.
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
 * Defensively normalize a structured add-on-review result into an AddonReview: a
 * string summary (else ""), and an unusedPermissions list with each entry's
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
