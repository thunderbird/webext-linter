// Builds the sibling RunContexts every check runs against. There is ONE ctx per artifact -
// the built XPI, and in a source review the submitted archive - plus the route that carries
// every artifact at once. `source` gets no ctx of its own: it points at whichever artifact
// the review mode makes the target. They all project ONE shared review env: the schema,
// the shipped manifest.json and experiments, and the mode. Each per-artifact ctx also carries
// that artifact's DATA getters (ctx.vendor(), ctx.bundled(), ctx.jsSources(),
// ctx.apiUsages(), ctx.buildReview()), which compute on first ask (src/review/products.js).
//
// Belongs here: assembling the per-artifact sibling ctxs from the shared review env and the
// artifact's data getters, in the RunContext shape registry.js documents.
//
// Does NOT belong here: computing the data (src/review/products.js), LOADING any review-level
// singleton (the pipeline does that once and hands it in via the env), or any individual
// review logic - that lives in a rule under src/checks/rules/*. The RunContext type and
// runChecks live in src/checks/registry.js.

import { wiringError } from "../lib/errors.js";

/** @typedef {import("./registry.js").RunContext} RunContext */

/**
 * @typedef {object} ReviewEnv  The review-level state shared by every sibling ctx, built ONCE
 *   by the pipeline (src/pipeline.js) and handed to every ctx builder. It carries only what is
 *   the SAME across artifacts, so a sibling can never drift from another: the schema, the
 *   shipped manifest.json and experiments, the review mode and the
 *   invalid-Experiment flag. Where the source and the Experiment sit on disk is NOT here: it
 *   is settled once, when the archive is split into views (src/addon/load.js scaViews), and a
 *   check reads the files it was routed rather than a path.
 * @property {import("../schema/index.js").SchemaIndex} schema
 * @property {{allowExperiments?: boolean}} options
 * @property {object} mode  The REVIEW_MODE enum member (XPI/SCA); read as `mode?.sca`.
 * @property {boolean} invalidExperiment
 * @property {?import("../addon/load.js").WebExtManifestRecord} manifest
 * @property {?object} experiments
 */

/**
 * Project one sibling RunContext from the shared review `env` onto a single artifact. Every
 * review-level field (schema, the shipped manifest.json and experiments, mode) is copied from
 * `env`, so all siblings share them by reference and cannot drift; only the artifact itself
 * and its data getters differ. The manifest.json and
 * experiments are shipped-authoritative - read off `env`, which asked the built XPI once - so
 * a check cannot read one artifact's manifest.json against another's files.
 * @param {ReviewEnv} env
 * @param {object} routed
 * @param {import("../addon/load.js").Addon} [routed.artifact]  The routed artifact, linked
 *   by reference: ctx.artifact IS the object the loader produced. Absent for the ONE route
 *   that can be about more than one artifact (the `all` ctx), which names them instead.
 *   A check reads the artifact's own files off it; what the review COMPUTES about it comes
 *   through the data getters, never off the artifact.
 * @param {import("../review/products.js").ArtifactData} routed.data  The artifact's data
 *   getters. A getter for data this artifact never has throws, so a check has no reason to
 *   ask whether data EXISTS - the only way it cannot is that the check declared the wrong
 *   `input`. A value that is null is the other thing entirely: `experiments` below is a
 *   verdict or null, and null is that artifact's answer (it declares none).
 * @returns {RunContext}
 */
function projectCtx(env, { artifact, data }) {
  /** @type {RunContext} */
  const ctx = {
    // Per-ctx scratch for the memoized derivations (see the lazy accessors in src/lib/*),
    // each computed once on first ask. Its own field, so nothing derived is mistaken for
    // something the artifact was loaded with.
    cache: {},
    schema: env.schema,
    // The artifact's data, each computed on first ask and shared by every check after it.
    vendor: data.vendor,
    bundled: data.bundled,
    jsSources: data.jsSources,
    apiUsages: data.apiUsages,
    buildReview: data.buildReview,
    options: env.options,
    invalidExperiment: env.invalidExperiment,
    // "xpi" (a built add-on) or "sca" (a source-code archive review, --sca-root). Gates checks
    // via modeEligible.
    mode: env.mode,
    // The authoritative manifest.json and experiments are the SHIPPED artifact's (the built
    // XPI) - what Thunderbird actually loads. Explicit shared context like `schema`, so the
    // manifest.json / permission / API / experiment checks read them here and no artifact
    // carries an answer of its own to be read instead. The record passes through whole: the
    // parse, the bytes, the parse error and the line index are one artifact's one answer, and
    // splitting one answer is how its parts drift apart.
    manifest: env.manifest,
    experiments: env.experiments,
  };
  if (artifact !== undefined) {
    // The loaded artifact ITSELF, by reference - not a copy of some of its fields. A reader
    // of ctx.artifact.files can see which artifact those files are, and nothing on it was
    // put there by a check: what a review derives goes on ctx.cache, and the shipped answers
    // (the manifest.json record, the Experiment verdict) are asked of the XPI once and
    // shared above. What stops a check reaching the artifact it was NOT routed to is the
    // routing - its declared `input` - so there is nothing here to withhold.
    //
    // Set only when there IS one artifact. The `all` route names its artifacts instead;
    // leaving the field off there means anything written for the one-artifact shape fails
    // on it rather than silently reading whichever side happened to be here.
    ctx.artifact = artifact;
  }
  return ctx;
}

