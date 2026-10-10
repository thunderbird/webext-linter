// The review's DATA, computed when a check first asks for it. Every piece a check reads
// beyond the artifact's own files - its vendor reading and audits, the classification of its
// bundled code, its parsed sources and their API usage, the build trace - sits behind an
// async getter on the check's context (ctx.vendor(), ctx.bundled(), ctx.jsSources(),
// ctx.apiUsages(), ctx.buildReview()). A getter answers from what was already computed, or
// computes it first, once per artifact. So a review computes what its checks read and
// nothing else: a check that never runs - one after an abort, one left out by
// --checks-only - costs nothing.
//
// Each getter answers only FINAL data. The stages behind it run in the order they always
// have, and some revise what an earlier stage wrote: the CDN identification rewrites the
// vendor results and the non-authored set, and the audits append to the vulnerability lists.
// A getter resolves every stage that writes its answer before it hands it over, so no check
// ever reads a value a later stage would still change.
//
// The stages are the pipeline's own functions, called as they were before. They keep their
// working state on the artifact (addon.vendor, addon.bundled), where the functions they call
// look for it; a check never reads it there, only through the getters (a test holds the
// checks and their accessors to that).
//
// Belongs here: the stages, their order and dependencies, memoizing them, and narrating each
// as it runs. Does NOT belong here: what a stage computes (src/vendor/*, src/lib/bundled.js,
// src/lib/cdn-lookup.js, src/checks/extract.js, src/build/analyze.js), which data stays
// eager (src/pipeline.js: the schema, the Experiment verdict, loading the archive), or how a
// check reads it (src/checks/context.js).

import { resolveVendor } from "../vendor/resolve.js";
import {
  verifyVendor,
  verifyVendorDeclarations,
  verifyScaDependencies,
  auditIdentifiedLibraries,
} from "../vendor/verify.js";
import { classifyBundled, applyUnverifiedVendor } from "../lib/bundled.js";
import { resolveCdnLibraries } from "../lib/cdn-lookup.js";
import {
  resolveLibraryHashes,
  parseLibraryHashes,
} from "../lib/library-hashes.js";
import {
  resolveLibraryBlocks,
  parseLibraryBlocks,
} from "../lib/library-blocks.js";
import { collectJsSources } from "../addon/sources.js";
import { runExtractionPass, apiUsageOf } from "../checks/extract.js";
import { analyzeBuild } from "../build/analyze.js";
import { withExperiment } from "../addon/store.js";
import { isExperiment } from "../lib/util.js";
import { experimentApiNamespaces } from "../lib/experiments.js";
import { ERROR_CLASS } from "../lib/enum.js";
import { LinterError, wiringError } from "../lib/errors.js";
import { progress, FEED } from "../util/log.js";

/**
 * A stage that runs once, on first call, and answers every later call from the same
 * promise. The stages it depends on are resolved first, one after another, in the order
 * given - the order the review has always computed them in. Then a labelled stage says what
 * it is doing - the feed line a reviewer sees while it runs - and does it, so the feed
 * narrates what a review actually computed, in the order it computed it.
 *
 * A stage that fails ends the review. It is reached from inside a check, whose own failures
 * are caught and reported as that check's (src/checks/registry.js runOneCheck), so a plain
 * error is carried out as a LinterError, which that catch re-throws. The message is the
 * original one: it is what the exit prints.
 * @template T
 * @param {?string} label  The feed line, or null for a silent stage.
 * @param {(() => Promise<unknown>)[]} after  The stages this one depends on.
 * @param {() => T | Promise<T>} fn  Its own work.
 * @returns {() => Promise<T>}
 */
function stage(label, after, fn) {
  let started = null;
  return () => {
    if (!started) {
      started = (async () => {
        for (const dependency of after) {
          await dependency();
        }
        if (label) {
          progress(label, FEED.STEP);
        }
        return fn();
      })().catch((err) => {
        if (err instanceof LinterError) {
          throw err;
        }
        const fatal = new LinterError(ERROR_CLASS.WIRING, err.message);
        fatal.cause = err;
        throw fatal;
      });
    }
    return started;
  };
}

