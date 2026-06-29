// The review pipeline: opts in, a structured Review out. This is the tool's
// core, independent of the CLI front-end (cli.js) - the test harness drives it
// directly. It loads the add-on, resolves and verifies its vendored
// declarations, classifies bundled code, runs the schema review, and fills each
// finding's display text from the registry. It returns the Review. Formatting
// and I/O are the front-end's job. The tool is read-only: it never modifies or
// repacks the submission.
//
// Belongs here: the stage orchestration (runPipeline, reviewAddon) and the
// pipeline-level schema-branch helpers (chooseBranch, detectManifestVersion).
//
// Does NOT belong here: the channel/cache/model defaults and behavior toggles -
// src/config.js. Argv parse, validation, and printing (src/cli.js and
// src/report/format.js); each stage's own work - add-on load
// (src/addon/load.js), vendor resolution/verification (src/vendor/*), schema
// fetch/load/index (src/schema/*), check orchestration and run context
// (src/checks/registry.js and src/checks/context.js), and all user-facing text
// (src/checks/registry.js plus src/report/responses.js).

import { resolveSchemaZip } from "./schema/fetch.js";
import { loadSchemaFiles } from "./schema/load.js";
import { buildSchemaIndex } from "./schema/index.js";
import { loadAddon } from "./addon/load.js";
import { resolveReviewUrl } from "./addon/atn.js";
import { runChecks, runOneCheck, loadRegistry } from "./checks/registry.js";
import { buildRunContext } from "./checks/context.js";
import {
  buildSummarizer,
  buildAddonSummarizer,
  buildSelfAssessment,
} from "./checks/summaries.js";
import { createLlmClient } from "./checks/llm-client.js";
import { renderFindings, renderManualItems } from "./report/responses.js";
import { headerLines } from "./report/format.js";
import { resolveVendor } from "./vendor/resolve.js";
import { verifyVendor, auditIdentifiedLibraries } from "./vendor/verify.js";
import { validateLlmConfig, checkModelAvailable } from "./llm/provider.js";
import { classifyBundled } from "./checks/lib/bundled.js";
import { resolveCdnLibraries } from "./checks/lib/cdn-lookup.js";
import {
  resolveLibraryHashes,
  parseLibraryHashes,
} from "./checks/lib/library-hashes.js";
import { getPermissionAnalysis } from "./checks/lib/permissions.js";
import { collapseUnused } from "./checks/lib/unused-folders.js";
import { isExperiment } from "./checks/lib/util.js";
import { experimentApiNamespaces } from "./checks/lib/experiments.js";
import { verifyExperiments } from "./experiments/verify.js";
import { createLlmBudget } from "./llm/budget.js";
import { debug, progress, llmErrorText } from "./util/log.js";
import { red } from "./util/color.js";
import { humanSize } from "./util/text.js";
import {
  DEFAULT_CHANNEL,
  DEFAULT_CACHE,
  MAX_LLM_REQUESTS_PER_RUN,
} from "./config.js";

/** @typedef {import("./report/finding.js").Finding} Finding */
/** @typedef {import("./report/format.js").ReviewMeta} ReviewMeta */
/**
 * An advisory summary already generated during the activity feed: the
 * transmitted byte size and the model's prose (null if the call failed), plus a
 * one-line `error` reason when it failed (shown in the report's summary
 * section). The caller prints the prose after the report.
 * @typedef {{bytes: number, text: ?string, error?: string}} GeneratedSummary
 */

