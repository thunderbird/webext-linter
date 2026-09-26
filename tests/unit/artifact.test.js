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
      input: "sca",
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

// The one cross-over: the shipped manifest.json is authoritative for EVERY check, so a
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

// A FILELESS finding from an input:xpi check is [XPI] too - it never reaches the
// manifest.json branch above, so the input alone has to answer. The manifest.json checks
// (manifest-missing / manifest-missing-key) are the ones that report without a file.
test("artifactLabel labels a fileless input:xpi finding as XPI", () => {
  assert.equal(
    artifactLabel({ file: null, input: "xpi", mode: REVIEW_MODE.SCA }),
    ARTIFACT_XPI
  );
});
