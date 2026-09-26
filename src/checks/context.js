// Builds the sibling RunContexts every check runs against. Each artifact the orchestrator may
// route a check to - the built XPI, the readable source, that source without its parsed code
// (the build route), and the shipped
// manifest.json - gets its own ctx, and all of them project ONE shared review env: the schema, the
// shipped manifest.json and experiments, and the mode. The pipeline
// (pipeline.js) resolves the schema, parses the sources, and builds that shared env;
// this module only derives ctx.apiUsages from the already-parsed sources and swaps the
// per-artifact fields for each sibling.
//
// Belongs here: assembling the per-artifact sibling ctxs from the shared review env -
// projecting the already-parsed JsSources into the RunContext shape registry.js documents.
//
// Does NOT belong here: PARSING. The extraction pass (src/checks/extract.js) parses each source
// once, up front, and its results arrive already parsed - this module never reaches for an AST.
// Nor LOADING any review-level singleton: the pipeline does that once and hands it in via
// the env. Nor any individual review logic - that lives in a rule under src/checks/rules/*.
// The RunContext type and runChecks live in src/checks/registry.js.

import { apiUsageOf } from "./extract.js";

/** @typedef {import("./registry.js").RunContext} RunContext */

/**
 * @typedef {object} ReviewEnv  The review-level state shared by every sibling ctx, built ONCE
 *   by the pipeline (src/pipeline.js) and handed to both ctx builders. It carries only what is
 *   the SAME across artifacts, so a sibling can never drift from another: the schema, the
 *   shipped manifest.json and experiments, the review mode (+ the two SCA paths/scaNotRequired)
 *   and the invalid-Experiment flag.
 * @property {import("../schema/index.js").SchemaIndex} schema
 * @property {{allowExperiments?: boolean, libraryHashes?: Map<string, object>}} options
 * @property {object} mode  The REVIEW_MODE enum member (XPI/SCA); read as `mode?.sca`.
 * @property {boolean} scaNotRequired
 * @property {boolean} invalidExperiment
 * @property {?import("../addon/load.js").ManifestRecord} manifest
 * @property {?object} experiments
 */

/**
 * The check-facing artifact: the routed add-on projected to only its INTRINSIC data - the
 * fields a check legitimately reads off ctx.addon. An ALLOWLIST, not a strip: a field not
 * named here CANNOT reach a check, so a new Addon field can never leak onto the check surface
 * by omission (a blocklist would leak until someone remembered to delete it - all it takes
 * for a field like `skipped` to put load-time narration in front of a check). If this list is
 * ever INCOMPLETE, a check reads undefined and the tests fail loudly - the safe failure
 * direction.
 *
 * `files` is the addon's own corpus (referenced, not cloned), so a check reads the real
 * bytes. `store` is the SUBMISSION's, which in a source review is the whole --sca-root while
 * `files` gives up the Experiment subtree: the frame the package file and the lock are
 * written in. It is named here because a dependency finding anchors at that file and has
 * to find it to report a line; a check reaching for `store` is saying it wants the
 * submission rather than the add-on, which is a different question, not a wider one. In an
 * XPI review `files` reviews every key the store has. `experiment` is the privileged Experiment
 * implementation (--sca-exp-source), which `files` deliberately excludes so the
 * WebExtension checks never see Services/ChromeUtils code: a check that reviews a file for
 * what it IS rather than for which API it calls - minified, obfuscated, a known library -
 * reads both, and when the Experiment sits inside the add-on the two share a keyspace so
 * the union is the add-on's whole tree.
 * `vendor`/`bundled` are the pipeline's pre-computed, reconciled classification (the lazy
 * fallbacks would recompute a less-complete one). `nodeModules`/`archives`/`buildReview` serve
 * the SCA archive, which the sca ctx projects; they are undefined on the xpi/source/manifest
 * routes, which is harmless. `symlinks` rides
 * beside them but is NOT one of them: the xpi route carries it too, because an add-on holds
 * a link to a stricter standard than a source archive does and needs the same facts to say
 * so, and `directories` rides with it for the file:/link: walk a lock check runs. The lazy
 * caches
 * (locales/localizedNames/evalScan/outboundSinks/permissionAnalysis/apiResolution, and the
 * bundled fallback)
 * attach themselves on demand via `ctx.addon.X ??= …`, so they need no seeding.
 *
 * DELIBERATELY ABSENT: manifest.json and experiments are shipped-authoritative and exposed as
 * ctx.manifest / ctx.experiments (so a check cannot read one artifact's manifest.json against
 * another's files). For the archive there is also nothing to withhold: it is loaded without
 * reading a manifest.json (src/addon/load.js), so its `manifest` is null and the record this
 * would strip exists only on the built XPI. skipped is read by no check. An Addon carries no
 * path of its own to withhold (src/addon/load.js) - a check addresses files by the keys of
 * this `files` Map.
 * @param {import("../addon/load.js").Addon} addon  The routed add-on.
 * @returns {object} The intrinsic-only view.
 */
