// CLI-contract tests of the --llm-review skips and the sweeps: what each skip leaves out and
// how a swept case becomes an item of its check.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipelineOptsFromArgv } from "../../src/cli.js";
import {
  ROOT,
  OFFLINE_FLAGS,
  entriesOf,
  run,
  workOfReviewFile,
  sweepBack,
} from "../cli-run.js";

/** What the reviewer sends to the developer. The linter WRITES this one, and the final
 *  prompt links it rather than reproducing it - so a test asserting on the report reads
 *  the file, the way the reviewer does. Read out of the link's target, because a path
 *  taken as "the next run of non-space" would take the `](` with it. */
function reportOf(stdout) {
  const at = stdout.match(/\]\((\S+\/report\.md)\)/);
  assert.ok(at, "the prompt links the report file");
  return fs.readFileSync(at[1], "utf8");
}

// --sca-root / --sca-exp-source flow through to the source-code submission pipeline opts
// (--sca-root alone switches the review to SCA mode).
// The reader is where a path stops being a spelling and becomes a place: --sca-root against
// the working directory, and the one that names a folder inside it against the RESOLVED
// root. Everything downstream is handed absolutes and re-resolves nothing.
test("--sca-root / --sca-exp-source map to the sca pipeline opts", () => {
  const o = pipelineOptsFromArgv([
    "--sca-root",
    "pkg",
    "--sca-exp-source",
    "exp",
  ]);
  assert.equal(o.scaRoot, path.resolve("pkg"));
  assert.equal(o.scaExpSource, path.resolve("pkg", "exp"));
  // Every spelling of the same folder arrives as one value.
  for (const written of [
    "exp",
    "./exp",
    "./exp/",
    path.resolve("pkg", "exp"),
  ]) {
    const each = pipelineOptsFromArgv([
      "--sca-root",
      "pkg",
      "--sca-exp-source",
      written,
    ]);
    assert.equal(each.scaExpSource, path.resolve("pkg", "exp"), written);
  }
  assert.ok(!pipelineOptsFromArgv([]).scaRoot);
  assert.ok(!pipelineOptsFromArgv([]).scaExpSource);
});

// The two skips end to end: the same round trip, minus the two parts that need a person.
// The sweep, the findings and the Extended Code Review are asked for exactly as a plain
// --llm-review asks for them; the add-on description and the manual questions are not, and
// the manual items are absent from the item file so the prompt and the file agree about
// what the reader is being asked to settle. They stay in the REPORT, for the reviewer.
test("the two skips withhold the description and the manual items", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const on = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--llm-skip-summary",
    "--llm-skip-manual",
  ]);
  const lines = on.stdout.split("\n");
  const intro = lines.findIndex((l) =>
    l.startsWith("This review runs in passes")
  );
  assert.ok(intro > -1, "the loop's preamble is printed");
  // The prompt is the WHOLE output: no header block beside it, because every value a step
  // uses is printed by that step, and no Summary, because the tally is about to change.
  assert.doesNotMatch(on.stdout, /── Review Details ──/, "no header block");
  assert.doesNotMatch(on.stdout, /── Summary ──/, "no tally");
  assert.ok(!on.stdout.includes("── Found Issues ──"), "no prose report");
  assert.ok(!on.stdout.includes("── Setup ──"), "no feed");

  // The inverse of the --llm-review assertions above: these are the two withheld steps,
  // and their absence is the whole feature.
  assert.ok(
    !entriesOf(on.stdout).some((e) => "answers" in e),
    "no manual questions asked"
  );
  assert.doesNotMatch(
    on.stdout,
    /\/summary\.md/,
    "no add-on description asked for, and no file named for one"
  );
  // ...while the step that closes the round trip survives the renumbering.
  assert.match(on.stdout, /--llm-handback/);

  // --llm-skip-summary leaves the sweep as the spawn phase's only agent, and the pass asks
  // about nothing in the file.
  assert.match(on.stdout, /Spawn an independent sub-agent NOW to sweep/);
  assert.deepEqual(entriesOf(on.stdout), []);
  assert.equal(on.code, 0);
});

