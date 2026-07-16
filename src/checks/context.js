// Builds the sibling RunContexts every check runs against. Each artifact the orchestrator may
// route a check to - the built XPI, the readable source, the SCA build corpus, and the shipped
// manifest - gets its own ctx, and all of them project ONE shared review env: the schema, the
// shipped manifest/experiments, the mode, the single llm client, the diff baseline, and the
// untrusted-content nonce. The pipeline (pipeline.js) resolves the schema, parses the sources,
// and builds that shared env (including the llm client and the --diff-to baseline, both
// review-level singletons); this module only derives ctx.apiUsages from the already-parsed
// sources and swaps the per-artifact fields for each sibling.
//
// Belongs here: assembling the per-artifact sibling ctxs from the shared review env -
// orchestrating addon/sources.js into the RunContext shape that registry.js documents.
//
// Does NOT belong here: PARSING. The extraction pass (src/checks/extract.js) parses each source
// once, up front, and its results arrive already parsed - this module never reaches for an AST.
// Nor BUILDING the llm client (src/checks/llm-client.js, invoked by the pipeline) or LOADING the
// --diff-to baseline: the pipeline does both once, as review-level singletons, and hands them in
// via the env. Nor any individual review logic - that lives in a rule under src/checks/rules/*.
// The RunContext type and runChecks live in src/checks/registry.js.

import { apiUsageOf } from "./extract.js";

/** @typedef {import("./registry.js").RunContext} RunContext */

/**
 * @typedef {object} ReviewEnv  The review-level state shared by every sibling ctx, built ONCE
 *   by the pipeline (src/pipeline.js) and handed to both ctx builders. It carries only what is
 *   the SAME across artifacts, so a sibling can never drift from another: the schema, the
 *   shipped manifest/experiments, the review mode (+ scaExpSource/scaNotRequired), the
 *   invalid-Experiment flag, the --diff-to baseline (`previous`), the ONE llm client (or
 *   undefined), and the per-review untrusted-content `nonce`. The LLM token is NEVER here - the
 *   client is already built, so the secret never reaches the check-facing ctx.
 * @property {import("../schema/index.js").SchemaIndex} schema
 * @property {{allowExperiments?: boolean, libraryHashes?: Map<string, object>}} options
 * @property {object} mode  The REVIEW_MODE enum member (XPI/SCA); read as `mode?.sca`.
 * @property {string} [scaExpSource]
 * @property {boolean} scaNotRequired
 * @property {boolean} invalidExperiment
 * @property {?object} manifest
 * @property {?object} manifestError
 * @property {?object} manifestLoc
 * @property {string} manifestText
 * @property {?object} experiments
 * @property {?import("../addon/load.js").Addon} previous
 * @property {object} [llm]
 * @property {string} nonce
 */

/**
 * The check-facing artifact: the routed add-on projected to only its INTRINSIC data - the
 * fields a check legitimately reads off ctx.addon. An ALLOWLIST, not a strip: a field not
 * named here CANNOT reach a check, so a new Addon field can never leak onto the check surface
 * by omission (a blocklist would leak until someone remembered to delete it - which is how
 * buildFiles once exposed the SCA build tree to input:source checks). If this list is ever
 * INCOMPLETE, a check reads undefined and the tests fail loudly - the safe failure direction.
 *
 * `files` is the addon's own Map (referenced, not cloned), so a check reads the real bytes.
 * `vendor`/`bundled` are the pipeline's pre-computed, reconciled classification (the lazy
 * fallbacks would recompute a less-complete one). `nodeModules`/`archives`/`buildReview` serve
 * the SCA build corpus (reviewView also projects addon.buildFiles for the input:build checks);
 * they are undefined on the xpi/source/manifest routes, which is harmless. The lazy caches
 * (locales/evalScan/outboundSinks/permissionAnalysis/apiResolution, and the bundled fallback)
 * attach themselves on demand via `ctx.addon.X ??= …`, so they need no seeding.
 *
 * DELIBERATELY ABSENT: manifest/manifestError/manifestLoc and experiments are
 * shipped-authoritative and exposed as ctx.manifest / ctx.experiments (so a check cannot read
 * one artifact's manifest against another's files); buildFiles is the wrong artifact for a
 * review check; source/kind/skipped are read by no check.
 * @param {import("../addon/load.js").Addon} addon  The routed add-on (or the build corpus).
 * @returns {object} The intrinsic-only view.
 */
