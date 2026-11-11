// Taking what a sweep found and routing each result the way its own check routes its own
// cases. The agent that swept classifies nothing, so every guard here exists because a
// result routed by anything other than what that check already does would land a case in
// front of whoever cannot settle it - which is the defect this path was built to end.

import { test } from "node:test";
import { ARTIFACT_XPI, ARTIFACT_SCA } from "../../src/lib/artifacts.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  checkedResult,
  MAX_HINT,
  mergeSweepResults,
} from "../../src/report/sweep.js";
import { loadRegistry } from "../../src/checks/registry.js";

const registry = loadRegistry();

/** A swept tree on disk, holding `files` (relative path to content). */
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wxl-sweep-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

/** The tree the shape tests read: every file they name, each a few lines long. */
const ROOT = tree({
  "a.js": "one\ntwo\nthree\n",
  "sub/a.js": "one\n",
  "lib/deep/widget.js": "one\ntwo\n",
});

/** A file of the shape tests' tree by its absolute path, the way an agent names it. */
const at = (rel) => path.join(ROOT, rel);

/** One result as it reaches the merge: already saying which check it answers and which
 *  tree it was found in. Both were resolved from its label by whoever read the answers
 *  file (src/report/sweep-files.js), so nothing here has to work them out. */
function result(check, file, line, hint = null, artifact = ARTIFACT_SCA) {
  return { check, artifact, file, line, hint };
}

function merge(results, manual = [], findings = [], mode = undefined) {
  return mergeSweepResults({
    results,
    manual,
    findings,
    registry,
    mode,
  });
}

// ---- what an agent may write ----
// The agent AUTHORS these rows - the linter cannot, since a sweep exists for what its
// detectors miss - so each is held to a shape at the one point it enters the review.
// Refused rather than repaired: a result nothing can be done with is a sweep half applied.

test("a malformed sweep result is rejected with a reason", () => {
  const bad = (entry, re) =>
    assert.throws(() => checkedResult("row 1", entry, ROOT), re);
  bad("nope", /must be an object/);
  bad({}, /names no "file"/);
  bad({ file: at("a.js"), line: 0 }, /has line 0/);
  bad({ file: at("a.js"), hint: "" }, /has hint ""/);
  bad({ file: at("a.js"), hint: "x".repeat(MAX_HINT + 1) }, (err) =>
    err.message.includes(`${MAX_HINT + 1}-character hint`)
  );
  // WHICH sweep a result answers is the slot it was written into, never something it
  // says: a result naming one would be an agent choosing where its hint lands.
  bad({ check: "privacy-policy", file: at("a.js") }, /may only set/);
  // Where it lands and how it reads are the linter's, so a result that tries to say is
  // refused rather than quietly stripped - that would be an agent wording the report.
  bad(
    { file: at("a.js"), severity: "error" },
    /may only set "file", "line", "hint"/
  );

  assert.deepEqual(checkedResult("row 1", { file: at("a.js") }, ROOT), {
    file: "a.js",
    line: null,
    hint: null,
  });
});

// A hint up to the limit is a phrase, and the limit leaves room for one naming a call and
// what it carries.
test("a hint of 500 characters is accepted, and one past the limit refused", () => {
  assert.equal(MAX_HINT, 500);
  const hint = "x".repeat(MAX_HINT);
  assert.equal(
    checkedResult("row", { file: at("a.js"), hint }, ROOT).hint,
    hint
  );
  assert.throws(
    () => checkedResult("row", { file: at("a.js"), hint: `${hint}x` }, ROOT),
    (err) => err.message.includes("501-character hint")
  );
});

