// The LLM client placed on `ctx.llm` when an Anthropic token is set - the
// per-review half of the LLM stack, and pure transport. It builds the
// prompt-cached add-on context shared across the review's calls and exposes
// `evaluate(criterion)`, which returns the structured three-way verdict for one
// case. It does NOT decide outcomes: mapping verdict -> finding / manual review
// is the orchestrator's job (escalation.js). The wire protocol (the forced
// structured output, coercion) is the provider adapters via src/llm/provider.js.
// It never reads the registry yaml - the system intro and each criterion are
// passed in by the caller as strings.
//
// Belongs here: creating the per-review client, building the cached add-on
// metadata block once, forwarding each criterion to the transport via
// evaluate(), the free-form change summary via summarize(), and the structured
// --full-summary add-on review via reviewAddon().
// Does NOT belong here: the wire protocol - the forced structured output and
// coercion - which lives in the provider adapters (src/llm/{anthropic,openai}.js
// + schema.js), selected by src/llm/provider.js. The system intro and criterion
// text - the registry owns those (the caller passes them in). Deciding what a
// verdict means - src/checks/escalation.js. Attaching the client to ctx -
// src/checks/context.js.

import { getProvider, defaultModelFor } from "../llm/provider.js";
import { MAX_FILES_PER_BATCH } from "../config.js";
import { debug } from "../util/log.js";
import { sortKeys } from "../util/json.js";

/** @typedef {import("./registry.js").RunContext} RunContext */
/** @typedef {import("../llm/schema.js").LlmResult} LlmResult */

/**
 * Build the LLM client for a review. The shared system context is built once
 * and reused across `evaluate()` calls, so the large add-on block is a cached
 * prefix billed cheaply after the first call.
 * @param {object} opts
 * @param {RunContext} opts.ctx  The shared check context (add-on metadata).
 * @param {string} opts.token  LLM API token.
 * @param {string} opts.systemIntro  The reviewer role prompt (registry-owned,
 *   resolved by the caller from prompts.system-intro) - the first system block.
 * @param {string} [opts.type]  LLM_API_TYPE (claude | chatgpt); picks the provider.
 * @param {string} [opts.model]
 * @param {string} [opts.url]  Override the LLM API base URL (LLM_API_URL).
 * @param {Function} [opts.callVerdicts]  Injectable verdict transport (tests).
 * @param {Function} [opts.callText]  Injectable free-form transport (tests).
 * @param {Function} [opts.callReview]  Injectable add-on-review transport (tests).
 * @returns {{evaluate: (criterion: string, label?: string) =>
 *   Promise<LlmResult>, summarize: (prompt: string) => Promise<string>,
 *   reviewAddon: (prompt: string) =>
 *     Promise<import("../llm/schema.js").AddonReview>}}
 */
export function createLlmClient({
  ctx,
  token,
  systemIntro,
  type,
  model = defaultModelFor(type),
  url,
  budget,
  callVerdicts,
  callText,
  callReview,
}) {
  if (!systemIntro) {
    throw new Error(
      "createLlmClient: missing systemIntro (prompts.system-intro)"
    );
  }
  const provider = getProvider(type);
  const verdicts = callVerdicts ?? provider.callVerdicts;
  const text = callText ?? provider.callText;
  const review = callReview ?? provider.callReview;
  const system = [
    { type: "text", text: systemIntro },
    {
      type: "text",
      text: buildAddonContext(ctx),
      cache_control: { type: "ephemeral" },
    },
  ];

  // Verbose: show the shared system context once (identical and prompt-cached
  // across this review's calls). Each call then logs its criterion and result.
  debug(`[llm] system context:\n${system.map((b) => b.text).join("\n\n")}`);

  return {
    /**
     * Judge a batch of candidates and return one verdict per id. The orchestrator
     * mints the ids and owns what each means; the model only verdicts them. The
     * candidates are split into batches bounded by distinct corpus file count
     * (MAX_FILES_PER_BATCH), one model call each, over the shared cached system
     * context. Returned ids outside the batch are ignored; any candidate the
     * model omits (or a whole batch that errored) defaults to "unsure", so the
     * caller can route it to manual review. Never throws.
     * @param {object} req
     * @param {string} req.rubric  The check's rubric (registry prompt).
     * @param {Array<{id: string, file?: string, line?: number, note?: string,
     *   corpus?: string[]}>} req.candidates  Each id points at a file:line site;
     *   `corpus` lists the add-on files the model needs for it (default: `file`).
     * @returns {Promise<Map<string, {verdict: "fail"|"pass"|"unsure",
     *   reason: string|null}>>}
     */
    async evaluate({ rubric, candidates }) {
      const out = new Map();
      const list = (candidates ?? []).filter((c) => c && c.id);
      for (const batch of batchByFiles(list)) {
        // Run-wide request cap: once the budget is spent (and not extended) stop
        // calling the model; the fill below defaults the rest to "unsure", so
        // they escalate to manual review like a token-less run.
        if (budget && !(await budget.consume())) {
          break;
        }
        const paths = corpusPaths(batch);
        const criterion = buildCriterion(rubric, batch, paths, ctx);
        debug(`[llm] criterion (${batch.length} candidate(s)):\n${criterion}`);
        let result;
        try {
          result = await verdicts({
            token,
            model,
            baseURL: url,
            system,
            criterion,
          });
        } catch (err) {
          debug(`[llm] batch error: ${err?.message ?? String(err)}`);
          for (const c of batch) {
            out.set(c.id, { verdict: "unsure", reason: null });
          }
          continue;
        }
        const ids = new Set(batch.map((c) => c.id));
        for (const v of result.verdicts) {
          if (ids.has(v.id)) {
            out.set(v.id, { verdict: v.verdict, reason: v.reason });
          }
        }
      }
      for (const c of list) {
        if (!out.has(c.id)) {
          out.set(c.id, { verdict: "unsure", reason: null });
        }
      }
      return out;
    },

    /**
     * Free-form prose completion (no forced verdict tool, no cached add-on
     * context). Used for the advisory change summary - the prompt is
     * self-contained. Throws on a transport/API error.
     * @param {string} prompt
     * @returns {Promise<string>}
     */
    async summarize(prompt) {
      debug(`[llm] summarize prompt:\n${prompt}`);
      const out = await text({ token, model, baseURL: url, prompt });
      debug(`[llm] summary:\n${out}`);
      return out;
    },

    /**
     * Structured --full-summary review (forced report_addon_review tool, no
     * cached add-on context - the prompt is self-contained). Returns the prose
     * summary plus the permissions the model judged unused. Throws on a
     * transport/API error (the caller treats that as no summary).
     * @param {string} prompt
     * @returns {Promise<import("../llm/schema.js").AddonReview>}
     */
    async reviewAddon(prompt) {
      debug(`[llm] reviewAddon prompt:\n${prompt}`);
      const result = await review({ token, model, baseURL: url, prompt });
      debug(`[llm] reviewAddon result:\n${JSON.stringify(result, null, 2)}`);
      return result;
    },
  };
}

