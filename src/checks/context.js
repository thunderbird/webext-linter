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
 * The check-facing artifact: the routed add-on projected to its INTRINSIC,
 * self-healing data - files plus the lazy file-derived caches (bundled, vendor,
 * locales, evalScan, outboundSinks, permissionAnalysis). The manifest and the
 * experiment classification are deliberately ABSENT: they are shipped-authoritative
 * (what Thunderbird loads / how it treats the XPI's experiments) and are exposed as
 * ctx.manifest / ctx.experiments instead. So a check has no `ctx.addon.manifest` to
 * read one artifact's manifest against another's files, and no `ctx.addon.experiments`
 * for an `input: xpi` check to read as undefined. Vendor STAYS - each artifact's own
 * dependency audit is intrinsic to it (only the review target's is computed) and
 * classifyBundled reads it through the addon it classifies.
 * @param {import("../addon/load.js").Addon} addon  The routed add-on.
 * @returns {object} A shallow copy without manifest/experiments.
 */
function reviewView(addon) {
  const view = { ...addon };
  delete view.manifest;
  delete view.manifestError;
  delete view.manifestLoc;
  delete view.experiments;
  return view;
}

/**
 * Assemble the shared RunContext for one review.
 * @param {object} params
 * @param {import("../addon/load.js").Addon} params.addon
 * @param {import("../schema/index.js").SchemaIndex} params.schema
 * @param {{llmEnabled?: boolean, llmApiKey?: string, llmApiUrl?: string,
 *   llmApiType?: string, allowExperiments?: boolean,
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
  xpiAddon = addon,
  schema,
  options,
  diffTo,
  llmModel,
  systemIntro,
  invalidExperiment,
  mode = "xpi",
  scsExpSource,
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
  // (src.parsed ?? parseJs), one file at a time, with no effect on the findings.
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
    // The check-facing artifact is the routed add-on's INTRINSIC view (reviewView):
    // files + self-healing derivations, with the manifest and experiments stripped
    // so they can only be read through the shipped-authoritative ctx fields below.
    addon: reviewView(addon),
    schema,
    jsSources,
    apiUsages,
    options,
    previous: diffTo ? loadAddon(diffTo) : null,
    invalidExperiment,
    // "xpi" (default - reviewing a built add-on) or "scs" (a source-code
    // submission: --scs-root/--scs-source). Gates checks via scsEligible.
    mode,
    // SCS mode: the Experiment folder as a source-relative path (runPipeline re-based
    // it from the scsRoot-relative --scs-exp-source flag). buildReachability excludes
    // it from the pure-WebExtension set, so the WebExtension code checks skip
    // privileged Experiment code. Undefined in XPI mode.
    scsExpSource,
    // The authoritative manifest is the SHIPPED artifact's (the built XPI) - what
    // Thunderbird actually loads. It is explicit shared context, like `schema`, so
    // the manifest / permission / API checks read it - there is no ctx.addon.manifest
    // (reviewView strips it), which in SCS would be the readable source's pre-build
    // template. In XPI mode xpiAddon IS addon. See the RunContext typedef.
    manifest: xpiAddon?.manifest ?? null,
    manifestError: xpiAddon?.manifestError ?? null,
    manifestLoc: xpiAddon?.manifestLoc ?? null,
    manifestText: xpiAddon?.files?.get("manifest.json")?.toString("utf8") ?? "",
    // The Experiment classification (verifyExperiments, computed from the shipped
    // XPI and attached to the review addon by the pipeline). Shipped-authoritative
    // and shared like the manifest, so the experiment checks read ctx.experiments,
    // not ctx.addon.experiments (which reviewView strips). Null for non-Experiments.
    experiments: addon?.experiments ?? null,
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

/**
 * A sibling of a review context whose `addon` / `jsSources` are the SHIPPED
 * artifact's (the built XPI), for the `input: xpi` structure checks (bundled-files,
 * minimize-web-accessible-resources, ...) and the behavioral add-on summary, which
 * describe what actually ships. The orchestrator (registry.js runChecks / pipeline)
 * builds this once and routes it to those consumers; every other field is shared with
 * the review context, and `apiUsages` (per-source, source-only) is dropped so the
 * shipped view never carries the source's. It REQUIRES the built XPI as an argument,
 * so there is no way to derive the shipped artifact from a check's context alone.
 *
 * When the built XPI IS the review target (an XPI review), there is one artifact and
 * this returns ctx unchanged - so callers route unconditionally through it.
 * @param {RunContext} ctx  The review context (ctx.addon = the review target).
 * @param {import("../addon/load.js").Addon} xpiAddon  The built XPI.
 * @returns {RunContext}
 */
export function buildShippedCtx(ctx, xpiAddon) {
  // ctx.addon is a reviewView (a shallow copy), so it is never === xpiAddon even in
  // XPI mode; the files Map, however, is copied by reference, so an identical files
  // Map means the review target IS the built XPI (one artifact) - return ctx unchanged.
  if (ctx.addon.files === xpiAddon.files) {
    return ctx;
  }
  return {
    ...ctx,
    addon: reviewView(xpiAddon),
    jsSources: collectJsSources(xpiAddon),
    apiUsages: undefined,
    // Marks the shipped view for reachability: the built XPI's manifest entry points
    // resolve against its OWN files, so pureWebExtensionReachable takes the closure
    // branch - not the SCS "all readable-source files" fallback, which exists only
    // for the review source, whose pre-build layout the manifest's built paths miss.
    isShippedView: true,
  };
}

/**
 * A sibling review context whose `addon` is the SCS BUILD files - the tooling that
 * builds the add-on (scripts, configs, package.json/lock: everything in --scs-root
 * outside the review source, with node_modules and dotfiles excluded, from
 * loadScsBuildFiles). The
 * `input: build` check (undeclared-build-source) is routed here, so it reads the
 * build corpus off ctx.addon like any other check reads its artifact - keeping
 * artifact selection the single `input` seam, no separate ctx field. SCS mode only.
 * The build corpus is projected through reviewView (like every other ctx.addon), so a
 * build check can never read ctx.addon.manifest/experiments against another artifact's
 * files; the shipped manifest stays on ctx.manifest for the shared LLM framing.
 * @param {RunContext} ctx  The review context.
 * @param {{files: Map<string, Buffer>, nodeModules?: string[]}} buildAddon  The
 *   build-file corpus (nodeModules rides along for the committed-node-modules check).
 * @returns {RunContext}
 */
export function buildScsBuildCtx(ctx, buildAddon) {
  return {
    ...ctx,
    addon: reviewView(buildAddon),
    jsSources: [],
    apiUsages: undefined,
  };
}
