// The preparation of a source code review, one hand-back at a time (src/prepare/steps.js):
// which roots it reads back and settles, what its audit of a root's lock decides
// (src/prepare/audit.js), when a rescued copy is made, how the copy's steps move on, how a
// rescue is given up, what each hand-back refuses, and what the review of a rescued copy
// tells the developer (sca-dependencies-changed). Driven through handBack() with a fake
// network, so every OSV answer is the test's.

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
import { workPaths } from "../../src/util/dest.js";
import { loadSourceArchive } from "../../src/addon/load.js";
import depsChanged from "../../src/checks/rules/sca-dependencies-changed.js";
import { advisory, answer, net, noNet, writeTree } from "../prepared.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");

/** A HIGH advisory on the build tool every source below declares. */
const TOOL_HIGH = {
  "lint-pebble@0.4.0": [advisory("GHSA-tool", "HIGH", "lint-pebble", "0.4.1")],
};

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
 * sca/ (`files`, relative to sca/) - inside a fresh parent, so its rescued copy lands beside
 * it there. Real, as the hand-back is given it.
 * @param {Record<string, string>} files
 * @param {{experiments?: boolean}} [opts]
 * @returns {string} The work folder.
 */
function workFolder(files, { experiments = false } = {}) {
  const parent = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "wl-prepare-"))
  );
  const work = path.join(parent, "work");
  fs.mkdirSync(work);
  startPreparation(
    work,
    startRecord({
      submission: { xpi: path.join(parent, "addon.xpi"), experiments },
      flags: {},
    })
  );
  writeTree(workPaths(work).sca, {
    "manifest.json": '{"manifest_version": 3, "name": "x", "version": "1"}',
    "bg.js": 'console.log("source");\n',
    ...files,
  });
  return work;
}

/** The first step: the extracted source handed back as the root, sca/ itself. */
const first = (work, n = net(), answers = {}) => {
  answer(work, { SCA_ROOT: workPaths(work).sca, ...answers });
  return handBack(work, { net: n });
};

/** A later step: the folder handed back, nothing to fill in. */
const later = (work, n = net()) => handBack(work, { net: n });

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
  const work = workFolder({
    "package.json": packageFile(),
    "package-lock.json": npmLock(),
  });
  const at = await first(work, net());
  assert.equal(at.next, "review");
  assert.equal(at.work, work);
  assert.equal(at.record.step, PREPARE_STEP.done);
  assert.deepEqual(at.record.roots, {
    scaRoot: workPaths(work).sca,
    scaExpSource: null,
  });
  assert.deepEqual(recordOf(work), at.record);
  assert.ok(!fs.existsSync(workPaths(work).review), "the review file is gone");
  assert.ok(!fs.existsSync(`${work}-rescued`), "no copy is made");
  cleanup(work);
});

// The root is settled the way the review settles it: named one wrapper folder too high, it
// moves down to the folder holding package.json, and that is what is recorded and audited.
test("a wrapper folder named as the root settles on the folder below", async () => {
  const work = workFolder({
    "proj/package.json": packageFile(),
    "proj/package-lock.json": npmLock(),
  });
  const at = await first(work, net(TOOL_HIGH));
  // Audited at the settled root: the build tool's advisory is found there, so it is rescued.
  assert.equal(at.work, `${work}-rescued`);
  assert.equal(
    recordOf(work).roots.scaRoot,
    path.join(workPaths(work).sca, "proj")
  );
  assert.equal(
    at.record.roots.scaRoot,
    path.join(workPaths(at.work).sca, "proj")
  );
  cleanup(work);
});

