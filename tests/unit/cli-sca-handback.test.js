// CLI-contract tests of the build check hand-back and its refusals, and of how a review treats
// submission files it cannot read or must not echo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { workPaths } from "../../src/util/dest.js";
import { MAX_NOTE } from "../../src/config.js";
import { cdnMissCache } from "../seed-caches.js";
import {
  ROOT,
  REVIEW,
  CACHE,
  OFFLINE_FLAGS,
  cacheFlags,
  headerValue,
  run,
  workOfReviewFile,
  reviewFile,
  defaultFolderOf,
  submissionFolder,
  packAddon,
  packSource,
  NO_LOCK_SOURCE,
  nameExperimentFolder,
  workOf,
  readJson,
  handBackRoots,
  handBackUntil,
  answerAnalyze,
} from "../cli-run.js";

// The prompt's one command is typed by its reader, and a submission folder is as likely to
// hold a space as not. Quoted where it matters and nowhere else: an unquoted path with a
// space in it is a second argument the hand-back refuses.
test("the build check quotes an argument that carries whitespace", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl sub mission-"));
  packAddon(path.join(dir, "addon  v2.xpi"));
  packSource(path.join(dir, "src.tar.gz"), NO_LOCK_SOURCE);
  const r = run([dir, "--llm-auto-review", ...OFFLINE_FLAGS]);
  assert.equal(r.code, 0, r.stderr);
  // The values above the command are read by eye, not typed, so they carry no quotes.
  assert.equal(
    headerValue(r.stdout, "SCA_SOURCE"),
    workPaths(workOf(r.stdout)).sca
  );
  assert.ok(headerValue(r.stdout, "SCA_SOURCE").startsWith(`${dir}/`));
  assert.match(
    r.stdout,
    new RegExp(`--llm-handback '${dir}/sca-review-addon__v2-`)
  );
  const handed = handBackRoots(r.stdout);
  assert.notEqual(handed.code, 2, handed.stdout + handed.stderr);
  assert.equal(
    readJson(workOf(r.stdout), "state").submission.xpi,
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
  const r = run([dir, "--llm-auto-review", ...OFFLINE_FLAGS]);
  assert.equal(r.code, 0, r.stderr);
  const work = workOf(r.stdout);
  const handed = handBackRoots(r.stdout, {
    typed: (w) => `${path.relative(process.cwd(), w)}/`,
  });
  assert.notEqual(handed.code, 2, handed.stdout + handed.stderr);
  assert.ok(fs.existsSync(workPaths(work).state), "the review starts in it");
  assert.ok(handed.stdout.includes(`${work}/`), handed.stdout);
  fs.rmSync(dir, { recursive: true, force: true });
});

// One run of the early-exit checks per path, once ctx holds every artifact they read: with a
// source, the linter extracts the archive first and the agent names the Experiment folder, so a
// rejected Experiment costs that one answer. The early-exit checks then run in the
// experiment-folder case and reject it, and the review closes at once, the same close
// --llm-review of the .xpi gives. An Experiment the review accepts goes on to its build check,
// and either way the verdict is recorded by the run that decides it, for every later run.
test("--llm-auto-review has an Experiment it would reject extracted first, then closed", () => {
  const submission = (fixture) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-exp-gate-"));
    const zip = new AdmZip();
    zip.addLocalFolder(path.join(ROOT, "tests", "addons", fixture));
    zip.writeZip(path.join(dir, "addon.xpi"));
    packSource(path.join(dir, "src.tar.gz"), NO_LOCK_SOURCE, "experiment");
    return dir;
  };
  const dir = submission("experiment-disallowed");
  const r = run([dir, "--llm-auto-review", ...OFFLINE_FLAGS]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /── SCA Review Prompt ──/);
  const work = defaultFolderOf(path.join(dir, "addon.xpi"), "sca");
  assert.equal(readJson(work, "state").current.mode, "experiment-folder");
  const closed = nameExperimentFolder(r.stdout, {
    experimentsFolder: "experiment",
  });
  assert.equal(closed.code, 1, closed.stdout + closed.stderr);
  assert.match(closed.stdout, /── LLM Prompt ──/);
  assert.match(closed.stdout, /The review was aborted/);
  // Nothing was started: the closing prompt has no file to hand back, and the record holds
  // the review as the early-exit checks produced it, closed.
  assert.ok(fs.existsSync(workPaths(work).report), "review.md is written");
  const record = readJson(work, "state");
  assert.deepEqual(record.current, { mode: "review", phase: "close" });
  assert.deepEqual(record.review.report.meta.checksRun, [
    "experiment-not-allowed",
  ]);
  assert.deepEqual(
    record.verification.groups.map((g) => [g.status, g.rejected]),
    [["unsupported", true]]
  );
  fs.rmSync(dir, { recursive: true, force: true });

  for (const [fixture, extra] of [
    ["experiment-disallowed", ["--allow-experiments"]],
    ["experiment-pristine", []],
  ]) {
    const allowed = submission(fixture);
    const first = run([
      allowed,
      "--llm-auto-review",
      ...OFFLINE_FLAGS,
      ...extra,
    ]);
    assert.equal(first.code, 0, first.stderr);
    const analyze = nameExperimentFolder(first.stdout, {
      experimentsFolder: "experiment",
    });
    assert.equal(analyze.code, 0, analyze.stdout + analyze.stderr);
    assert.match(analyze.stdout, /── SCA Review Prompt ──/, fixture);
    // The verdict is recorded where it is decided, so the review the build check starts
    // takes it as its own rather than asking again.
    const record = readJson(
      defaultFolderOf(path.join(allowed, "addon.xpi"), "sca"),
      "state"
    );
    assert.equal(record.current.step, "analyze", fixture);
    assert.deepEqual(
      record.verification.groups.map((g) => [g.status, g.rejected]),
      [[fixture === "experiment-pristine" ? "pristine" : "unsupported", false]],
      fixture
    );
    fs.rmSync(allowed, { recursive: true, force: true });
  }
});