function reviewView(addon) {
  return {
    files: addon.files,
    vendor: addon.vendor,
    bundled: addon.bundled,
    nodeModules: addon.nodeModules,
    archives: addon.archives,
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
 * review-level field (schema, the shipped manifest/experiments, mode, the ONE llm client, the
 * diff baseline, the untrusted-content nonce) is copied from `env`, so all siblings share them
 * by reference and cannot drift; only the per-artifact `addon` (via reviewView), its parsed
 * `jsSources`/`apiUsages`, and the shipped-view flag differ. The manifest/experiments are
 * shipped-authoritative (read off `env`, never off `addon`), so a check cannot read one
 * artifact's manifest against another's files - reviewView strips them from ctx.addon.
 * @param {ReviewEnv} env
 * @param {object} artifact
 * @param {import("../addon/load.js").Addon} artifact.addon  The routed artifact (or corpus).
 * @param {import("../addon/sources.js").JsSource[]} artifact.jsSources
 * @param {object[]|undefined} artifact.apiUsages  Per-source usage, or undefined for a corpus
 *   with no reviewable sources (the manifest / build ctxs).
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
    // The check-facing artifact is the routed add-on's INTRINSIC view (reviewView): files +
    // self-healing derivations, with the manifest/experiments stripped so they can only be read
    // through the shipped-authoritative env fields below.
    addon: reviewView(addon),
    schema: env.schema,
    jsSources,
    apiUsages,
    options: env.options,
    // The --diff-to baseline (the pipeline loaded it ONCE for the whole review).
    previous: env.previous,
    invalidExperiment: env.invalidExperiment,
    // "xpi" (a built add-on) or "sca" (a source-code archive review, --sca-root). Gates checks
    // via scaEligible.
    mode: env.mode,
    // SCA mode: the Experiment folder as a source-relative path, excluded from the WebExtension
    // code checks by buildReachability. Undefined in XPI mode.
    scaExpSource: env.scaExpSource,
    // A submitted SCA was downgraded to this XPI review because the shipped XPI is directly
    // reviewable; the sca-not-required check reads this to report the redundant source submission.
    scaNotRequired: env.scaNotRequired,
    // The authoritative manifest/experiments are the SHIPPED artifact's (the built XPI) - what
    // Thunderbird actually loads. Explicit shared context like `schema`, so the manifest /
    // permission / API / experiment checks read them here, never off ctx.addon (reviewView
    // strips those, which in SCA would be the readable source's pre-build template).
    manifest: env.manifest,
    manifestError: env.manifestError,
    manifestLoc: env.manifestLoc,
    manifestText: env.manifestText,
    experiments: env.experiments,
    // The per-review nonce that delimits untrusted add-on content in every LLM prompt. Set
    // eagerly and identically on every sibling (the client was built with this same nonce), so a
    // summary's wrapped content and the client's framing always agree - independently-built
    // ctxs cannot each mint their own.
    __nonce: env.nonce,
  };
  // The ONE verified model client, or none. Present === "a verified client exists, safe to call
  // the model"; every consumer tests ctx.llm and none re-derives the decision.
  if (env.llm) {
    ctx.llm = env.llm;
  }
  if (isShippedView) {
    // The built XPI's manifest entry points resolve against its OWN files, so
    // pureWebExtensionReachable takes the closure branch - not the SCA "all readable-source
    // files" fallback, which exists only for the review source, whose pre-build layout the
    // manifest's built paths miss.
    ctx.isShippedView = true;
  }
  return ctx;
}