/**
 * @typedef {object} PipelineOpts
 * @property {string} addonPath
 * @property {string} [schemaChannel]
 * @property {string} [schemaZip]
 * @property {string} [schemaCache]
 * @property {boolean} [schemaForceRefresh]
 * @property {string} [experimentsZip]  Local allowed-experiments zip/dir (skips
 *   network).
 * @property {string} [experimentsCache]  Where to cache the fetched experiments
 *   zip.
 * @property {boolean} [experimentsForceRefresh]  Re-fetch the allow-list.
 * @property {string[]} [checksOnly]
 * @property {string[]} [checksSkip]
 * @property {boolean} [eslint]  Run the opt-in ESLint code-sanity check (off by
 *   default); when unset, the code-sanity check is skipped entirely.
 * @property {boolean} [allowExperiments]
 * @property {boolean} [scanMinified]  Review minified/built code: treat a
 *   minified-by-geometry file (an unidentifiable webpack/tsc bundle) as authored so
 *   every source-level check scans it. Hash-identified libraries, obfuscated code,
 *   and VENDOR-declared/experiment files stay excluded. Off by default.
 * @property {string} [libraryHashes]  Local known-library hashes.txt to use
 *   instead of fetching (offline/CI/tests; the golden harness injects a fixture).
 * @property {string} [libraryHashesCache]  Where to cache the fetched hashes.
 * @property {boolean} [libraryHashesForceRefresh]  Re-fetch the library hashes.
 * @property {boolean} [cdnLookup]  Identify an unrecognized minified bundle by a
 *   jsDelivr content-hash lookup (on by default; --cdn-lookup false disables). Set
 *   false to skip the per-file CDN request (offline/privacy).
 * @property {string} [cdnLookupCache]  Where to cache the CDN hash-lookup results.
 * @property {string} [diffTo]  Path to the previous published version.
 * @property {boolean} [diffSummary]  Add an LLM "Summary of changes" section.
 * @property {boolean} [fullSummary]  Add an LLM "Summary of add-on" section.
 * @property {boolean} [selfAssessmentSummary]  Add a final LLM FP/FN audit of the
 *   deterministic findings (tries the LLM regardless of --llm-enabled, logs on
 *   failure). Runs no LLM checks - only the one closing self-assessment call.
 * @property {boolean} [reviewUrl]  Look up the ATN reviewer review-page URL and
 *   put it on meta.reviewUrl - set for text reports, off for JSON/the harness.
 * @property {boolean} [llmEnabled]  The sole LLM on-switch (--llm-enabled).
 * @property {string} [llmApiKey]  Real API key, or undefined (a keyless
 *   provider).
 * @property {string} [llmModel]
 * @property {string} [llmApiUrl]  Override the LLM API base URL (LLM_API_URL).
 * @property {string} [llmApiType]  LLM_API_TYPE (claude | chatgpt | ollama).
 * @property {import("./vendor/verify.js").VendorNet} [vendorNet]  Injectable
 *   network transport for vendor verification (the test harness injects an
 *   offline one); defaults to the real fetch.
 * @property {import("./addon/load.js").Addon} [addon]  Pre-loaded add-on (the
 *   test harness injects one to drop its expected.json sidecar).
 * @property {import("./checks/registry.js").Registry} [registry]  Parsed
 *   registry threaded from the caller, parsed once here otherwise.
 * @property {(used: number) => boolean | Promise<boolean>} [confirmMore]  Asked
 *   when the run hits the LLM request cap (MAX_LLM_REQUESTS_PER_RUN): truthy
 *   runs that many more, falsy stops. The CLI supplies an interactive prompt
 *   only at a terminal. Omitted means hard-stop at the cap (see
 *   src/llm/budget.js).
 */

/**
 * @typedef {object} PipelineResult
 * @property {Finding[]} findings
 * @property {ReviewMeta} meta
 * @property {Record<string, string>} [issueHeadings]
 * @property {Record<string, string>} [verdictIntros]
 * @property {GeneratedSummary} [summarize]
 * @property {GeneratedSummary} [summarizeAddon]
 * @property {GeneratedSummary} [selfAssessment]
 */

/**
 * Run the review pipeline and return the structured result.
 *
 * @param {PipelineOpts} opts
 * @returns {Promise<PipelineResult>}
 */