// Each skip cuts ONE part, and the other is untouched: the pair is not a single decision
// wearing two names. Asserted at both ends - what the prompt asks for, and what the item
// file carries - because the two must agree about what the reader is being asked to settle.
test("each skip leaves out its own part and nothing else", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const itemsOf = (r) => entriesOf(r.stdout);
  const manualSections = ["Extended Manual Review", "Standard Manual Review"];

  // The description goes, the questions stay: the file still offers answers.
  const noSummary = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--llm-skip-summary",
  ]);
  assert.equal(noSummary.code, 0, noSummary.stderr);
  assert.doesNotMatch(noSummary.stdout, /\/summary\.md/);
  // The questions are a later pass, so the first prompt names none either way. What the
  // skip decides is whether the FILE still carries them.

  assert.doesNotMatch(
    noSummary.stdout,
    /Spawn an independent sub-agent NOW to describe/,
    "no description agent is spawned"
  );

  // The questions go, the description stays: the file carries no manual entry.
  const noManual = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--llm-skip-manual",
  ]);
  assert.equal(noManual.code, 0, noManual.stderr);
  assert.match(noManual.stdout, /^\s*\S+\/summary\.md$/m);
  assert.ok(
    !entriesOf(noManual.stdout).some((e) => "answers" in e),
    "no questions asked"
  );
  assert.ok(
    !itemsOf(noManual).some((x) => manualSections.includes(x.section)),
    "no manual entry in the file"
  );
});

// The description file is named only when the step that writes it PRINTS. Two things
// withhold that step - --llm-skip-summary names it, and a review with nothing to settle
// prints no steps at all - and a path printed for a file nobody is asked to write is an
// instruction with no step behind it. The second route is the one a skip does not cover.
test("a review with nothing to settle names no description file", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const r = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--llm-skip-manual",
    "--checks-only",
    "debugger-statement",
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /── LLM Prompt ──/);
  // A review with nothing to SETTLE still has something to DO: the description is for the
  // reviewer, who still gets a report. So the spawn phase prints, and the phases that
  // settle entries do not - which is the rule, not an exception to it.
  assert.match(r.stdout, /^1\. Spawn an independent sub-agent/m);
  assert.doesNotMatch(r.stdout, /Verify every entry/, "nothing to verify");
  assert.doesNotMatch(r.stdout, /Settle each entry/, "nothing to settle");
  // The description agent returns its text as its reply, and the step names the PATH the
  // reply is written to, on a line of its own and in the sentence that says to write it.
  assert.match(
    r.stdout,
    /write its reply unchanged to\n\n\s+\S+\/summary\.md\n\n\s+and to nothing else/
  );
  assert.doesNotMatch(r.stdout, /ADDON_DESCRIPTION/);
  // The review file is handed over with nothing to answer: this phase has a step to do
  // and no entries, which is work either way.
  assert.deepEqual(entriesOf(r.stdout), []);
});

// Each skip names part of the --llm-review prompt, so neither says anything without it:
// a run that prints its report has no prompt to cut down. Refused before every other
// guard, and the wording names the flags that were actually given.
test("a skip without --llm-review is refused", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const one = run([addon, ...OFFLINE_FLAGS, "--llm-skip-manual"]);
  assert.equal(one.code, 2);
  assert.match(one.stderr, /--llm-skip-manual names part/);
  assert.match(one.stderr, /it needs --llm-review, or --llm-sca-review/);

  const both = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-skip-summary",
    "--llm-skip-manual",
  ]);
  assert.equal(both.code, 2);
  assert.match(
    both.stderr,
    /--llm-skip-summary and --llm-skip-manual name parts/
  );
  assert.match(both.stderr, /they need --llm-review, or --llm-sca-review/);

  // --llm-skip-sweep is not one of them - it names no `skip:` step, so it feeds the
  // `run: sweep` condition instead - but the rule it lives under is the same one.
  const sweep = run([addon, ...OFFLINE_FLAGS, "--llm-skip-sweep"]);
  assert.equal(sweep.code, 2);
  assert.match(sweep.stderr, /--llm-skip-sweep names part/);
});

