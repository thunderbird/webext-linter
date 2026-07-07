// analyzeBuild runs the SCA build review's ONE classification in the setup phase (the vendor
// pattern): it selects the build corpus, asks the model to classify the build, and returns the
// verdict stored on addon.buildFiles.buildReview. LLM-optional and offline-safe. callText is
// injected here so no network/model is touched.

import { test } from "node:test";
import assert from "node:assert/strict";

import { analyzeBuild } from "../../src/build/analyze.js";

const build = (obj) => ({
  files: new Map(Object.entries(obj).map(([k, v]) => [k, Buffer.from(v)])),
});
const pkg = (scripts) => JSON.stringify({ scripts });

test("analyzeBuild stores the model classification", async () => {
  const r = await analyzeBuild({
    build: build({
      "package.json": pkg({ build: "webpack" }),
      "webpack.config.js": "x",
    }),
    analysisPrompt: "classify",
    enabled: true,
    callText: async () =>
      '{"classification":"remote-fetch","reason":"curls x","buildInstructions":"npm run build"}',
  });
  assert.equal(r.classification, "remote-fetch");
  assert.equal(r.reason, "curls x");
  assert.equal(r.buildInstructions, "npm run build");
  assert.equal(r.analyzed, true);
  assert.equal(r.anchor, "package.json");
});

test("analyzeBuild offline (llm disabled) -> analyzed:false, classification:null", async () => {
  const r = await analyzeBuild({
    build: build({ "package.json": pkg({ build: "webpack" }) }),
    analysisPrompt: "classify",
    enabled: false,
    callText: async () => {
      throw new Error("must not call the model when disabled");
    },
  });
  assert.equal(r.analyzed, false);
  assert.equal(r.classification, null);
});

test("analyzeBuild with no package.json -> 'none', no model call", async () => {
  let called = false;
  const r = await analyzeBuild({
    build: build({ Makefile: "all:\n\tgcc" }),
    analysisPrompt: "classify",
    enabled: true,
    callText: async () => {
      called = true;
      return "{}";
    },
  });
  assert.equal(r.classification, "none");
  assert.equal(r.analyzed, false);
  assert.equal(called, false);
});

test("analyzeBuild: an unparseable / unknown classification -> analyzed:false", async () => {
  const bad = await analyzeBuild({
    build: build({ "package.json": pkg({ build: "webpack" }) }),
    analysisPrompt: "classify",
    enabled: true,
    callText: async () => "not json at all",
  });
  assert.equal(bad.analyzed, false);
  assert.equal(bad.classification, null);

  const unknown = await analyzeBuild({
    build: build({ "package.json": pkg({ build: "webpack" }) }),
    analysisPrompt: "classify",
    enabled: true,
    callText: async () => '{"classification":"bananas"}',
  });
  assert.equal(unknown.analyzed, false);
  assert.equal(unknown.classification, null);
});

test("analyzeBuild feeds the corpus + deterministic linter signals to the model", async () => {
  let seen;
  await analyzeBuild({
    build: build({
      "package.json": pkg({ build: "make dist" }),
      Makefile: "all:",
    }),
    analysisPrompt: "classify",
    enabled: true,
    callText: async (req) => {
      seen = req;
      return '{"classification":"ok","reason":"","buildInstructions":""}';
    },
  });
  assert.match(seen.prompt, /LINTER SIGNALS/);
  assert.match(seen.prompt, /make/); // the unresolved:tool signal
  assert.match(seen.prompt, /package\.json/); // the corpus file, wrapped as untrusted data
});
