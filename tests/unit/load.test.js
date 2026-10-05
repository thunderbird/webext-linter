// Tests for add-on loading edge cases.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";

import { ADDON_MAX_UNPACKED_BYTES } from "../../src/config.js";

import {
  loadAddon,
  loadSourceArchive,
  readWebExtManifest,
  manifestRecord,
  scaViews,
  scaRootRelative,
  relativeInside,
} from "../../src/addon/load.js";
import { withExperiment } from "../../src/addon/store.js";
import { ERROR_CLASS, SYMLINK_CAUSE } from "../../src/lib/enum.js";
import { ARTIFACT_SCA, ARTIFACT_XPI } from "../../src/lib/artifacts.js";

// Every load here is of a built add-on; loadSourceArchive has its own tests.
const XPI = { kind: ARTIFACT_XPI };

const MANIFEST = '{"manifest_version":3,"name":"x","version":"1"}';

// The one sentence an XPI holding a link is refused with: invalid, which file, and why.
const linkRefusal = (rel) => ({
  message: `Invalid XPI: ${rel} is a symbolic link (an add-on must contain regular files only).`,
});

// An add-on may not link at all, wherever the link points: the first one refuses the whole
// XPI at load, before any review starts.
test("an XPI folder holding a symlink is refused at load", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-sym-"));
  fs.writeFileSync(path.join(dir, "manifest.json"), MANIFEST);
  fs.writeFileSync(path.join(dir, "real.js"), "browser.runtime.id;\n");
  fs.symlinkSync(path.join(dir, "real.js"), path.join(dir, "link.js"));

  assert.throws(() => loadAddon(dir, undefined, XPI), linkRefusal("link.js"));

  fs.rmSync(dir, { recursive: true, force: true });
});

