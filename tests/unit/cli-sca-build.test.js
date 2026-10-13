// CLI-contract tests of the build, the permission question and the rescue, and of the details
// block each prompt prints.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  advisory,
  answer,
  auditCache,
  buildInto,
  realPreparation,
  writeBuildReport,
} from "../prepared.js";
import { workPaths } from "../../src/util/dest.js";
import { loopSlots } from "../../src/report/loop.js";
import { loadRegistry } from "../../src/checks/registry.js";
import {
  ROOT,
  CACHE,
  CDN_CACHE,
  OFFLINE_FLAGS,
  headerValue,
  run,
  sweepBack,
  submissionFolder,
  NO_LOCK_SOURCE,
  commandOf,
  workOf,
  readJson,
  handBackRoots,
  argvOf,
  unwrapped,
} from "../cli-run.js";

/**
 * The sca-unrescued fixture's source, prepared through the CLI up to the prompt that follows
 * the reviewer's permission, its lock audited from a run cache folder seeded with `vulns`
 * (named as --cache-work-dir, which the record hands to every step).
 * @param {Record<string, object[]>} vulns
 * @returns {{work: string, stdout: string, dir: string}}  The prompt that run printed.
 */
function permittedPrompt(vulns) {
  const fixture = path.join(ROOT, "tests", "addons", "sca-unrescued");
  const dir = submissionFolder();
  const r = run([
    dir,
    "--llm-sca-review",
    ...OFFLINE_FLAGS,
    "--cache-work-dir",
    auditCache(vulns),
  ]);
  assert.equal(r.code, 0, r.stderr);
  const work = workOf(r.stdout);
  const sca = headerValue(r.stdout, "EXTRACT_TO");
  fs.cpSync(path.join(fixture, "src"), sca, { recursive: true });
  answer(work, { SCA_ROOT: sca });
  writeBuildReport(work);
  const permission = run(argvOf(commandOf(r.stdout)));
  assert.equal(permission.code, 0, permission.stdout + permission.stderr);
  assert.equal(readJson(work, "prepare").step, "permission");
  answer(work, {});
  const next = run(argvOf(commandOf(permission.stdout)));
  assert.equal(next.code, 0, next.stdout + next.stderr);
  assert.ok(next.stdout.includes("── SCA Review Prompt ──"), next.stdout);
  assert.equal(headerValue(next.stdout, "ANSWERS"), workPaths(work).review);
  assert.equal(
    headerValue(next.stdout, "BUILD_PROCESS"),
    workPaths(work).build
  );
  assert.deepEqual(commandOf(next.stdout), [`--llm-handback ${work}`]);
  return { work, stdout: next.stdout, dir };
}

/** What the build and rescue prompts say of the agent's comparison of its output with the
 *  submitted XPI, which it answers as BUILD_MATCH. */
const COMPARED = [
  "compare it with SUBMITTED_XPI, given above: it holds the same files at the same paths, each with the same contents, where only line endings may differ.",
  'Answer its entry whose "index" is BUILD_MATCH with the "label" of one of its "answers", and with nothing else',
  "`match` means exactly the comparison above holds, and nothing less.",
  "Write no notes and no list of differences",
];

/** The fixture's lock releases, none with an advisory. */
const FIXTURE_CLEAN = {
  "lint-pebble@0.4.0": [],
  "argv-crumb@0.0.8": [],
  "tidy-lantern@2.1.0": [],
  "wick-trim@1.0.1": [],
};

// A source rescued clean: its review reads the rescued copy, named as such, beside the same
// root in the source archive, and the root in the build copy the agent built in.
test("a rescued review names both roots and the build root", async () => {
  const fixture = path.join(ROOT, "tests", "addons", "sca-unrescued");
  const own = { name: "lantern-sorter", version: "1.0.0" };
  const { work, record } = await realPreparation({
    source: path.join(fixture, "src"),
    xpi: path.join(fixture, "xpi"),
    flags: {
      "cache-schema-dir": CACHE,
      "cache-hash-db-dir": CACHE,
      "cache-experiments-dir": CACHE,
      "cache-cdn-lookup-dir": CDN_CACHE,
      "cache-npm-registry-dir": CACHE,
    },
    cache: auditCache({
      "lint-pebble@0.4.0": [
        advisory("GHSA-fixture-pebble", "CRITICAL", "lint-pebble", "0.4.1"),
      ],
      "argv-crumb@0.0.8": [],
      "tidy-lantern@2.1.0": [],
      "wick-trim@1.0.1": [],
    }),
    rescue: (root) => {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(own));
      fs.writeFileSync(
        path.join(root, "package-lock.json"),
        JSON.stringify({ ...own, lockfileVersion: 3, packages: { "": own } })
      );
    },
  });
  const { sca, rescued, buildCopy } = workPaths(work);
  assert.equal(record.roots.scaRoot, rescued);
  const r = run(["--llm-handback", work]);
  assert.notEqual(r.code, 2, r.stdout + r.stderr);
  const state = readJson(work, "state");
  assert.equal(state.paths.scaRoot, rescued);
  assert.equal(state.paths.scaRootOrig, sca);
  assert.equal(state.build.root, buildCopy);
  const rows = [
    `* SCA_ROOT: [rescued source (reduced/fixed dependencies)](${rescued})`,
    `* SCA_ROOT_ORIG: [source archive](${sca})`,
    `* BUILD_ROOT: [build copy](${buildCopy})`,
  ];
  const details = loopSlots(state, {}, work, loadRegistry()).buildDetails;
  for (const row of rows) {
    assert.ok(details.includes(row), `${row}\n${details}`);
  }
});

