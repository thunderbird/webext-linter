// CLI-contract tests of verify.js options: --help, the cache flags, and the options and
// arguments a run refuses with exit 2.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { pipelineOptsFromArgv } from "../../src/cli.js";
import { advisory } from "../prepared.js";
import {
  addonOutsideRepo,
  osvEntries,
  popularityEntries,
  seedWorkCache,
} from "../seed-caches.js";
import { REVIEW, OFFLINE_FLAGS, runFile, FIXTURES, run } from "../cli-run.js";

// --help prints the usage (the check-id list and the verify.js command) to
// stdout, nothing to stderr, and exits 0.
test("--help prints usage to stdout and exits 0", () => {
  const r = run(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--checks-only/);
  assert.match(r.stdout, /node verify\.js/);
  assert.doesNotMatch(r.stdout, /node review\.js|node build\.js|node lint\.js/);
  assert.equal(r.stderr, "");
  // The run header opens the output, echoing the args (here --help).
  assert.match(r.stdout, /> (?:@[\w-]+\/)?webext-linter@\d+\.\d+\.\d+ review/);
  assert.match(r.stdout, /node verify\.js --help/);
  // Every flag is listed under a group that holds more than it. --report-format has no
  // group of its own: one option under a heading is a heading that says nothing.
  assert.match(r.stdout, /--warnings-as-errors/);
  assert.match(r.stdout, /--report-format/);
  assert.doesNotMatch(r.stdout, /Report output:/);
});

// An unknown top-level option exits 2 with a clean message - no node:util
// "place it after --" hint, which does not apply to this tool.
test("unknown option errors cleanly (no -- separator hint)", () => {
  const r = run(["--bogusflag"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown option '--bogusflag'/);
  assert.doesNotMatch(r.stderr, /To specify a positional argument/);
});

// None of these flag strings is a valid option; passing any of them is an
// "Unknown option" error (exit 2). Guards the CLI surface against their return.
test("unrecognized cache/cdn flag strings are unknown options", () => {
  for (const flag of [
    "--schema-force-refresh",
    "--schema-cache",
    "--lib-mozilla-hash-db-cache",
    "--experiments-cache",
    "--lib-cdn-lookup",
  ]) {
    const r = run(["x.xpi", flag, "v"]);
    assert.equal(r.code, 2, `${flag} should exit 2`);
    assert.match(r.stderr, /Unknown option/, `${flag} should be unknown`);
  }
});

// The cache/cdn flags map to the internal pipeline opts.
test("cache/cdn flags map to the pipeline opts", () => {
  assert.equal(pipelineOptsFromArgv([]).cdnLookup, true); // default on
  assert.equal(
    pipelineOptsFromArgv(["--cdn-lib-lookup", "false"]).cdnLookup,
    false
  );
  const o = pipelineOptsFromArgv([
    "--cache-schema-dir",
    "/a",
    "--cache-hash-db-dir",
    "/b",
    "--cache-cdn-lookup-dir",
    "/c",
    "--cache-experiments-dir",
    "/d",
    "--cache-npm-registry-dir",
    "/e",
    "--cache-sources-dir",
    "/f",
  ]);
  assert.equal(o.schemaCache, "/a");
  assert.equal(o.libraryHashesCache, "/b");
  assert.equal(o.cdnLookupCache, "/c");
  assert.equal(o.experimentsCache, "/d");
  assert.equal(o.npmRegistryCache, "/e");
  assert.equal(o.sourcesCache, "/f");
});

// --cache-work-dir names the folder the run's cache is read from, so a review is answered
// by what a test kept there: every lock package popular, and one advisory, which the review
// reports. Seeded with the run cache's own keys (seedWorkCache), so the entries are spelt as
// the review reads them.
test("--cache-work-dir: a review reads its answers from the folder named", async () => {
  const fixture = addonOutsideRepo(path.join(FIXTURES, "sca-unrescued"));
  const lock = JSON.parse(
    fs.readFileSync(path.join(fixture, "src", "package-lock.json"), "utf8")
  );
  const packages = Object.entries(lock.packages)
    .filter(([at]) => at)
    .map(([at, { version }]) => ({
      name: at.slice("node_modules/".length),
      version,
    }));
  const seeded = advisory(
    "GHSA-seed-0000-0000",
    "CRITICAL",
    "tidy-lantern",
    "2.1.1"
  );
  const release = ({ name, version }) => `${name}@${version}`;
  const dir = seedWorkCache({
    osv: osvEntries({
      batch: Object.fromEntries(
        packages.map((p) => [
          release(p),
          release(p) === "tidy-lantern@2.1.0"
            ? { vulns: [{ id: seeded.id }] }
            : {},
        ])
      ),
      advisories: { [seeded.id]: seeded },
    }),
    popularity: popularityEntries({
      npm: Object.fromEntries(
        packages.map(({ name }) => [name, { downloads: 1e9 }])
      ),
    }),
  });

  const r = run([
    path.join(fixture, "xpi"),
    "--sca-root",
    path.join(fixture, "src"),
    ...OFFLINE_FLAGS,
    "--cache-work-dir",
    dir,
  ]);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stdout, /GHSA-seed-0000-0000/);
});

