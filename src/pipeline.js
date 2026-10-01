// The review pipeline: opts in, a structured Review out. This is the tool's
// core, independent of the CLI front-end (cli.js) - the test harness drives it
// directly. It loads the add-on, resolves and verifies its vendored
// declarations, classifies bundled code, runs the schema review, and fills each
// finding's display text from the registry. It returns the Review. Formatting
// and I/O are the front-end's job. The submission itself is never modified or
// repacked: the one thing this writes of it is a copy, the packed .xpi extracted
// to XPI_ROOT so every reader - the checks, a reviewer, an agent - reads one
// unpacked tree rather than the tool holding a second one of its own.
//
// Belongs here: the declared setup plan (SETUP_STEPS), the stage orchestration
// (runPipeline) and the pipeline-level schema-selection helpers
// (resolveReviewSchema, selectSchemaChannel, detectManifestVersion).
//
// Does NOT belong here: the cache defaults and behavior toggles -
// src/config.js. The schema channel set + branch names - src/schema/fetch.js.
// Argv parse, validation, and printing (src/cli.js and
// src/report/format.js); each stage's own work - add-on load
// (src/addon/load.js), vendor resolution/verification (src/vendor/*), schema
// fetch/load/index (src/schema/*), check orchestration and run context
// (src/checks/registry.js and src/checks/context.js), and all user-facing text
// (src/checks/registry.js plus src/report/responses.js).

import { ARTIFACT_XPI, artifactRoots } from "./lib/artifacts.js";
import fs from "node:fs";
import path from "node:path";
import { extractionDestination, EXTRACTED_SUFFIX } from "./util/dest.js";
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
  loadSourceArchive,
  readWebExtManifest,
  scaViews,
} from "./addon/load.js";
import { settleScaRoot } from "./addon/sca-root.js";
import { runChecks, loadRegistry, ctxForRule } from "./checks/registry.js";
import { analyzeBuild } from "./build/analyze.js";
import { withExperiment } from "./addon/store.js";
import { buildXpiCtx, buildScaCtx, buildAllCtx } from "./checks/context.js";
import {
  renderFindings,
  renderManualItems,
  withDefaultNotes,
} from "./report/responses.js";
import { resolveHolds } from "./report/finding.js";
import { orderReview } from "./report/order.js";
import { earlyExitOf, withoutQuestions } from "./report/early-exit.js";
import { STATE_VERSION } from "./report/state.js";
import { issue, reviewDetails } from "./report/loop.js";
import { headerLines, loopPromptLines, schemaLines } from "./report/format.js";
import { reviewFilePaths } from "./report/items.js";
import { writeSweepFiles, sweepSlots } from "./report/sweep-files.js";
import { sweepRun } from "./checks/registry-vocabulary.js";
import { resolveVendor } from "./vendor/resolve.js";
import {
  verifyVendor,
  verifyVendorDeclarations,
  verifyScaDependencies,
  auditIdentifiedLibraries,
} from "./vendor/verify.js";
import { classifyBundled, applyUnverifiedVendor } from "./lib/bundled.js";
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
import {
  experimentApiMembers,
  experimentApiNamespaces,
} from "./lib/experiments.js";
import { verifyExperiments } from "./experiments/verify.js";
import { debug, progress, report, warn, FEED } from "./util/log.js";
import { DEFAULT_CACHE } from "./config.js";
import { rethrowIfFatal, sealArtifact } from "./lib/errors.js";

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
// One predicate per PHASE, not per step. Every step inside a phase acts on the same
// artifact, so every one of them runs exactly when that artifact is there to act on -
// written once here rather than decided again, identically, by each step.
/** A reviewable add-on: everything but the one reject check a rejected Experiment gets. */
const REVIEWED = (f) => !f.invalidExperiment;
/** There IS a source archive: the phase that prepares it, and nothing else, needs this. */
const ARCHIVE = (f) => f.sca && !f.invalidExperiment;

export const SETUP_STEPS = Object.freeze([
  // PHASE 1 - the REVIEW-LEVEL answers, and the one gate they decide. Each of these
  // produces something the whole review shares rather than something an artifact owns:
  // the loaded artifact and its manifest.json record, the schema, the Experiment verdict
  // (+ invalidExperiment, which gates every phase below). That is why the Experiment
  // steps are here even though they read the XPI - their product is projected through
  // `env` to every sibling, never stapled to an artifact. Phases 2-4 are the opposite:
  // each produces state that belongs to ONE artifact, one phase per artifact.
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
  { key: "experiment-schema", when: (f) => f.isExp && REVIEWED(f) },
  // PHASE 2 - the SHIPPED XPI. Both modes run all of it: the artifact users install is
  // analysed the same way whether or not a source archive came with it.
  { key: "hashes", label: "Fetching library hashes", when: REVIEWED },
  { key: "vendor-xpi", label: "Verifying vendored libraries", when: REVIEWED },
  {
    key: "cdn-bundled",
    label: "Identifying bundled libraries on a CDN",
    when: REVIEWED,
  },
  // The two parses - the shipped artifact's and, in a source review, the readable source's
  // - are separate steps under one label.
  { key: "parse-xpi", label: "Parsing add-on sources", when: REVIEWED },
  // What the submission IS, and what this review makes of it: the submitted source archive,
  // the review target, and the record of what was reviewed. The target is two entries rather
  // than one arm each side of an `if`, so the list - not a branch inside a step - holds the
  // pin that a REJECTED Experiment is reviewed as its shipped XPI even with --sca-root,
  // and `meta` is reached on every path.
  { key: "source-archive", when: REVIEWED },
  { key: "target-source", when: ARCHIVE },
  { key: "target-xpi", when: (f) => !f.sca || f.invalidExperiment },
  { key: "meta", when: () => true },
  // An XPI review's target IS the built XPI, parsed above; there is nothing left to do but
  // hand those sources on.
  { key: "xpi-sources", when: (f) => !f.sca && REVIEWED(f) },
  // PHASE 3 - the SOURCE ARCHIVE's own preparation, and the build the reviewer reproduces.
  // Only an archive has any of this: dependencies it installs rather than ships, a build to
  // trace, readable source to parse. An XPI review reaches none of it.
  {
    key: "vendor-source",
    label: "Verifying vendored source libraries",
    when: ARCHIVE,
  },
  { key: "deps-source", label: "Auditing source dependencies", when: ARCHIVE },
  {
    key: "cdn-source",
    label: "Identifying source libraries on a CDN",
    when: ARCHIVE,
  },
  { key: "parse-source", label: "Parsing add-on sources", when: ARCHIVE },
  { key: "build", label: "Analyzing the build", when: ARCHIVE },
  // PHASE 4 - the REVIEW TARGET. One audit, over whichever artifact this review is about,
  // recorded on that artifact - so the checks reading it find it in both modes without any
  // of them naming an artifact. Last, because it needs the target's libraries identified
  // first: phase 2 does that for an XPI review, phase 3 for a source review.
  { key: "audit", label: "Auditing libraries", when: REVIEWED },
]);

