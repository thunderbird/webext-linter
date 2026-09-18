// Tests for add-on loading edge cases.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";

import {
  loadAddon,
  loadScaAddon,
  selectScaBuildFiles,
  scaRootRelative,
  relativeInside,
} from "../../src/addon/load.js";

// Loading a directory keeps a real .js file but drops a symlink pointing at it,
// preventing duplicate or out-of-tree content from entering addon.files.
test("directory load skips symlinks but keeps real files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-sym-"));
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    '{"manifest_version":3,"name":"x","version":"1"}'
  );
  fs.writeFileSync(path.join(dir, "real.js"), "browser.runtime.id;\n");
  fs.symlinkSync(path.join(dir, "real.js"), path.join(dir, "link.js"));

  const addon = loadAddon(dir);
  assert.ok(addon.files.has("real.js"), "real file is loaded");
  assert.ok(!addon.files.has("link.js"), "symlink is skipped");
  // The skip is collected as a notice (not printed) for the pipeline to narrate.
  assert.deepEqual(addon.skipped, ["Skipping symlink (not packaged): link.js"]);

  fs.rmSync(dir, { recursive: true, force: true });
});

// A symlink named node_modules is still a committed dependency tree: it is recorded
// (so committed-node-modules fires) but never followed - its target is not read.
test("directory load records a symlinked node_modules without following it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-nmsym-"));
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    '{"manifest_version":3,"name":"x","version":"1"}'
  );
  // Point node_modules at an out-of-tree target: it must be recorded, never followed.
  fs.symlinkSync(
    path.join(os.tmpdir(), "wrr-nm-target"),
    path.join(dir, "node_modules"),
    "dir"
  );

  const addon = loadAddon(dir);
  assert.deepEqual(addon.nodeModules, ["node_modules"]);
  // A node_modules symlink is a recorded dependency tree, not a skipped-entry notice.
  assert.deepEqual(addon.skipped, []);
  assert.ok(
    ![...addon.files.keys()].some((k) => k.startsWith("node_modules")),
    "symlink target not read"
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

// A source code archive: the add-on code is at <root>/src, package.json/lock at
// the root. loadScaAddon partitions the src subtree (prefix stripped) and brings the
// root package.json along (for the dependency audit). The source's own manifest.json is
// parsed (not overwritten by a root one) and, like any manifest, lifted off the corpus
// onto the addon. The authoritative (shipped) manifest is the built XPI's, resolved
// separately into ctx.manifest (context.js); loadScaAddon does not touch the source manifest.
test("loadScaAddon partitions scaSource, keeps root package.json + parses the source's own manifest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-sca-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    '{"dependencies":{"left-pad":"1.3.0"}}'
  );
  const srcManifest =
    '{"manifest_version":3,"name":"FROM-SOURCE","version":"1"}';
  fs.writeFileSync(path.join(root, "src", "manifest.json"), srcManifest);
  fs.writeFileSync(
    path.join(root, "src", "background.js"),
    "browser.runtime.id;\n"
  );

  // The pipeline reads the --sca-root archive ONCE and shares it with both the review
  // loader and the build-corpus loader, so the tree is never walked twice.
  const archive = loadAddon(root);
  const addon = loadScaAddon(archive, path.join(root, "src"), root);

  assert.ok(addon.files.has("background.js"), "src file, prefix stripped");
  assert.ok(!addon.files.has("src/background.js"), "prefix not retained");
  assert.ok(addon.files.has("package.json"), "root package.json brought along");
  // Pure source: the source's own manifest.json is parsed, not injected/overwritten.
  assert.equal(
    addon.manifest.name,
    "FROM-SOURCE",
    "source's own manifest kept"
  );
  // The manifest is lifted off the corpus into manifestText and the key dropped, so a
  // corpus lookup can never return the source's pre-build manifest.
  assert.ok(
    !addon.files.has("manifest.json"),
    "manifest.json removed from corpus"
  );
  assert.equal(addon.manifestText, srcManifest);

  fs.rmSync(root, { recursive: true, force: true });
});

