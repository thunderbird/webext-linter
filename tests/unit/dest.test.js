// The work folder's naming convention (src/util/dest.js): the default folder a review gets,
// read off the path it was given, and the bare names inside every work folder.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  defaultWorkFolder,
  misplacedFolders,
  misplacedFoldersError,
  submissionLeaf,
  workPaths,
} from "../../src/util/dest.js";

// The default folder is named after the kind of review and the submission, read off the
// PATH the run was given - never off the manifest.json, whose name is submission data of
// any shape. It sits beside the add-on argument, for a packed and an unpacked one alike.
test("the default work folder is named after the submission, beside it", () => {
  for (const kind of ["xpi", "sca"]) {
    for (const p of ["/dl/foo.xpi", "/dl/foo"]) {
      const work = defaultWorkFolder(p, kind);
      assert.equal(path.dirname(work), "/dl", p);
      assert.match(
        path.basename(work),
        new RegExp(`^${kind}-review-foo-\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z$`),
        p
      );
    }
  }
  // Escaped, not because a leaf could escape a directory - it cannot - but because an
  // ordinary name like this one would otherwise upset a shell.
  assert.match(
    path.basename(defaultWorkFolder("/dl/My Add-on 1.0.xpi", "xpi")),
    /^xpi-review-My_Add-on_1\.0-/
  );
});

// Only the .xpi it was packed as comes off: anything else is part of the name somebody
// gave it.
test("submissionLeaf takes off .xpi and nothing else", () => {
  assert.equal(submissionLeaf("/dl/foo.xpi"), "foo");
  assert.equal(submissionLeaf("/dl/foo"), "foo");
  assert.equal(submissionLeaf("/dl/foo.xpi.extracted"), "foo.xpi.extracted");
  assert.equal(submissionLeaf("/dl/foo.zip"), "foo.zip");
});

// Every review names the same files the same way, so a prompt, a test and a person all find
// a file where the last review had it.
test("the work folder's names are bare and fixed", () => {
  const work = workPaths("/w");
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(work).filter(([, v]) => typeof v === "string")
    ),
    {
      xpi: "/w/xpi",
      sca: "/w/sca",
      rescued: "/w/rescued",
      prepare: "/w/.review/prepare.json",
      state: "/w/.review/state.json",
      review: "/w/.review/review.json",
      report: "/w/report.md",
      summary: "/w/summary.md",
      build: "/w/build.md",
      buildIssues: "/w/build-issues.md",
      buildCopy: "/w/build",
    }
  );
  assert.equal(work.sweep("XPI"), "/w/.review/sweep-xpi.answers.json");
  assert.equal(work.sweep("SCA"), "/w/.review/sweep-sca.answers.json");
});

// A folder the linter made is that folder or it is not, and the three ways it is not are one
// check, named in one message: gone, a link, or not a folder. A link to a real folder is a
// link all the same.
test("a folder the linter made is gone, a link, or not a folder, in one check", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "wl-dest-"));
  const { xpi, sca, rescued, buildCopy } = workPaths(work);
  fs.mkdirSync(xpi);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "wl-dest-"));
  fs.symlinkSync(elsewhere, sca);
  fs.writeFileSync(buildCopy, "");
  const misplaced = misplacedFolders([xpi, sca, rescued, buildCopy]);
  assert.deepEqual(misplaced, [
    { folder: sca, problem: "is a link" },
    { folder: rescued, problem: "is gone" },
    { folder: buildCopy, problem: "is not a folder" },
  ]);
  assert.equal(
    misplacedFoldersError(work, misplaced).message,
    `The work folder "${work}" no longer holds the folders the linter put there for this ` +
      "review: sca/ is a link, rescued/ is gone, build/ is not a folder. It cannot be carried " +
      "on. Start the review again from the submission."
  );
  assert.deepEqual(misplacedFolders([xpi]), []);
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(elsewhere, { recursive: true, force: true });
});