// A result names a location the reader opens. A file the agent misremembered, or a line
// counted across several files read together, points at nothing, so both are refused
// where the agent can correct them.
test("a result names a file in the swept tree and a line that file has", () => {
  const root = tree({
    "ends.js": "one\ntwo\nthree\n",
    "open.js": "one\ntwo\nthree",
    "lib/x.js": "",
  });
  const outside = tree({ "secret.js": "one\n" });
  fs.symlinkSync(path.join(outside, "secret.js"), path.join(root, "linked.js"));
  const inRoot = (rel) => path.join(root, rel);
  const refused = (raw, says, what) =>
    assert.throws(
      () => checkedResult("row", raw, root),
      (err) => err.message.includes(says),
      what
    );

  refused(
    { file: inRoot("gone.js"), line: 1 },
    `row names file ${JSON.stringify(inRoot("gone.js"))}, which is not a file inside ${root}`,
    "a file the tree does not have"
  );
  refused({ file: inRoot("lib") }, "which is not a file inside", "a folder");
  refused(
    { file: inRoot("linked.js") },
    "which is not a file inside",
    "a link out of the tree"
  );
  refused(
    { file: inRoot("ends.js"), line: 4 },
    `row names line 4 of ${JSON.stringify(inRoot("ends.js"))}, which has 3 lines - a line is that file's own line number, counted from its first line`,
    "one past the last line"
  );
  refused(
    { file: inRoot("open.js"), line: 501 },
    "which has 3 lines",
    "a running count"
  );

  // The last line itself, with and without a trailing newline.
  assert.equal(
    checkedResult("row", { file: inRoot("ends.js"), line: 3 }, root).line,
    3
  );
  assert.equal(
    checkedResult("row", { file: inRoot("open.js"), line: 3 }, root).line,
    3
  );
  // A result with no line needs only the file, and comes back relative to the tree.
  assert.deepEqual(checkedResult("row", { file: inRoot("lib/x.js") }, root), {
    file: "lib/x.js",
    line: null,
    hint: null,
  });
});

// ---- the routing ----

// The whole point of this file. A sweep is a DETECTOR: what comes back is a hint its
// check's own detectors missed, and from that point it is one of that check's cases,
// handled the way that check already handles them. Three routes, one rule.
test("a result goes where its check's own cases go", () => {
  const { manual, findings, applied } = merge([
    result("privacy-policy", "providers/Gravatar.js", 23, "gravatar.com"),
    result("data-exfiltration", "bg.js", 40, "<a ping> carries the digest"),
    result("cleartext-transmission", "sync.js", 12, "posts over http://"),
  ]);
  assert.deepEqual(applied, [
    "privacy-policy [SCA] (providers/Gravatar.js:23) -> code-review",
    "data-exfiltration [SCA] (bg.js:40) -> code-review",
    "cleartext-transmission [SCA] (sync.js:12) -> finding",
  ]);

  // This check asks its two readers two different questions, so a swept case is screened
  // first, exactly as a detected one is. Both wordings ride on the item: the agent reads
  // one, and the reviewer whatever survives reads the other.
  const screened = manual.find((m) => m.ruleId === "privacy-policy");
  assert.equal(screened.section, "code-review");
  assert.equal(screened.extended, true);
  assert.deepEqual(
    [screened.file, screened.loc.line],
    ["providers/Gravatar.js", 23]
  );
  assert.match(screened.instructions, /privacy policy/i);
  assert.match(screened.llmInstructions, /fixed in the\s+shipped code/);
  assert.deepEqual(screened.settleVerbs, ["cleared", "ask"]);

  // This one escalates to code review, so a swept case asks the SAME question a detected
  // one asks - the check's own `instructions`, never the text the sweep agent was sent.
  const code = manual.find((m) => m.ruleId === "data-exfiltration");
  assert.equal(code.section, "code-review");
  assert.equal(
    code.instructions,
    registry.instructionsFor("data-exfiltration")
  );
  assert.notEqual(
    code.instructions,
    registry.sweepTargets("data-exfiltration")[0].instruction,
    "the sweep's own text settles nothing"
  );
  assert.equal(code.hint, "<a ping> carries the digest");

  // This one does not escalate at all: it settles its cases as findings, so a swept one is
  // a finding - which the verify phase audits like every other claim.
  assert.equal(
    manual.some((m) => m.ruleId === "cleartext-transmission"),
    false,
    "not a to-do item"
  );
  assert.equal(findings.length, 1);
  const [swept] = findings;
  assert.equal(swept.ruleId, "cleartext-transmission");
  assert.equal(
    swept.severity,
    registry.suggestedVerdict("cleartext-transmission")
  );
  assert.deepEqual([swept.file, swept.loc.line], ["sync.js", 12]);
  assert.equal(swept.hint, "posts over http://");
});