// selectScaBuildFiles is the COMPLEMENT of loadScaAddon: the archive minus the review
// source (scaSource), the Experiment source (scaExpSource), node_modules, and
// dotfiles/dotfolders - the build scripts / config the review otherwise drops. Keys
// keep their real archive paths (unstripped); the root package.json/lock stay, and a
// plain .npmrc is kept (the one dotfile exception the build-tooling checks read).
test("selectScaBuildFiles returns the build files outside scaSource + scaExpSource", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-scab-"));
  fs.mkdirSync(path.join(root, "src", "experiment"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"));
  // node_modules is skipped at LOAD (never read) and reported: a nested one (any depth)
  // and one INSIDE the review source are both recorded, neither read.
  fs.mkdirSync(path.join(root, "sub", "node_modules", "dep"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(root, "src", "node_modules"), { recursive: true });
  // Dotfolders (.github CI) are excluded; a plain .npmrc is KEPT; a .npmrc buried in a
  // dotfolder is still excluded.
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
  fs.writeFileSync(path.join(root, "webpack.config.js"), "module.exports={}");
  fs.writeFileSync(path.join(root, "scripts", "build.sh"), "echo build");
  fs.writeFileSync(path.join(root, ".npmrc"), "registry=https://evil");
  fs.writeFileSync(path.join(root, ".github", ".npmrc"), "registry=https://x");
  fs.writeFileSync(
    path.join(root, ".github", "workflows", "ci.yml"),
    "on: push"
  );
  fs.writeFileSync(path.join(root, "src", "background.js"), "1;\n");
  fs.writeFileSync(path.join(root, "src", "experiment", "exp.js"), "1;\n");
  fs.writeFileSync(
    path.join(root, "sub", "node_modules", "dep", "webpack.config.js"),
    ""
  );
  fs.writeFileSync(path.join(root, "src", "node_modules", "pkg.js"), "1;\n");

  const { files, nodeModules } = selectScaBuildFiles(
    loadAddon(root),
    path.join(root, "src"),
    root,
    path.join(root, "src", "experiment")
  );
  assert.deepEqual([...files.keys()].sort(), [
    ".npmrc",
    "package-lock.json",
    "package.json",
    "scripts/build.sh",
    "webpack.config.js",
  ]);
  assert.ok(files.has(".npmrc"));
  assert.ok(!files.has("background.js") && !files.has("src/background.js"));
  assert.ok(!files.has("src/experiment/exp.js"));
  assert.ok(!files.has("sub/node_modules/dep/webpack.config.js"));
  assert.ok(!files.has(".github/.npmrc")); // a .npmrc buried in a dotfolder is dropped
  assert.ok(!files.has(".github/workflows/ci.yml"));
  // node_modules is never read (no node_modules file in the corpus) but IS reported for
  // the committed-node-modules check - anywhere, including inside the review source.
  assert.deepEqual(nodeModules.sort(), [
    "src/node_modules",
    "sub/node_modules",
  ]);
  assert.ok(![...files.keys()].some((k) => k.includes("node_modules")));

  fs.rmSync(root, { recursive: true, force: true });
});

// A flat layout: scaSource IS the archive root, so there is no source subtree to
// exclude - every file becomes a build candidate, and selectBuildCorpus (called by
// analyzeBuild) still traces the build off the root package.json.
test("selectScaBuildFiles with scaSource at the archive root keeps the root as build candidates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-scab0-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    '{"scripts":{"build":"x"}}'
  );
  fs.writeFileSync(path.join(root, "background.js"), "1;\n");
  const { files } = selectScaBuildFiles(loadAddon(root), root, root, "");
  assert.ok(
    files.has("package.json"),
    "the root package.json is a build candidate"
  );
  assert.ok(
    files.has("background.js"),
    "root files are build candidates in a flat layout"
  );
  fs.rmSync(root, { recursive: true, force: true });
});

