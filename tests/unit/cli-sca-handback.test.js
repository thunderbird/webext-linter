// CLI-contract tests of the preparation hand-back and its refusals, and of how a review treats
// submission files it cannot read or must not echo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { workPaths } from "../../src/util/dest.js";
import {
  ROOT,
  REVIEW,
  OFFLINE_FLAGS,
  headerValue,
  run,
  workOfReviewFile,
  defaultFolderOf,
  submissionFolder,
  packAddon,
  workOf,
  readJson,
  handBackRoots,
} from "../cli-run.js";

// The prompt's one command is typed by its reader, and a submission folder is as likely to
// hold a space as not. Quoted where it matters and nowhere else: an unquoted path with a
// space in it is a second argument the hand-back refuses.
test("the preparation quotes an argument that carries whitespace", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl sub mission-"));
  packAddon(path.join(dir, "addon  v2.xpi"));
  fs.writeFileSync(path.join(dir, "src.tar.gz"), "");
  const r = run([dir, "--llm-sca-review", ...OFFLINE_FLAGS]);
  assert.equal(r.code, 0, r.stderr);
  // The values above the command are read by eye, not typed, so they carry no quotes, and
  // keep the run of spaces the file name has.
  assert.match(r.stdout, new RegExp(`\n  FOLDER\n    ${dir}\n`));
  assert.equal(headerValue(r.stdout, "XPI"), path.join(dir, "addon  v2.xpi"));
  assert.match(r.stdout, new RegExp(`--llm-handback '${dir}/addon__v2-`));
  const handed = handBackRoots(r.stdout);
  assert.notEqual(handed.code, 2, handed.stdout + handed.stderr);
  assert.equal(
    readJson(workOf(r.stdout), "state").report.meta.xpi,
    path.join(dir, "addon  v2.xpi"),
    "the review reads the file the block named"
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// The work folder is recorded, a rescued copy goes inside it, and the next prompt names it,
// so however it is typed - relative, with a trailing slash - it is taken as one absolute
// name: the review starts in it, and the prompt names its files by that name.
test("a hand-back takes its folder as one absolute name", () => {
  const dir = submissionFolder();
  const r = run([dir, "--llm-sca-review", ...OFFLINE_FLAGS]);
  assert.equal(r.code, 0, r.stderr);
  const work = workOf(r.stdout);
  const handed = handBackRoots(r.stdout, {
    typed: (w) => `${path.relative(process.cwd(), w)}/`,
  });
  assert.notEqual(handed.code, 2, handed.stdout + handed.stderr);
  assert.ok(fs.existsSync(workPaths(work).state), "the review starts in it");
  assert.ok(
    handed.stdout.includes(`[report.md](${work}/report.md)`),
    handed.stdout
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// An Experiment the review would reject is not worth preparing: --llm-sca-review asks the
// review's own verdict of the .xpi first, and where it rejects, starts that review at once -
// the same review --llm-review of the .xpi starts, which the reject aborts, so its first
// prompt is the close. An Experiment
// the review accepts is prepared as any submission is.
test("--llm-sca-review starts the review of an Experiment it would reject", () => {
  const submission = (fixture) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-exp-gate-"));
    const zip = new AdmZip();
    zip.addLocalFolder(path.join(ROOT, "tests", "addons", fixture));
    zip.writeZip(path.join(dir, "addon.xpi"));
    fs.writeFileSync(path.join(dir, "src.tar.gz"), "");
    return dir;
  };
  const dir = submission("experiment-disallowed");
  const r = run([dir, "--llm-sca-review", ...OFFLINE_FLAGS]);
  assert.equal(r.code, 1, r.stderr);
  assert.doesNotMatch(r.stdout, /SCA Review Prompt/);
  assert.match(r.stdout, /── LLM Prompt ──/);
  const work = defaultFolderOf(path.join(dir, "addon.xpi"));
  // The reject aborts the review, so its first prompt is the close, with the report.
  assert.deepEqual(fs.readdirSync(work).sort(), [
    ".review",
    "report.md",
    "xpi",
  ]);
  assert.deepEqual(fs.readdirSync(path.join(work, ".review")).sort(), [
    "review.json",
    "state.json",
  ]);
  assert.ok(r.stdout.includes(`[report.md](${work}/report.md)`), r.stdout);
  assert.deepEqual(readJson(work, "state").report.meta.checksRun, [
    "experiment-not-allowed",
  ]);
  const plain = run([
    path.join(dir, "addon.xpi"),
    "--llm-review",
    ...OFFLINE_FLAGS,
  ]);
  assert.equal(plain.code, 1, plain.stderr);
  const promptOf = (out, w) =>
    out.split("── LLM Prompt ──")[1].replaceAll(w, "<W>");
  assert.equal(
    promptOf(r.stdout, work),
    promptOf(
      plain.stdout,
      fs
        .readdirSync(dir)
        .map((n) => path.join(dir, n))
        .find((p) => /addon-[\d-]+T[\d-]+Z$/.test(p) && p !== work)
    ),
    "the review --llm-review of the .xpi starts"
  );
  fs.rmSync(dir, { recursive: true, force: true });

  for (const [fixture, extra] of [
    ["experiment-disallowed", ["--allow-experiments"]],
    ["experiment-pristine", []],
  ]) {
    const allowed = submission(fixture);
    const prepared = run([
      allowed,
      "--llm-sca-review",
      ...OFFLINE_FLAGS,
      ...extra,
    ]);
    assert.equal(prepared.code, 0, prepared.stderr);
    assert.match(prepared.stdout, /── SCA Review Prompt ──/, fixture);
    fs.rmSync(allowed, { recursive: true, force: true });
  }
});

// The preparation records every cache its review is to read, given or default, as one
// absolute name: a hand-back started from another directory reads the same caches.
test("the preparation records every cache as an absolute path", () => {
  const dir = submissionFolder();
  const cwd = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "wl-cwd-"))
  );
  const r = spawnSync(
    process.execPath,
    [REVIEW, dir, "--llm-sca-review", "--cache-schema-dir", "mycache"],
    { encoding: "utf8", cwd }
  );
  assert.equal(r.status, 0, r.stderr);
  const flags = readJson(workOf(r.stdout), "prepare").flags;
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(flags).filter(([name]) => name.endsWith("-dir"))
    ),
    {
      "cache-schema-dir": path.join(cwd, "mycache"),
      "cache-hash-db-dir": path.join(
        cwd,
        "WEBEXT-LINTER-CACHE",
        "mozilla-hash-db"
      ),
      "cache-cdn-lookup-dir": path.join(
        cwd,
        "WEBEXT-LINTER-CACHE",
        "cdn-lookup"
      ),
      "cache-npm-registry-dir": path.join(
        cwd,
        "WEBEXT-LINTER-CACHE",
        "npm-registry"
      ),
      "cache-sources-dir": path.join(cwd, "WEBEXT-LINTER-CACHE", "sources"),
      "cache-experiments-dir": path.join(
        cwd,
        "WEBEXT-LINTER-CACHE",
        "experiments"
      ),
    }
  );
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

// A check id nobody can run is a bad command line whatever the run does with it - and
// --llm-sca-review would record it for the review it starts, which would then fail on it.
// Answered before any branch, so no prompt is printed at all.
test("an unknown check id is refused before a prompt is printed", () => {
  const dir = submissionFolder();
  const sca = run([dir, "--llm-sca-review", "--checks-only", "no-such-check"]);
  assert.equal(sca.code, 2);
  assert.match(sca.stderr, /Unknown check "no-such-check"/);
  assert.doesNotMatch(sca.stdout, /SCA Review Prompt/);

  const review = run([
    path.join(ROOT, "tests", "addons", "clean"),
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--checks-skip",
    "no-such-check",
  ]);
  assert.equal(review.code, 2);
  assert.match(review.stderr, /Unknown check "no-such-check"/);
  assert.doesNotMatch(review.stdout, /LLM Prompt/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Each way the flag cannot be used, refused before it prints anything - it starts its own
// review, so it shares no run with the flags that do.
test("--llm-sca-review refuses what it cannot be combined with", () => {
  const dir = submissionFolder();
  const cases = [
    [["--sca-root", "src"], /works out --sca-root for you/],
    [["--llm-review"], /starts its own review/],
    [["--llm-handback", "work"], /starts its own review/],
    [["--report-format", "json"], /--llm-sca-review is text only/],
    // A SECOND add-on argument: the flag reads the first one as the submission.
    [
      ["x.xpi"],
      /Only one submission can be prepared at a time, and 2 were given/,
    ],
  ];
  for (const [extra, message] of cases) {
    const r = run([dir, "--llm-sca-review", ...extra]);
    assert.equal(r.code, 2, extra.join(" "));
    assert.match(r.stderr, message, extra.join(" "));
    assert.doesNotMatch(r.stdout, /SCA Review Prompt/, extra.join(" "));
  }
  // And the add-on argument it reads is REQUIRED: this flag changes what that argument
  // means, it does not carry the folder itself.
  const none = run(["--llm-sca-review"]);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /as a submission folder, and none was given/);
  assert.doesNotMatch(none.stdout, /SCA Review Prompt/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A folder that is not a submission fails here, where the reviewer can see it, rather than
// handing back a command aimed at a file nobody submitted.
test("--llm-sca-review refuses a folder that is not a submission", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-empty-"));
  const r = run([dir, "--llm-sca-review"]);
  assert.equal(r.code, 2);
  // The flag's name and the value that was given are the front-end's half of the message;
  // what was found in the folder is the loader's.
  assert.match(r.stderr, new RegExp(`--llm-sca-review "${dir}":`));
  assert.match(
    r.stderr,
    /a submission folder holds exactly one \.xpi and exactly one other archive/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// An answer that reaches settle() already invalid - too long to have been typed into the
// question it answers - fails cleanly, not as a raw stack trace. It cannot be redone: the
// answer is already in the state by the time settle() sees it, so this is a terminal
// failure of the review, the same as a state file this build cannot read - not a
// HandbackRefused, which exists only for a hand-back that can still be corrected.
test("an answer too long for settle() to apply fails cleanly, not as a crash", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const first = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--llm-skip-sweep",
  ]);
  assert.equal(first.code, 0, first.stderr);
  const file = first.stdout.match(/(\S+\/review\.json)/)[1];

  let out = run(["--llm-handback", workOfReviewFile(file), ...OFFLINE_FLAGS]);
  // Every prompt but the closing one ends on the command that hands it back.
  while (/^\s+node verify\.js --llm-handback /m.test(out.stdout)) {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.entries = doc.entries.map((e) => ({
      ...e,
      answer: "answers".repeat(400),
    }));
    fs.writeFileSync(file, JSON.stringify(doc, null, 1));
    out = run(["--llm-handback", workOfReviewFile(file), ...OFFLINE_FLAGS]);
  }
  assert.equal(out.code, 2, out.stdout);
  assert.match(out.stderr, /carries a \d+-character answer and the limit is/);
  assert.match(out.stderr, /verify failed/);
  assert.doesNotMatch(out.stderr, /at settleAnswer|at applyVerdicts|at Object/);
});

// The live feed and the report are two renderings of one review, so they must not
// disagree about which artifact a path is in. They reach the label by different routes -
// the feed settles it per note as a check runs, the report reads what was stamped on the
// finding - and a signature change once left the feed calling the label rule with a route
// where it expects an artifact, which silently blanked every label in it. Nothing caught
// that, because the feed is stdout and no unit test reads it.
test("the activity feed labels a locus the same way the report does", () => {
  const fx = "tests/addons/sca-multiple-vendor-files";
  const r = run([
    `${fx}/xpi`,
    "--sca-root",
    `${fx}/src`,
    "--verbose",
    ...OFFLINE_FLAGS,
  ]);
  const feed = r.stdout
    .split("\n")
    .filter((l) => l.trimStart().startsWith("•"));
  assert.ok(feed.length > 0, "the run narrated something");

  // Every note that names a file says which artifact it is in. An unlabelled one in a
  // source review is the failure: two artifacts, and the line says neither.
  const unlabelled = feed.filter(
    (l) => /\s-\s/.test(l) && !/\[(XPI|SCA)\]/.test(l)
  );
  assert.deepEqual(unlabelled, [], "no note names a file without its artifact");

  // And the labels are not all one value: this fixture has both artifacts in play, which
  // is what makes the agreement worth asserting.
  assert.ok(feed.some((l) => l.includes("[XPI]")));
  assert.ok(feed.some((l) => l.includes("[SCA]")));

  // The same file, labelled the same way in both places. VENDOR.md exists in BOTH
  // artifacts here, so this is the case a wrong label would be invisible in.
  assert.match(r.stdout, /• .*\[XPI\] VENDOR\.md - vendoring information/);
  assert.match(r.stdout, /^ - \[XPI\] VENDOR\.md$/m);
});

// Nothing the submission names reaches the terminal with a control character in it: every
// write passes one guarded door (src/util/log.js). The case that found the gap - a source
// archive whose only folder is named with escape sequences, which the "Source root" feed
// line printed raw - now prints them as plain text.
test("a submission's escape sequences never reach the terminal raw", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-escape-"));
  const xpi = path.join(dir, "xpi");
  fs.mkdirSync(xpi);
  fs.writeFileSync(
    path.join(xpi, "manifest.json"),
    '{"manifest_version":3,"name":"x","version":"1"}'
  );
  const root = path.join(dir, "src");
  const evil = path.join(root, "evil\u001b[2K\u001b[1Aname");
  fs.mkdirSync(evil, { recursive: true });
  fs.writeFileSync(
    path.join(evil, "package.json"),
    '{"name":"x","version":"1.0.0"}'
  );
  const r = run([xpi, "--sca-root", root, ...OFFLINE_FLAGS]);
  assert.match(r.stdout, /evil \[2K \[1Aname/, "the folder was named");
  assert.ok(!r.stdout.includes("\u001b"), "raw ESC on stdout");
  assert.ok(!r.stderr.includes("\u001b"), "raw ESC on stderr");
  fs.rmSync(dir, { recursive: true, force: true });
});

// An unreadable submission file makes it invalid: exit 2 and one sentence naming the artifact,
// the file and why, before any check runs - never a review that read it as empty.
test("an unreadable submission file makes it invalid, exit 2", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root reads every file");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-unreadable-"));
  const xpi = path.join(dir, "xpi");
  const src = path.join(dir, "src");
  fs.mkdirSync(xpi);
  fs.mkdirSync(src);
  fs.writeFileSync(
    path.join(xpi, "manifest.json"),
    '{"manifest_version":3,"name":"x","version":"1","background":{"scripts":["bg.js"]}}'
  );
  const bg = path.join(xpi, "bg.js");
  fs.writeFileSync(bg, "browser.runtime.id;\n");
  fs.writeFileSync(
    path.join(src, "package.json"),
    '{"name":"x","version":"1.0.0"}'
  );
  const build = path.join(src, "build.js");
  fs.writeFileSync(build, "1;\n");
  try {
    fs.chmodSync(bg, 0o000);
    const r = run([xpi, ...OFFLINE_FLAGS]);
    assert.equal(r.code, 2, r.stderr);
    assert.match(
      r.stderr,
      /Invalid XPI: bg\.js cannot be read \(permission denied\)\./
    );
    // The same in a source archive: the archive is the invalid input.
    fs.chmodSync(bg, 0o644);
    fs.chmodSync(build, 0o000);
    const sca = run([xpi, "--sca-root", src, ...OFFLINE_FLAGS]);
    assert.equal(sca.code, 2, sca.stderr);
    assert.match(
      sca.stderr,
      /Invalid source archive: build\.js cannot be read \(permission denied\)\./
    );
  } finally {
    fs.chmodSync(bg, 0o644);
    fs.chmodSync(build, 0o644);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Code Babel parses but cannot walk (a `const` declared twice) is one file's failure, not
// the run's: the review finishes and reports it at its line, in the XPI and in a source
// archive alike, instead of ending as a tool failure.
test("code Babel cannot walk is reported at its line, not exit 2", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-walk-"));
  const xpi = path.join(dir, "xpi");
  const src = path.join(dir, "src");
  fs.mkdirSync(xpi);
  fs.mkdirSync(src);
  fs.writeFileSync(
    path.join(xpi, "manifest.json"),
    '{"manifest_version":3,"name":"x","version":"1","background":{"scripts":["bg.js"]}}'
  );
  fs.writeFileSync(path.join(xpi, "bg.js"), "const k = 1;\nconst k = 2;\n");
  fs.writeFileSync(
    path.join(src, "package.json"),
    '{"name":"x","version":"1.0.0"}'
  );
  // The lock a source submission owes; without it the review stops before the code checks.
  fs.writeFileSync(
    path.join(src, "package-lock.json"),
    '{"lockfileVersion":3,"packages":{"":{}}}'
  );
  fs.writeFileSync(path.join(src, "broken.js"), "let a;\nlet a;\n");
  try {
    const r = run([xpi, ...OFFLINE_FLAGS]);
    assert.equal(r.code, 1, r.stderr);
    assert.match(
      r.stdout,
      /bg\.js:2 - Identifier 'k' has already been declared\./
    );
    assert.doesNotMatch(r.stderr, /verify failed/);
    fs.writeFileSync(path.join(xpi, "bg.js"), "browser.runtime.id;\n");
    const sca = run([xpi, "--sca-root", src, ...OFFLINE_FLAGS]);
    assert.equal(sca.code, 1, sca.stderr);
    assert.match(
      sca.stdout,
      /broken\.js:2 - Identifier 'a' has already been declared\./
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// An XPI may hold no symbolic link, whichever file it is and however it arrives: the run
// refuses it as invalid, names the link, and reviews nothing - in an XPI review and as the
// XPI of a source review alike.
test("an XPI holding a symlink is invalid, exit 2", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-symlink-"));
  const xpi = path.join(dir, "xpi");
  const src = path.join(dir, "src");
  fs.mkdirSync(xpi);
  fs.mkdirSync(src);
  fs.writeFileSync(
    path.join(xpi, "real.json"),
    '{"manifest_version":3,"name":"x","version":"1"}'
  );
  fs.symlinkSync("real.json", path.join(xpi, "manifest.json"));
  fs.writeFileSync(
    path.join(src, "package.json"),
    '{"name":"x","version":"1.0.0"}'
  );
  const refusal =
    /Invalid XPI: manifest\.json is a symbolic link \(an add-on must contain regular files only\)\./;
  try {
    for (const args of [
      [xpi, ...OFFLINE_FLAGS],
      [xpi, "--sca-root", src, ...OFFLINE_FLAGS],
    ]) {
      const r = run(args);
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, refusal);
      assert.match(r.stderr, /verify failed/);
      assert.doesNotMatch(r.stdout, /Found Issues/);
    }
    // A packed XPI that stored an entry AS a link is the same refusal.
    const zip = new AdmZip();
    zip.addFile(
      "manifest.json",
      Buffer.from('{"manifest_version":3,"name":"x","version":"1"}')
    );
    zip.addFile("lib/a.js", Buffer.from("../../etc/passwd"));
    zip.getEntry("lib/a.js").attr = (0o120777 << 16) >>> 0;
    const packed = path.join(dir, "addon.xpi");
    zip.writeZip(packed);
    const r = run([packed, ...OFFLINE_FLAGS]);
    assert.equal(r.code, 2, r.stderr);
    assert.match(
      r.stderr,
      /Invalid XPI: lib\/a\.js is a symbolic link \(an add-on must contain regular files only\)\./
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