// --llm-review carries its own guards, and a skip changes none of them: the prompt is
// still text only, and it is still the asking half of a round trip --llm-handback closes.
test("a skipped review carries the same guards", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const json = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--llm-skip-manual",
    "--report-format",
    "json",
  ]);
  assert.equal(json.code, 2);
  assert.match(json.stderr, /--llm-review is text only/);

  const verdict = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--llm-skip-summary",
    "--llm-handback",
    os.tmpdir(),
  ]);
  assert.equal(verdict.code, 2);
  assert.match(verdict.stderr, /--llm-review and --llm-handback/);
});

// --llm-review switches on the verification prompt and the skips cut it down: the review
// stays deterministic, so all three must reach the pipeline as print decisions and leave
// every other opt alone. The skips arrive as the registry's own words, which is what
// format.js and items.js match them against.
test("a review flag carries only the prompt decision into the run", () => {
  // The hand-back command is a closure over the parsed flags, so two runs never produce
  // the same function object however alike the flags were. Compared by what it BUILDS
  // instead, below; dropped from the structural comparisons, which it would always fail.
  const shape = ({ llmSweepCommand: _drop, ...rest }) => rest;
  const bare = pipelineOptsFromArgv([]);
  assert.equal(bare.llmReview, false);
  assert.deepEqual(bare.llmSkip, []);

  const full = pipelineOptsFromArgv(["--llm-review"]);
  assert.equal(full.llmReview, true);
  assert.deepEqual(full.llmSkip, []);
  assert.deepEqual(shape({ ...full, llmReview: false }), shape(bare));

  const cut = pipelineOptsFromArgv([
    "--llm-review",
    "--llm-skip-manual",
    "--llm-skip-summary",
  ]);
  // Authored order, never the order the flags were given: the registry names the steps.
  assert.deepEqual(cut.llmSkip, ["llm-skip-summary", "llm-skip-manual"]);
  assert.deepEqual(
    shape({ ...cut, llmReview: false, llmSkip: [] }),
    shape(bare)
  );

  // The skips do not ride along in a hand-back any more: the run that was given them puts
  // them in the state, and every pass after reads that. So a later pass needs no flags at
  // all beyond the file it hands back.
});

// The retired flags parse as unknown options (exit 2), so a stale command line fails
// loudly instead of being quietly ignored.
test("retired flags are unknown options", () => {
  for (const flag of [
    "--ai-review",
    "--full-summary",
    "--diff-summary",
    "--llm-sweep-results",
  ]) {
    const r = run(["x.xpi", flag]);
    assert.equal(r.code, 2, `${flag} should exit 2`);
    assert.match(r.stderr, /Unknown option/, `${flag} should be unknown`);
  }
});

/** Give the review's own copy of the add-on the file a sweep result names, at least
 *  `lines` long: whatever it holds, then empty lines up to that count. A result names a
 *  file the swept tree has, and a line that file has. */
function planted(reviewFile, rel, lines) {
  const state = JSON.parse(
    fs.readFileSync(path.join(path.dirname(reviewFile), "state.json"), "utf8")
  );
  const file = path.join(state.paths.xpiRoot, rel);
  const had = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  fs.writeFileSync(file, had + "\n".repeat(lines));
}

