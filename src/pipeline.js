// The review pipeline: opts in, a structured Review out. This is the tool's
// core, independent of the CLI front-end (cli.js) - the test harness drives it
// directly. It loads the add-on, resolves and verifies its vendored
// declarations, classifies bundled code, runs the schema review, and fills each
// finding's display text from the registry. It returns the Review. Formatting
// and I/O are the front-end's job. The tool is read-only: it never modifies or
// repacks the submission.
//
// Belongs here: the stage orchestration (runPipeline) and the
// pipeline-level schema-selection helpers (resolveReviewSchema,
// selectSchemaChannel, detectManifestVersion).
//
// Does NOT belong here: the cache defaults and behavior toggles -
// src/config.js. The schema channel set + branch names - src/schema/fetch.js.
// Argv parse, validation, and printing (src/cli.js and
// src/report/format.js); each stage's own work - add-on load
// (src/addon/load.js), vendor resolution/verification (src/vendor/*), schema
// fetch/load/index (src/schema/*), check orchestration and run context
// (src/checks/registry.js and src/checks/context.js), and all user-facing text
// (src/checks/registry.js plus src/report/responses.js).

import fs from "node:fs";
import path from "node:path";
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
import { REVIEW_MODE } from "./lib/enum.js";
import {
  loadSchemaAnnotations,
  applySchemaAnnotations,
} from "./schema/annotate.js";
import {
  loadAddon,
  loadScaAddon,
  selectScaBuildFiles,
  scaRootRelative,
  relativeInside,
} from "./addon/load.js";
import { isTranspiledSource } from "./util/files.js";
import { runChecks, loadRegistry } from "./checks/registry.js";
import { analyzeBuild } from "./build/analyze.js";
import { buildXpiCtxs, buildScaCtxs } from "./checks/context.js";
import {
  renderFindings,
  renderManualItems,
  withDefaultNotes,
} from "./report/responses.js";
import {
  headerLines,
  llmPromptLines,
  promptAsks,
  summaryLines,
} from "./report/format.js";
import { resolveHolds } from "./report/finding.js";
import { locusLabeler } from "./report/format.js";
import { readVerdicts, applyVerdicts } from "./report/verdicts.js";
import { reviewItems, reviewFilePaths } from "./report/items.js";
import { resolveVendor } from "./vendor/resolve.js";
import {
  verifyVendor,
  verifyVendorDeclarations,
  verifyScaDependencies,
  auditIdentifiedLibraries,
} from "./vendor/verify.js";
import {
  classifyFiles,
  assembleBundled,
  applyUnverifiedVendor,
  hasUnreviewableCode,
} from "./lib/bundled.js";
import { untwinnedShippedJs } from "./lib/source-twins.js";
import { collectJsSources } from "./addon/sources.js";
import { runExtractionPass } from "./checks/extract.js";
import { resolveCdnLibraries } from "./lib/cdn-lookup.js";
import {
  resolveLibraryHashes,
  parseLibraryHashes,
} from "./lib/library-hashes.js";
import {
  resolveLibraryBlocks,
  parseLibraryBlocks,
} from "./lib/library-blocks.js";
import { isExperiment, parseVersion, strictMaxVersion } from "./lib/util.js";
import { experimentApiNamespaces } from "./lib/experiments.js";
import { verifyExperiments } from "./experiments/verify.js";
import { debug, progress, report, warn, FEED } from "./util/log.js";
import { DEFAULT_CACHE } from "./config.js";

/** @typedef {import("./report/finding.js").Finding} Finding */
/** @typedef {import("./report/format.js").ReviewMeta} ReviewMeta */

/**
 * Every path opt is ABSOLUTE. The arg-array reader resolves them (pipelineOptsFromValues,
 * src/cli.js), which is the one layer that knows what each flag was written relative to -
 * the working directory for --sca-root, and --sca-root itself for the two naming a folder
 * inside it. Nothing here re-resolves one, and a caller handing in a relative path gets
 * whatever the working directory makes of it.
 * @typedef {object} PipelineOpts
 * @property {string} addonPath  The shipped add-on, absolute.
 * @property {string} [schemaCache]
 * @property {string} [experimentsCache]  Where to cache the fetched experiments
 *   zip.
 * @property {string[]} [checksOnly]
 * @property {string[]} [checksSkip]
 * @property {boolean} [eslint]  Run the opt-in ESLint code-sanity check (off by
 *   default); when unset, the code-sanity check is skipped entirely.
 * @property {boolean} [allowExperiments]
 * @property {string} [scaRoot]  SCA mode: the source archive root, absolute - an extracted
 *   folder holding package.json/lock. Setting it switches the
 *   review to SCA mode - the readable source (scaSource) is reviewed and its declared
 *   dependencies are audited; the positional XPI is the shipped artifact against which
 *   the manifest, experiments and file-completeness (`input: xpi`) checks all run (a
 *   separate shipped context the orchestrator routes them to - see buildXpiCtxs in
 *   src/checks/context.js).
 * @property {string} [scaSource]  The add-on code root, absolute and inside scaRoot
 *   (--sca-source names it relative to the root). Optional; defaults to scaRoot itself -
 *   a flat layout with manifest.json at the root.
 * @property {string} [scaExpSource]  SCA mode: the Experiment implementation folder,
 *   absolute and inside scaRoot, which is not necessarily inside scaSource. It reaches a
 *   check AS GIVEN (ctx.scaExpSource, beside ctx.scaSource); where it sits WITHIN the review
 *   source is derived at the one read that wants it (src/lib/reachability.js), in the
 *   keyspace the review addon's keys live in. Its privileged, non-WebExtension files are excluded
 *   from the WebExtension code checks (which review all of the readable source, having no
 *   reachability tree there). Optional in general, but REQUIRED when allowExperiments is
 *   set in SCA mode (the CLI enforces this) - without it, Experiment code cannot be told
 *   apart from WebExtension code.
 * @property {string} [libraryHashesCache]  Where to cache the fetched hashes.
 * @property {boolean} [cdnLookup]  Identify an unrecognized bundled library (minified,
 *   or a large readable file) by a jsDelivr content-hash lookup (on by default;
 *   --cdn-lib-lookup false disables). Set false to skip the per-file CDN request
 *   (offline/privacy).
 * @property {string} [cdnLookupCache]  Where to cache the CDN hash-lookup results.
 * @property {import("./vendor/verify.js").VendorNet} [vendorNet]  Injectable
 *   network transport for vendor verification (the test harness injects an
 *   offline one); defaults to the real fetch.
 * @property {import("./addon/load.js").Addon} [addon]  Pre-loaded add-on (the
 *   test harness injects one to drop its expected.json sidecar).
 * @property {import("./checks/registry.js").Registry} [registry]  Parsed
 *   registry threaded from the caller, parsed once here otherwise.
 * @property {string} [llmVerdict]  Path to a verdict file (--llm-verdict) settling the
 *   questions this review asks: findings withdrawn, to-do items reported or cleared.
 *   A reported case is worded by its own check; the only wording an answer brings is what
 *   a reviewer typed instead of picking one, which travels on that case's location line.
 * @property {boolean} [llmReview]  Print the verification prompt above the review header,
 *   addressing the report to a model that is asked to check it, and write the review to an
 *   item file instead of printing it. Changes nothing about the review itself, only what
 *   is printed before it and what the item file carries.
 * @property {string[]} [llmSkip]  What that prompt leaves out (PROMPT_SKIPS, src/config.js):
 *   "summary" (--llm-skip-summary) drops the add-on description and the file named for it;
 *   "manual" (--llm-skip-manual) drops the steps that put the manual items to a reviewer,
 *   and those items leave the item file with them - they stay in the report, for the
 *   reviewer to work through later.
 */

