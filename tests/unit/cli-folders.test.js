// CLI-contract tests of the folders a run reads and writes: the work folder, links, folder
// flags judged by where they land, and the usage errors.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { addonOutsideRepo } from "../seed-caches.js";
import {
  ROOT,
  REVIEW,
  OFFLINE_FLAGS,
  headerValue,
  runFile,
  run,
  defaultFolderOf,
} from "../cli-run.js";

// The linter reads a submission from disk once, whether or not an agent is involved: a
// packed .xpi is extracted into the work folder, under the one name every review uses, and
// read back from there.
test("a plain review of a packed .xpi extracts it into the work folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-plain-extract-"));
  const zip = new AdmZip();
  zip.addFile(
    "manifest.json",
    Buffer.from('{"manifest_version":3,"name":"x","version":"1"}')
  );
  zip.addFile("bg.js", Buffer.from("browser.runtime.id;\n"));
  const file = path.join(dir, "addon.xpi");
  zip.writeZip(file);

  const r = run([file, ...OFFLINE_FLAGS]);
  assert.notEqual(r.code, 2, r.stderr);
  // The review gets its folder beside the add-on, named after it.
  const work = defaultFolderOf(file, "xpi");
  const extracted = path.join(work, "xpi");
  assert.equal(
    fs.readFileSync(path.join(extracted, "manifest.json"), "utf8"),
    '{"manifest_version":3,"name":"x","version":"1"}'
  );
  assert.equal(
    fs.readFileSync(path.join(extracted, "bg.js"), "utf8"),
    "browser.runtime.id;\n"
  );
  // The terminal header names which add-on and where to read it, in place of the raw
  // .xpi path.
  assert.equal(headerValue(r.stdout, "XPI_FILE"), "addon.xpi");
  assert.equal(headerValue(r.stdout, "XPI_ROOT"), `${extracted}${path.sep}`);
  // A plain review writes nothing else there: its report is printed.
  assert.deepEqual(fs.readdirSync(work), ["xpi"]);

  fs.rmSync(dir, { recursive: true, force: true });
});

// An unpacked submission is copied into the work folder like a packed one is extracted
// there, so XPI_ROOT is the same name in every review - and the submission is only read: its
// folder gets nothing but the work folder beside it.
test("a folder add-on is copied into the work folder and its parent left alone", () => {
  const addon = addonOutsideRepo(path.join(ROOT, "tests", "addons", "clean"));
  const before = fs.readdirSync(addon).sort();
  const r = run([addon, ...OFFLINE_FLAGS]);
  assert.notEqual(r.code, 2, r.stderr);
  const work = defaultFolderOf(addon, "xpi");
  const copy = path.join(work, "xpi");
  assert.equal(headerValue(r.stdout, "XPI_ROOT"), `${copy}${path.sep}`);
  assert.deepEqual(fs.readdirSync(copy).sort(), before);
  assert.deepEqual(
    fs.readFileSync(path.join(copy, "manifest.json")),
    fs.readFileSync(path.join(addon, "manifest.json"))
  );
  assert.deepEqual(fs.readdirSync(addon).sort(), before);
  assert.deepEqual(fs.readdirSync(path.dirname(addon)).sort(), [
    "clean",
    path.basename(work),
  ]);
});

