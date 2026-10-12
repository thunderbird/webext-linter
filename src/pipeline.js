// The review pipeline: opts in, a structured Review out. This is the tool's
// core, independent of the CLI front-end (cli.js) - the test harness drives it
// directly. It loads the add-on, resolves and verifies its vendored
// declarations, classifies bundled code, runs the schema review, and fills each
// finding's display text from the registry. It returns the Review. Formatting
// and I/O are the front-end's job. The submission itself is never modified or
// repacked: the one thing this writes of it is a copy, the .xpi extracted (or the
// unpacked folder copied) to XPI_ROOT in the review's work folder, so every reader -
// the checks, a reviewer, an agent - reads one unpacked tree rather than the tool
// holding a second one of its own.
//
// Belongs here: the declared setup plan (SETUP_STEPS), the stage orchestration
// (runPipeline), claiming the work folder's names when a review starts (and giving them
// back when it fails to start), and the pipeline-level schema-selection helpers
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

import { ARTIFACT_SCA, ARTIFACT_XPI, artifactRoots } from "./lib/artifacts.js";
import fs from "node:fs";
import path from "node:path";
import { workPaths, runCache } from "./util/dest.js";
import { defaultNet } from "./vendor/verify.js";
import { withRunCache } from "./vendor/run-cache.js";
import { withSourceCache } from "./vendor/source-cache.js";
import { originalPackages, readPrepare } from "./prepare/state.js";
import {
  resolveSchemaZip,
  refreshAllSchemas,
  hasAllCachedSchemas,
  cachedZipPath,
  allSchemaBranches,
  schemaBranch as branchName,
  SCHEMA_CHANNELS,
} from "./schema/fetch.js";
import { cacheIsStale } from "./util/cache-age.js";
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
import {
  checkSelected,
  ctxForRule,
  loadRegistry,
  runChecks,
} from "./checks/registry.js";
import { buildXpiCtx, buildScaCtx, buildAllCtx } from "./checks/context.js";
import {
  renderFindings,
  renderManualItems,
  withDefaultNotes,
} from "./report/responses.js";
import { resolveHolds } from "./report/finding.js";
import { assignRefs, orderReview } from "./report/order.js";
import { earlyExitOf, withoutQuestions } from "./report/early-exit.js";
import { STATE_VERSION } from "./report/state.js";
import { issue, loopSlots } from "./report/loop.js";
import { headerLines, loopPromptLines, schemaLines } from "./report/format.js";
import { sweepRequests } from "./report/sweep-files.js";
import { sweepRun } from "./checks/registry-vocabulary.js";
import { isExperiment, parseVersion, strictMaxVersion } from "./lib/util.js";
import { experimentApiMembers } from "./lib/experiments.js";
import { experimentVerdict } from "./experiments/verify.js";
import { debug, progress, report, warn, FEED } from "./util/log.js";
import { DEFAULT_CACHE, SOURCES_CACHE } from "./config.js";
import { rethrowIfFatal, wiringError } from "./lib/errors.js";
import { reviewData } from "./review/products.js";

/** @typedef {import("./report/finding.js").Finding} Finding */
/** @typedef {import("./report/format.js").ReviewMeta} ReviewMeta */

/**
 * The setup sequence: the review's EAGER steps, in the order they run, with the condition
 * that decides whether this run has each. The loop in runPipeline WALKS this list and runs
 * each entry's action, so a step happens because it is declared here rather than because a
 * statement sits somewhere in that function.
 *
 * Eager means every review needs it before any check can run: the schema (every report
 * stamps it, and the manifest.json checks read it), the Experiment verdict (it decides the
 * review's mode), the Experiment APIs on the schema (they decide what every API lookup
 * answers, so they cannot depend on which checks ran first), the source archive (the
 * artifact the checks are routed to), and the record of what was reviewed. Everything else
 * the review computes - the vendor reading and its audits, the classification, the CDN
 * lookup, the parse, the build trace - is computed when a check first asks for it
 * (src/review/products.js).
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
 * `when` decides whether this run has the step, from facts the fast .xpi read already gives:
 * whether this is an Experiment, and the review MODE. A step that depends on the mode reads
 * `mode` rather than spelling out what makes one. The Experiment verdict decides none of
 * them: a rejected Experiment is the review it was asked to be, and its first check stops it.
 * @type {{key: string, label?: ?string,
 *   when: (facts: {sca: boolean, isExp: boolean,
 *     mode: import("./lib/enum.js").ReviewMode}) => boolean}[]}
 */