/**
 * @typedef {object} PipelineResult
 * @property {Finding[]} findings
 * @property {ReviewMeta} meta
 * @property {Record<string, string>} [issueHeadings]
 * @property {Record<string, string>} [verdictIntros]
 */

/**
 * Run the review pipeline and return the structured result.
 *
 * @param {PipelineOpts} opts
 * @returns {Promise<PipelineResult>}
 */
export async function runPipeline(opts) {
  const { addonPath } = opts;
  // `addonPath` IS the shipped add-on's path, absolute, and the single value the run has
  // for "which add-on": what the report names, what a verdict file is checked against, and
  // where the description file goes. An Addon carries no path of its own
  // (src/addon/load.js), and nothing here resolves one - the arg-array reader did.
  // SCA (source code archive) mode is on when --sca-root is set (--sca-source is
  // optional, defaulting to "."). It splits the review across TWO add-on artifacts
  // with a fixed ROLE each, resolved here ONCE so nothing downstream re-branches on the mode:
  //
  //   xpiAddon - the built XPI (the positional addonPath). The SHIPPED artifact,
  //     authoritative in BOTH modes for the manifest, the experiments, and the
  //     behavioral review summary (what actually runs on a user's machine).
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
  // case (scaRootRelative resolves "." and "./" alike to "")
  // is handled throughout: loadScaAddon reviews every file, and selectScaBuildFiles still
  // traces the build off the root package.json (there is no source subtree to exclude).
  // --sca-root alone switches to SCA mode; --sca-source is optional and defaults to "."
  // (the whole root reviewed as the source - the common flat-layout case).
  //
  // `preliminaryMode` sizes the Setup feed only (the counter is fixed before the first
  // step). The EFFECTIVE mode is set below and differs only for a REJECTED Experiment, which
  // stays an XPI review even with --sca-root. Everything mode-dependent (the source load,
  // scaSource, the Experiment exclude prefix, meta) is then DERIVED from it, so nothing is
  // mutated afterward.
  const preliminaryMode = opts.scaRoot ? "sca" : "xpi";
  // The parsed registry, threaded from main() (or loaded once here when a caller
  // such as the test harness invokes the pipeline directly).
  const registry = opts.registry ?? loadRegistry();

  // 1. Load the .xpi archive (a fast in-memory unzip). Read before the "Setup" banner
  // because it sizes the feed - it gives the mode and whether the add-on is an
  // Experiment. Every slow NETWORK step below (the experiment fetch, schema fetch, vendor
  // verification, CDN lookups) plus the AST parse is narrated as a Setup step. The add-on
  // reads are fast local unzips (this .xpi, and in a kept SCA the source archive loaded in
  // Phase 2) marked by the "Reading add-on" step. A caller may inject a pre-loaded XPI
  // add-on (the test harness does, to drop its expected.json).
  const xpiAddon = opts.addon ?? loadAddon(addonPath);
  const isExp = isExperiment(xpiAddon.manifest);

  // The "Setup" feed: one numbered [i/total] line per slow pre-review step, matching
  // the Activity check loop, so the otherwise-silent pre-review pause shows what is
  // running (a no-op when progress is off - JSON, the golden harness). The total is
  // sized from what the fast .xpi read already gives us: mode (SCA analyses BOTH
  // artifacts - the always-run built-XPI analysis PLUS the readable source and its
  // build - so it is longer) and whether it is an Experiment (which adds a
  // bundled-experiment verification step). Exact for every path EXCEPT a REJECTED
  // Experiment (an experiment add-on run WITHOUT --allow-experiments whose bundled draft
  // is unrecognised): it skips the whole vendor block, so its counter stops MID-count
  // (e.g. [4/8]) rather than completing. Sizing the total for that short path would need
  // `invalidExperiment`, known only AFTER the narrated experiment fetch - i.e. a second
  // classification pass before the banner, which we deliberately avoid; the accepted path
  // (the reviewer's --allow-experiments flow) is exact. Every other --sca-root run is exact
  // too: the review is never re-routed away from SCA, so the source-only steps always run.
  const setupTotal = (preliminaryMode === "sca" ? 12 : 7) + (isExp ? 1 : 0);
  let setupDone = 0;
  /**
   * Emit the next numbered "Setup" feed line.
   * @param {string} label  Names the step shown after the [done/total] counter.
   */
  const setupStep = (label) =>
    progress(`[${++setupDone}/${setupTotal}] ${label}`, FEED.STEP);
  progress("── Setup ──");
  progress("");

  // 1a. Mark the start of the review. The .xpi was already read pre-banner (above); the SCA
  // source archive is read below (for the XPI-only advice) and reused in Phase 2 - only a
  // rejected Experiment never reads it. The review target (`addon`) and the derived
  // `scaSource` and the Experiment exclude prefix are set there, from the resolved mode. Narrate the .xpi
  // loader's skip notices (a non-node_modules symlink, an unsafe archive path) here; the
  // source loader's notices are narrated in Phase 2.
  setupStep("Reading add-on");
  for (const notice of xpiAddon.skipped ?? []) {
    warn(notice);
  }
  // Resolved in Phase 2 from the effective mode (below).
  let addon;
  let scaArchive;
  /** The submitted archive's files, keyed relative to --sca-source, for the XPI-only
   * advice (resolveXpiOnlyAdvice), which compares their bytes against the shipped ones. */
  let sourceFiles;
  let scaSource;

  // 1b. The review schema: fetched, annotated, indexed. It is resolved from the SHIPPED
  // XPI's manifest alone (manifest_version + strict_max_version pick the channel), so it
  // depends on neither the Experiment classification nor the review mode - which is why it
  // runs before both, as the one piece of setup EVERY path needs. The extraction pass reads
  // its web_api / loader signatures and the review runs against it; a rejected Experiment
  // needs it too - the reject check resolves Experiment API paths through it (to spot one
  // shadowing a built-in) and meta reads schema.applicationVersion.
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
  // no judgement, no manual reminders, and the vendor pre-processing below is skipped)
  // UNLESS every bundled experiment is a recognised upstream draft - a
  // recognised-but-modified one does NOT abort, so the full review runs and
  // experiment-modified flags it. With --allow-experiments the reviewer accepts
  // them, so the full review always runs.
  // Experiments are reviewed from the XPI (its shipped-artifact role; xpiAddon ===
  // addon in XPI mode). They are privileged, non-bundled, readable code, and the
  // manifest's experiment paths resolve against the XPI's own files (no
  // source-layout mismatch). The classification is the XPI's, so it is stored on
  // xpiAddon here (its bundled classification seeds the trusted experiment files) and
  // mirrored onto the review addon in Phase 2 (the experiment checks read
  // ctx.experiments from it); in XPI mode the two are one addon.
  let invalidExperiment = false;
  if (isExp) {
    // The upstream-drafts allow-list fetch (network) - narrated, since it is one of
    // the slow pre-review steps; it stays silent+offline for a bare experiment_apis
    // declaration that bundles nothing.
    setupStep("Verifying bundled experiments");
    xpiAddon.experiments = await verifyExperiments(xpiAddon, opts);
    invalidExperiment =
      !opts.allowExperiments &&
      xpiAddon.experiments.groups.some((g) => g.status === "unsupported");
  }

  const findings = [];

  // The review target: the SHIPPED XPI, or the readable source whenever --sca-root was
  // given. Stays `xpi` for a rejected Experiment even with --sca-root, because its rejection
  // is decided entirely from the shipped XPI's bundled experiments - reviewing the readable
  // source would be pointless, so Phase 2 never reads the source archive at all. That pin is
  // the ONLY thing that can make an SCA submission an XPI review.
  let mode = REVIEW_MODE.XPI;
  // Set below when the shipped XPI turns out to BE the source, so an XPI-only submission
  // would have been enough. Pure advice - it changes nothing about this review. Read by the
  // sca-not-required check via ctx.
  let scaNotRequired = false;
  // The known-library hash DB the bundled classifier matches files against. An empty Map
  // recognizes nothing.
  let libraryHashes = new Map();
  // The parse-first REVIEW-TARGET sources handed to the ctx builders (Phase 4), which never
  // parses for itself. In an XPI review the review target IS the built XPI, so these ARE
  // xpiParsedSources (below); in SCA they are the readable source's, parsed in Phase 3. Stays
  // unset for a rejected Experiment (its one check reads no code - an empty ctx.jsSources).
  let preParsedJsSources;
  // The BUILT XPI's sources, from the FULL extractReview run on it in Phase 2 (always, unless a
  // rejected Experiment). buildXpiCtxs (Phase 4) hands them to the input:xpi checks, so the
  // shipped ctx is built ONE way regardless of mode; in an XPI review they ALSO ARE
  // preParsedJsSources (the XPI is the review target).
  let xpiParsedSources;
  // The banned-library list (assets/library-blocks.yaml), resolved once in Phase 2 and shared
  // by BOTH artifact analyses (the XPI in Phase 2, the SCA source in Phase 3).
  let libraryBlocks;
  // The XPI's Experiment API namespaces (null for a non-Experiment). Computed ONCE when
  // registered into the schema below.
  let xpiExperimentNamespaces = null;
  // The rest of setup serves a REVIEWABLE add-on, and is skipped WHOLESALE for a rejected
  // Experiment: it runs only the invalid-experiment phase against the shipped XPI - no
  // call, no libraries to recognize, no mode to resolve - so none of this would be read.
  if (!invalidExperiment) {
    // A valid Experiment's declared APIs are part of its platform: register their base
    // namespaces so the developer's calls into them (e.g. browser.calendar.*) resolve
    // instead of tripping unknown-api. Registered from the XPI (in SCA the experiment
    // schema/scripts live in the built XPI, so the manifest's paths resolve there).
    if (isExp) {
      xpiExperimentNamespaces = experimentApiNamespaces(
        xpiAddon.manifest,
        xpiAddon.files
      );
      schema.registerExperimentNamespaces(xpiExperimentNamespaces);
    }

    // The known-library hash DB the classifier matches bytes against (fetched and cached; a
    // pre-seeded cache keeps offline runs deterministic). Both modes classify.
    setupStep("Fetching library hashes");
    const { text: libraryHashesText } = await resolveLibraryHashes({
      cacheDir: opts.libraryHashesCache,
    });
    libraryHashes = parseLibraryHashes(libraryHashesText);

    // The Mozilla add-on policy blocklist (curated assets/library-blocks.yaml): a shipped
    // asset read from disk (fast, no network, so no Setup feed line). Consulted by the vendor
    // audit before each OSV query (auditNpm) - a banned library is recorded and skips the
    // request. Read ONCE here and shared by both artifact analyses (the XPI below, the SCA
    // source in Phase 3).
    const { text: libraryBlocksText } = await resolveLibraryBlocks();
    libraryBlocks = parseLibraryBlocks(libraryBlocksText);

    // Analyse the BUILT XPI FIRST and UNCONDITIONALLY, with the SAME full chain an XPI review
    // runs on its review target - resolveVendor -> verifyVendor -> classifyReview ->
    // identifyBundledLibraries -> extractReview - so siblings.xpi is built ONE way regardless of
    // the mode set just below. The vendor-aware classification it produces
    // (xpiAddon.bundled) is exactly what the XPI-only advice reads: verifyVendor
    // DISCOVERS vendored files that classifyReview then marks non-authored, so a minified
    // vendored library is not miscounted as unreviewable first-party code. In a native XPI
    // review the XPI IS the review target, so this is that review's own analysis (Phase 3 then
    // only reuses xpiParsedSources rather than parsing again).
    xpiAddon.vendor = resolveVendor({ addon: xpiAddon });
    setupStep("Verifying vendored libraries");
    await verifyVendor(xpiAddon, opts.vendorNet, libraryBlocks);
    classifyReview(xpiAddon, { libraryHashes });
    await identifyBundledLibraries(xpiAddon, {
      net: opts.vendorNet,
      cacheDir: opts.cdnLookupCache,
      cdnEnabled: opts.cdnLookup !== false,
      blocks: libraryBlocks,
      setupStep,
      scope: "bundled",
    });
    xpiParsedSources = extractReview(xpiAddon, { schema, xpiAddon, setupStep });

    // The submitted archive is read here because the XPI-only ADVICE below asks both what
    // KIND of source it carries and whether the shipped scripts ARE that source - which
    // needs bytes, not just names. They cost nothing extra: loadAddon has already
    // decompressed them into memory, and Phase 2 reuses this same archive.
    //
    // Reading bytes is not what the no-claims rule forbids. The archive is unverified, so
    // it may only ever ADD scrutiny - and everything here can only WITHHOLD the advice,
    // never shrink the review (the review no longer routes on this at all). What stays
    // forbidden is consulting a CLAIM - a VENDOR declaration, package.json - before
    // Phase 3 has verified it.
    if (opts.scaRoot) {
      scaArchive = loadAddon(opts.scaRoot);
      const rel = scaRootRelative(
        opts.scaSource || opts.scaRoot,
        opts.scaRoot,
        "--sca-source"
      );
      const prefix = rel ? `${rel}/` : "";
      sourceFiles = new Map();
      for (const [p, buf] of scaArchive.files) {
        if (p.startsWith(prefix)) {
          sourceFiles.set(p.slice(prefix.length), buf);
        }
      }
    }

    // An SCA submission is ALWAYS reviewed as SCA - this only decides whether to TELL the
    // developer an XPI-only submission would have done, so their next one skips the longer
    // review. See resolveXpiOnlyAdvice for why nothing routes on it any more.
    scaNotRequired = resolveXpiOnlyAdvice(
      opts,
      xpiAddon.bundled,
      xpiAddon,
      sourceFiles
    );
    if (opts.scaRoot) {
      mode = REVIEW_MODE.SCA;
    }
  }

  // Phase 2: everything mode-dependent, DERIVED from the resolved mode - no mutation. The
  // review target `addon`, `scaSource`, the Experiment exclude prefix, the experiment mirror, and `meta`
  // all follow it. Only a rejected Experiment takes the XPI arm with --sca-root set.
  if (mode?.sca) {
    // The archive was read ONCE above, for the mode decision (and is shared with
    // selectScaBuildFiles below); the review addon is the source subtree carrying the
    // XPI's manifest.
    // The review source, absolute: the whole root when --sca-source named nothing.
    scaSource = opts.scaSource || opts.scaRoot;
    scaArchive = scaArchive ?? loadAddon(opts.scaRoot);
    addon = loadScaAddon(scaArchive, scaSource, opts.scaRoot);
    for (const notice of scaArchive.skipped ?? []) {
      warn(notice);
    }
    // Mirror the XPI's experiment classification onto the review addon (the experiment
    // checks read ctx.experiments from it; in XPI mode the two are one addon anyway).
    addon.experiments = xpiAddon.experiments;
    // Warn when --sca-exp-source matches nothing under the review source: a mis-typed path
    // would silently exclude nothing and flood the report with false positives on the
    // privileged Experiment code. Derived HERE, for this warning only - the checks are
    // handed the two paths and ask the same question of them where they use it
    // (src/lib/reachability.js). "" means there is nothing to exclude, which is also the
    // answer when the folder sits elsewhere under the root: it was never in this file set.
    const expExclude = opts.scaExpSource
      ? (relativeInside(opts.scaExpSource, scaSource) ?? "")
      : "";
    if (
      expExclude &&
      ![...addon.files.keys()].some(
        (f) => f === expExclude || f.startsWith(`${expExclude}/`)
      )
    ) {
      warn(
        `--sca-exp-source "${opts.scaExpSource}" matched no files under --sca-source; ` +
          "nothing will be excluded from the WebExtension code checks."
      );
    }
  } else {
    // XPI review (native, or a rejected Experiment): the review target IS the .xpi.
    addon = xpiAddon;
  }
  // What was reviewed, named by ARTIFACT rather than by role: `xpi` is the shipped add-on
  // in EVERY review, and a source code review adds the values it was given - the root, the
  // source, and the Experiment folder when one was named. One field meaning "the review
  // target" named a different artifact in each mode, which no reader of the JSON could tell
  // apart, and the subtree had nowhere to go but fused into it.
  //
  // These are the names the Review Details block prints and the --llm-review prompt's steps
  // point at, so the report, the prompt and the machine-readable document say one thing.
  const meta = {
    action: "review",
    // RESOLVED, both of them: a reader resolves these, and an agent handed a relative one
    // would resolve it against its own directory.
    xpi: addonPath,
    ...(mode?.sca
      ? {
          scaRoot: opts.scaRoot,
          // The subtree as the review READ it - absolute like every other path here, so
          // every spelling the flag allows ("addon", "./addon/", ".") reaches one value.
          scaSource,
          // The one input that NARROWS the review: that subtree is privileged code and is
          // excluded from the WebExtension checks. Named only when it was given, because a
          // name printed for a value nobody supplied says something false - and unnamed, a
          // reader of the report or of the JSON could not see that anything was excluded,
          // or from where.
          ...(opts.scaExpSource ? { scaExpSource: opts.scaExpSource } : {}),
        }
      : {}),
    reviewed: true,
  };
  if (scaNotRequired) {
    // Advice only - the source review below runs either way. The sca-not-required check
    // emits the formal finding; this feed line says it as it is decided.
    warn(
      "Shipped XPI is the submitted source; an XPI-only submission would have been enough."
    );
  }

  // Phase 3: SCA only - analyse the readable SOURCE (the review target) with the same chain
  // the XPI got in Phase 2 (declared-dependency audit, classify, identify, parse), plus the
  // build corpus. In an XPI review the review target IS the built XPI, already fully analysed
  // in Phase 2, so there is nothing to do but reuse its parsed sources. Skipped for a rejected
  // Experiment (only the reject check runs, and it reads no code).
  if (!invalidExperiment) {
    if (mode?.sca) {
      // 1c. Resolve the source's dependency manifest ONCE (package.json deps + any VENDOR
      // declarations), so the review's checks share one immutable store.
      addon.vendor = resolveVendor({ addon });
      // 1d. A source archive may carry a VENDOR file of its own, and a declaration there
      // must EARN its exemption exactly as one in a shipped XPI does: each declared path is
      // compared against the bytes its declared source serves, so an entry that does not
      // verify leaves a result row for applyUnverifiedVendor to reconcile into the untrusted
      // family (1e/1f) and the file is reviewed as the developer's own code. Without this the
      // declaration alone excluded the file from every source-level check, unverified and
      // unreported. Only the declarations: the package.json half of verifyVendor compares
      // SHIPPED copies of declared dependencies, which a source archive does not carry.
      setupStep("Verifying vendored source libraries");
      await verifyVendorDeclarations(addon, opts.vendorNet, libraryBlocks);
      // The source's package.json declares its dependencies - audit each for popularity
      // (non-popular -> reject) and OSV. The readable source may ALSO vendor a library as a
      // committed copy, so full identification (Mozilla-hash + CDN + OSV, deduped against the
      // declared audit) runs on it below. An unrecognized minified file the source vendors
      // stays non-authored and is rejected.
      setupStep("Auditing source dependencies");
      await verifyScaDependencies(addon, opts.vendorNet, libraryBlocks);
      // 1e. Classify the source's files (library hash, minified geometry, obfuscation), seeding
      // addon.bundled and its non-authored set - AFTER the declaration audit, so the vendored
      // set is final (verifyScaDependencies DISCOVERS further vendored files that classifyFiles
      // reads). 1f then identifies the UNDECLARED libraries the audit cannot see (jsDelivr hash),
      // and applyUnverifiedVendor removes a readable not-popular vendored copy from the skip set;
      // this FINALIZES the authored / non-authored split, so it must precede the parse (1g).
      classifyReview(addon, { libraryHashes });
      await identifyBundledLibraries(addon, {
        net: opts.vendorNet,
        cacheDir: opts.cdnLookupCache,
        cdnEnabled: opts.cdnLookup !== false,
        blocks: libraryBlocks,
        setupStep,
        scope: "source",
      });
      // 1g. Parse the source - once, with the FINAL skip set (see extractReview).
      preParsedJsSources = extractReview(addon, {
        schema,
        xpiAddon,
        setupStep,
      });
      // 1h. The BUILD files (archive minus the review source + Experiment source) - the build
      // scripts/config the review otherwise drops. buildScaCtxs wraps these as the
      // input:build check's ctx.addon; they never merge into the review addon.
      addon.buildFiles = selectScaBuildFiles(
        scaArchive,
        scaSource,
        opts.scaRoot,
        opts.scaExpSource
      );
      // Look at the build ONCE here (the vendor pattern), storing what was found on
      // addon.buildFiles.buildReview for the input:build checks to read. Nothing
      // classifies what the build does, so it routes to the reviewer, who reproduces
      // it from the source by hand.
      setupStep("Analyzing the build");
      addon.buildFiles.buildReview = analyzeBuild({ build: addon.buildFiles });
    } else {
      // XPI review (native, or a rejected Experiment): the built XPI IS the review target
      // and was fully analysed in Phase 2. Its parsed sources ARE the review's sources.
      preParsedJsSources = xpiParsedSources;
    }
  }

  // Phase 4: build the sibling RunContexts the checks read - the last step of setup. The
  // review-level singletons are built ONCE here and shared by every sibling ctx, so they can
  // never drift between artifacts or double-cost. Nothing is parsed here: Phase 2/3 parsed
  // each artifact's sources.

  // The shared review env every sibling ctx projects (buildXpiCtxs / buildScaCtxs). The
  // manifest/experiments are the SHIPPED artifact's - authoritative like the schema, so no
  // artifact's own template can shadow them. Only what a check reads goes on `options`.
  const env = {
    schema,
    options: { allowExperiments: opts.allowExperiments, libraryHashes },
    mode,
    scaSource,
    scaExpSource: opts.scaExpSource,
    scaNotRequired,
    invalidExperiment,
    manifest: xpiAddon.manifest ?? null,
    manifestError: xpiAddon.manifestError ?? null,
    manifestLoc: xpiAddon.manifestLoc ?? null,
    manifestText: xpiAddon.manifestText ?? "",
    experiments: xpiAddon.experiments ?? null,
  };

  // From the ALWAYS-analysed built XPI: the shipped ctx (siblings.xpi - the input:xpi structure
  // checks) and the manifest ctx (input:manifest checks, an empty corpus carrying only the
  // shipped manifest).
  const { xpiCtx, manifestCtx } = buildXpiCtxs(xpiAddon, xpiParsedSources, env);
  // SCA only: from the readable-source analysis, the source ctx (the review target the code
  // checks analyse) and the SCA build corpus ctx (undeclared-build-source). `mode?.sca` implies
  // Phase 3 ran, so addon.buildFiles is loaded; both are undefined in an XPI review (no source).
  const { scaCtx, buildCtx } = mode?.sca
    ? buildScaCtxs(addon, preParsedJsSources, addon.buildFiles, env)
    : {};
  // The sibling ctxs keyed by the `input` value that routes to each (see routeCtx). Routing is
  // total: `source` is a first-class sibling. siblings.source is the REVIEW TARGET - the readable
  // source in SCA, else the built XPI (xpiCtx doubles as both siblings.xpi and siblings.source in
  // an XPI review). The orchestrator reads every review-level datum (the base feed note)
  // off siblings.source; a check routed to one sibling can never reach another's artifact.
  const siblings = {
    source: mode?.sca ? scaCtx : xpiCtx,
    xpi: xpiCtx,
    build: buildCtx,
    manifest: manifestCtx,
  };

  // Phase 5: run the review, then finalize. runChecks runs the phase this review calls
  // for - invalid-experiment for a rejected Experiment, deterministic otherwise - and
  // returns the finished findings, manual items and the checks that ran. Each throwing
  // check is isolated so one failure can't abort all.
  // The `--eslint` opt-in gates code-sanity inside loadChecks (eslintEligible).
  progress(""); // close the Setup section before runChecks prints "── Activity ──"
  const {
    findings: reviewFindings,
    manualItems,
    checksRun,
  } = await runChecks(
    registry,
    {
      only: opts.checksOnly,
      skip: opts.checksSkip,
      eslint: opts.eslint,
    },
    siblings
  );
  findings.push(...reviewFindings);

  // The review-derived half of meta (the base half - action/addon/... - was set in
  // Phase 1): the schema stamps, the checks that ran, and the manual-review to-do list.
  // Its `extended` items are the orchestrator's escalations (resolved to their registry
  // text); the rest are the by-hand manual-checks entries, which every review carries
  // unconditionally. An Experiment reject carries none.
  const ranIds = new Set(checksRun.map((c) => c.id));
  Object.assign(meta, {
    schemaSource,
    schemaBranch,
    schemaChannel,
    applicationVersion: schema.applicationVersion,
    manifestVersion: xpiAddon.manifest?.manifest_version ?? null,
    checksRun: checksRun.map((c) => c.id),
    // The three to-do origins as ONE list, each carrying its own `default-note` where the
    // check authors one: a case a check escalated and a by-hand manual check are the same
    // item to whoever answers it, so the note is appended to both in one place.
    manualReview: invalidExperiment
      ? []
      : withDefaultNotes(
          [
            ...renderManualItems(manualItems, registry).map((m) => ({
              ...m,
              extended: true,
            })),
            ...registry.manualChecks().map((m) => ({ ...m, extended: false })),
          ],
          registry
        ),
    // The blind-spot sweeps to run BEFORE settling this review: the shared method, then
    // one bare item per check that authors an instruction for what it cannot detect. ONE
    // request, not one per check - the sweeps read the same add-on, so what is learned on
    // one item is already in hand for the next. Registry-sourced and carried by every
    // review, exactly like the by-hand manual-checks above, which is why it travels on
    // meta: the text renderer never sees the registry.
    //
    // Gated on the checks that actually RAN: sweeping the blind spot of a scan that did
    // not happen asks a reader to cover for nothing, and this is what makes
    // --checks-only/--checks-skip carry through. An Experiment reject carries none, for
    // the same reason it carries no manual review.
    preSweep: invalidExperiment ? null : preSweepOf(registry, ranIds),
  });

  // --llm-review writes the review's items to a file, named in the Review Details section.
  // Claim it now, empty: a directory we cannot write to has to fail here rather than after
  // the whole review has run.
  // What this run was told to leave out (--llm-skip-summary / --llm-skip-manual). Read
  // once: the prompt drops steps by it, the item file drops sections by it, and the
  // description file is named by it.
  const skip = opts.llmSkip ?? [];
  // Where the prompt's reader writes the add-on description, and where it writes what
  // building the add-on takes. Both share the item file's name and moment, and this tool
  // writes neither and reads neither. Held until the prompt is built, because whether either
  // is NAMED depends on whether the step that writes it prints - the description is withheld
  // by --llm-skip-summary, the build report by a review that is not a source code one.
  let summaryPath = null;
  let buildPath = null;
  if (opts.llmReview) {
    const files = reviewFilePaths(xpiAddon, addonPath);
    meta.itemsFile = files.items;
    summaryPath = skip.includes("summary") ? null : files.summary;
    buildPath = mode?.sca ? files.build : null;
    fs.writeFileSync(meta.itemsFile, "");
  }

  // Fill each finding's display message from its registry response (with the
  // {{item}} placeholder), so the Found Issues section reports the ready-to-send
  // wording. The registry is the only source of this text.
  renderFindings(findings, registry);

  // How a locus names its artifact ([XPI]/[SCA]) in this review - a no-op in an XPI one.
  // Both readers of it below say the same thing about a case: the verdict narration and
  // the question the item file carries.
  const labelOf = locusLabeler(mode, registry.checkInputs());

  let appliedLine;
  let addedLine;
  // Settle the review against the answers a reviewer (or a model) gave it. AFTER
  // renderFindings, because a verdict names an item by its position in the printed
  // report and that order depends on the rendered message - findings are grouped by it,
  // and a locus shows its subject only when the message did not. BEFORE the holds
  // resolve, because a reported case can be a hold itself and has to be counted among
  // the findings that decide whether any hold stands.
  if (opts.llmVerdict) {
    const settled = readVerdicts(opts.llmVerdict);
    // An index means nothing on its own, so the file has to name the submission its
    // verdicts were reached on. Compared against the shipped add-on, which is the path
    // the Review Details section printed under the name XPI.
    if (path.resolve(settled.xpi) !== addonPath) {
      throw new Error(
        `--llm-verdict ${opts.llmVerdict} was written for "${settled.xpi}", but this ` +
          `review is of "${addonPath}" - its item indices mean nothing here`
      );
    }
    const { applied, added } = applyVerdicts({
      findings,
      manual: meta.manualReview,
      verdicts: settled.verdicts,
      additions: settled.additions,
      registry,
      labelOf,
    });
    // A reported case, and a swept addition, became a finding carrying only its locus and
    // slots, so word both from the registry like any other - the same text either way.
    renderFindings(findings, registry);
    // The sweep is settled too, so it stops being asked. A verdict file is the answer to
    // the whole review - its `additions` ARE what the sweep found - and the settled manual
    // items have just been spliced out of the list for the same reason. Leaving the sweep
    // standing would re-ask a reviewer for work whose results are in the report above it,
    // and leave the two standard sections disagreeing about whether the review was done.
    meta.preSweep = null;
    // Audible, so a misaimed verdict shows up as one line here instead of being
    // buried in a re-rendered report. Emitted below, under Review Details, because that
    // section names the review these verdicts were applied to.
    if (applied.length) {
      appliedLine = `Applied ${applied.length} verdict(s): ${applied.join(", ")}`;
    }
    // Counted separately: an addition settles nothing, it ADDS a case no check found, so
    // folding it into the verdict tally would overstate what was settled.
    if (added.length) {
      addedLine = `Added ${added.length} swept finding(s): ${added.join(", ")}`;
    }
  }

  // Settle every provisional hold against the rest of the review - the one moment a
  // hold-or-error check's band is decided. After any verdict has been applied and
  // before anything reads a severity, so the report, the tally and the JSON all see
  // the same value.
  resolveHolds(findings);

  // Fill the file claimed above: the review as an array in the order the report lists
  // them, so whoever settles it addresses an item by reading its index instead of counting
  // lines. Written HERE, after renderFindings gave every finding its wording and
  // resolveHolds settled every band - an array built any earlier would carry a null
  // message and a provisional severity.
  if (meta.itemsFile) {
    const itemsList = reviewItems({
      findings,
      manual: meta.manualReview,
      choices: registry.manualReviewChoices(),
      preSweep: meta.preSweep,
      skipManual: skip.includes("manual"),
      // So a question names its case as the settled report will: in an SCA review
      // "package.json" alone is a file in either artifact, and a reviewer asked about one
      // of them has to be told which.
      labelOf,
    });
    fs.writeFileSync(meta.itemsFile, `${JSON.stringify(itemsList, null, 2)}\n`);
  }

  // Narrate the document's own opening, now that the review is final. It has to come after
  // resolveHolds, because the Review Details tally counts bands and a hold is not settled
  // until then. Under --llm-review the prompt goes first, so a model handed the review
  // reads what to do with it before anything else.
  //
  // report(), not feed: these belong to the document, so they reach a --report-out copy and
  // survive --llm-review switching the Setup and Activity sections off. Absent from JSON (a
  // machine contract) and from the golden harness for free, like the rest of the narration.
  if (opts.llmReview) {
    const prompt = registry.llmReviewPrompt();
    // A path printed for a file nobody is asked to write is an instruction with no step
    // behind it. Two things withhold that step: --llm-skip-summary names it, and a review
    // with nothing to settle prints no steps at all. Both are answered here, from the
    // asks the prompt itself is built from, so the name and the step cannot part company.
    const asked = promptAsks(
      prompt,
      findings,
      meta.manualReview,
      meta.preSweep,
      skip
    ).length;
    if (summaryPath && asked) {
      meta.summaryFile = summaryPath;
    }
    if (buildPath && asked) {
      meta.buildFile = buildPath;
    }
    for (const line of llmPromptLines(
      prompt,
      findings,
      meta.manualReview,
      meta.preSweep,
      skip,
      // What a source code review's own steps need, or null in an XPI one - which is what
      // gates them. Read off meta, never off the flags: a rejected Experiment keeps
      // --sca-root and is still an XPI review, and these steps would then send an agent to
      // a root nothing read. The same values the header prints, so the steps and the block
      // name the same paths or neither does.
      meta.scaRoot ? { root: meta.scaRoot, buildFile: meta.buildFile } : null
    )) {
      report(line);
    }
  }
  for (const line of headerLines(meta)) {
    report(line);
  }
  if (appliedLine || addedLine) {
    report("");
    if (addedLine) {
      report(addedLine);
    }
    if (appliedLine) {
      report(appliedLine);
    }
  }
  // A --llm-review run prints no report, so its Summary is printed here instead: a
  // reviewer has to see from the output alone whether the add-on can be signed off or
  // still has work waiting. Every other run gets it as the report's closing section.
  if (meta.itemsFile) {
    for (const line of summaryLines(
      findings,
      meta.manualReview,
      meta.preSweep
    )) {
      report(line);
    }
  }
  report("");

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
  };
}