export async function runPipeline(opts) {
  const { addonPath } = opts;
  // The parsed registry, threaded from main() (or loaded once here when a caller
  // such as the test harness invokes the pipeline directly).
  const registry = opts.registry ?? loadRegistry();

  // 1. Load the add-on (.xpi archive or source folder). A caller may inject a
  // pre-loaded add-on (the test harness does, to drop its expected.json file).
  const addon = opts.addon ?? loadAddon(addonPath);

  // Classify every Experiment add-on against the upstream drafts
  // (github.com/thunderbird/webext-experiments), regardless of
  // --allow-experiments: a bundled experiment whose name matches a known draft
  // MUST be the unmodified upstream copy, which experiment-modified enforces.
  // verifyExperiments fetches the allow-list only when a group actually bundles
  // files (a bare experiment_apis declaration stays offline -> unsupported), and
  // a fetch failure throws so the run hard-exits (2) rather than letting a
  // missing allow-list masquerade as a verdict - we cannot verify identity
  // without it.
  //
  // The flag governs only rejection, not classification. Without
  // --allow-experiments an Experiment add-on is rejected outright (the review
  // short-circuits to the single experiment-not-allowed check, no other checks,
  // no LLM, no manual reminders, and the vendor pre-processing below is skipped)
  // UNLESS every bundled experiment is a recognised upstream draft - a
  // recognised-but-modified one does NOT abort, so the full review runs and
  // experiment-modified flags it. With --allow-experiments the reviewer accepts
  // them, so the full review always runs.
  let invalidExperiment = false;
  if (isExperiment(addon.manifest)) {
    addon.experiments = await verifyExperiments(addon, opts);
    invalidExperiment =
      !opts.allowExperiments &&
      addon.experiments.groups.some((g) => g.status === "unsupported");
  }

  const findings = [];
  const meta = {
    action: "review",
    addon: addon.source,
    addonKind: addon.kind,
    reviewed: true,
  };

  // Run-wide model-request cap, shared by every LLM site this run: the vendor
  // parse, the LLM checks (each candidate batch is one request), and the
  // summaries. `confirmMore` (the interactive "run 25 more?" prompt) is supplied
  // by the CLI. Without it (JSON, piped, tests) the run hard-stops at the cap
  // and the remaining LLM work escalates to manual review. See
  // src/llm/budget.js.
  const llmBudget = createLlmBudget({
    step: MAX_LLM_REQUESTS_PER_RUN,
    confirmMore: opts.confirmMore,
  });

  // The "Setup" feed section: a numbered line per slow pre-review step, in the
  // same [i/total] style as the Activity check loop, so the otherwise-silent
  // pause after the banner (vendor network verification, schema fetch, AST
  // parse) shows what is running. The add-on is already loaded above - like
  // Activity counting its checks before the loop, the total is known here: the
  // vendor step is skipped for a rejected Experiment, so it is one fewer then. A
  // no-op when progress is off (JSON, the golden harness).
  const setupTotal = (invalidExperiment ? 3 : 6) + (opts.llmEnabled ? 1 : 0);
  let setupDone = 0;
  /**
   * Emit the next numbered "Setup" feed line.
   *
   * @param {string} label  Names the step shown after the [done/total] counter.
   */
  const setupStep = (label) =>
    progress(`  [${++setupDone}/${setupTotal}] ${label}`);
  progress("── Setup ──");
  progress("");
  setupStep("Reading add-on");

  // The LLM pre-flight: shown in the Setup feed with the chosen type + model,
  // and a HARD FAIL on a bad config. Runs whenever --llm-enabled, regardless of
  // whether this run will actually use the LLM (a rejected Experiment included)
  // - if you ask for the LLM, its config must be usable. A throw here is
  // surfaced by main()'s catch as a stderr message + exit 2.
  if (opts.llmEnabled) {
    setupStep(`Checking the LLM (${opts.llmApiType}, ${opts.llmModel})`);
    const configError = validateLlmConfig(opts.llmApiType, {
      apiKey: opts.llmApiKey,
    });
    if (configError) {
      throw new Error(configError);
    }
    const availabilityError = await checkModelAvailable(opts.llmApiType, {
      model: opts.llmModel,
      token: opts.llmApiKey,
      baseURL: opts.llmApiUrl,
    });
    if (availabilityError) {
      throw new Error(availabilityError);
    }
  }

  // The known-library hash DB the bundled classifier matches files against. Stays
  // an empty Map for a rejected Experiment (the block below, which classifies, is
  // skipped) so nothing is ever recognized.
  let libraryHashes = new Map();

  if (!invalidExperiment) {
    setupStep("Verifying vendored libraries");
    // 1b. Resolve the vendored declarations ONCE, before the review, so the
    // review's checks share one immutable set. Deterministic parse, plus an LLM
    // fallback when a token is set (token-less stays deterministic).
    addon.vendor = await resolveVendor({
      addon,
      parsePrompt: registry.prompt("vendor-parse"),
      enabled: opts.llmEnabled,
      token: opts.llmApiKey,
      model: opts.llmModel,
      url: opts.llmApiUrl,
      type: opts.llmApiType,
      budget: llmBudget,
    });

    // 1c. Verify the resolved declarations over the network ONCE - fetch,
    // compare (EOL-tolerant), popularity, and the package.json<->file matching -
    // recording each file's result into the same shared store. A declaration
    // with nothing fetchable (or an injected offline transport, as the golden
    // harness uses) makes no request, so offline runs stay deterministic. The LLM
    // params drive the github->npm resolution fallback (a github source whose npm
    // twin the deterministic match misses); the same run-wide budget is shared.
    await verifyVendor(addon, opts.vendorNet, {
      enabled: opts.llmEnabled,
      resolvePrompt: registry.prompt("vendor-npm-resolve"),
      token: opts.llmApiKey,
      model: opts.llmModel,
      url: opts.llmApiUrl,
      type: opts.llmApiType,
      budget: llmBudget,
    });

    // 1d. Resolve + parse the known-library hash DB (fetch+cache, or the
    // --library-hashes local override; the golden harness injects a fixture so
    // offline runs are deterministic), so the classifier can identify a bundled
    // library by the raw hash of its bytes.
    setupStep("Fetching library hashes");
    const { text: libraryHashesText } = await resolveLibraryHashes({
      source: opts.libraryHashes,
      cacheDir: opts.libraryHashesCache,
      refresh: opts.libraryHashesForceRefresh,
    });
    libraryHashes = parseLibraryHashes(libraryHashesText);

    // 1e. Classify the bundled (undeclared third-party) JS ONCE into
    // addon.bundled, read by the bundled checks (computed once, never
    // recomputed). Runs after verifyVendor so the vendored skip set is final.
    addon.bundled = classifyBundled(addon, {
      scanMinified: opts.scanMinified,
      libraryHashes,
    });

    // 1e-bis. Second-tier library identification: for a minified bundle the
    // Mozilla DB did not recognize, ask jsDelivr (by content hash) whether it is a
    // published release, promoting a match into the vendored family (library +
    // libraryId + cdn) for find-lib-on-cdn. Runs after classifyBundled and BEFORE
    // the audit below, so a CDN match is OSV-audited like a hash-DB library.
    // Best-effort: cached on disk, silently skipped offline.
    setupStep("Identifying bundled libraries on a CDN");
    await resolveCdnLibraries(addon, {
      net: opts.vendorNet,
      cacheDir: opts.cdnLookupCache,
      enabled: opts.cdnLookup !== false,
    });

    // 1f. OSV-audit the identified (but undeclared) libraries - both Mozilla
    // hash-DB and CDN matches - so an undeclared vulnerable bundle is caught like a
    // declared dependency. Runs after the two identifiers (libraryIds exist only
    // then) and reuses verifyVendor's OSV transport + the shared vulnerabilities
    // store; best-effort, skips offline.
    setupStep("Auditing bundled libraries");
    await auditIdentifiedLibraries(addon, opts.vendorNet);
  }

  // 2. Schema review. reviewAddon also generates the advisory AI summaries at
  // the tail of the activity feed (the add-on summary's recheck verdicts feed the
  // post-summary recheck consumers, which run there too), so they come back here.
  const result = await reviewAddon(
    addon,
    opts,
    registry,
    invalidExperiment,
    llmBudget,
    setupStep,
    libraryHashes
  );
  findings.push(...result.findings);
  Object.assign(meta, result.meta);
  const { summarize, summarizeAddon, selfAssessment } = result;

  // Surface the review header now - before the ATN review-page lookup below, a
  // network call that can stall the feed for seconds - so the reviewer sees what
  // was reviewed the moment the Activity feed ends, instead of staring at a
  // frozen screen. It is removed from the report body (src/report/format.js) so
  // it is not printed twice. A no-op when progress is off (JSON, the golden
  // harness).
  progress("");
  for (const line of headerLines(meta)) {
    progress(line);
  }
  progress("");

  // Text reports point the reviewer at the ATN review page, looked up by gecko
  // id (addon/atn.js). Best-effort: null when it cannot be resolved, and the
  // report omits the line. Gated to text runs by the caller, so the golden
  // harness (which never sets it) makes no request and stays reproducible.
  // Skipped for an outright Experiment reject (the URL only renders inside the
  // omitted Manual review section anyway).
  if (opts.reviewUrl && !invalidExperiment) {
    meta.reviewUrl = await resolveReviewUrl({ manifest: addon.manifest });
  }

  // Fill each finding's display message from its registry response (with the
  // {{item}} placeholder), so the Issues section reports the ready-to-send
  // wording. The registry is the only source of this text.
  renderFindings(findings, registry);

  return {
    findings,
    meta,
    // Severity-group headings + the verdict preamble for the text Issues
    // section.
    issueHeadings: registry.issueHeadings(),
    verdictIntros: registry.verdictIntros(),
    // AI summaries generated above (each undefined unless its flag + a token
    // warrant it). The caller prints the prose after the report - see
    // src/cli.js.
    summarize,
    summarizeAddon,
    selfAssessment,
  };
}

