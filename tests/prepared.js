// A preparation of a source code review (src/prepare/steps.js) as the tests make one: for
// real, step by step through the linter's own hand-backs, its audit answered from a run cache
// folder the test seeded outside the work folder and named as its --cache-work-dir - so a
// test that needs a prepared work folder gets the record the linter writes, never one
// written for it. A test that models a forged record edits that real record.
//
// Belongs here: the OSV answers the lock audit reads, the agent's side of a step (filling the
// review file, writing files), and the run through the steps. Does NOT belong here: what a
// step does (src/prepare/steps.js), or any record written by hand.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { handBack, startPreparation } from "../src/prepare/steps.js";
import { PREPARE_STEP, startRecord } from "../src/prepare/state.js";
import { workPaths } from "../src/util/dest.js";
import { freshWorkFolder, osvEntries, seedWorkCache } from "./seed-caches.js";

/** An OSV advisory as the API serves it. */
export const advisory = (id, severity, name, fixed) => ({
  id,
  database_specific: { severity },
  affected: [
    {
      package: { ecosystem: "npm", name },
      ranges: [{ events: [{ fixed }] }],
    },
  ],
});

/**
 * OSV's answers to the audit, as run cache entries (osvEntries). `vulns` maps each
 * "name@version" the audit asks about to the advisories that release has, an empty list for
 * one OSV has no record of. A release not in it is not answered, so a step asks the network
 * for it, which a test refuses.
 * @param {Record<string, object[]>} vulns
 * @returns {Record<string, object>}
 */
export function auditEntries(vulns) {
  const batch = {};
  const advisories = {};
  for (const [release, list] of Object.entries(vulns)) {
    batch[release] = list.length
      ? { vulns: list.map((v) => ({ id: v.id })) }
      : {};
    for (const v of list) {
      advisories[v.id] = v;
    }
  }
  return osvEntries({ batch, advisories });
}

/**
 * A run cache folder outside any work folder, holding OSV's answers to the audit (`vulns`,
 * as auditEntries takes them), for a preparation to name as its --cache-work-dir.
 * @param {Record<string, object[]>} [vulns]
 * @returns {string}
 */
export const auditCache = (vulns = {}) =>
  seedWorkCache({ osv: auditEntries(vulns) });

/** Write files under a folder, creating what is missing. */
export function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
}

/** Fill in the review file the way the agent does: each entry's answer by its index. */
export function answer(work, answers) {
  const file = workPaths(work).review;
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  doc.entries = doc.entries.map((e) => ({ ...e, answer: answers[e.index] }));
  fs.writeFileSync(file, JSON.stringify(doc));
}

/**
 * Prepare a source code review for real: the work folder a --llm-sca-review run creates, the
 * source extracted into its sca/ and handed back as the root, and every hand-back after it.
 * Its run cache is `cache`, a seeded folder named as --cache-work-dir in its record, so every
 * step and its review read it: each audit is answered from it, a rescued copy's included.
 * A clean source is done at once.
 * A vulnerable one gets its rescued copy, and `rescue` is the agent's work in it: a function
 * of the copy's root, which changes what it must for the copy's audit to come out clean -
 * or null, which changes nothing, so the fix step gives the rescue up and the original is
 * done, its roots back in sca/. Each step is asserted to move as the preparation moves it.
 * @param {{source: string, xpi: string, flags?: object, cache?: string,
 *   rescue?: ?(copyRoot: string) => void}} opts
 * @returns {Promise<{next: string, work: string, record: object}>}  The handout of the
 *   last step: the folder whose review starts, and its record.
 */
export async function realPreparation({
  source,
  xpi,
  flags = {},
  cache = auditCache(),
  rescue = null,
}) {
  const work = freshWorkFolder();
  fs.mkdirSync(work);
  startPreparation(
    work,
    startRecord({
      submission: { xpi, experiments: false },
      flags: { ...flags, "cache-work-dir": cache },
    })
  );
  const sca = workPaths(work).sca;
  fs.cpSync(source, sca, { recursive: true });
  answer(work, { SCA_ROOT: sca });
  const step = (folder) => handBack(folder);
  let at = await step(work);
  if (at.next === "review") {
    assert.equal(at.work, work, "a clean source is reviewed where it is");
    return at;
  }
  assert.equal(
    at.record.step,
    PREPARE_STEP.reduce,
    "a vulnerable source is rescued"
  );
  assert.equal(at.work, work, "the copy is made in the same work folder");
  const copy = workPaths(work).rescued;
  if (rescue) {
    rescue(at.record.roots.scaRoot);
    at = await step(work);
    assert.equal(at.next, "review", "the rescued copy came out clean");
    assert.equal(at.work, work);
    return at;
  }
  at = await step(work);
  assert.equal(
    at.record.step,
    PREPARE_STEP.fix,
    "a reduce that changed nothing"
  );
  at = await step(work);
  assert.equal(
    at.next,
    "review",
    "a fix that changed nothing gives the rescue up"
  );
  assert.equal(at.work, work);
  assert.equal(
    at.record.roots.scaRoot,
    sca,
    "the source as submitted is reviewed"
  );
  assert.ok(!fs.existsSync(copy), "the given-up copy is deleted");
  return at;
}