// The file a review starts from is no exception: a linked manifest.json refuses the XPI the
// same way, rather than reaching a check.
test("an XPI folder whose manifest.json is a symlink is refused at load", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-symman-"));
  fs.writeFileSync(path.join(dir, "real.json"), MANIFEST);
  fs.symlinkSync("real.json", path.join(dir, "manifest.json"));

  assert.throws(
    () => loadAddon(dir, undefined, XPI),
    linkRefusal("manifest.json")
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

// In an add-on the name node_modules means nothing: a link called that is a link like any
// other, and refuses the XPI.
test("an XPI folder holding a symlinked node_modules is refused at load", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-nmsym-xpi-"));
  fs.writeFileSync(path.join(dir, "manifest.json"), MANIFEST);
  fs.symlinkSync(
    path.join(os.tmpdir(), "wrr-nm-target"),
    path.join(dir, "node_modules"),
    "dir"
  );

  assert.throws(
    () => loadAddon(dir, undefined, XPI),
    linkRefusal("node_modules")
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

// A source archive may link within itself, so its load keeps the real file, skips the link
// (never following it) with a notice for the pipeline to narrate, and records where the
// target landed for its check to judge.
test("source-archive load skips a symlink, keeps real files and records the link", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-scasym-"));
  fs.writeFileSync(path.join(dir, "real.js"), "browser.runtime.id;\n");
  fs.symlinkSync(path.join(dir, "real.js"), path.join(dir, "link.js"));

  const archive = loadSourceArchive(dir);
  assert.ok(archive.files.has("real.js"), "real file is loaded");
  assert.ok(!archive.files.has("link.js"), "symlink is skipped");
  assert.deepEqual(archive.skipped, [
    "Skipping symlink (not packaged): link.js",
  ]);
  assert.equal(archive.symlinks.length, 1);
  assert.equal(archive.symlinks[0].path, "link.js");
  assert.equal(archive.symlinks[0].cause, SYMLINK_CAUSE.INTERNAL);

  fs.rmSync(dir, { recursive: true, force: true });
});

// Where a link LEADS is a fact the loader records and the check judges. The three answers,
// from one walk: inside the root, beyond it, and nowhere. The target of an escaping link is
// deliberately real, so only its location distinguishes it from the internal one.
test("source-archive load records where each symlink's target lands", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-out-"));
  fs.mkdirSync(path.join(outside, "secret"));
  fs.writeFileSync(
    path.join(outside, "secret", "payload.js"),
    "exfiltrate();\n"
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-cause-"));
  fs.mkdirSync(path.join(dir, "inner"));
  fs.writeFileSync(path.join(dir, "inner", "real.js"), "browser.runtime.id;\n");
  fs.symlinkSync("inner", path.join(dir, "intree"), "dir");
  fs.symlinkSync(
    path.join(outside, "secret"),
    path.join(dir, "outward"),
    "dir"
  );
  fs.symlinkSync(path.join(dir, "nothing-here"), path.join(dir, "dangling"));

  const archive = loadSourceArchive(dir);
  const byPath = new Map(archive.symlinks.map((l) => [l.path, l.cause]));
  assert.deepEqual([...byPath.keys()].sort(), [
    "dangling",
    "intree",
    "outward",
  ]);
  assert.equal(byPath.get("intree"), SYMLINK_CAUSE.INTERNAL);
  assert.equal(byPath.get("outward"), SYMLINK_CAUSE.OUTSIDE);
  assert.equal(byPath.get("dangling"), SYMLINK_CAUSE.BROKEN);
  // Recorded, still never followed: the escaping target stays out of the store.
  assert.ok(
    ![...archive.files.keys()].some((k) => k.includes("payload")),
    "an escaping link's target is not read"
  );

  [dir, outside].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

// A link is followed to its END before the question is asked, so a chain that starts
// inside the root and leaves it is the escape it arrives at, not the hop it began with.
test("source-archive load follows a symlink chain to where it really ends", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-chain-out-"));
  fs.writeFileSync(path.join(outside, "target.js"), "exfiltrate();\n");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-chain-"));
  // hop.js sits inside the root and points out of it; first.js points at hop.js, so a
  // test of the written target alone would read the first link as internal.
  fs.symlinkSync(path.join(outside, "target.js"), path.join(dir, "hop.js"));
  fs.symlinkSync(path.join(dir, "hop.js"), path.join(dir, "first.js"));

  const archive = loadSourceArchive(dir);
  const chain = new Map(archive.symlinks.map((l) => [l.path, l.cause]));
  assert.deepEqual([...chain.keys()].sort(), ["first.js", "hop.js"]);
  assert.equal(chain.get("hop.js"), SYMLINK_CAUSE.OUTSIDE);
  assert.equal(chain.get("first.js"), SYMLINK_CAUSE.OUTSIDE);

  [dir, outside].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

// In a SOURCE ARCHIVE a symlink named node_modules is still a committed dependency tree:
// it is recorded (so committed-node-modules fires) but never followed - its target is not
// read - and it is not a symlink record, so exactly one check answers it.
test("source-archive load records a symlinked node_modules without following it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-nmsym-"));
  // Point node_modules at an out-of-tree target: it must be recorded, never followed.
  fs.symlinkSync(
    path.join(os.tmpdir(), "wrr-nm-target"),
    path.join(dir, "node_modules"),
    "dir"
  );

  const archive = loadSourceArchive(dir);
  assert.deepEqual(archive.nodeModules, ["node_modules"]);
  assert.deepEqual(archive.skipped, []);
  assert.deepEqual(archive.symlinks, []);
  assert.ok(
    ![...archive.files.keys()].some((k) => k.startsWith("node_modules")),
    "symlink target not read"
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

// And a real node_modules DIRECTORY in an add-on is shipped content: walked and keyed like
// any other folder, because that is what a user receives.
test("add-on load reviews a node_modules directory like any other folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-nmdir-xpi-"));
  fs.writeFileSync(path.join(dir, "manifest.json"), MANIFEST);
  fs.mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "node_modules", "dep", "index.js"),
    "module.exports = 1;\n"
  );

  const addon = loadAddon(dir, undefined, XPI);
  assert.deepEqual(addon.nodeModules, []);
  assert.ok(addon.files.has("node_modules/dep/index.js"), "it is in the store");

  fs.rmSync(dir, { recursive: true, force: true });
});

// A packed archive can store an entry AS a link, and its data is then a target path where
// a file's bytes belong. Extraction never replays a stored mode (that is what keeps a
// crafted archive from writing a real link); the entry refuses the XPI like a link on disk
// does, and the partial extraction is removed.
test("loadAddon(file) refuses an entry the archive stored as a link", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-linkentry-"));
  const zip = new AdmZip();
  zip.addFile("manifest.json", Buffer.from(MANIFEST));
  zip.addFile("bg.js", Buffer.from("browser.runtime.id;\n"));
  // addFile stamps S_IFREG and keeps only the permission bits, so the file TYPE is set on
  // the entry itself - which is exactly the claim a hand-built archive would make.
  zip.addFile("libs/jquery.js", Buffer.from("../../../../etc/passwd"));
  zip.getEntry("libs/jquery.js").attr = (0o120777 << 16) >>> 0;
  const file = path.join(dir, "addon.xpi");
  zip.writeZip(file);

  const dest = path.join(dir, "addon.xpi.extracted");
  assert.throws(
    () => loadAddon(file, dest, XPI),
    linkRefusal("libs/jquery.js")
  );
  assert.ok(!fs.existsSync(dest), "the partial extraction is removed");

  fs.rmSync(dir, { recursive: true, force: true });
});

// An archiver that records no Unix mode at all writes 0, which names no file type. It must
// read as an ordinary file, or every entry of such an archive would be refused as a link.
test("loadAddon(file) treats an entry with no recorded mode as an ordinary file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-nomode-"));
  const zip = new AdmZip();
  zip.addFile(
    "manifest.json",
    Buffer.from('{"manifest_version":3,"name":"x","version":"1"}')
  );
  zip.addFile("bg.js", Buffer.from("browser.runtime.id;\n"));
  zip.getEntry("bg.js").attr = 0;
  const file = path.join(dir, "addon.xpi");
  zip.writeZip(file);

  const addon = loadAddon(file, path.join(dir, "addon.xpi.extracted"), XPI);
  assert.deepEqual(addon.symlinks, []);
  assert.ok(addon.files.has("bg.js"));

  fs.rmSync(dir, { recursive: true, force: true });
});

