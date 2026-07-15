// Unit tests for the per-finding artifact label rule ([XPI]/[SCA]).

import { test } from "node:test";
import { REVIEW_MODE } from "../../src/lib/enum.js";
import assert from "node:assert/strict";

import {
  artifactLabel,
  ARTIFACT_XPI,
  ARTIFACT_SCA,
} from "../../src/report/artifact.js";

// In an XPI review there is one artifact, so nothing is labelled - regardless of
// the check's input or the file.
test("artifactLabel returns '' in XPI mode", () => {
  assert.equal(
    artifactLabel({
      file: "manifest.json",
      input: "xpi",
      mode: REVIEW_MODE.XPI,
    }),
    ""
  );
  assert.equal(
    artifactLabel({ file: "app.js", input: "source", mode: REVIEW_MODE.XPI }),
    ""
  );
  assert.equal(
    artifactLabel({ file: "app.js", input: "source", mode: undefined }),
    ""
  );
});

// In an SCA review the routed input decides the artifact: xpi-input checks report
// against the built XPI, source/build against the readable source archive.
test("artifactLabel keys off the check input in SCA mode", () => {
  assert.equal(
    artifactLabel({ file: "app.js", input: "xpi", mode: REVIEW_MODE.SCA }),
    ARTIFACT_XPI
  );
  assert.equal(
    artifactLabel({ file: "app.js", input: "source", mode: REVIEW_MODE.SCA }),
    ARTIFACT_SCA
  );
  assert.equal(
    artifactLabel({
      file: "scripts/build.sh",
      input: "build",
      mode: REVIEW_MODE.SCA,
    }),
    ARTIFACT_SCA
  );
  // An unknown/undefined input falls to the source archive (the review target).
  assert.equal(
    artifactLabel({ file: "app.js", input: undefined, mode: REVIEW_MODE.SCA }),
    ARTIFACT_SCA
  );
});

// The one cross-over: the shipped manifest is authoritative for EVERY check, so a
// manifest.json finding is [XPI] even from an input:source check.
test("artifactLabel labels manifest.json as XPI regardless of input", () => {
  assert.equal(
    artifactLabel({
      file: "manifest.json",
      input: "source",
      mode: REVIEW_MODE.SCA,
    }),
    ARTIFACT_XPI
  );
  assert.equal(
    artifactLabel({
      file: "manifest.json",
      input: "xpi",
      mode: REVIEW_MODE.SCA,
    }),
    ARTIFACT_XPI
  );
});

// input: manifest checks read the shipped manifest, so their output is [XPI] - both
// the manifest.json findings (via the cross-over above) and the FILELESS ones
// (manifest-missing / manifest-missing-key), which don't hit the manifest.json branch.
test("artifactLabel labels input:manifest as XPI (incl. fileless findings)", () => {
  assert.equal(
    artifactLabel({
      file: "manifest.json",
      input: "manifest",
      mode: REVIEW_MODE.SCA,
    }),
    ARTIFACT_XPI
  );
  assert.equal(
    artifactLabel({ file: null, input: "manifest", mode: REVIEW_MODE.SCA }),
    ARTIFACT_XPI
  );
});