/**
 * Per-file classification of the REVIEW TARGET (library hash / minified geometry /
 * obfuscation, plus the vendored + experiment-trusted non-authored seed) -> addon.bundled.
 * It runs before identifyBundledLibraries, which reads its tags (tag.obfuscation) and refines
 * the result.
 * @param {import("./addon/load.js").Addon} addon
 * @param {{libraryHashes: Map<string, {name: string, version: string}>}} deps
 */
function classifyReview(addon, { libraryHashes }) {
  // Reuse the classification when the caller already has one (the SHIPPED XPI carries its own,
  // computed in Phase 1 to resolve the mode); otherwise classify now.
  addon.bundled =
    addon.bundled ?? assembleBundled(classifyFiles(addon, { libraryHashes }));
}

/**
 * The single extraction pass over the REVIEW TARGET: parse each source ONCE, extract every
 * per-file result the checks read, drop the AST. Returns the parsed sources for Phase 4.
 *
 * It runs AFTER identifyBundledLibraries, and that ORDER IS THE POINT: that step FINALIZES
 * addon.bundled.nonAuthored - the skip set this pass gates content extraction on - and it moves
 * the line in BOTH directions. The CDN lookup ADDS a file (a library the Mozilla hash DB
 * missed), and applyUnverifiedVendor REMOVES one: a READABLE vendored library whose package
 * turns out not to be popular is reviewed as the developer's OWN code.
 *
 * That removal is what forces the order. A file dropped from the skip set after the pass would
 * be authored but never content-scanned - and since a check is a pure reader, it would find
 * nothing there. The library's network sinks, eval and unsafe-HTML would all be invisible.
 * @param {import("./addon/load.js").Addon} addon  The review target, already classified.
 * @param {{schema: object,
 *   xpiAddon: import("./addon/load.js").Addon,
 *   setupStep: (label: string) => void}} deps
 * @returns {import("./addon/sources.js").JsSource[]}  The parsed review sources.
 */
