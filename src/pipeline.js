// The review pipeline: opts in, a structured Review out. This is the tool's
// core, independent of the CLI front-end (cli.js) - the test harness drives it
// directly. It loads the add-on, resolves and verifies its vendored
// declarations, classifies bundled code, runs the schema review, and fills each
// finding's display text from the registry. It returns the Review. Formatting
// and I/O are the front-end's job. The tool is read-only: it never modifies or
// repacks the submission.
//
// Belongs here: the stage orchestration (runPipeline, reviewAddon) and the
// pipeline-level schema-selection helpers (resolveReviewSchema,
// selectSchemaChannel, detectManifestVersion).
//
// Does NOT belong here: the cache/model defaults and behavior toggles -
// src/config.js. The schema channel set + branch names - src/schema/fetch.js.
// Argv parse, validation, and printing (src/cli.js and
// src/report/format.js); each stage's own work - add-on load
// (src/addon/load.js), vendor resolution/verification (src/vendor/*), schema
// fetch/load/index (src/schema/*), check orchestration and run context
// (src/checks/registry.js and src/checks/context.js), and all user-facing text
// (src/checks/registry.js plus src/report/responses.js).

import {
  resolveSchemaZip,
  refreshAllSchemas,
  hasAllCachedSchemas,
  cachedZipPath,
  schemaBranch as branchName,
  SCHEMA_CHANNELS,
} from "./schema/fetch.js";
import { loadSchemaFiles, peekApplicationVersion } from "./schema/load.js";
import { buildSchemaIndex } from "./schema/index.js";
import {
  loadSchemaAnnotations,
  applySchemaAnnotations,
} from "./schema/annotate.js";
import {
  loadAddon,
  loadScaAddon,
  loadScaBuildFiles,
  scaExpSourceRelative,
} from "./addon/load.js";
import { resolveReviewUrl } from "./addon/atn.js";
import {
  runChecks,
  runOneCheck,
  routeCtx,
  loadRegistry,
} from "./checks/registry.js";
import { analyzeBuild } from "./build/analyze.js";
import {
  buildRunContext,
  buildShippedCtx,
  buildScaBuildCtx,
  buildManifestCtx,
} from "./checks/context.js";
import { buildSummarizer, buildAddonSummarizer } from "./checks/summaries.js";
import { renderFindings, renderManualItems } from "./report/responses.js";
import { headerLines } from "./report/format.js";
import { resolveVendor } from "./vendor/resolve.js";
import {
  verifyVendor,
  verifyScaDependencies,
  auditIdentifiedLibraries,
} from "./vendor/verify.js";
import { validateLlmConfig, checkModelAvailable } from "./llm/provider.js";
import {
  classifyFiles,
  classifyBundled,
  assembleBundled,
  applyNotPopularVendor,
} from "./checks/lib/bundled.js";
import { collectJsSources } from "./addon/sources.js";
import { runExtractionPass } from "./checks/extract.js";
import { resolveCdnLibraries } from "./checks/lib/cdn-lookup.js";
import {
  resolveLibraryHashes,
  parseLibraryHashes,
} from "./checks/lib/library-hashes.js";
import {
  resolveLibraryBlocks,
  parseLibraryBlocks,
} from "./checks/lib/library-blocks.js";
import { collapseUnused } from "./checks/lib/unused-folders.js";
import {
  isExperiment,
  parseVersion,
  strictMaxVersion,
} from "./checks/lib/util.js";
import { experimentApiNamespaces } from "./checks/lib/experiments.js";
import { verifyExperiments } from "./experiments/verify.js";
import { createLlmBudget } from "./llm/budget.js";
import { debug, progress, warn, FEED, llmErrorText } from "./util/log.js";
import { red } from "./util/color.js";
import { humanSize } from "./util/text.js";
import { DEFAULT_CACHE, MAX_LLM_REQUESTS_PER_RUN } from "./config.js";

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
 * @property {string} [schemaCache]
 * @property {string} [experimentsCache]  Where to cache the fetched experiments
 *   zip.
 * @property {string[]} [checksOnly]
 * @property {string[]} [checksSkip]
 * @property {boolean} [eslint]  Run the opt-in ESLint code-sanity check (off by
 *   default); when unset, the code-sanity check is skipped entirely.
 * @property {boolean} [allowExperiments]
 * @property {string} [scaRoot]  SCA mode: path to the source
 *   archive root (folder or zip) holding package.json/lock. Setting it switches the
 *   review to SCA mode - the readable source (scaSource) is reviewed and its declared
 *   dependencies are audited; the positional XPI is the shipped artifact against which
 *   the manifest, experiments, file-completeness (`input: xpi`) checks, the --diff-to
 *   comparison, and the packaging summary all run (a separate shipped context the
 *   orchestrator routes them to - see buildShippedCtx in src/checks/context.js). The
 *   behavioral --full-summary reviews the readable source instead.
 * @property {string} [scaSource]  The add-on code root, relative to scaRoot or an
 *   absolute path (e.g. "src" or "addon"). Optional; defaults to "." (the whole scaRoot
 *   reviewed as the source - a flat layout with manifest.json at the root).
 * @property {string} [scaExpSource]  SCA mode: the Experiment implementation folder,
 *   relative to scaRoot (or absolute) and within scaSource (e.g. "addon/experiment-api");
 *   runPipeline re-bases it to a source-relative ctx.scaExpSource. Its privileged, non-WebExtension
 *   files are excluded from the WebExtension code checks (which review all of the
 *   readable source, having no reachability tree there). Optional in general, but
 *   REQUIRED when allowExperiments is set in SCA mode (the CLI enforces this) -
 *   without it, Experiment code cannot be told apart from WebExtension code.
 * @property {string} [libraryHashesCache]  Where to cache the fetched hashes.
 * @property {boolean} [cdnLookup]  Identify an unrecognized bundled library (minified,
 *   or a large readable file) by a jsDelivr content-hash lookup (on by default;
 *   --cdn-lib-lookup false disables). Set false to skip the per-file CDN request
 *   (offline/privacy).
 * @property {string} [cdnLookupCache]  Where to cache the CDN hash-lookup results.
 * @property {string} [diffTo]  Path to the previous published version.
 * @property {boolean} [diffSummary]  Add an LLM "Summary of changes" section.
 * @property {boolean} [fullSummary]  Add an LLM "Summary of add-on" section.
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
 */