/**
 * Generate one advisory prose summary at the tail of the activity feed: narrate
 * `LLM: Generating <label> (<size>) ...` so the reviewer sees what is being
 * waited on, then run the deferred model call. Returns { bytes, text } (text
 * null on an LLM error), or undefined when there is nothing to summarize (no
 * token, no diff, ...). The caller prints the prose after the report.
 * @param {import("./checks/summaries.js").DeferredSummary|null} deferred
 * @param {string} label  Names the summary in the feed, e.g. "diff summary".
 * @param {import("./llm/budget.js").LlmBudget} [budget]  Run-wide request cap.
 * @returns {Promise<GeneratedSummary|undefined>}
 */
async function generateSummary(deferred, label, budget) {
  if (!deferred) {
    return undefined;
  }
  if (budget && !(await budget.consume())) {
    return undefined; // run-wide request cap reached
  }
  progress(`  LLM: Generating ${label} (${humanSize(deferred.bytes)}) ...`);
  try {
    return { bytes: deferred.bytes, text: await deferred.run() };
  } catch (err) {
    // An advisory summary must never abort the review. Report the failure at
    // this step (visible without --verbose) and carry the reason to the report.
    const reason = llmErrorText(err);
    progress(red(`  LLM: ${label} failed - ${reason}`));
    return { bytes: deferred.bytes, text: null, error: reason };
  }
}