// A start that fails after the add-on was copied - here a source review of an Experiment
// without --sca-exp-source, which fails once its XPI is read - gives back the folder it
// created, so the same command can simply run again.
test("a failed start leaves the work folder as it found it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-failed-start-"));
  const xpi = path.join(dir, "xpi");
  const src = path.join(dir, "src");
  fs.mkdirSync(xpi);
  fs.mkdirSync(src);
  fs.writeFileSync(
    path.join(xpi, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Exp",
      version: "1.0",
      experiment_apis: { myapi: {} },
    })
  );
  fs.writeFileSync(path.join(src, "package.json"), "{}");
  const argv = [
    xpi,
    "--sca-root",
    src,
    "--allow-experiments",
    "--llm-review",
    ...OFFLINE_FLAGS,
  ];
  for (let i = 0; i < 2; i++) {
    const r = run(argv);
    assert.equal(r.code, 2, `run ${i + 1}`);
    assert.match(r.stderr, /--sca-exp-source/, `run ${i + 1}`);
    assert.doesNotMatch(r.stderr, /must not exist/, `run ${i + 1}`);
    assert.deepEqual(
      fs.readdirSync(dir).sort(),
      ["src", "xpi"],
      `run ${i + 1}`
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// A review's work folder is always its default, beside the add-on, and the only run that
// names an existing one is --llm-handback: --work-folder is no option, for any run.
test("--work-folder is an unknown option", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-work-flag-"));
  for (const argv of [
    ["x.xpi", "--work-folder", dir],
    [dir, "--llm-sca-review", "--work-folder", dir],
    ["--llm-handback", dir, "--work-folder", dir],
  ]) {
    const r = run(argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.stderr, /Unknown option '--work-folder'/, argv.join(" "));
  }
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Everything under --sca-root is reviewed as the source, so the add-on may never lie inside
// it - nor be it. Every folder argument is the folder it really is, so a link in a path
// changes none of this, and nothing is created.
test("--sca-root must not include the add-on", () => {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "wl-work-sca-"))
  );
  const proj = path.join(dir, "proj");
  const addon = path.join(proj, "dist", "addon");
  fs.cpSync(path.join(ROOT, "tests", "addons", "clean"), addon, {
    recursive: true,
  });
  fs.writeFileSync(path.join(proj, "package.json"), "{}");
  const link = path.join(dir, "link");
  fs.symlinkSync(proj, link);
  const before = fs.readdirSync(path.join(proj, "dist"));
  for (const [named, root] of [
    [addon, proj],
    [path.join(link, "dist", "addon"), proj],
    [addon, link],
    [addon, addon],
  ]) {
    const r = run([named, "--sca-root", root]);
    assert.equal(r.code, 2, named);
    const realRoot = root === link ? proj : root;
    assert.equal(
      r.stderr,
      `--sca-root "${realRoot}" must not include the add-on "${addon}".\n`,
      `${named} in ${root}`
    );
  }
  assert.deepEqual(fs.readdirSync(path.join(proj, "dist")), before);
  // Without --sca-root nothing is reviewed in place, and the default beside it is fine.
  const xpiOnly = run([addon, ...OFFLINE_FLAGS]);
  assert.notEqual(xpiOnly.code, 2, xpiOnly.stderr);
  const work = defaultFolderOf(addon, "xpi");
  assert.ok(fs.existsSync(path.join(work, "xpi", "manifest.json")));
  fs.rmSync(dir, { recursive: true, force: true });
});

