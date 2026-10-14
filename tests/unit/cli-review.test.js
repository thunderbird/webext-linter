// CLI-contract tests of a plain review and the --llm-review loop: what goes to stdout and
// stderr, the exit code, and the flags that change a pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ROOT,
  REVIEW,
  OFFLINE_FLAGS,
  reviewFile,
  entriesOf,
  run,
  workOfReviewFile,
  sweepBack,
} from "../cli-run.js";

// A real review renders a report to stdout and sets the exit code by severity
// (0 = clean, 1 = has error-severity findings).
test("reviewing a fixture renders to stdout with a severity-based exit", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const r = run([addon, ...OFFLINE_FLAGS, "--report-format", "json"]);
  assert.ok([0, 1].includes(r.code));
  const json = JSON.parse(r.stdout);
  assert.equal(json.meta.action, "review");
  assert.ok(Array.isArray(json.findings));
});

// A source code review's own steps send a sub-agent to paths, and those paths are what the
// review RESOLVED to be, never what the flags asked for: the root a review settles on can
// sit below the one --sca-root named, so a step reading the flag would send an agent to a
// root nothing had read. Driven through the CLI because that is the seam: rendering from a
// hand-built meta cannot catch a pipeline that feeds its two halves different values.
//
// Keyed on the paths themselves, because a path is all a step gives out: a sub-agent is
// handed the request and nothing else, so nothing in one stands for a path by name.
test("a source code review's steps carry the paths the review resolved to", () => {
  // A source review nothing aborts, so its first prompt is the build opening, which takes
  // both paths.
  const sca = path.join(ROOT, "tests", "addons", "sca-transpiled-kept");
  const r = run([
    path.join(sca, "xpi"),
    ...OFFLINE_FLAGS,
    "--sca-root",
    path.join(sca, "src"),
    "--llm-review",
  ]);
  // Each sits on its own line inside the step that hands it over, unwrapped and unaltered,
  // so the agent can copy it whole.
  const lines = r.stdout.split("\n").map((l) => l.trim());
  assert.ok(
    lines.includes(path.join(sca, "src")),
    "the step names the source root"
  );
  assert.ok(
    lines.some((l) => /\/build\.md$/.test(l)),
    "and where the build report goes"
  );

  // A rejected Experiment submitted WITH --sca-root is the source review it was asked to be:
  // it needs --sca-exp-source like any Experiment reviewed with source, and with it the review
  // starts and is aborted at its first check - so its first prompt is the close, and no build
  // report is asked for.
  const exp = path.join(ROOT, "tests", "addons", "experiment-disallowed-sca");
  const asked = [
    path.join(exp, "xpi"),
    ...OFFLINE_FLAGS,
    "--sca-root",
    path.join(exp, "src"),
    "--llm-review",
  ];
  const refused = run(asked);
  assert.equal(refused.code, 2, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /--sca-exp-source/);
  const rejected = run([
    ...asked,
    "--sca-exp-source",
    path.join(exp, "src", "experiment"),
  ]);
  assert.equal(rejected.code, 1, rejected.stderr);
  assert.match(rejected.stdout, /── LLM Prompt ──/);
  assert.doesNotMatch(rejected.stdout, /SCA_BUILD_PROCESS/);
  assert.ok(
    !rejected.stdout.split("\n").some((l) => /\/build\.md$/.test(l.trim())),
    "no build report is asked for"
  );
});

