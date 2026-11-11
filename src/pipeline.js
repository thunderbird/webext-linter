// The review: "review the loaded submission" for an .xpi review and a source review alike,
// plain or an agent's, on a work folder its caller set up. This is the tool's core,
// independent of the CLI front-end (cli.js) - the test harness drives it directly
// (runPipeline). It populates the context every check reads (populateCtx: the add-on read
// where the load put it, the schema, the Experiment verdict, the source archive), runs the
// checks that end a review early and then the others (runChecks), and hands the review as
// the checks produced it to one of the review functions: "report the review" (plain), "start
// the review loop" or "close the review" (src/report/loop.js). The submission itself is never
// modified or repacked, and nothing here extracts it: the load put the one copy in the work
// folder's xpi/ (src/review/start.js).
//
// Belongs here: the declared setup plan (SETUP_STEPS), populating ctx, the two runs of the
// checks and the review function after them, the review as the checks produced it, reporting
// a plain review, and the pipeline-level schema-selection helpers (resolveReviewSchema,
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

import { ARTIFACT_XPI, artifactRoots } from "./lib/artifacts.js";
import fs from "node:fs";
import path from "node:path";
import { workPaths, runCache } from "./util/dest.js";
import { defaultNet } from "./vendor/verify.js";
import { withRunCache } from "./vendor/run-cache.js";
import { withSourceCache } from "./vendor/source-cache.js";
import { governingLock, unreadableLock } from "./vendor/locks.js";
import {
  BUILD_CHECK_STEP,
  buildCheckBody,
  originalPackages,
} from "./build-check/state.js";
import { analyzeEntries, stepPromptLines } from "./build-check/steps.js";
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
import {
  checkSelected,
  ctxForRule,
  loadRegistry,
  runChecks,
} from "./checks/registry.js";
import {
  classifyAddonJs,
  classifyInlineScripts,
  isMinifiedFirstParty,
} from "./lib/bundled.js";
import { buildXpiCtx, buildScaCtx, buildAllCtx } from "./checks/context.js";
import { renderManualItems, withDefaultNotes } from "./report/responses.js";
import { SEVERITY, finding, hasErrors } from "./report/finding.js";
import { orderReview } from "./report/order.js";
import { withoutQuestions } from "./report/early-exit.js";
import { closeReview, startReviewLoop } from "./report/loop.js";
import { formatReview, headerLines } from "./report/format.js";
import { settleReview } from "./review/settle.js";
import {
  MODE,
  addToRecord,
  modeOf,
  readRecord,
  startMode,
} from "./review/record.js";
import { issueHandbackPrompt } from "./review/issue.js";
import { isExperiment, parseVersion, strictMaxVersion } from "./lib/util.js";
import { experimentApiMembers } from "./lib/experiments.js";
import { experimentVerdict } from "./experiments/verify.js";
import { debug, progress, report, writeToStdout, FEED } from "./util/log.js";
import { DEFAULT_CACHE, SOURCES_CACHE } from "./config.js";
import { rethrowIfFatal, wiringError } from "./lib/errors.js";
import { reviewData } from "./review/products.js";
import { LOCK_AUDIT_LISTS, vulnerabilityCounts } from "./build-check/audit.js";

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
 * lookup, the parse, the build review - is computed when a check first asks for it
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
 * the working directory for --sca-extracted and --sca-package-root, and --sca-extracted for
 * --sca-experiments. Nothing here re-resolves one, and a caller handing in a relative path gets
 * whatever the working directory makes of it.
 * @typedef {object} PipelineOpts
 * @property {string} addonPath  The shipped add-on, absolute.
 * @property {string} workFolder  The review's work folder, absolute: every file this review,
 *   or an agent it instructs, creates lives there under a bare name (src/util/dest.js
 *   workPaths). REQUIRED, and not defaulted here: the front-end names it (beside the add-on,
 *   src/util/dest.js defaultWorkFolder), and a caller that forgot would otherwise put a review somewhere
 *   nobody chose. The load created it and put the add-on's copy in its xpi/
 *   (src/review/start.js loadTheXpi); nothing already in it is overwritten.
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
 * @property {?import("./experiments/verify.js").ExperimentVerification} [verification]  The
 *   Experiment verdict an earlier run recorded, null for an add-on that declares none.
 *   Absent in the run that runs the early-exit checks, which decides it (populateCtx).
 * @property {boolean} [warningsAsErrors]  Read every warning as an error for this review
 *   (--warnings-as-errors): the band the registry hands out IS an error, so the report,
 *   the tally, the early exit and the exit code all follow (src/checks/registry.js
 *   bandUnder). Off by default.
 * @property {import("./addon/package-root.js").ScaFolders} [scaFolders]  SCA mode: the
 *   source copy in the work folder, the tree the review reads (that copy or a build check's
 *   rescued copy) and the folders inside it, the package root, where package.json and the
 *   lock are read and the declared dependencies audited, and the Experiment implementation
 *   folder, there exactly when the add-on declares Experiments. Copied there and settled
 *   before the review (src/review/start.js copySource, src/addon/package-root.js
 *   settlePackageRoot) or left there by a build check, and read where it is. The Experiment
 *   folder's privileged files are
 *   excluded from the WebExtension code checks. The positional XPI is the shipped artifact the
 *   manifest.json, experiments and file-completeness (`input: xpi`) checks run against
 *   (buildXpiCtx, src/checks/context.js).
 * @property {?{from: string, to: string}} [scaMoved]  The package root named, and the one it
 *   was settled to below it, both relative to the work folder's `sca/`, there only when it
 *   moved, so the run can say so.
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
 * @property {boolean} [llmReview]  Whether --llm-review was given. Whether an agent runs the
 *   review is its caller's to say (reviewLoadedSubmission's `llm`).
 * @property {string[]} [llmSkip]  What that prompt leaves out (PROMPT_SKIPS, src/config.js):
 *   --llm-skip-summary drops the summary report and the file named for it.
 * @property {string} [downgradedFrom]  The work folder of the source review this XPI review
 *   was restarted from (src/cli.js downgradeCase), which adds its sca-not-needed finding. No
 *   command-line flag sets it.
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
 * What populateCtx makes and every run of the checks reads: the registry under the run's band
 * policy, what the shipped add-on declares, its Experiment verdict, the source archive in a
 * source review, the review schema and
 * the stamps meta publishes for it, the meta built in Setup, the review's mode, and the
 * contexts each check is routed to (routeCtx).
 * @typedef {object} ReviewContext
 * @property {import("./checks/registry.js").Registry} registry
 * @property {import("./addon/load.js").WebExtManifestRecord} manifest
 * @property {?import("./experiments/verify.js").ExperimentVerification} verification
 * @property {?import("./addon/load.js").Addon} scaArchive
 * @property {object} schema
 * @property {string} schemaSource
 * @property {string} schemaBranch
 * @property {string} schemaChannel
 * @property {ReviewMeta} meta  Extended once the checks have run (reviewOf).
 * @property {object} mode
 * @property {Record<string, import("./checks/registry.js").RunContext>} siblings
 */

