// The preparation of a source code review, one hand-back at a time (src/prepare/steps.js):
// which roots it reads back and settles, what its audit of a root's lock decides
// (src/prepare/audit.js), when a rescued copy is made, how the copy's steps move on, how a
// rescue is given up, what each hand-back refuses, and what the review of a rescued copy
// tells the developer (sca-dependencies-changed). Driven through handBack() with OSV's
// answers seeded into a run cache folder outside the work folder, which the record names as
// its --cache-work-dir (auditCache), so every OSV answer is the test's, and a request for one
// it does not give is refused by the switched-off network.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handBack, startPreparation } from "../../src/prepare/steps.js";
import {
  PREPARE_STEP,
  readPrepare,
  startRecord,
  writePrepare,
} from "../../src/prepare/state.js";
import { HandbackRefused } from "../../src/report/handback.js";
import { NoAnswerError } from "../../src/util/net.js";
import { runCache, workPaths } from "../../src/util/dest.js";
import { loadSourceArchive } from "../../src/addon/load.js";
import depsChanged from "../../src/checks/rules/sca-dependencies-changed.js";
import { advisory, answer, auditCache, writeTree } from "../prepared.js";
import { osvEntries, seeded, seedWorkCache } from "../seed-caches.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");

/** A HIGH advisory on the build tool every source below declares. */
const TOOL_HIGH = {
  "lint-pebble@0.4.0": [advisory("GHSA-tool", "HIGH", "lint-pebble", "0.4.1")],
};

/** The build tool every source below declares, as OSV answers it with no advisory. */
const TOOL_CLEAN = { "lint-pebble@0.4.0": [] };

/** A package.json for the sources below: no dependency of its own, and a lint tool pinned
 *  as a devDependency unless `tool` is null. */
function packageFile(tool = "0.4.0", extra = {}) {
  return JSON.stringify({
    name: "lantern-sorter",
    version: "1.0.0",
    scripts: { build: "node build.js" },
    ...(tool ? { devDependencies: { "lint-pebble": tool } } : {}),
    ...extra,
  });
}

/** The npm lock that installs it, one key per line, so an entry has a line of its own. */
function npmLock(tool = "0.4.0", extraPackages = {}) {
  const root = { name: "lantern-sorter", version: "1.0.0" };
  if (tool) {
    root.devDependencies = { "lint-pebble": tool };
  }
  return JSON.stringify(
    {
      name: "lantern-sorter",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": root,
        ...(tool
          ? { "node_modules/lint-pebble": { version: tool, dev: true } }
          : {}),
        ...extraPackages,
      },
    },
    null,
    2
  );
}

/**
 * A work folder as the run that starts a preparation leaves it, its source extracted into
 * sca/ (`files`, relative to sca/), inside a fresh parent. Real, as the hand-back is given it.
 * Its record names `cache` as its --cache-work-dir: by default a folder seeded with OSV's
 * answers `vulns` (auditCache), for every step of the preparation. A null `cache` names none,
 * so the run's cache is the work folder's own.
 * @param {Record<string, string>} files
 * @param {{experiments?: boolean, vulns?: Record<string, object[]>, cache?: ?string}} [opts]
 * @returns {string} The work folder.
 */
function workFolder(
  files,
  { experiments = false, vulns = {}, cache = auditCache(vulns) } = {}
) {
  const parent = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "wl-prepare-"))
  );
  const work = path.join(parent, "work");
  fs.mkdirSync(work);
  startPreparation(
    work,
    startRecord({
      submission: { xpi: path.join(parent, "addon.xpi"), experiments },
      flags: cache ? { "cache-work-dir": cache } : {},
    })
  );
  writeTree(workPaths(work).sca, {
    "manifest.json": '{"manifest_version": 3, "name": "x", "version": "1"}',
    "bg.js": 'console.log("source");\n',
    ...files,
  });
  return work;
}

/** The first step: the extracted source handed back as the root, sca/ itself, with
 *  `answers` filled in beside it. */
const first = (work, answers = {}) => {
  answer(work, { SCA_ROOT: workPaths(work).sca, ...answers });
  return handBack(work);
};

/** A later step: the folder handed back, nothing to fill in. */
const later = (work) => handBack(work);

/**
 * OSV's responses to an audit of one release, as run cache entries (osvEntries), each played
 * in place of OSV and kept like a live answer: `vulns` maps the "name@version" asked about to
 * its advisories, as auditEntries takes it.
 * @param {Record<string, object[]>} vulns  One release.
 * @returns {Record<string, object>}
 */