// The rescue's whole case: a known vulnerability in the lock. The original is marked as
// handed to the copy and records what the lock audit found; the
// copy names the original, and carries its roots mapped into its own sca/ - a symbolic link
// copied as it is written.
test("a source stopped only by a locked vulnerability gets a rescued copy", async () => {
  const work = workFolder({
    "package.json": packageFile(),
    "package-lock.json": npmLock(),
  });
  fs.symlinkSync("bg.js", path.join(workPaths(work).sca, "link.js"));
  const at = await first(work, net(TOOL_HIGH));
  const copy = `${work}-rescued`;
  assert.equal(at.next, "step");
  assert.equal(at.work, copy);
  assert.equal(at.record.step, PREPARE_STEP.reduce);
  assert.deepEqual(at.record.original, {
    work,
    scaRoot: workPaths(work).sca,
  });
  assert.equal(at.record.roots.scaRoot, workPaths(copy).sca);
  assert.deepEqual(recordOf(copy), at.record);
  const original = recordOf(work);
  assert.equal(original.step, PREPARE_STEP.handed);
  assert.equal(original.rescued, copy);
  assert.deepEqual(
    original.lockAudit.devVulnerabilities.map((v) => [
      v.file,
      v.name,
      v.version,
      v.ids,
      v.severity,
    ]),
    [["package-lock.json", "lint-pebble", "0.4.0", ["GHSA-tool"], "high"]]
  );
  assert.deepEqual(original.lockAudit.vulnerabilities, []);
  assert.equal(original.unrescued, false);
  assert.ok(!fs.existsSync(workPaths(work).review));
  assert.equal(
    fs.readFileSync(path.join(workPaths(copy).sca, "package.json"), "utf8"),
    packageFile()
  );
  assert.equal(
    fs.readlinkSync(path.join(workPaths(copy).sca, "link.js")),
    "bg.js"
  );
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
  const work = workFolder({
    "package.json": packageFile(),
    "pnpm-lock.yaml": lock,
  });
  const at = await first(
    work,
    net({
      "argv-crumb@0.0.8": [
        advisory("GHSA-crumb", "CRITICAL", "argv-crumb", "0.0.10"),
      ],
    })
  );
  assert.equal(at.work, `${work}-rescued`);
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
    first(work, net(), { SCA_ROOT: "   " }),
    refused(/SCA_ROOT names no folder/)
  );
  unchanged();
  const elsewhere = path.join(path.dirname(work), "elsewhere");
  writeTree(elsewhere, { "package.json": packageFile() });
  await assert.rejects(
    first(work, net(), { SCA_ROOT: elsewhere }),
    refused(/SCA_ROOT ".+elsewhere" is not a folder inside/)
  );
  await assert.rejects(
    first(work, net(), { SCA_ROOT: path.join(sca, "nothing-here") }),
    refused(/is not a folder inside/)
  );
  // A link inside the source that leads out is the folder it leads to, and refused.
  fs.symlinkSync(elsewhere, path.join(sca, "out"));
  await assert.rejects(
    first(work, net(), { SCA_ROOT: path.join(sca, "out") }),
    refused(/is not a folder inside/)
  );
  unchanged();
  // One that leads to a folder inside it is that folder, and taken as it.
  writeTree(path.join(sca, "real"), { "package.json": packageFile() });
  fs.symlinkSync(path.join(sca, "real"), path.join(sca, "in"));
  const at = await first(work, net(), { SCA_ROOT: "in" });
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
    first(work, net(), { SCA_ROOT: sca }),
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
    first(work, net(), {}),
    refused(/SCA_EXP_SOURCE still has no "answer"/)
  );
  await assert.rejects(
    first(work, net(), { SCA_EXP_SOURCE: "../.." }),
    refused(/SCA_EXP_SOURCE "\.\.\/\.\." is not a folder inside/)
  );
  // The root itself excludes nothing, and the review refuses it - so the hand-back does.
  await assert.rejects(
    first(work, net(), { SCA_EXP_SOURCE: "." }),
    refused(/sca-exp-source/)
  );
  assert.equal(recordOf(work).step, PREPARE_STEP.extract, "nothing moved");
  const at = await first(work, net(), { SCA_EXP_SOURCE: "exp" });
  assert.equal(at.record.roots.scaExpSource, path.join(sca, "exp"));
  cleanup(work);
});