export const SETUP_STEPS = Object.freeze([
  { key: "read", label: "Reading add-on", when: () => true },
  { key: "schema", label: null, when: () => true },
  {
    key: "experiments",
    label: "Verifying bundled experiments",
    when: (f) => f.isExp,
  },
  { key: "experiment-schema", when: (f) => f.isExp },
  // The target is two entries rather than one arm each side of an `if`, so the list - not a
  // branch inside a step - holds which artifact the review is of, and `meta` is reached on
  // every path.
  { key: "source-archive", when: (f) => f.mode.sca },
  { key: "target-source", when: (f) => f.mode.sca },
  { key: "target-xpi", when: (f) => !f.mode.sca },
  { key: "meta", when: () => true },
]);

/**
 * Every path opt is ABSOLUTE. The arg-array reader resolves them (pipelineOptsFromValues,
 * src/cli.js), which is the one layer that knows what each flag was written relative to -
 * the working directory for --sca-root, and --sca-root itself for --sca-exp-source. Nothing here re-resolves one, and a caller handing in a relative path gets
 * whatever the working directory makes of it.
 * @typedef {object} PipelineOpts
 * @property {string} addonPath  The shipped add-on, absolute.
 * @property {string} workFolder  The review's work folder, absolute: every file this review,
 *   or an agent it instructs, creates lives there under a bare name (src/util/dest.js
 *   workPaths). REQUIRED, and not defaulted here: the front-end names it (beside the add-on,
 *   src/util/dest.js defaultWorkFolder), and a caller that forgot would otherwise put a review somewhere
 *   nobody chose. Created if missing; nothing already in it is overwritten.
 * @property {string} [schemaCache]
 * @property {string} [workCache]  The folder the run keeps its cache in, absolute, when it
 *   names one (--cache-work-dir, tests only): otherwise the work folder's (runCache).
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
 * @property {string} [npmRegistryCache]  Where to cache the npm registry's answers about
 *   a lock file's tarball URLs.
 * @property {string} [sourcesCache]  Where to keep the pinned library sources a review
 *   downloads.
 * @property {import("./checks/registry.js").Registry} [registry]  Parsed
 *   registry threaded from the caller, parsed once here otherwise.
 * @property {boolean} [llmReview]  Run the review and hand out the first phase of it -
 *   printing that prompt and writing the state every later pass reads - instead of
 *   printing the report. Changes nothing about the review itself, only what is printed
 *   and what is written for the passes that follow.
 * @property {string[]} [llmSkip]  What that prompt leaves out (PROMPT_SKIPS, src/config.js):
 *   --llm-skip-summary drops the add-on description and the file named for it;
 *   --llm-skip-manual drops the steps that put the manual items to a reviewer,
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
 * The review's work folder is claimed first, before anything is read: created if missing,
 * checked to be writable, and every name this run will create there checked to be free
 * (claimWorkFolder). A plain review creates only the shipped add-on's copy. A --llm-review
 * run names every file of the loop, and claims them all, because the agents it instructs
 * write the rest later and a name already taken would be overwritten then, out of sight.
 *
 * A run that fails before the review loop's state is written gives back what it claimed,
 * so the same command can run again. Once the state is there, the review exists and its
 * files are the passes' to work on.
 * @param {PipelineOpts} opts
 * @returns {Promise<PipelineResult>}
 */
export async function runPipeline(opts) {
  if (!opts.workFolder) {
    throw wiringError(
      "runPipeline: no workFolder - every file a review creates lives in one, and only " +
        "the caller can name it."
    );
  }
  const work = workPaths(opts.workFolder);
  // A work folder a source code review was prepared in holds the preparation's record. Its
  // review is started there by the hand-back that finds the preparation done (src/cli.js),
  // and reads the record for what the preparation found.
  const prepared = readPrepare(opts.workFolder);
  const claim = claimWorkFolder(
    opts.workFolder,
    claimedNames(work, opts.llmReview)
  );
  try {
    return await reviewSubmission(opts, work, prepared);
  } catch (err) {
    // The state is one of the claimed names under --llm-review, so it being there means
    // this run wrote it. A plain run writes none and gives back on any failure.
    if (!(opts.llmReview && fs.existsSync(work.state))) {
      releaseWorkFolder(claim);
    }
    throw err;
  }
}