// The walk records every directory it enters, which is the one question the key set cannot
// answer: a key names a file, so a directory shows up there only as a prefix of one, and an
// empty directory not at all. A recorded installed tree is absent - it is never walked, so
// nothing may resolve into it.
test("directory load records every directory it walks into", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-dirs-"));
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    '{"manifest_version":3,"name":"x","version":"1"}'
  );
  fs.mkdirSync(path.join(dir, "libs", "widget"), { recursive: true });
  fs.writeFileSync(path.join(dir, "libs", "widget", "index.js"), "1;\n");
  fs.mkdirSync(path.join(dir, "empty"));
  fs.mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "dep", "i.js"), "1;\n");
  fs.writeFileSync(path.join(dir, "libs", "payload.tgz"), "blob");

  const addon = loadAddon(dir, undefined, {
    ...XPI,
    recordInstalledTrees: true,
  });
  assert.deepEqual(addon.directories.sort(), ["empty", "libs", "libs/widget"]);
  // A file is never one, however it is spelled - the bug this list exists to close.
  assert.ok(!addon.directories.includes("libs/payload.tgz"));
  // And the tree recorded instead of walked contributes neither itself nor its contents.
  assert.deepEqual(addon.nodeModules, ["node_modules"]);

  fs.rmSync(dir, { recursive: true, force: true });
});

// Loaded as an ADD-ON, where node_modules is ordinary content, it is a directory like any
// other - so the two halves of the loader stay consistent about what a directory is.
test("add-on load records a node_modules folder as the directory it is", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-dirs-xpi-"));
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    '{"manifest_version":3,"name":"x","version":"1"}'
  );
  fs.mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "dep", "i.js"), "1;\n");

  const addon = loadAddon(dir, undefined, XPI);
  assert.deepEqual(addon.directories.sort(), [
    "node_modules",
    "node_modules/dep",
  ]);

  fs.rmSync(dir, { recursive: true, force: true });
});

// The packed route gets the same list, because loadAddon walks the extraction back with
// the same readDir - nothing about directories has to be recovered from the archive.
test("loadAddon(file) records the extracted directories", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-dirs-zip-"));
  const zip = new AdmZip();
  zip.addFile(
    "manifest.json",
    Buffer.from('{"manifest_version":3,"name":"x","version":"1"}')
  );
  zip.addFile("libs/widget/index.js", Buffer.from("1;\n"));
  const file = path.join(dir, "addon.xpi");
  zip.writeZip(file);

  const addon = loadAddon(file, path.join(dir, "addon.xpi.extracted"), XPI);
  assert.deepEqual(addon.directories.sort(), ["libs", "libs/widget"]);

  fs.rmSync(dir, { recursive: true, force: true });
});

// ONE shape for every artifact: `store` is the FileStore the submission was walked into, and
// `files` is a view over it - so a reader of `files` never has to know which kind of artifact
// produced it, and nothing can come to depend on store-only behaviour by reaching through it.
// A built XPI withholds nothing, and says that by HOLDING every key rather than by being the
// store: the two answer the same keys and are still different objects.
test("files is a view over the store, for an add-on as much as an archive", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-view-"));
  fs.mkdirSync(path.join(dir, "lib"));
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    '{"manifest_version":3,"name":"x","version":"1"}'
  );
  fs.writeFileSync(path.join(dir, "bg.js"), "1;\n");
  fs.writeFileSync(path.join(dir, "lib", "dep.js"), "2;\n");

  const addon = loadAddon(dir, undefined, XPI);
  assert.notEqual(addon.files, addon.store, "a view is never the store");
  assert.deepEqual(
    [...addon.files.keys()].sort(),
    [...addon.store.keys()].sort(),
    "and withholds nothing from an add-on"
  );
  // Reading through the view is reading the store's bytes: a view carries none of its own.
  assert.equal(addon.files.get("lib/dep.js").toString("utf8"), "2;\n");
  assert.equal(addon.files.size, addon.store.size);

  // The archive narrows the same field, which is the only difference between the two kinds.
  const archive = scaViews(loadSourceArchive(dir), {
    scaRoot: dir,
    scaExpSource: path.join(dir, "lib"),
  });
  assert.notEqual(archive.files, archive.store);
  assert.ok(!archive.files.has("lib/dep.js"), "the Experiment is its own view");
  assert.ok(archive.store.has("lib/dep.js"), "the submission still holds it");

  fs.rmSync(dir, { recursive: true, force: true });
});

// A manifest.json is a FILE an artifact holds, like any other file the submission
// contains. What the add-on DECLARES is a separate question with one answer, asked of one
// artifact: readWebExtManifest reads the record off a store, and the review asks it of the
// shipped XPI only (src/pipeline.js). Loading never derives it, so no artifact carries a
// second answer for a reader to pick up by mistake.
test("loading holds the file; the record is asked for, not derived", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-record-"));
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    '{"manifest_version":3,"name":"x","version":"1"}'
  );
  fs.writeFileSync(path.join(dir, "bg.js"), "1;\n");

  for (const artifact of [
    loadAddon(dir, undefined, XPI),
    scaViews(loadSourceArchive(dir), { scaRoot: dir }),
  ]) {
    assert.ok(artifact.files.has("manifest.json"), "its files hold it");
    assert.equal(artifact.manifest, undefined, "and answers nothing itself");
  }

  // Asked of the store, the record is the whole answer: the parse, and a line index a
  // finding can anchor in.
  const record = readWebExtManifest(loadAddon(dir, undefined, XPI).store);
  assert.equal(record.json.name, "x");
  assert.equal(record.error, null);
  assert.ok(record.loc, "and can anchor a finding at a line");

  // An artifact holding no manifest.json is the one case that is nothing at all.
  fs.rmSync(path.join(dir, "manifest.json"));
  // A record either way: `present` is the answer, not the record's existence.
  const absent = readWebExtManifest(loadAddon(dir, undefined, XPI).store);
  assert.equal(absent.present, false);
  assert.equal(absent.json, null);
  assert.equal(absent.error, null, "absent is not a parse failure");
  assert.equal(absent.locus().artifact, ARTIFACT_XPI, "and it still mints");

  fs.rmSync(dir, { recursive: true, force: true });
});

