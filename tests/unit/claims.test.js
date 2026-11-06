// What a run created for a review it never got to: claimed as it is made, kept once the
// review exists, and the rest given back as the run fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claimFolder,
  claimNames,
  keepClaims,
  releaseClaims,
} from "../../src/util/claims.js";

const tmp = () =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wl-claims-")));

test("a released claim removes the folder it created, and the folders above it it made", () => {
  const dir = tmp();
  const work = path.join(dir, "addon", "xpi-review-addon-1");
  assert.equal(claimFolder(work), path.join(dir, "addon"));
  fs.writeFileSync(path.join(work, "file"), "x");
  releaseClaims();
  assert.deepEqual(fs.readdirSync(dir), [], "addon/ was this run's");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a kept claim stays, and only what was claimed after it is released", () => {
  const dir = tmp();
  const kept = path.join(dir, "kept");
  claimFolder(kept);
  keepClaims();
  const later = path.join(dir, "later");
  claimFolder(later);
  releaseClaims();
  assert.deepEqual(fs.readdirSync(dir), ["kept"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("in a folder that was there, only the names claimed in it are released", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, ".review"));
  fs.writeFileSync(path.join(dir, ".review", "prepare.json"), "{}");
  fs.writeFileSync(path.join(dir, "mine"), "kept: not claimed");
  // The folder was there, so claiming it again claims nothing.
  assert.equal(claimFolder(dir), null);
  const state = path.join(dir, ".review", "state.json");
  const xpi = path.join(dir, "xpi", "manifest.json");
  claimNames([state, path.join(dir, "xpi")]);
  fs.writeFileSync(state, "{}");
  fs.mkdirSync(path.dirname(xpi));
  fs.writeFileSync(xpi, "{}");
  releaseClaims();
  assert.deepEqual(fs.readdirSync(dir).sort(), [".review", "mine"]);
  assert.deepEqual(fs.readdirSync(path.join(dir, ".review")), ["prepare.json"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a name's missing folders are claimed with it", () => {
  const dir = tmp();
  claimNames([path.join(dir, ".review", "answers.json")]);
  fs.mkdirSync(path.join(dir, ".review"));
  fs.writeFileSync(path.join(dir, ".review", "answers.json"), "{}");
  releaseClaims();
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