/**
 * The single extraction pass over one artifact: parse each source ONCE, extract every
 * per-file result the checks read, drop the AST.
 *
 * It runs AFTER the CDN identification, and that ORDER IS THE POINT: that stage FINALIZES
 * addon.bundled.nonAuthored - the skip set this pass gates content extraction on - and it
 * moves the line in BOTH directions. The CDN lookup ADDS a file (a library the Mozilla hash
 * DB missed), and applyUnverifiedVendor REMOVES one: a READABLE vendored library whose package
 * turns out not to be popular is reviewed as the developer's OWN code. A file dropped from the
 * skip set after the pass would be authored but never content-scanned, and a check, being a
 * pure reader, would find nothing there.
 * @param {import("../addon/load.js").Addon} addon  Already classified and identified.
 * @param {{schema: object,
 *   manifest: ?import("../addon/load.js").WebExtManifestRecord}} deps  What the SHIPPED
 *   add-on declares: whether this is an Experiment, and which namespaces its APIs own, are
 *   its answers even when the artifact being extracted is the source.
 * @returns {import("../addon/sources.js").JsSource[]}
 */
function extractReview(addon, { schema, manifest }) {
  const jsSources = collectJsSources(addon);
  const experimentNamespaces = isExperiment(manifest?.json)
    ? experimentApiNamespaces(manifest?.json, addon.files)
    : null;
  runExtractionPass(jsSources, {
    schema,
    nonAuthored: addon.bundled.nonAuthored,
    experimentNamespaces,
  });
  return jsSources;
}

/**
 * Per-source api-usage in the ctx.apiUsages shape (file + inline + the extracted usage),
 * derived from sources already through the extraction pass.
 * @param {import("../addon/sources.js").JsSource[]} jsSources
 * @returns {object[]}
 */
export function deriveApiUsages(jsSources) {
  return jsSources.map((src) => ({
    file: src.file,
    inline: src.inline,
    ...apiUsageOf(src),
  }));
}

/**
 * The getters one artifact's checks read its data through.
 * @typedef {object} ArtifactData
 * @property {() => Promise<object>} vendor  The vendor reading and every audit of it.
 * @property {() => Promise<object>} bundled  The classification, after the CDN
 *   identification.
 * @property {() => Promise<import("../addon/sources.js").JsSource[]>} jsSources
 * @property {() => Promise<object[]>} apiUsages
 * @property {() => Promise<object>} buildReview
 */

/**
 * Build the review's data getters, one set per artifact.
 *
 * Which artifact has which data is the review's, and is said here once:
 * - the vendor reading exists on the REVIEW TARGET only (the XPI in an XPI review, the
 *   archive in a source review): a VENDOR file or package.json is read from the artifact
 *   the review is of, and a copy shipped inside the XPI of a source review is a second,
 *   unverified answer nothing reads;
 * - the classification and the parse exist on every artifact: what an artifact's bytes ARE
 *   is a fact about it, and the input:xpi checks read the shipped XPI in both modes;
 * - the build trace exists on the archive only.
 * A getter for data an artifact never has throws: a check that reads it was routed wrong,
 * and a silent empty answer would read as a clean submission.
 *
 * An UNRESCUED source review's vendor reading is the lock audit its preparation recorded
 * (src/prepare/steps.js): the archive's dependency record, with the four lists taken from
 * the record instead of asked of the network again.
 * @param {object} deps
 * @param {object} deps.opts  The pipeline opts: the network, the caches, the CDN switch.
 * @param {object} deps.schema  The review schema, Experiment APIs already registered.
 * @param {?object} deps.manifest  The shipped manifest.json record.
 * @param {import("../addon/load.js").Addon} deps.xpi  The built XPI.
 * @param {?import("../addon/load.js").Addon} deps.archive  The source archive, or null.
 * @param {import("../addon/load.js").Addon} deps.target  The review target.
 * @param {?object} deps.lockAudit  An unrescued review's recorded lock audit, or null.
 * @returns {(artifact: import("../addon/load.js").Addon) => ArtifactData}
 */