// The archive is ONE object: it owns the store and the recorded path lists, and carries its
// two views over that store. Copying those onto parts is how two views of one
// archive came to disagree about what it holds, so the shape itself is worth pinning.
test("scaViews leaves the archive owning one store and two views", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-oneobj-"));
  const w = (p, c) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), c);
  };
  w("manifest.json", '{"manifest_version":3,"name":"R","version":"1"}');
  w("bg.js", "1;\n");
  w("sub/manifest.json", "{}");
  w("exp/impl.js", "1;\n");

  // Loaded the way the pipeline loads a submission: an installed tree is recorded, and no
  // manifest.json is read off it.
  const loaded = loadSourceArchive(root);
  const archive = scaViews(loaded, {
    scaRoot: root,
    scaExpSource: path.join(root, "exp"),
  });

  // Returned, not spawned: the caller's archive IS the review target.
  assert.equal(archive, loaded);

  // Two distinct views over the ONE store.
  const views = [archive.files, archive.experiment];
  assert.equal(new Set(views).size, 2, "two distinct views");
  for (const v of views) {
    assert.notEqual(v, archive.store, "a view is never the store itself");
  }

  // What each holds: the partition puts every file in exactly one of them, and a
  // manifest.json is a file like any other.
  assert.deepEqual([...archive.files.keys()].sort(), [
    "bg.js",
    "manifest.json",
    "sub/manifest.json",
  ]);
  assert.deepEqual([...archive.experiment.keys()].sort(), ["exp/impl.js"]);
  // And the artifact still holds all of it, the views notwithstanding.
  assert.deepEqual([...archive.store.keys()].sort(), [
    "bg.js",
    "exp/impl.js",
    "manifest.json",
    "sub/manifest.json",
  ]);

  // And no record of its own: loading derives none, so the pre-build template cannot be
  // mistaken for the shipped manifest.json. The files are still there above.
  assert.equal(archive.manifest, undefined);

  fs.rmSync(root, { recursive: true, force: true });
});

// A source code archive: the add-on code is at <root>/src, package.json/lock at the root.
// scaViews splits the archive into the parts a source review reads, as views over the one
// store it was walked into, all keyed against the SUBMISSION. The whole archive IS the
// review source - a build may move, rename or generate anything, so there is no subtree that
// can be called the add-on's and no way to tell which files are used. A manifest.json found
// anywhere is parsed and lifted off the view, so a pre-build manifest.json is never reviewed as
// source; the authoritative one is the built XPI's (ctx.manifest, context.js).
test("scaViews keys every view to the submission and reviews the whole archive", () => {
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

  // The pipeline reads the --sca-root archive ONCE and splits it, so the tree is never
  // walked twice and no part holds a second copy of any file.
  const source = scaViews(loadSourceArchive(root), { scaRoot: root });

  assert.ok(
    source.files.has("src/background.js"),
    "keyed as the archive keys it"
  );
  assert.ok(!source.files.has("background.js"), "not re-keyed to the add-on");
  // The build tooling is part of the submission and is reviewed with the rest of it: a
  // build script is code a reviewer has to read, and nothing can show it does not ship.
  assert.ok(
    source.files.has("package.json"),
    "the whole archive is the review source"
  );
  assert.equal(
    source.files.get("src/background.js").toString("utf8"),
    "browser.runtime.id;\n",
    "a view reads its bytes through the store"
  );
  // A manifest.json ANYWHERE is in the view, at its real path: the add-on's root may sit
  // under any subtree, so there is no root manifest.json to single out, and what the shipped
  // one SAYS is ctx.manifest rather than anything read from here.
  assert.ok(
    source.files.has("src/manifest.json"),
    "a manifest below the root is held at its real path"
  );
  assert.equal(source.manifest, undefined, "and the archive answers nothing");

  fs.rmSync(root, { recursive: true, force: true });
});

