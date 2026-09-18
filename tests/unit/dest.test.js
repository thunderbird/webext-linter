// extractionDestination: one check, no retry loop - see src/util/dest.js for why.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractionDestination } from "../../src/util/dest.js";

test("nothing at the base: returned unchanged", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webext-linter-dest-"));
  const base = path.join(dir, "a.xpi.extracted");
  assert.equal(extractionDestination(base), base);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("something already at the base: a timestamp-suffixed sibling", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webext-linter-dest-"));
  const base = path.join(dir, "a.xpi.extracted");
  fs.mkdirSync(base);
  const dest = extractionDestination(base);
  assert.notEqual(dest, base);
  assert.ok(dest.startsWith(`${base}-`));
  // Iso-ish, minute resolution at least - not just any suffix.
  assert.match(dest, /-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a plain file at the base collides too, not only a directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webext-linter-dest-"));
  const base = path.join(dir, "a.xpi.extracted");
  fs.writeFileSync(base, "");
  assert.notEqual(extractionDestination(base), base);
  fs.rmSync(dir, { recursive: true, force: true });
});