/**
 * The sibling ctxs derived from the BUILT XPI - always analysed, in both review modes:
 *   - `xpiCtx`       the shipped artifact itself, for the `input: xpi` structure checks
 *                    (bundled-files, minimize-web-accessible-resources, ...), the diff +
 *                    packaging summaries, and - in an XPI review - the whole review (it IS
 *                    siblings.source, the review target).
 *   - `manifestCtx`  an EMPTY file corpus carrying only the shipped manifest, for the
 *                    `input: manifest` checks (they read ctx.manifest and reach no files, so a
 *                    stray lookup finds nothing rather than another artifact's bytes).
 * The XPI goes through the SAME full extraction pass in both modes, so `xpiCtx` carries the
 * XPI's OWN per-source api-usage and an `input: xpi` check sees the identical artifact whether
 * the run is an XPI review or an SCA review. A reviewable XPI MUST arrive parsed; only a rejected
 * Experiment (env.invalidExperiment) may have no sources, and it reviews with an empty corpus
 * (its one check reads no code).
 * @param {import("../addon/load.js").Addon} xpiAddon  The built XPI.
 * @param {import("../addon/sources.js").JsSource[]|undefined} xpiParsedSources  Its sources,
 *   already through the full extraction pass (Phase 2). Absent only for a rejected Experiment.
 * @param {ReviewEnv} env  The shared review-level state (see projectCtx).
 * @returns {{xpiCtx: RunContext, manifestCtx: RunContext}}
 */
export function buildXpiCtxs(xpiAddon, xpiParsedSources, env) {
  if (!env.invalidExperiment && !xpiParsedSources) {
    throw new Error(
      "buildXpiCtxs: a reviewable built XPI arrived with no parsed sources " +
        "(the extraction pass must run and hand them over)"
    );
  }
  const jsSources = xpiParsedSources ?? [];
  const xpiCtx = projectCtx(env, {
    addon: xpiAddon,
    jsSources,
    apiUsages: deriveApiUsages(jsSources),
    // A distinct shipped view ONLY in SCA. In an XPI review xpiCtx IS siblings.source (the
    // review target), so it must NOT flag the shipped-view reachability branch.
    isShippedView: Boolean(env.mode?.sca),
  });
  const manifestCtx = projectCtx(env, {
    addon: { files: new Map() },
    jsSources: [],
    apiUsages: undefined,
  });
  return { xpiCtx, manifestCtx };
}

/**
 * The sibling ctxs derived from the readable SOURCE - SCA reviews only:
 *   - `scaCtx`    the review target (the readable source subtree) the code checks analyse and
 *                 the behavioral --llm-review describes. It is siblings.source in an SCA review.
 *   - `buildCtx`  the SCA BUILD files (scripts/configs/package.json outside the review source,
 *                 node_modules/dotfiles excluded) on ctx.addon, for the `input: build` check -
 *                 read off ctx.addon via the same one-place `input` routing, no separate field.
 * Both project the shipped manifest/experiments + the one llm client / diff baseline from `env`
 * (so no artifact's manifest leaks against another's files, and the review-level singletons stay
 * single-instance). The source MUST arrive parsed.
 * @param {import("../addon/load.js").Addon} source  The readable review source.
 * @param {import("../addon/sources.js").JsSource[]} sourceParsedSources  Its parsed sources.
 * @param {{files: Map<string, Buffer>, nodeModules?: string[], archives?: string[]}} buildFiles
 *   The build corpus (nodeModules/archives ride along via reviewView for the build checks).
 * @param {ReviewEnv} env
 * @returns {{scaCtx: RunContext, buildCtx: RunContext}}
 */
export function buildScaCtxs(source, sourceParsedSources, buildFiles, env) {
  if (!sourceParsedSources) {
    throw new Error(
      "buildScaCtxs: the readable source arrived with no parsed sources " +
        "(the extraction pass must run and hand them over)"
    );
  }
  const scaCtx = projectCtx(env, {
    addon: source,
    jsSources: sourceParsedSources,
    apiUsages: deriveApiUsages(sourceParsedSources),
  });
  const buildCtx = projectCtx(env, {
    addon: buildFiles,
    jsSources: [],
    apiUsages: undefined,
  });
  return { scaCtx, buildCtx };
}
