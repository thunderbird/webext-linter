// Unit tests for the per-finding artifact label rule ([XPI]/[SCA]).

import { test } from "node:test";
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
    artifactLabel({ file: "manifest.json", input: "xpi", mode: "xpi" }),
    ""
  );
  assert.equal(
    artifactLabel({ file: "app.js", input: "auto", mode: "xpi" }),
    ""
  );
  assert.equal(
    artifactLabel({ file: "app.js", input: "auto", mode: undefined }),
    ""
  );
});

// In an SCA review the routed input decides the artifact: xpi-input checks report
// against the built XPI, auto/build against the readable source archive.
test("artifactLabel keys off the check input in SCA mode", () => {
  assert.equal(
    artifactLabel({ file: "app.js", input: "xpi", mode: "sca" }),
    ARTIFACT_XPI
  );
  assert.equal(
    artifactLabel({ file: "app.js", input: "auto", mode: "sca" }),
    ARTIFACT_SCA
  );
  assert.equal(
    artifactLabel({ file: "scripts/build.sh", input: "build", mode: "sca" }),
    ARTIFACT_SCA
  );
  // An unknown/undefined input falls to the source archive (the review target).
  assert.equal(
    artifactLabel({ file: "app.js", input: undefined, mode: "sca" }),
    ARTIFACT_SCA
  );
});

// The one cross-over: the shipped manifest is authoritative for EVERY check, so a
// manifest.json finding is [XPI] even from an input:auto check.
test("artifactLabel labels manifest.json as XPI regardless of input", () => {
  assert.equal(
    artifactLabel({ file: "manifest.json", input: "auto", mode: "sca" }),
    ARTIFACT_XPI
  );
  assert.equal(
    artifactLabel({ file: "manifest.json", input: "xpi", mode: "sca" }),
    ARTIFACT_XPI
  );
});