// A result nothing can be done with is a sweep half applied, so it fails the run rather
// than being skipped into silence.
//
// The OTHER way a result can be wrong - naming a sweep this review never asked for - is
// settled before anything reaches here: the answers are read against the very slots this
// run wrote, so a label nobody was asked about is refused at that door
// (tests/unit/sweep-files.test.js). What is left to ask here is whether the check could
// receive a case at all.
test("a result for a check nobody swept refuses the run", () => {
  assert.throws(
    () => merge([result("eval-call", "a.js", 1)]),
    /authors no sweep instruction/
  );
});

// Deduplication is the linter's, not the reader's: a sweep escalation is passed through
// untouched, so the agent must not be the one deciding that two of its lines are one case.
//
// Asked of BOTH lists, because which one the deterministic pass used depends on whether
// that check escalates - and a sweep naming a location either already holds is naming what
// is already in the review.
test("a location already covered for that check is merged once", () => {
  const twice = merge([
    result("privacy-policy", "a.js", 1),
    result("privacy-policy", "a.js", 1),
  ]);
  assert.equal(twice.applied.length, 1);

  // Already raised by the deterministic pass as a to-do item, at the same locus.
  const already = [
    {
      ruleId: "privacy-policy",
      file: "a.js",
      loc: { line: 1 },
      artifact: ARTIFACT_SCA,
      section: "manual-review",
      extended: true,
    },
  ];
  const again = merge([result("privacy-policy", "a.js", 1)], already);
  assert.deepEqual(again.applied, []);
  assert.equal(again.manual.length, 1, "nothing was added beside it");

  // A different line of the same file is a different case, and is kept.
  const other = merge([result("privacy-policy", "a.js", 2)], already);
  assert.equal(other.applied.length, 1);
  assert.equal(other.manual.length, 2);

  // And already FILED by the deterministic pass, which is what a check with no escalation
  // does with its cases. Without this the sweep would file the finding a second time.
  const filed = [
    {
      ruleId: "cleartext-transmission",
      file: "sync.js",
      loc: { line: 12 },
      artifact: ARTIFACT_SCA,
    },
  ];
  const dup = merge(
    [result("cleartext-transmission", "sync.js", 12)],
    [],
    filed
  );
  assert.deepEqual(dup.applied, []);
  assert.equal(dup.findings.length, 1, "the one the pass filed, and no second");

  const elsewhere = merge(
    [result("cleartext-transmission", "sync.js", 99)],
    [],
    filed
  );
  assert.equal(elsewhere.applied.length, 1);
  assert.equal(elsewhere.findings.length, 2);
});

