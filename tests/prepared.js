// A preparation of a source code review (src/prepare/steps.js) as the tests make one: for
// real, step by step through the linter's own hand-backs, against a fake OSV network - so a
// test that needs a prepared work folder gets the record the linter writes, never one
// written for it. A test that models a forged record edits that real record.
//
// Belongs here: the fake network the lock audit asks, the agent's side of a step (filling the
// review file, writing files), and the run through the steps. Does NOT belong here: what a
// step does (src/prepare/steps.js), or any record written by hand.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { handBack, startPreparation } from "../src/prepare/steps.js";
import { PREPARE_STEP, startRecord } from "../src/prepare/state.js";
import { workPaths } from "../src/util/dest.js";
import { freshWorkFolder } from "./seed-caches.js";

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
 * The network the audit asks, answering OSV from `vulns`: "name@version" -> the advisories
 * that release has. The single-package query answers with them whole; the batch answers with
 * their ids, positionally, and each id is served on its own. Everything else 404s, so a
 * request the audit should not make is not answered. `batch: false` has the batch endpoint
 * answer 404.
 * @param {Record<string, object[]>} [vulns]
 * @param {{batch?: boolean}} [opts]
 */
export function net(vulns = {}, { batch = true } = {}) {
  const byId = new Map(
    Object.values(vulns)
      .flat()
      .map((v) => [v.id, v])
  );
  const key = (q) => `${q.package.name}@${q.version}`;
  const notFound = () => Object.assign(new Error("HTTP 404"), { status: 404 });
  const answer = {
    fetchBytes: async () => {
      throw notFound();
    },
    fetchJson: async (url) => {
      const id = url.slice(url.lastIndexOf("/") + 1);
      if (url.includes("/v1/vulns/") && byId.has(id)) {
        return byId.get(id);
      }
      throw notFound();
    },
  };
  answer.postJson = async (url, body) => {
    if (!url.includes("querybatch")) {
      return { vulns: vulns[key(body)] ?? [] };
    }
    if (!batch) {
      throw notFound();
    }
    return {
      results: body.queries.map((q) => ({
        vulns: (vulns[key(q)] ?? []).map((v) => ({ id: v.id })),
      })),
    };
  };
  return answer;
}

/** A network that fails the test on any request: for a step that must not audit. */
export const noNet = {
  fetchBytes: async () => assert.fail("no request expected"),
  fetchJson: async () => assert.fail("no request expected"),
  postJson: async () => assert.fail("no request expected"),
};

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
 * source extracted into its sca/ and handed back as the root, and every hand-back after it,
 * each answered by the fake OSV network built from `vulns`. A clean source is done at once.
 * A vulnerable one gets its rescued copy, and `rescue` is the agent's work in it: a function
 * of the copy's root, which changes what it must for the copy's audit to come out clean -
 * or null, which changes nothing, so the fix step gives the rescue up and the original is
 * done, unrescued. Each step is asserted to move as the preparation moves it.
 * @param {{source: string, xpi: string, flags?: object, vulns?: Record<string, object[]>,
 *   rescue?: ?(copyRoot: string) => void}} opts
 * @returns {Promise<{next: string, work: string, record: object}>}  The handout of the
 *   last step: the folder whose review starts, and its record.
 */
export async function realPreparation({
  source,
  xpi,
  flags = {},
  vulns = {},
  rescue = null,
}) {
  const work = freshWorkFolder();
  fs.mkdirSync(work);
  startPreparation(
    work,
    startRecord({ submission: { xpi, experiments: false }, flags })
  );
  const sca = workPaths(work).sca;
  fs.cpSync(source, sca, { recursive: true });
  answer(work, { SCA_ROOT: sca });
  const step = (folder) => handBack(folder, { net: net(vulns) });
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
  assert.equal(at.record.unrescued, true);
  assert.ok(!fs.existsSync(copy), "the given-up copy is deleted");
  return at;
}