/** Every row a details block can hold, in the blocks' order. */
const DETAIL_ROWS = [
  "XPI_FILE",
  "XPI_ROOT",
  "SCA_ROOT",
  "SCA_ROOT_ORIG",
  "SCA_EXP_SOURCE",
  "ADDON_DESCRIPTION",
  "BUILD_PROCESS",
  "BUILD_SAFETY",
  "BUILD_VULNERABILITIES",
  "BUILD_RESULT",
  "BUILD_ROOT",
  "BUILD_OUTPUT",
  "BUILD_MATCH",
  "REVIEW_REPORT",
];

/** The details rows a prompt printed, as they read with their indent taken off. */
const detailRowsOf = (stdout) =>
  stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => DETAIL_ROWS.some((name) => l.startsWith(`* ${name}: `)));

/** The answer a test reviewer and agent give an entry of a review's phase. */
const WALK_ANSWERS = {
  built: "Builds and reproduces",
  verify: "reported",
  settle: "cleared",
  ask: "Clear",
};

// One review walked from the preparation's permission prompt to its close: each details
// block holds every row of the block before it, the submitted XPI is XPI_FILE, a link, in
// every one of them, and the Final Review Details still hold the build.
test("each details block holds every row of the block before it", () => {
  const fixture = path.join(ROOT, "tests", "addons", "sca-unrescued");
  const dir = submissionFolder();
  const first = run([
    dir,
    "--llm-sca-review",
    ...OFFLINE_FLAGS,
    "--cache-work-dir",
    auditCache({ "lint-pebble@0.4.0": [] }),
  ]);
  assert.equal(first.code, 0, first.stderr);
  const work = workOf(first.stdout);
  const sca = headerValue(first.stdout, "EXTRACT_TO");
  fs.cpSync(path.join(fixture, "src"), sca, { recursive: true });
  const own = { name: "lantern-sorter", version: "1.0.0" };
  fs.writeFileSync(path.join(sca, "package.json"), JSON.stringify(own));
  fs.writeFileSync(
    path.join(sca, "package-lock.json"),
    JSON.stringify({
      ...own,
      lockfileVersion: 3,
      packages: { "": own, "node_modules/lint-pebble": { version: "0.4.0" } },
    })
  );
  answer(work, { SCA_ROOT: sca });
  writeBuildReport(work);
  const permission = run(argvOf(commandOf(first.stdout)));
  assert.equal(permission.code, 0, permission.stdout + permission.stderr);
  answer(work, {});
  const build = run(argvOf(commandOf(permission.stdout)));
  assert.equal(build.code, 0, build.stdout + build.stderr);
  const xpi = readJson(work, "prepare").submission.xpi;
  answer(work, {
    BUILD_OUTPUT: buildInto(workPaths(work).buildCopy),
    BUILD_MATCH: "match",
  });
  let out = run(argvOf(commandOf(build.stdout)));
  const blocks = [["permission", detailRowsOf(permission.stdout)]];
  // Every pass up to the closing one is answered and handed back.
  for (let pass = 0; pass < 10; pass++) {
    assert.ok(out.code === 0 || out.code === 1, out.stdout + out.stderr);
    const { phase } = readJson(work, "state");
    if (phase === "built" || phase === "ask") {
      blocks.push([phase, detailRowsOf(out.stdout)]);
    }
    if (phase === "close") {
      blocks.push([phase, detailRowsOf(out.stdout)]);
      break;
    }
    sweepBack(workPaths(work).review);
    const doc = JSON.parse(fs.readFileSync(workPaths(work).review, "utf8"));
    doc.entries = doc.entries.map((e) => ({
      ...e,
      answer: WALK_ANSWERS[phase],
    }));
    fs.writeFileSync(workPaths(work).review, JSON.stringify(doc, null, 1));
    out = run(["--llm-handback", work]);
  }
  assert.deepEqual(
    blocks.map(([name]) => name),
    ["permission", "built", "ask", "close"]
  );
  const named = `* XPI_FILE: [${path.basename(xpi)}](${xpi})`;
  for (const [i, [name, rows]] of blocks.entries()) {
    assert.equal(rows[0], named, `${name}: XPI_FILE, a link, first`);
    assert.ok(
      !rows.some((row) => row.includes("SUBMITTED_XPI")),
      `${name}: no SUBMITTED_XPI`
    );
    if (i > 0) {
      for (const row of blocks[i - 1][1]) {
        assert.ok(rows.includes(row), `${name} misses ${row}`);
      }
    }
  }
  // The build block goes out before the description agent and the report.
  assert.ok(
    !blocks[1][1].some((row) =>
      ["* ADDON_DESCRIPTION: ", "* REVIEW_REPORT: "].some((n) =>
        row.startsWith(n)
      )
    ),
    blocks[1][1].join("\n")
  );
  const final = blocks.at(-1)[1];
  for (const row of [
    "* BUILD_SAFETY: safe",
    "* BUILD_RESULT: built by the agent",
    "* BUILD_MATCH: match",
  ]) {
    assert.ok(final.includes(row), `close misses ${row}\n${final.join("\n")}`);
  }
  for (const name of ["BUILD_VULNERABILITIES", "BUILD_ROOT", "BUILD_OUTPUT"]) {
    assert.ok(
      final.some((row) => row.startsWith(`* ${name}: `)),
      `close misses ${name}`
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// A clean lock is built: the prompt after the permission names the source root, its place in
// the build copy the linter made to build it in, the build report and the submitted XPI, and
// asks for the build's final artifact and its comparison with that XPI. The agent copies
// nothing.
test("the hand-back prints a clean source's build", () => {
  const { work, stdout, dir } = permittedPrompt(FIXTURE_CLEAN);
  assert.equal(readJson(work, "prepare").step, "build");
  assert.equal(headerValue(stdout, "SCA_ROOT"), path.join(work, "sca"));
  assert.equal(headerValue(stdout, "BUILD_ROOT"), workPaths(work).buildCopy);
  assert.equal(headerValue(stdout, "BUILD_COPY"), undefined);
  assert.equal(headerValue(stdout, "RESCUE_ROOT"), undefined);
  assert.ok(
    fs.existsSync(path.join(workPaths(work).buildCopy, "package.json"))
  );
  assert.equal(
    headerValue(stdout, "SUBMITTED_XPI"),
    readJson(work, "prepare").submission.xpi
  );
  assert.ok(!unwrapped(stdout).includes("Copy SCA_ROOT"));
  for (const said of [
    "Build in BUILD_ROOT, and only there",
    "Write it as an absolute path.",
    '"Build attempt"',
    ...COMPARED,
    'Where the build failed, leave its "answer" null.',
  ]) {
    assert.ok(unwrapped(stdout).includes(said), said);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// A vulnerable lock is rescued: the prompt after the permission names the copy and the build
// report, and hands the agent the whole loop - lock-only commands, an audit before any
// build, and the build of a clean lock.
test("the hand-back prints a vulnerable source's rescue", () => {
  const { work, stdout, dir } = permittedPrompt({
    ...FIXTURE_CLEAN,
    "lint-pebble@0.4.0": [
      advisory("GHSA-fixture-pebble", "CRITICAL", "lint-pebble", "0.4.1"),
    ],
  });
  assert.equal(readJson(work, "prepare").step, "rescue");
  assert.equal(headerValue(stdout, "RESCUE_ROOT"), path.join(work, "rescued"));
  assert.equal(headerValue(stdout, "BUILD_ROOT"), workPaths(work).buildCopy);
  assert.equal(headerValue(stdout, "BUILD_COPY"), undefined);
  assert.equal(
    headerValue(stdout, "SUBMITTED_XPI"),
    readJson(work, "prepare").submission.xpi
  );
  // The agent replaces build/ with a copy of the whole rescued/ before each build, with
  // exactly these two commands, printed as they are run.
  const commands = [
    `rm -rf ${workPaths(work).buildCopy}`,
    `cp -a ${workPaths(work).rescued} ${workPaths(work).buildCopy}`,
  ];
  const lines = stdout.split("\n").map((l) => l.trim());
  const at = lines.indexOf(commands[0]);
  assert.ok(at > 0, stdout);
  assert.equal(lines[at + 1], commands[1]);
  for (const said of [
    "Never install or build anything in RESCUE_ROOT",
    "Then build in BUILD_ROOT, and only there.",
    "npm install --package-lock-only --ignore-scripts",
    "npm audit fix --package-lock-only --ignore-scripts",
    "build NOTHING",
    "`npm ci`",
    "husky",
    '"label" of its one answer',
    ...COMPARED,
    'Where the rescue failed, leave its "answer" null.',
  ]) {
    assert.ok(unwrapped(stdout).includes(said), said);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// A safe build is shown to the reviewer before they are asked: the permission prompt names
// the review file and shows the Build Review Details - the source root, the build report
// and the judgement - as a block that ends the turn with the waiting line, and then puts
// the question. Its hand-back carries the preparation on.
test("a safe build prints the Build Review Details and the permission question", () => {
  const dir = submissionFolder();
  const r = run([dir, "--llm-sca-review", ...OFFLINE_FLAGS]);
  assert.equal(r.code, 0, r.stderr);
  const work = workOf(r.stdout);
  const sca = headerValue(r.stdout, "EXTRACT_TO");
  fs.cpSync(NO_LOCK_SOURCE, sca, { recursive: true });
  answer(work, { SCA_ROOT: sca });
  writeBuildReport(work);
  const asked = run(argvOf(commandOf(r.stdout)));
  assert.equal(asked.code, 0, asked.stdout + asked.stderr);
  assert.equal(readJson(work, "prepare").step, "permission");
  assert.match(asked.stdout, /── SCA Review Prompt ──/);
  assert.equal(headerValue(asked.stdout, "ANSWERS"), workPaths(work).review);
  const block = [
    `* SCA_ROOT: [source archive](${path.join(work, "sca")})`,
    `* BUILD_PROCESS: [build.md](${workPaths(work).build})`,
    "* BUILD_SAFETY: safe",
    "",
    'Reply "next" to continue the review with the question whether the agent may ' +
      "build the add-on.",
  ]
    .map((line) => (line ? `   ${line}` : ""))
    .join("\n");
  assert.ok(asked.stdout.includes(block), asked.stdout);
  assert.ok(
    asked.stdout.indexOf(block) < asked.stdout.indexOf("PACKAGE_MANAGERS"),
    "the block comes before the question"
  );
  assert.deepEqual(commandOf(asked.stdout), [`--llm-handback ${work}`]);
  answer(work, {});
  const started = run(argvOf(commandOf(asked.stdout)));
  assert.notEqual(started.code, 2, started.stdout + started.stderr);
  assert.equal(readJson(work, "prepare").packageManagers, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The agent-builds test switch answers the permission question up front: the start run
// records it, the safe build goes straight on to the audit, and the review starts with no
// question put. The hand-back runs without the switch, so the record decides.
test("WEBEXT_LINTER_AGENT_BUILDS=1 skips the permission question", () => {
  const dir = submissionFolder();
  const r = run([dir, "--llm-sca-review", ...OFFLINE_FLAGS], {
    WEBEXT_LINTER_AGENT_BUILDS: "1",
  });
  assert.equal(r.code, 0, r.stderr);
  const work = workOf(r.stdout);
  assert.equal(readJson(work, "prepare").agentBuilds, true);
  assert.ok(!("llm-agent-builds" in readJson(work, "prepare").flags));
  const handed = handBackRoots(r.stdout);
  assert.notEqual(handed.code, 2, handed.stdout + handed.stderr);
  assert.doesNotMatch(handed.stdout, /SCA Review Prompt/);
  const record = readJson(work, "prepare");
  assert.equal(record.step, "done");
  assert.equal(record.buildSafety, "safe");
  assert.equal(record.packageManagers, true);
  // The review starts with the recorded judgement, and build.md as its product.
  const state = readJson(work, "state");
  assert.deepEqual(state.values, { "build-safety": "safe" });
  assert.deepEqual(state.products, ["build"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The permission question is answered up front only by the test switch: no option does it.
test("--llm-agent-builds is an unknown option", () => {
  const dir = submissionFolder();
  const r = run([
    dir,
    "--llm-sca-review",
    "--llm-agent-builds",
    ...OFFLINE_FLAGS,
  ]);
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.stderr, /Unknown option '--llm-agent-builds'/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// An unsafe build ends the preparation: the review starts at once, with the judgement the
// preparation recorded and its build report, and the agent builds nothing.
test("an unsafe build starts the review with its judgement", () => {
  const dir = submissionFolder();
  const r = run([dir, "--llm-sca-review", ...OFFLINE_FLAGS]);
  assert.equal(r.code, 0, r.stderr);
  const work = workOf(r.stdout);
  const handed = handBackRoots(r.stdout, { safety: "unsafe" });
  assert.notEqual(handed.code, 2, handed.stdout + handed.stderr);
  assert.match(handed.stdout, /── LLM Prompt ──/);
  const record = readJson(work, "prepare");
  assert.equal(record.buildSafety, "unsafe");
  assert.equal(record.packageManagers, false);
  const state = readJson(work, "state");
  assert.deepEqual(state.values, { "build-safety": "unsafe" });
  assert.deepEqual(state.products, ["build"]);
  assert.equal(state.build.result, null);
  fs.rmSync(dir, { recursive: true, force: true });
});