/**
 * Generate the --full-summary add-on review and store its recheck verdicts on the
 * context (the post-summary recheck consumers, which run next, read them). Mirrors
 * generateSummary but unpacks the review object: the prose goes to the returned
 * summary (printed after the report), the recheck verdicts onto ctx.addon.recheck.
 * They are set ONLY when the model actually returned a review, so a missing
 * `ctx.addon.recheck` is the clean signal that no analysis happened (LLM error
 * here, or never called) - the consumers then fall their handed-over items back to
 * manual review. Undefined when there is no summary to make.
 * @param {import("./checks/registry.js").RunContext} ctx
 * @param {import("./checks/registry.js").Registry} registry
 * @param {Set<string>} unused  Files the review found unreachable (excluded).
 * @param {import("./llm/budget.js").LlmBudget} [budget]  Run-wide request cap.
 * @returns {Promise<GeneratedSummary|undefined>}
 */
async function generateAddonSummary(ctx, registry, unused, budget) {
  // Permissions a reachable API call provably requires (memoized, already
  // computed by the main-loop missing-permission checks). Passed to the prompt's
  // declared-permissions block as context; the producer (unused-permission-manual)
  // already excluded these, so the summary only re-judges the unprovable rest.
  const used = getPermissionAnalysis(ctx).usedPermissions;
  const deferred = buildAddonSummarizer(ctx, registry, { unused, used });
  if (!deferred) {
    return undefined;
  }
  if (budget && !(await budget.consume())) {
    return undefined; // run-wide request cap reached
  }
  progress(`  LLM: Generating full summary (${humanSize(deferred.bytes)}) ...`);
  let review;
  try {
    review = await deferred.run();
  } catch (err) {
    const reason = llmErrorText(err);
    progress(red(`  LLM: full summary failed - ${reason}`));
    return { bytes: deferred.bytes, text: null, error: reason };
  }
  if (review) {
    ctx.addon.recheck = review.recheck;
  }
  return { bytes: deferred.bytes, text: review?.summary ?? null };
}

/**
 * The --self-assessment-summary FP/FN audit: one free-form LLM call that gets the
 * authored sources plus the deterministic findings and reports likely false
 * positives + possible false negatives. Independent of the LLM-check gating - it
 * builds its OWN client and just TRIES the call, logging (never throwing) on a
 * missing token or any model error, so the review is unaffected. Returns a
 * GeneratedSummary, or undefined when there is nothing to send.
 * @param {RunContext} ctx
 * @param {Registry} registry
 * @param {PipelineOpts} opts
 * @param {Finding[]} findings  Rendered findings (message filled).
 * @param {object[]} manualItems
 * @param {Set<string>} unused  Unreachable files, excluded from the sources.
 * @param {import("../llm/budget.js").LlmBudget} [budget]
 * @returns {Promise<GeneratedSummary|undefined>}
 */