// A sweep, end to end through the loop. The blind spot the sweep covers is the one thing
// the deterministic checks cannot find for themselves, so what it hands back has to become
// an item of the check it names - routed, numbered, and settled like any other.
//
// This one ESCALATES, so a swept case becomes an escalation of it, asking the question that
// check asks. The route below it covers the other kind.
test("a swept case becomes an item of its check and settles like any other", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const first = run([addon, ...OFFLINE_FLAGS, "--llm-review"]);
  assert.equal(first.code, 0, first.stderr);
  const file = first.stdout.match(/(\S+\/review\.json)/)[1];

  // The spawn pass asks nothing in this file - the sweeping agents answer in their own,
  // where an empty list is "swept and clean" and a null is "never looked".
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).entries, []);
  planted(file, "background.js", 12);
  sweepBack(file, {
    "data-exfiltration": [
      {
        file: "background.js",
        line: 12,
        hint: "<a ping> attribute carries the message digest",
      },
    ],
  });

  // The next pass carries it as a case of its own check, with its locus and its hint.
  const second = run([
    "--llm-handback",
    workOfReviewFile(file),
    ...OFFLINE_FLAGS,
  ]);
  assert.equal(second.code, 0, second.stderr);
  const next = JSON.parse(fs.readFileSync(file, "utf8"));
  const swept = next.entries.find((e) => e.ruleId === "data-exfiltration");
  assert.ok(swept, "the swept case is an entry of its own check");
  assert.equal(swept.hint, "<a ping> attribute carries the message digest");
  assert.match(second.stdout, /Settle each entry yourself/);

  // Settled like any other, and the developer reads the OWNING check's words - not the
  // sweeping agent's, which never leave the hint.
  next.entries = next.entries.map((e) => ({ ...e, answer: "reported" }));
  fs.writeFileSync(file, JSON.stringify(next, null, 1));
  let out = run(["--llm-handback", workOfReviewFile(file), ...OFFLINE_FLAGS]);
  // Every prompt but the closing one ends on the command that hands it back.
  while (/^\s+node verify\.js --llm-handback /m.test(out.stdout)) {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.entries = doc.entries.map((e) => ({ ...e, answer: "Clear" }));
    fs.writeFileSync(file, JSON.stringify(doc, null, 1));
    out = run(["--llm-handback", workOfReviewFile(file), ...OFFLINE_FLAGS]);
  }
  assert.equal(out.code, 1, out.stderr);
  // The invariant clause, not the subject: what the response calls the data (user data,
  // telemetry, ...) is wording the registry owns and may reword, and this test is about
  // the response reaching the output at all.
  const report = reportOf(out.stdout);
  assert.match(report, /to a remote server without an explicit opt-in/);
  // Squared off on the way into the report, like every other angle bracket in it. The hint
  // is a THIRD source of them, after our own prose and the submission's own tokens: the
  // agent wrote this one, and it names an HTML element, so it would open a tag in the
  // document the reviewer sends.
  assert.match(
    report,
    /background\.js:12 - \[a ping\] attribute carries the message digest/
  );
});

// A check with NO escalation settles its cases as FINDINGS - `cleartext-transmission` sees
// http:// and files one. So a hint its detectors missed is a finding too, and the verify
// phase audits it exactly like a detected one: same phase, same two verbs, and the report
// words it from that check's own response. The sweep's own text settles nothing.
test("a swept case of a check that files findings is verified like one", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const first = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--llm-skip-summary",
  ]);
  assert.equal(first.code, 0, first.stderr);
  const file = first.stdout.match(/(\S+\/review\.json)/)[1];

  planted(file, "sync.js", 12);
  sweepBack(file, {
    "cleartext-transmission": [
      { file: "sync.js", line: 12, hint: "posts over http://" },
    ],
  });

  // It arrives in VERIFY, as a finding: a locus and the agent's hint, and no `instructions`
  // - a finding carries no question, because it is a claim to be audited.
  const second = run([
    "--llm-handback",
    workOfReviewFile(file),
    ...OFFLINE_FLAGS,
  ]);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /Verify every entry in ONE pass/);
  const verify = JSON.parse(fs.readFileSync(file, "utf8"));
  const swept = verify.entries.find(
    (e) => e.ruleId === "cleartext-transmission"
  );
  assert.ok(swept, "the swept hint is a verify entry of its own check");
  assert.equal(swept.hint, "posts over http://");
  assert.equal(
    swept.instructions,
    undefined,
    "a finding carries no instructions"
  );

  // Confirmed, it reaches the developer worded by the OWNING check - never by the sweep.
  verify.entries = verify.entries.map((e) => ({ ...e, answer: "reported" }));
  fs.writeFileSync(file, JSON.stringify(verify, null, 1));
  let out = run(["--llm-handback", workOfReviewFile(file), ...OFFLINE_FLAGS]);
  // Every prompt but the closing one ends on the command that hands it back.
  while (/^\s+node verify\.js --llm-handback /m.test(out.stdout)) {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.entries = doc.entries.map((e) => ({ ...e, answer: "Clear" }));
    fs.writeFileSync(file, JSON.stringify(doc, null, 1));
    out = run(["--llm-handback", workOfReviewFile(file), ...OFFLINE_FLAGS]);
  }
  const report = reportOf(out.stdout);
  assert.match(report, /Data is sent over an unencrypted connection/);
  assert.match(report, /sync\.js:12 - posts over http:\/\//);
});