// ---- not rescued ----
// Each of these is done at once, and its review decides the rest.

test("a vulnerable library committed to the archive is not rescued", async () => {
  const work = workFolder({
    "package.json": packageFile(null),
    "package-lock.json": npmLock(null),
    "vendor/bootstrap.min.css": fs.readFileSync(
      path.join(
        ROOT,
        "tests/addons/sca-undeclared-library/src/vendor/bootstrap/bootstrap.min.css"
      )
    ),
  });
  const at = await first(
    work,
    net({
      "bootstrap@5.3.0": [advisory("GHSA-css", "HIGH", "bootstrap", "5.3.1")],
    })
  );
  assert.equal(at.work, work);
  assert.equal(at.record.step, PREPARE_STEP.done);
  cleanup(work);
});

// The preparation looks at the lock and nothing else: a review that will stop for another
// reason as well is rescued all the same, and stops on that reason after.
test("a vulnerable lock beside another reason to stop is rescued", async () => {
  const work = workFolder({
    "package.json": packageFile(),
    "package-lock.json": npmLock(),
    ".npmrc": "registry=https://registry.example.invalid/\n",
  });
  const at = await first(work, net(TOOL_HIGH));
  assert.equal(at.work, `${work}-rescued`);
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
  const at = await first(work, noNet);
  assert.equal(at.next, "review");
  assert.equal(at.work, work);
  assert.equal(at.record.step, PREPARE_STEP.done);
  assert.ok(!fs.existsSync(`${work}-rescued`), "no copy is made");
  cleanup(work);
});

test("a source the audit cannot read in full is not rescued", async (t) => {
  await t.test("no lock at all", async () => {
    const work = workFolder({ "package.json": packageFile() });
    const at = await first(work, net(TOOL_HIGH));
    assert.equal(at.work, work);
    assert.equal(at.record.step, PREPARE_STEP.done);
    cleanup(work);
  });
  await t.test("the lock scan abandoned", async () => {
    // The batch endpoint does not answer: the declared tool's advisory would be rescued,
    // but the tree is unread.
    const work = workFolder({
      "package.json": packageFile(),
      "package-lock.json": npmLock(),
    });
    const at = await first(work, net(TOOL_HIGH, { batch: false }));
    assert.equal(at.work, work);
    assert.equal(at.record.step, PREPARE_STEP.done);
    cleanup(work);
  });
  await t.test("a file the loader cannot read", async () => {
    const work = workFolder({
      "package.json": packageFile(),
      "package-lock.json": npmLock(),
      "secret.js": "",
    });
    fs.chmodSync(path.join(workPaths(work).sca, "secret.js"), 0);
    const at = await first(work, net(TOOL_HIGH));
    assert.equal(at.work, work);
    assert.equal(at.record.step, PREPARE_STEP.done);
    cleanup(work);
  });
});

// ---- the rescued copy's steps ----

/** A work folder rescued for the build tool's advisory: the copy, at `reduce`. */
async function rescued() {
  const work = workFolder({
    "package.json": packageFile(),
    "package-lock.json": npmLock(),
  });
  const at = await first(work, net(TOOL_HIGH));
  return { work, copy: at.work, root: at.record.roots.scaRoot };
}

test("a reduce that leaves the copy clean hands the review the copy", async () => {
  const { work, copy, root } = await rescued();
  writeTree(root, {
    "package.json": packageFile(null),
    "package-lock.json": npmLock(null),
  });
  const at = await later(copy, net(TOOL_HIGH));
  assert.equal(at.next, "review");
  assert.equal(at.work, copy);
  assert.equal(at.record.step, PREPARE_STEP.done);
  assert.equal(recordOf(work).step, PREPARE_STEP.handed);
  cleanup(work);
});