// --llm-review end to end. Its whole output is the prompt, the Review Details section and
// an item file: the prose report is deliberately absent, because its reader settles the
// items it can address rather than the report it can see. JSON is refused - that is the
// machine contract for ATN, which wants neither half of this.
test("--llm-review prints a prompt and writes the item file, not the report", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const on = run([addon, ...OFFLINE_FLAGS, "--llm-review"]);
  const lines = on.stdout.split("\n");
  const intro = lines.findIndex((l) =>
    l.startsWith("This review runs in passes")
  );
  assert.ok(intro > -1, "the loop's preamble is printed");
  // The prompt is the WHOLE output: no header block beside it, because every value a step
  // uses is printed by that step, and no Summary, because the tally is about to change.
  assert.doesNotMatch(on.stdout, /── Review Details ──/, "no header block");
  assert.doesNotMatch(on.stdout, /── Summary ──/, "no tally");
  // The first pass is the SPAWN phase, and it says nothing about the questions: a later
  // pass asks those, and the agent only ever sees what the pass in front of it needs.
  assert.ok(
    !entriesOf(on.stdout).some((e) => "answers" in e),
    "the questions are a later pass"
  );
  assert.match(on.stdout, /\/review\.json/, "the file to hand back is named");
  assert.match(
    on.stdout,
    /--llm-handback/,
    "and the command that hands it back"
  );
  // The description is a file the reader writes and the reviewer opens: this run names
  // the path, and never reads what lands there.
  assert.match(on.stdout, /^\s*\S+\/summary\.md$/m);
  assert.ok(
    !on.stdout.includes('"Report"'),
    "the answers are not prose in the prompt"
  );
  // The review itself is in the file, so none of it is printed.
  assert.ok(!on.stdout.includes("── Found Issues ──"), "no prose report");
  assert.ok(!on.stdout.includes("── Setup ──"), "no feed");

  // The spawn pass asks for nothing in this file: its work is starting the agents, and
  // each of those answers in a file of its own.
  assert.deepEqual(entriesOf(on.stdout), []);
  // The sweep request is printed INLINE in the step that spawns its agent: the tree to
  // read and every sweep under its label. No request file is named, and the answers file
  // is named for the orchestrating agent to write the reply to, and is not there yet.
  assert.doesNotMatch(on.stdout, /sweep-xpi\.yaml/, "no request file");
  assert.match(on.stdout, /Sweep this folder, and read nothing outside it:/);
  assert.match(on.stdout, /^\s*\S+\/xpi\/$/m, "it names the tree to read");
  assert.match(on.stdout, /^\s*Label 1: /m, "each sweep under its label");
  const answers = on.stdout.match(/^\s*(\S+\/sweep-xpi\.answers\.json)$/m);
  assert.ok(answers, "the answers file is named");
  assert.ok(!fs.existsSync(answers[1]), "and left for the agent to write");

  const off = run([addon, ...OFFLINE_FLAGS]);
  assert.ok(!off.stdout.includes("Please verify"), "off by default");
  assert.match(off.stdout, /── Found Issues ──/, "the report prints normally");

  const json = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--report-format",
    "json",
  ]);
  assert.equal(json.code, 2);
  assert.match(json.stderr, /--llm-review is text only/);
});

// Both ends of the loop print a prompt, so both have to refuse the one format that is
// not one. --llm-handback returns from its own branch before reaching the test
// --llm-review takes, so the refusal is asked ahead of both. The message names the flag
// that was actually used, because a run that said --llm-handback is not helped by being
// told about --llm-review.
// A failure while building the NEXT pass is the tool's, not the agent's: its hand-back was
// accepted. So it is not a refusal - that would send the agent to retry a file it got right,
// into the same failure - but the clean failure every other tool error in the loop gives:
// the error's own message and "verify failed", exit 2, and the state left as it was.
test("a failure building the next pass ends it cleanly, not with a stack trace", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const first = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--llm-skip-summary",
  ]);
  assert.equal(first.code, 0, first.stderr);
  const file = first.stdout.match(/(\S+\/review\.json)/)[1];
  const stateFile = path.join(path.dirname(file), "state.json");
  // A finding in the archive, in a review that has no archive: the next phase cannot
  // resolve its path, which is the linter's own inconsistency to report.
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.report.findings.push({
    ruleId: "eval-call",
    severity: "error",
    file: "orphan.js",
    loc: { line: 1 },
    artifact: "SCA",
    message: "eval",
  });
  fs.writeFileSync(stateFile, JSON.stringify(state));
  sweepBack(file);
  const before = fs.readFileSync(stateFile, "utf8");

  const out = run(["--llm-handback", workOfReviewFile(file), ...OFFLINE_FLAGS]);
  assert.equal(out.code, 2);
  assert.match(out.stderr, /orphan\.js/, "the error's own message");
  assert.match(out.stderr, /verify failed/);
  assert.doesNotMatch(out.stderr, /^\s+at /m, "no stack trace");
  assert.doesNotMatch(
    out.stdout,
    /not what this pass expected/,
    "not a refusal"
  );
  assert.equal(
    fs.readFileSync(stateFile, "utf8"),
    before,
    "the state is untouched"
  );
});