/**
 * The add-on files one candidate needs the model to read: its explicit `corpus`
 * if given, else just its own `file`. Deduped.
 * @param {{file?: string, corpus?: string[]}} c
 * @returns {string[]}
 */
function candidateCorpus(c) {
  const paths = c.corpus?.length ? c.corpus : c.file ? [c.file] : [];
  return [...new Set(paths)];
}

/**
 * The union of corpus paths across a batch, in first-seen order.
 * @param {Array<{file?: string, corpus?: string[]}>} batch
 * @returns {string[]}
 */
function corpusPaths(batch) {
  const seen = new Set();
  const out = [];
  for (const c of batch) {
    for (const p of candidateCorpus(c)) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  return out;
}

/**
 * Greedily split candidates so each batch's distinct corpus files stay within
 * MAX_FILES_PER_BATCH. A single candidate whose own corpus exceeds the cap gets
 * its own batch (it cannot be split further).
 * @param {Array<{file?: string, corpus?: string[]}>} candidates
 * @returns {Array<object[]>}
 */
function batchByFiles(candidates) {
  const batches = [];
  let cur = [];
  let curFiles = new Set();
  for (const c of candidates) {
    const need = candidateCorpus(c);
    const union = new Set([...curFiles, ...need]);
    if (cur.length && union.size > MAX_FILES_PER_BATCH) {
      batches.push(cur);
      cur = [];
      curFiles = new Set();
    }
    cur.push(c);
    for (const p of need) {
      curFiles.add(p);
    }
  }
  if (cur.length) {
    batches.push(cur);
  }
  return batches;
}

/**
 * Assemble one batch's user message: the rubric, the CANDIDATES list (id ->
 * file:line plus an optional note), and a FILES section with the batch's corpus
 * bodies. File contents come from the add-on, not the model.
 * @param {string} rubric
 * @param {Array<{id: string, file?: string, line?: number, note?: string}>} batch
 * @param {string[]} paths  The batch's deduped corpus paths.
 * @param {RunContext} ctx
 * @returns {string}
 */
function buildCriterion(rubric, batch, paths, ctx) {
  const lines = [rubric ?? "", "", "CANDIDATES:"];
  for (const c of batch) {
    const loc = c.line != null ? `:${c.line}` : "";
    const note = c.note ? ` (${c.note})` : "";
    lines.push(`${c.id}: ${c.file ?? "(add-on)"}${loc}${note}`);
  }
  lines.push("", "FILES:");
  for (const p of paths) {
    const body = ctx.addon?.files?.get(p)?.toString("utf8") ?? "";
    lines.push(`--- ${p} ---`, body);
  }
  return lines.join("\n");
}

/**
 * Build the compact, deterministic add-on context shared by every LLM check.
 * Identical bytes across checks so the cached prefix is reused. Metadata only -
 * no file bodies.
 * @param {RunContext} ctx
 * @returns {string}
 */
function buildAddonContext(ctx) {
  const { addon } = ctx;
  const manifest = addon.manifest
    ? JSON.stringify(sortKeys(addon.manifest), null, 2)
    : "(no valid manifest.json)";
  const paths = [...addon.files.keys()].sort();
  const fileList =
    paths
      .map((p) => `  ${p} (${addon.files.get(p).length} bytes)`)
      .join("\n") || "  (none)";
  const localeDirs = [
    ...new Set(
      paths
        .filter((p) => p.startsWith("_locales/"))
        .map((p) => p.split("/")[1])
        .filter(Boolean)
    ),
  ];
  const war = addon.manifest?.web_accessible_resources;

  return [
    "ADD-ON UNDER REVIEW",
    "",
    "manifest.json:",
    manifest,
    "",
    `default_locale: ${addon.manifest?.default_locale ?? "(none)"}`,
    `_locales directories: ${localeDirs.length ? localeDirs.join(", ") : "(none)"}`,
    `web_accessible_resources: ${war ? JSON.stringify(war) : "(none)"}`,
    "",
    "Files:",
    fileList,
  ].join("\n");
}