/**
 * Run a plain review of a loaded work folder and return the review a plain report prints,
 * without printing it: the programmatic face of "review the loaded submission", which the
 * test harness drives and formats itself.
 *
 * The work folder holds the add-on's copy and the record the load put there
 * (src/review/start.js loadTheXpi), what the run was given added to it, and in a source
 * review the source in its sca/, settled (`scaFolders`). A folder whose build check is done
 * holds its build results (`build`), whose build decision the review reads.
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
  if (!fs.existsSync(workPaths(opts.workFolder).xpi)) {
    throw wiringError(
      "runPipeline: the work folder holds no xpi/ - every review reads the add-on the load " +
        "put there (src/review/start.js loadTheXpi), and none was run."
    );
  }
  const record = readRecord(opts.workFolder);
  const { review } = await reviewLoadedSubmission({
    opts,
    llm: false,
    format: null,
    record,
  });
  return review;
}

/**
 * What the checks are selected by: the check lists, --eslint, the review mode, and the
 * reviewer's build decision in the build check, which decides which of the build checks asks
 * about the build (build-review, build-reproduces-xpi, build-unsafe).
 * @param {PipelineOpts} opts
 * @param {ReviewContext} ctx
 * @param {?object} build  The build results of a build check done in the folder, or null.
 * @returns {object}
 */
function selectionOf(opts, ctx, build) {
  return {
    only: opts.checksOnly,
    skip: opts.checksSkip,
    eslint: opts.eslint,
    sca: ctx.mode.sca,
    buildJudged: typeof build?.safe === "boolean",
    buildSafe: build?.safe === true,
  };
}