function reviewView(addon) {
  return {
    files: addon.files,
    store: addon.store,
    experiment: addon.experiment,
    vendor: addon.vendor,
    bundled: addon.bundled,
    nodeModules: addon.nodeModules,
    archives: addon.archives,
    symlinks: addon.symlinks,
    directories: addon.directories,
    buildReview: addon.buildReview,
  };
}

/**
 * Per-source api-usage in the ctx.apiUsages shape (file + inline + the extracted usage),
 * derived from sources ALREADY through the extraction pass - this module never parses.
 * @param {import("../addon/sources.js").JsSource[]} jsSources
 * @returns {object[]}
 */
function deriveApiUsages(jsSources) {
  return jsSources.map((src) => ({
    file: src.file,
    inline: src.inline,
    ...apiUsageOf(src),
  }));
}

/**
 * Project one sibling RunContext from the shared review `env` onto a single artifact. Every
 * review-level field (schema, the shipped manifest.json and experiments, mode, the
 * two SCA paths) is copied from `env`, so all siblings share them
 * by reference and cannot drift; only the per-artifact `addon` (via reviewView), its parsed
 * `jsSources`/`apiUsages`, and the shipped-view flag differ. The manifest.json and experiments are
 * shipped-authoritative (read off `env`, never off `addon`), so a check cannot read one
 * artifact's manifest.json against another's files - reviewView strips them from ctx.addon.
 * @param {ReviewEnv} env
 * @param {object} artifact
 * @param {import("../addon/load.js").Addon} artifact.addon  The routed artifact (or corpus).
 * @param {import("../addon/sources.js").JsSource[]} artifact.jsSources
 * @param {object[]|undefined} artifact.apiUsages  Per-source usage, or undefined for a corpus
 *   with no reviewable sources (the manifest / sca ctxs).
 * @param {boolean} [artifact.isShippedView]  Mark the built-XPI view for reachability (SCA
 *   only - in an XPI review the XPI IS the review target, so it is NOT a distinct shipped view).
 * @returns {RunContext}
 */
function projectCtx(
  env,
  { addon, jsSources, apiUsages, isShippedView = false }
) {
  /** @type {RunContext} */
  const ctx = {
    addon: reviewView(addon),
    schema: env.schema,
    jsSources,
    apiUsages,
    options: env.options,
    invalidExperiment: env.invalidExperiment,
    // "xpi" (a built add-on) or "sca" (a source-code archive review, --sca-root). Gates checks
    // via scaEligible.
    mode: env.mode,
    // The shipped XPI turned out to BE the submitted source, so an XPI-only submission would
    // have been enough. The sca-not-required check reads this to say so. Advice only - this
    // review is a full SCA review either way.
    scaNotRequired: env.scaNotRequired,
    // The authoritative manifest.json and experiments are the SHIPPED artifact's (the built XPI) - what
    // Thunderbird actually loads. Explicit shared context like `schema`, so the manifest.json /
    // permission / API / experiment checks read them here, never off ctx.addon (reviewView
    // strips the record, and in SCA the archive was loaded without one anyway). The record
    // passes through whole: the parse, the bytes, the parse error and the line index are one
    // artifact's one answer, and splitting one answer is how its parts drift apart.
    manifest: env.manifest,
    experiments: env.experiments,
  };
  if (isShippedView) {
    // The built XPI's manifest.json entry points resolve against its OWN files, so
    // pureWebExtensionReachable takes the closure branch - not the SCA "all readable-source
    // files" fallback, which exists only for the review source, whose pre-build layout the
    // manifest.json's built paths miss.
    ctx.isShippedView = true;
  }
  return ctx;
}