function extractReview(addon, { schema, xpiAddon, setupStep }) {
  const jsSources = collectJsSources(addon);
  const experimentNamespaces = isExperiment(xpiAddon.manifest)
    ? experimentApiNamespaces(xpiAddon.manifest, addon.files)
    : null;
  setupStep("Parsing add-on sources");
  runExtractionPass(jsSources, {
    schema,
    nonAuthored: addon.bundled.nonAuthored,
    experimentNamespaces,
  });
  return jsSources;
}

/**
 * Second-tier library identification over an already-classified add-on: reconcile the
 * not-popular declared (VENDOR/package) results into the untrusted family, match still-
 * unrecognized bundles against jsDelivr by content hash, then OSV-audit every identified
 * (undeclared) library - both Mozilla-hash and CDN matches. Reads/writes addon.bundled and
 * addon.vendor; every step is best-effort and skips silently offline. Runs AFTER
 * classification (so the Mozilla-hash matches and tag.obfuscation are final) and after the
 * declared-dependency audit (so auditIdentifiedLibraries dedups against it). Requires
 * addon.vendor for the OSV audit; both the built XPI (Phase 2) and the SCA source (Phase 3)
 * resolve their vendor store before this runs.
 * @param {import("./addon/load.js").Addon} addon
 * @param {{net?: object, cacheDir?: string, cdnEnabled?: boolean,
 *   blocks?: Map<string, object>, setupStep?: (label: string) => void,
 *   scope?: string}} opts  `scope` names the artifact in the Setup feed ("source"/"bundled"); both call sites pass it.
 */
