// A build check of a source code review (src/build-check/steps.js) as the tests make one: for
// real, step by step through the linter's own hand-backs, its audit answered from a run cache
// folder the test seeded outside the work folder and named as its --cache-work-dir - so a
// test that needs a work folder whose build check is done gets the record the linter writes,
// never one written for it. A test that models a forged record edits that real record.
//
// Belongs here: the OSV answers the lock audit reads, the agent's side of a step (filling the
// review file, writing files), and the run through the steps. Does NOT belong here: what a
// step does (src/build-check/steps.js), or any record written by hand.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { analyzeEntries, handBack } from "../src/build-check/steps.js";
import {
  BUILD_CHECK_STEP,
  buildCheckBody,
  buildResults,
} from "../src/build-check/state.js";
import {
  MODE,
  addToRecord,
  readRecord,
  startMode,
  writeRecord,
} from "../src/review/record.js";
import { reviewFile, writeReviewFile } from "../src/report/handback.js";
import { settlePackageRoot } from "../src/addon/package-root.js";
import { loadRegistry } from "../src/checks/registry.js";
import { workPaths } from "../src/util/dest.js";
import {
  freshWorkFolder,
  osvEntries,
  popularityEntries,
  seedWorkCache,
} from "./seed-caches.js";
import { loadTheXpi } from "../src/review/start.js";

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
 * as auditEntries takes them), for a build check to name as its --cache-work-dir. Every
 * package named there is a widely-used one by its npm downloads, unless `unpopular` names it:
 * the audit asks the popularity of each declared package before OSV.
 * @param {Record<string, object[]>} [vulns]
 * @param {string[]} [unpopular]  Package names npm reports below the download bar.
 * @returns {string}
 */
export const auditCache = (vulns = {}, unpopular = []) => {
  const npm = {};
  for (const release of Object.keys(vulns)) {
    const name = release.slice(0, release.lastIndexOf("@"));
    npm[name] = { downloads: unpopular.includes(name) ? 0 : 9_000_000 };
  }
  return seedWorkCache({
    osv: auditEntries(vulns),
    popularity: popularityEntries({ npm }),
  });
};

/** Write files under a folder, creating what is missing. */
export function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
}

/** Fill in the review file the way the agent does: each entry's answer by its index. The
 *  agent judges the build safe and the reviewer lets it build unless `answers` says
 *  otherwise. */
export function answer(work, answers) {
  const file = workPaths(work).answers;
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const given = {
    SCA_BUILD_SAFETY_ISSUES: [],
    SCA_BUILD_DECISION: "Let the agent build",
    ...answers,
  };
  doc.entries = doc.entries.map((e) => ({ ...e, answer: given[e.index] }));
  fs.writeFileSync(file, JSON.stringify(doc));
}

/** Write the build report the `analyze` prompt asks for, as the agent does. */
export function writeBuildReport(work) {
  fs.writeFileSync(
    workPaths(work).build,
    "1. `npm ci`\n\n## Safety\n\nNone.\n"
  );
}

/**
 * The agent's build, as a test makes one: an empty `dist/` folder inside `folder`, which is
 * where the build put what it produced. Empty, so a rescued copy's review reads nothing new.
 * @param {string} folder
 * @returns {string}  The output, absolute.
 */
export function buildInto(folder) {
  const output = path.join(folder, "dist");
  fs.mkdirSync(output, { recursive: true });
  return output;
}

/**
 * The agent's build in a rescue, as the rescue prompt has it made: `build/` replaced with a
 * copy of the whole `rescued/`, and built at the root's place in it (buildInto).
 * @param {string} work  The work folder, real.
 * @param {string} root  The rescued copy's root.
 * @returns {string}  The output, absolute.
 */
export function buildRescued(work, root) {
  const { rescued, buildCopy } = workPaths(work);
  fs.rmSync(buildCopy, { recursive: true, force: true });
  fs.cpSync(rescued, buildCopy, { recursive: true, verbatimSymlinks: true });
  return buildInto(path.join(buildCopy, path.relative(rescued, root)));
}