// A message that is not part of the normal review goes to stderr. In a run printing a
// prompt for an agent it is held back and written last, under its own header - the
// agent's harness merges both streams, and a warning printed in place reads as part of
// the prompt.
test("a warning reaches stderr, held back to the end of a prompt run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxl-warn-"));
  fs.cpSync(
    path.join(ROOT, "tests", "addons", "sca-experiment-vendored"),
    dir,
    {
      recursive: true,
    }
  );
  // A folder that exists and holds nothing: the run carries on, degraded, and says so.
  fs.mkdirSync(path.join(dir, "src", "emptyexp"));
  // Its VENDORS.md sends the review to GitHub for the vendored file, which no cache answers;
  // what this test reads is the held warning, which does not need it.
  fs.rmSync(path.join(dir, "src", "VENDORS.md"));
  const args = [
    path.join(dir, "xpi"),
    "--sca-root",
    path.join(dir, "src"),
    "--sca-exp-source",
    "emptyexp",
    ...OFFLINE_FLAGS,
  ];
  const WARNING = /matched no files under --sca-root/;

  const prompt = run([...args, "--llm-review", "--llm-skip-summary"]);
  assert.notEqual(prompt.code, 2, prompt.stderr);
  assert.doesNotMatch(prompt.stdout, WARNING, "not in the prompt");
  assert.match(prompt.stderr, /── Tool messages ──[\s\S]*matched no files/);

  const text = run(args);
  assert.doesNotMatch(text.stdout, WARNING);
  assert.match(text.stderr, WARNING, "a text run prints it in place");
  assert.doesNotMatch(text.stderr, /Tool messages/, "with nothing held back");
});

// A failure OUTSIDE main's promise - a throw from a callback nothing awaits - would end
// the process through Node's own handler, past exitWith, and lose every message the run
// was holding back. The entry point catches those too.
//
// Driven by a preloaded module that throws from a microtask queued as the prompt is
// printed: by then the run is holding its warning, and that microtask is queued ahead of
// main's own settlement, so it runs before the exit every time - no timing. (A nextTick
// would not: Node drains the microtask queue, exit included, before any nextTick.)
test("a failure outside main still dumps the held messages", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxl-crash-"));
  fs.cpSync(
    path.join(ROOT, "tests", "addons", "sca-experiment-vendored"),
    dir,
    {
      recursive: true,
    }
  );
  fs.mkdirSync(path.join(dir, "src", "emptyexp"));
  // Its VENDORS.md sends the review to GitHub for the vendored file, which no cache answers;
  // what this test reads is the held warning, which does not need it.
  fs.rmSync(path.join(dir, "src", "VENDORS.md"));
  const stray = path.join(dir, "stray.mjs");
  fs.writeFileSync(
    stray,
    [
      "const write = process.stdout.write.bind(process.stdout);",
      "let thrown = false;",
      "process.stdout.write = (chunk, ...rest) => {",
      '  if (!thrown && String(chunk).includes("LLM Prompt")) {',
      "    thrown = true;",
      "    queueMicrotask(() => {",
      '      throw new Error("stray failure outside main");',
      "    });",
      "  }",
      "  return write(chunk, ...rest);",
      "};",
      "",
    ].join("\n")
  );
  const r = spawnSync(
    process.execPath,
    [
      "--import",
      stray,
      REVIEW,
      path.join(dir, "xpi"),
      "--sca-root",
      path.join(dir, "src"),
      "--sca-exp-source",
      "emptyexp",
      "--llm-review",
      ...OFFLINE_FLAGS,
    ],
    { encoding: "utf8" }
  );
  assert.equal(r.status, 2, r.stderr);
  assert.match(
    r.stderr,
    /── Tool messages ──[\s\S]*matched no files[\s\S]*stray failure outside main/,
    "the held warning, then the failure, in one block"
  );
});

test("both ends of the review loop refuse --report-format json", () => {
  const started = run([
    "--llm-handback",
    "/nonexistent",
    "--report-format",
    "json",
  ]);
  assert.equal(started.code, 2);
  assert.match(started.stderr, /--llm-handback is text only/);
  assert.doesNotMatch(
    started.stderr,
    /--llm-review/,
    "names the flag the run used"
  );

  // Text is still the loop's own format, so the pass runs - and a folder holding no review
  // is a hand-back gone wrong, refused to the agent on stdout like any other.
  const text = run(["--llm-handback", "/nonexistent"]);
  assert.equal(text.code, 2);
  assert.match(
    text.stdout,
    /The hand-back was refused: "\/nonexistent" holds no review/
  );
});

// The review file is the linter's to name, so the flag takes no value at all - which is
// what lets it sit anywhere on the command line, including before the add-on, where a flag
// with an optional value would have swallowed the path and left nothing to review. It sits
// in the run's own work folder, so no second run can open the file a reader is still
// working from.
test("--llm-review names its own review file and swallows no argument", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const named = (r) => reviewFile(r.stdout);

  // After the add-on, before it, and before another option: the same review either way.
  const written = [
    named(run([addon, ...OFFLINE_FLAGS, "--llm-review"])),
    named(run([...OFFLINE_FLAGS, "--llm-review", addon])),
    named(run([addon, ...OFFLINE_FLAGS, "--llm-review", "--eslint"])),
  ];
  for (const file of written) {
    assert.ok(file && fs.existsSync(file), `${file} was written`);
    assert.ok(Array.isArray(JSON.parse(fs.readFileSync(file, "utf8")).entries));
    assert.equal(path.basename(file), "review.json");
  }
  assert.equal(
    new Set(written).size,
    written.length,
    "each run writes its own file, so none truncates another's"
  );
});

