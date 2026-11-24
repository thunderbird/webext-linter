// The linter's extraction of a submitted source archive (src/addon/source-archive.js): every
// type ATN accepts gives the same tree, a wrapping archive is unpacked in its place, an archive
// inside the source stays packed, links are created and never followed, and every entry it will
// not take refuses the whole archive, leaving nothing behind. The archives are committed under
// tests/fixtures/source-archives/, whose README says how each was made.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractSourceArchive,
  isSourceArchive,
} from "../../src/addon/source-archive.js";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "source-archives"
);

/** The tree every `source.*` fixture holds, file by file. */
const TREE = {
  "README.md": "# Pebble Sorter\n\nBuild with `npm ci && npm run build`.\n",
  "package.json": '{"name":"pebble-sorter","version":"1.0.0"}\n',
  "src/lib/sort.js": "export const sort = (a) => [...a].sort();\n",
  "src/main.js":
    'import { sort } from "./lib/sort.js";\nconsole.log(sort([3, 1, 2]));\n',
};

/** A fresh folder to extract into: `sca/` inside a temporary one, not there yet. */
function destination() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wl-sca-")), "sca");
}

/** Every regular file under `dir`, by its path relative to it, with its text. */
function filesOf(dir) {
  const out = {};
  const walk = (at, rel) => {
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      const key = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(path.join(at, e.name), key);
      } else if (e.isFile()) {
        out[key] = fs.readFileSync(path.join(at, e.name), "utf8");
      }
    }
  };
  walk(dir, "");
  return out;
}

/** Extract `fixture` and expect it refused with `why`, leaving no folder behind. */
async function refusedWith(fixture, why, opts) {
  const dest = destination();
  const archive = path.join(FIXTURES, fixture);
  await assert.rejects(extractSourceArchive(archive, dest, opts), (err) => {
    assert.ok(
      err.message.startsWith(
        `Could not extract the source archive ${archive}: `
      ),
      err.message
    );
    assert.ok(err.message.includes(why), err.message);
    return true;
  });
  assert.ok(!fs.existsSync(dest), `${fixture}: nothing is left behind`);
  fs.rmSync(path.dirname(dest), { recursive: true, force: true });
}

for (const name of [
  "source.zip",
  "source.tar",
  "source.7z",
  "source.tar.gz",
  "source.tgz",
  "source.tbz",
  "source.txz",
  "source.tar.bz2",
  "source.tar.xz",
]) {
  test(`a ${name.slice("source".length)} source archive extracts to its tree`, async () => {
    const dest = destination();
    await extractSourceArchive(path.join(FIXTURES, name), dest);
    assert.deepEqual(filesOf(dest), TREE);
    fs.rmSync(path.dirname(dest), { recursive: true, force: true });
  });
}

// The type is read from the content: ATN renames an upload, so the name says nothing.
test("an archive is told by its content, not its name", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-renamed-"));
  const renamed = path.join(dir, "src-1.0.tar_UubDLRC.gz");
  fs.copyFileSync(path.join(FIXTURES, "source.tar.xz"), renamed);
  const dest = path.join(dir, "sca");
  await extractSourceArchive(renamed, dest);
  assert.deepEqual(filesOf(dest), TREE);
  assert.equal(isSourceArchive(Buffer.from("just text, long enough")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A layer holding a single accepted archive is a wrapping, unpacked in its place until the
// source appears: here a .zip holding only a renamed .tar.gz.
test("an archive holding only another archive is unpacked until the source appears", async () => {
  const dest = destination();
  await extractSourceArchive(path.join(FIXTURES, "nested.zip"), dest);
  assert.deepEqual(filesOf(dest), TREE);
  fs.rmSync(path.dirname(dest), { recursive: true, force: true });
});

// An archive beside other files is part of the source, kept packed for the review to report.
test("an archive inside the source, beside other files, stays packed", async () => {
  const dest = destination();
  await extractSourceArchive(path.join(FIXTURES, "beside.tar.gz"), dest);
  const files = Object.keys(filesOf(dest)).sort();
  assert.deepEqual(files, [...Object.keys(TREE), "vendor/lib.zip"].sort());
  assert.deepEqual(
    fs.readFileSync(path.join(dest, "vendor", "lib.zip")),
    fs.readFileSync(path.join(FIXTURES, "source.zip"))
  );
  fs.rmSync(path.dirname(dest), { recursive: true, force: true });
});

// A link is created as stored, pointing in or out, and never followed: the walk records where
// it points and sca-invalid-symlink judges it.
test("a symbolic link is created as stored and never followed", async () => {
  const dest = destination();
  await extractSourceArchive(path.join(FIXTURES, "links.tar"), dest);
  assert.deepEqual(filesOf(dest), TREE);
  for (const [name, target] of [
    ["src/inside.js", "lib/sort.js"],
    ["src/outside.js", "../../outside.txt"],
  ]) {
    const at = path.join(dest, ...name.split("/"));
    assert.ok(fs.lstatSync(at).isSymbolicLink(), name);
    assert.equal(fs.readlinkSync(at), target, name);
  }
  assert.ok(!fs.existsSync(path.join(path.dirname(dest), "..", "outside.txt")));
  fs.rmSync(path.dirname(dest), { recursive: true, force: true });
});

test("an entry that steps out of the folder is refused", async () => {
  await refusedWith("dotdot.tar", 'named "../x.txt", which leaves the archive');
  await refusedWith(
    "absolute.tar",
    'named "/abs/x.txt", which leaves the archive'
  );
  await refusedWith(
    "backslash.tar",
    'named "a\\b.txt", which leaves the archive'
  );
});

// A name inside a stored link would be written wherever the link points.
test("an entry inside a stored link is refused before it is written", async () => {
  await refusedWith(
    "through-link.tar",
    'its entry "lib/z.txt" lies inside the symbolic link "lib"'
  );
});

test("an archive naming one path twice is refused", async () => {
  await refusedWith("twice.tar", "it names one path twice");
});

test("a hard link is refused", async () => {
  await refusedWith("hardlink.tar", 'its entry "b.txt" is a hard link');
});

test("an encrypted entry is refused", async () => {
  await refusedWith("encrypted.zip", 'its entry "README.md" is encrypted');
});

// zstd and rar are archives ATN does not accept, so neither is read.
test("an archive of a type ATN does not accept is refused", async () => {
  await refusedWith(
    "source.tar.zst",
    "it is none of the archive types ATN accepts (.zip, .tar, .7z"
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-rar-"));
  const rar = path.join(dir, "source.rar");
  fs.writeFileSync(
    rar,
    Buffer.concat([Buffer.from("Rar!\x1a\x07\x00", "latin1"), Buffer.alloc(64)])
  );
  const dest = path.join(dir, "sca");
  await assert.rejects(
    extractSourceArchive(rar, dest),
    /none of the archive types/
  );
  assert.ok(!fs.existsSync(dest));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an archive that unpacks past the cap is refused", async () => {
  await refusedWith("source.tar.gz", "it unpacks to more than 100 bytes", {
    maxBytes: 100,
  });
});