/**
 * The ctx over the BUILT XPI - in both review modes. It serves the `input: xpi` checks: the
 * structure checks (bundled-files, minimize-web-accessible-resources, ...), the manifest.json
 * checks (the shipped manifest.json IS this artifact's), the diff + packaging summaries, and -
 * in an XPI review - the whole review, since it IS siblings.source, the review target. Its
 * data is computed the same way in both modes, so an `input: xpi` check sees the identical
 * artifact whether the run is an XPI review or a source review.
 * @param {import("../addon/load.js").Addon} xpiAddon  The built XPI.
 * @param {import("../review/products.js").ArtifactData} data  Its data getters.
 * @param {ReviewEnv} env  The shared review-level state (see projectCtx).
 * @returns {RunContext}
 */
export function buildXpiCtx(xpiAddon, data, env) {
  return projectCtx(env, { artifact: xpiAddon, data });
}

/**
 * The ctx for the submitted archive, which only a source review has. It is ONE ctx over one
 * artifact: `siblings.sca` routes the build and dependency checks to it, and `siblings.source`
 * points at this same object, because in a source review the archive IS the review target.
 * (In an XPI review that slot points at the XPI instead - `source` names the target, never
 * an artifact, and carries no ctx of its own.)
 *
 * It projects the shipped manifest.json and experiments from `env`, so no artifact's
 * manifest.json is read against another's files and the review-level singletons stay
 * single-instance.
 * @param {import("../addon/load.js").Addon} archive  The submitted archive, carrying its
 *   views (scaViews): `files` is everything but the Experiment implementation.
 * @param {import("../review/products.js").ArtifactData} data  Its data getters.
 * @param {ReviewEnv} env
 * @returns {RunContext}
 */
export function buildScaCtx(archive, data, env) {
  return projectCtx(env, { artifact: archive, data });
}

/**
 * The `input: all` sibling: every artifact this review has, by name, and no `artifact` of
 * its own. Built for BOTH review modes, because the route says "whatever is here", not
 * "two" - so an XPI review has this sibling too, with the archive absent. routeCtx refuses
 * a missing sibling outright (it would abort the review rather than fail one check), so the
 * route always has to answer with a real ctx.
 *
 * `xpi` and `sca` are the per-artifact CTXS, the same objects the other siblings hold. A
 * ctx is what the analyses take and memoize against (getOutboundSinks, buildReachability,
 * nonAuthoredJs), so a check written for one artifact runs over either of these unchanged -
 * see perArtifact in src/checks/each-artifact.js - and nothing is analysed twice. A check
 * that compares the two reads the Addon under each, `ctx.xpi.artifact`.
 *
 * Naming them is the point. This route has no `ctx.artifact`, so a comparison has to say
 * which side every read is about, and there is no slot that would let it avoid saying.
 *
 * The archive is an explicit `null` rather than left off. A ctx is a plain object, so an
 * absent field reads as `undefined` and a check would walk into it; `null` makes "this
 * review has no archive" a value the check can test, the same way `experiments` is a
 * verdict or null. What a check does with one artifact is its own call - the two comparison
 * checks need two and return early without it.
 * @param {ReviewEnv} env
 * @param {{xpi: RunContext, sca?: ?RunContext}} ctxs  The per-artifact siblings.
 * @returns {RunContext}
 */
export function buildAllCtx(env, { xpi, sca = null }) {
  // No artifact, so no data of its own: a check on this route asks ctx.xpi / ctx.sca, and one
  // that reads the data here was written for the one-artifact shape.
  const none = (what) => () =>
    Promise.reject(
      wiringError(
        `${what} was read off the \`input: all\` ctx, which has no artifact - ask ctx.xpi / ctx.sca`
      )
    );
  const ctx = projectCtx(env, {
    data: {
      vendor: none("The vendor reading"),
      bundled: none("The classification"),
      jsSources: none("The parsed sources"),
      apiUsages: none("The API usage"),
      buildReview: none("The build trace"),
    },
  });
  ctx.xpi = xpi;
  ctx.sca = sca;
  return ctx;
}