// The preparation is one run with its review: OSV is asked through the run's cache in the
// original's work folder, which the copy shares. A step over a lock the original already
// had audited asks OSV nothing.
test("a rescued copy reads the run's OSV cache", async () => {
  const { work, copy } = await rescued();
  assert.ok(fs.existsSync(path.join(work, ".cache", "osv.json")));
  const reduce = await later(copy, noNet);
  assert.equal(reduce.record.step, PREPARE_STEP.fix);
  assert.ok(!fs.existsSync(path.join(copy, ".cache")), "no cache of its own");
  cleanup(work);
});

test("a reduce that is not enough moves on to fix, and a clean fix is done", async () => {
  const { work, copy, root } = await rescued();
  const reduce = await later(copy, net(TOOL_HIGH));
  assert.equal(reduce.next, "step");
  assert.equal(reduce.work, copy);
  assert.equal(reduce.record.step, PREPARE_STEP.fix);
  writeTree(root, {
    "package.json": packageFile("0.4.1"),
    "package-lock.json": npmLock("0.4.1"),
  });
  const fix = await later(copy, net(TOOL_HIGH));
  assert.equal(fix.work, copy);
  assert.equal(fix.record.step, PREPARE_STEP.done);
  cleanup(work);
});

// The way out: an agent that could not do either step runs on without changing anything.
// The copy is deleted, and the original is done, marked unrescued: its review takes the lock
// audit it recorded, and is decided by it. The preparation writes no report of its own.
test("a fix that is not enough deletes the copy, and the original is reviewed unrescued", async () => {
  const { work, copy } = await rescued();
  await later(copy, net(TOOL_HIGH));
  const at = await later(copy, net(TOOL_HIGH));
  assert.equal(at.next, "review");
  assert.equal(at.work, work);
  assert.equal(at.record.step, PREPARE_STEP.done);
  assert.equal(at.record.unrescued, true);
  assert.equal(at.record.rescued, copy);
  assert.equal(at.record.lockAudit.devVulnerabilities.length, 1);
  assert.deepEqual(recordOf(work), at.record);
  assert.ok(!fs.existsSync(copy), "the copy is deleted");
  assert.ok(!fs.existsSync(workPaths(work).report), "no report of its own");
  // Handed back again, its review is handed out once more, asking nothing.
  const again = await later(work, noNet);
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
      const { work, copy, root } = await rescued();
      edit(root);
      assert.equal(
        (await later(copy, net())).record.step,
        PREPARE_STEP.fix,
        name
      );
      cleanup(work);
    });
  }
  await t.test("its tree never read", async () => {
    const { work, copy, root } = await rescued();
    writeTree(root, {
      "package.json": packageFile(null),
      "package-lock.json": npmLock(null, {
        "node_modules/argv-crumb": { version: "0.0.8", dev: true },
      }),
    });
    assert.equal(
      (await later(copy, net({}, { batch: false }))).record.step,
      PREPARE_STEP.fix
    );
    cleanup(work);
  });
});

// ---- order, and runs cut short ----

// A run cut short after the copy was made can lose the prompt that named the copy, so the
// original handed back again prints it again. Once the copy is done, its own hand-back
// carries the review, and the original only points at it.
test("an original handed back again points at its copy", async () => {
  const { work, copy, root } = await rescued();
  const again = await later(work, noNet);
  assert.equal(again.next, "step");
  assert.equal(again.work, copy);
  assert.equal(again.record.step, PREPARE_STEP.reduce);
  writeTree(root, {
    "package.json": packageFile(null),
    "package-lock.json": npmLock(null),
  });
  await later(copy, net());
  await assert.rejects(
    later(work, noNet),
    refused(/handed its source to ".+-rescued"/)
  );
  cleanup(work);
});

// A finished preparation is not audited again: its review is handed out once more, for the
// hand-back to start again, and the review file the review claims is deleted again, in case
// the run that marked it was cut short before it could.
test("a done folder handed back again hands out its review again", async () => {
  const work = workFolder({
    "package.json": packageFile(),
    "package-lock.json": npmLock(),
  });
  const done = await first(work, net());
  fs.writeFileSync(workPaths(work).review, "{}");
  const again = await later(work, noNet);
  assert.equal(again.next, "review");
  assert.deepEqual(again.record, done.record);
  assert.ok(!fs.existsSync(workPaths(work).review));
  cleanup(work);
});