async function generateSelfAssessment(
  ctx,
  registry,
  opts,
  findings,
  manualItems,
  unused,
  budget
) {
  const payload = buildSelfAssessment(
    ctx,
    registry,
    findings,
    manualItems,
    unused
  );
  if (!payload) {
    return undefined;
  }
  if (budget && !(await budget.consume())) {
    return undefined; // run-wide request cap reached
  }
  progress(
    `  LLM: Generating self-assessment (${humanSize(payload.bytes)}) ...`
  );
  try {
    const client = createLlmClient({
      ctx,
      token: opts.llmApiKey,
      systemIntro: registry.prompt("system-intro"),
      type: opts.llmApiType,
      model: opts.llmModel,
      url: opts.llmApiUrl,
      budget,
    });
    const text = await client.summarize({
      system: payload.system,
      user: payload.user,
    });
    return { bytes: payload.bytes, text };
  } catch (err) {
    const reason = llmErrorText(err);
    progress(red(`  LLM: self-assessment skipped - ${reason}`));
    return { bytes: payload.bytes, text: null, error: reason };
  }
}

/**
 * The schema-review half of the pipeline, operating on an already-loaded add-on.
 *
 * @param {import("./addon/load.js").Addon} addon
 * @param {PipelineOpts} opts
 * @param {import("./checks/registry.js").Registry} registry
 * @param {boolean} [invalidExperiment]  Reject-only mode: run just the
 *   experiment-not-allowed check, with no LLM, summaries, or manual reminders.
 * @param {import("../llm/budget.js").LlmBudget} [budget]
 * @param {(label: string) => void} [setupStep]  Emits the next numbered "Setup"
 *   feed line; supplied by runPipeline, which owns the section's running count.
 * @param {Map<string, {name: string, version: string}>} [libraryHashes]  The
 *   known-library hash DB runPipeline resolved, carried onto ctx.options so the
 *   lazy getBundled path matches the pre-step's classification (real runs use the
 *   memoized addon.bundled, so this is only the no-pre-step fallback).
 * @returns {Promise<{findings: Finding[], meta: ReviewMeta,
 *   ctx: import("./checks/registry.js").RunContext}>}
 */