/**
 * Review the loaded submission: one subroutine for an .xpi review and a source review alike,
 * plain or LLM. It populates ctx and runs the early-exit checks. Where one of them reports an
 * error, a plain review is settled with no verdicts and reported. An LLM one starts nothing:
 * the review as the early-exit checks produced it is added to the record, with no verdicts,
 * and the review closed with the record (src/report/loop.js closeReview), which settles it
 * itself. No mode review is started, so it gets no refs, no claimed files, no sweep requests
 * and none of the LLM file names a review start adds to meta. Where they pass, a source
 * review in LLM mode starts its build check at `analyze` and issues its prompt, since the
 * normal checks read what the build check produces, and every other review runs the normal
 * checks and the review function after them (runTheNormalChecks).
 *
 * The caller sets the review up: it creates its own work folder and loads the .xpi, which
 * creates the record, adds what the run was given to the record, and a source review's caller
 * also puts the source into sca/ and settles the package root. After the early-exit checks,
 * before it reports or issues anything, the review adds to the record what the early-exit run
 * worked out (the Experiment verdict, which checks ran, and in a source review an agent runs,
 * whether its XPI could be reviewed on its own), and only that. Every later run finds it
 * there.
 * @param {{opts: PipelineOpts, llm: boolean, format: ?string, record: object}} args  The
 *   options the review runs with (the flags as given, or as recorded), whether an agent runs
 *   it, the report's format (none for a caller that prints nothing), and the record the folder
 *   holds, whose build results (`build`) are those of a build check done in the folder.
 * @returns {Promise<{code: number, review?: PipelineResult}>}  The exit code: 0 or 1 by the
 *   review's errors, 0 after the analyze prompt. A plain review returns what it reported.
 */
export async function reviewLoadedSubmission({
  opts,
  llm,
  format,
  record: given,
}) {
  const build = given.build ?? null;
  const ctx = await populateCtx(opts, workPaths(opts.workFolder), build);
  const { registry } = ctx;
  const early = await runChecks(
    registry,
    { ...selectionOf(opts, ctx, build), earlyExit: true },
    ctx.siblings
  );
  const earlyIds = early.checksRun.map((c) => c.id);
  // What this run worked out, added to the record's permanent part, where every later run
  // reads it: the Experiment verdict, the early-exit checks that ran and whether they passed,
  // and in a source review an agent runs, whether its XPI could be reviewed on its own, which
  // only the close asks.
  const passed = !early.findings.some((f) => f.severity === SEVERITY.ERROR);
  const record = addToRecord(opts.workFolder, given, {
    verification: ctx.verification,
    earlyExit: { checksRun: earlyIds, passed },
    ...(llm && ctx.mode.sca
      ? { xpiReviewable: await readableXpi(ctx.siblings.xpi) }
      : {}),
  });
  if (!passed) {
    const review = reviewOf(ctx, early, earlyIds, opts);
    if (!llm) {
      return reportReview(
        settleReview(review, {}, registry),
        review.preSweep,
        format,
        registry
      );
    }
    const { settled } = closeReview(
      opts.workFolder,
      addToRecord(opts.workFolder, record, { review }),
      registry
    );
    return { code: hasErrors(settled.findings) ? 1 : 0 };
  }
  if (llm && ctx.mode.sca) {
    const buildCheck = startMode(
      record,
      MODE.buildCheck,
      buildCheckBody(opts.scaFolders),
      BUILD_CHECK_STEP.analyze
    );
    issueHandbackPrompt(
      opts.workFolder,
      buildCheck,
      analyzeEntries(),
      stepPromptLines(opts.workFolder, buildCheck, registry, {
        first: modeOf(record) === undefined,
      })
    );
    return { code: 0 };
  }
  return runTheNormalChecks(ctx, {
    opts,
    llm,
    format,
    record,
    earlyIds,
    activity: early.activity,
  });
}