// The ESLint code-sanity check is opt-in: it runs only when --eslint is passed.
test("--eslint gates the code-sanity check", () => {
  const addon = path.join(ROOT, "tests", "addons", "all-checks");
  const base = [addon, ...OFFLINE_FLAGS, "--report-format", "json"];
  const off = JSON.parse(run(base).stdout);
  assert.ok(!off.meta.checksRun.includes("code-sanity")); // default: not run
  const on = JSON.parse(run([...base, "--eslint"]).stdout);
  assert.ok(on.meta.checksRun.includes("code-sanity")); // --eslint: runs
});

// The whole of --warnings-as-errors, from the outside: the band a finding is published at,
// the tally that counts it, the verdict preamble that opens the section, and the exit code.
// One flag is read in one place (src/checks/registry.js bandUnder) and all four follow.
test("--warnings-as-errors settles a warning as an error, exit code included", () => {
  const addon = path.join(ROOT, "tests", "addons", "mistyped-manifest-value");
  const base = [addon, ...OFFLINE_FLAGS];
  const off = run([...base, "--report-format", "json"]);
  const offDoc = JSON.parse(off.stdout);
  assert.equal(off.code, 0); // a warning alone does not fail the run
  assert.ok(offDoc.summary.warning > 0 && offDoc.summary.error === 0);

  const on = run([...base, "--warnings-as-errors", "--report-format", "json"]);
  const onDoc = JSON.parse(on.stdout);
  assert.equal(on.code, 1);
  assert.equal(onDoc.summary.warning, 0);
  assert.equal(onDoc.summary.error, offDoc.summary.warning);
  // The same findings, not more of them: the flag moves a band, it finds nothing new.
  assert.deepEqual(onDoc.summary.byRule, offDoc.summary.byRule);

  // The text report opens with the rejection preamble rather than the one that thanks the
  // developer and asks for a fix in the next release.
  const text = run([...base, "--warnings-as-errors"]).stdout;
  assert.match(text, /caused the submission to be rejected/);
  assert.doesNotMatch(
    text,
    /resolve the following issues with your next release/
  );
});

// The band belongs to the REVIEW, recorded when it started, so a later pass reads it back
// instead of being told it again - two sources for one fact is one of them going stale.
test("--warnings-as-errors is refused on a --llm-handback pass", () => {
  const r = run(["--llm-handback", "/nonexistent", "--warnings-as-errors"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /belongs to the review/);
  // Refused before the folder is read: the message is about the flag, not about the path.
  assert.doesNotMatch(r.stderr, /nonexistent/);
});

// ...and read back it is: a case a later pass reports becomes a finding in the band the
// review started with, so a warning reported under the flag is an error, exit code included.
test("a hand-back pass reports a case in the band its review recorded", () => {
  const addon = path.join(ROOT, "tests", "addons", "optional-permission");
  const settle = (...flags) => {
    const first = run([
      addon,
      ...OFFLINE_FLAGS,
      "--llm-review",
      "--llm-skip-summary",
      "--llm-skip-manual",
      "--llm-skip-sweep",
      "--checks-only",
      "unused-permission",
      ...flags,
    ]);
    assert.equal(first.code, 0, first.stderr);
    const file = reviewFile(first.stdout);
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(
      doc.entries.map((e) => e.ruleId),
      ["unused-permission"]
    );
    doc.entries = doc.entries.map((e) => ({ ...e, answer: "reported" }));
    fs.writeFileSync(file, JSON.stringify(doc));
    return run(["--llm-handback", workOfReviewFile(file)]);
  };
  const plain = settle();
  assert.equal(plain.code, 0, plain.stdout + plain.stderr);
  assert.match(plain.stdout, /0 error\(s\), 0 hold, 1 warning\(s\)/);
  const strict = settle("--warnings-as-errors");
  assert.equal(strict.code, 1, strict.stdout + strict.stderr);
  assert.match(strict.stdout, /1 error\(s\), 0 hold, 0 warning\(s\)/);
});

// JSON is a machine contract: stdout is the document, stderr is silent - even
// with --verbose (no activity feed, no notices).
test("JSON output is fully silent on stderr, even with --verbose", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const r = run([
    addon,
    ...OFFLINE_FLAGS,
    "--report-format",
    "json",
    "--verbose",
  ]);
  assert.ok([0, 1].includes(r.code));
  assert.doesNotThrow(() => JSON.parse(r.stdout));
  assert.equal(r.stderr, "");
});
