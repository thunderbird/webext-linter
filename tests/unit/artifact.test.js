// Unit tests for the artifact LABEL - how a locus's artifact is shown.
//
// There is no rule here to test any more. WHICH artifact a locus is in is settled by the
// thing that holds the file (src/addon/load.js `kind` and `at`), so this file only covers
// the presentation: a source review tells two artifacts apart, an XPI review has one and
// says nothing.

import { test } from "node:test";
import { REVIEW_MODE } from "../../src/lib/enum.js";
import assert from "node:assert/strict";

import { artifactLabel } from "../../src/report/artifact.js";
import { ARTIFACT_XPI, ARTIFACT_SCA } from "../../src/lib/artifacts.js";

test("the label shows the stamped artifact, and only in a source review", () => {
  assert.equal(
    artifactLabel({ artifact: ARTIFACT_XPI, mode: REVIEW_MODE.SCA }),
    ARTIFACT_XPI
  );
  assert.equal(
    artifactLabel({ artifact: ARTIFACT_SCA, mode: REVIEW_MODE.SCA }),
    ARTIFACT_SCA
  );
  // One artifact: nothing to tell apart, so nothing is said.
  for (const mode of [REVIEW_MODE.XPI, undefined]) {
    assert.equal(artifactLabel({ artifact: ARTIFACT_XPI, mode }), "");
    assert.equal(artifactLabel({ artifact: ARTIFACT_SCA, mode }), "");
  }
});

// Asked to show no artifact, this shows nothing rather than guessing one. A finding cannot
// reach it that way - the constructor refuses a locus without one - so this
// pins the renderer's own floor, which every caller relies on and none should test around.
test("no artifact is labelled with nothing, not with a default", () => {
  assert.equal(artifactLabel({ mode: REVIEW_MODE.SCA }), "");
  assert.equal(artifactLabel({ artifact: null, mode: REVIEW_MODE.SCA }), "");
});

// The two constants are PLAIN STRINGS and must stay so: they ride on every finding into
// the JSON report, the loop state and the file an agent hands back, and an enum member
// here would be a strict Proxy that throws on JSON.stringify.
test("the artifact names survive JSON", () => {
  for (const a of [ARTIFACT_XPI, ARTIFACT_SCA]) {
    assert.equal(typeof a, "string");
    assert.equal(JSON.parse(JSON.stringify({ a })).a, a);
  }
});