// Both SCA source flags name a folder WITHIN --sca-root, and relativeInside is the ONE
// function that says WHERE inside - src/cli.js asks it before the filesystem, the loader
// asks it through scaRootRelative for the archive key, so the folder the guard finds is
// the folder the review reads. Both paths are
// absolute by now (the arg-array reader resolved them), so this asks about the filesystem
// rather than about spelling: a dot in a NAME survives because nothing here strips prefixes.
test("scaRootRelative keys a path inside the root, and refuses one outside", () => {
  const root = "/tmp/wrr-root";
  for (const [given, key] of [
    [`${root}/addon`, "addon"],
    [`${root}/a/b`, "a/b"],
    [`${root}/a/./b`, "a/b"],
    [`${root}//a`, "a"],
    [root, ""],
    [`${root}/`, ""],
    [`${root}/.src`, ".src"],
    [`${root}/..src`, "..src"],
    [`${root}/.hidden/x`, ".hidden/x"],
    // A backslash is a separator on Windows and an ordinary character in a POSIX file
    // name, so which it is here is the platform's answer, never ours to rewrite.
    [`${root}${path.sep}sub${path.sep}dir`, "sub/dir"],
  ]) {
    assert.equal(scaRootRelative(given, root), key, given);
  }
  // Outside the root is refused, however it got there: another tree, the root's own parent,
  // or a way back out of it. What it names is not part of the submission.
  for (const outside of [
    "/elsewhere/x",
    `${root}/../sibling`,
    path.dirname(root),
    `${root}/a/../..`,
  ]) {
    assert.throws(
      () => scaRootRelative(outside, root, "--sca-source"),
      /is not inside --sca-root/,
      outside
    );
    // The same question without the throw, which is what the CLI guard asks.
    assert.equal(relativeInside(outside, root), null, outside);
  }
});

// The question --sca-exp-source turns into, asked where it is used: where does the
// Experiment folder sit INSIDE the review source? relativeInside answers it, and null - the
// caller's "nothing to exclude" - is the answer for every folder outside that source, which
// was never in the reviewed file set to begin with (it is the build corpus's, and the
// Experiment's own code is reviewed from the XPI).
test("relativeInside places an in-source exp folder, else answers null", () => {
  const root = "/tmp/wrr-root";
  const src = path.join(root, "addon");
  assert.equal(
    relativeInside(path.join(src, "experiment-api"), src),
    "experiment-api"
  );
  assert.equal(
    relativeInside(path.join(src, "experiment-api/x"), src),
    "experiment-api/x"
  );
  // The folder IS the whole source: nothing under it to strip.
  assert.equal(relativeInside(src, src), "");
  // Outside the review source, however it is arranged under --sca-root.
  assert.equal(relativeInside(path.join(root, "experiment-api"), src), null);
  assert.equal(relativeInside(path.join(root, "other/exp"), src), null);
  assert.equal(
    relativeInside(path.join(root, "experiment"), path.join(root, "src")),
    null
  );
});

// A ZIP entry name is taken as written - entryKey strips a leading "./" and nothing else -
// so a name carrying path SYNTAX rather than names ("." , "" or "..") keys a file where the
// manifest's own reference can never find it (normalizeRefInDir drops both), and two
// spellings of one path would collide in `files`, letting entry order decide which bytes are
// reviewed. Such an archive is refused whole, not repaired and not partly read: a file we
// will not take is a review that would silently cover less than the submission.
test("a zip entry name that is not a plain path refuses the whole archive", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-zipname-"));
  // AdmZip's WRITER normalizes these away, so the name is stamped onto the entry after it
  // is added - which is what an archive whose central directory was written by hand holds.
  const packed = (entryName, n) => {
    const zip = new AdmZip();
    zip.addFile(
      "manifest.json",
      Buffer.from('{"manifest_version":3,"name":"x","version":"1"}')
    );
    zip.addFile("MARKER.js", Buffer.from("browser.runtime.id;\n"));
    zip.getEntries().find((e) => e.entryName === "MARKER.js").entryName =
      entryName;
    const file = path.join(dir, `bad-${n}.xpi`);
    zip.writeZip(file);
    return file;
  };

  const refused = [
    "a/./MARKER.js", // a dot segment: the shape that opened this
    "a//MARKER.js", // an empty segment, from a naive path join
    "../MARKER.js", // outside the package
    "/MARKER.js", // absolute
    "C:/MARKER.js", // absolute, Windows
  ];
  refused.forEach((entryName, n) => {
    const file = packed(entryName, n);
    assert.throws(
      () => loadAddon(file),
      (err) => {
        // Exactly one sentence, naming the archive. The entry name is the submission's
        // own text and stays out of it - a refusal is not a place to escape user data.
        assert.equal(err.message, `Could not read archive: ${file}`);
        assert.doesNotMatch(err.message, /MARKER/);
        return true;
      },
      entryName
    );
  });

  fs.rmSync(dir, { recursive: true, force: true });
});