export function reviewData({
  opts,
  schema,
  manifest,
  xpi,
  archive,
  target,
  lockAudit,
}) {
  const sca = Boolean(archive);
  const net = opts.vendorNet;
  const cdn = {
    net,
    cacheDir: opts.cdnLookupCache,
    enabled: opts.cdnLookup !== false,
  };

  // The known-library hash DB the classifier matches bytes against, and the Mozilla policy
  // blocklist the audits consult before each OSV query. Shared by every artifact.
  const libraries = stage("Fetching library hashes", [], async () => {
    const { text: hashesText } = await resolveLibraryHashes({
      cacheDir: opts.libraryHashesCache,
    });
    const { text: blocksText } = await resolveLibraryBlocks();
    return {
      libraryHashes: parseLibraryHashes(hashesText),
      libraryBlocks: parseLibraryBlocks(blocksText),
    };
  });

  // THE SHIPPED XPI: in an XPI review its vendor reading first, which DISCOVERS the vendored
  // files the classification then marks non-authored; in a source review the classification
  // alone.
  const xpiClassified = stage(
    "Verifying vendored libraries",
    [libraries],
    async () => {
      const { libraryHashes, libraryBlocks } = await libraries();
      if (!sca) {
        xpi.vendor = resolveVendor({ addon: xpi });
        await verifyVendor(xpi, net, libraryBlocks);
      }
      xpi.bundled = classifyBundled(xpi, { libraryHashes });
    }
  );
  const xpiIdentified = stage(
    "Identifying bundled libraries on a CDN",
    [xpiClassified],
    async () => {
      applyUnverifiedVendor(xpi);
      await resolveCdnLibraries(xpi, cdn);
    }
  );
  const xpiParsed = stage("Parsing add-on sources", [xpiIdentified], () =>
    extractReview(xpi, { schema, manifest })
  );

  // THE SOURCE ARCHIVE: its lock and VENDOR declarations, the dependency audit, the
  // classification, the CDN identification, the parse.
  const scaVendored = stage(
    "Verifying vendored source libraries",
    [libraries],
    async () => {
      const { libraryBlocks } = await libraries();
      // The archive's lock IS what the reviewer installs from, so it alone says which
      // packages, at which versions, are audited - package.json is not read for them.
      archive.vendor = resolveVendor({
        addon: archive,
        reviewerInstalls: true,
      });
      await verifyVendorDeclarations(archive, net, libraryBlocks);
    }
  );
  const scaClassified = stage(
    "Auditing source dependencies",
    [scaVendored],
    async () => {
      const { libraryHashes, libraryBlocks } = await libraries();
      await verifyScaDependencies(archive, net, libraryBlocks);
      archive.bundled = classifyBundled(archive, { libraryHashes });
    }
  );
  const scaIdentified = stage(
    "Identifying source libraries on a CDN",
    [scaClassified],
    async () => {
      applyUnverifiedVendor(archive);
      await resolveCdnLibraries(archive, cdn);
    }
  );
  const scaParsed = stage("Parsing add-on sources", [scaIdentified], () =>
    extractReview(archive, { schema, manifest })
  );
  const scaBuild = stage("Analyzing the build", [], () =>
    analyzeBuild({ build: { files: withExperiment(archive) } })
  );
  const scaRecorded = stage(null, [], () => {
    archive.vendor = resolveVendor({ addon: archive, reviewerInstalls: true });
    Object.assign(archive.vendor, lockAudit);
  });

  const identified = (artifact) =>
    artifact === xpi ? xpiIdentified() : scaIdentified();
  const parsed = (artifact) => (artifact === xpi ? xpiParsed() : scaParsed());

  // ONE audit of the identified libraries, over the REVIEW TARGET, after its libraries are
  // identified: the checks that read it are routed to the target too.
  const audited = stage(
    "Auditing libraries",
    [() => identified(target)],
    async () => {
      const { libraryBlocks } = await libraries();
      await auditIdentifiedLibraries(target, net, libraryBlocks);
    }
  );

  const absent = (what, artifact) =>
    wiringError(
      `${what} is never computed for the ${artifact === xpi ? "built XPI" : "source archive"} in this review - the check reading it was routed to the wrong artifact`
    );

  const sets = new Map();
  return (artifact) => {
    if (!sets.has(artifact)) {
      const usages = stage(null, [], async () =>
        deriveApiUsages(await parsed(artifact))
      );
      sets.set(artifact, {
        vendor: async () => {
          if (artifact !== target) {
            throw absent("A vendor reading", artifact);
          }
          if (lockAudit) {
            await scaRecorded();
          } else {
            await audited();
          }
          return artifact.vendor;
        },
        bundled: async () => {
          await identified(artifact);
          return artifact.bundled;
        },
        jsSources: () => parsed(artifact),
        apiUsages: () => usages(),
        buildReview: async () => {
          if (artifact === xpi) {
            throw absent("A build trace", artifact);
          }
          return scaBuild();
        },
      });
    }
    return sets.get(artifact);
  };
}