/**
 * The normal checks and the review function that follows them: every check but the early-exit
 * ones, then the review settled with no verdicts and reported (plain), or the review loop
 * started (LLM). Run by "review the loaded submission" once the early-exit checks passed, and
 * by the hand-back that finds a build check done, whose early-exit checks ran in an earlier
 * run.
 * @param {ReviewContext} ctx
 * @param {{opts: PipelineOpts, llm: boolean, format: ?string, record: object,
 *   earlyIds: string[], activity?: object}} args  As
 *   reviewLoadedSubmission's, with the early-exit checks that ran and the feed's count so far.
 * @returns {Promise<{code: number, review?: PipelineResult}>}  0 or 1 by the review's errors.
 */
export async function runTheNormalChecks(
  ctx,
  { opts, llm, format, record, earlyIds, activity }
) {
  const { registry } = ctx;
  const normal = await runChecks(
    registry,
    {
      ...selectionOf(opts, ctx, record.build ?? null),
      earlyExit: false,
      activity,
    },
    ctx.siblings
  );
  const ranIds = [...earlyIds, ...normal.checksRun.map((c) => c.id)];
  const review = reviewOf(ctx, normal, ranIds, opts);
  if (!llm) {
    return reportReview(
      settleReview(review, {}, registry),
      review.preSweep,
      format,
      registry
    );
  }
  const { settled } = startReviewLoop(
    review,
    record,
    loopStart(ctx, opts, new Set(ranIds))
  );
  return { code: hasErrors(settled.findings) ? 1 : 0 };
}

/**
 * What the review loop starts with beside the review (src/report/loop.js LoopStart).
 * @param {ReviewContext} ctx
 * @param {PipelineOpts} opts
 * @param {Set<string>} ranIds  The checks that ran.
 * @returns {import("./report/loop.js").LoopStart}
 */
function loopStart(ctx, opts, ranIds) {
  const { registry } = ctx;
  return {
    work: opts.workFolder,
    registry,
    opts,
    // The submitted lock's vulnerable packages as this review's own audit counted them, where
    // the build check counted none.
    vulnerabilities: lockVulnerabilities(
      ctx.scaArchive,
      registry
        .checkIds()
        .some(
          (id) =>
            (registry.earlyExitFor(id) ?? registry.lateExitFor(id)) ===
              VULNERABILITY_EXIT && ranIds.has(id)
        )
    ),
  };
}

/**
 * The review as the checks produced it: their findings, unworded and their holds undecided,
 * and the meta the review publishes - the schema stamps, the checks that ran, the to-do list
 * and the blind-spot sweeps - which every reader settles a copy of (src/review/settle.js).
 * @param {ReviewContext} ctx
 * @param {{findings: object[], manualItems: object[]}} out  What the checks returned.
 * @param {string[]} ranIds  The checks that ran, early-exit ones first.
 * @param {PipelineOpts} opts
 * @returns {import("./review/settle.js").StoredReview}
 */
function reviewOf(ctx, out, ranIds, opts) {
  const { registry, meta, mode, siblings, schema } = ctx;
  const findings = [...out.findings];
  // An XPI review restarted from a source review that did not need its archive: its one
  // finding tells the developer to submit just the XPI next time.
  if (
    opts.downgradedFrom &&
    checkSelected(registry, SCA_NOT_NEEDED_CHECK, {
      only: opts.checksOnly,
      skip: opts.checksSkip,
    })
  ) {
    const notNeeded = finding({
      ruleId: SCA_NOT_NEEDED_CHECK,
      severity: registry.checkEntry(SCA_NOT_NEEDED_CHECK).severity,
      artifact: ARTIFACT_XPI,
    });
    // Raised here rather than by runOneCheck, so stamped here: the reviewer chose the restart.
    if (!registry.verifiedByLlm(SCA_NOT_NEEDED_CHECK)) {
      notNeeded.llmVerification = false;
    }
    findings.push(notNeeded);
  }
  // The review-derived half of meta (the base half - action/xpi/... - is the `meta` setup
  // step's): the schema stamps and the checks that ran. Meta holds facts about the run only.
  Object.assign(meta, {
    schemaSource: ctx.schemaSource,
    schemaBranch: ctx.schemaBranch,
    schemaChannel: ctx.schemaChannel,
    applicationVersion: schema.applicationVersion,
    manifestVersion: ctx.manifest?.json?.manifest_version ?? null,
    checksRun: ranIds,
  });
  // The to-do list, beside the findings. Its `extended` items are the orchestrator's
  // escalations (resolved to their registry text), the rest the by-hand manual-checks
  // entries, which every review carries unconditionally. The two origins are ONE list, each
  // carrying its own `default-note` where the check authors one: a case a check escalated and
  // a by-hand manual check are the same item to whoever answers it, so the note is appended
  // to both in one place.
  const manual = withDefaultNotes(
    [
      ...renderManualItems(out.manualItems, registry, mode).map((m) => ({
        ...m,
        extended: true,
      })),
      ...registry.manualChecks(mode).map((m) => ({ ...m, extended: false })),
    ],
    registry
  );
  // The blind-spot sweeps to run BEFORE settling this review: one bare item per sweep a check
  // that ran authors. Gated on the checks that actually RAN: sweeping the blind spot of a scan
  // that did not happen asks a reader to cover for nothing, and this is what makes
  // --checks-only/--checks-skip carry through.
  const preSweep = preSweepOf(
    registry,
    new Set(ranIds),
    mode,
    siblings,
    artifactRoots(meta)
  );
  return { report: { findings, meta, sca: mode.sca }, manual, preSweep };
}