// The one non-canonical form that is repaired rather than refused: `zip -r ./dir` writes a
// leading "./" on every entry, it names the package root unambiguously, and entryKey has
// always stripped it. Pinned so the refusal above is never "tidied up" to cover it too.
test("a leading ./ on a zip entry is repaired, not refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-zipdot-"));
  const zip = new AdmZip();
  zip.addFile(
    "manifest.json",
    Buffer.from('{"manifest_version":3,"name":"x","version":"1"}')
  );
  zip.addFile("a/b.js", Buffer.from("browser.runtime.id;\n"));
  zip.getEntries().find((e) => e.entryName === "a/b.js").entryName = "./a/b.js";
  const file = path.join(dir, "leading-dot.xpi");
  zip.writeZip(file);

  const addon = loadAddon(file);
  assert.ok(addon.files.has("a/b.js"), "keyed without the leading ./");
  assert.equal(addon.manifest.name, "x");

  fs.rmSync(dir, { recursive: true, force: true });
});

// An archive we cannot open, and one whose entry will not inflate, are the same answer as
// one holding a name we will not take: one sentence about the archive. AdmZip's own wording
// either names its internals ("No END header found") or quotes a file name out of the
// archive ("CRC32 checksum failed"), and the second is submission text - which a refusal
// must not start carrying.
test("an unreadable archive is refused in our own words", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-zipbad-"));
  const refuses = (file) =>
    assert.throws(
      () => loadAddon(file),
      (err) => {
        assert.equal(err.message, `Could not read archive: ${file}`);
        assert.doesNotMatch(err.message, /ADM-ZIP|END header|CRC32|SECRET/i);
        return true;
      },
      file
    );

  // The container itself: not a zip at all.
  const truncated = path.join(dir, "truncated.xpi");
  fs.writeFileSync(truncated, "PK\u0003\u0004 and then nothing that is a zip");
  refuses(truncated);

  // One entry that does not inflate: the archive opens and every name is fine, but the
  // stored checksum does not match the bytes. Written by corrupting the crc32 field (byte
  // 14) of each local file header in an otherwise valid zip.
  const zip = new AdmZip();
  zip.addFile(
    "manifest.json",
    Buffer.from('{"manifest_version":3,"name":"x","version":"1"}')
  );
  zip.addFile("SECRET.js", Buffer.from("browser.runtime.id; ".repeat(40)));
  const buf = zip.toBuffer();
  const SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  for (let at = buf.indexOf(SIG); at !== -1; at = buf.indexOf(SIG, at + 4)) {
    buf.writeUInt32LE(0xdeadbeef, at + 14);
  }
  const badCrc = path.join(dir, "bad-crc.xpi");
  fs.writeFileSync(badCrc, buf);
  refuses(badCrc);

  fs.rmSync(dir, { recursive: true, force: true });
});

// A packed .xpi is extracted to disk and read back from there - the one way its files
// ever reach addon.files - so the round trip has to be exact: manifest.json included
// (assembleAddon lifts it off the corpus AFTER this, same as a directory submission),
// and every other file byte-identical to what was packed.
test("loadAddon(file) extracts to disk and reads the same content back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-extract-"));
  const zip = new AdmZip();
  zip.addFile(
    "manifest.json",
    Buffer.from('{"manifest_version":3,"name":"x","version":"1"}')
  );
  zip.addFile("bg.js", Buffer.from("browser.runtime.id;\n"));
  zip.addFile("a/b/c.js", Buffer.from("nested();\n"));
  const file = path.join(dir, "addon.xpi");
  zip.writeZip(file);

  const dest = path.join(dir, "addon.xpi.extracted");
  const addon = loadAddon(file, dest);

  // On disk: manifest.json included, unlike addon.files (assembleAddon drops it there).
  assert.equal(
    fs.readFileSync(path.join(dest, "manifest.json"), "utf8"),
    '{"manifest_version":3,"name":"x","version":"1"}'
  );
  assert.equal(
    fs.readFileSync(path.join(dest, "bg.js"), "utf8"),
    "browser.runtime.id;\n"
  );
  assert.equal(
    fs.readFileSync(path.join(dest, "a", "b", "c.js"), "utf8"),
    "nested();\n"
  );

  // Read back the same way a directory submission is: manifest lifted off the corpus,
  // everything else in addon.files keyed the same as the packed entries were.
  assert.equal(addon.manifest.name, "x");
  assert.ok(!addon.files.has("manifest.json"));
  assert.equal(
    addon.files.get("bg.js").toString("utf8"),
    "browser.runtime.id;\n"
  );
  assert.equal(addon.files.get("a/b/c.js").toString("utf8"), "nested();\n");

  fs.rmSync(dir, { recursive: true, force: true });
});