// A review of a source that declares npm dependencies, run as the reviewer runs it, with
// every answer it reads already in a cache: OSV's for each package the lock installs, npm's
// download count for each declared dependency, and the fixture caches for the rest. One
// advisory on a package the build pulls in for production rejects the add-on at its lock
// entry. The same run with one package's OSV answer missing asks the network, which the test
// switch refuses, so the review is answered by the caches and nothing else.
test("--cache-work-dir: a source review is answered by its seeded caches alone", () => {
  const fixture = addonOutsideRepo(
    path.join(FIXTURES, "sca-transitive-vulnerability")
  );
  const seeded = advisory(
    "GHSA-seed-1111-1111",
    "HIGH",
    "entity-decoder",
    "1.4.1"
  );
  const batch = {
    "markdown-render@2.0.0": {},
    "color-name-map@3.1.0": {},
    "entity-decoder@1.4.0": { vulns: [{ id: seeded.id }] },
    "bundler@5.0.0": {},
    "script-serializer@6.0.2": {},
  };
  const review = (answers) =>
    run([
      path.join(fixture, "xpi"),
      "--sca-root",
      path.join(fixture, "src"),
      ...OFFLINE_FLAGS,
      "--cache-work-dir",
      seedWorkCache({
        osv: osvEntries({
          batch: answers,
          advisories: { [seeded.id]: seeded },
        }),
        popularity: popularityEntries({
          npm: {
            "markdown-render": { downloads: 500000 },
            bundler: { downloads: 500000 },
          },
        }),
      }),
    ]);

  const r = review(batch);
  assert.equal(r.code, 1, r.stderr);
  assert.match(
    r.stdout,
    /\[SCA\] package-lock\.json:29 - entity-decoder@1\.4\.0 has known vulnerabilities \(GHSA-seed-1111-1111\)/
  );

  const { "color-name-map@3.1.0": _, ...unanswered } = batch;
  const missing = review(unanswered);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /network request in a test: \S*osv\.dev/);
});