/**
 * The review itself, inside the work folder runPipeline claimed for it.
 * @param {PipelineOpts} opts
 * @param {ReturnType<typeof workPaths>} work  The work folder's names.
 * @param {?import("./prepare/state.js").PrepareRecord} prepared  The preparation's record,
 *   where the review starts in a folder a source code review was prepared in.
 * @returns {Promise<PipelineResult>}
 */
async function reviewSubmission(opts, work, prepared) {
  const { addonPath } = opts;
  // `addonPath` IS the shipped add-on's path, absolute, and the single value the run has
  // for "which add-on": what the report names, and where the work folder and its files go. An Addon carries no path of its own
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
  // The review mode is DERIVED from one fact below and assigned nowhere, so it cannot drift
  // from the steps that ran: --sca-root makes it a source code review. Every reader - the
  // steps, the ctx builders, the report - reads that one derivation.
  // The parsed registry, threaded from main() (or loaded once here when a caller
  // such as the test harness invokes the pipeline directly), read under THIS run's band
  // policy. Applied here rather than at either construction site, so a caller that hands one
  // in and a caller that leaves it to be loaded get the same reading of the same flag.
  const registry = (opts.registry ?? loadRegistry()).withPolicy({
    warningsAsErrors: Boolean(opts.warningsAsErrors),
  });

  // Which folder is the source root, settled before anything reads it
  // (src/addon/sca-root.js). Whoever named --sca-root had not looked inside it yet - an
  // archive is extracted by whoever prepares the review, into a destination
  // worked out by path math - so an archive carrying its contents in one directory of its own
  // leaves the build files a level below the root it was given.
  //
  // Rebound onto `opts`, once, rather than threaded: every reader below asks opts.scaRoot,
  // and a settled value beside the one it was given is two answers to one question. The
  // narration comes later, with the rest of Setup.
  const scaMove = settleScaRoot(opts);
  opts = { ...opts, ...scaMove };

  // Load the .xpi. Read before the "Setup" banner because it sizes the feed - it gives
  // the mode and whether the add-on is an Experiment. The eager steps below (the schema
  // fetch, the experiment fetch) are narrated as Setup steps; the review's data is
  // narrated where a check first asks for it (src/review/products.js). The add-on reads
  // are fast local ones (this .xpi, and in a source review the source archive) marked by
  // the "Reading add-on" step.
  // Loading here is the ONLY way an add-on enters a review: its content and its identity
  // then come from one value, and no caller can hand in files that disagree with the path
  // the report goes on to name.
  //
  // The add-on is read from its copy in the work folder, not in memory and not where it was
  // submitted: XPI_ROOT is a single folder this run writes once and every reader - the
  // checks below, a reviewer, an LLM agent - reads back from, never two representations of
  // one submission. A packed .xpi is extracted there and an unpacked folder copied there,
  // so the files a review names sit in one folder whichever was submitted, and nothing an
  // agent does in XPI_ROOT can reach the submission itself.
  const xpiAddon = loadAddon(addonPath, work.xpi, { kind: ARTIFACT_XPI });
  // What the SHIPPED add-on declares, read ONCE here and the review's only record: it is
  // asked of the built XPI by name rather than derived by whatever loads an artifact (a
  // source archive's root manifest.json is a pre-build template, and nothing asks it). One
  // record, so the name needs no artifact to tell it from another.
  const webExtManifestRecord = readWebExtManifest(xpiAddon.store);
  // The Experiment verdict, likewise the SHIPPED add-on's and likewise shared rather than
  // stapled to an artifact: it reaches the checks as ctx.experiments. Named for its type
  // (ExperimentVerification) rather than for the artifact, because there is only ever one.
  let experimentVerification = null;
  const xpiRoot = `${work.xpi}${path.sep}`;
  const isExp = isExperiment(webExtManifestRecord?.json);

  // The facts each step's `when` is asked of, from what the fast .xpi read already gives
  // us: the mode, and whether this is an Experiment.
  const setupFacts = {
    sca: Boolean(opts.scaRoot),
    isExp,
    // What the review IS, derived here and nowhere else: the steps that depend on it, the
    // ctx builders and the report all read it, so none of them re-spells the rule.
    get mode() {
      return this.sca ? REVIEW_MODE.SCA : REVIEW_MODE.XPI;
    },
  };
  // The total, sized by asking the same conditions the loop will ask.
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
  /** The submitted source archive: read by `source-archive`, reused by `target-source`. */
  let scaArchive;
  /** The review schema (indexed) and the stamps meta publishes for it. */
  let schema;
  let schemaSource;
  let schemaBranch;
  let schemaChannel;
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

    // Mark the start of the review. The .xpi was already read pre-banner (above), and has
    // nothing to narrate: an XPI holding a link is refused at load, so it skips nothing. The
    // SCA source archive is read by `source-archive` and reused after it, in a source
    // review, and its skip notices are narrated by `target-source`.
    read: () => {},

    // The review schema: fetched, annotated, indexed. It is resolved from the SHIPPED
    // XPI's manifest.json alone (manifest_version + strict_max_version pick the channel), so it
    // depends on neither the Experiment classification nor the review mode - which is why it
    // runs before both, as the one piece of setup EVERY path needs. The extraction pass reads
    // its web_api / loader signatures and the review runs against it; experiment-not-allowed
    // resolves a rejected Experiment's API paths through it (to spot one shadowing a
    // built-in), and meta reads schema.applicationVersion.
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
    // The verdict (experimentVerdict) is read from the review's own xpi/, by the one rule
    // --llm-sca-review asks before it prepares a review. It fetches the allow-list only
    // when a group actually bundles files (a bare experiment_apis declaration stays
    // offline -> unsupported, and the step's line is the only sign of it), and a fetch
    // failure throws so the run hard-exits (2) rather than letting a missing allow-list
    // masquerade as a verdict - we cannot verify identity without it.
    //
    // The verdict is the one reader of --allow-experiments. Without it, an unsupported
    // experiment is rejected, and the review's first check, experiment-not-allowed, reports
    // the rejected groups and aborts. The verdict decides nothing else: the review keeps its
    // mode and registers the Experiment's APIs, so with that check left out it runs exactly
    // as an allowed one would. A recognised but modified one is not rejected, so the full
    // review runs and experiment-modified flags it.
    // Experiments are reviewed from the XPI (its shipped-artifact role; xpiAddon ===
    // reviewTarget in XPI mode). They are privileged, non-bundled, readable code, and the
    // manifest.json's experiment paths resolve against the XPI's own files (no
    // source-layout mismatch).
    experiments: async () => {
      ({ verification: experimentVerification } = await experimentVerdict(
        work.xpi,
        opts
      ));
    },

    // An Experiment's declared APIs are part of its platform - a rejected one's too, whose
    // review experiment-not-allowed stops first: register each namespace it adds, with the members its own schema declares, so the developer's
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

    // The submitted source archive, walked ONCE and split here into the two views every
    // later reader takes its part from (src/addon/load.js scaViews). Reading them costs
    // nothing extra: the store reads a file once and the views share it.
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
        // Where the source is a rescued copy, the package files of the root it was copied
        // from - what the developer submitted - for the check that tells them the review
        // ran on changed dependencies. Null for every other source.
        scaArchive.originalPackages = originalPackages(
          opts.workFolder,
          prepared
        );
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

    // The review target of every other review: the .xpi itself.
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
    // Built on every path: an aborted review's report names its add-on too.
    meta: () => {
      meta = {
        action: "review",
        // RESOLVED, both of them: a reader resolves these, and an agent handed a relative one
        // would resolve it against its own directory.
        xpi: addonPath,
        // Where the shipped package IS on disk, readable: its copy in the work folder,
        // extracted or copied there - set once, above, alongside loading it.
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

  // Build the sibling RunContexts the checks read, once the step list has run. The
  // review-level singletons are built ONCE here and shared by every sibling ctx, so they can
  // never drift between artifacts or double-cost. Nothing is computed here: each artifact's
  // data is computed when a check first asks for it (src/review/products.js).

  // Both facts are settled - the loop has run - so the review mode follows from them.
  const mode = setupFacts.mode;

  // The shared review env every sibling ctx projects (buildXpiCtx / buildScaCtx). The
  // manifest.json and experiments are the SHIPPED artifact's - authoritative like the schema, so no
  // artifact's own template can shadow them. No run option is on it: what a flag decides is
  // decided before the checks (--allow-experiments by the Experiment verdict), and a check
  // reads the decision.
  const env = {
    schema,
    mode,
    manifest: webExtManifestRecord,
    experiments: experimentVerification ?? null,
  };

  // Each artifact's data, computed when a check first asks for it. OSV and the popularity
  // hosts are asked through the run's cache: a prepared review's questions were mostly asked
  // by its preparation already. A pinned library source is downloaded through the sources
  // cache, which every review shares.
  const dataOf = reviewData({
    opts: {
      ...opts,
      vendorNet: withRunCache(
        withSourceCache(defaultNet, opts.sourcesCache ?? SOURCES_CACHE),
        runCache(opts.workFolder, opts.workCache)
      ),
    },
    schema,
    manifest: webExtManifestRecord,
    xpi: xpiAddon,
    archive: mode.sca ? scaArchive : null,
    target: reviewTarget,
  });
  // The shipped ctx, for the input:xpi checks - the structure checks and the manifest.json
  // checks alike, since the shipped manifest.json is this artifact's.
  const xpiCtx = buildXpiCtx(xpiAddon, dataOf(xpiAddon), env);
  // The submitted archive, which only a source review has. One ctx over one artifact: the
  // build checks and the code checks read the same object, and what separates them is the
  // route each declared, not a second narrowed projection.
  const scaCtx = mode.sca
    ? buildScaCtx(reviewTarget, dataOf(reviewTarget), env)
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

  // Run the review, then finalize. runChecks runs the deterministic phase and returns the
  // finished findings, manual items and the checks that ran. Each throwing check is
  // isolated so one failure can't abort all. A rejected Experiment stops at its first
  // check, experiment-not-allowed, as any review stops at a check that aborts it - and a
  // source whose preparation gave up rescuing its lock stops at its vulnerability checks.
  // The `--eslint` opt-in gates code-sanity inside loadChecks (eslintEligible).
  progress(""); // close the Setup section before runChecks prints "── Activity ──"
  const {
    findings: reviewFindings,
    manualItems,
    checksRun,
  } = await runChecks(
    registry,
    { only: opts.checksOnly, skip: opts.checksSkip, eslint: opts.eslint },
    siblings
  );
  findings.push(...reviewFindings);

  // The review-derived half of meta (the base half - action/xpi/... - is the `meta` setup
  // step's): the schema stamps, the checks that ran, and the manual-review to-do list.
  // Its `extended` items are the orchestrator's escalations (resolved to their registry
  // text); the rest are the by-hand manual-checks entries, which every review carries
  // unconditionally. An aborted review withholds the ones a reviewer would be asked
  // (src/report/early-exit.js), here as in any other review.
  const ranIds = new Set(checksRun.map((c) => c.id));
  Object.assign(meta, {
    schemaSource,
    schemaBranch,
    schemaChannel,
    applicationVersion: schema.applicationVersion,
    manifestVersion: webExtManifestRecord?.json?.manifest_version ?? null,
    checksRun: checksRun.map((c) => c.id),
    // The two to-do origins as ONE list, each carrying its own `default-note` where the
    // check authors one: a case a check escalated and a by-hand manual check are the same
    // item to whoever answers it, so the note is appended to both in one place.
    manualReview: withDefaultNotes(
      [
        ...renderManualItems(manualItems, registry, mode).map((m) => ({
          ...m,
          extended: true,
        })),
        ...registry.manualChecks(mode).map((m) => ({ ...m, extended: false })),
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
    // --checks-only/--checks-skip carry through.
    preSweep: preSweepOf(registry, ranIds, mode, siblings, artifactRoots(meta)),
  });

  // What this run was told to leave out (--llm-skip-summary / --llm-skip-manual). Read
  // once: a phase drops steps by it, the routing drops entries by it, and the
  // description file is named by it.
  const skip = opts.llmSkip ?? [];
  // Where the prompt's reader writes the add-on description, and where it writes what
  // building the add-on takes. Both sit in the review's work folder, and this tool writes
  // neither and reads neither. Held until the prompt is built, because whether either
  // is NAMED depends on whether the step that writes it can print - the description is
  // withheld by --llm-skip-summary, the build report by a review that is not a source code one.
  let summaryPath = null;
  let buildPath = null;
  let buildCopyPath = null;
  let buildDiffPath = null;
  let reportPath = null;
  // Each tree's sweep request and answers file, by artifact - empty when this run sweeps
  // nothing. The keys are what says which trees were asked: a step prints for one, and
  // accepting the pass reads back exactly these.
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
  const prompting = opts.llmReview;
  if (prompting) {
    // Said plainly, because two readers need it and neither should infer it from whether
    // some file happens to have been named: this run HANDS OUT A PHASE, so its whole
    // output is that prompt and the report is not printed beside it.
    meta.prompting = true;
    summaryPath = skip.includes("llm-skip-summary") ? null : work.summary;
    buildPath = mode.sca ? work.build : null;
    // The build phase's two paths, named only where it can be issued: a source code review
    // (its steps' `sca` condition in assets/registry.yaml).
    buildCopyPath = mode.sca ? work.buildCopy : null;
    buildDiffPath = mode.sca ? work.buildDiff : null;
    // Ungated, unlike the two above: every review has a report, and this one is written by
    // the linter (src/report/report-file.js) rather than asked of an agent, so there is no
    // step whose absence could leave the path naming nothing.
    reportPath = work.report;
    // Named on meta BEFORE the state is built: `issue` writes the state, and a field set
    // after that never reaches the passes that read it back. A path printed for a file
    // nobody is asked to write would be an instruction with no step behind it - which is
    // why the first two are null above where the step that writes them can never print: the
    // description under --llm-skip-summary, the build report in a review that is not a
    // source code one. The Review Details name the build report only once its phase
    // recorded it (src/report/loop.js reportMeta).
    //
    // Nothing is checked here: the work folder was found writable, and every one of these
    // names free, before the review began (runPipeline). The agents this prompt hands out
    // write the first two, and a later pass the report, so a folder that could not take
    // them would only have failed once the review was already finished.
    meta.summaryFile = summaryPath ?? undefined;
    meta.buildFile = buildPath ?? undefined;
    meta.reportFile = reportPath;
    // One sweeping agent per tree, each handed a request of its own and answering into a
    // file of its own. Made HERE, with the review, because the request carries the tree's
    // path and the sweeps that tree was asked about - both of which are this run's
    // answers and neither of which a later pass could reconstruct.
    //
    // Nothing is asked of a review that is not sweeping: --llm-skip-sweep withholds the
    // asking though the instructions still stand, and then there is no request to hand
    // over and no file for a step to name.
    sweepFiles = sweeping
      ? sweepRequests(work, meta.preSweep, artifactRoots(meta))
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
    //
    // Every item gets its fixed reference here, the one every answer is recorded under, in
    // the order the checks raised them (src/report/order.js assignRefs).
    assignRefs([...findings, ...meta.manualReview], registry);
    loopState = {
      version: STATE_VERSION,
      report: { findings, meta, sca: mode.sca },
      manual: meta.manualReview,
      preSweep: meta.preSweep,
      // What this run was told, recorded ONCE. Every pass reads it from here - a second
      // copy handed in beside the state is a second answer, and the two deciding
      // differently is a phase issued for entries it never shows.
      run: {
        skip,
        sca: mode.sca,
        // Whether every check an agent's build relies on runs: with one switched off, nothing
        // vouches for what the build would install, so the review builds nothing itself.
        ...(registry
          .buildGuardIds()
          .every((id) =>
            checkSelected(id, { only: opts.checksOnly, skip: opts.checksSkip })
          )
          ? { "build-guarded": true }
          : {}),
        // One condition per tree that has a sweep to run, keyed the way the step names
        // it. Read off the REQUESTS rather than off `sweeping` and `preSweep` separately:
        // a step exists to hand an agent a request, so the request existing is the whole
        // condition, and --llm-skip-sweep leaves none behind.
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
        description: summaryPath,
        build: buildPath,
        buildCopy: buildCopyPath,
        buildDiff: buildDiffPath,
        report: reportPath,
        schemaCache: opts.schemaCache,
        // The two roots every reported path is relative to, so a later pass can resolve
        // one without the review it came from. The shipped add-on was copied in setup,
        // and `--sca-root` is extracted before the run, so both are readable directories
        // by the time anything is handed out.
        scaRoot: opts.scaRoot ?? null,
        xpiRoot: meta.xpiRoot,
        // Each tree's sweep request, as the text its step hands over, and the file its
        // answers are written to. Carried so the step prints the request this run made and
        // the pass that accepts the hand-back reads exactly the files this run named, with
        // no later pass deriving either again.
        sweeps: sweepFiles,
        // The schema block a judging phase prints - the snapshot its verdicts mean
        // anything against. Built once, from the same meta the report's header is.
        schema: schemaLines(meta, opts.schemaCache).join("\n"),
      },
      answers: {},
      issued: [],
    };
  }

  // A review the findings themselves settle is ABORTED here: nothing further is put to a
  // reviewer, and the report says why rather than listing work nobody should do. The case
  // it exists for is a build the reviewer would otherwise be asked to reproduce from a
  // dependency tree this review has already rejected.
  //
  // Applied only for a review that PRINTS one. Under --llm-review the same decision is
  // taken again at the end of the loop (src/report/loop.js settle), because a pass may
  // still report a case that aborts the review - so the state above keeps the full list,
  // and the loop decides what an aborted review hands over.
  //
  // AFTER resolveHolds, and that ordering is load-bearing: the threshold reads a
  // finding's severity, and resolveHolds is the moment a provisional hold becomes one.
  // Decided before it, a blocking check that reported a hold would abort nothing.
  //
  // The key is left off a review that was not aborted, rather than written as null - the
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
    // Which phase goes out is `issue`'s to decide, from what has work - a source review
    // opens with its build, and a run with no sweep and no description agent never
    // mentions either.
    const texts = registry.llmPhases();
    const state = loopState;
    const first = issue(state, opts.workFolder, texts.phases, registry);
    for (const line of loopPromptLines(
      texts,
      first.phase,
      first.steps,
      loopSlots(state, first, opts.workFolder),
      // The preamble parts its conditions chose: this is the first prompt, so it prints
      // unless the review closes right here.
      first.preamble
    )) {
      report(line);
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

/** The work folder's names a review never writes: the source archive's extraction, put
 *  there when a source code review is prepared, the copy of it a rescue makes, and that
 *  preparation's record. A review claiming them would refuse the very folder it was
 *  prepared in. */
const WORK_INPUTS = new Set(["sca", "rescued", "prepare"]);

/**
 * The names a run will create in its work folder (src/util/dest.js workPaths).
 *
 * A plain review creates the shipped add-on's copy and nothing else. A --llm-review run
 * names every other output too - the loop's pair, the report, what its agents write, and a
 * sweep answers file for each artifact - whether or not this review turns out to use each
 * one: an XPI review never builds and may sweep nothing, but which of them it will use is
 * only known once it has run, and a review refused at the end for a name it needed is a
 * review paid for and thrown away.
 * @param {ReturnType<typeof workPaths>} work
 * @param {boolean} [llmReview]
 * @returns {string[]}  Absolute paths.
 */
function claimedNames(work, llmReview) {
  if (!llmReview) {
    return [work.xpi];
  }
  const outputs = Object.entries(work)
    .filter(
      ([key, value]) => typeof value === "string" && !WORK_INPUTS.has(key)
    )
    .map(([, value]) => value);
  const sweeps = [ARTIFACT_XPI, ARTIFACT_SCA].map(work.sweep);
  return [...outputs, ...sweeps];
}

/**
 * Claim the work folder for this run: create it if missing, refuse it when it cannot be
 * written to, and refuse it when any name this run will create is already there.
 *
 * A command line never hands a review an existing folder (src/cli.js refuses one). The one
 * that is there already is a PREPARED folder, whose review the hand-back starts once its
 * preparation is done: it holds the preparation's record and the extracted source, which
 * this run reads and never claims (WORK_INPUTS). Nothing in it is overwritten. A name
 * already taken is left over from a start that was cut short, and replacing it would destroy
 * work nobody asked to discard.
 * @param {string} dir  The work folder, absolute.
 * @param {string[]} names  claimedNames' answer.
 * @returns {{dir: string, names: string[], inner: string[], created: ?string}}  What
 *   releaseWorkFolder needs to give it back: the names, the folders inside the work folder
 *   they live in that were not there yet, and the outermost folder this call created, if any.
 */
function claimWorkFolder(dir, names) {
  let created;
  try {
    created = fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    rethrowIfFatal(err);
    throw new Error(
      `The work folder "${dir}" cannot be created (${err.code ?? err.message}).`
    );
  }
  if (!canWriteDir(dir)) {
    throw new Error(
      `The work folder "${dir}" cannot be written to, and every file this review creates ` +
        "lives there."
    );
  }
  const taken = names.filter(onDisk);
  if (taken.length) {
    const listed = taken.map((p) => `"${path.relative(dir, p)}"`).join(", ");
    throw new Error(
      `The work folder "${dir}" already holds ${listed}, which this review would ` +
        "create. Nothing in a work folder is overwritten: remove what is there, and hand " +
        "the folder back again."
    );
  }
  // The folders inside it that the claimed names live in (`.review/`) and that are not
  // there yet: the review creates them as it writes, so they are this run's to give back.
  const inner = [...new Set(names.map((p) => path.dirname(p)))].filter(
    (folder) => folder !== dir && !onDisk(folder)
  );
  return { dir, names, inner, created: created ?? null };
}

/**
 * Give back what claimWorkFolder took, for a run that failed before its review existed:
 * every claimed name - each was free when it was claimed, so whatever is there now this run
 * created - and the folders the claim created or found missing, while they are empty.
 * @param {{dir: string, names: string[], inner: string[], created: ?string}} claim
 */
function releaseWorkFolder({ dir, names, inner, created }) {
  for (const name of names) {
    fs.rmSync(name, { recursive: true, force: true });
  }
  for (const folder of inner) {
    try {
      fs.rmdirSync(folder);
    } catch (err) {
      rethrowIfFatal(err);
    }
  }
  if (!created) {
    return;
  }
  // Innermost first, and never past the outermost one this run made. rmdir refuses a
  // folder that is not empty, which is what stops this removing anything it did not create.
  for (let folder = dir; ; folder = path.dirname(folder)) {
    try {
      fs.rmdirSync(folder);
    } catch (err) {
      rethrowIfFatal(err);
      return;
    }
    if (folder === created) {
      return;
    }
  }
}

/**
 * Whether anything is at a path, a dangling symbolic link included: lstat, so a link is
 * the name it occupies and not the file it may or may not point at.
 * @param {string} p
 * @returns {boolean}
 */
function onDisk(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (err) {
    rethrowIfFatal(err);
    return false;
  }
}

/**
 * Whether a directory can be written to, without writing anything to it.
 *
 * The question the review's work folder has to answer before the review is built. Asked
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

  // A channel branch is a MOVING target: release-mv2 means "whatever release is today", and
  // even a train already cached gains backported API data, so a cached zip is a snapshot
  // that goes stale as Thunderbird ships. All six are refreshed once ANY of them is older
  // than a day (schemaCacheIsStale) - every one, not only this manifest version's, so a
  // refresh that failed halfway can never leave an old branch looking fresh beside new
  // ones. A refresh that fails ends the review: a cache known to be stale is not reviewed
  // against.
  if (!stepped && schemaCacheIsStale(cacheDir)) {
    setupStep("Refreshing review schemas (cache older than a day)");
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
 * The blind-spot sweeps for this review, or null when no check that ran authors one.
 *
 * One flat list, grouped into one request per tree when the requests are made
 * (src/report/sweep-files.js): the method is said once per request and each item says
 * only what its own check is looking for. Split the other way - method repeated on every
 * item - and eight near-identical paragraphs teach a reader to skim the part that matters.
 *
 * This is what BOTH readers get. The report prints it as the Standard Code Review list,
 * and the same items are what each sweeping agent's request is built from - so a
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
    // rather than within a tree, so the two answers files cannot both hold a label 1 and
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
 * Whether the cached schema snapshot must be downloaded again: any of the six branch zips
 * is missing or older than CACHE_MAX_AGE_DAYS (src/util/cache-age.js). The oldest decides,
 * because refreshAllSchemas writes them one after another and may stop part-way.
 * @param {string} cacheDir
 * @param {number} [now]  The current time, in ms.
 * @returns {boolean}
 */
export function schemaCacheIsStale(cacheDir, now = Date.now()) {
  return allSchemaBranches().some((branch) =>
    cacheIsStale(cachedZipPath(cacheDir, branch), now)
  );
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