/**
 * Every path opt is ABSOLUTE. The arg-array reader resolves them (pipelineOptsFromValues,
 * src/cli.js), which is the one layer that knows what each flag was written relative to -
 * the working directory for --sca-root, and --sca-root itself for --sca-exp-source. Nothing here re-resolves one, and a caller handing in a relative path gets
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
 * @property {boolean} [warningsAsErrors]  Read every warning as an error for this review
 *   (--warnings-as-errors): the band the registry hands out IS an error, so the report,
 *   the tally, the early exit and the exit code all follow (src/checks/registry.js
 *   bandUnder). Off by default.
 * @property {string} [scaRoot]  SCA mode: the source archive root, absolute - an extracted
 *   folder holding package.json/lock. Setting it switches the
 *   review to SCA mode - the whole archive is reviewed as the readable source and its
 *   declared dependencies are audited; the positional XPI is the shipped artifact against which
 *   the manifest.json, experiments and file-completeness (`input: xpi`) checks all run (a
 *   separate shipped context the orchestrator routes them to - see buildXpiCtx in
 *   src/checks/context.js).
 * @property {string} [scaExpSource]  SCA mode: the Experiment implementation folder,
 *   absolute and inside scaRoot, never scaRoot itself. It reaches the review as an archive
 *   partition (scaViews), which gives it its own view; where it sits WITHIN the review
 *   source is derived at the one read that wants it (src/lib/reachability.js), in the
 *   keyspace the review target's keys live in. Its privileged, non-WebExtension files are
 *   excluded from the WebExtension code checks (which review all of the readable source,
 *   having no reachability tree there). REQUIRED in SCA mode when the add-on is an
 *   Experiment (runPipeline refuses to start): without it, Experiment code cannot be told
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
  // SCA (source code archive) mode is on when --sca-root is set, and the whole of that
  // root is the review source. It splits the review across TWO add-on artifacts with a fixed
  // ROLE each, resolved here ONCE so nothing downstream re-branches on the mode:
  //
  //   xpiAddon - the built XPI (the positional addonPath). The SHIPPED artifact,
  //     authoritative in BOTH modes for the manifest.json, the experiments, and the
  //     behavioral review summary (what actually runs on a user's machine).
  //   reviewTarget - whichever artifact this review is OF: the code the source-level
  //     checks scan, and what becomes siblings.source. In XPI mode it IS xpiAddon; in
  //     SCA mode it IS scaArchive, which scaViews gave the views a source review reads.
  //     Anything that wants ONE artifact whatever the mode names that one directly, which
  //     is what keeps the checks mode-agnostic without a mode test here.
  //
  // So downstream: read `reviewTarget` for the code under review, `xpiAddon` for the
  // shipped artifact - no further mode checks. The only other mode forks are the
  // dependency resolution (--sca-root vs the XPI's VENDOR/package.json) and the
  // check gate (ctx.mode -> modeEligible). Minified code is non-authored (and rejected)
  // in both modes: a source-code submission's promise is readable source, so a minified
  // file in the archive is rejected like one in an XPI, not scanned as authored.
  // The source view holds every file but the Experiment, and collectBuildFiles traces the
  // build over both off the root package.json - the code and the tooling are one set of
  // files, which is what the build checks want.
  //
  // The review mode is DERIVED from the two facts below and assigned nowhere, so it cannot
  // drift from the steps that ran: --sca-root makes it a source code review, and a REJECTED
  // Experiment takes it back to an XPI review (its rejection is decided from the shipped XPI
  // alone, so the readable source is never read). Setup itself never reads it - each step
  // says which facts it needs - and everything after setup reads the one derivation.
  // The parsed registry, threaded from main() (or loaded once here when a caller
  // such as the test harness invokes the pipeline directly), read under THIS run's band
  // policy. Applied here rather than at either construction site, so a caller that hands one
  // in and a caller that leaves it to be loaded get the same reading of the same flag.
  const registry = (opts.registry ?? loadRegistry()).withPolicy({
    warningsAsErrors: Boolean(opts.warningsAsErrors),
  });

  // Which folder is the source root, settled before anything reads it
  // (src/addon/sca-root.js). Whoever named --sca-root had not looked inside it yet - an
  // archive is extracted by the reader of the --llm-sca-review prompt, into a destination
  // worked out by path math - so an archive carrying its contents in one directory of its own
  // leaves the build files a level below the root it was given.
  //
  // Rebound onto `opts`, once, rather than threaded: every reader below asks opts.scaRoot,
  // and a settled value beside the one it was given is two answers to one question. The
  // narration comes later, with the rest of Setup.
  const scaMove = settleScaRoot(opts);
  opts = { ...opts, ...scaMove };

  // Load the .xpi. Read before the "Setup" banner because it sizes the feed - it gives
  // the mode and whether the add-on is an Experiment. Every slow NETWORK step below (the
  // experiment fetch, schema fetch, vendor verification, CDN lookups) plus the AST parse
  // is narrated as a Setup step. The add-on reads are fast local ones (this .xpi, and in
  // a kept SCA the source archive loaded in Phase 2) marked by the "Reading add-on" step.
  // Loading here is the ONLY way an add-on enters a review: its content and its identity
  // then come from one value, and no caller can hand in files that disagree with the path
  // the report goes on to name.
  //
  // A packed .xpi is extracted here, not read in memory and left there: XPI_ROOT is a
  // single folder this run writes once and every reader - the checks below, a reviewer,
  // an LLM agent - reads back from, never two representations of one submission. An
  // already-unpacked submission needs none of that; it already IS the folder.
  const addonIsDir = fs.statSync(path.resolve(addonPath)).isDirectory();
  const extractTo = addonIsDir
    ? null
    : extractionDestination(`${addonPath}${EXTRACTED_SUFFIX}`);
  const xpiAddon = loadAddon(addonPath, extractTo ?? undefined, {
    kind: ARTIFACT_XPI,
  });
  // What the SHIPPED add-on declares, read ONCE here and the review's only record: it is
  // asked of the built XPI by name rather than derived by whatever loads an artifact (a
  // source archive's root manifest.json is a pre-build template, and nothing asks it). One
  // record, so the name needs no artifact to tell it from another.
  const webExtManifestRecord = readWebExtManifest(xpiAddon.store);
  // The Experiment verdict, likewise the SHIPPED add-on's and likewise shared rather than
  // stapled to an artifact: it reaches the checks as ctx.experiments. Named for its type
  // (ExperimentVerification) rather than for the artifact, because there is only ever one.
  let experimentVerification = null;
  const xpiRootBase = addonIsDir ? addonPath : extractTo;
  const xpiRoot = xpiRootBase.endsWith(path.sep)
    ? xpiRootBase
    : `${xpiRootBase}${path.sep}`;
  const isExp = isExperiment(webExtManifestRecord?.json);

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

  /** The review target (it becomes ctx.artifact): the readable source, or the shipped .xpi - whichever
   * of `target-source` / `target-xpi` this review runs. */
  let reviewTarget;
  /** The submitted source archive: read by `source-archive`, reused by `target-source`
   * and `build`. */
  let scaArchive;
  /** The review schema (indexed) and the stamps meta publishes for it. */
  let schema;
  let schemaSource;
  let schemaBranch;
  let schemaChannel;
  // The known-library hash DB the bundled classifier matches files against. An empty Map
  // recognizes nothing.
  let libraryHashes = new Map();
  // The parse-first REVIEW-TARGET sources handed to the ctx builders (Phase 5), which never
  // parses for itself. In an XPI review the review target IS the built XPI, so these ARE
  // xpiParsedSources; in SCA they are the readable source's, parsed in Phase 3. Stays
  // unset for a rejected Experiment (its one check reads no code - an empty ctx.jsSources).
  let preParsedJsSources;
  // The BUILT XPI's sources, from the FULL extractReview run on it in Phase 2 (always, unless a
  // rejected Experiment). buildXpiCtx (Phase 5) hands them to the input:xpi checks, so the
  // shipped ctx is built ONE way regardless of mode; in an XPI review they ALSO ARE
  // preParsedJsSources (the XPI is the review target).
  let xpiParsedSources;
  // The banned-library list (assets/library-blocks.yaml), resolved once in Phase 2 and shared
  // by every artifact's analysis (the XPI in Phase 2, the archive in Phase 3) and by the
  // review target's audit in Phase 4.
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
    // XPI's manifest.json alone (manifest_version + strict_max_version pick the channel), so it
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
        manifest: webExtManifestRecord?.json ?? null,
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
    // reviewTarget in XPI mode). They are privileged, non-bundled, readable code, and the
    // manifest.json's experiment paths resolve against the XPI's own files (no
    // source-layout mismatch).
    experiments: async () => {
      experimentVerification = await verifyExperiments(
        xpiAddon,
        webExtManifestRecord,
        opts
      );
      invalidExperiment =
        !opts.allowExperiments &&
        experimentVerification.groups.some((g) => g.status === "unsupported");
    },

    // A valid Experiment's declared APIs are part of its platform: register each
    // namespace it adds, with the members its own schema declares, so the developer's
    // calls into them (e.g. browser.calendar.*) resolve instead of tripping unknown-api
    // - and a call to a member the schema does NOT declare still does, because it
    // reaches nothing at run time. A namespace whose schema could not be read registers
    // opaque. From the XPI (in SCA the experiment schema/scripts live in the built XPI,
    // so the manifest.json's paths resolve there).
    "experiment-schema": () => {
      schema.registerExperimentApis(
        experimentApiMembers(webExtManifestRecord?.json, xpiAddon.files)
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

    // Phase 2: the SHIPPED XPI's analysis, and what this review makes of the
    // submission. Both modes run all of it - the XPI is analysed the same way either way.

    // Analyse the BUILT XPI FIRST, with the SAME full chain an XPI review
    // runs on its review target - resolveVendor -> verifyVendor -> classifyReview ->
    // identifyBundledLibraries -> audit -> extractReview - so siblings.xpi is built ONE way
    // regardless of which mode this review turns out to be. The vendor-aware classification
    // it produces (xpiAddon.bundled) is what keeps a vendored library from being read as
    // the developer's code: verifyVendor DISCOVERS vendored files, and classifyReview marks
    // them non-authored AND leaves them out of `classified` altogether, so a minified
    // vendored library is not counted against the developer by unused-files. In a native XPI
    // review the XPI IS the review target, so this is that review's own analysis, and
    // `xpi-sources` hands those parsed sources on rather than parsing again.
    "vendor-xpi": async () => {
      // A VENDOR file or a package.json is read from the artifact that IS the review
      // target. In a source review that is the archive: the declarations there are the
      // ones the reviewer reads and the build installs from, and a copy shipped inside the
      // XPI is a second, unverified answer to the same question - which the source review
      // has no use for, and sca-xpi-declares-vendoring reports as the mistake it is. So the
      // XPI gets a vendor reading only when it is the review target.
      //
      // The condition is the MODE, not an identity test against reviewTarget: that does not
      // exist yet here - `target-xpi` settles it later in the list - and other step bodies
      // read setupFacts.sca the same way.
      if (!setupFacts.sca) {
        xpiAddon.vendor = resolveVendor({ addon: xpiAddon });
        await verifyVendor(xpiAddon, opts.vendorNet, libraryBlocks);
      }
      // Classification runs on the XPI in BOTH modes: what its bytes ARE - a known library,
      // minified, obfuscated - is a fact about the artifact, not about the review, and the
      // input:xpi checks read it either way.
      classifyReview(xpiAddon, { libraryHashes });
    },
    "cdn-bundled": () =>
      identifyBundledLibraries(xpiAddon, {
        net: opts.vendorNet,
        cacheDir: opts.cdnLookupCache,
        cdnEnabled: opts.cdnLookup !== false,
      }),
    "parse-xpi": () => {
      xpiParsedSources = extractReview(xpiAddon, {
        schema,
        webExtManifestRecord,
      });
    },

    // The submitted source archive, walked ONCE and split here into the two views every
    // later reader takes its part from (src/addon/load.js scaViews). It is done here
    // because the XPI-only ADVICE below asks both what KIND of source the archive carries
    // and whether the shipped scripts ARE that source - which needs bytes, not just names.
    // Reading them costs nothing extra: the store reads a file once and the views share it.
    "source-archive": () => {
      if (setupFacts.sca) {
        // Said where the source archive is read, because that is what it is about, and said
        // at all because the root reviewed is then not the root the command named - the
        // reviewer has to be able to see which folder their verdicts are about.
        if (scaMove.movedFrom) {
          progress(
            `Source root: ${opts.scaRoot} (${scaMove.movedFrom} holds no package.json)`,
            FEED.DETAIL
          );
        }
        // The two ways a submitted source archive is not an add-on. An installed
        // dependency tree is not content: the reviewer installs it from the declared
        // package file and lock, so a committed one is recorded and rejected rather than read.
        // And a root manifest.json here is a PRE-BUILD template, not what Thunderbird
        // loads, so none is read - ctx.manifest is the shipped one and must be the only
        // answer. The built add-on above is loaded the ordinary way, where a node_modules
        // folder is shipped content like any other and the manifest.json IS the artifact's.
        // The archive cannot say which of its folders holds the Experiment - only the
        // flag does - and without it the privileged code is reviewed as WebExtension code
        // and rejected for being what an Experiment is. So the review does not start.
        if (isExp && !opts.scaExpSource) {
          throw new Error(
            "This add-on ships an Experiment (its manifest.json declares experiment_apis): " +
              "name the folder of the source archive that holds the Experiment " +
              "implementation with --sca-exp-source."
          );
        }
        scaArchive = loadSourceArchive(opts.scaRoot);
        scaViews(scaArchive, {
          scaRoot: opts.scaRoot,
          scaExpSource: opts.scaExpSource,
        });
      }
    },

    "target-source": () => {
      reviewTarget = scaArchive;
      for (const notice of scaArchive.skipped ?? []) {
        warn(notice);
      }
      // Warn when --sca-exp-source matches nothing: a mis-typed path would exclude nothing
      // and flood the report with false positives on the privileged Experiment code.
      if (opts.scaExpSource && scaArchive.experiment.size === 0) {
        warn(
          `--sca-exp-source "${opts.scaExpSource}" matched no files under --sca-root; ` +
            "nothing will be excluded from the WebExtension code checks."
        );
      }
    },

    // The review target of every other review: the .xpi itself. A native XPI review takes
    // this arm, and so does a REJECTED Experiment even with --sca-root - its rejection is
    // decided entirely from the shipped XPI, so the readable source is never read.
    "target-xpi": () => {
      reviewTarget = xpiAddon;
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
        // Where the shipped package IS on disk, readable, whether that took extracting it
        // or the submission already was a folder - set once, above, alongside loading it.
        // Always present: unlike the LLM-only files below, nothing here is conditional on
        // how this review is being run.
        xpiRoot,
        // What was submitted, by NAME rather than by path: an .xpi arrives from ATN named
        // for the add-on and its version, which is what a reviewer recognises it by and
        // what they say back when they talk about it. The folder's name where the
        // submission was already unpacked, which is the same thing said the same way.
        xpiFile: path.basename(addonPath),
        // Named iff the readable source is what was reviewed: `scaArchive` is set by
        // `source-archive`, which runs only then. meta names the artifacts this review
        // READ, so the step that loaded one is what decides whether it appears here.
        ...(scaArchive
          ? {
              scaRoot: opts.scaRoot,
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

    // Phase 3: the SOURCE ARCHIVE's own preparation - the same chain
    // the XPI got in Phase 2 (declared-dependency audit, classify, identify, parse), plus the
    // build trace.

    // Resolve the source's dependency declarations ONCE (package.json deps + any VENDOR
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
      // The archive's lock IS what the reviewer installs from, so it resolves a ranged
      // spec to the exact version audited. The XPI above gets no such reading: a lock has
      // no place inside a built add-on, so one found there would only launder a range.
      reviewTarget.vendor = resolveVendor({
        addon: reviewTarget,
        reviewerInstalls: true,
      });
      await verifyVendorDeclarations(
        reviewTarget,
        opts.vendorNet,
        libraryBlocks
      );
    },

    // The source's package.json declares its dependencies - audit each for popularity
    // (non-popular -> reject) and OSV. The readable source may ALSO vendor a library as a
    // committed copy, so full identification (Mozilla-hash + CDN + OSV, deduped against the
    // declared audit) runs on it below. An unrecognized minified file the source vendors
    // stays non-authored and is rejected.
    // Classify the source's files (library hash, minified geometry, obfuscation), seeding
    // reviewTarget.bundled and its non-authored set - AFTER the declaration audit, so the vendored
    // set is final (verifyScaDependencies DISCOVERS further vendored files that classifyFiles
    // reads).
    "deps-source": async () => {
      await verifyScaDependencies(reviewTarget, opts.vendorNet, libraryBlocks);
      classifyReview(reviewTarget, { libraryHashes });
    },

    // Identify the UNDECLARED libraries the audit cannot see (jsDelivr hash), and
    // applyUnverifiedVendor removes a readable not-popular vendored copy from the skip set;
    // this FINALIZES the authored / non-authored split, so it must precede `parse-source`.
    "cdn-source": () =>
      identifyBundledLibraries(reviewTarget, {
        net: opts.vendorNet,
        cacheDir: opts.cdnLookupCache,
        cdnEnabled: opts.cdnLookup !== false,
      }),

    // Parse the source ONCE, with the FINAL skip set (see extractReview).
    "parse-source": () => {
      preParsedJsSources = extractReview(reviewTarget, {
        schema,
        webExtManifestRecord,
      });
    },

    // Look at the build ONCE here (the vendor pattern), over EVERY file the archive holds -
    // the Experiment folder included - because a build step may reference any of it, and a
    // step the trace cannot see raises no signal for the reviewer to follow. A script kept
    // under the Experiment folder runs on the reviewer's machine like any other. What was
    // found is stored on reviewTarget.buildReview for the input:sca checks to read. Nothing
    // classifies what the build DOES, so it routes to the reviewer, who reproduces it from
    // the source by hand.
    build: () => {
      reviewTarget.buildReview = analyzeBuild({
        build: { files: withExperiment(reviewTarget) },
      });
    },

    // Phase 4: the REVIEW TARGET. Last, because it needs the target's libraries identified
    // first - Phase 2 does that for an XPI review, Phase 3 for a source review.

    // ONE audit, over the REVIEW TARGET, recorded on the review target. The checks that
    // read it - a published advisory, a policy-blocked release, a library nothing could be
    // asked about - are routed to the target too, so they find it in both modes and none of
    // them names an artifact. Auditing the shipped XPI as well, in a review whose target is
    // the archive, wrote an answer nothing was routed to read.
    audit: () =>
      auditIdentifiedLibraries(reviewTarget, opts.vendorNet, libraryBlocks),
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

  // The step list is done, so what each artifact carries is settled. Close them against
  // reads of what was never computed for them: a field only some artifacts have - a vendor
  // reading, a build trace - answers `undefined` otherwise, and a check that reads
  // `undefined` finds nothing, which reads as a clean submission. From here such a read
  // throws, so a wrongly-routed check is a wiring error that reaches the exit instead of a
  // silent pass.
  sealArtifact(xpiAddon, "built XPI");
  if (scaArchive && scaArchive !== xpiAddon) {
    sealArtifact(scaArchive, "source archive");
  }

  // Phase 5: build the sibling RunContexts the checks read, once the step list has run. The
  // review-level singletons are built ONCE here and shared by every sibling ctx, so they can
  // never drift between artifacts or double-cost. Nothing is parsed here: Phase 2/3 parsed
  // each artifact's sources.

  // Both facts are settled - the loop has run - so the review mode follows from them.
  const mode = setupFacts.mode;

  // The shared review env every sibling ctx projects (buildXpiCtx / buildScaCtx). The
  // manifest.json and experiments are the SHIPPED artifact's - authoritative like the schema, so no
  // artifact's own template can shadow them. Only what a check reads goes on `options`.
  const env = {
    schema,
    options: { allowExperiments: opts.allowExperiments },
    mode,
    invalidExperiment,
    manifest: webExtManifestRecord,
    experiments: experimentVerification ?? null,
  };

  // From the built XPI's analysis, which every reviewable path runs: the shipped ctx, for the
  // input:xpi checks - the structure checks and the manifest.json checks alike, since the
  // shipped manifest.json is this artifact's.
  const xpiCtx = buildXpiCtx(xpiAddon, xpiParsedSources, env);
  // The submitted archive, which only a source review has. One ctx over one artifact: the
  // build checks and the code checks read the same object, and what separates them is the
  // route each declared, not a second narrowed projection.
  const scaCtx = mode.sca
    ? buildScaCtx(reviewTarget, preParsedJsSources, env)
    : null;
  // The sibling ctxs keyed by the `input` value that routes to each (see routeCtx). Routing
  // is total: `source` is a first-class key, but it is a POINTER and not a ctx of its own -
  // it names the REVIEW TARGET, which is the archive in a source review and the XPI
  // otherwise, so it is always one of the two beside it. A check routed to one sibling can
  // never reach another's artifact.
  const siblings = {
    source: scaCtx ?? xpiCtx,
    xpi: xpiCtx,
    sca: scaCtx,
    // Every artifact this review has, named: two in a source review, one otherwise. The
    // sibling always exists, because the route says "whatever is here" rather than "two" -
    // so an `input: all` check runs in either mode and tests for what it needs. Built from
    // the per-artifact ctxs, never from `source` above: that one ALIASES, so reading it
    // here would hand an XPI review the same artifact twice.
    all: buildAllCtx(env, { xpi: xpiCtx, sca: scaCtx }),
  };

  // Phase 6: run the review, then finalize. runChecks runs the phase this review calls
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
    manifestVersion: webExtManifestRecord?.json?.manifest_version ?? null,
    checksRun: checksRun.map((c) => c.id),
    // The three to-do origins as ONE list, each carrying its own `default-note` where the
    // check authors one: a case a check escalated and a by-hand manual check are the same
    // item to whoever answers it, so the note is appended to both in one place.
    manualReview: invalidExperiment
      ? []
      : withDefaultNotes(
          [
            ...renderManualItems(manualItems, registry, mode).map((m) => ({
              ...m,
              extended: true,
            })),
            ...registry
              .manualChecks(mode)
              .map((m) => ({ ...m, extended: false })),
          ],
          registry
        ),
    // The blind-spot sweeps to run BEFORE settling this review: one bare item per sweep a
    // check that ran authors, asked as one request per tree rather than one per item - the
    // sweeps of a tree read the same files, so what is learned on one is already in hand
    // for the next. Registry-sourced and carried by every review, exactly like the by-hand
    // manual-checks above, which is why it travels on meta: the text renderer never sees
    // the registry.
    //
    // Gated on the checks that actually RAN: sweeping the blind spot of a scan that did
    // not happen asks a reader to cover for nothing, and this is what makes
    // --checks-only/--checks-skip carry through. An Experiment reject carries none, for
    // the same reason it carries no manual review.
    preSweep: invalidExperiment
      ? null
      : preSweepOf(registry, ranIds, mode, siblings, artifactRoots(meta)),
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
  let reportPath = null;
  // Each tree's sweep pair, by artifact - empty when this run sweeps nothing. The keys
  // are what says which trees were asked: a step prints for one, and accepting the pass
  // reads back exactly these.
  let sweepFiles = {};
  // The REVIEW LOOP's state, built once the review is final and handed to `issue` below.
  // A LOCAL, never hung off meta: it carries the report, and the report carries meta.
  let loopState = null;
  // Whether this run SWEEPS: it asked for one, it was not told to leave it out, and there
  // is a blind spot to cover. The requests hang off this, and the per-tree conditions that
  // print a step hang off the requests - so a review with nothing to sweep and one told
  // not to read the same, and neither mentions a sweep that is not happening.
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
    const files = reviewFilePaths(addonPath);
    summaryPath = skip.includes("summary") ? null : files.summary;
    buildPath = mode.sca ? files.build : null;
    // Ungated, unlike the two above: every review has a report, and this one is written by
    // the linter (src/report/report-file.js) rather than asked of an agent, so there is no
    // step whose absence could leave the path naming nothing.
    reportPath = files.report;
    // Named on meta BEFORE the state is built: `issue` writes the state, and a field set
    // after that never reaches the passes that read it back. A path printed for a file
    // nobody is asked to write would be an instruction with no step behind it - which is
    // why the first two are null above unless the step that writes them prints: the
    // description is withheld by --llm-skip-summary, the build report by a review that is
    // not a source code one.
    meta.summaryFile = summaryPath ?? undefined;
    meta.buildFile = buildPath ?? undefined;
    meta.reportFile = reportPath;
    // The three above land BESIDE the submission, and this run writes none of them: the
    // description and the build report are written by the agents this prompt hands out, and
    // the report by a later pass. So a folder that cannot be written to has to be refused
    // HERE - otherwise it surfaces after the review is over, and under --llm-review after
    // an agent has been paid to produce a description it cannot save.
    //
    // The directory, not the files: writeFileAtomic writes a sibling .tmp and renames over
    // the target (src/util/atomic.js), so what those writes need is permission on the
    // folder. Asked once, because all three are in it.
    const beside = path.dirname(addonPath);
    if (!canWriteDir(beside)) {
      throw new Error(
        `The review's files land beside the submission, in "${beside}", and this run ` +
          "cannot write there. The description and the build report are written by the " +
          "agents this prompt hands out, and the report by a later pass, so nothing would " +
          "have failed until the review was already finished. Point the review at a " +
          "submission in a folder you can write to."
      );
    }
    // The REVIEW LOOP's pair, named here for the passes that read them back. Not checked
    // like the folder above: they live in the system temp directory, writeState creates
    // into it (src/report/state.js), and nothing a reviewer keeps is written there.
    meta.stateFile = files.state;
    meta.reviewFile = files.review;
    // One sweeping agent per tree, each handed a request of its own and an answers file
    // of its own. Written HERE, with the review, because the request carries the tree's
    // path and the sweeps that tree was asked about - both of which are this run's
    // answers and neither of which a later pass could reconstruct.
    //
    // Nothing is written for a review that is not sweeping: --llm-skip-sweep withholds
    // the asking though the instructions still stand, and then there is no request to
    // make and no file for a step to name.
    sweepFiles = sweeping
      ? writeSweepFiles(files, meta.preSweep, artifactRoots(meta))
      : {};
  }

  // Fill each finding's display message from its registry response (with the
  // {{item}} placeholder), so the Found Issues section reports the ready-to-send
  // wording. The registry is the only source of this text.
  renderFindings(findings, registry, mode);

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
    // issueHeadings and verdictIntros are the registry's, and a copy here would
    // outlive an edit to it.
    loopState = {
      version: STATE_VERSION,
      review: meta.reviewFile,
      report: { findings, meta, sca: mode.sca },
      manual: meta.manualReview,
      preSweep: meta.preSweep,
      // What this run was told, recorded ONCE. Every pass reads it from here - a second
      // copy handed in beside the state is a second answer, and the two deciding
      // differently is a phase issued for entries it never shows.
      run: {
        skip,
        sca: mode.sca,
        // One condition per tree that has a sweep to run, keyed the way the step names
        // it. Read off the FILES rather than off `sweeping` and `preSweep` separately:
        // a step exists to send an agent at a request, so the request existing is the
        // whole condition, and --llm-skip-sweep leaves none behind.
        ...Object.fromEntries(
          Object.keys(sweepFiles).map((a) => [sweepRun(a), true])
        ),
        // The band policy, so a later pass reads the review under the one it was started
        // with. The findings below are already published at it, but a case REPORTED on a
        // later pass becomes a finding there and then (src/report/verdicts.js asFinding),
        // and that pass is never handed the flag again.
        warningsAsErrors: registry.warningsAsErrors,
      },
      sweep: null,
      paths: {
        review: meta.reviewFile,
        description: summaryPath,
        build: buildPath,
        report: reportPath,
        schemaCache: opts.schemaCache,
        // The two roots every reported path is relative to, so a later pass can resolve
        // one without the review it came from. A packed submission was extracted in
        // setup, and `--sca-root` is extracted before the run, so both are readable
        // directories by the time anything is handed out.
        scaRoot: opts.scaRoot ?? null,
        xpiRoot: meta.xpiRoot,
        // Where each tree's sweeping agent was sent and where it answers. Carried so the
        // pass that accepts the hand-back reads back exactly the files this run wrote,
        // rather than recomputing a stem it no longer has.
        sweeps: sweepFiles,
        // The schema block a judging phase prints - the snapshot its verdicts mean
        // anything against. Built once, from the same meta the report's header is.
        schema: schemaLines(meta, opts.schemaCache).join("\n"),
      },
      answers: {},
      route: {},
      issued: [],
    };
  }

  // A review the findings themselves settle STOPS here: nothing further is put to a
  // reviewer, and the report says why rather than listing work nobody should do. The case
  // it exists for is a build the reviewer would otherwise be asked to reproduce from a
  // dependency tree this review has already rejected.
  //
  // Applied only for a review that PRINTS one. Under --llm-review the same decision is
  // taken again at the end of the loop (src/report/loop.js settle), because a pass may
  // withdraw the very finding that stopped it - so the state above keeps the full list,
  // and nothing here narrows what a later pass can still change its mind about.
  //
  // AFTER resolveHolds, and that ordering is load-bearing: the threshold reads a
  // finding's severity, and resolveHolds is the moment a provisional hold becomes one.
  // Decided before it, a blocking check that reported a hold would stop nothing.
  //
  // The key is left off a review that did not stop, rather than written as null - the
  // same way manualReview and preSweep are dropped from the JSON rather than emptied.
  if (!prompting) {
    const ordered = orderReview(findings, meta.manualReview ?? []);
    const earlyExit = earlyExitOf(ordered, {}, registry);
    if (earlyExit) {
      meta.earlyExit = earlyExit;
      meta.manualReview = withoutQuestions(ordered);
    }
  }

  // Narrate the document's own opening, now that the review is final. It has to come after
  // resolveHolds, because the Review Details tally counts bands and a hold is not settled
  // until then. Under --llm-review the prompt goes first, so a model handed the review
  // reads what to do with it before anything else.
  //
  // report(), not feed: these belong to the document, so they survive --llm-review
  // switching the Setup and Activity sections off. Absent from JSON (a machine contract)
  // and from the golden harness for free, like the rest of the narration.
  if (prompting) {
    // THE REVIEW LOOP's first pass. The deterministic review just ran, and it runs ONCE:
    // its result goes into the state, and every pass after this reads that instead of
    // rebuilding it. So this is the only run that needs the add-on at all.
    //
    // Which phase goes out is `issue`'s to decide, from what has work - a run with no
    // sweep and no description agent starts at `verify`, and never mentions either.
    const texts = registry.llmPhases();
    const state = loopState;
    const first = issue(state, meta.stateFile, texts.phases, registry);
    if (first) {
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
          schema: state.paths.schema,
          // Named because `ask` can be the FIRST phase issued - a review with no findings
          // and nothing to settle opens there - and that is the phase that hands the
          // block over. A run whose first phase does not name it passes it unused.
          details: reviewDetails(state),
          ...sweepSlots(state),
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
    // Severity-group headings + the verdict preamble for the text Issues
    // section.
    issueHeadings: registry.issueHeadings(),
    verdictIntros: registry.verdictIntros(),
  };
}

/**
 * Whether a directory can be written to, without writing anything to it.
 *
 * The question the review's output folder has to answer before the review is built. Asked
 * of the DIRECTORY because that is what the later writes need: writeFileAtomic creates a
 * sibling .tmp and renames over the target, so both steps want permission on the folder
 * rather than on a file that does not exist yet.
 *
 * A probe that CREATED something would answer the same question and leave litter in a
 * reviewer's folder for a run that may then fail, which is not ours to put there.
 * @param {string} dir
 * @returns {boolean}
 */
function canWriteDir(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (err) {
    rethrowIfFatal(err);
    return false;
  }
}

/**
 * Per-file classification of the REVIEW TARGET (library hash / minified geometry /
 * obfuscation, plus the vendored non-authored seed) -> addon.bundled.
 * It runs before identifyBundledLibraries, which reads its tags (tag.obfuscation) and refines
 * the result.
 * @param {import("./addon/load.js").Addon} addon
 * @param {{libraryHashes: Map<string, {name: string, version: string}>}} deps
 */
function classifyReview(addon, { libraryHashes }) {
  // Reuse the classification when the caller already has one (the SHIPPED XPI carries its own,
  // computed in Phase 2 by `vendor-xpi`); otherwise classify now.
  addon.bundled = addon.bundled ?? classifyBundled(addon, { libraryHashes });
}

/**
 * The single extraction pass over the REVIEW TARGET: parse each source ONCE, extract every
 * per-file result the checks read, drop the AST. Returns the parsed sources for Phase 5.
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
 * @param {import("./addon/load.js").Addon} addon  The artifact to extract, already classified.
 * @param {{schema: object,
 *   webExtManifestRecord: ?import("./addon/load.js").WebExtManifestRecord}} deps  What the SHIPPED add-on
 *   declares: whether this is an Experiment, and which namespaces its APIs own, are its
 *   answers even when the artifact being extracted is the source.
 * @returns {import("./addon/sources.js").JsSource[]}  The parsed review sources.
 */
function extractReview(addon, { schema, webExtManifestRecord }) {
  const jsSources = collectJsSources(addon);
  const experimentNamespaces = isExperiment(webExtManifestRecord?.json)
    ? experimentApiNamespaces(webExtManifestRecord?.json, addon.files)
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
  } catch (err) {
    rethrowIfFatal(err);
    return null;
  }
}

/**
 * Resolve which schema to review against, downloading if needed. The channel is
 * auto-detected from the add-on's version range (see selectSchemaChannel): the
 * cache is first brought to the full canonical set (all channels × both manifest.json
 * versions, re-downloading a missing OR corrupt branch), then the add-on's
 * manifest_version + strict_max_version pick the branch to load.
 *
 * @param {object} params
 * @param {string} params.cacheDir      Schema cache directory.
 * @param {import("./addon/load.js").Manifest} params.manifest  Shipped manifest.json.
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
    schemaSnapshotIsStale({
      cap,
      newest,
      ageDays: schemaCacheAgeDays(cacheDir, candidates),
    })
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
 * The blind-spot sweeps for this review, or null when no check that ran authors one.
 *
 * One flat list, grouped into one request per tree when the requests are written
 * (src/report/sweep-files.js): the method is said once per request and each item says
 * only what its own check is looking for. Split the other way - method repeated on every
 * item - and eight near-identical paragraphs teach a reader to skim the part that matters.
 *
 * This is what BOTH readers get. The report prints it as the Standard Code Review list,
 * and the same items are what each sweeping agent's request file is built from - so a
 * reviewer covering a blind spot by hand and an agent covering it are asked the same
 * thing, in the same words, under the same number.
 * @param {import("./checks/registry.js").Registry} registry
 * @param {Set<string>} ranIds  Ids of the checks that actually ran.
 * @param {{sca?: boolean}} [mode]  The review mode: a swept case is worded from the
 *   check's response, so an entry that words one per mode is read for this review's.
 * @param {Record<string, object>} siblings  The routing ctxs, for the artifact a
 *   single-artifact route answers with.
 * @param {Record<string, ?string>} trees  This review's trees by artifact
 *   (artifactRoots), asked only whether it HAS the one a sweep names.
 * @returns {?{items: object[]}}
 */

function preSweepOf(registry, ranIds, mode, siblings, trees) {
  const items = registry
    .sweepInstructions(mode)
    .filter((s) => ranIds.has(s.check))
    .map((s) => ({
      ...s,
      // WHICH artifact this sweep is about, settled HERE because here is where a holder
      // still exists. The sweep is merged in the loop phase, long after the ctxs are
      // gone and the state is JSON, so the answer cannot be asked for then - and
      // re-deriving it from the route and the mode is the reconstruction this whole
      // arrangement exists to avoid. An `input: all` entry named it itself; every other
      // route names it by the single artifact its check read.
      artifact:
        s.artifact ?? ctxForRule(registry, s.check, siblings).artifact.kind,
    }))
    // An `input: all` check may author a sweep for an artifact THIS review does not have
    // - the archive, in an XPI review. There is no tree to search, so the request is not
    // made, the same way a check routed at that artifact does not run. Asked of the trees
    // rather than of the review mode, because having the tree IS the question, and the
    // PATH is not recorded: a reader is handed it when the list is printed or handed out,
    // from the same lookup, so there is no second copy to go stale.
    .filter((s) => trees[s.artifact])
    // What NAMES this sweep for the rest of the review. Unique across the whole review
    // rather than within a tree, so the two sweep files cannot both hold a label 1 and
    // an answer can never be read against the wrong one; and the same number the report
    // prints beside it, because both walk this list in this order.
    //
    // A NUMBER, and nothing a reader has to decode: a sweeping agent is told which
    // labels to answer and says which it is answering, and the check and the artifact
    // behind one are the review's own business (src/report/sweep-files.js).
    .map((s, i) => ({ ...s, label: i + 1 }));
  return items.length ? { items } : null;
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
    } catch (err) {
      rethrowIfFatal(err);
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
 * Detect the manifest_version from the add-on manifest.json. A missing or invalid
 * manifest_version defaults to 2 (an add-on that omits it is Manifest V2).
 *
 * @param {object|null|undefined} manifest.json
 * @returns {{version: number, detected: boolean}}
 */
export function detectManifestVersion(manifest) {
  const v = manifest?.manifest_version;
  if (v === 2 || v === 3) {
    return { version: v, detected: true };
  }
  return { version: 2, detected: false };
}