/**
 * Report the review: the settled review, its to-dos dropped where an early or a late exit
 * aborted it (withoutQuestions), and the report printed, text or JSON, its header first, the
 * rejection report where it was aborted. A caller that prints nothing names no format.
 * The to-dos and the sweeps are put into the meta the formatter reads (`manualReview`,
 * `preSweep`) here, at print time: the stored review holds each once, beside the findings.
 * @param {import("./review/settle.js").SettledReview} settled  With no verdicts.
 * @param {?object} preSweep  The review's blind-spot sweeps, which the settled review does
 *   not carry.
 * @param {?string} format  "text" or "json", or null to print nothing.
 * @param {import("./checks/registry.js").Registry} registry
 * @returns {{code: number, review: PipelineResult}}  0 or 1 by the review's errors, and the
 *   review as printed.
 */
export function reportReview(settled, preSweep, format, registry) {
  // A plain report counts an early and a late exit alike: it has no pass left to run first.
  // The key is left off a review that was not aborted, rather than written as null - the
  // same way manualReview and preSweep are dropped from the JSON rather than emptied.
  const aborted = settled.exits.late;
  const meta = aborted
    ? {
        ...settled.meta,
        earlyExit: aborted,
        manualReview: withoutQuestions(
          orderReview(settled.findings, settled.manual)
        ),
        preSweep,
      }
    : { ...settled.meta, manualReview: settled.manual, preSweep };
  const review = {
    findings: settled.findings,
    meta,
    // The review mode, so the text report can label each finding's file:line by artifact
    // ([XPI]/[SCA]) in a source review (src/report/artifact.js).
    mode: settled.mode.sca ? REVIEW_MODE.SCA : REVIEW_MODE.XPI,
    // Severity-group headings and the verdict preamble for the text Issues section.
    issueHeadings: registry.issueHeadings(),
    verdictIntros: registry.verdictIntros(),
  };
  if (format) {
    // report(), not the feed: the header belongs to the document, and is absent from JSON.
    for (const line of headerLines(meta)) {
      report(line);
    }
    report("");
    writeToStdout(`${formatReview(review, format)}\n`);
  }
  return { code: hasErrors(review.findings) ? 1 : 0, review };
}

/**
 * What a review's checks read, made before any of them runs: the add-on in the work folder's
 * xpi/ and, in a source review, the source in its sca/, both read where they are; what the
 * add-on declares; the review schema; the Experiment verdict; and the contexts each check is
 * routed to, with the review data they compute when a check first asks. Narrated as the
 * "Setup" section of the feed.
 *
 * The one place that hard-codes how review data is made. It claims nothing and writes
 * nothing into the work folder, and it reads none of the options only the review needs
 * (what an agent is asked, the check lists, --eslint). What it fetches lands in the caches
 * outside the work folder.
 * @param {PipelineOpts} opts
 * @param {ReturnType<typeof workPaths>} work  The work folder's names.
 * @param {?object} build  The build results a done build check added to the record
 *   (src/build-check/state.js buildResults), where the review starts in such a folder.
 * @returns {Promise<ReviewContext>}
 */