// A check that reviews a file for what it IS - minified, obfuscated, a known library -
// must see the privileged Experiment code too: shipping it unreadable is worse there, not
// better. The source view excludes it (so the WebExtension API/permission checks never
// false-positive on Services/ChromeUtils), so such a check reads BOTH views - which works
// because every view is keyed against the submission, so one file has one spelling
// wherever it is read. Merging them reproduces the add-on's whole tree, one entry per file.
test("the source and experiment views merge into the add-on's whole tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-scam-"));
  fs.mkdirSync(path.join(root, "addon", "experiment"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "addon", "manifest.json"), '{"name":"x"}');
  fs.writeFileSync(path.join(root, "addon", "main.js"), "1;\n");
  fs.writeFileSync(
    path.join(root, "addon", "experiment", "exp.js"),
    "ChromeUtils.import('x');\n"
  );

  const source = scaViews(loadSourceArchive(root), {
    scaRoot: root,
    scaExpSource: path.join(root, "addon", "experiment"),
  });
  const { experiment } = source;

  // Apart, each holds only its own - which is what keeps privileged code away from the
  // WebExtension checks.
  assert.deepEqual([...source.files.keys()].sort(), [
    "addon/main.js",
    "addon/manifest.json",
    "package.json",
  ]);
  assert.deepEqual([...experiment.keys()].sort(), ["addon/experiment/exp.js"]);

  // Together, they are the whole submission - no key belongs to both, and none is lost
  // between them.
  const merged = new Map([...source.files, ...experiment]);
  assert.deepEqual(
    [...merged.keys()].sort(),
    [
      "addon/experiment/exp.js",
      "addon/main.js",
      "addon/manifest.json",
      "package.json",
    ],
    "the union is the whole submission"
  );
  assert.equal(merged.size, source.files.size + experiment.size, "disjoint");
  // Merged, a file still reads its real bytes: a view resolves through the one store.
  assert.match(
    merged.get("addon/experiment/exp.js").toString("utf8"),
    /ChromeUtils/,
    "the merged files read the Experiment's bytes"
  );

  // The same files a check is handed: `experiment` rides on the review addon, so a check
  // needing both never has to know where the folder was named.
  assert.deepEqual([...source.experiment.keys()].sort(), [
    "addon/experiment/exp.js",
  ]);
  assert.deepEqual(
    [...withExperiment(source).keys()].sort(),
    [
      "addon/experiment/exp.js",
      "addon/main.js",
      "addon/manifest.json",
      "package.json",
    ],
    "withExperiment says what 'everything the add-on ships' means, in one place"
  );

  fs.rmSync(root, { recursive: true, force: true });
});

// An Experiment BESIDE the add-on is keyed exactly as one inside it would be - against the
// submission - so where the developer put the folder changes the path and nothing else. The
// view is present in both layouts and merges in both, so a check that reviews privileged
// code for what it IS covers it either way, and the source view excludes it either way,
// which is what keeps the WebExtension checks layout-independent.
test("a sibling Experiment is keyed like any other part of the submission", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-scas-"));
  fs.mkdirSync(path.join(root, "addon"), { recursive: true });
  fs.mkdirSync(path.join(root, "experiment"), { recursive: true });
  fs.writeFileSync(path.join(root, "addon", "manifest.json"), '{"name":"x"}');
  fs.writeFileSync(path.join(root, "addon", "main.js"), "1;\n");
  fs.writeFileSync(path.join(root, "experiment", "exp.js"), "1;\n");

  const source = scaViews(loadSourceArchive(root), {
    scaRoot: root,
    scaExpSource: path.join(root, "experiment"),
  });
  const { experiment } = source;

  assert.deepEqual([...source.files.keys()].sort(), [
    "addon/main.js",
    "addon/manifest.json",
  ]);
  assert.deepEqual([...experiment.keys()].sort(), ["experiment/exp.js"]);
  // The view is there either way: where the folder was PUT changes how its files are
  // spelled, never whether they are reviewed. A check merging the two gets the same
  // Experiment here as it does when the folder sits inside the add-on.
  assert.equal(source.experiment, experiment);
  assert.deepEqual([...withExperiment(source).keys()].sort(), [
    "addon/main.js",
    "addon/manifest.json",
    "experiment/exp.js",
  ]);

  fs.rmSync(root, { recursive: true, force: true });
});

// The two views account for the archive: the Experiment is disjoint from the source view,
// including in a NESTED layout, where the folder sits inside the add-on. Nothing may fall
// into both, and nothing the review needs may fall into neither.
test("scaViews puts every file in the right part, and the Experiment in only one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-scav-"));
  fs.mkdirSync(path.join(root, "src", "exp"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "build.js"), "1;\n");
  fs.writeFileSync(path.join(root, "src", "manifest.json"), '{"name":"x"}');
  fs.writeFileSync(path.join(root, "src", "main.js"), "1;\n");
  fs.writeFileSync(path.join(root, "src", "exp", "api.js"), "1;\n");

  const source = scaViews(loadSourceArchive(root), {
    scaRoot: root,
    scaExpSource: path.join(root, "src", "exp"),
  });
  const { experiment } = source;

  // The Experiment is its own part, wherever the developer put it - here inside the add-on.
  // Everything else is the source view, keyed against the submission.
  assert.deepEqual([...source.files.keys()].sort(), [
    "build.js",
    "package.json",
    "src/main.js",
    "src/manifest.json",
  ]);
  assert.deepEqual([...experiment.keys()].sort(), ["src/exp/api.js"]);

  fs.rmSync(root, { recursive: true, force: true });
});