function liveAudit(vulns) {
  const [[release, list]] = Object.entries(vulns);
  return osvEntries({
    batch: {
      [release]: seeded({
        status: 200,
        json: { results: [{ vulns: list.map((v) => ({ id: v.id })) }] },
      }),
    },
    advisories: Object.fromEntries(
      list.map((v) => [v.id, seeded({ status: 200, json: v })])
    ),
  });
}

/** OSV's batch endpoint answering 404 for `release`, which is no answer from OSV and ends
 *  the run, as run cache entries (osvEntries). */
const batchDown = (release) =>
  osvEntries({ batch: { [release]: seeded({ status: 404 }) } });

/** Add `entries` to the OSV cache of the run the record of `work` names. */
function seedRunOsv(work, entries) {
  const file = runCache(work, recordOf(work).flags?.["cache-work-dir"]).osv;
  const cache = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : {};
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...cache, ...entries }));
}

/** Whether every entry of a run's OSV cache file holds OSV's answer. */
const allAnswered = (file) =>
  Object.values(JSON.parse(fs.readFileSync(file, "utf8"))).every((e) =>
    Object.hasOwn(e, "answer")
  );

const recordOf = (work) => readPrepare(work);

const cleanup = (work) =>
  fs.rmSync(path.dirname(work), { recursive: true, force: true });

/** A refusal, with the problem it names. */
const refused = (pattern) => (err) => {
  assert.ok(err instanceof HandbackRefused, err.message);
  assert.match(err.problem, pattern);
  return true;
};

// ---- the first step ----

// Nothing to stop the review: the folder is done, with the roots recorded, the review file
// the review claims for itself gone, and the review starts there.
test("a clean source is done, and its review starts in the folder", async () => {
  const work = workFolder(
    {
      "package.json": packageFile(),
      "package-lock.json": npmLock(),
    },
    { vulns: TOOL_CLEAN }
  );
  const at = await first(work);
  assert.equal(at.next, "review");
  assert.equal(at.work, work);
  assert.equal(at.record.step, PREPARE_STEP.done);
  assert.deepEqual(at.record.roots, {
    scaRoot: workPaths(work).sca,
    scaExpSource: null,
  });
  assert.equal(at.record.packageManagers, true, "the reviewer allowed them");
  assert.deepEqual(recordOf(work), at.record);
  assert.ok(!fs.existsSync(workPaths(work).review), "the review file is gone");
  assert.ok(!fs.existsSync(workPaths(work).rescued), "no copy is made");
  cleanup(work);
});

// The reviewer is asked first whether the agent may run package-manager commands, and the
// record holds no answer until the first hand-back reads one.
test("the first step asks the reviewer about package-manager commands", () => {
  const work = workFolder({ "package.json": packageFile() });
  const [managers] = JSON.parse(
    fs.readFileSync(workPaths(work).review, "utf8")
  ).entries;
  assert.equal(managers.index, "PACKAGE_MANAGERS");
  assert.equal(managers.answer, null);
  assert.match(managers.message, /npm install --package-lock-only/);
  assert.match(managers.message, /npm ci/);
  assert.deepEqual(
    managers.answers.map((a) => a.label),
    ["Allow", "Do not allow"]
  );
  assert.equal(recordOf(work).packageManagers, null);
  cleanup(work);
});

// Declined, nothing is audited and nothing rescued: a rescue runs package-manager commands.
// The lock is vulnerable and OSV is given no answer, so any audit would ask the switched-off
// network and fail. The folder is done at once, its roots in sca/.
test("declined package-manager commands are done at once, with nothing audited", async () => {
  const work = workFolder({
    "package.json": packageFile(),
    "package-lock.json": npmLock(),
  });
  const at = await first(work, { PACKAGE_MANAGERS: "Do not allow" });
  assert.equal(at.next, "review");
  assert.equal(at.record.step, PREPARE_STEP.done);
  assert.equal(at.record.packageManagers, false);
  assert.deepEqual(at.record.roots, {
    scaRoot: workPaths(work).sca,
    scaExpSource: null,
  });
  assert.deepEqual(recordOf(work), at.record);
  assert.ok(!fs.existsSync(workPaths(work).rescued), "no copy is made");
  cleanup(work);
});

// The answer is one of the labels its entry offered, and anything else is refused with the
// folder unchanged.
test("an answer about package-manager commands that is no label is refused", async () => {
  const work = workFolder({ "package.json": packageFile() });
  await assert.rejects(
    first(work, { PACKAGE_MANAGERS: "Maybe" }),
    refused(
      /PACKAGE_MANAGERS answers "Maybe", which this entry does not accept/
    )
  );
  await assert.rejects(
    first(work, { PACKAGE_MANAGERS: null }),
    refused(/PACKAGE_MANAGERS still has no "answer"/)
  );
  assert.equal(recordOf(work).step, PREPARE_STEP.extract);
  cleanup(work);
});

