// What THIS RUN created on disk for a review, so a run that fails gives it all back.
//
// A run creates a work folder, or names inside one an earlier run left, before it knows
// whether it will do its job. One that fails leaves nothing it created behind: the same
// command can simply run again, and no half-made folder is left for a reviewer to mistake
// for a review. So every such path is claimed here as it is made, and exit handling, which
// every run ends in (src/cli.js exitHandling), keeps it where the run did its job or refused
// an answer, and releases it after a failure, whatever made it fail.
//
// Only what was claimed is ever removed. A folder that was already there is never claimed,
// only the names this run creates inside it, so a --llm-handback that fails leaves the review
// it was handed exactly as it was.
import fs from "node:fs";
import path from "node:path";

/** The paths this run created and has not yet kept. */
const claimed = new Set();

/**
 * Create a folder, and every missing folder above it, as this run's: the outermost one the
 * call created is claimed, so a release removes exactly what was not there before.
 * @param {string} dir  Absolute.
 * @returns {?string}  The outermost folder created, or null where `dir` was already there.
 * @throws {Error}  The folder could not be created.
 */
export function claimFolder(dir) {
  const created = fs.mkdirSync(dir, { recursive: true }) ?? null;
  if (created) {
    claimed.add(created);
  }
  return created;
}

/**
 * Claim names this run will create inside a folder that was already there, with every folder
 * they live in that is not there yet (`.review/`). Each was free when it was claimed, so
 * whatever is at one later is this run's.
 * @param {string[]} paths  Absolute.
 */
export function claimNames(paths) {
  for (const p of paths) {
    claimed.add(p);
    for (
      let dir = path.dirname(p);
      !fs.existsSync(dir);
      dir = path.dirname(dir)
    ) {
      claimed.add(dir);
    }
  }
}

/**
 * What has been claimed so far stays, since the run did its job or refused an answer, and a
 * later run carries it on: none of it is released.
 */
export function keepClaims() {
  claimed.clear();
}

/**
 * Remove everything claimed and not kept. A claimed folder held nothing before this run, so
 * removing all of it removes only what this run wrote.
 */
export function releaseClaims() {
  for (const p of claimed) {
    fs.rmSync(p, { recursive: true, force: true });
  }
  claimed.clear();
}