// The source view is the archive minus the Experiment source (scaExpSource) and minus a
// recorded node_modules. Nothing else is withheld, which is what lets the build trace run
// over it: a build may read anything the archive carries, and where a file sits says nothing
// about whether a build step reaches it.
test("the source view holds the archive minus the Experiment and node_modules", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-scab-"));
  fs.mkdirSync(path.join(root, "src", "experiment"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"));
  // node_modules is skipped at LOAD (never read) and reported: a nested one (any depth)
  // and one INSIDE the review source are both recorded, neither read.
  fs.mkdirSync(path.join(root, "sub", "node_modules", "dep"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(root, "src", "node_modules"), { recursive: true });
  // Dotfolders (.github CI) are excluded; the ROOT .npmrc is KEPT; one in a subfolder and
  // one buried in a dotfolder are both excluded - neither is a directory this review
  // installs from.
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
  fs.writeFileSync(path.join(root, "webpack.config.js"), "module.exports={}");
  fs.writeFileSync(path.join(root, "scripts", "build.sh"), "echo build");
  fs.writeFileSync(path.join(root, ".npmrc"), "registry=https://evil");
  fs.writeFileSync(path.join(root, "scripts", ".npmrc"), "registry=https://y");
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

  const { files, nodeModules } = scaViews(loadSourceArchive(root), {
    scaRoot: root,
    scaExpSource: path.join(root, "src", "experiment"),
  });
  assert.deepEqual([...files.keys()].sort(), [
    ".github/.npmrc",
    ".github/workflows/ci.yml",
    ".npmrc",
    "package-lock.json",
    "package.json",
    "scripts/.npmrc",
    "scripts/build.sh",
    "src/background.js",
    "webpack.config.js",
  ]);
  assert.ok(files.has(".npmrc"));
  // The add-on's own code is a build candidate too: nothing separates it from the tooling
  // once there is no source subtree to remove.
  assert.ok(files.has("src/background.js"));
  // A dot-path is held like any other. Whether a nested .npmrc is READ is the reading
  // check's own business - build-registry-redirect asks for the root key and no other -
  // and not something the view decides by hiding the file.
  assert.ok(files.has("scripts/.npmrc"));
  assert.ok(files.has(".github/workflows/ci.yml"));
  // The two that stay out, and why they are different: the Experiment is partitioned into
  // its own view, and a recorded installed tree was never walked, so it has no keys at all.
  assert.ok(!files.has("src/experiment/exp.js"));
  assert.ok(!files.has("sub/node_modules/dep/webpack.config.js"));
  // node_modules is never read (no node_modules file among them) but IS reported for
  // the committed-node-modules check - anywhere, including inside the review source.
  assert.deepEqual(nodeModules.sort(), [
    "src/node_modules",
    "sub/node_modules",
  ]);
  assert.ok(![...files.keys()].some((k) => k.includes("node_modules")));

  fs.rmSync(root, { recursive: true, force: true });
});

// Every file is a build candidate, and collectBuildFiles (called by analyzeBuild) still
// traces the build off the root package.json.
test("the whole root stays a set of build candidates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-scab0-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    '{"scripts":{"build":"x"}}'
  );
  fs.writeFileSync(path.join(root, "background.js"), "1;\n");
  const { files } = scaViews(loadSourceArchive(root), {
    scaRoot: root,
  });
  assert.ok(
    files.has("package.json"),
    "the root package.json is a build candidate"
  );
  assert.ok(files.has("background.js"), "root files are build candidates");
  fs.rmSync(root, { recursive: true, force: true });
});

// Both SCA source flags name a folder WITHIN --sca-root, and relativeInside is the ONE
// function that says WHERE inside - src/cli.js asks it before the filesystem, the loader
// asks it through scaRootRelative for the archive key, so the folder the guard finds is
// the folder the review reads. Both paths are absolute by now (the arg-array reader
// resolved them), so this asks about the filesystem rather than about spelling: a dot in a
// NAME survives because nothing here strips prefixes.
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
      () => scaRootRelative(outside, root, "--sca-exp-source"),
      /is not inside --sca-root/,
      outside
    );
    // The same question without the throw, which is what the CLI guard asks.
    assert.equal(relativeInside(outside, root), null, outside);
  }
});