// The root is settled the way the review settles it: named one wrapper folder too high, it
// moves down to the folder holding package.json, and that is what is recorded and audited.
test("a wrapper folder named as the root settles on the folder below", async () => {
  const work = workFolder(
    {
      "proj/package.json": packageFile(),
      "proj/package-lock.json": npmLock(),
    },
    { vulns: TOOL_HIGH }
  );
  const at = await first(work);
  // Audited at the settled root: the build tool's advisory is found there, so it is rescued,
  // and the copy's root is the same folder in the copy.
  assert.equal(at.work, work);
  assert.equal(at.record.step, PREPARE_STEP.reduce);
  assert.equal(
    at.record.roots.scaRoot,
    path.join(workPaths(work).rescued, "proj")
  );
  cleanup(work);
});

// The rescue's whole case: a known vulnerability in the lock. The source is copied into the
// work folder's rescued/, beside sca/, and the record's roots move into the copy - a symbolic
// link copied as it is written. One folder, one record.
test("a source stopped only by a locked vulnerability gets a rescued copy", async () => {
  const work = workFolder(
    {
      "package.json": packageFile(),
      "package-lock.json": npmLock(),
    },
    { vulns: TOOL_HIGH }
  );
  fs.symlinkSync("bg.js", path.join(workPaths(work).sca, "link.js"));
  const at = await first(work);
  const copy = workPaths(work).rescued;
  assert.equal(at.next, "step");
  assert.equal(at.work, work);
  assert.equal(at.record.step, PREPARE_STEP.reduce);
  assert.equal(at.record.roots.scaRoot, copy);
  assert.deepEqual(recordOf(work), at.record);
  assert.ok(!fs.existsSync(workPaths(work).review));
  assert.equal(
    fs.readFileSync(path.join(copy, "package.json"), "utf8"),
    packageFile()
  );
  assert.equal(fs.readlinkSync(path.join(copy, "link.js")), "bg.js");
  cleanup(work);
});

// A pnpm lock is read the same way: the advisory sits in the tree, anchored at
// pnpm-lock.yaml, which is a file a rescue changes.
test("a pnpm tree vulnerability is rescued like an npm one", async () => {
  const lock = [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    devDependencies:",
    "      lint-pebble:",
    "        specifier: 0.4.0",
    "        version: 0.4.0",
    "",
    "packages:",
    "",
    "  lint-pebble@0.4.0:",
    "    resolution: {integrity: sha512-aaaa==}",
    "",
    "  argv-crumb@0.0.8:",
    "    resolution: {integrity: sha512-bbbb==}",
    "",
    "snapshots:",
    "",
    "  lint-pebble@0.4.0:",
    "    dependencies:",
    "      argv-crumb: 0.0.8",
    "",
    "  argv-crumb@0.0.8: {}",
    "",
  ].join("\n");
  const work = workFolder(
    {
      "package.json": packageFile(),
      "pnpm-lock.yaml": lock,
    },
    {
      vulns: {
        ...TOOL_CLEAN,
        "argv-crumb@0.0.8": [
          advisory("GHSA-crumb", "CRITICAL", "argv-crumb", "0.0.10"),
        ],
      },
    }
  );
  const at = await first(work);
  assert.equal(at.work, work);
  assert.equal(at.record.step, PREPARE_STEP.reduce);
  cleanup(work);
});

// ---- the roots handed back ----
// Every way they can be wrong is refused to the agent, with nothing changed.

test("roots that are missing, blank or outside the source are refused", async () => {
  const work = workFolder({ "package.json": packageFile() });
  const sca = workPaths(work).sca;
  const unchanged = () =>
    assert.equal(recordOf(work).step, PREPARE_STEP.extract);

  await assert.rejects(later(work), refused(/SCA_ROOT still has no "answer"/));
  unchanged();
  await assert.rejects(
    first(work, { SCA_ROOT: "   " }),
    refused(/SCA_ROOT names no folder/)
  );
  unchanged();
  const elsewhere = path.join(path.dirname(work), "elsewhere");
  writeTree(elsewhere, { "package.json": packageFile() });
  await assert.rejects(
    first(work, { SCA_ROOT: elsewhere }),
    refused(/SCA_ROOT ".+elsewhere" is not a folder inside/)
  );
  await assert.rejects(
    first(work, { SCA_ROOT: path.join(sca, "nothing-here") }),
    refused(/is not a folder inside/)
  );
  // A link inside the source that leads out is the folder it leads to, and refused.
  fs.symlinkSync(elsewhere, path.join(sca, "out"));
  await assert.rejects(
    first(work, { SCA_ROOT: path.join(sca, "out") }),
    refused(/is not a folder inside/)
  );
  unchanged();
  // One that leads to a folder inside it is that folder, and taken as it.
  writeTree(path.join(sca, "real"), { "package.json": packageFile() });
  fs.symlinkSync(path.join(sca, "real"), path.join(sca, "in"));
  const at = await first(work, { SCA_ROOT: "in" });
  assert.equal(at.record.roots.scaRoot, path.join(sca, "real"));
  cleanup(work);
});