async function reviewAddon(
  addon,
  opts,
  registry,
  invalidExperiment,
  budget,
  setupStep = () => {},
  libraryHashes = new Map()
) {
  const {
    schemaChannel = DEFAULT_CHANNEL,
    schemaZip,
    schemaCache = DEFAULT_CACHE,
    schemaForceRefresh = false,
    checksOnly,
    checksSkip,
    eslint,
    llmEnabled,
    llmApiKey,
    llmApiUrl,
    llmApiType,
    allowExperiments,
    scanMinified,
    diffTo,
    fullSummary,
    diffSummary,
  } = opts;

  const branch = chooseBranch({ schemaZip, schemaChannel, addon });
  setupStep(`Fetching review schemas (${branch})`);
  const { zipPath, source: schemaSource } = await resolveSchemaZip({
    schemaZip,
    branch,
    cacheDir: schemaCache,
    refresh: schemaForceRefresh,
  });
  const schema = buildSchemaIndex(loadSchemaFiles(zipPath));
  // A valid Experiment's declared APIs are part of its platform: register their
  // base namespaces so the developer's calls into them (e.g. browser.calendar.*,
  // including bare browser.calendar) resolve instead of tripping unknown-api -
  // the developer owns the namespace, so we accept it wholesale rather than
  // tracing each sub-API. Note that experiment-overrides-api separately flags a
  // path that collides with a built-in.
  if (!invalidExperiment && isExperiment(addon.manifest)) {
    schema.registerExperimentNamespaces(
      experimentApiNamespaces(addon.manifest, addon.files)
    );
  }

  setupStep("Parsing add-on sources");
  // The checks layer assembles its own context (sources, API usage, diff
  // baseline, LLM client) - the pipeline only resolves the schema.
  const ctx = buildRunContext({
    addon,
    schema,
    options: {
      llmEnabled,
      llmApiKey,
      llmApiUrl,
      llmApiType,
      allowExperiments,
      scanMinified,
      libraryHashes,
    },
    diffTo,
    llmModel: opts.llmModel,
    systemIntro: registry.prompt("system-intro"),
    invalidExperiment,
    budget,
  });

  // The registry.yaml file drives which checks run, by `phase`: runChecks runs
  // the default-phase checks in its loop now and returns the post-summary checks
  // marked `phase: post-summary` (the unused-permission recheck consumers, which
  // read the add-on summary's result) as `deferred` to run after the summary below.
  // An invalid Experiment runs only its reject check (runChecks picks the
  // profile from ctx.invalidExperiment). The orchestrator returns issues-only
  // findings plus the manual refs it produced (escalations with no token /
  // unsure / error). Each throwing check is isolated so one failure can't abort
  // all. The ESLint code-sanity check is opt-in: without --eslint it is excluded
  // here.
  const baseSkip = eslint
    ? (checksSkip ?? [])
    : [...(checksSkip ?? []), "code-sanity"];
  // When the full add-on summary will run, a check that declares a
  // `post-summary-recheck` hands its manual items to that recheck consumer to be
  // re-judged with whole-add-on context (runChecks diverts them; the summary
  // judges them; the consumer resolves them - see src/checks/lib/recheck.js).
  // Without the summary this is false, so those items go straight to manual
  // review exactly as before.
  ctx.recheckActive = !invalidExperiment && fullSummary && Boolean(ctx.llm);
  progress(""); // close the Setup section before runChecks prints "── Activity ──"
  const { findings, checks, manualItems, deferred, total } = await runChecks(
    ctx,
    registry,
    { only: checksOnly, skip: baseSkip }
  );

  // Advisory AI summaries, generated at the tail of the activity feed (a
  // `LLM: Generating ...` line shows what is being waited on). The prose is
  // printed after the report by the caller (src/cli.js). The add-on summary runs
  // first to match that display order, and because it re-judges the recheck items
  // handed to it (ctx.recheck) - storing the verdicts on ctx.addon.recheck for
  // the post-summary recheck consumers below. It excludes files the review found
  // unreachable - that set is a product of reachability (unused-files), so it
  // exists only now, which is why the summary runs after the checks.
  let summarizeAddon;
  if (!invalidExperiment && fullSummary) {
    const unused = new Set(
      findings.filter((f) => f.ruleId === "unused-files").map((f) => f.file)
    );
    summarizeAddon = await generateAddonSummary(ctx, registry, unused, budget);
  }
  let summarize;
  if (!invalidExperiment && diffSummary) {
    summarize = await generateSummary(
      buildSummarizer(ctx, registry),
      "diff summary",
      budget
    );
  }

  // The post-summary checks (phase: post-summary, incl. the recheck consumers),
  // run now that the add-on summary has populated ctx.addon.recheck, through the
  // identical per-check path as the loop - runOneCheck stamps id/severity and
  // routes escalations to manual review. They honor --checks/--skip (already
  // applied by loadChecks). Numbering continues from the main loop so the feed
  // reads [1/total] .. [total/total]. This list is empty for an invalid Experiment.
  const ran = [...checks];
  for (const [j, check] of deferred.entries()) {
    const out = await runOneCheck(
      ctx,
      check,
      `[${checks.length + j + 1}/${total}]`
    );
    findings.push(...out.findings);
    manualItems.push(...out.manualItems);
    ran.push(check);
  }

  // Condense the unused-files report: when every packaged file under a folder is
  // unused, collapse it to the top-most such folder (recursively). Output-only -
  // it runs after every check has scanned every file, so other rules still
  // report each nested file at its exact path. Applied separately to the
  // findings (clear orphans/junk) and the manual escalations (ambiguous), so
  // certainty is not mixed (a folder split across both buckets collapses in
  // neither).
  const allFiles = [...addon.files.keys()];
  collapseUnusedFolders(findings, allFiles);
  collapseUnusedFolders(manualItems, allFiles);

  // The self-assessment audit (--self-assessment-summary): a single final LLM call
  // that critiques the now-complete deterministic findings for false positives and
  // hunts for false negatives. It needs the rendered finding messages, so render
  // them here (idempotent - the caller renders again before printing). It tries the
  // LLM regardless of --llm-enabled and only logs on failure.
  let selfAssessment;
  if (!invalidExperiment && opts.selfAssessmentSummary) {
    renderFindings(findings, registry);
    const unused = new Set(
      findings.filter((f) => f.ruleId === "unused-files").map((f) => f.file)
    );
    selfAssessment = await generateSelfAssessment(
      ctx,
      registry,
      opts,
      findings,
      manualItems,
      unused,
      budget
    );
  }

  return {
    findings,
    // The built run context is returned for any post-review use by the caller.
    ctx,
    // The advisory summaries, generated above (each undefined unless its flag +
    // a token warrant it). The caller prints their prose after the report.
    summarize,
    summarizeAddon,
    selfAssessment,
    meta: {
      schemaSource,
      schemaBranch: branch,
      schemaChannel: schemaZip ? null : schemaChannel,
      applicationVersion: schema.applicationVersion,
      manifestVersion: addon.manifest?.manifest_version ?? null,
      checksRun: ran.map((c) => c.id),
      // One manual-review list, tagged by origin so the report can split it into
      // two sections: `extended` items are checks that escalated (the
      // orchestrator's refs, resolved to their registry text). The rest are the
      // by-hand `manual-checks` entries (Standard), diff-gated like the checks
      // (e.g. the new-submission-only "Forked add-on" reminder). An outright
      // Experiment reject prints only the reject finding, so it carries none.
      manualReview: invalidExperiment
        ? []
        : [
            ...renderManualItems(manualItems, registry).map((m) => ({
              ...m,
              extended: true,
            })),
            ...registry
              .manualChecks(Boolean(ctx.previous))
              .map((m) => ({ ...m, extended: false })),
          ],
    },
  };
}