/**
 * Run the build check of a source code review for real: the work folder a --llm-auto-review
 * run creates, the source extracted into its sca/ and handed back as the root, beside a build report judged
 * safe, the reviewer letting the agent build, and every hand-back after it.
 * Its run cache is `cache`, a seeded folder named as --cache-work-dir in its record, so every
 * step and its review read it: each audit is answered from it, a rescued copy's included.
 * A clean source is built in build/ (buildInto) and done. One the audit cannot read in full
 * is done at analyze, nobody asked.
 * A vulnerable one gets its rescued copy, and `rescue` is the agent's work in it: a function
 * of the copy's root, which changes what it must for the copy's audit to come out clean, and
 * after which a copy of it is built in build/ (buildRescued) - or null, for an agent that answers that the
 * rescue failed, so build/ is deleted, the copy stays, and the original is done, its roots back
 * in sca/.
 * Each step is asserted to move as the build check moves it. A build's output is compared
 * with the submitted XPI as `match` says, `no match` unless it says otherwise.
 * @param {{source: string, xpi: string, flags?: object, cache?: string,
 *   rescue?: ?(copyRoot: string) => void, match?: string}} opts
 * @returns {Promise<{next: string, work: string, record: object}>}  The handout of the
 *   last step: the folder whose review starts, and its record.
 */
export async function realBuildCheck({
  source,
  xpi,
  flags = {},
  cache = auditCache(),
  rescue = null,
  match = "no match",
}) {
  // Started as a build check is: the load creates the folder and puts the add-on's copy in
  // it with an empty record, what the run was given is added to it, the source lies in its
  // sca/, and the record starts at `analyze`, the early-exit checks having passed on it. The
  // review that starts in the folder adds what its early-exit run works out.
  const work = freshWorkFolder();
  const loaded = loadTheXpi(xpi, work);
  const given = addToRecord(work, loaded.record, {
    submission: { xpi, experiments: false },
    kind: "sca",
    flags: { ...flags, "cache-work-dir": cache },
    folders: { xpi: workPaths(work).xpi },
  });
  const sca = workPaths(work).sca;
  fs.cpSync(source, sca, { recursive: true });
  const copied = addToRecord(work, given, { folders: { sca } });
  const registry = loadRegistry();
  // What the hand-back issues, without the print: the record, then the answers file.
  const issue = (out) => {
    if (out.next === "step") {
      writeRecord(work, out.record);
      writeReviewFile(workPaths(work).answers, reviewFile(out.entries));
    }
    return out;
  };
  issue({
    next: "step",
    record: startMode(
      copied,
      MODE.buildCheck,
      buildCheckBody(settlePackageRoot(sca, {}).folders),
      BUILD_CHECK_STEP.analyze
    ),
    entries: analyzeEntries(),
  });
  const step = async () =>
    issue(await handBack(work, readRecord(work), registry));
  // Done, the build results added to the record as the hand-back adds them before the review
  // starts (src/cli.js buildCheckCase).
  const finished = (out) => ({
    ...out,
    work,
    record: addToRecord(work, out.record, {
      build: buildResults(work, out.record.current),
    }),
  });
  let at;
  answer(work, {});
  writeBuildReport(work);
  at = await step();
  if (at.next === "review") {
    return finished(at);
  }
  assert.equal(
    at.record.current.step,
    BUILD_CHECK_STEP.decision,
    "a safe build asks the reviewer"
  );
  answer(work, {});
  at = await step();
  if (at.next === "review") {
    return finished(at);
  }
  if (at.record.current.step === BUILD_CHECK_STEP.build) {
    const output = buildInto(workPaths(work).buildCopy);
    answer(work, { LLM_BUILD_OUTPUT: output, LLM_BUILD_XPI_MATCH: match });
    at = await step();
    assert.equal(at.next, "review", "a clean source is built and reviewed");
    assert.equal(at.record.current.buildOutput, output);
    assert.equal(at.record.current.buildMatch, match);
    return finished(at);
  }
  assert.equal(
    at.record.current.step,
    BUILD_CHECK_STEP.rescue,
    "a vulnerable source is rescued"
  );
  const copy = workPaths(work).rescued;
  if (rescue) {
    rescue(at.record.current.roots.packageRoot);
    answer(work, {
      LLM_BUILD_OUTPUT: buildRescued(work, at.record.current.roots.packageRoot),
      LLM_BUILD_XPI_MATCH: match,
    });
    at = await step();
    assert.equal(at.next, "review", "the rescued copy came out clean");
    assert.equal(at.record.current.buildResult, "built");
    return finished(at);
  }
  answer(work, {
    LLM_BUILD_OUTPUT: "The rescue failed",
    LLM_BUILD_XPI_MATCH: null,
  });
  at = await step();
  assert.equal(at.next, "review", "a failed rescue is reviewed unrescued");
  assert.equal(at.record.current.buildResult, "rescue-failed");
  assert.equal(
    at.record.current.roots.packageRoot,
    sca,
    "the source as submitted is reviewed"
  );
  assert.ok(fs.existsSync(copy), "the failed rescue's copy stays");
  return finished(at);
}