/**
 * Run the review pipeline and return the structured result.
 *
 * @param {PipelineOpts} opts
 * @returns {Promise<PipelineResult>}
 */
export async function runPipeline(opts) {
  const { addonPath } = opts;
  // SCA (source code archive) mode is on when --sca-root is set (--sca-source is
  // optional, defaulting to "."). It splits the review across TWO add-on artifacts
  // with a fixed ROLE each, resolved here ONCE so nothing downstream re-branches on the mode:
  //
  //   xpiAddon - the built XPI (the positional addonPath). The SHIPPED artifact,
  //     authoritative in BOTH modes for the manifest, the experiments, and the
  //     behavioral LLM summary (what actually runs on a user's machine).
  //   addon    - the deterministic review target (becomes ctx.addon): the readable
  //     code the source-level checks scan. In XPI mode it simply IS xpiAddon; in
  //     SCA mode it is the readable source at scaSource - a synthetic addon whose
  //     files are the source but whose manifest is the XPI's (loadScaAddon), so the
  //     checks stay mode-agnostic.
  //
  // So downstream: read `addon` for the code under review, `xpiAddon` for the
  // shipped artifact - no further mode checks. The only other mode forks are the
  // dependency resolution (--sca-root vs the XPI's VENDOR/package.json) and the
  // check gate (ctx.mode -> scaEligible). Minified code is non-authored (and rejected)
  // in both modes: a source-code submission's promise is readable source, so a minified
  // file in --sca-source is rejected like one in an XPI, not scanned as authored.
  // --sca-source may name a nested subfolder OR the archive root itself (a flat
  // layout: manifest.json at the root, with the build tooling intermingled). The root
  // case (scaRootRelative resolves ".", an absolute root, or a literal match all to "")
  // is handled throughout: loadScaAddon reviews every file, and loadScaBuildFiles still
  // traces the build off the root package.json (there is no source subtree to exclude).
  // --sca-root alone switches to SCA mode; --sca-source is optional and defaults to "."
  // (the whole root reviewed as the source - the common flat-layout case).
  const mode = opts.scaRoot ? "sca" : "xpi";
  // No (or empty) --sca-source in SCA mode defaults to "." - both resolve to the
  // archive root via scaRootRelative, so `||` keeps the value a real path.
  const scaSource = mode === "sca" ? opts.scaSource || "." : opts.scaSource;
  // The parsed registry, threaded from main() (or loaded once here when a caller
  // such as the test harness invokes the pipeline directly).
  const registry = opts.registry ?? loadRegistry();

  // 1. Load the .xpi archive (a fast in-memory unzip). Read before the "Setup" banner
  // because it sizes the feed - it gives the mode and whether the add-on is an
  // Experiment. Everything slow below (the source directory read, the network
  // experiment fetch, vendor verification, schema fetch, AST parse) is narrated as a
  // Setup step, so nothing slow runs un-narrated. A caller may inject a pre-loaded XPI
  // add-on (the test harness does, to drop its expected.json).
  const xpiAddon = opts.addon ?? loadAddon(addonPath);
  const isExp = isExperiment(xpiAddon.manifest);

  // The "Setup" feed: one numbered [i/total] line per slow pre-review step, matching
  // the Activity check loop, so the otherwise-silent pre-review pause shows what is
  // running (a no-op when progress is off - JSON, the golden harness). The total is
  // sized from what the fast .xpi read already gives us: mode (SCA skips the XPI-only
  // CDN + identified-library-audit steps, so is shorter), --llm-enabled, and whether
  // it is an Experiment (which adds a classification step). Exact for every path EXCEPT
  // a REJECTED Experiment (an experiment add-on run WITHOUT --allow-experiments whose
  // bundled draft is unrecognised): it skips the whole vendor block, so its counter
  // stops MID-count (e.g. [4/8]) rather than completing. Sizing the total for that short
  // path would need `invalidExperiment`, known only AFTER the narrated experiment fetch
  // - i.e. a second classification pass before the banner, which we deliberately avoid;
  // the accepted path (the reviewer's --allow-experiments flow) is exact.
  const setupTotal =
    (mode === "sca" ? 10 : 7) + (opts.llmEnabled ? 1 : 0) + (isExp ? 1 : 0);
  let setupDone = 0;
  /**
   * Emit the next numbered "Setup" feed line.
   * @param {string} label  Names the step shown after the [done/total] counter.
   */
  const setupStep = (label) =>
    progress(`[${++setupDone}/${setupTotal}] ${label}`, FEED.STEP);
  progress("── Setup ──");
  progress("");

  // 1a. Read the add-on the review scans. In SCA mode this reads the whole --sca-root
  // archive ONCE (the slow directory walk) and shares it with the build-corpus loader
  // (loadScaBuildFiles) below, so the tree is never read twice; the review addon is
  // the source subtree carrying the XPI's manifest. In XPI mode it IS the .xpi above.
  setupStep("Reading add-on");
  let scaArchive;
  let addon;
  if (mode === "sca") {
    scaArchive = loadAddon(opts.scaRoot);
    addon = loadScaAddon(scaArchive, scaSource, opts.scaRoot);
  } else {
    addon = xpiAddon;
  }
  // Narrate anything the loader skipped (a non-node_modules symlink, an unsafe archive
  // path) as a notice under this step. The loaders collect these instead of printing, so
  // the pre-banner .xpi sizing read (loadAddon above) stays silent - nothing leaks before
  // the Setup banner.
  for (const notice of [
    ...(xpiAddon.skipped ?? []),
    ...(scaArchive?.skipped ?? []),
  ]) {
    warn(notice);
  }

  // --sca-exp-source (like --sca-source) is relative to --sca-root, or absolute.
  // Re-base it into the review-source keyspace (strip the --sca-source prefix) so
  // the WebExtension-code checks can exclude the Experiment subtree; ctx.scaExpSource
  // is that source-relative value. Warn when it matches nothing - a mis-typed path
  // would otherwise silently exclude nothing and flood the report with false
  // positives on the privileged Experiment code.
  const scaExpSource =
    mode === "sca"
      ? scaExpSourceRelative(opts.scaExpSource, scaSource, opts.scaRoot)
      : undefined;
  if (
    scaExpSource &&
    ![...addon.files.keys()].some(
      (f) => f === scaExpSource || f.startsWith(`${scaExpSource}/`)
    )
  ) {
    warn(
      `--sca-exp-source "${opts.scaExpSource}" matched no files under --sca-source; ` +
        "nothing will be excluded from the WebExtension code checks."
    );
  }

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
  // Experiments are reviewed from the XPI (its shipped-artifact role; xpiAddon ===
  // addon in XPI mode). They are privileged, non-bundled, readable code, and the
  // manifest's experiment paths resolve against the XPI's own files (no
  // source-layout mismatch). The classification is the XPI's, so it is stored on
  // BOTH the review addon (the experiment checks read ctx.experiments from it) and
  // xpiAddon itself (its bundled classification seeds the trusted experiment files);
  // in XPI mode the two are one addon.
  let invalidExperiment = false;
  if (isExp) {
    // The upstream-drafts allow-list fetch (network) - narrated, since it is one of
    // the slow pre-review steps; it stays silent+offline for a bare experiment_apis
    // declaration that bundles nothing.
    setupStep("Verifying bundled experiments");
    addon.experiments = xpiAddon.experiments = await verifyExperiments(
      xpiAddon,
      opts
    );
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

  // Resolve the review schema up front: the extraction pass (run per-review below) needs
  // the web_api / loader schema, and reviewAddon reviews against it. A rejected Experiment fetches
  // it too (reviewAddon still runs the reject check and reads schema.applicationVersion).
  const {
    zipPath: schemaZipPath,
    source: schemaSource,
    branch: schemaBranch,
    channel: schemaChannel,
  } = await resolveReviewSchema({
    cacheDir: opts.schemaCache ?? DEFAULT_CACHE,
    manifest: xpiAddon.manifest,
    setupStep,
  });
  const schemaFiles = loadSchemaFiles(schemaZipPath);
  applySchemaAnnotations(schemaFiles.files, loadSchemaAnnotations());
  const schema = buildSchemaIndex(schemaFiles);
  // A valid Experiment's declared APIs are part of its platform: register their base
  // namespaces so the developer's calls into them (e.g. browser.calendar.*) resolve
  // instead of tripping unknown-api. Registered from the XPI (in SCA the experiment
  // schema/scripts live in the built XPI, so the manifest's paths resolve there).
  if (!invalidExperiment && isExperiment(xpiAddon.manifest)) {
    schema.registerExperimentNamespaces(
      experimentApiNamespaces(xpiAddon.manifest, xpiAddon.files)
    );
  }

  // The known-library hash DB the bundled classifier matches files against. Stays
  // an empty Map for a rejected Experiment (the block below, which classifies, is
  // skipped) so nothing is ever recognized.
  let libraryHashes = new Map();
  // The parse-first review sources: classifyAndExtractReview runs the extraction pass
  // and returns them for reviewAddon to reuse. Stays undefined for a rejected Experiment
  // (which skips the classify block below), so buildRunContext parses there instead.
  let preParsedJsSources;

  if (!invalidExperiment) {
    // 1b. The known-library hash DB the classifier matches bytes against (fetched
    // and cached; a pre-seeded cache keeps offline runs deterministic). Both modes
    // classify.
    setupStep("Fetching library hashes");
    const { text: libraryHashesText } = await resolveLibraryHashes({
      cacheDir: opts.libraryHashesCache,
    });
    libraryHashes = parseLibraryHashes(libraryHashesText);

    // 1c. Resolve the dependency manifest ONCE (package.json deps + any VENDOR
    // declarations), so the review's checks share one immutable store.
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

    // The Mozilla add-on policy blocklist (curated assets/library-blocks.yaml): a
    // shipped asset read from disk (fast, no network, so no Setup feed line). Passed
    // to the vendor audit, which consults it before each OSV query (auditNpm) - a
    // banned library is recorded and skips the request. Not applied to SCA
    // devDependencies (never shipped).
    const { text: libraryBlocksText } = await resolveLibraryBlocks();
    const libraryBlocks = parseLibraryBlocks(libraryBlocksText);

    if (mode === "sca") {
      // SCA: the source archive's package.json declares the dependencies - audit each for
      // popularity (non-popular -> reject) and OSV. The readable source may ALSO vendor a
      // library as a committed copy, so full identification (Mozilla-hash + CDN + OSV,
      // deduped against the declared audit) runs on it below. An unrecognized minified file
      // the source vendors stays non-authored and is rejected.
      setupStep("Auditing source dependencies");
      await verifyScaDependencies(addon, opts.vendorNet, libraryBlocks);
      preParsedJsSources = classifyAndExtractReview(addon, {
        schema,
        libraryHashes,
        xpiAddon,
        setupStep,
      });
      // Identify + OSV-audit any third-party library VENDORED into the readable source (a
      // committed copy the Mozilla hash DB missed): a jsDelivr content-hash match plus OSV,
      // deduped against the declared-dependency audit above. Corrects the authored /
      // non-authored split the content checks and the source summary read.
      await identifyBundledLibraries(addon, {
        net: opts.vendorNet,
        cacheDir: opts.cdnLookupCache,
        cdnEnabled: opts.cdnLookup !== false,
        blocks: libraryBlocks,
        setupStep,
        scope: "source",
      });
      // Classify the BUILT XPI too (the review target above is the readable source).
      // The packaging summary + the input:xpi checks read the shipped XPI, and their skip
      // set is this classification's non-authored set - so the XPI's minified/library
      // bundles are excluded exactly as in an XPI review (where the XPI IS the review
      // target). Sync
      // and cheap: the multi-MB minified bundles are byte-tagged, never parsed. The
      // XPI already carries its own experiments (set at verifyExperiments above), so its
      // trusted upstream experiment files seed the non-authored set here too.
      setupStep("Classifying the built add-on");
      xpiAddon.bundled = classifyBundled(xpiAddon, { libraryHashes });
      // Second-tier identification for the shipped XPI too: a readable/minified library the
      // Mozilla DB missed, matched on jsDelivr, so the XPI's non-authored set (read by the
      // input:xpi checks) is correct. No OSV audit here - the XPI carries no vendor store,
      // and an undeclared library the BUILD bundled is the build review's concern.
      setupStep("Identifying built-add-on libraries on a CDN");
      await resolveCdnLibraries(xpiAddon, {
        net: opts.vendorNet,
        cacheDir: opts.cdnLookupCache,
        enabled: opts.cdnLookup !== false,
      });
      // The BUILD files (archive minus the review source + Experiment source) - the
      // build scripts/config the review otherwise drops. buildScaBuildCtx wraps these
      // as the `input: build` check's ctx.addon; they never merge into the review addon.
      addon.buildFiles = loadScaBuildFiles(
        scaArchive,
        scaSource,
        opts.scaRoot,
        opts.scaExpSource
      );
      // Classify the build ONCE here (the vendor pattern): one model request over the
      // build corpus, stored on addon.buildFiles.buildReview for the input:build checks to
      // read deterministically. Offline / no token -> analyzed:false (routed to manual review).
      setupStep("Analyzing the build");
      addon.buildFiles.buildReview = await analyzeBuild({
        build: addon.buildFiles,
        analysisPrompt: registry.prompt("build-analysis"),
        enabled: opts.llmEnabled,
        token: opts.llmApiKey,
        model: opts.llmModel,
        url: opts.llmApiUrl,
        type: opts.llmApiType,
        budget: llmBudget,
      });
    } else {
      // XPI: the full vendored-library pipeline.
      // 1d. Verify the resolved declarations over the network ONCE - fetch,
      // compare (EOL-tolerant), popularity, and the package.json<->file matching.
      // An offline transport (the golden harness) makes no request. The LLM params
      // drive the github->npm resolution fallback; the run-wide budget is shared.
      setupStep("Verifying vendored libraries");
      await verifyVendor(
        addon,
        opts.vendorNet,
        {
          enabled: opts.llmEnabled,
          resolvePrompt: registry.prompt("vendor-npm-resolve"),
          token: opts.llmApiKey,
          model: opts.llmModel,
          url: opts.llmApiUrl,
          type: opts.llmApiType,
          budget: llmBudget,
        },
        libraryBlocks
      );

      // 1e. Classify the bundled (undeclared third-party) JS per file (library hash,
      // minified geometry, obfuscation), then the extraction pass (content scanners
      // over the authored remainder), then assemble addon.bundled. Runs after
      // verifyVendor so the vendored skip set is final, and before cdn-lookup, which
      // reads the final tag.obfuscated.
      preParsedJsSources = classifyAndExtractReview(addon, {
        schema,
        libraryHashes,
        xpiAddon,
        setupStep,
      });

      // 1e-half..1f. Reconcile the not-popular declared libraries, then CDN-identify and
      // OSV-audit the undeclared bundles (Mozilla-hash + jsDelivr matches), so an undeclared
      // vulnerable/not-popular library is caught like a declared dependency. See
      // identifyBundledLibraries.
      await identifyBundledLibraries(addon, {
        net: opts.vendorNet,
        cacheDir: opts.cdnLookupCache,
        cdnEnabled: opts.cdnLookup !== false,
        blocks: libraryBlocks,
        setupStep,
      });
    }
  }

  // 2. Schema review. reviewAddon also generates the advisory AI summaries at
  // the tail of the activity feed (the add-on summary's recheck verdicts feed the
  // post-summary recheck consumers, which run there too), so they come back here.
  const result = await reviewAddon(addon, opts, registry, invalidExperiment, {
    budget: llmBudget,
    setupStep,
    libraryHashes,
    mode,
    xpiAddon,
    scaExpSource,
    schema,
    schemaSource,
    schemaBranch,
    schemaChannel,
    preParsedJsSources,
  });
  findings.push(...result.findings);
  Object.assign(meta, result.meta);
  const { summarize, summarizeAddon } = result;

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
    meta.reviewUrl = await resolveReviewUrl({ manifest: xpiAddon.manifest });
  }

  // Fill each finding's display message from its registry response (with the
  // {{item}} placeholder), so the Issues section reports the ready-to-send
  // wording. The registry is the only source of this text.
  renderFindings(findings, registry);

  return {
    findings,
    meta,
    // The review mode + the per-ruleId input artifact, so the text report can label
    // each finding's file:line by artifact ([XPI]/[SCA]) in an SCA review (a no-op in
    // XPI mode). See src/report/artifact.js.
    mode,
    ruleInputs: registry.checkInputs(),
    // Severity-group headings + the verdict preamble for the text Issues
    // section.
    issueHeadings: registry.issueHeadings(),
    verdictIntros: registry.verdictIntros(),
    // AI summaries generated above (each undefined unless its flag + a token
    // warrant it). The caller prints the prose after the report - see
    // src/cli.js.
    summarize,
    summarizeAddon,
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
  progress(
    `LLM: Generating ${label} (${humanSize(deferred.bytes)}) ...`,
    FEED.STEP
  );
  try {
    return { bytes: deferred.bytes, text: await deferred.run() };
  } catch (err) {
    // An advisory summary must never abort the review. Report the failure at
    // this step (visible without --verbose) and carry the reason to the report.
    const reason = llmErrorText(err);
    progress(red(`LLM: ${label} failed - ${reason}`), FEED.STEP);
    return { bytes: deferred.bytes, text: null, error: reason };
  }
}

/** The recheck verdicts from a summary pass that belong to `allowed` consumers. */
const keepVerdicts = (verdicts, allowed) =>
  (verdicts ?? []).filter((v) => v && allowed.has(v.check));

/**
 * Generate one --full-summary add-on review pass over a chosen corpus and return its
 * prose plus its recheck verdicts (the caller merges the verdicts onto
 * ctx.recheckVerdicts for the post-summary consumers). In SCA the pipeline runs two
 * passes - a behavioral one over the source and a packaging one over the built XPI - each
 * carrying only its corpus's recheck consumers (opts.consumers) and its own framing
 * (opts.promptId). Undefined when there is nothing to summarize (no token / no prompt /
 * budget spent); `{ text: null, error }` on an LLM failure; otherwise `{ bytes, text,
 * verdicts }` where a defined `verdicts` (possibly empty) means the model returned a
 * review - the clean signal that analysis happened.
 * @param {import("./checks/registry.js").RunContext} ctx
 * @param {import("./checks/registry.js").Registry} registry
 * @param {import("./llm/budget.js").LlmBudget} [budget]  Run-wide request cap.
 * @param {{unused?: Set<string>, summaryAddon?: object, promptId?: string,
 *   consumers?: ?Set<string>, label?: string}} [opts]
 * @returns {Promise<(GeneratedSummary & {verdicts?: object[]})|undefined>}
 */
async function generateAddonSummary(ctx, registry, budget, opts = {}) {
  const { label = "full", ...summarizerOpts } = opts;
  const deferred = buildAddonSummarizer(ctx, registry, summarizerOpts);
  if (!deferred) {
    return undefined;
  }
  if (budget && !(await budget.consume())) {
    return undefined; // run-wide request cap reached
  }
  progress(
    `LLM: Generating ${label} summary (${humanSize(deferred.bytes)}) ...`,
    FEED.STEP
  );
  let review;
  try {
    review = await deferred.run();
  } catch (err) {
    const reason = llmErrorText(err);
    progress(red(`LLM: ${label} summary failed - ${reason}`), FEED.STEP);
    return { bytes: deferred.bytes, text: null, error: reason };
  }
  return {
    bytes: deferred.bytes,
    text: review?.summary ?? null,
    verdicts: review?.recheck,
  };
}

/**
 * Per-file classification (classifyFiles) -> the single extraction pass -> assemble the
 * final addon.bundled, and return the parsed sources for buildRunContext to reuse. The
 * classification precedes both the extraction pass and cdn-lookup (which reads
 * tag.obfuscated), so obfuscated files are already in the non-authored skip set the pass
 * and consumers read.
 * @param {import("./addon/load.js").Addon} addon
 * @param {{schema: object,
 *   libraryHashes: Map<string, {name: string, version: string}>,
 *   xpiAddon: import("./addon/load.js").Addon,
 *   setupStep: (label: string) => void}} ctx
 * @returns {import("./addon/sources.js").JsSource[]}  The parsed review sources.
 */
function classifyAndExtractReview(
  addon,
  { schema, libraryHashes, xpiAddon, setupStep }
) {
  const classification = classifyFiles(addon, { libraryHashes });
  const jsSources = collectJsSources(addon);
  const experimentNamespaces = isExperiment(xpiAddon.manifest)
    ? experimentApiNamespaces(xpiAddon.manifest, addon.files)
    : null;
  setupStep("Parsing add-on sources");
  runExtractionPass(jsSources, {
    schema,
    nonAuthored: classification.nonAuthored,
    invalidExperiment: false,
    experimentNamespaces,
  });
  addon.bundled = assembleBundled(classification);
  return jsSources;
}

/**
 * Second-tier library identification over an already-classified add-on: reconcile the
 * not-popular declared (VENDOR/package) results into the untrusted family, match still-
 * unrecognized bundles against jsDelivr by content hash, then OSV-audit every identified
 * (undeclared) library - both Mozilla-hash and CDN matches. Reads/writes addon.bundled and
 * addon.vendor; every step is best-effort and skips silently offline. Runs AFTER
 * classification (so the Mozilla-hash matches and tag.obfuscated are final) and after the
 * declared-dependency audit (so auditIdentifiedLibraries dedups against it). Requires
 * addon.vendor for the OSV audit; the shipped XPI in SCA has none, so it gets only the CDN
 * pass (resolveCdnLibraries directly), not this routine.
 * @param {import("./addon/load.js").Addon} addon
 * @param {{net?: object, cacheDir?: string, cdnEnabled?: boolean,
 *   blocks?: Map<string, object>, setupStep?: (label: string) => void,
 *   scope?: string}} opts  `scope` names the artifact in the narration (default "bundled").
 */
async function identifyBundledLibraries(
  addon,
  {
    net,
    cacheDir,
    cdnEnabled = true,
    blocks,
    setupStep = () => {},
    scope = "bundled",
  }
) {
  applyNotPopularVendor(addon);
  setupStep(`Identifying ${scope} libraries on a CDN`);
  await resolveCdnLibraries(addon, { net, cacheDir, enabled: cdnEnabled });
  setupStep(`Auditing ${scope} libraries`);
  await auditIdentifiedLibraries(addon, net, blocks);
}

/**
 * The schema-review half of the pipeline, operating on an already-loaded add-on.
 *
 * @param {import("./addon/load.js").Addon} addon
 * @param {PipelineOpts} opts
 * @param {import("./checks/registry.js").Registry} registry
 * @param {boolean} [invalidExperiment]  Reject-only mode: run just the
 *   experiment-not-allowed check, with no LLM, summaries, or manual reminders.
 * @param {object} resolved  The review inputs runPipeline resolved up front, grouped
 *   to keep this signature small:
 * @param {import("../llm/budget.js").LlmBudget} [resolved.budget]
 * @param {(label: string) => void} [resolved.setupStep]  Emits the next numbered
 *   "Setup" feed line; runPipeline owns the section's running count.
 * @param {Map<string, {name: string, version: string}>} [resolved.libraryHashes]  The
 *   known-library hash DB runPipeline resolved, carried onto ctx.options so the lazy
 *   getBundled path matches the pre-step's classification (real runs use the memoized
 *   addon.bundled, so this is only the no-pre-step fallback).
 * @param {"xpi"|"sca"} [resolved.mode]
 * @param {import("./addon/load.js").Addon} [resolved.xpiAddon]  The built XPI (the
 *   shipped artifact); === addon in XPI mode.
 * @param {string} [resolved.scaExpSource]  SCA Experiment folder (source-relative).
 * @param {import("./schema/index.js").SchemaIndex} [resolved.schema]
 * @param {string} [resolved.schemaSource]
 * @param {string} [resolved.schemaBranch]
 * @param {string} [resolved.schemaChannel]  The auto-detected schema channel.
 * @param {import("./addon/sources.js").JsSource[]} [resolved.preParsedJsSources]  The
 *   review sources the extraction pass already parsed (parse-first); absent for a
 *   rejected Experiment, where buildRunContext parses.
 * @returns {Promise<{findings: Finding[], meta: ReviewMeta,
 *   ctx: import("./checks/registry.js").RunContext}>}
 */
async function reviewAddon(addon, opts, registry, invalidExperiment, resolved) {
  const {
    budget,
    setupStep = () => {},
    libraryHashes = new Map(),
    mode = "xpi",
    xpiAddon = addon,
    scaExpSource,
    schema,
    schemaSource,
    schemaBranch,
    schemaChannel,
    preParsedJsSources,
  } = resolved;
  const {
    checksOnly,
    checksSkip,
    eslint,
    llmEnabled,
    llmApiKey,
    llmApiUrl,
    llmApiType,
    allowExperiments,
    diffTo,
    fullSummary,
    diffSummary,
  } = opts;

  // schema + schemaSource (and the Experiment-namespace registration) are resolved by
  // runPipeline up front, because the extraction pass (run there per-review) needs the
  // schema. For a reviewed
  // addon runPipeline already ran the pass and passes its parsed sources in as
  // preParsedJsSources (reused below); a rejected Experiment has no pre-step, so
  // buildRunContext parses here (narrated).
  if (!preParsedJsSources) {
    setupStep("Parsing add-on sources");
  }
  // The checks layer assembles its own context (sources, API usage, diff
  // baseline, LLM client) - the pipeline only resolves the schema.
  const ctx = buildRunContext({
    addon,
    // The built XPI - authoritative for the manifest (ctx.manifest). xpiAddon === addon
    // in XPI mode; in SCA it is the shipped artifact while addon is the readable source.
    xpiAddon,
    schema,
    options: {
      llmEnabled,
      llmApiKey,
      llmApiUrl,
      llmApiType,
      allowExperiments,
      libraryHashes,
    },
    diffTo,
    llmModel: opts.llmModel,
    systemIntro: registry.prompt("system-intro"),
    invalidExperiment,
    mode,
    // SCA: the Experiment folder as a source-relative path (runPipeline re-based it
    // from the scaRoot-relative --sca-exp-source flag), excluded from the WebExtension
    // code checks. Undefined in XPI mode.
    scaExpSource,
    budget,
    // runPipeline parsed the review sources up front (parse-first) and passed them in;
    // reuse them here. Absent for a rejected Experiment, where buildRunContext parses.
    preParsedJsSources,
  });

  // The orchestrator holds the review-target `ctx` plus its sibling contexts (below,
  // gathered into `siblings`): shippedCtx (the built XPI - the `input: xpi` checks
  // resolve declared paths against it, the diff + packaging summaries describe it),
  // buildCtx (the SCA build files), and manifestCtx (the shipped manifest, no file
  // corpus). Each check is routed to exactly one by its `input` (see routeCtx); a check
  // cannot derive one from another, so it only ever sees the artifact it was routed to.
  // In an XPI review shippedCtx IS ctx (buildShippedCtx returns it unchanged when the
  // XPI is the review target).
  const shippedCtx = buildShippedCtx(ctx, xpiAddon);
  // SCA: a sibling context whose addon is the build files (the archive minus the
  // review source minus node_modules), so the `input: build` check
  // (undeclared-build-source) reads them off ctx.addon via the same one-place
  // `input` routing - no separate ctx field. Always a build context in SCA mode - an
  // empty one when an invalid Experiment's reject-only profile skipped loading the
  // files - so an `input: build` check reads a build artifact (never the review
  // source) and cleanly skips on empty. Undefined in XPI mode, where no such check runs.
  const buildCtx =
    mode === "sca"
      ? buildScaBuildCtx(ctx, addon.buildFiles ?? { files: new Map() })
      : undefined;
  // A sibling context with NO file corpus (empty ctx.addon.files), for `input: manifest`
  // checks - they read only the shipped manifest (on ctx.manifest), so there is no
  // artifact's files for them to reach. Both modes (the manifest exists in each).
  const manifestCtx = buildManifestCtx(ctx);
  // The sibling ctxs keyed by the `input` value that routes to each (see routeCtx). A
  // check's `input` selects its ctx; anything else runs over the review-target ctx.
  const siblings = { xpi: shippedCtx, build: buildCtx, manifest: manifestCtx };

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
  // re-judged with whole-add-on context (runChecks diverts them - except any a
  // producer marked manual-only; the summary judges them; the consumer resolves
  // them - see src/checks/lib/recheck.js).
  // Without the summary this is false, so those items go straight to manual review.
  ctx.recheckActive = !invalidExperiment && fullSummary && Boolean(ctx.llm);
  progress(""); // close the Setup section before runChecks prints "── Activity ──"
  const { findings, checks, manualItems, deferred, total } = await runChecks(
    ctx,
    registry,
    { only: checksOnly, skip: baseSkip },
    siblings
  );

  // Advisory AI summaries, generated at the tail of the activity feed (a
  // `LLM: Generating ...` line shows what is being waited on). The prose is
  // printed after the report by the caller (src/cli.js). The add-on summary runs
  // first to match that display order, and because it re-judges the recheck items
  // handed to it (ctx.recheck) - merging the verdicts onto ctx.recheckVerdicts for
  // the post-summary recheck consumers below. It excludes files the review found
  // unreachable - that set is a product of reachability (unused-files), so it
  // exists only now, which is why the summary runs after the checks.
  let summarizeAddon;
  if (!invalidExperiment && fullSummary) {
    // unused-files runs over the built XPI (input: xpi), so its paths are the XPI's.
    const unusedFiles = new Set(
      findings.filter((f) => f.ruleId === "unused-files").map((f) => f.file)
    );
    if (mode === "sca") {
      // SCA: one summary per corpus. The behavioral pass over the readable SOURCE is the
      // displayed "Summary of add-on" and re-judges the source-anchored rechecks; the
      // packaging pass over the built XPI is recheck-only (its prose is discarded). Each
      // pass carries only its corpus's consumers, and its verdicts are filtered to those
      // consumers before they merge, so neither can resolve the other's items. The source
      // pass excludes no `unused` files - those XPI paths do not apply to the source corpus.
      const { source, xpi } = registry.recheckConsumersByCorpus();
      summarizeAddon = await generateAddonSummary(ctx, registry, budget, {
        summaryAddon: ctx.addon,
        consumers: source,
        label: "source",
      });
      const verdicts = [];
      let ran = false;
      if (summarizeAddon && !summarizeAddon.error) {
        ran = true;
        verdicts.push(...keepVerdicts(summarizeAddon.verdicts, source));
      }
      // The packaging pass runs only when an XPI-anchored recheck actually escalated -
      // otherwise it has nothing to judge over the (often near-empty) built corpus.
      const hasXpiItems = [...(ctx.recheck ?? new Map()).keys()].some((id) =>
        xpi.has(id)
      );
      if (hasXpiItems) {
        const packaging = await generateAddonSummary(ctx, registry, budget, {
          unused: unusedFiles,
          summaryAddon: shippedCtx.addon,
          consumers: xpi,
          promptId: "shipped-package-summary",
          label: "packaging",
        });
        if (packaging && !packaging.error) {
          ran = true;
          verdicts.push(...keepVerdicts(packaging.verdicts, xpi));
        }
      }
      if (ran) {
        ctx.recheckVerdicts = verdicts;
      }
    } else {
      // XPI review: one all-in-one summary over the single artifact (the review target),
      // carrying every recheck consumer.
      summarizeAddon = await generateAddonSummary(ctx, registry, budget, {
        unused: unusedFiles,
        summaryAddon: ctx.addon,
      });
      if (summarizeAddon && !summarizeAddon.error) {
        ctx.recheckVerdicts = summarizeAddon.verdicts;
      }
    }
  }
  let summarize;
  if (!invalidExperiment && diffSummary) {
    summarize = await generateSummary(
      buildSummarizer(ctx, registry, shippedCtx),
      "diff summary",
      budget
    );
  }

  // The post-summary checks (phase: post-summary, incl. the recheck consumers),
  // run now that the add-on summary has populated ctx.recheckVerdicts, through the
  // identical per-check path as the loop - runOneCheck stamps id/severity and
  // routes escalations to manual review. They honor --checks/--skip (already
  // applied by loadChecks). Numbering continues from the main loop so the feed
  // reads [1/total] .. [total/total]. This list is empty for an invalid Experiment.
  const ran = [...checks];
  for (const [j, check] of deferred.entries()) {
    // Route via the SAME helper as the main loop (registry.routeCtx), so the two can
    // never drift. The post-summary rechecks declare no `input`, so they run on the main
    // ctx (where ctx.recheck lives) and are labelled by their producer's corpus.
    const checkCtx = routeCtx(check, ctx, siblings);
    const out = await runOneCheck(
      checkCtx,
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

  return {
    findings,
    // The built run context is returned for any post-review use by the caller.
    ctx,
    // The advisory summaries, generated above (each undefined unless its flag +
    // a token warrant it). The caller prints their prose after the report.
    summarize,
    summarizeAddon,
    meta: {
      schemaSource,
      schemaBranch,
      schemaChannel,
      applicationVersion: schema.applicationVersion,
      manifestVersion: xpiAddon.manifest?.manifest_version ?? null,
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
 * The Thunderbird major a cached branch targets (its applicationVersion stamp), or
 * null when the zip is missing, unreadable, corrupt, or carries no parseable stamp
 * - a null excludes the channel from the candidates, which resolveReviewSchema
 * reads as a corrupt/incomplete cache and self-heals. Never throws.
 * @param {string} cacheDir @param {string} branch
 * @returns {number|null}
 */
export function peekBranchMajor(cacheDir, branch) {
  try {
    return (
      parseVersion(
        peekApplicationVersion(cachedZipPath(cacheDir, branch))
      )?.[0] ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Resolve which schema to review against, downloading if needed. The channel is
 * auto-detected from the add-on's version range (see selectSchemaChannel): the
 * cache is first brought to the full canonical set (all channels × both manifest
 * versions, re-downloading a missing OR corrupt branch), then the add-on's
 * manifest_version + strict_max_version pick the branch to load.
 *
 * @param {object} params
 * @param {string} params.cacheDir      Schema cache directory.
 * @param {import("./addon/load.js").Manifest} params.manifest  Shipped manifest.
 * @param {(label: string) => void} [params.setupStep]  Setup-feed narrator.
 * @returns {Promise<{zipPath: string, source: string, branch: string, channel: string}>}
 */
export async function resolveReviewSchema({
  cacheDir,
  manifest,
  setupStep = () => {},
}) {
  const mv = detectManifestVersion(manifest);
  // The detected manifest version's channel anchors. A channel is a candidate only
  // if its cached zip is present AND carries a readable version stamp - a
  // present-but-corrupt zip yields null (peekBranchMajor) and counts as absent, so
  // it triggers a re-download below instead of being silently selected around.
  const readAnchors = () =>
    SCHEMA_CHANNELS.map((channel) => {
      const branch = branchName(channel, mv.version);
      return { channel, branch, major: peekBranchMajor(cacheDir, branch) };
    }).filter((c) => c.major != null);

  // Schema resolution is ONE numbered setup step (the counter is pre-sized), so
  // fire setupStep exactly once on every path. The cache must be COMPLETE and
  // READABLE: a missing branch or a corrupt anchor (fewer readable candidates than
  // channels) re-downloads all six together so they share one train - the slow,
  // narrated step. Refreshing on corruption self-heals rather than silently
  // reviewing against the wrong channel. With the cache already complete and
  // readable, the step is nominal and names the chosen branch.
  let stepped = false;
  let candidates = readAnchors();
  if (
    !hasAllCachedSchemas(cacheDir) ||
    candidates.length < SCHEMA_CHANNELS.length
  ) {
    setupStep("Fetching review schemas (all channels)");
    stepped = true;
    await refreshAllSchemas({ cacheDir });
    candidates = readAnchors();
  }

  // Still short after a full re-download means the schema set itself is unusable -
  // fail loudly rather than review against a wrong or partial schema.
  if (candidates.length < SCHEMA_CHANNELS.length) {
    const bad = SCHEMA_CHANNELS.filter(
      (c) => !candidates.some((x) => x.channel === c)
    ).map((c) => branchName(c, mv.version));
    throw new Error(
      `Schema cache unusable: no readable version stamp for ${bad.join(", ")} even after refresh. ` +
        "Re-run with --cache-clear (and check network access to the schema source)."
    );
  }

  const { channel, branch, reason } = selectSchemaChannel({
    candidates,
    strictMax: strictMaxVersion(manifest),
  });
  debug(
    `manifest_version ${mv.detected ? mv.version : `? (defaulting to ${mv.version})`}; ${reason}` +
      ` → schema branch "${branch}".`
  );
  if (!stepped) {
    setupStep(`Fetching review schemas (${branch})`);
  }
  const { zipPath, source } = await resolveSchemaZip({ branch, cacheDir });
  return { zipPath, source, branch, channel };
}

/**
 * Pick the schema channel for an add-on from its supported version range. Driven
 * by the UPPER bound (strict_max_version): an add-on capped at a channel's own
 * major targets that train, so its schema (with the backported version_added
 * entries for that train) is authoritative. With no exact-major match - a gap, a
 * range below/above every cached train, or no cap at all - fall back to release
 * (the version_added checks still flag genuinely unsupported APIs). Never rejects
 * on version grounds. `candidates` are in channel priority (release > esr > beta),
 * so an exact-major tie resolves to the earlier (more stable) channel.
 *
 * @param {object} params
 * @param {{channel: string, branch: string, major: number}[]} params.candidates
 * @param {string|null|undefined} params.strictMax  The add-on's strict_max_version.
 * @returns {{channel: string, branch: string, reason: string}}
 */
export function selectSchemaChannel({ candidates, strictMax }) {
  if (candidates.length === 0) {
    throw new Error("No schema candidates available to choose from.");
  }
  const cap = parseVersion(strictMax)?.[0] ?? null;
  if (cap != null) {
    const hit = candidates.find((c) => c.major === cap);
    if (hit) {
      return {
        channel: hit.channel,
        branch: hit.branch,
        reason: `strict_max ${strictMax} targets the ${hit.channel} train (Thunderbird ${hit.major})`,
      };
    }
  }
  // Default: release if present, else the newest-major candidate available.
  const def =
    candidates.find((c) => c.channel === "release") ??
    candidates.reduce((a, b) => (b.major > a.major ? b : a));
  const why =
    cap == null
      ? "no strict_max cap"
      : `strict_max ${strictMax} matches no cached train`;
  return {
    channel: def.channel,
    branch: def.branch,
    reason: `${why} → ${def.channel} (Thunderbird ${def.major})`,
  };
}

/**
 * Detect the manifest_version from the add-on manifest. A missing or invalid
 * manifest_version defaults to 2 (an add-on that omits it is Manifest V2).
 *
 * @param {object|null|undefined} manifest
 * @returns {{version: number, detected: boolean}}
 */
export function detectManifestVersion(manifest) {
  const v = manifest?.manifest_version;
  if (v === 2 || v === 3) {
    return { version: v, detected: true };
  }
  return { version: 2, detected: false };
}