// extractTo omitted: loadAddon defaults it itself (src/util/dest.js), beside the file.
test("loadAddon(file) with no extractTo defaults beside the archive", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-extract-default-"));
  const zip = new AdmZip();
  zip.addFile(
    "manifest.json",
    Buffer.from('{"manifest_version":3,"name":"x","version":"1"}')
  );
  const file = path.join(dir, "addon.xpi");
  zip.writeZip(file);

  loadAddon(file);
  assert.ok(
    fs.existsSync(path.join(dir, "addon.xpi.extracted", "manifest.json"))
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

// node_modules is never decompressed - not into memory, and now not to disk either - so
// a later read of the extracted folder cannot rediscover it there. addon.nodeModules has
// to come from the extraction step itself, or committed-node-modules would silently stop
// firing on every zip-origin submission.
test("loadAddon(file) records node_modules without writing it to disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-extract-nm-"));
  const zip = new AdmZip();
  zip.addFile(
    "manifest.json",
    Buffer.from('{"manifest_version":3,"name":"x","version":"1"}')
  );
  zip.addFile(
    "node_modules/dep/index.js",
    Buffer.from("module.exports = 1;\n")
  );
  const file = path.join(dir, "addon.xpi");
  zip.writeZip(file);

  const dest = path.join(dir, "addon.xpi.extracted");
  const addon = loadAddon(file, dest);

  assert.deepEqual(addon.nodeModules, ["node_modules"]);
  assert.ok(
    !fs.existsSync(path.join(dest, "node_modules")),
    "node_modules was written to disk"
  );
  assert.ok(!addon.files.has("node_modules/dep/index.js"));

  fs.rmSync(dir, { recursive: true, force: true });
});

// A refusal midway through extraction must not leave a partial tree behind for a
// reviewer to mistake for the whole submission.
test("a refused archive leaves no partial extraction on disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-extract-partial-"));
  const zip = new AdmZip();
  zip.addFile(
    "manifest.json",
    Buffer.from('{"manifest_version":3,"name":"x","version":"1"}')
  );
  zip.addFile("MARKER.js", Buffer.from("browser.runtime.id;\n"));
  zip.getEntries().find((e) => e.entryName === "MARKER.js").entryName =
    "../MARKER.js";
  const file = path.join(dir, "bad.xpi");
  zip.writeZip(file);

  const dest = path.join(dir, "bad.xpi.extracted");
  assert.throws(() => loadAddon(file, dest));
  assert.ok(!fs.existsSync(dest), "a partial extraction was left behind");

  fs.rmSync(dir, { recursive: true, force: true });
});

// An archive with no real files at all (only a node_modules subtree) still leaves a
// directory a later readDir can walk - otherwise loadAddon crashes on a submission that
// is merely useless, not unreadable.
test("an archive with nothing but node_modules still leaves an empty extracted folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-extract-empty-"));
  const zip = new AdmZip();
  zip.addFile(
    "node_modules/dep/index.js",
    Buffer.from("module.exports = 1;\n")
  );
  const file = path.join(dir, "addon.xpi");
  zip.writeZip(file);

  const dest = path.join(dir, "addon.xpi.extracted");
  const addon = loadAddon(file, dest);
  assert.ok(fs.existsSync(dest) && fs.statSync(dest).isDirectory());
  assert.equal(addon.files.size, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});