// The work folder says what kind of review it holds: `xpi-review-` for a review of the XPI
// alone, plain or with --llm-review, and `sca-review-` for a source code review, whether it
// is prepared with --llm-sca-review or started with --sca-root.
test("the work folder is named by the kind of review", () => {
  const madeBeside = (target, args) => {
    const parent = path.dirname(target);
    const before = new Set(fs.readdirSync(parent));
    const r = run([target, ...args]);
    assert.notEqual(r.code, 2, r.stderr);
    const made = fs.readdirSync(parent).filter((n) => !before.has(n));
    assert.equal(made.length, 1, args.join(" "));
    return made[0];
  };
  const clean = path.join(ROOT, "tests", "addons", "clean");
  for (const args of [OFFLINE_FLAGS, ["--llm-review", ...OFFLINE_FLAGS]]) {
    const name = madeBeside(addonOutsideRepo(clean), args);
    assert.ok(name.startsWith("xpi-review-clean-"), name);
  }
  const fixture = path.join(ROOT, "tests", "addons", "build-hygiene-sca");
  for (const extra of [[], ["--llm-review"]]) {
    const src = addonOutsideRepo(path.join(fixture, "src"));
    const name = madeBeside(addonOutsideRepo(path.join(fixture, "xpi")), [
      "--sca-root",
      src,
      ...extra,
      ...OFFLINE_FLAGS,
    ]);
    assert.ok(name.startsWith("sca-review-xpi-"), name);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-kind-"));
  const zip = new AdmZip();
  zip.addFile(
    "manifest.json",
    Buffer.from('{"manifest_version":2,"name":"x","version":"1"}')
  );
  zip.writeZip(path.join(dir, "a.xpi"));
  fs.writeFileSync(path.join(dir, "src.zip"), "");
  const before = new Set(fs.readdirSync(dir));
  const prepared = run(["--llm-sca-review", dir]);
  assert.equal(prepared.code, 0, prepared.stderr);
  const made = fs.readdirSync(dir).filter((n) => !before.has(n));
  assert.equal(made.length, 1);
  assert.ok(made[0].startsWith("sca-review-a-"), made[0]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A folder named through a link is the folder it names: an add-on is copied from its
// target, and a source root is reviewed where it really is.
test("folders named through a link are reviewed as their targets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-work-link-"));
  const addonLink = path.join(dir, "addon");
  const target = addonOutsideRepo(path.join(ROOT, "tests", "addons", "clean"));
  fs.symlinkSync(target, addonLink);
  const r = run([addonLink, ...OFFLINE_FLAGS]);
  assert.notEqual(r.code, 2, r.stderr);
  // The work folder goes beside the target, the folder the add-on really is.
  const work = defaultFolderOf(target, "xpi");
  assert.ok(fs.existsSync(path.join(work, "xpi", "manifest.json")));
  const fixture = path.join(ROOT, "tests", "addons", "build-hygiene-sca");
  const srcLink = path.join(dir, "src");
  fs.symlinkSync(path.join(fixture, "src"), srcLink);
  const sca = run([
    path.join(fixture, "xpi"),
    "--sca-root",
    srcLink,
    ...OFFLINE_FLAGS,
  ]);
  assert.notEqual(sca.code, 2, sca.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Files are never followed: the .xpi named, and the files of a submission folder, must be
// the files themselves. The folder holding them may be a link.
test("an .xpi or a source archive given through a link is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-file-link-"));
  const real = path.join(dir, "real");
  fs.mkdirSync(real);
  const zip = new AdmZip();
  zip.addFile(
    "manifest.json",
    Buffer.from('{"manifest_version":2,"name":"x","version":"1"}')
  );
  zip.writeZip(path.join(real, "a.xpi"));
  fs.writeFileSync(path.join(real, "src.zip"), "");
  const linkedXpi = path.join(dir, "linked.xpi");
  fs.symlinkSync(path.join(real, "a.xpi"), linkedXpi);
  const r = runFile(REVIEW, [linkedXpi]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /The add-on ".+linked\.xpi" is a symlink/);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["linked.xpi", "real"]);

  // A submission folder named through a link is accepted ...
  const folderLink = path.join(dir, "submission");
  fs.symlinkSync(real, folderLink);
  const prepared = run(["--llm-sca-review", folderLink]);
  assert.equal(prepared.code, 0, prepared.stderr);
  // ... but not a submission whose files are links.
  for (const name of ["a.xpi", "src.zip"]) {
    const sub = path.join(dir, `sub-${name}`);
    fs.mkdirSync(sub);
    for (const file of ["a.xpi", "src.zip"]) {
      const target = path.join(real, file);
      if (file === name) {
        fs.symlinkSync(target, path.join(sub, file));
      } else {
        fs.copyFileSync(target, path.join(sub, file));
      }
    }
    const refused = run(["--llm-sca-review", sub]);
    assert.equal(refused.code, 2, name);
    assert.match(
      refused.stderr,
      new RegExp(`"${name.replace(".", "\\.")}" is a symlink`),
      name
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// A flag given with no value names something and says nothing. Asked of EVERY option that
// takes one, before any branch reads one: parseArgs hands "--flag=" down as "", which every
// reader tests for truth and so reads as "not given" - a named cache would silently be the
// default one, a named verdict file would print an unsettled report, a named format would
// fall back to text, and a named source root would review the XPI alone. Whitespace counts
// as none.
test("a flag given no value is refused (exit 2)", () => {
  for (const [argv, flag] of [
    [["some.xpi", "--report-format="], "--report-format"],
    [["some.xpi", "--checks-only="], "--checks-only"],
    [["some.xpi", "--cache-schema-dir="], "--cache-schema-dir"],
    [["some.xpi", "--llm-handback="], "--llm-handback"],
    [["some.xpi", "--sca-root="], "--sca-root"],
    [["some.xpi", "--sca-root", " "], "--sca-root"],
  ]) {
    const r = run(argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.stderr, new RegExp(`\\${flag} needs a value`), flag);
  }
  // --help is a request for the usage text, not a run: it is answered before this.
  assert.equal(run(["--help", "--report-format="]).code, 0);
});

// The guard asks the LOADER which folder a value names, rather than spelling the path math
// a second time. Spelled twice, ".src" validates as ".src" (found) and reads as "src" - a
// real folder, but not the one named, reviewed in silence. Pinned from the CLI end, because
// what fails there is the two ends disagreeing.
test("a folder flag is checked against the folder the review will read", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-dotdir-"));
  fs.mkdirSync(path.join(dir, "src"));

  // Only src/ exists: naming .src refuses, rather than reviewing src/ without a word.
  const missing = run([
    "some.xpi",
    "--sca-root",
    dir,
    "--sca-exp-source",
    ".src",
  ]);
  assert.equal(missing.code, 2);
  assert.match(
    missing.stderr,
    /--sca-exp-source must point at a folder: "[^"]*\/\.src"/
  );
  assert.match(missing.stderr, new RegExp(`${dir}/\\.src`), "looked in .src");

  // With the folder there, it passes this guard and the run reaches the next refusal.
  fs.mkdirSync(path.join(dir, ".src"));
  const ok = run(["some.xpi", "--sca-root", dir, "--sca-exp-source", ".src"]);
  // The run goes on to fail on the missing add-on instead, which is the point: this guard
  // no longer has anything to say about it.
  assert.doesNotMatch(ok.stderr, /must point at a folder/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Where a folder flag LANDS is the question, asked with the loader's own relativeInside so
// the guard and the review cannot answer it differently: a path resolving outside
// --sca-root names a folder on the reviewing machine. How it was spelled - a ".." segment
// included - makes no difference. For --sca-exp-source "nothing to exclude" is also the
// legitimate answer for an Experiment outside the source, so the mistake would not
// announce itself.
test("a folder flag is judged by where it lands, however it was spelled (exit 2 outside the root)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-folder-"));
  fs.mkdirSync(path.join(dir, "src"));

  // A folder INSIDE --sca-root may be named either way - relative to the root, or absolute,
  // which is the spelling the report prints and a reader hands straight back. What is
  // refused is where it LANDS: outside the root it names a folder on the reviewing machine,
  // so what it names is not the submission's and cannot be shown to be.
  const inside = run([
    "some.xpi",
    "--sca-root",
    dir,
    "--sca-exp-source",
    path.join(dir, "src"),
  ]);
  assert.doesNotMatch(
    inside.stderr,
    /--sca-exp-source/,
    "an absolute path inside is taken"
  );
  for (const argv of [
    ["some.xpi", "--sca-root", dir, "--sca-exp-source", "/tmp"],
    ["some.xpi", "--sca-root", dir, "--sca-exp-source", "../outside"],
  ]) {
    const r = run(argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.stderr, /which is outside/, argv.join(" "));
  }

  // A ".." segment is no reason to refuse: where it lands, the folder is the one named.
  for (const argv of [
    ["some.xpi", "--sca-root", `${dir}/../${path.basename(dir)}`],
    [
      "some.xpi",
      "--sca-root",
      dir,
      "--sca-exp-source",
      `../${path.basename(dir)}/src`,
    ],
  ]) {
    const r = run(argv);
    assert.doesNotMatch(r.stderr, /--sca-(root|exp-source)/, argv.join(" "));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// One add-on per run. A second positional silently ignored is how an unquoted path with a
// space in it would review the half before the space and say nothing about the rest - the
// shape --llm-sca-review's printed command could produce.
test("a second positional is refused (exit 2)", () => {
  const r = run(["some.xpi", "another.xpi"]);
  assert.equal(r.code, 2);
  assert.match(
    r.stderr,
    /Only one add-on can be reviewed at a time, and 2 were given/
  );
  assert.match(r.stderr, /"[^"]*some\.xpi", "another\.xpi"/);
});

// --help is a request for the usage text, not a run, so it is answered before every guard
// that judges the command line - a reader asking what the flags ARE is told, rather than
// refused over a flag this run will never reach. The two exceptions are the things that
// make an answer impossible: a command line that does not parse (and a registry that does
// not load, which no flag can reach).
test("--help is answered before every guard that judges a run", () => {
  for (const extra of [
    [],
    ["--report-format", "xml"],
    ["--llm-skip-manual"],
    ["--sca-root="],
    ["--checks-only", "no-such-check"],
    ["some.xpi", "another.xpi"],
  ]) {
    const r = run(["--help", ...extra]);
    assert.equal(r.code, 0, extra.join(" "));
    assert.match(r.stdout, /webext-linter - verify/, extra.join(" "));
    assert.equal(r.stderr, "", extra.join(" "));
  }
  // A command line that cannot be parsed has no flags to explain: the usage text comes
  // with the refusal, and the exit code says it was one.
  const unparsable = run(["--nope", "--help"]);
  assert.equal(unparsable.code, 2);
  assert.match(unparsable.stderr, /Unknown option/);
});

// No positional argument is a usage error: usage to stdout, exit 2.
test("no add-on argument prints usage and exits 2", () => {
  const r = run([]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /--checks-only/);
});

// An invalid --report-format is rejected before any work, on stderr, exit 2.
test("invalid --report-format errors to stderr and exits 2", () => {
  const r = run(["some.xpi", "--report-format", "bogus"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Invalid --report-format/);
});

// An unknown --checks-only id is rejected (validated against the registry) on
// stderr, exit 2.
test("unknown --checks-only id errors to stderr and exits 2", () => {
  const r = run(["some.xpi", "--checks-only", "no-such-check"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown check/);
});