// A folder the linter put in the work folder that is gone when the folder is handed back is
// not the agent's to correct, in a build check and in a started review alike: the tool's
// failure, exit 2, on stderr, before anything is read or written.
test("a hand-back whose work folder lost a folder the linter made is exit 2", () => {
  const lost = (work, name) => {
    fs.rmSync(path.join(work, name), { recursive: true, force: true });
    const r = run(["--llm-handback", work]);
    assert.equal(r.code, 2, `${name}: ${r.stdout}${r.stderr}`);
    assert.match(
      r.stderr,
      new RegExp(
        `for this review: ${name}/ is gone\\. It cannot be carried on`
      ),
      name
    );
    assert.match(r.stderr, /verify failed/, name);
    assert.doesNotMatch(r.stdout, /refused|LLM Prompt/, name);
    return r;
  };

  // A build check past `unpack`, at `analyze`.
  const dir = submissionFolder();
  const begun = run([dir, "--llm-auto-review", ...OFFLINE_FLAGS]);
  assert.equal(begun.code, 0, begun.stderr);
  assert.equal(nameExperimentFolder(begun.stdout).code, 0);
  const work = workOf(begun.stdout);
  assert.equal(readJson(work, "state").current.step, "analyze");
  lost(work, "xpi");
  assert.equal(
    readJson(work, "state").current.step,
    "analyze",
    "nothing written"
  );

  // A started XPI review.
  const xpiDir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-lost-"));
  const xpi = path.join(xpiDir, "addon.xpi");
  packAddon(xpi);
  const started = run([xpi, "--llm-review", ...OFFLINE_FLAGS]);
  assert.equal(started.code, 0, started.stderr);
  lost(workOfReviewFile(reviewFile(started.stdout)), "xpi");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(xpiDir, { recursive: true, force: true });
});

// A broken add-on fails in the load, the first step of every path: before a source is
// copied or a build check started, and with nothing left behind. A link in a packed .xpi,
// here, in a source review an agent runs and in --llm-auto-review alike.
test("a broken .xpi fails before any build check starts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-broken-"));
  const zip = new AdmZip();
  zip.addFile(
    "manifest.json",
    Buffer.from('{"manifest_version":3,"name":"x","version":"1"}')
  );
  zip.addFile("lib/a.js", Buffer.from("../../etc/passwd"));
  zip.getEntry("lib/a.js").attr = (0o120777 << 16) >>> 0;
  const xpi = path.join(dir, "addon.xpi");
  zip.writeZip(xpi);
  const src = path.join(dir, "src");
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "package.json"), '{"name":"x"}');
  fs.writeFileSync(path.join(dir, "src.tar.gz"), "");
  for (const args of [
    [xpi, "--llm-review", "--sca-extracted", src],
    [dir, "--llm-auto-review"],
  ]) {
    const r = run([...args, ...OFFLINE_FLAGS]);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /Invalid XPI: lib\/a\.js is a symbolic link/);
    assert.doesNotMatch(r.stdout, /SCA Review Prompt/);
    assert.deepEqual(fs.readdirSync(dir).sort(), [
      "addon.xpi",
      "src",
      "src.tar.gz",
    ]);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// The build check records every cache its review is to read, given or default, as one