test("a source folder that is a link is refused", async () => {
  const work = workFolder({ "package.json": packageFile() });
  const sca = workPaths(work).sca;
  const moved = path.join(path.dirname(work), "moved");
  fs.renameSync(sca, moved);
  fs.symlinkSync(moved, sca);
  await assert.rejects(
    first(work, { SCA_ROOT: sca }),
    refused(/is not the folder the source was extracted into/)
  );
  cleanup(work);
});

test("an Experiment folder is read against the root, and must lie inside it", async () => {
  const work = workFolder(
    { "package.json": packageFile(), "exp/api.js": "" },
    { experiments: true }
  );
  const sca = workPaths(work).sca;
  // Asked for, so an answer missing is refused like any other.
  await assert.rejects(
    first(work, {}),
    refused(/SCA_EXP_SOURCE still has no "answer"/)
  );
  await assert.rejects(
    first(work, { SCA_EXP_SOURCE: "../.." }),
    refused(/SCA_EXP_SOURCE "\.\.\/\.\." is not a folder inside/)
  );
  // The root itself excludes nothing, and the review refuses it - so the hand-back does.
  await assert.rejects(
    first(work, { SCA_EXP_SOURCE: "." }),
    refused(/sca-exp-source/)
  );
  assert.equal(recordOf(work).step, PREPARE_STEP.extract, "nothing moved");
  const at = await first(work, { SCA_EXP_SOURCE: "exp" });
  assert.equal(at.record.roots.scaExpSource, path.join(sca, "exp"));
  cleanup(work);
});

// ---- not rescued ----
// Each of these is done at once, and its review decides the rest.

test("a vulnerable library committed to the archive is not rescued", async () => {
  const work = workFolder(
    {
      "package.json": packageFile(null),
      "package-lock.json": npmLock(null),
      "vendor/bootstrap.min.css": fs.readFileSync(
        path.join(
          ROOT,
          "tests/addons/sca-undeclared-library/src/vendor/bootstrap/bootstrap.min.css"
        )
      ),
    },
    {
      vulns: {
        "bootstrap@5.3.0": [advisory("GHSA-css", "HIGH", "bootstrap", "5.3.1")],
      },
    }
  );
  const at = await first(work);
  assert.equal(at.work, work);
  assert.equal(at.record.step, PREPARE_STEP.done);
  cleanup(work);
});

// The preparation looks at the lock and nothing else: a review that will stop for another
// reason as well is rescued all the same, and stops on that reason after.
test("a vulnerable lock beside another reason to stop is rescued", async () => {
  const work = workFolder(
    {
      "package.json": packageFile(),
      "package-lock.json": npmLock(),
      ".npmrc": "registry=https://registry.example.invalid/\n",
    },
    { vulns: TOOL_HIGH }
  );
  const at = await first(work);
  assert.equal(at.record.step, PREPARE_STEP.reduce);
  cleanup(work);
});

// A lock entry that names one release and installs another is a lock the audit cannot trust
// to say what is installed: it is not audited at all - no request reaches OSV - and not
// rescued, and the review it is handed to stops on it.
test("a forged lock is neither audited nor rescued", async () => {
  const work = workFolder({
    "package.json": packageFile(),
    "package-lock.json": npmLock("0.4.0", {
      "node_modules/lint-pebble": {
        version: "0.4.0",
        dev: true,
        resolved:
          "https://registry.npmjs.org/lint-pebble/-/lint-pebble-0.3.9.tgz",
      },
    }),
  });
  const at = await first(work);
  assert.equal(at.next, "review");
  assert.equal(at.work, work);
  assert.equal(at.record.step, PREPARE_STEP.done);
  assert.ok(!fs.existsSync(workPaths(work).rescued), "no copy is made");
  cleanup(work);
});

// More than one lock is a source the audit cannot trust either: it would read one while the
// build installs from another. Not audited - no request reaches OSV - and not rescued, and
// the review it is handed to stops on it (sca-lock-file-multiple).
test("a source with more than one lock is neither audited nor rescued", async () => {
  const work = workFolder({
    "package.json": packageFile(),
    "package-lock.json": npmLock(),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
  });
  const at = await first(work);
  assert.equal(at.next, "review");
  assert.equal(at.record.step, PREPARE_STEP.done);
  assert.ok(!fs.existsSync(workPaths(work).rescued), "no copy is made");
  cleanup(work);
});