// The question --sca-exp-source turns into, asked where it is used: where does the
// Experiment folder sit INSIDE the review source? relativeInside answers it, and null - the
// caller's "nothing to exclude" - is the answer for every folder outside that source, where
// there is no in-source prefix to carve out and the Experiment's own code is reviewed from
// the XPI.
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
// manifest.json's own reference can never find it (normalizeRefInDir drops both), and two
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
      () => loadAddon(file, undefined, XPI),
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

  const addon = loadAddon(file, undefined, XPI);
  assert.ok(addon.files.has("a/b.js"), "keyed without the leading ./");
  assert.equal(readWebExtManifest(addon.store).json.name, "x");

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
      () => loadAddon(file, undefined, XPI),
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

  // One entry that declares no content but carries some: its size fields (local header
  // +22, central +24) and crc32 zeroed, as for an empty file. adm-zip would inflate it
  // without a cap and hand it back empty, so it is refused before inflating.
  const hidden = new AdmZip();
  hidden.addFile(
    "manifest.json",
    Buffer.from('{"manifest_version":3,"name":"x","version":"1"}')
  );
  hidden.addFile("SECRET.js", Buffer.alloc(1 << 20, 0x61));
  const hiddenBuf = hidden.toBuffer();
  for (const [sig, crcAt, sizeAt] of [
    [0x04034b50, 14, 22],
    [0x02014b50, 16, 24],
  ]) {
    for (let at = 0; at < hiddenBuf.length - 4; at++) {
      if (
        hiddenBuf.readUInt32LE(at) === sig &&
        hiddenBuf.includes("SECRET", at)
      ) {
        hiddenBuf.writeUInt32LE(0, at + crcAt);
        hiddenBuf.writeUInt32LE(0, at + sizeAt);
      }
    }
  }
  const sizeZero = path.join(dir, "size-zero.xpi");
  fs.writeFileSync(sizeZero, hiddenBuf);
  refuses(sizeZero);

  // Entries that name one path twice: readers disagree on which copy wins, so the archive
  // has no single meaning. An exact duplicate, two spellings of one path, a path that is a
  // file and a folder, and two names that differ only in case.
  const colliding = (name, files) => {
    const z = new AdmZip();
    files.forEach((_, i) => z.addFile(`f${i}`, Buffer.from("1;")));
    z.getEntries().forEach((e, i) => {
      e.entryName = files[i][0];
    });
    const file = path.join(dir, `${name}.xpi`);
    fs.writeFileSync(file, z.toBuffer());
    return file;
  };
  for (const [name, files] of [
    ["twice", [["manifest.json"], ["manifest.json"]]],
    ["dot-spelling", [["manifest.json"], ["./manifest.json"]]],
    ["file-and-folder", [["lib"], ["lib/a.js"]]],
    ["case-only", [["manifest.json"], ["Manifest.json"]]],
  ]) {
    refuses(colliding(name, files));
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

// A zip bomb is refused by the size its entries DECLARE, before anything is inflated: an
// entry claiming more than the unpacked cap ends the read with the size error, and the
// destination this call created is removed rather than left half-written.
test("an archive declaring more than the unpacked cap is refused before inflating", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-zipcap-"));
  const zip = new AdmZip();
  zip.addFile("manifest.json", Buffer.from('{"manifest_version":3}'));
  zip.addFile("big.js", Buffer.from("x;"));
  const buf = zip.toBuffer();
  // The uncompressed-size field of each header naming big.js: local +22, central +24.
  for (const [sig, sizeAt] of [
    [0x04034b50, 22],
    [0x02014b50, 24],
  ]) {
    for (let at = 0; at < buf.length - 4; at++) {
      if (buf.readUInt32LE(at) === sig && buf.includes("big.js", at)) {
        buf.writeUInt32LE(ADDON_MAX_UNPACKED_BYTES + 1, at + sizeAt);
      }
    }
  }
  const file = path.join(dir, "big.xpi");
  fs.writeFileSync(file, buf);
  const dest = path.join(dir, "big.xpi.extracted");
  assert.throws(() => loadAddon(file, dest, XPI), /unpacked size exceeds/);
  assert.equal(fs.existsSync(dest), false, "the partial extraction is removed");
  fs.rmSync(dir, { recursive: true, force: true });
});

// A packed .xpi is extracted to disk and read back from there - the one way its files
// ever reach addon.files - so the round trip has to be exact: manifest.json included, and
// every other file byte-identical to what was packed.
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
  const addon = loadAddon(file, dest, XPI);

  // On disk: manifest.json included, and in addon.files too.
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

  // Read back the same way a directory submission is: readable as the record, and still in
  // the store with everything else, keyed the same as the packed entries were.
  assert.equal(readWebExtManifest(addon.store).json.name, "x");
  assert.ok(addon.files.has("manifest.json"));
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

  loadAddon(file, undefined, XPI);
  assert.ok(
    fs.existsSync(path.join(dir, "addon.xpi.extracted", "manifest.json"))
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

// In an ADD-ON a node_modules folder is shipped content: extracted and reviewed like any
// other file, and nothing recorded instead.
test("a packed add-on's node_modules is extracted and reviewed like any content", () => {
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

  const shipped = loadAddon(file, path.join(dir, "as-addon"), XPI);
  assert.deepEqual(shipped.nodeModules, []);
  assert.ok(shipped.files.has("node_modules/dep/index.js"));

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
  assert.throws(() => loadAddon(file, dest, XPI));
  assert.ok(!fs.existsSync(dest), "a partial extraction was left behind");

  fs.rmSync(dir, { recursive: true, force: true });
});

// An archive with no real files at all (only directory entries) still leaves a directory
// a later readDir can walk - otherwise loadAddon crashes on a submission that is merely
// useless, not unreadable.
test("an archive with nothing but directories still leaves an empty extracted folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-extract-empty-"));
  const zip = new AdmZip();
  zip.addFile("lib/", Buffer.alloc(0));
  const file = path.join(dir, "addon.xpi");
  zip.writeZip(file);

  const dest = path.join(dir, "addon.xpi.extracted");
  const addon = loadAddon(file, dest, XPI);
  assert.ok(fs.existsSync(dest) && fs.statSync(dest).isDirectory());
  assert.equal(addon.files.size, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

// Which artifact a locus is in comes from the thing holding the file, so the loader has to
// name what it built and the Addon has to be able to mint one. These four tests are that
// contract: without them every downstream label is derived again from the route it was
// reached by, which is what src/lib/artifacts.js exists to replace.
test("each loader names the artifact it built, and the Addon mints loci in it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-kind-"));
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    '{"manifest_version":3,"name":"x","version":"1"}'
  );
  fs.writeFileSync(path.join(dir, "bg.js"), "1;\n");

  assert.equal(loadAddon(dir, undefined, XPI).kind, ARTIFACT_XPI);
  assert.equal(loadSourceArchive(dir).kind, ARTIFACT_SCA);
  // And the narrowed views are the same object, so they answer the same.
  assert.equal(
    scaViews(loadSourceArchive(dir), { scaRoot: dir }).kind,
    ARTIFACT_SCA
  );

  // at() stamps its own kind onto the locus, with the loc it was handed or null.
  assert.deepEqual(loadAddon(dir, undefined, XPI).at("bg.js", { line: 1 }), {
    file: "bg.js",
    loc: { line: 1 },
    artifact: ARTIFACT_XPI,
  });
  assert.deepEqual(loadSourceArchive(dir).at("bg.js"), {
    file: "bg.js",
    loc: null,
    artifact: ARTIFACT_SCA,
  });
});

