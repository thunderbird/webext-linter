// Unit tests for src/util/atomic.js: the atomic write, and the read-only file written through
// it. Windows will not rename over a read-only file (issue #7), which POSIX allows, so the
// tests play that refusal: the rename throws EPERM whenever its target exists without its
// owner's write bit.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  writeFileAtomic,
  writeReadOnlyFileAtomic,
} from "../../src/util/atomic.js";

/** A rename that refuses a read-only target, as Windows' MoveFileEx does. */
function refuseReadOnlyTargets(t) {
  const rename = fs.renameSync;
  t.after(() => mock.restoreAll());
  mock.method(fs, "renameSync", (from, to) => {
    if (fs.existsSync(to) && (fs.statSync(to).mode & 0o200) === 0) {
      throw Object.assign(new Error(`EPERM: operation not permitted, rename`), {
        code: "EPERM",
      });
    }
    return rename(from, to);
  });
}

const fileIn = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), "atomic-")), "state.json");

test("a read-only file is replaced, and left read-only", (t) => {
  refuseReadOnlyTargets(t);
  const file = fileIn();
  writeReadOnlyFileAtomic(file, "first\n");
  assert.equal(fs.statSync(file).mode & 0o777, 0o444);
  writeReadOnlyFileAtomic(file, "second\n");
  assert.equal(fs.readFileSync(file, "utf8"), "second\n");
  assert.equal(fs.statSync(file).mode & 0o777, 0o444);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

// The refusal the wrapper exists for: a plain atomic write over a read-only file fails where
// Windows refuses the rename, and the plain write does not override the mode by itself.
test("a plain atomic write over a read-only file is refused where the rename is", (t) => {
  refuseReadOnlyTargets(t);
  const file = fileIn();
  writeReadOnlyFileAtomic(file, "first\n");
  assert.throws(() => writeFileAtomic(file, "second\n"), { code: "EPERM" });
  assert.equal(fs.readFileSync(file, "utf8"), "first\n");
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)),
    ["state.json"],
    "the temp file is cleaned up"
  );
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