test("a source the audit cannot read in full is not rescued", async (t) => {
  await t.test("no lock at all", async () => {
    const work = workFolder(
      { "package.json": packageFile() },
      { vulns: TOOL_HIGH }
    );
    const at = await first(work);
    assert.equal(at.work, work);
    assert.equal(at.record.step, PREPARE_STEP.done);
    cleanup(work);
  });
  await t.test("a file the loader cannot read", async () => {
    const work = workFolder(
      {
        "package.json": packageFile(),
        "package-lock.json": npmLock(),
        "secret.js": "",
      },
      { vulns: TOOL_HIGH }
    );
    fs.chmodSync(path.join(workPaths(work).sca, "secret.js"), 0);
    const at = await first(work);
    assert.equal(at.work, work);
    assert.equal(at.record.step, PREPARE_STEP.done);
    cleanup(work);
  });
});

// ---- the rescued copy's steps ----

/** A work folder rescued for the build tool's advisory: the copy, at `reduce`. Its steps are
 *  answered from `vulns`, which holds that advisory. */
async function rescued(vulns = TOOL_HIGH) {
  const work = workFolder(
    {
      "package.json": packageFile(),
      "package-lock.json": npmLock(),
    },
    { vulns }
  );
  const at = await first(work);
  return { work, copy: workPaths(work).rescued, root: at.record.roots.scaRoot };
}

test("a reduce that leaves the copy clean hands the review the copy", async () => {
  const { work, copy, root } = await rescued();
  writeTree(root, {
    "package.json": packageFile(null),
    "package-lock.json": npmLock(null),
  });
  const at = await later(work);
  assert.equal(at.next, "review");
  assert.equal(at.work, work);
  assert.equal(at.record.step, PREPARE_STEP.done);
  // The copy is what the review reads.
  assert.equal(at.record.roots.scaRoot, root);
  assert.ok(fs.existsSync(copy));
  cleanup(work);
});

// The preparation is one run with its review: OSV is asked through the run's cache in the
// work folder. A step over a lock already audited asks OSV nothing, and the advisory it
// reads there is what rescues the copy.
test("a rescued copy's step reads the run's OSV cache", async () => {
  const work = workFolder(
    {
      "package.json": packageFile(),
      "package-lock.json": npmLock(),
    },
    { cache: null }
  );
  seedRunOsv(work, liveAudit(TOOL_HIGH));
  const at = await first(work);
  assert.equal(at.record.step, PREPARE_STEP.reduce);
  assert.ok(allAnswered(path.join(work, ".cache", "osv.json")));
  const reduce = await handBack(work);
  assert.equal(reduce.record.step, PREPARE_STEP.fix);
  cleanup(work);
});

// A run that names its cache folder (--cache-work-dir, forwarded in the record) keeps OSV's
// answers there instead, so the preparation and its review read the folder a test seeded.
test("a step asks through the cache folder its record names", async () => {
  const dir = seedWorkCache({ osv: liveAudit(TOOL_HIGH) });
  const work = workFolder(
    {
      "package.json": packageFile(),
      "package-lock.json": npmLock(),
    },
    { cache: dir }
  );
  const at = await first(work);
  assert.equal(at.record.step, PREPARE_STEP.reduce, "the advisory was read");
  assert.ok(allAnswered(path.join(dir, "osv.json")));
  assert.ok(!fs.existsSync(path.join(work, ".cache")));
  cleanup(work);
});

test("a reduce that is not enough moves on to fix, and a clean fix is done", async () => {
  const { work, copy, root } = await rescued({
    ...TOOL_HIGH,
    "lint-pebble@0.4.1": [],
  });
  const reduce = await later(work);
  assert.equal(reduce.next, "step");
  assert.equal(reduce.work, work);
  assert.equal(reduce.record.step, PREPARE_STEP.fix);
  writeTree(root, {
    "package.json": packageFile("0.4.1"),
    "package-lock.json": npmLock("0.4.1"),
  });
  const fix = await later(work);
  assert.equal(fix.work, work);
  assert.equal(fix.record.step, PREPARE_STEP.done);
  cleanup(work);
});

