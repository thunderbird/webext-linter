// Unit tests for the dependency-vulnerability findings (src/lib/vuln-findings.js): the
// update advice names the one release a developer moves to.

import { test } from "node:test";
import assert from "node:assert/strict";

import { vulnFindings } from "../../src/lib/vuln-findings.js";
import { ARTIFACT_SCA } from "../../src/lib/artifacts.js";

/** A context whose artifact holds no files, so each finding anchors at its file. */
const ctx = {
  artifact: {
    files: new Map(),
    at: (file, loc) => ({ file, loc, artifact: ARTIFACT_SCA }),
  },
};

/** The `fixed` slot of the one finding made for a vulnerability fixed in `fixed`. */
const fixedSlot = (fixed) =>
  vulnFindings(ctx, [
    {
      name: "pkg",
      version: "3.1.2",
      ids: ["GHSA-a"],
      severity: "high",
      fixed,
      file: "package-lock.json",
      token: "",
    },
  ])[0].data.fixed;

// OSV lists a fixed release for every range of every advisory, older release lines
// included, so only the most recent of them is advice that fixes them all.
test("the advice names the most recent fixed release", () => {
  assert.equal(
    fixedSlot(["3.4.0", "3.4.16", "2.5.0", "3.1.3", "3.4.9"]),
    "3.4.16"
  );
  assert.equal(fixedSlot(["1.0.0"]), "1.0.0");
});

test("without a fixed release the advice names a patched release", () => {
  assert.equal(fixedSlot([]), "a patched release");
  assert.equal(fixedSlot(["not-a-version"]), "a patched release");
});