// absolute name: a hand-back started from another directory reads the same caches.
test("the build check records every cache as an absolute path", () => {
  // An add-on with Experiments, whose first run stops at the experiment-folder question
  // before any cache is read.
  const dir = submissionFolder("addon.xpi", {
    manifest: { experiment_apis: { foo: {} } },
    experimentsFolder: "experiment",
  });
  const cwd = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "wl-cwd-"))
  );
  const r = spawnSync(
    process.execPath,
    [REVIEW, dir, "--llm-auto-review", "--cache-schema-dir", "mycache"],
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
// --llm-auto-review would record it for the review it starts, which would then fail on it.
// Answered before any branch, so no prompt is printed at all.
test("an unknown check id is refused before a prompt is printed", () => {
  const dir = submissionFolder();
  const sca = run([dir, "--llm-auto-review", "--checks-only", "no-such-check"]);
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

// --verbose is recorded with the review's other flags, so its hand-backs run verbose without
// being told: the unpack hand-back populates ctx, and its debug lines are held with stderr,
// never printed into the prompt on stdout.
test("a review started with --verbose runs its hand-backs verbose", () => {
  // An add-on with Experiments, so the review starts in the hand-back that names the folder.
  const dir = submissionFolder("addon.xpi", {
    manifest: { experiment_apis: { foo: {} } },
    experimentsFolder: "experiment",
  });
  const begun = run([
    dir,
    "--llm-auto-review",
    "--verbose",
    "--allow-experiments",
    ...OFFLINE_FLAGS,
  ]);
  assert.equal(begun.code, 0, begun.stderr);
  assert.equal(readJson(workOf(begun.stdout), "state").flags.verbose, true);
  const unpacked = nameExperimentFolder(begun.stdout, {
    experimentsFolder: "experiment",
  });
  assert.equal(unpacked.code, 0, unpacked.stderr);
  assert.ok(!unpacked.stdout.includes("schema files from"), unpacked.stdout);
  assert.match(unpacked.stderr, /── Tool messages ──[\s\S]*schema files from/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Each way the flag cannot be used, refused before it prints anything - it starts its own
// review, so it shares no run with the flags that do.
test("--llm-auto-review refuses what it cannot be combined with", () => {
  const dir = submissionFolder();
  const cases = [
    [["--sca-package-root", "src"], /works out --sca-package-root for you/],
    [["--llm-review"], /starts its own review/],
    [["--llm-handback", "work"], /nothing goes beside the work folder/],
    [["--report-format", "json"], /--llm-auto-review is text only/],
    // A SECOND add-on argument: the flag reads the first one as the submission.
    [
      ["x.xpi"],
      /Only one submission can be reviewed at a time, and 2 were given/,
    ],
  ];
  for (const [extra, message] of cases) {
    const r = run([dir, "--llm-auto-review", ...extra]);
    assert.equal(r.code, 2, extra.join(" "));
    assert.match(r.stderr, message, extra.join(" "));
    assert.doesNotMatch(r.stdout, /SCA Review Prompt/, extra.join(" "));
  }
  // And the add-on argument it reads is REQUIRED: this flag changes what that argument
  // means, it does not carry the folder itself.
  const none = run(["--llm-auto-review"]);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /reviews a submission folder - one \.xpi/);
  assert.match(none.stderr, /and none was given/);
  assert.doesNotMatch(none.stdout, /SCA Review Prompt/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --llm-auto-review reviews a submission folder only: an .xpi on its own is reviewed with
// --llm-review, and anything that is no folder is refused before anything is made, as is a
// folder with no .xpi in it. The flag it replaced is no option any more.
test("--llm-auto-review takes a submission folder only, and refuses the rest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-auto-"));
  const xpi = path.join(dir, "addon.xpi");
  packAddon(xpi);
  const notXpi = path.join(dir, "addon.zip");
  fs.writeFileSync(notXpi, "x");
  const unpacked = path.join(ROOT, "tests", "addons", "clean");
  for (const given of [xpi, notXpi, path.join(dir, "missing.xpi"), unpacked]) {
    const r = run([given, "--llm-auto-review", ...OFFLINE_FLAGS]);
    assert.equal(r.code, 2, given);
    assert.match(
      r.stderr,
      given === unpacked
        ? /a submission folder holds exactly one \.xpi/
        : /reviews a submission folder - .* - and ".*" is not one/,
      given
    );
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), ["addon.xpi", "addon.zip"]);
  const old = run([xpi, "--llm-sca-review"]);
  assert.equal(old.code, 2);
  assert.match(old.stderr, /Unknown option '--llm-sca-review'/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A submission without source is reviewed as its .xpi: the same first prompt, in the .xpi's
// own work folder inside the submission, and no build check of a source review is made.
test("--llm-auto-review reviews a folder holding only an .xpi as that .xpi", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-auto-xpi-"));
  const xpi = path.join(dir, "addon.xpi");
  packAddon(xpi);
  const auto = run([dir, "--llm-auto-review", ...OFFLINE_FLAGS]);
  assert.equal(auto.code, 0, auto.stderr);
  const autoWork = workOfReviewFile(reviewFile(auto.stdout));
  assert.equal(path.dirname(autoWork), path.resolve(dir));
  assert.match(path.basename(autoWork), /^xpi-review-addon-/);
  assert.ok(!fs.readdirSync(dir).some((n) => n.startsWith("sca-review-")));
  assert.ok(!fs.existsSync(workPaths(autoWork).prepare));
  fs.rmSync(autoWork, { recursive: true, force: true });

  const plain = run([xpi, "--llm-review", ...OFFLINE_FLAGS]);
  assert.equal(plain.code, 0, plain.stderr);
  const prompt = (out) =>
    out.stdout
      .slice(out.stdout.indexOf("── LLM Prompt ──"))
      .split(workOfReviewFile(reviewFile(out.stdout)))
      .join("<WORK>");
  assert.equal(prompt(auto), prompt(plain));
  fs.rmSync(dir, { recursive: true, force: true });
});

// A folder that is not a submission fails here, where the reviewer can see it, rather than
// handing back a command aimed at a file nobody submitted.
test("--llm-auto-review refuses a folder that is not a submission", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-empty-"));
  const r = run([dir, "--llm-auto-review"]);
  assert.equal(r.code, 2);
  // The flag's name and the value that was given are the front-end's half of the message;
  // what was found in the folder is the loader's.
  assert.match(r.stderr, new RegExp(`--llm-auto-review "${dir}":`));
  assert.match(
    r.stderr,
    /a submission folder holds exactly one \.xpi and at most one other archive/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// An answer in a reviewer's own words too long to become a note is refused at the hand-back,
// as the `refused` text the agent reads, so it can ask that question again. Taken instead,
// it would be refused only once the review settles, which no hand-back can redo.
test("an answer too long to be a note is refused at the hand-back", () => {
  const addon = path.join(ROOT, "tests", "addons", "clean");
  const first = run([
    addon,
    ...OFFLINE_FLAGS,
    "--llm-review",
    "--llm-skip-sweep",
  ]);
  assert.equal(first.code, 0, first.stderr);
  const file = reviewFile(first.stdout);

  let out = run(["--llm-handback", workOfReviewFile(file)]);
  // Every prompt but the closing one ends on the command that hands it back.
  while (/^\s+node verify\.js --llm-handback /m.test(out.stdout)) {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.entries = doc.entries.map((e) => ({
      ...e,
      answer: "answers".repeat(400),
    }));
    fs.writeFileSync(file, JSON.stringify(doc, null, 1));
    out = run(["--llm-handback", workOfReviewFile(file)]);
  }
  assert.equal(out.code, 2, out.stdout);
  assert.ok(out.stdout.includes("The hand-back was refused: "), out.stdout);
  assert.ok(
    out.stdout.includes(
      `carries a 2800-character answer and the limit is ${MAX_NOTE}`
    ),
    out.stdout
  );
  assert.ok(!out.stderr.includes("verify failed"), out.stderr);
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
    "--sca-extracted",
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
  const r = run([xpi, "--sca-extracted", root, ...OFFLINE_FLAGS]);
  assert.match(r.stdout, /evil \[2K \[1Aname/, "the folder was named");
  assert.ok(!r.stdout.includes("\u001b"), "raw ESC on stdout");
  assert.ok(!r.stderr.includes("\u001b"), "raw ESC on stderr");
  fs.rmSync(dir, { recursive: true, force: true });
});

// An unreadable submission file makes it invalid: exit 2 and one sentence naming the artifact,
// the file and why, before any check runs - never a review that read it as empty. In a named
// source it is the copy into the work folder that fails, as it does for a build check.
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
    // The same in a source archive, which cannot be copied.
    fs.chmodSync(bg, 0o644);
    fs.chmodSync(build, 0o000);
    const sca = run([xpi, "--sca-extracted", src, ...OFFLINE_FLAGS]);
    assert.equal(sca.code, 2, sca.stderr);
    assert.match(
      sca.stderr,
      /The source ".*src" could not be copied into the work folder \(EACCES\)\./
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
    const sca = run([xpi, "--sca-extracted", src, ...OFFLINE_FLAGS]);
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
      [xpi, "--sca-extracted", src, ...OFFLINE_FLAGS],
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

// "Restart as an XPI review": the hand-back of an aborted source review whose XPI is
// readable starts the XPI review itself, in a work folder of its own, with the flags the
// source review was started with minus every --sca-* one, and prints its first prompt. Its
// report tells the developer the archive was not needed. The source review's folder stays
// as it is. A plain --llm-review of the same XPI carries no such finding.
test("restarting an aborted source review starts an XPI review of its own", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-downgrade-"));
  const xpi = path.join(dir, "addon");
  const src = path.join(dir, "src");
  const files = {
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "Readable",
      version: "1.0",
      background: { scripts: ["bg.js"] },
    }),
    "bg.js": "console.log('readable shipped code');\n",
  };
  fs.mkdirSync(xpi);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(xpi, name), content);
  }
  // No package.json: the source review aborts on it, which the XPI review cures.
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "bg.js"), "console.log('source');\n");
  const flags = cacheFlags(CACHE, cdnMissCache(dir));
  try {
    const started = run([
      xpi,
      "--sca-extracted",
      src,
      "--llm-review",
      "--warnings-as-errors",
      ...flags,
    ]);
    assert.equal(started.code, 0, started.stderr);
    // With no package.json there is no lock to audit, so the build check is done at analyze,
    // nobody asked, and the review starts there.
    const begun = run(answerAnalyze(started.stdout));
    assert.notEqual(begun.code, 2, begun.stdout + begun.stderr);
    const scaWork = defaultFolderOf(xpi, "sca");
    // The missing package.json aborts the review late: its passes run first, and the
    // question is put once they are done.
    const { state: scaState, out: asked } = handBackUntil(scaWork, "downgrade");
    assert.equal(scaState.phase, "downgrade");
    // The question is answered with a hand-back, so the review is unfinished and the run
    // that put it exits 0, though the aborted review holds an error.
    assert.equal(asked.code, 0, asked.stderr);
    const scaFlags = readJson(scaWork, "state").flags;
    assert.ok(
      !Object.keys(scaFlags).some((name) => name.startsWith("sca-")),
      JSON.stringify(scaFlags)
    );
    assert.equal(scaFlags["warnings-as-errors"], true);

    const file = workPaths(scaWork).answers;
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.entries[0].answer = "Restart as an XPI review";
    fs.writeFileSync(file, JSON.stringify(doc, null, 1));
    const before = fs.readFileSync(workPaths(scaWork).state, "utf8");
    const handed = run(["--llm-handback", scaWork]);
    assert.equal(handed.code, 0, handed.stderr);
    assert.equal(
      fs.readFileSync(workPaths(scaWork).state, "utf8"),
      before,
      "the source review's folder stays as it is"
    );

    const xpiWork = defaultFolderOf(xpi, "xpi");
    assert.ok(handed.stdout.includes(workPaths(xpiWork).answers), "its prompt");
    const xpiRecord = readJson(xpiWork, "state");
    const xpiState = xpiRecord.current;
    assert.equal(xpiState.run.sca, false);
    assert.equal(xpiState.run.warningsAsErrors, true);
    assert.deepEqual(xpiRecord.flags, scaFlags);
    assert.deepEqual(
      xpiState.report.findings
        .filter((f) => f.ruleId === "sca-not-needed")
        .map((f) => f.severity),
      ["info"]
    );

    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-plain-"));
    const plainXpi = path.join(plainDir, "addon");
    fs.cpSync(xpi, plainXpi, { recursive: true });
    const plain = run([plainXpi, "--llm-review", ...flags]);
    assert.notEqual(plain.code, 2, plain.stderr);
    assert.ok(
      !readJson(
        defaultFolderOf(plainXpi, "xpi"),
        "state"
      ).current.report.findings.some((f) => f.ruleId === "sca-not-needed")
    );
    fs.rmSync(plainDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