test("loadAddon refuses to build an artifact that cannot say which one it is", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-nokind-"));
  fs.writeFileSync(path.join(dir, "bg.js"), "1;\n");
  for (const opts of [undefined, {}, { kind: "source" }]) {
    assert.throws(() => loadAddon(dir, undefined, opts), /kind must be/);
  }
});

test("the shipped manifest.json record mints XPI loci whatever read it", () => {
  const record = manifestRecord(
    '{\n  "manifest_version": 3,\n  "permissions": ["tabs"]\n}'
  );
  // The JSON path resolves to the line the value is on, and the artifact is the XPI's by
  // construction: the record IS the shipped declaration, so there is no second answer.
  assert.deepEqual(record.locus("permissions"), {
    file: "manifest.json",
    loc: { line: 3 },
    artifact: ARTIFACT_XPI,
  });
  // A path the file does not have still mints - the finding is about the ABSENT key, and
  // "nowhere in manifest.json" is a locus a reader can act on.
  assert.deepEqual(record.locus("browser_specific_settings", "gecko"), {
    file: "manifest.json",
    loc: null,
    artifact: ARTIFACT_XPI,
  });
  // NO path at all: the locus is the manifest.json itself, which sits on no single line.
  // The JSON tree would answer its root node here, whose offset is 0 and whose line is
  // therefore 1 - a line the reader would open and find nothing at, since every caller
  // asking with no path is talking about the file as a whole or about an ABSENT key.
  assert.deepEqual(record.locus(), {
    file: "manifest.json",
    loc: null,
    artifact: ARTIFACT_XPI,
  });
});

test("an unparsable manifest.json still mints, with no line", () => {
  const record = manifestRecord("{ not json");
  assert.ok(record.error);
  assert.deepEqual(record.locus("permissions"), {
    file: "manifest.json",
    loc: null,
    artifact: ARTIFACT_XPI,
  });
});

// A file this machine cannot read makes the submission invalid: reviewed as empty, its code
// would be absent and raise no finding. Refused when the tree is loaded, naming the artifact,
// the file and the reason. (As root a permission denies nothing, so there is nothing to show.)
test("an unreadable file makes the submission invalid at load", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root reads every file");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-unreadable-"));
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    '{"manifest_version":3,"name":"x","version":"1"}'
  );
  const locked = path.join(dir, "bg.js");
  fs.writeFileSync(locked, "browser.runtime.id;\n");
  fs.chmodSync(locked, 0o000);
  try {
    assert.throws(() => loadAddon(dir, undefined, XPI), {
      message: "Invalid XPI: bg.js cannot be read (permission denied).",
    });
    assert.throws(() => loadSourceArchive(dir), {
      message:
        "Invalid source archive: bg.js cannot be read (permission denied).",
    });
  } finally {
    fs.chmodSync(locked, 0o644);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A file that leaves the disk after the tree was loaded is not the submission's fault, but a
// read that fails mid-review ends it as an I/O error rather than reviewing an empty file.
test("a file that cannot be read mid-review is an I/O error, not an empty file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-vanished-"));
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    '{"manifest_version":3,"name":"x","version":"1"}'
  );
  fs.writeFileSync(path.join(dir, "bg.js"), "browser.runtime.id;\n");
  const addon = loadAddon(dir, undefined, XPI);
  fs.rmSync(path.join(dir, "bg.js"));
  assert.throws(
    () => addon.files.get("bg.js"),
    (err) => err.class === ERROR_CLASS.IO
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// An archive's directory entries are created on extraction, so an empty one - which no file
// key can show - is recorded like a folder's: Thunderbird lists it (an empty
// _locales/<dir>/ is a locale it tries to read). A name that is both a file and a folder
// has no single meaning, and refuses the archive.
test("loadAddon(file) records an archive's empty directory entries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrr-dirent-"));
  const zip = new AdmZip();
  zip.addFile("manifest.json", Buffer.from(MANIFEST));
  zip.addFile("_locales/fr/", Buffer.alloc(0));
  const file = path.join(dir, "addon.xpi");
  zip.writeZip(file);
  const addon = loadAddon(file, path.join(dir, "out"), XPI);
  assert.ok(addon.directories.includes("_locales/fr"), addon.directories);

  const clash = new AdmZip();
  clash.addFile("manifest.json", Buffer.from(MANIFEST));
  clash.addFile("lib", Buffer.from("x"));
  clash.addFile("lib/", Buffer.alloc(0));
  const bad = path.join(dir, "clash.xpi");
  clash.writeZip(bad);
  assert.throws(() => loadAddon(bad, path.join(dir, "out2"), XPI), {
    message: `Could not read archive: ${bad}`,
  });

  fs.rmSync(dir, { recursive: true, force: true });
});