// The way out: an agent that could not do either step runs on without changing anything.
// The copy is deleted, and the folder is done, its roots back in sca/: the
// source as submitted is reviewed like any other. The preparation writes no report of its own.
test("a fix that is not enough deletes the copy, and the original is reviewed unrescued", async () => {
  const { work, copy } = await rescued();
  await later(work);
  const at = await later(work);
  assert.equal(at.next, "review");
  assert.equal(at.work, work);
  assert.equal(at.record.step, PREPARE_STEP.done);
  assert.equal(at.record.roots.scaRoot, workPaths(work).sca);
  assert.deepEqual(recordOf(work), at.record);
  assert.ok(!fs.existsSync(copy), "the copy is deleted");
  assert.ok(!fs.existsSync(workPaths(work).report), "no report of its own");
  // Handed back again, its review is handed out once more, asking nothing.
  const again = await later(work);
  assert.equal(again.next, "review");
  assert.deepEqual(again.record, at.record);
  cleanup(work);
});

// A copy is clean only where the audit can vouch for it. Each of these would otherwise read
// as a lock with no advisory left in it.
test("a copy the audit cannot vouch for is not clean", async (t) => {
  const cases = {
    "its lock deleted": (root) =>
      fs.rmSync(path.join(root, "package-lock.json")),
    "its lock unreadable": (root) =>
      writeTree(root, { "package-lock.json": "{ not json" }),
    "its lock pointed at git": (root) =>
      writeTree(root, {
        "package-lock.json": npmLock("0.4.0", {
          "node_modules/lint-pebble": {
            version: "0.4.0",
            dev: true,
            resolved: "git+ssh://git@example.invalid/pebble.git#abc",
          },
        }),
      }),
    "its lock forged to name a fixed release": (root) =>
      writeTree(root, {
        "package-lock.json": npmLock("0.4.0", {
          "node_modules/lint-pebble": {
            version: "0.4.1",
            dev: true,
            resolved:
              "https://registry.npmjs.org/lint-pebble/-/lint-pebble-0.4.0.tgz",
          },
        }),
      }),
    "a file the loader cannot read": (root) => {
      writeTree(root, {
        "package.json": packageFile(null),
        "package-lock.json": npmLock(null),
        "secret.js": "",
      });
      fs.chmodSync(path.join(root, "secret.js"), 0);
    },
  };
  for (const [name, edit] of Object.entries(cases)) {
    await t.test(name, async () => {
      const { work, root } = await rescued();
      edit(root);
      assert.equal((await later(work)).record.step, PREPARE_STEP.fix, name);
      cleanup(work);
    });
  }
});

// OSV answering 404 is no answer: it says nothing about the tree, so the preparation ends as
// the tool's failure, with the record where it was, for the folder to be handed back once OSV
// answers again - at the first step, and at a rescued copy's.
test("an audit OSV does not answer ends the preparation", async (t) => {
  const noAnswer = (err) =>
    err instanceof NoAnswerError && /querybatch \(HTTP 404\)/.test(err.message);
  await t.test("at the first step", async () => {
    const work = workFolder(
      {
        "package.json": packageFile(),
        "package-lock.json": npmLock(),
      },
      { cache: seedWorkCache({ osv: batchDown("lint-pebble@0.4.0") }) }
    );
    await assert.rejects(first(work), noAnswer);
    assert.equal(recordOf(work).step, PREPARE_STEP.extract);
    cleanup(work);
  });
  await t.test("at a rescued copy's step", async () => {
    const { work, root } = await rescued();
    // A package the run has not asked OSV about yet, so the copy's audit asks.
    writeTree(root, {
      "package.json": packageFile(null),
      "package-lock.json": npmLock(null, {
        "node_modules/argv-crumb": { version: "0.0.8", dev: true },
      }),
    });
    seedRunOsv(work, batchDown("argv-crumb@0.0.8"));
    await assert.rejects(later(work), noAnswer);
    assert.equal(recordOf(work).step, PREPARE_STEP.reduce);
    cleanup(work);
  });
});

// ---- order, and runs cut short ----

// A run cut short after the copy was made can lose the prompt that named it: the folder
// handed back again is at the copy's step, and carries it on.
test("a folder handed back mid-rescue carries the rescue on", async () => {
  const { work } = await rescued();
  const again = await later(work);
  assert.equal(again.next, "step");
  assert.equal(again.work, work);
  assert.equal(again.record.step, PREPARE_STEP.fix);
  cleanup(work);
});

// A finished preparation is not audited again: its review is handed out once more, for the
// hand-back to start again, and the review file the review claims is deleted again, in case
// the run that marked it was cut short before it could.
test("a done folder handed back again hands out its review again", async () => {
  const work = workFolder(
    {
      "package.json": packageFile(),
      "package-lock.json": npmLock(),
    },
    { vulns: TOOL_CLEAN }
  );
  const done = await first(work);
  fs.writeFileSync(workPaths(work).review, "{}");
  const again = await later(work);
  assert.equal(again.next, "review");
  assert.deepEqual(again.record, done.record);
  assert.ok(!fs.existsSync(workPaths(work).review));
  cleanup(work);
});