// A give-up cut short after the original was marked unrescued leaves the copy behind; a
// hand-back of the copy finishes removing it and closes the preparation.
test("a copy left behind by a give-up cut short is removed", async (t) => {
  /** A give-up cut short after the original was marked, before the copy was deleted. */
  const cutShort = async () => {
    const { work, copy } = await rescued();
    await later(copy, net(TOOL_HIGH));
    writePrepare(work, {
      ...recordOf(work),
      step: PREPARE_STEP.done,
      unrescued: true,
    });
    return { work, copy };
  };
  await t.test("by a hand-back of the copy", async () => {
    const { work, copy } = await cutShort();
    const at = await later(copy, noNet);
    assert.equal(at.next, "review");
    assert.equal(at.work, work);
    assert.ok(!fs.existsSync(copy));
    cleanup(work);
  });
  await t.test("by a hand-back of the original", async () => {
    const { work, copy } = await cutShort();
    const at = await later(work, noNet);
    assert.equal(at.next, "review");
    assert.equal(at.work, work);
    assert.ok(!fs.existsSync(copy));
    cleanup(work);
  });
});

// The agent can write any file, records included, so no record alone decides what is
// deleted: only a copy at the path computed from its original, which names it back.
test("a forged record never removes a folder", async () => {
  const { work, copy } = await rescued();
  // A folder that is not at the computed path, claiming the original.
  const stray = path.join(path.dirname(work), "stray");
  fs.mkdirSync(stray);
  writePrepare(stray, {
    ...recordOf(copy),
    step: PREPARE_STEP.fix,
  });
  await assert.rejects(
    later(stray, noNet),
    refused(/is not a copy this preparation made/)
  );
  assert.ok(fs.existsSync(stray));
  // The original rewritten to name the stray folder as its copy, at every step that could
  // delete one.
  for (const step of [PREPARE_STEP.handed, PREPARE_STEP.done]) {
    writePrepare(work, {
      ...recordOf(work),
      step,
      rescued: stray,
      unrescued: step === PREPARE_STEP.done,
    });
    if (step === PREPARE_STEP.handed) {
      await assert.rejects(later(work, noNet), refused(/handed its source/));
    } else {
      await later(work, noNet);
    }
    assert.ok(fs.existsSync(stray), step);
  }
  // The copy at the computed path, handed back while the original no longer names it.
  await assert.rejects(
    later(copy, net(TOOL_HIGH)),
    refused(/does not name ".+-rescued" as its rescue/)
  );
  assert.ok(fs.existsSync(copy));
  cleanup(work);
});

// The record is the linter's alone: every write leaves it read-only, the plainest signal that
// it is out of the agent's reach - the original's and the copy's, at every step.
test("every record the preparation writes is read-only", async () => {
  const mode = (folder) => fs.statSync(workPaths(folder).prepare).mode & 0o777;
  const work = workFolder({
    "package.json": packageFile(),
    "package-lock.json": npmLock(),
  });
  assert.equal(mode(work), 0o444, "as the preparation starts");
  const copy = (await first(work, net(TOOL_HIGH))).work;
  assert.equal(mode(work), 0o444, "handed");
  assert.equal(mode(copy), 0o444, "the copy");
  await later(copy, net(TOOL_HIGH));
  assert.equal(mode(copy), 0o444, "the copy at fix");
  await later(copy, net(TOOL_HIGH));
  assert.equal(mode(work), 0o444, "given up");
  cleanup(work);
});

