// Builds the RunContext every check runs against. The checks layer owns its own
// context: collecting the add-on's JS sources, extracting API usage, loading
// the --diff-to baseline, and attaching the LLM client when a token is set. The
// pipeline (cli.js) resolves the schema and hands everything in.
//
// Belongs here: the one-time assembly of the shared per-review ctx -
// orchestrating addon/sources.js, parse/api-usage.js, addon/load.js, and
// llm-client.js into the RunContext shape that registry.js documents.
//
// Does NOT belong here: any individual review logic - that lives in a rule
// under src/checks/rules/*. The RunContext type and runChecks live in
// src/checks/registry.js. The verdict-to-outcome decision is escalation.js, the
// LLM transport is src/checks/llm-client.js, and shared analysis helpers belong
// in src/checks/lib/*.

import { loadAddon } from "../addon/load.js";
import { collectJsSources } from "../addon/sources.js";
import { parseJs } from "../parse/ast.js";
import { parseApiUsage } from "../parse/api-usage.js";
import { createLlmClient } from "./llm-client.js";
import { llmEnabled } from "./lib/util.js";

/** @typedef {import("./registry.js").RunContext} RunContext */

/**
 * Assemble the shared RunContext for one review.
 * @param {object} params
 * @param {import("../addon/load.js").Addon} params.addon
 * @param {import("../schema/index.js").SchemaIndex} params.schema
 * @param {{llmEnabled?: boolean, llmApiKey?: string, llmApiUrl?: string,
 *   llmApiType?: string, allowExperiments?: boolean, scanMinified?: boolean,
 *   libraryHashes?: Map<string, {name: string, version: string}>}}
 *   params.options
 * @param {string} [params.diffTo]  Path of the previously published version,
 *   loaded as the diff baseline for the diff checks (run only with --diff-to).
 * @param {string} [params.llmModel]  Model override for the LLM client.
 * @param {string} [params.systemIntro]  The registry-owned reviewer system
 *   prompt (prompts.system-intro), passed to the LLM client when a token is set.
 * @param {boolean} [params.invalidExperiment]  The add-on is an Experiment and
 *   --allow-experiments is off: short-circuit to the reject check with no LLM,
 *   so the client is never attached even when a token is set.
 * @param {import("../llm/budget.js").LlmBudget} [params.budget]  Run-wide model
 *   request cap, shared with the rest of the run (see runPipeline).
 * @returns {RunContext}
 */
export function buildRunContext({
  addon,
  schema,
  options,
  diffTo,
  llmModel,
  systemIntro,
  invalidExperiment,
  budget,
}) {
  // Parse each source ONCE and hang the result on the source. Every read-only
  // analysis consumer (api-usage here, plus the sync-xhr / debugger-statement /
  // async-onmessage checks and the remote-js / unsafe-html scanners) reuses
  // src.parsed instead of re-parsing the same code.
  //
  // Memory: parse and extract api-usage, then RETAIN the AST only for files a
  // source scanner will actually read. A non-authored file (vendored / library /
  // minified / obfuscated - the multi-MB bundles among them) is skipped by every
  // content scanner via nonAuthoredJs, and keeping all those ASTs at once is what
  // exhausts the heap on a bundle-heavy add-on. Dropping src.parsed to null only
  // frees memory: a consumer that does reach such a file re-parses on demand
  // (src.parsed ?? parseJs), one file at a time, so findings are unchanged.
  // (api-usage still runs on every file via the live parse above, and
  // unparsable-file reads ctx.apiUsages, not src.parsed.) The skip set is the one
  // classifyBundled already computed (addon.bundled, set before review); absent it
  // - e.g. a direct buildRunContext with no pre-step - every AST is retained.
  // A rejected Experiment runs only the reject check (no AST consumer) and skips
  // the classifyBundled pre-step, so there is no skip set and nothing reads an
  // AST: retain none of them (the parse only feeds api-usage above).
  const nonAuthored = addon.bundled?.nonAuthored;
  const jsSources = collectJsSources(addon);
  const apiUsages = jsSources.map((src) => {
    const parsed = parseJs(src.code);
    const usage = {
      file: src.file,
      inline: src.inline,
      ...parseApiUsage(src.code, src.lineOffset, parsed),
    };
    src.parsed =
      invalidExperiment || nonAuthored?.has(src.file) ? null : parsed;
    return usage;
  });

  /** @type {RunContext} */
  const ctx = {
    addon,
    schema,
    jsSources,
    apiUsages,
    options,
    previous: diffTo ? loadAddon(diffTo) : null,
    invalidExperiment,
  };

  // When an Anthropic token is set, attach the LLM client so the llm-checks
  // rule modules can evaluate their criterion. Without it ctx.llm is absent and
  // those modules escalate to manual review (the tool stays deterministic and
  // offline). An invalid Experiment rejects outright with no LLM at all, so the
  // client is never attached in that mode (even with a token).
  if (llmEnabled(ctx) && !invalidExperiment) {
    ctx.llm = createLlmClient({
      ctx,
      token: options.llmApiKey,
      systemIntro,
      type: options.llmApiType,
      model: llmModel,
      url: options.llmApiUrl,
      budget,
    });
  }
  return ctx;
}
