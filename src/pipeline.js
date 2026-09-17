// The review pipeline: opts in, a structured Review out. This is the tool's
// core, independent of the CLI front-end (cli.js) - the test harness drives it
// directly. It loads the add-on, resolves and verifies its vendored
// declarations, classifies bundled code, runs the schema review, and fills each
// finding's display text from the registry. It returns the Review. Formatting
// and I/O are the front-end's job. The tool is read-only: it never modifies or
// repacks the submission.
//
// Belongs here: the declared setup plan (SETUP_STEPS), the stage orchestration
// (runPipeline), the XPI-only submission advice (resolveXpiOnlyAdvice) and the
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
import { resolveHolds } from "./report/finding.js";
import { STATE_VERSION } from "./report/state.js";
import { issue } from "./report/loop.js";
import { headerLines, loopPromptLines, packageLines } from "./report/format.js";
import { reviewFilePaths } from "./report/items.js";
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
 * The setup sequence: every pre-review step, in the order it runs, with the condition that
 * decides whether this run has it. The loop in runPipeline WALKS this list and runs each
 * entry's action, so a step happens because it is declared here rather than because a
 * statement sits somewhere in that function.
 *
 * The ONE place that order and that count are stated. The feed's total is the count of the
 * NARRATED entries this run plans, so a step cannot be added without the total following
 * it, and no number typed beside the steps can fall behind them.
 *
 * Exported so a test can read the plan without running a review.
 *
 * `label` ALONE says whether a step narrates, so the line and the count can never disagree:
 *   - a string is the line the reviewer sees, printed before the step runs;
 *   - `null` narrates too, but the label is only known as the step runs (the schema names
 *     the branch it chose), so the action is handed the narrator and must call it exactly
 *     once;
 *   - NO `label` is a silent step - fast work, or a decision rather than a fetch. It runs
 *     like any other step and is not counted.
 *
 * `when` decides whether this run has the step. It is asked as the loop ARRIVES, because
 * one fact - `invalidExperiment` - is decided by a step of this list; the plan sized before
 * the run (for the feed's total) asks the same conditions of the facts as they stand then.
 * @type {{key: string, label?: ?string,
 *   when: (facts: {sca: boolean, isExp: boolean, invalidExperiment: boolean}) => boolean}[]}
 */
export const SETUP_STEPS = Object.freeze([
  { key: "read", label: "Reading add-on", when: () => true },
  // The one piece of setup EVERY path needs, a rejected Experiment included.
  { key: "schema", label: null, when: () => true },
  {
    key: "experiments",
    label: "Verifying bundled experiments",
    when: (f) => f.isExp,
  },
  // Everything below serves a REVIEWABLE add-on, so a rejected Experiment drops it: its
  // review runs the one reject check against the shipped XPI and nothing else. The
  // exceptions are the two steps that name what was reviewed, which its report still needs.
  {
    key: "experiment-schema",
    when: (f) => f.isExp && !f.invalidExperiment,
  },
  // The built XPI's own analysis, which a source review runs too: the shipped artifact is
  // analysed the same way in both modes.
  {
    key: "hashes",
    label: "Fetching library hashes",
    when: (f) => !f.invalidExperiment,
  },
  {
    key: "vendor-xpi",
    label: "Verifying vendored libraries",
    when: (f) => !f.invalidExperiment,
  },
  {
    key: "cdn-bundled",
    label: "Identifying bundled libraries on a CDN",
    when: (f) => !f.invalidExperiment,
  },
  {
    key: "audit-bundled",
    label: "Auditing bundled libraries",
    when: (f) => !f.invalidExperiment,
  },
  // The two parses - the shipped artifact's and, in a source review, the readable source's
  // - are separate steps under one label.
  {
    key: "parse-xpi",
    label: "Parsing add-on sources",
    when: (f) => !f.invalidExperiment,
  },
  // What the submission IS, and what this review makes of it: the submitted source archive,
  // the review target, and the record of what was reviewed. The target is two entries rather
  // than one arm each side of an `if`, so the list - not a branch inside a step - holds the
  // pin that a REJECTED Experiment is reviewed as its shipped XPI even with --sca-root,
  // and `meta` is reached on every path.
  { key: "source-archive", when: (f) => !f.invalidExperiment },
  { key: "target-source", when: (f) => f.sca && !f.invalidExperiment },
  { key: "target-xpi", when: (f) => !f.sca || f.invalidExperiment },
  { key: "meta", when: () => true },
  // An XPI review's target IS the built XPI, parsed above; there is nothing left to do but
  // hand those sources on.
  { key: "xpi-sources", when: (f) => !f.sca && !f.invalidExperiment },
  // The readable source's own passes, and the build the reviewer reproduces.
  {
    key: "vendor-source",
    label: "Verifying vendored source libraries",
    when: (f) => f.sca && !f.invalidExperiment,
  },
  {
    key: "deps-source",
    label: "Auditing source dependencies",
    when: (f) => f.sca && !f.invalidExperiment,
  },
  {
    key: "cdn-source",
    label: "Identifying source libraries on a CDN",
    when: (f) => f.sca && !f.invalidExperiment,
  },
  {
    key: "audit-source",
    label: "Auditing source libraries",
    when: (f) => f.sca && !f.invalidExperiment,
  },
  {
    key: "parse-source",
    label: "Parsing add-on sources",
    when: (f) => f.sca && !f.invalidExperiment,
  },
  {
    key: "build",
    label: "Analyzing the build",
    when: (f) => f.sca && !f.invalidExperiment,
  },
]);

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
 *   (--sca-source names it relative to the root, or absolute within it). Optional;
 *   defaults to scaRoot itself -
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
 *   network transport for every review fetch that is not a cached asset - vendor
 *   verification, the CDN lookup, the OSV audit (the test harness injects an offline
 *   one); defaults to the real fetch.
 * @property {import("./checks/registry.js").Registry} [registry]  Parsed
 *   registry threaded from the caller, parsed once here otherwise.
 * @property {string} [llmVerdict]  Path to a verdict file (--llm-verdict) settling the
 *   questions this review asks: findings withdrawn, to-do items reported or cleared.
 *   A reported case is worded by its own check; the only wording an answer brings is what
 *   a reviewer typed instead of picking one, which travels on that case's location line.
 * @property {boolean} [llmReview]  Run the review and hand out the first phase of it -
 *   printing that prompt and writing the state every later pass reads - instead of
 *   printing the report. Changes nothing about the review itself, only what is printed
 *   and what is written for the passes that follow.
 * @property {string[]} [llmSkip]  What that prompt leaves out (PROMPT_SKIPS, src/config.js):
 *   "summary" (--llm-skip-summary) drops the add-on description and the file named for it;
 *   "manual" (--llm-skip-manual) drops the steps that put the manual items to a reviewer,
 *   and no phase puts them to anyone - they stay in the report, for the
 *   reviewer to work through later.
 */

/**
 * @typedef {object} PipelineResult
 * @property {Finding[]} findings
 * @property {ReviewMeta} meta
 * @property {import("./lib/enum.js").ReviewMode} mode  For the artifact labels.
 * @property {Map<string, string>} ruleInputs  Each ruleId's input artifact.
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
  // SCA (source code archive) mode is on when --sca-root is set; --sca-source is optional
  // and defaults to the root itself (a flat layout, manifest.json at the root, the build
  // tooling intermingled). It splits the review across TWO add-on artifacts with a fixed
  // ROLE each, resolved here ONCE so nothing downstream re-branches on the mode:
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
  // The root case (scaRootRelative keys it as "") is handled throughout: loadScaAddon
  // reviews every file, and selectScaBuildFiles traces the build off the root
  // package.json (there is no source subtree to exclude).
  //
  // The review mode is DERIVED from the two facts below and assigned nowhere, so it cannot
  // drift from the steps that ran: --sca-root makes it a source code review, and a REJECTED
  // Experiment takes it back to an XPI review (its rejection is decided from the shipped XPI
  // alone, so the readable source is never read). Setup itself never reads it - each step
  // says which facts it needs - and everything after setup reads the one derivation.
  // The parsed registry, threaded from main() (or loaded once here when a caller
  // such as the test harness invokes the pipeline directly).
  const registry = opts.registry ?? loadRegistry();

  // Load the .xpi archive (a fast in-memory unzip). Read before the "Setup" banner
  // because it sizes the feed - it gives the mode and whether the add-on is an
  // Experiment. Every slow NETWORK step below (the experiment fetch, schema fetch, vendor
  // verification, CDN lookups) plus the AST parse is narrated as a Setup step. The add-on
  // reads are fast local unzips (this .xpi, and in a kept SCA the source archive loaded in
  // Phase 2) marked by the "Reading add-on" step. Loading here is the ONLY way an add-on
  // enters a review: its content and its identity then come from one value, and no caller
  // can hand in files that disagree with the path the report goes on to name.
  const xpiAddon = loadAddon(addonPath);
  const isExp = isExperiment(xpiAddon.manifest);

  // The facts each step's `when` is asked of, from what the fast .xpi read already gives
  // us: the mode, and whether this is an Experiment.
  let invalidExperiment = false;
  const setupFacts = {
    sca: Boolean(opts.scaRoot),
    isExp,
    // Live rather than a snapshot: the experiments step decides this one, and the loop
    // asks each step's condition as it reaches it.
    get invalidExperiment() {
      return invalidExperiment;
    },
    // What the review IS, from the two above. Read after setup, by the ctx builders and the
    // report; no step reads it, because a step says which FACTS it needs.
    get mode() {
      return this.sca && !invalidExperiment ? REVIEW_MODE.SCA : REVIEW_MODE.XPI;
    },
  };
  // The total, sized by asking the same conditions the loop will ask - but of the facts as
  // they stand HERE, before any step has run. That is the whole of why a rejected
  // Experiment's counter stops short: the step that rejects it has not run yet, so the
  // total is the one the review would have had, and the report says where it ended.
  const setupTotal = SETUP_STEPS.filter(
    (step) => "label" in step && step.when(setupFacts)
  ).length;
  let setupDone = 0;
  /**
   * Print one step's feed line.
   * @param {object} step  The step's SETUP_STEPS entry.
   * @param {string} [label]  For the step whose label is only known as it runs.
   */
  const narrate = (step, label) =>
    progress(
      `[${++setupDone}/${setupTotal}] ${label ?? step.label}`,
      FEED.STEP
    );
  // One numbered line per slow step, matching the Activity check loop, so the
  // otherwise-silent pre-review pause shows what is running (a no-op when progress is off -
  // JSON, the golden harness).
  progress("── Setup ──");
  progress("");

  // What the steps share. Each value is written by the step that owns it and read by the
  // ones after it, and the declared order is what puts them in that sequence.

  /** The review target (ctx.addon): the readable source, or the shipped .xpi - whichever
   * of `target-source` / `target-xpi` this review runs. */
  let addon;
  /** The submitted source archive: read by `source-archive`, reused by `target-source`
   * and `build`. */
  let scaArchive;
  /** The submitted archive's files, keyed relative to --sca-source, for the XPI-only
   * advice (resolveXpiOnlyAdvice), which compares their bytes against the shipped ones. */
  let sourceFiles;
  /** The review source, absolute - the whole root when --sca-source named nothing. */
  let scaSource;
  /** The review schema (indexed) and the stamps meta publishes for it. */
  let schema;
  let schemaSource;
  let schemaBranch;
  let schemaChannel;
  // Set by `source-archive` when the shipped XPI turns out to BE the source, so an XPI-only
  // submission would have been enough. Pure advice - it changes nothing about this review. Read by the
  // sca-not-required check via ctx.
  let scaNotRequired = false;
  // The known-library hash DB the bundled classifier matches files against. An empty Map
  // recognizes nothing.
  let libraryHashes = new Map();
  // The parse-first REVIEW-TARGET sources handed to the ctx builders (Phase 4), which never
  // parses for itself. In an XPI review the review target IS the built XPI, so these ARE
  // xpiParsedSources; in SCA they are the readable source's, parsed in Phase 3. Stays
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
  // What was reviewed, built by the `meta` step and extended once the review has run.
  let meta;

  const findings = [];

  // One body per declared step, keyed by its entry. Each is a closure over the locals
  // above, so a step reads what the steps before it wrote and nothing is threaded through a
  // state object; the loop below is what RUNS them, in the declared order.
  const actions = {
    // No inherited keys: a step named for something on Object.prototype would
    // otherwise find a "body" nobody wrote.
    __proto__: null,

    // Phase 1: what every review needs, whatever it turns out to be.

    // Mark the start of the review. The .xpi was already read pre-banner (above); the
    // SCA source archive is read by `source-archive` and reused after it - in a source
    // review, and not when a rejected Experiment drops that step. Narrate the .xpi loader's
    // skip notices (a non-node_modules symlink, so only ever an unpacked submission) here;
    // the source loader's notices are narrated by `target-source`.
    read: () => {
      for (const notice of xpiAddon.skipped ?? []) {
        warn(notice);
      }
    },

    // The review schema: fetched, annotated, indexed. It is resolved from the SHIPPED
    // XPI's manifest alone (manifest_version + strict_max_version pick the channel), so it
    // depends on neither the Experiment classification nor the review mode - which is why it
    // runs before both, as the one piece of setup EVERY path needs. The extraction pass reads
    // its web_api / loader signatures and the review runs against it; a rejected Experiment
    // needs it too - the reject check resolves Experiment API paths through it (to spot one
    // shadowing a built-in) and meta reads schema.applicationVersion.
    //
    // It names the branch it chose, which is known only once it has chosen, so it narrates
    // itself with the narrator handed to it.
    schema: async (say) => {
      const resolved = await resolveReviewSchema({
        cacheDir: opts.schemaCache ?? DEFAULT_CACHE,
        manifest: xpiAddon.manifest,
        setupStep: say,
      });
      schemaSource = resolved.source;
      schemaBranch = resolved.branch;
      schemaChannel = resolved.channel;
      const schemaFiles = loadSchemaFiles(resolved.zipPath);
      applySchemaAnnotations(schemaFiles.files, loadSchemaAnnotations());
      schema = buildSchemaIndex(schemaFiles);
    },

    // Classify every Experiment add-on against the upstream drafts
    // (github.com/thunderbird/webext-experiments), regardless of
    // --allow-experiments: a bundled experiment whose name matches a known draft
    // MUST be the unmodified upstream copy, which experiment-modified enforces.
    // verifyExperiments fetches the allow-list only when a group actually bundles
    // files (a bare experiment_apis declaration stays offline -> unsupported, and the
    // step's line is the only sign of it), and a fetch failure throws so the run
    // hard-exits (2) rather than letting a missing allow-list masquerade as a verdict -
    // we cannot verify identity without it.
    //
    // Without
    // --allow-experiments an Experiment add-on is rejected outright (the review
    // short-circuits to the single experiment-not-allowed check, no other checks,
    // no judgement, no manual reminders, and every step below is dropped)
    // UNLESS every bundled experiment is a recognised upstream draft - a
    // recognised-but-modified one does NOT abort, so the full review runs and
    // experiment-modified flags it. With --allow-experiments the reviewer accepts
    // them, so the full review always runs.
    // Experiments are reviewed from the XPI (its shipped-artifact role; xpiAddon ===
    // addon in XPI mode). They are privileged, non-bundled, readable code, and the
    // manifest's experiment paths resolve against the XPI's own files (no
    // source-layout mismatch). The classification is the XPI's, so it is stored on
    // xpiAddon here, whose bundled classification seeds the trusted experiment files.
    experiments: async () => {
      xpiAddon.experiments = await verifyExperiments(xpiAddon, opts);
      invalidExperiment =
        !opts.allowExperiments &&
        xpiAddon.experiments.groups.some((g) => g.status === "unsupported");
    },

    // A valid Experiment's declared APIs are part of its platform: register their base
    // namespaces so the developer's calls into them (e.g. browser.calendar.*) resolve
    // instead of tripping unknown-api. Registered from the XPI (in SCA the experiment
    // schema/scripts live in the built XPI, so the manifest's paths resolve there).
    "experiment-schema": () => {
      schema.registerExperimentNamespaces(
        experimentApiNamespaces(xpiAddon.manifest, xpiAddon.files)
      );
    },

    // The known-library hash DB the classifier matches bytes against (fetched and cached; a
    // pre-seeded cache keeps offline runs deterministic). Both modes classify.
    hashes: async () => {
      const { text: libraryHashesText } = await resolveLibraryHashes({
        cacheDir: opts.libraryHashesCache,
      });
      libraryHashes = parseLibraryHashes(libraryHashesText);

      // The Mozilla add-on policy blocklist (curated assets/library-blocks.yaml): a shipped
      // asset read from disk (fast, no network, so no step of its own). Consulted by the
      // vendor audit before each OSV query (auditNpm) - a banned library is recorded and
      // skips the request. Read ONCE here and shared by both artifact analyses (the XPI
      // below, the SCA source in Phase 3).
      const { text: libraryBlocksText } = await resolveLibraryBlocks();
      libraryBlocks = parseLibraryBlocks(libraryBlocksText);
    },

    // Phase 2: the SHIPPED artifact's analysis, and what this review makes of the
    // submission. Both modes run all of it - the XPI is analysed the same way either way.

    // Analyse the BUILT XPI FIRST, with the SAME full chain an XPI review
    // runs on its review target - resolveVendor -> verifyVendor -> classifyReview ->
    // identifyBundledLibraries -> audit -> extractReview - so siblings.xpi is built ONE way
    // regardless of which mode this review turns out to be. The vendor-aware classification
    // it produces (xpiAddon.bundled) is exactly what the XPI-only advice reads: verifyVendor
    // DISCOVERS vendored files that classifyReview then marks non-authored, so a minified
    // vendored library is not miscounted as unreviewable first-party code. In a native XPI
    // review the XPI IS the review target, so this is that review's own analysis, and
    // `xpi-sources` hands those parsed sources on rather than parsing again.
    "vendor-xpi": async () => {
      xpiAddon.vendor = resolveVendor({ addon: xpiAddon });
      await verifyVendor(xpiAddon, opts.vendorNet, libraryBlocks);
      classifyReview(xpiAddon, { libraryHashes });
    },
    "cdn-bundled": () =>
      identifyBundledLibraries(xpiAddon, {
        net: opts.vendorNet,
        cacheDir: opts.cdnLookupCache,
        cdnEnabled: opts.cdnLookup !== false,
      }),
    "audit-bundled": () =>
      auditIdentifiedLibraries(xpiAddon, opts.vendorNet, libraryBlocks),
    "parse-xpi": () => {
      xpiParsedSources = extractReview(xpiAddon, { schema, xpiAddon });
    },

    // The submitted source archive, read ONCE for every later reader of it. It is read
    // here because the XPI-only ADVICE below asks both what KIND of source it carries and
    // whether the shipped scripts ARE that source - which needs bytes, not just names. They
    // cost nothing extra: loadAddon has already decompressed them into memory, and the
    // steps below reuse this same archive.
    "source-archive": () => {
      if (setupFacts.sca) {
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
      // review. See resolveXpiOnlyAdvice for why nothing routes on it.
      scaNotRequired = resolveXpiOnlyAdvice(
        opts,
        xpiAddon.bundled,
        xpiAddon,
        sourceFiles
      );
      if (scaNotRequired) {
        // Advice only - the source review runs either way. The sca-not-required check
        // emits the formal finding; this feed line says it as it is decided.
        warn(
          "Shipped XPI is the submitted source; an XPI-only submission would have been enough."
        );
      }
    },

    // The review target of a source code review: the readable source. The archive was read
    // ONCE above by `source-archive` (and is shared with selectScaBuildFiles in
    // `build`); the review addon is the source subtree carrying the XPI's manifest. The
    // review source is absolute: the whole root when --sca-source named nothing.
    "target-source": () => {
      scaSource = opts.scaSource || opts.scaRoot;
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
    },

    // The review target of every other review: the .xpi itself. A native XPI review takes
    // this arm, and so does a REJECTED Experiment even with --sca-root - its rejection is
    // decided entirely from the shipped XPI, so the readable source is never read.
    "target-xpi": () => {
      addon = xpiAddon;
    },

    // What was reviewed, named by ARTIFACT rather than by role: `xpi` is the shipped add-on
    // in EVERY review, and a source code review adds the values it was given - the root, the
    // source, and the Experiment folder when one was named. One field meaning "the review
    // target" would name a different artifact in each mode, which no reader of the JSON
    // could tell apart, and would leave the subtree nowhere to go but fused into it.
    //
    // These are the names the Review Details block prints and the --llm-review prompt's steps
    // point at, so the report, the prompt and the machine-readable document say one thing.
    // Built on every path: a rejected Experiment's report names its add-on too.
    meta: () => {
      meta = {
        action: "review",
        // RESOLVED, both of them: a reader resolves these, and an agent handed a relative one
        // would resolve it against its own directory.
        xpi: addonPath,
        // Named iff the readable source is what was reviewed: `scaSource` is set by
        // `target-source`, which runs only then. meta names the artifacts this review
        // READ, so the step that loaded one is what decides whether it appears here.
        ...(scaSource
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
    },

    // XPI review: the built XPI IS the review target and was fully analysed above. Its
    // parsed sources ARE the review's sources.
    "xpi-sources": () => {
      preParsedJsSources = xpiParsedSources;
    },

    // Phase 3: SCA only - analyse the readable SOURCE (the review target) with the same chain
    // the XPI got in Phase 2 (declared-dependency audit, classify, identify, parse), plus the
    // build corpus.

    // Resolve the source's dependency manifest ONCE (package.json deps + any VENDOR
    // declarations), so the review's checks share one immutable store.
    // A source archive may carry a VENDOR file of its own, and a declaration there
    // must EARN its exemption exactly as one in a shipped XPI does: each declared path is
    // compared against the bytes its declared source serves, so an entry that does not
    // verify leaves a result row for applyUnverifiedVendor to reconcile into the untrusted
    // family (`cdn-source`) and the file is reviewed as the developer's own code. Without
    // this, the declaration alone would exclude the file from every source-level check,
    // unverified and unreported. Only the declarations: the package.json half of verifyVendor compares
    // SHIPPED copies of declared dependencies, which a source archive does not carry.
    "vendor-source": async () => {
      addon.vendor = resolveVendor({ addon });
      await verifyVendorDeclarations(addon, opts.vendorNet, libraryBlocks);
    },

    // The source's package.json declares its dependencies - audit each for popularity
    // (non-popular -> reject) and OSV. The readable source may ALSO vendor a library as a
    // committed copy, so full identification (Mozilla-hash + CDN + OSV, deduped against the
    // declared audit) runs on it below. An unrecognized minified file the source vendors
    // stays non-authored and is rejected.
    // Classify the source's files (library hash, minified geometry, obfuscation), seeding
    // addon.bundled and its non-authored set - AFTER the declaration audit, so the vendored
    // set is final (verifyScaDependencies DISCOVERS further vendored files that classifyFiles
    // reads).
    "deps-source": async () => {
      await verifyScaDependencies(addon, opts.vendorNet, libraryBlocks);
      classifyReview(addon, { libraryHashes });
    },

    // Identify the UNDECLARED libraries the audit cannot see (jsDelivr hash), and
    // applyUnverifiedVendor removes a readable not-popular vendored copy from the skip set;
    // this FINALIZES the authored / non-authored split, so it must precede `parse-source`.
    "cdn-source": () =>
      identifyBundledLibraries(addon, {
        net: opts.vendorNet,
        cacheDir: opts.cdnLookupCache,
        cdnEnabled: opts.cdnLookup !== false,
      }),
    "audit-source": () =>
      auditIdentifiedLibraries(addon, opts.vendorNet, libraryBlocks),

    // Parse the source ONCE, with the FINAL skip set (see extractReview).
    "parse-source": () => {
      preParsedJsSources = extractReview(addon, { schema, xpiAddon });
    },

    // The BUILD files (archive minus the review source + Experiment source) - the build
    // scripts/config the review otherwise drops. buildScaCtxs wraps these as the
    // input:build check's ctx.addon; they never merge into the review addon.
    //
    // Look at the build ONCE here (the vendor pattern), storing what was found on
    // addon.buildFiles.buildReview for the input:build checks to read. Nothing
    // classifies what the build does, so it routes to the reviewer, who reproduces
    // it from the source by hand.
    build: () => {
      addon.buildFiles = selectScaBuildFiles(
        scaArchive,
        scaSource,
        opts.scaRoot,
        opts.scaExpSource
      );
      addon.buildFiles.buildReview = analyzeBuild({ build: addon.buildFiles });
    },
  };

  // Every action answers to a declared step, so a body cannot be added to setup without an
  // entry in the list to run it - the half of the contract the loop below cannot state.
  const undeclared = Object.keys(actions).filter(
    (key) => !SETUP_STEPS.some((step) => step.key === key)
  );
  if (undeclared.length) {
    throw new Error(
      `setup action(s) not declared in SETUP_STEPS: ${undeclared.join(", ")}`
    );
  }

  // Setup RUNS here, and only here: a step's body executes because the loop reached its
  // entry, in the list's order, under the list's own condition - asked HERE, where every
  // fact is settled, so a step can be admitted by a fact that a step before it decided and
  // not merely dropped by one. There is no other call site, so a step out of order is not
  // a mistake to catch but a shape that cannot be written; an undeclared step and a stray
  // second line are refused below, where the loop can see them.
  for (const step of SETUP_STEPS) {
    if (!step.when(setupFacts)) {
      continue;
    }
    const action = actions[step.key];
    if (!action) {
      throw new Error(
        `setup step "${step.key}" is declared but not implemented`
      );
    }
    // A step prints the line it declares, and only that line. The loop prints a declared
    // label itself; the step whose label is known only as it runs prints it through `say`;
    // a silent step starts out as having spoken, so a stray line is refused.
    let said = !("label" in step);
    const say = (label) => {
      if (said) {
        throw new Error(
          `setup step "${step.key}" narrated a line it does not declare`
        );
      }
      said = true;
      narrate(step, label);
    };
    if (step.label) {
      say();
    }
    await action(say);
    if (!said) {
      throw new Error(`setup step "${step.key}" never printed its line`);
    }
  }

  // Phase 4: build the sibling RunContexts the checks read, once the step list has run. The
  // review-level singletons are built ONCE here and shared by every sibling ctx, so they can
  // never drift between artifacts or double-cost. Nothing is parsed here: Phase 2/3 parsed
  // each artifact's sources.

  // Both facts are settled - the loop has run - so the review mode follows from them.
  const mode = setupFacts.mode;

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

  // From the built XPI's analysis, which every reviewable path runs: the shipped ctx (siblings.xpi - the input:xpi structure
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

  // The review-derived half of meta (the base half - action/xpi/... - is the `meta` setup
  // step's): the schema stamps, the checks that ran, and the manual-review to-do list.
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

  // What this run was told to leave out (--llm-skip-summary / --llm-skip-manual). Read
  // once: a phase drops steps by it, the routing drops entries by it, and the
  // description file is named by it.
  const skip = opts.llmSkip ?? [];
  // Where the prompt's reader writes the add-on description, and where it writes what
  // building the add-on takes. Both share the review's name and moment, and this tool
  // writes neither and reads neither. Held until the prompt is built, because whether either
  // is NAMED depends on whether the step that writes it prints - the description is withheld
  // by --llm-skip-summary, the build report by a review that is not a source code one.
  let summaryPath = null;
  let buildPath = null;
  // The REVIEW LOOP's state, built once the review is final and handed to `issue` below.
  // A LOCAL, never hung off meta: it carries the report, and the report carries meta.
  let loopState = null;
  // Whether this run SWEEPS: it asked for one, it was not told to leave it out, and there
  // is a blind spot to cover. Every `run: sweep` step hangs off this - spawning the agent,
  // waiting for it, recording what it found - so a review with nothing to sweep and one
  // told not to read the same, and neither mentions a sweep that is not happening.
  const sweeping =
    opts.llmReview &&
    !opts.llmSkipSweep &&
    Boolean(meta.preSweep?.items?.length);
  // A run that PROMPTS is the loop's first pass, and the only one that reads the add-on:
  // everything after it works from the state this run writes.
  const prompting = opts.llmReview && !opts.llmVerdict;
  if (prompting) {
    // Said plainly, because two readers need it and neither should infer it from whether
    // some file happens to have been named: this run HANDS OUT A PHASE, so its whole
    // output is that prompt and the report is not printed beside it.
    meta.prompting = true;
    const files = reviewFilePaths(xpiAddon, addonPath);
    summaryPath = skip.includes("summary") ? null : files.summary;
    buildPath = mode?.sca ? files.build : null;
    // Claimed empty, so a directory this run cannot write to fails before the review is
    // built rather than when the finished review is written to it.
    fs.writeFileSync(files.state, "");
    // The REVIEW LOOP's two files, claimed before the review is built for the reason
    // a directory this run cannot write to has to fail before the review is built.
    meta.stateFile = files.state;
    meta.reviewFile = files.review;
  }

  // Fill each finding's display message from its registry response (with the
  // {{item}} placeholder), so the Found Issues section reports the ready-to-send
  // wording. The registry is the only source of this text.
  renderFindings(findings, registry);

  // Settle every provisional hold against the rest of the review - the one moment a
  // hold-or-error check's band is decided. After any verdict has been applied and
  // before anything reads a severity, so the report, the tally and the JSON all see
  // the same value.
  resolveHolds(findings);

  // The REVIEW LOOP's state, written once the review is final: everything a later pass
  // reads, since none of them runs the review again.
  if (prompting) {
    // The REVIEW LOOP's state: the review itself, so no later pass has to rebuild it.
    // Everything formatText reads that the registry cannot recompute goes in here -
    // ruleInputs, issueHeadings and verdictIntros are the registry's, and a copy here
    // would outlive an edit to it.
    loopState = {
      version: STATE_VERSION,
      review: meta.reviewFile,
      report: { findings, meta, sca: Boolean(mode?.sca) },
      manual: meta.manualReview,
      preSweep: meta.preSweep,
      // What this run was told, recorded ONCE. Every pass reads it from here - a second
      // copy handed in beside the state is a second answer, and the two deciding
      // differently is a phase issued for entries it never shows.
      run: {
        skip,
        sca: Boolean(mode?.sca),
        // Not derived from preSweep: --llm-skip-sweep leaves the instructions standing
        // and withholds the asking, so the two are different facts.
        sweep: sweeping,
      },
      sweep: null,
      paths: {
        review: meta.reviewFile,
        description: summaryPath,
        build: buildPath,
        schemaCache: opts.schemaCache,
        scaRoot: opts.scaRoot ?? null,
        // The block a phase that READS the add-on prints: which artifact, and the schema
        // snapshot its verdicts mean anything against. Built once, from the same meta the
        // report's header is built from.
        package: packageLines(meta, opts.schemaCache).join("\n"),
      },
      answers: {},
      route: {},
      issued: [],
    };
  }

  // Narrate the document's own opening, now that the review is final. It has to come after
  // resolveHolds, because the Review Details tally counts bands and a hold is not settled
  // until then. Under --llm-review the prompt goes first, so a model handed the review
  // reads what to do with it before anything else.
  //
  // report(), not feed: these belong to the document, so they reach a --report-out copy and
  // survive --llm-review switching the Setup and Activity sections off. Absent from JSON (a
  // machine contract) and from the golden harness for free, like the rest of the narration.
  if (prompting) {
    // THE REVIEW LOOP's first pass. The deterministic review just ran, and it runs ONCE:
    // its result goes into the state, and every pass after this reads that instead of
    // rebuilding it. So this is the only run that needs the add-on at all.
    //
    // Which phase goes out is `issue`'s to decide, from what has work - a run with no
    // sweep and no description agent starts at `verify`, and never mentions either.
    const texts = registry.llmPhases();
    const state = loopState;
    // A path printed for a file nobody is asked to write is an instruction with no step
    // behind it, so the header names one only when its step survived the markers.
    const first = issue(state, meta.stateFile, texts.phases, registry);
    if (first) {
      const named = new Set(
        first.steps.map((step) => step.skip ?? step.run ?? "")
      );
      if (summaryPath && named.has("summary")) {
        meta.summaryFile = summaryPath;
      }
      if (buildPath && named.has("sca")) {
        meta.buildFile = buildPath;
      }
      for (const line of loopPromptLines(
        texts,
        first.phase,
        first.steps,
        {
          review: state.review,
          command: `node verify.js --llm-verdict ${state.review}`,
          schemaCache: state.paths.schemaCache ?? "",
          description: summaryPath ?? "",
          build: buildPath ?? "",
          scaRoot: state.paths.scaRoot ?? "",
          package: state.paths.package,
        },
        // The preamble prints once, and this is the run that is once.
        true
      )) {
        report(line);
      }
    }
  }
  // The prompt IS the whole output of a run that hands out a phase. Neither the header
  // nor the Summary is printed beside it:
  //
  // - the header is a block of VALUES the steps point at by name, and this prompt's steps
  //   carry the two they use. A name printed with no step behind it is an instruction with
  //   nothing to do.
  // - the Summary is a tally of a review that is about to change. The agent is here to
  //   withdraw findings and settle cases; a count printed before it starts is a number it
  //   could work back from, and the finished report carries the real one.
  if (!prompting) {
    for (const line of headerLines(meta)) {
      report(line);
    }
    report("");
  }

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
  // computed in Phase 2 by `vendor-xpi`); otherwise classify now.
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
 *
 * Runs once per artifact - the shipped one, and in a source review the readable source -
 * which are two steps of the setup list under one label (SETUP_STEPS).
 * @param {import("./addon/load.js").Addon} addon  The review target, already classified.
 * @param {{schema: object,
 *   xpiAddon: import("./addon/load.js").Addon}} deps
 * @returns {import("./addon/sources.js").JsSource[]}  The parsed review sources.
 */
function extractReview(addon, { schema, xpiAddon }) {
  const jsSources = collectJsSources(addon);
  const experimentNamespaces = isExperiment(xpiAddon.manifest)
    ? experimentApiNamespaces(xpiAddon.manifest, addon.files)
    : null;
  runExtractionPass(jsSources, {
    schema,
    nonAuthored: addon.bundled.nonAuthored,
    experimentNamespaces,
  });
  return jsSources;
}

/**
 * Second-tier library identification over an already-classified add-on: reconcile the
 * not-popular declared (VENDOR/package) results into the untrusted family, then match the
 * still-unrecognized bundles against jsDelivr by content hash. Reads/writes addon.bundled
 * and addon.vendor; best-effort, and skips silently offline. Runs AFTER classification (so
 * the Mozilla-hash matches and tag.obfuscation are final), and before the OSV audit of what
 * it identified (auditIdentifiedLibraries), which is the setup step after it.
 * @param {import("./addon/load.js").Addon} addon
 * @param {{net?: object, cacheDir?: string, cdnEnabled?: boolean}} opts
 */
async function identifyBundledLibraries(
  addon,
  { net, cacheDir, cdnEnabled = true }
) {
  applyUnverifiedVendor(addon);
  await resolveCdnLibraries(addon, { net, cacheDir, enabled: cdnEnabled });
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
 * The blind-spot sweep for this review: the shared method plus the bare items, or null
 * when no check that ran authors one.
 *
 * One object rather than a list, because it is ONE request. The intro says how to judge;
 * each item says only what its own check is looking for. Split the other way - method
 * repeated on every item - and eight near-identical paragraphs teach a reader to skim the
 * part that matters.
 *
 * Both intros travel: the report prints the human one, the sweep's rows carry the agent
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

/**
 * Whether the cached schema snapshot is too old to review this add-on against: its cap
 * reaches past every cached train, so the schema cannot know the APIs in between, AND the
 * snapshot is more than a day old, so a newer one plausibly exists. An add-on with no cap
 * has an infinite one, which is why the age test carries the weight - without it every such
 * add-on would re-download six zips on every run.
 * @param {{cap: number, newest: number, ageDays: number}} state
 * @returns {boolean}
 */
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
 * an SCA submission is ALWAYS reviewed as SCA. Routing on this would let a wrong answer
 * silently narrow the review, and no content test can be trusted with that: a committed,
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
 *    exist, byte-identical, in the archive). Without it the first two answer "is the
 *    XPI readable?" and call it "is the XPI the source?", and every real bundler
 *    submission - webpack, Vite, a build that copies from submodules - is told its
 *    archive is unnecessary.
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