/**
 * The ctx over the BUILT XPI - always analysed, in both review modes. It serves the
 * `input: xpi` checks: the structure checks (bundled-files,
 * minimize-web-accessible-resources, ...), the manifest.json checks (the shipped manifest.json
 * IS this artifact's), the diff + packaging summaries, and - in an XPI review - the whole
 * review, since it IS siblings.source, the review target.
 * The XPI goes through the SAME full extraction pass in both modes, so it carries the
 * XPI's OWN per-source api-usage and an `input: xpi` check sees the identical artifact whether
 * the run is an XPI review or an SCA review. A reviewable XPI MUST arrive parsed; only a rejected
 * Experiment (env.invalidExperiment) may have no sources, and it reviews with an empty corpus
 * (its one check reads no code).
 * @param {import("../addon/load.js").Addon} xpiAddon  The built XPI.
 * @param {import("../addon/sources.js").JsSource[]|undefined} xpiParsedSources  Its sources,
 *   already through the full extraction pass (Phase 2). Absent only for a rejected Experiment.
 * @param {ReviewEnv} env  The shared review-level state (see projectCtx).
 * @returns {RunContext}
 */
export function buildXpiCtx(xpiAddon, xpiParsedSources, env) {
  if (!env.invalidExperiment && !xpiParsedSources) {
    throw new Error(
      "buildXpiCtx: a reviewable built XPI arrived with no parsed sources " +
        "(the extraction pass must run and hand them over)"
    );
  }
  const jsSources = xpiParsedSources ?? [];
  return projectCtx(env, {
    addon: xpiAddon,
    jsSources,
    apiUsages: deriveApiUsages(jsSources),
    // A distinct shipped view ONLY in SCA. In an XPI review xpiCtx IS siblings.source (the
    // review target), so it must NOT flag the shipped-view reachability branch.
    isShippedView: Boolean(env.mode?.sca),
  });
}

/**
 * The two sibling ctxs an SCA review adds, named for the ARTIFACT each is over, never for
 * the mode that produced them:
 *   - `sourceCtx` over the archive's add-on code, which in an SCA review is the review
 *                 target, so it becomes siblings.source. (In an XPI review that same slot
 *                 holds the XPI: `source` names the target, never an artifact.)
 *   - `scaCtx`  the same archive with no parsed source, for the `input: sca` checks, read
 *                 off ctx.addon via the same one-place `input` routing, no separate field.
 *                 A build check reads files and the recorded lists, never code.
 * Both project the shipped manifest.json and experiments from `env`
 * (so no artifact's manifest.json leaks against another's files, and the review-level singletons stay
 * single-instance). The source MUST arrive parsed.
 * @param {import("../addon/load.js").Addon} archive  The submitted archive, carrying its
 *   corpora (scaViews): `files` is everything but the Experiment implementation.
 * @param {import("../addon/sources.js").JsSource[]} sourceParsedSources  Its parsed sources.
 * @param {ReviewEnv} env
 * @returns {{sourceCtx: RunContext, scaCtx: RunContext}}
 */
export function buildScaCtxs(archive, sourceParsedSources, env) {
  if (!sourceParsedSources) {
    throw new Error(
      "buildScaCtxs: the readable source arrived with no parsed sources " +
        "(the extraction pass must run and hand them over)"
    );
  }
  const sourceCtx = projectCtx(env, {
    addon: archive,
    jsSources: sourceParsedSources,
    apiUsages: deriveApiUsages(sourceParsedSources),
  });
  // The same archive, with no parsed source: a build check reads files and recorded lists,
  // never code. One owner, projected per route, is what keeps two views of one archive from
  // disagreeing about what it holds.
  const scaCtx = projectCtx(env, {
    addon: archive,
    jsSources: [],
    apiUsages: undefined,
  });
  return { sourceCtx, scaCtx };
}