export async function populateCtx(opts, work, build) {
  const { addonPath } = opts;
  // `addonPath` IS the shipped add-on's path, absolute, and the single value the run has
  // for "which add-on": what the report names, and where the work folder and its files go. An Addon carries no path of its own
  // (src/addon/load.js), and nothing here resolves one - the arg-array reader did.
  // SCA (source code archive) mode is on when --sca-extracted is set, and the whole extracted
  // archive is the review source. It splits the review across TWO add-on artifacts with a fixed
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
  // dependency resolution (--sca-package-root vs the XPI's VENDOR/package.json) and the
  // check gates (ctx.mode -> modeEligible, and a check's `when: sca`). Minified code is
  // non-authored (and rejected) in both modes: a source-code submission's promise is
  // readable source, so a minified file in the archive is rejected like one in an XPI, not
  // scanned as authored. The source view holds every file but the Experiment - the code
  // and the tooling are one set of files, which is what the build checks want.
  //
  // The review mode is DERIVED from one fact below and assigned nowhere, so it cannot drift
  // from the steps that ran: a source archive (--sca-extracted) makes it a source code review. Every reader - the
  // steps, the ctx builders, the report - reads that one derivation.
  // The parsed registry, threaded from main() (or loaded once here when a caller
  // such as the test harness invokes the pipeline directly), read under THIS run's band
  // policy. Applied here rather than at either construction site, so a caller that hands one
  // in and a caller that leaves it to be loaded get the same reading of the same flag.
  const registry = (opts.registry ?? loadRegistry()).withPolicy({
    warningsAsErrors: Boolean(opts.warningsAsErrors),
  });

  // The package root, settled in the work folder's `sca/` before the review by its caller
  // (src/addon/package-root.js settlePackageRoot), and handed in as `scaMoved` where it moved
  // below the folder named. The narration comes later, with the rest of Setup.
  const scaMoved = opts.scaMoved ?? null;

  // Load the .xpi. Read before the "Setup" banner because it sizes the feed - it gives
  // the mode and whether the add-on is an Experiment. The eager steps below (the schema
  // fetch, the experiment fetch) are narrated as Setup steps; the review's data is
  // narrated where a check first asks for it (src/review/products.js). The add-on reads
  // are fast local ones (this .xpi, and in a source review the source archive) marked by
  // the "Reading add-on" step.
  // The add-on is read from its copy in the work folder, not in memory and not where it was
  // submitted: XPI_ROOT is a single folder the load wrote once (src/review/start.js
  // loadTheXpi), and every reader - the checks below, a reviewer, an LLM agent - reads back
  // from it, never two representations of one submission. A packed .xpi was extracted there
  // and an unpacked folder copied there, so the files a review names sit in one folder
  // whichever was submitted, and nothing an agent does in XPI_ROOT can reach the submission
  // itself. Read where it is, never extracted again, so the review reads what the load
  // decided its verdict from.
  const xpiAddon = loadAddon(work.xpi, undefined, { kind: ARTIFACT_XPI });
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
    sca: Boolean(opts.scaFolders),
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
    // The verdict (experimentVerdict) is read from the review's own xpi/. It fetches the
    // allow-list only
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
      // The verdict the record holds where an earlier run decided it (`verification`), so it
      // is decided once, by the run that runs experiment-not-allowed.
      experimentVerification =
        opts.verification !== undefined
          ? opts.verification
          : (await experimentVerdict(xpiAddon, webExtManifestRecord, opts))
              .verification;
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
        // at all because the package root is then not the folder the command named - the
        // reviewer has to be able to see which folder their verdicts are about.
        if (scaMoved) {
          const inSca = (rel) => path.join("sca", rel);
          progress(
            `Package root: ${inSca(scaMoved.to)} (${inSca(scaMoved.from)} holds no package.json)`,
            FEED.DETAIL
          );
        }
        // The two ways a submitted source archive is not an add-on. An installed
        // dependency tree is not content: the reviewer installs it from the declared
        // package file and lock, so a committed one is recorded and rejected rather than read.
        // And a manifest.json in the archive is a PRE-BUILD template, not what Thunderbird
        // loads, so none is read - ctx.manifest is the shipped one and must be the only
        // answer. The built add-on above is loaded the ordinary way, where a node_modules
        // folder is shipped content like any other and the manifest.json IS the artifact's.
        // The whole extracted archive is the source, so code a build takes from beside or
        // above the package root is reviewed like the rest. The package root is the place in
        // it the package file and the lock are read at.
        scaArchive = loadSourceArchive(opts.scaFolders.used);
        scaViews(scaArchive, opts.scaFolders);
        // Where the source is a rescued copy, the package files of the package root it was copied
        // from - what the developer submitted - for the check that tells them the review
        // ran on changed dependencies. Null for every other source.
        scaArchive.originalPackages = originalPackages(opts.scaFolders);
        // The reviewer's own reasons for holding the build unsafe, where they gave some, and
        // the issues the build analysis listed, which build-unsafe reports. Null and none for
        // every other source.
        scaArchive.buildReasons = build?.reasons ?? null;
        scaArchive.buildIssues = build?.issues ?? [];
      }
    },

    "target-source": () => {
      reviewTarget = scaArchive;
    },

    // The review target of every other review: the .xpi itself.
    "target-xpi": () => {
      reviewTarget = xpiAddon;
    },

    // What was reviewed, named by ARTIFACT rather than by role: `xpi` is the shipped add-on
    // in EVERY review, and a source code review adds its folders - the source copy, the
    // package root, and the Experiment folder when one was named. One field meaning "the review
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
        // Its folders as the review read them, the Experiment folder among them exactly where
        // the add-on declares Experiments: that subtree is privileged code and is excluded
        // from the WebExtension checks, which a reader of the report or of the JSON must be
        // able to see.
        ...(scaArchive ? { scaFolders: opts.scaFolders } : {}),
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
  // hosts are asked through the run's cache: a source review's questions were mostly asked
  // by its build check already. A pinned library source is downloaded through the sources
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

  progress(""); // close the Setup section before runChecks prints "── Activity ──"
  return {
    registry,
    manifest: webExtManifestRecord,
    verification: experimentVerification,
    scaArchive,
    schema,
    schemaSource,
    schemaBranch,
    schemaChannel,
    meta,
    mode,
    siblings,
  };
}