// --cache-clear wipes the cache directories before the review (so every source re-fetches
// from scratch): every one --help names, read from --help itself, so a cache added there is
// cleared too, or this fails. Each points at a temp dir of its own holding a stale file, so
// the delete touches nothing else, and a nonexistent add-on makes runPipeline fail at load
// (before any network) - we assert only that the stale files were deleted.
test("--cache-clear deletes every cache directory --help names", () => {
  const flags = [
    ...new Set(
      run(["--help"])
        .stdout.split("\n")
        .flatMap((line) => line.split(" "))
        .filter((w) => w.startsWith("--cache-") && w.endsWith("-dir"))
    ),
  ];
  assert.ok(flags.length >= 6, flags.join(" "));
  const stale = flags.map((flag) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-clear-"));
    fs.writeFileSync(path.join(dir, "stale"), "stale");
    return [flag, dir];
  });
  run(["/no/such/addon.xpi", "--cache-clear", ...stale.flat()]);
  for (const [flag, dir] of stale) {
    assert.ok(!fs.existsSync(path.join(dir, "stale")), `${flag} was cleared`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A pipeline hard-fail the review could not run through (here a missing add-on; an
// unusable schema or a failed schema download take the same path) exits 2 and
// states "verify failed" on stderr - distinct from a completed review that found
// error findings.
test("a pipeline hard-fail aborts: exit 2 and 'verify failed' on stderr", () => {
  const r = run(["/no/such/addon.xpi", ...OFFLINE_FLAGS]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /verify failed/);
});

// --sca-root is the SCA-mode switch; --sca-exp-source names a location inside it, so it
// is a usage error on its own. (--sca-root alone is fine - the whole archive is reviewed.)
test("--sca-exp-source without --sca-root is a usage error (exit 2)", () => {
  const r = run(["some.xpi", "--sca-exp-source", "src"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--sca-exp-source requires --sca-root/);
});

// In SCA mode, Experiment code is told apart from WebExtension code only by
// --sca-exp-source, so --allow-experiments without it is a usage error (else the
// privileged Experiment code would be reviewed as WebExtension code).
// And it names a folder INSIDE the root, so it may not BE the root: naming the root
// excludes nothing, which leaves the Experiment's privileged code reviewed as WebExtension
// code - the one thing the flag exists to prevent. Refused where the pair settles
// (src/addon/sca-root.js), so this asserts the throw reaches the EXIT rather than only the
// unit: "." is what a reviewer types for an add-on that is entirely an Experiment.
test("--sca-exp-source naming --sca-root itself is a usage error (exit 2)", () => {
  const r = run([
    "tests/addons/sca-nested-layout/xpi",
    "--sca-root",
    "tests/addons/sca-nested-layout/src",
    "--sca-exp-source",
    ".",
  ]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /cannot be the root/);
  assert.match(r.stderr, /Name the subfolder holding it/);
});

// The format decides how everything below it is routed, so it is checked where it is
// read - before the --llm-sca-review branch, which would otherwise print nothing at all
// and exit 0 for an unknown value.
test("an unknown --report-format is refused on every path (exit 2)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-fmt-"));
  fs.writeFileSync(path.join(dir, "a.xpi"), "");
  fs.writeFileSync(path.join(dir, "source.tar.gz"), "");
  for (const args of [
    ["some.xpi", "--report-format", "xml"],
    [dir, "--llm-sca-review", "--report-format", "xml"],
  ]) {
    const r = run(args);
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.stderr, /Invalid --report-format "xml"/, args.join(" "));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// The other flag whose value is a closed set. It reads as a boolean but arrives as a
// string, and the derivation disables the lookup on the exact lowercase "false" alone - so
// every near miss used to leave it ON, silently, while sending content hashes of the
// submission to a third party. "False" is the case worth naming: the plausible mistake, not
// a nonsense string.
test("an unknown --cdn-lib-lookup is refused (exit 2)", () => {
  for (const value of ["False", "no", "0", "flase", ""]) {
    const r = run(["some.xpi", "--cdn-lib-lookup", value]);
    assert.equal(r.code, 2, value);
    assert.match(
      r.stderr,
      new RegExp(`Invalid --cdn-lib-lookup "${value}"`),
      value
    );
    assert.match(r.stderr, /expected true or false/, value);
  }
  // The two it does take, and its absence, get past the guard - they fail later on the
  // add-on that is not there, which is a different exit and the point of the assertion.
  for (const args of [
    ["some.xpi"],
    ["some.xpi", "--cdn-lib-lookup", "true"],
    ["some.xpi", "--cdn-lib-lookup", "false"],
  ]) {
    assert.doesNotMatch(
      run(args).stderr,
      /Invalid --cdn-lib-lookup/,
      args.join(" ")
    );
  }
});

// --sca-root is the EXTRACTED source, and the guard asks one question: does the path
// point at a folder? A packed root is the case that motivates it: the loader reads .xpi
// archives and nothing else, so a .tar.gz reaches it as a file it cannot open - and the
// answer a reviewer needs is about the FLAG they got wrong, not about the bytes. A missing
// path and a trailing slash are the same answer. The loader's own refusal is asserted
// against below: this guard has to come first, or the usage error never gets printed.
test("--sca-root must point at a folder (exit 2)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-sca-root-"));
  const zip = path.join(dir, "source.zip");
  fs.writeFileSync(zip, "not a folder");
  fs.writeFileSync(path.join(dir, "source.tar.gz"), "not a folder");
  const refused = [
    zip,
    path.join(dir, "source.tar.gz"),
    // A trailing slash: existsSync says no, path.resolve drops it, and the loader would
    // have opened the archive anyway - so the guard asks about the resolved path.
    `${zip}/`,
    path.join(dir, "no-such-folder"),
  ];
  for (const root of refused) {
    const r = run(["some.xpi", "--sca-root", root]);
    assert.equal(r.code, 2, root);
    assert.match(r.stderr, /--sca-root must point at a folder/, root);
    // Neither the loader's refusal nor AdmZip's: this never reached the read.
    assert.doesNotMatch(
      r.stderr,
      /END header|unsupported zip|Could not read archive/i,
      root
    );
  }

  // The other names a folder INSIDE the root, and is asked the same question. It is why
  // this is a refusal and not a warning: warn and carry on, and the review reads the
  // Experiment's privileged code as WebExtension code.
  for (const flag of ["--sca-exp-source"]) {
    const r = run(["some.xpi", "--sca-root", dir, flag, "no-such-dir"]);
    assert.equal(r.code, 2, flag);
    assert.match(
      r.stderr,
      new RegExp(`\\${flag} must point at a folder`),
      flag
    );
    assert.match(r.stderr, /no-such-dir/, flag);
  }

  // A folder passes this guard, whatever ends the run after it.
  const ok = run(["some.xpi", "--sca-root", dir]);
  assert.doesNotMatch(ok.stderr, /must point at a folder/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// An .xpi the loader will not take ends the run before a review exists - the tool-failure
// channel, exit 2, no report - rather than reviewing whatever part of it could be read. Here
// the archive holds an entry whose name carries a "." segment, so the key it would land under
// is not the key the manifest.json's own reference resolves to (tests/unit/load.test.js covers
// each refused shape). Driven through the CLI for the one thing only this layer shows: that
// the refusal reaches stderr as the linter's own sentence, and that nothing from inside the
// archive rides along with it.
test("an archive the loader will not take fails the run (exit 2)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-badzip-"));
  const zip = new AdmZip();
  zip.addFile(
    "manifest.json",
    Buffer.from('{"manifest_version":3,"name":"x","version":"1"}')
  );
  zip.addFile("SECRET.js", Buffer.from("browser.runtime.id;\n"));
  // AdmZip's writer normalizes, so the name is stamped on after the entry is added.
  zip.getEntries().find((e) => e.entryName === "SECRET.js").entryName =
    "a/./SECRET.js";
  const file = path.join(dir, "addon.xpi");
  zip.writeZip(file);

  // In the default work folder, beside the add-on: the run that created it removes it.
  const r = runFile(REVIEW, [file, ...OFFLINE_FLAGS]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Could not read archive: /);
  assert.match(r.stderr, /verify failed/);
  // The entry name is the submission's, and the refusal carries none of it.
  assert.doesNotMatch(r.stderr, /SECRET/);
  // No review was produced: the run stopped at the read.
  assert.doesNotMatch(r.stdout, /Found Issues|Summary/);
  // A refusal mid-extraction leaves nothing behind for a reviewer to mistake for the
  // whole submission (src/addon/load.js extractZip's cleanup-on-throw), and no work folder
  // the run created for a review that never began.
  assert.deepEqual(fs.readdirSync(dir), ["addon.xpi"]);

  fs.rmSync(dir, { recursive: true, force: true });
});