// A clean rescue's folder handed back again keeps its copy: its roots lie there, so the copy
// is what its review reads.
test("a clean rescue handed back again keeps its copy", async () => {
  const { work, copy, root } = await rescued();
  writeTree(root, {
    "package.json": packageFile(null),
    "package-lock.json": npmLock(null),
  });
  await later(work);
  const again = await later(work);
  assert.equal(again.next, "review");
  assert.equal(again.record.roots.scaRoot, root);
  assert.ok(fs.existsSync(copy));
  cleanup(work);
});

// A give-up cut short after the folder was marked done leaves the copy behind; the next
// hand-back finishes removing it, and hands the review out.
test("a copy left behind by a give-up cut short is removed", async () => {
  const { work, copy } = await rescued();
  await later(work);
  writePrepare(work, {
    ...recordOf(work),
    step: PREPARE_STEP.done,
    roots: { scaRoot: workPaths(work).sca, scaExpSource: null },
  });
  assert.ok(fs.existsSync(copy));
  const at = await later(work);
  assert.equal(at.next, "review");
  assert.equal(at.work, work);
  assert.ok(!fs.existsSync(copy));
  cleanup(work);
});

// The agent can write any file, records included, so no record decides what is deleted: the
// one folder the preparation ever removes is the work folder's own rescued/, whatever the
// record names.
test("a forged record never removes a folder outside the work folder", async () => {
  const { work } = await rescued();
  const stray = path.join(path.dirname(work), "stray");
  fs.mkdirSync(stray);
  // Roots that name a folder outside the work folder, at the give-up that removes the copy.
  writePrepare(work, {
    ...recordOf(work),
    step: PREPARE_STEP.done,
    roots: { scaRoot: stray, scaExpSource: null },
  });
  await later(work);
  assert.ok(fs.existsSync(stray));
  assert.ok(!fs.existsSync(workPaths(work).rescued));
  cleanup(work);
});

// The record is the linter's alone: every write leaves it read-only, the plainest signal that
// it is out of the agent's reach - at every step.
test("every record the preparation writes is read-only", async () => {
  const mode = (folder) => fs.statSync(workPaths(folder).prepare).mode & 0o777;
  const work = workFolder(
    {
      "package.json": packageFile(),
      "package-lock.json": npmLock(),
    },
    { vulns: TOOL_HIGH }
  );
  assert.equal(mode(work), 0o444, "as the preparation starts");
  await first(work);
  assert.equal(mode(work), 0o444, "at reduce");
  await later(work);
  assert.equal(mode(work), 0o444, "at fix");
  await later(work);
  assert.equal(mode(work), 0o444, "given up");
  cleanup(work);
});

// Every write stores a hash over the record, so a change made after it - even a plausible
// one, like the root it names - is caught on the next read, and refused.
test("a record changed after the linter wrote it is refused", async () => {
  const { work } = await rescued();
  const file = workPaths(work).prepare;
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.roots.scaExpSource = record.roots.scaRoot;
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, JSON.stringify(record, null, 1));
  await assert.rejects(
    later(work),
    refused(/changed after the linter wrote it/)
  );
  cleanup(work);
});

// A record from the version of this tool before the hash has none, and is told apart as
// another version's rather than read as a changed one.
test("a record of another version of this tool is refused as one", async () => {
  const work = workFolder({ "package.json": packageFile() });
  const file = workPaths(work).prepare;
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  delete record.digest;
  record.version = 1;
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, JSON.stringify(record));
  await assert.rejects(later(work), /written by another version/);
  cleanup(work);
});

// A boolean in the record is true or false, as the linter writes it. Anything else was put
// there by an edit, and the hand-back is refused rather than reading a meaning into it.
test("a record boolean that is neither true nor false is refused", async () => {
  const { work } = await rescued();
  const record = recordOf(work);
  writePrepare(work, {
    ...record,
    submission: { ...record.submission, experiments: "yes" },
  });
  await assert.rejects(
    later(work),
    refused(/holds submission\.experiments as neither true nor false/)
  );
  cleanup(work);
});

test("a packageManagers that is neither true nor false is refused", async () => {
  const { work } = await rescued();
  writePrepare(work, { ...recordOf(work), packageManagers: "no" });
  await assert.rejects(
    later(work),
    refused(/holds packageManagers as neither true nor false/)
  );
  cleanup(work);
});