/** The check an XPI review restarted from a source review reports (opts.downgradedFrom). */
const SCA_NOT_NEEDED_CHECK = "sca-not-needed";

/**
 * Whether the built XPI could be reviewed on its own: no file or inline script in it is
 * minified first-party code, obfuscated, or an untrusted minified library.
 * @param {import("./checks/registry.js").RunContext} xpiCtx  The built XPI's ctx.
 * @returns {Promise<boolean>}
 */
async function readableXpi(xpiCtx) {
  for (const c of await classifyAddonJs(xpiCtx)) {
    if (
      c.obfuscation.fail ||
      isMinifiedFirstParty(c) ||
      (c.untrusted && c.minified)
    ) {
      return false;
    }
  }
  for (const site of await classifyInlineScripts(xpiCtx)) {
    if (site.obfuscation.fail || site.minified) {
      return false;
    }
  }
  return true;
}

/** The abort reason the dependency-vulnerability checks share: the checks that read the
 *  lock audit's lists (src/build-check/audit.js LOCK_AUDIT_LISTS). */
const VULNERABILITY_EXIT = "known-vulnerabilities";

/**
 * The vulnerable packages of the lock this review read, counted by severity from its own
 * audit, as the build check counts a lock it audited (vulnerabilityCounts). Null where the
 * audit did not happen. It happened once any dependency-vulnerability check ran: each reads
 * the vendor reading, which audits the whole lock first and records every list at once, or
 * ends the run (src/vendor/verify.js auditLockedPackages). Null too where there is no lock
 * or it cannot be read: the audit then saw no tree, which is not a clean one.
 * @param {?import("./addon/load.js").Addon} archive  The source archive, or null.
 * @param {boolean} audited  A dependency-vulnerability check ran.
 * @returns {?import("./build-check/audit.js").VulnerabilityCounts}
 */
function lockVulnerabilities(archive, audited) {
  const vendor = archive?.vendor;
  if (
    !vendor ||
    !audited ||
    governingLock(archive) === null ||
    unreadableLock(archive) !== null
  ) {
    return null;
  }
  return vulnerabilityCounts({
    lists: Object.fromEntries(
      LOCK_AUDIT_LISTS.map((l) => [l, vendor[l] ?? []])
    ),
    moderate: vendor.moderateVulnerabilities ?? [],
  });
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
 * and the same items are what each sweep agent's request is built from - so a
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
    // A NUMBER, and nothing a reader has to decode: a sweep agent is told which
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