async function identifyBundledLibraries(
  addon,
  { net, cacheDir, cdnEnabled = true, blocks, setupStep = () => {}, scope }
) {
  applyUnverifiedVendor(addon);
  setupStep(`Identifying ${scope} libraries on a CDN`);
  await resolveCdnLibraries(addon, { net, cacheDir, enabled: cdnEnabled });
  setupStep(`Auditing ${scope} libraries`);
  await auditIdentifiedLibraries(addon, net, blocks);
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

  // A channel branch is a MOVING target: release-mv2 means "whatever release is today", so
  // a cached zip is a snapshot that goes stale the moment Thunderbird ships. Staleness only
  // matters when the add-on reaches past the snapshot - then the schema cannot know the APIs
  // of the versions in between, and a call to one is reported as unknown rather than as
  // needing a newer strict_min_version, which is the wrong reason handed to the developer.
  //
  // So: refresh when the add-on's cap is above every cached train AND the snapshot is more
  // than a day old. The age test is what keeps a run from re-downloading six zips for every
  // add-on with no cap or a cap on an unreleased train. Best effort - with the network down
  // the stale cache still reviews, which beats not reviewing at all, and Review Details
  // names the version either way.
  const cap = parseVersion(strictMaxVersion(manifest))?.[0] ?? Infinity;
  const newest = Math.max(...candidates.map((c) => c.major));
  if (
    !stepped &&
    cap > newest &&
    schemaCacheAgeDays(cacheDir, candidates) > 1
  ) {
    setupStep("Refreshing review schemas (add-on targets a newer Thunderbird)");
    stepped = true;
    try {
      await refreshAllSchemas({ cacheDir });
      candidates = readAnchors();
    } catch (err) {
      warn(
        `Could not refresh the schema cache, reviewing against it as it is: ${err.message}`
      );
    }
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
 * Whether the cached schema snapshot is too old to review this add-on against: its cap
 * reaches past every cached train, so the schema cannot know the APIs in between, AND the
 * snapshot is more than a day old, so a newer one plausibly exists. An add-on with no cap
 * has an infinite one, which is why the age test carries the weight - without it every such
 * add-on would re-download six zips on every run.
 * @param {{cap: number, newest: number, ageDays: number}} state
 * @returns {boolean}
 */
/**
 * The blind-spot sweep for this review: the shared method plus the bare items, or null
 * when no check that ran authors one.
 *
 * One object rather than a list, because it is ONE request. The intro says how to judge;
 * each item says only what its own check is looking for. Split the other way - method
 * repeated on every item - and eight near-identical paragraphs teach a reader to skim the
 * part that matters.
 *
 * Both intros travel: the report prints the human one, the item file carries the agent
 * one. They differ only in that the agent is also told what to hand back.
 * @param {import("./checks/registry.js").Registry} registry
 * @param {Set<string>} ranIds  Ids of the checks that actually ran.
 * @returns {?{intro: string, agentIntro: string, items: object[]}}
 */
function preSweepOf(registry, ranIds) {
  const items = registry.sweepInstructions().filter((s) => ranIds.has(s.check));
  return items.length
    ? {
        intro: registry.sweepIntro("human"),
        agentIntro: registry.sweepIntro("llm"),
        items,
      }
    : null;
}

export function schemaSnapshotIsStale({ cap, newest, ageDays }) {
  return cap > newest && ageDays > 1;
}

/**
 * How old the cached schema snapshot is, in days - the NEWEST of the candidate zips, since
 * refreshAllSchemas writes them together. Infinity when none can be read, which makes a
 * refresh the answer.
 * @param {string} cacheDir
 * @param {{branch: string}[]} candidates
 * @returns {number}
 */
function schemaCacheAgeDays(cacheDir, candidates) {
  const times = candidates.map((c) => {
    try {
      return fs.statSync(cachedZipPath(cacheDir, c.branch)).mtimeMs;
    } catch {
      return null;
    }
  });
  const newest = Math.max(...times.filter((t) => t != null), -Infinity);
  return newest === -Infinity ? Infinity : (Date.now() - newest) / 86400000;
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
 * Would an XPI-only submission have been enough? A source-code archive (--sca-root) puts
 * the add-on into the longer source review; when the shipped XPI IS the source, the
 * developer can skip that next time. This answers only that ADVICE (sca-not-required,
 * info) - it never re-routes the review, which is the whole point:
 *
 * an SCA submission is ALWAYS reviewed as SCA. Routing on this once meant a wrong answer
 * silently narrowed the review, and no content test can be trusted with that: a committed,
 * unminified `dist/` inside --sca-source is its own twin under any of them, so a build can
 * always be dressed up as source. As advice, a wrong answer is only wrong advice.
 *
 * Three questions, all of which must say yes:
 *
 *  - can the shipped bytes be READ? (hasUnreviewableCode - minified, obfuscated, or an
 *    unreadable untrusted library, on the XPI's own vendor-aware classification)
 *  - is the shipped KIND the source kind? (isTranspiledSource over the archive's paths -
 *    a transpiler's output is perfectly readable and is still not the source). Deliberately
 *    narrow: it scans only under --sca-source, so a build config elsewhere does not veto a
 *    plain-JS add-on. It is what catches a NON-JS build - .scss -> .css with every script
 *    copied verbatim - which the third question, being JS-only, cannot see.
 *  - are the shipped bytes THE SOURCE? (untwinnedShippedJs - every shipped script must
 *    exist, byte-identical, in the archive). Without this the first two answered "is the
 *    XPI readable?" and called it "is the XPI the source?", and every real bundler
 *    submission - webpack, Vite, a build that copies from submodules - was told its
 *    archive was unnecessary.
 *
 * Neither of the first two is redundant once the third exists. A minified file COMMITTED
 * to the archive has a twin, and only the first question objects; inline <script> bodies
 * live in HTML, which the third never opens.
 *
 * The archive is unverified - nobody has vouched for it yet - so it may only ever ADD
 * scrutiny, i.e. WITHHOLD this advice. Reading its bytes is fine; consulting a CLAIM is
 * not. Nothing here may read a VENDOR declaration: verification happens later (Phase 3),
 * and a claim that could shrink the review before it is checked is a bypass - which is why
 * `exempt` below is the content-hash-identified libraries and nothing else. Not called for
 * a rejected Experiment (its review reads no source at all).
 *
 * @param {object} opts  Pipeline opts; only `opts.scaRoot` is read here.
 * @param {?import("./lib/bundled.js").Bundled} bundled  The built XPI's vendor-aware
 *   classification (xpiAddon.bundled from the Phase 2 classifyReview).
 * @param {import("./addon/load.js").Addon} [addon]  The built XPI itself, so the
 *   question also sees code shipped inside a page (hasUnreviewableCode).
 * @param {Map<string, Buffer>} [sourceFiles]  The submitted archive's files, keyed
 *   relative to --sca-source. Omitted means none were read, which withholds the advice.
 * @returns {boolean}  True only when all three say the XPI stands on its own.
 */
export function resolveXpiOnlyAdvice(opts, bundled, addon, sourceFiles) {
  if (!opts.scaRoot) {
    return false;
  }
  if (hasUnreviewableCode(bundled, addon)) {
    return false;
  }
  for (const path of sourceFiles?.keys() ?? []) {
    if (isTranspiledSource(path)) {
      return false;
    }
  }
  // ONLY a true content-hash match against the known-library DB (bundled.js sets
  // tag.library there and nowhere else). NOT bundled.nonAuthored: that mixes in
  // VENDOR.md-declared files, and a declaration must not be able to buy this advice
  // before Phase 3 has verified it. A VENDOR-declared file therefore still needs a twin.
  const exempt = new Set(
    (bundled?.classified ?? []).filter((t) => t.library).map((t) => t.file)
  );
  return (
    untwinnedShippedJs(addon?.files ?? new Map(), sourceFiles ?? new Map(), {
      exempt,
    }).length === 0
  );
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