/**
 * Rewrite the unused-files entries (findings OR manual refs) in `entries`,
 * in place, collapsing fully-unused folders to a single top-most folder entry
 * (see collapseUnused). Only acts when at least one folder forms, so the common
 * "nothing collapses" case leaves the array untouched (no reordering). The first
 * unused-files entry serves as the template, so the collapsed entries keep its
 * `ruleId` + `severity` (findings) / `ruleId` + `kind` (manual refs). Each new
 * entry sets `file` to the collapsed path and clears `loc`/`item`.
 * @param {Array<{ruleId?: string, file?: ?string}>} entries
 * @param {string[]} allFiles  Every packaged file path (the denominator).
 */
function collapseUnusedFolders(entries, allFiles) {
  const idx = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].ruleId === "unused-files" && entries[i].file) {
      idx.push(i);
    }
  }
  if (!idx.length) {
    return;
  }
  const collapsed = collapseUnused(
    idx.map((i) => entries[i].file),
    allFiles
  );
  if (!collapsed.some((p) => p.endsWith("/"))) {
    return; // no folder formed - leave the per-file entries (and their order) as-is
  }
  const base = entries[idx[0]];
  const replacements = collapsed.map((file) => ({
    ...base,
    file,
    loc: null,
    item: null,
  }));
  const drop = new Set(idx);
  const rebuilt = [];
  for (let i = 0; i < entries.length; i++) {
    if (i === idx[0]) {
      rebuilt.push(...replacements); // collapsed group takes the first match's slot
    }
    if (!drop.has(i)) {
      rebuilt.push(entries[i]);
    }
  }
  entries.splice(0, entries.length, ...rebuilt);
}

/**
 * @typedef {object} BranchParams
 * @property {string|undefined} schemaZip
 * @property {string} schemaChannel
 * @property {import("./addon/load.js").Addon} addon
 */

/**
 * Choose the schema branch for the add-on. The add-on's manifest_version
 * selects the schema, combined with the channel. A local --schema-zip bypasses
 * branch selection.
 *
 * @param {BranchParams} params
 * @returns {string|null}
 */
function chooseBranch({ schemaZip, schemaChannel, addon }) {
  if (schemaZip) {
    return null;
  }
  const mv = detectManifestVersion(addon.manifest);
  const branch = `${schemaChannel}-mv${mv.version}`;
  debug(
    `Detected manifest_version ${mv.detected ? mv.version : `? (defaulting to ${mv.version})`}` +
      ` → using schema branch "${branch}".`
  );
  return branch;
}

/**
 * Detect the manifest_version from the add-on manifest. A missing or invalid
 * manifest_version defaults to 2 (an add-on that omits it is Manifest V2).
 *
 * @param {object|null|undefined} manifest
 * @returns {{version: number, detected: boolean}}
 */
function detectManifestVersion(manifest) {
  const v = manifest?.manifest_version;
  if (v === 2 || v === 3) {
    return { version: v, detected: true };
  }
  return { version: 2, detected: false };
}
