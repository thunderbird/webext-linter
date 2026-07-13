// Unit tests for collapseUnused: folding fully-unused folders to their top-most
// folder (the unused-files report condensation). Pure path math, no I/O.

import { test } from "node:test";
import assert from "node:assert/strict";

import { collapseUnused } from "../../src/lib/unused-folders.js";

test("a fully-unused nested tree collapses to its top-most folder", () => {
  const all = [
    "dead/a.js",
    "dead/sub/b.js",
    "dead/sub/deep/c.js",
    "background.js", // used, outside the tree
  ];
  const unused = ["dead/a.js", "dead/sub/b.js", "dead/sub/deep/c.js"];
  assert.deepEqual(collapseUnused(unused, all), ["dead/"]);
});

test("one kept (non-unused) file under a folder blocks its collapse; sub-folders still fold", () => {
  const all = [
    "dead/keep.js", // NOT unused
    "dead/sub/b.js",
    "dead/sub/c.js",
  ];
  const unused = ["dead/sub/b.js", "dead/sub/c.js"];
  // "dead" is not fully unused (keep.js remains), but "dead/sub" is.
  assert.deepEqual(collapseUnused(unused, all), ["dead/sub/"]);
});

test("a root-level unused file (no folder) is reported as-is", () => {
  const all = ["orphan.js", "background.js"];
  assert.deepEqual(collapseUnused(["orphan.js"], all), ["orphan.js"]);
});

test("a single-file folder that is fully unused collapses to the folder", () => {
  const all = ["logs/debug.js", "background.js"];
  assert.deepEqual(collapseUnused(["logs/debug.js"], all), ["logs/"]);
});

test("only the top-most fully-unused folder is reported, not nested ones", () => {
  const all = ["x/a.js", "x/y/b.js", "x/y/z/c.js"];
  const unused = ["x/a.js", "x/y/b.js", "x/y/z/c.js"];
  // x, x/y and x/y/z are all fully unused -> only "x/" is reported.
  assert.deepEqual(collapseUnused(unused, all), ["x/"]);
});

test("siblings: a fully-unused folder folds while a partial sibling lists its files", () => {
  const all = [
    "a/1.js",
    "a/2.js", // a/ fully unused
    "b/3.js",
    "b/4.js", // b/ has a kept file
    "b/kept.js",
  ];
  const unused = ["a/1.js", "a/2.js", "b/3.js", "b/4.js"];
  assert.deepEqual(collapseUnused(unused, all), ["a/", "b/3.js", "b/4.js"]);
});

test("buckets are independent: a folder split between callers folds in neither", () => {
  // Mirrors how the pipeline calls collapseUnused once for findings and once for
  // manual refs with the SAME `allFiles`: a folder whose files are split across
  // the two buckets is not fully unused for either bucket alone.
  const all = ["m/finding.js", "m/manual.js"];
  assert.deepEqual(collapseUnused(["m/finding.js"], all), ["m/finding.js"]);
  assert.deepEqual(collapseUnused(["m/manual.js"], all), ["m/manual.js"]);
});

test("empty unused set yields nothing", () => {
  assert.deepEqual(collapseUnused([], ["a/b.js"]), []);
});