// The copy is the run's own, inside its work folder: one an earlier hand-back left behind, cut
// short before the record moved on, is simply made again. A copy that cannot be made ends the
// run before any prompt names it, and the record stays at its first step, so handing the
// folder back retries.
test("a rescued copy is made again over a stale one", async () => {
  const work = workFolder(
    {
      "package.json": packageFile(),
      "package-lock.json": npmLock(),
    },
    { vulns: TOOL_HIGH }
  );
  const copy = workPaths(work).rescued;
  fs.mkdirSync(copy);
  fs.writeFileSync(path.join(copy, "left-over.txt"), "stale");
  const at = await first(work);
  assert.equal(at.record.step, PREPARE_STEP.reduce);
  assert.ok(!fs.existsSync(path.join(copy, "left-over.txt")));
  assert.ok(fs.existsSync(path.join(copy, "package.json")));
  cleanup(work);
});

test("a rescued copy that cannot be made ends the preparation", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root writes any folder");
    return;
  }
  const work = workFolder(
    {
      "package.json": packageFile(),
      "package-lock.json": npmLock(),
    },
    { vulns: TOOL_HIGH }
  );
  fs.chmodSync(work, 0o555);
  try {
    await assert.rejects(first(work), (err) => {
      assert.ok(!(err instanceof HandbackRefused), err.message);
      assert.match(
        err.message,
        /^The rescued copy ".+rescued" could not be made \(\w+\)\. Hand the work folder back once that is fixed\.$/
      );
      return true;
    });
  } finally {
    fs.chmodSync(work, 0o755);
  }
  assert.equal(recordOf(work).step, PREPARE_STEP.extract);
  cleanup(work);
});

// Every path a record holds is read by a later run, from any directory, so each is written
// absolute - and a record about to hold a relative one is refused at the write, naming it.
test("a record holding a relative path is never written", async () => {
  const { work } = await rescued();
  const record = recordOf(work);
  const relative = {
    "submission.xpi": {
      submission: { ...record.submission, xpi: "addon.xpi" },
    },
    "roots.scaRoot": { roots: { ...record.roots, scaRoot: "sca" } },
    "roots.scaExpSource": { roots: { ...record.roots, scaExpSource: "exp" } },
    "flags.cache-schema-dir": { flags: { "cache-schema-dir": "cache" } },
  };
  for (const [field, over] of Object.entries(relative)) {
    assert.throws(
      () => writePrepare(work, { ...record, ...over }),
      new RegExp(`and ${field.replace(/\./g, "\\.")} is not`),
      field
    );
  }
  cleanup(work);
});

// ---- sca-dependencies-changed: what a rescued review tells the developer ----

/** The check run on a source archive written from `files`, beside the original package
 *  files `original` (null for a source that is no rescued copy). */
function changed(files, original) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-changed-"));
  writeTree(dir, files);
  const artifact = loadSourceArchive(dir);
  artifact.originalPackages = original && {
    files: new Map(
      Object.entries(original).map(([name, text]) => [name, Buffer.from(text)])
    ),
  };
  const { findings } = depsChanged.run({ artifact });
  fs.rmSync(dir, { recursive: true, force: true });
  return findings.map((f) => [
    `${f.file}${f.loc?.line ? `:${f.loc.line}` : ""}`,
    f.item,
  ]);
}

test("sca-dependencies-changed says nothing for a source that is no rescued copy", () => {
  const files = {
    "package.json": packageFile(),
    "package-lock.json": npmLock(),
  };
  assert.deepEqual(changed(files, null), []);
  // A copy whose lock installs what the original's did has nothing to say either - a
  // package.json edit alone included, since the lock is what the install follows.
  assert.deepEqual(
    changed({ ...files, "package.json": packageFile(null) }, files),
    []
  );
});

test("sca-dependencies-changed says once, at package.json, that the copy changed", () => {
  const original = {
    "package.json": packageFile("0.4.0"),
    "package-lock.json": npmLock("0.4.0", {
      "node_modules/tidy-lantern": { version: "2.1.0" },
      "node_modules/wick-trim": { version: "1.0.1" },
    }),
  };
  // A declared tool removed: one finding, no list - the developer's own audit names what to
  // fix.
  const reduced = {
    "package.json": packageFile(null),
    "package-lock.json": npmLock(null, {
      "node_modules/tidy-lantern": { version: "2.1.0" },
      "node_modules/wick-trim": { version: "1.0.1" },
    }),
  };
  assert.deepEqual(changed(reduced, original), [["package.json", null]]);
  // A moved release alone is a change too.
  const relocked = {
    ...original,
    "package-lock.json": npmLock("0.4.0", {
      "node_modules/tidy-lantern": { version: "2.1.0" },
      "node_modules/wick-trim": { version: "1.0.3" },
    }),
  };
  assert.deepEqual(changed(relocked, original), [["package.json", null]]);
});