// A swept case reaches a reader with a locus, so it has to say which artifact that locus
// is in - the same fact every other finding and case carries. BOTH branches here: a check
// that escalates routes the result to a manual case, one that does not turns it into a
// finding, and the artifact is not the branch's to decide differently.
//
// Stamped here rather than inherited, because this runs long after runChecks. The route
// is the registry's answer for that check, which is the answer the orchestrator would
// have used had the check found the case itself.
test("a swept result says which artifact it is in, whichever branch it takes", () => {
  // cleartext-transmission settles its own cases (a finding); data-exfiltration escalates.
  // Both take the artifact the REVIEW recorded for that check, not one worked out here.
  const out = merge([
    result("data-exfiltration", "app.js", 3, "fetch()"),
    result("cleartext-transmission", "app.js", 9, "http://"),
  ]);
  assert.deepEqual(
    out.manual.map((m) => [m.ruleId, m.artifact]),
    [["data-exfiltration", ARTIFACT_SCA]],
    "the escalated branch carries it"
  );
  assert.deepEqual(
    out.findings.map((f) => [f.ruleId, f.artifact]),
    [["cleartext-transmission", ARTIFACT_SCA]],
    "and so does the finding branch"
  );

  // A row for a check the review recorded as the XPI's lands there instead - the answer
  // travels with the pre-sweep list, so this merge never re-derives one.
  const xpiAsked = {
    items: [{ check: "data-exfiltration", artifact: ARTIFACT_XPI }],
  };
  const xpi = mergeSweepResults({
    results: [
      result("data-exfiltration", "app.js", 3, "fetch()", ARTIFACT_XPI),
    ],
    manual: [],
    findings: [],
    preSweep: xpiAsked,
    registry,
    file: "/s.json",
  });
  assert.equal(xpi.manual[0].artifact, ARTIFACT_XPI);
});

// A sweep row is the ONLY path in a review the agent authors - every other one is read
// off disk. The agent names it by its absolute path, and the linter records it relative to
// the folder read, so a value that is relative, or steps out of that folder, would leave the
// linter guessing where it starts or publishing a location outside the submission as its own
// claim. Refused at this door, in the same terms the reviewer's own folder flags are.
test("a sweep result naming a relative path, or one outside the folder, is refused", () => {
  const refused = (file, says, what) =>
    assert.throws(
      () => checkedResult("r[0]", { file, line: 1 }, ROOT),
      (err) => err.message.includes(says),
      what
    );
  const absolute = "a result names a file by its absolute path";
  refused("a.js", absolute, "relative, which leaves where it starts open");
  refused("../../../etc/passwd", absolute, "out through the top");
  refused(`${ROOT}/lib/../../escape.js`, absolute, "out through the middle");
  refused("/etc/hostname", "which is not a file inside", "outside the folder");

  // An ordinary nested path is still fine - the guard is about escaping, not depth.
  assert.equal(
    checkedResult("r[0]", { file: at("lib/deep/widget.js"), line: 2 }, ROOT)
      .file,
    "lib/deep/widget.js"
  );
});

// The folder itself is no file in it, however it is written.
test("a result naming the folder read is refused", () => {
  for (const file of [ROOT, `${ROOT}/`, `${ROOT}/.`]) {
    assert.throws(
      () => checkedResult("row", { file }, ROOT),
      /which is not a file inside/,
      `expected ${JSON.stringify(file)} to be refused`
    );
  }
  // A path INSIDE the folder passes, and comes back relative, with a `.` segment walked.
  for (const [file, rel] of [
    [at("a.js"), "a.js"],
    [at("sub/a.js"), "sub/a.js"],
    [`${ROOT}/sub/./a.js`, "sub/a.js"],
  ]) {
    assert.equal(checkedResult("row", { file }, ROOT).file, rel);
  }
});

// A source in a wrapper folder: the agent names the file it opened, and the linter records
// it with the wrapper folder, in the keyspace of the tree it read. A folder given through a
// link is matched by its real path too.
test("a result inside a wrapper folder is recorded with it", () => {
  const root = tree({ "project-1.0/src/api.ts": "one\ntwo\n" });
  assert.deepEqual(
    checkedResult(
      "row",
      { file: path.join(root, "project-1.0/src/api.ts"), line: 2 },
      root
    ),
    { file: "project-1.0/src/api.ts", line: 2, hint: null }
  );
  const link = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "wxl-link-")),
    "l"
  );
  fs.symlinkSync(root, link);
  assert.equal(
    checkedResult(
      "row",
      { file: path.join(fs.realpathSync(root), "project-1.0/src/api.ts") },
      link
    ).file,
    "project-1.0/src/api.ts"
  );
});