// Every write stores a hash over the record, so a change made after it - even a plausible
// one, like a release in the recorded lock audit - is caught on the next read, and refused.
test("a record changed after the linter wrote it is refused", async () => {
  const { work } = await rescued();
  const file = workPaths(work).prepare;
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.lockAudit.devVulnerabilities[0].version = "0.4.1";
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, JSON.stringify(record, null, 1));
  await assert.rejects(
    later(work, noNet),
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
  await assert.rejects(later(work, noNet), /written by another version/);
  cleanup(work);
});

// A boolean in the record is true or false, as the linter writes it. Anything else was put
// there by an edit, and the hand-back is refused rather than reading a meaning into it.
test("a record boolean that is neither true nor false is refused", async () => {
  const { work } = await rescued();
  writePrepare(work, { ...recordOf(work), unrescued: "yes" });
  await assert.rejects(
    later(work, noNet),
    refused(/holds unrescued as neither true nor false/)
  );
  cleanup(work);
});

// A rescued copy that cannot be made ends the run, before any prompt names it: a retry is a
// new preparation, with a new work folder and so a new copy name. Whatever stood in the way is
// left as it is, and the original stays at its first step, with nothing recorded.
test("a rescued copy that cannot be made ends the preparation", async (t) => {
  const files = {
    "package.json": packageFile(),
    "package-lock.json": npmLock(),
  };
  const cannotCopy = async (work) => {
    await assert.rejects(first(work, net(TOOL_HIGH)), (err) => {
      assert.ok(!(err instanceof HandbackRefused), err.message);
      assert.match(
        err.message,
        /^The rescued copy ".+-rescued" could not be made \(\w+\)\. Start the preparation again with --llm-sca-review\.$/
      );
      return true;
    });
    const original = recordOf(work);
    assert.equal(original.step, PREPARE_STEP.extract);
    assert.equal(original.lockAudit, null);
    assert.equal(original.rescued, null);
  };
  await t.test("a folder of someone else's at its path", async () => {
    const work = workFolder(files);
    const copy = `${work}-rescued`;
    fs.mkdirSync(copy);
    fs.writeFileSync(path.join(copy, "notes.txt"), "mine");
    await cannotCopy(work);
    assert.deepEqual(fs.readdirSync(copy), ["notes.txt"]);
    cleanup(work);
  });
  await t.test("a copy of this folder left at its path", async () => {
    const work = workFolder(files);
    const copy = `${work}-rescued`;
    fs.mkdirSync(copy);
    writePrepare(copy, {
      ...recordOf(work),
      step: PREPARE_STEP.reduce,
      original: { work, scaRoot: workPaths(work).sca },
    });
    await cannotCopy(work);
    assert.equal(recordOf(copy).step, PREPARE_STEP.reduce);
    cleanup(work);
  });
  await t.test("a folder that cannot be created", async (t) => {
    if (process.getuid?.() === 0) {
      t.skip("root writes any folder");
      return;
    }
    const work = workFolder(files);
    const parent = path.dirname(work);
    fs.chmodSync(parent, 0o555);
    try {
      await cannotCopy(work);
    } finally {
      fs.chmodSync(parent, 0o755);
    }
    cleanup(work);
  });
});

// Every path a record holds is read by a later run, from any directory, so each is written
// absolute - and a record about to hold a relative one is refused at the write, naming it.
test("a record holding a relative path is never written", async () => {
  const { work, copy } = await rescued();
  const record = recordOf(copy);
  const relative = {
    "submission.xpi": {
      submission: { ...record.submission, xpi: "addon.xpi" },
    },
    "roots.scaRoot": { roots: { ...record.roots, scaRoot: "sca" } },
    "roots.scaExpSource": { roots: { ...record.roots, scaExpSource: "exp" } },
    "original.work": { original: { ...record.original, work: "work" } },
    "original.scaRoot": { original: { ...record.original, scaRoot: "sca" } },
    rescued: { rescued: "work-rescued" },
    "flags.cache-schema-dir": { flags: { "cache-schema-dir": "cache" } },
  };
  for (const [field, over] of Object.entries(relative)) {
    assert.throws(
      () => writePrepare(copy, { ...record, ...over }),
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
