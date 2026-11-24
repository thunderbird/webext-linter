// The linter's extraction of a submitted SOURCE archive, for --llm-auto-review: the archive
// beside the .xpi, written out as the tree the review reads (the work folder's sca/).
//
// ATN accepts nine source archive types (addons-server VALID_SOURCE_EXTENSIONS: .zip, .tar,
// .7z, .tar.gz, .tgz, .tbz, .txz, .tar.bz2, .tar.xz) and never opens them, so this is the
// first thing that does. They are all read through libarchive, compiled to WebAssembly
// (libarchive-wasm), so the linter extracts the same on every platform and needs no tool of
// the system's. The format is read from the archive's first bytes, never its name: ATN
// renames uploads (`…-src.tar_UubDLRC.gz`).
//
// The archive is unpacked until the source appears, as a reader is told to: where what one
// layer holds is a single file that is itself an accepted archive (a .zip holding only a
// .tar.gz), that file is unpacked in its place. An archive found inside the source, beside
// other files, stays packed, for the review to report as a committed build artifact.
//
// libarchive only reads: every file, folder and link is written here, after its entry was
// judged, so the rules the XPI's extraction holds an archive to (src/addon/load.js) hold here
// too. A source archive may hold symbolic links, unlike an XPI: each is created as it was
// stored and never followed, for the walk to record where it points (sca-invalid-symlink).
//
// Belongs here: telling an accepted source archive by its bytes, unpacking its layers, and
// judging and writing each entry. Does NOT belong here: which file of a submission folder is
// the source (-> ./submission.js), where it is extracted (-> src/util/dest.js workPaths), or
// what the review makes of the tree (-> ./load.js, the checks).

import fs from "node:fs";
import path from "node:path";

import { ArchiveReader, libarchiveWasm } from "libarchive-wasm";

import {
  entryKey,
  isSafeAddonPath,
  namesCollide,
  relativeInside,
} from "./load.js";
import { SOURCE_ARCHIVE_MAX_UNPACKED_BYTES } from "../config.js";
import { trimEndOf } from "../util/text.js";

/** The archive types ATN accepts, as a refusal names them. */
export const ACCEPTED_SOURCE_ARCHIVES =
  ".zip, .tar, .7z, .tar.gz, .tgz, .tbz, .txz, .tar.bz2 and .tar.xz";

/** How many layers are unpacked before an archive is taken to be packed in itself forever. */
const MAX_LAYERS = 4;

/**
 * The first bytes of each accepted container: zip, 7z, and the three compressed streams a
 * tarball is packed in (gzip, bzip2, xz). A plain tar is told by its `ustar` mark instead.
 */
const MAGIC = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
  [0x1f, 0x8b],
  [0x42, 0x5a, 0x68],
  [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
];

/** Where a POSIX tar header carries its `ustar` mark. */
const TAR_MAGIC_AT = 257;

/**
 * Whether `bytes` begin as one of the accepted archive types. A gzip, bzip2 or xz stream is
 * accepted here and read as the tar it must hold: one that holds anything else is refused
 * when it is read.
 * @param {Buffer} bytes
 * @returns {boolean}
 */
export function isSourceArchive(bytes) {
  const starts = (magic) =>
    bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
  if (MAGIC.some(starts)) {
    return true;
  }
  return (
    bytes.length >= TAR_MAGIC_AT + 5 &&
    bytes.subarray(TAR_MAGIC_AT, TAR_MAGIC_AT + 5).toString("latin1") ===
      "ustar"
  );
}

/**
 * A refusal of the archive: why it cannot be extracted, naming the archive.
 * @param {string} archive
 * @param {string} why
 * @returns {Error}
 */
function refused(archive, why) {
  return new Error(`Could not extract the source archive ${archive}: ${why}`);
}

/**
 * Extract a submitted source archive into `destDir`, a folder nothing is in yet, unpacking
 * its layers until the source appears. Refused - `destDir` removed, so no part of a tree is
 * ever reviewed - for an archive of no accepted type, one libarchive cannot read, an entry
 * whose name or type it will not take, a path twice, encrypted data, a link the platform
 * cannot create, or more than `maxBytes` unpacked.
 * @param {string} archive  The source archive, absolute.
 * @param {string} destDir  Where to write it.
 * @param {{maxBytes?: number}} [opts]  The unpacked-size cap, for a test to lower.
 * @returns {Promise<void>}
 * @throws {Error}  The refusal, naming the archive and the problem.
 */
export async function extractSourceArchive(
  archive,
  destDir,
  { maxBytes = SOURCE_ARCHIVE_MAX_UNPACKED_BYTES } = {}
) {
  const lib = await libarchiveWasm();
  try {
    let bytes = fs.readFileSync(archive);
    for (let layer = 0; ; layer++) {
      if (!isSourceArchive(bytes)) {
        throw refused(
          archive,
          `it is none of the archive types ATN accepts (${ACCEPTED_SOURCE_ARCHIVES})`
        );
      }
      fs.rmSync(destDir, { recursive: true, force: true });
      fs.mkdirSync(destDir, { recursive: true });
      const files = writeLayer(lib, bytes, destDir, archive, maxBytes);
      // A layer holding one file that is itself an accepted archive is a wrapping, not the
      // source: that file is unpacked in its place.
      const [only] = files;
      if (files.length !== 1) {
        return;
      }
      const inner = fs.readFileSync(only);
      if (!isSourceArchive(inner)) {
        return;
      }
      if (layer + 1 >= MAX_LAYERS) {
        throw refused(
          archive,
          `it is packed more than ${MAX_LAYERS} times over`
        );
      }
      bytes = inner;
    }
  } catch (err) {
    fs.rmSync(destDir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Write one layer's entries into `destDir`, each judged before its data is read, and return
 * the regular files written, as absolute paths.
 * @param {object} lib  The libarchive module.
 * @param {Buffer} bytes  The layer's archive.
 * @param {string} destDir
 * @param {string} archive  The submitted archive, as a refusal names it.
 * @param {number} maxBytes
 * @returns {string[]}
 * @throws {Error}
 */
function writeLayer(lib, bytes, destDir, archive, maxBytes) {
  let reader;
  try {
    reader = new ArchiveReader(lib, new Int8Array(bytes));
  } catch {
    throw refused(archive, "libarchive cannot read it");
  }
  const files = [];
  const keys = [];
  const links = new Set();
  let unpacked = 0;
  try {
    for (const entry of entriesOf(reader, archive)) {
      const key = trimEndOf(entryKey(entry.getPathname()), "/");
      const type = entry.getFiletype();
      // The archive's own root folder ("./"), which names nothing.
      if (key === "" && type === "Directory") {
        continue;
      }
      // A name that steps out of the tree, is absolute, or can be spelled two ways: the
      // rules the XPI's extraction holds a name to.
      if (!isSafeAddonPath(key)) {
        throw refused(
          archive,
          `it holds an entry named "${key}", which leaves the archive`
        );
      }
      const dest = path.join(destDir, ...key.split("/"));
      if (relativeInside(dest, destDir) === null) {
        throw refused(
          archive,
          `it holds an entry named "${key}", which leaves the archive`
        );
      }
      // A name inside a link the archive stored would be written wherever that link points,
      // which no check of the name itself can see.
      const via = linkAbove(key, links);
      if (via) {
        throw refused(
          archive,
          `its entry "${key}" lies inside the symbolic link "${via}"`
        );
      }
      if (entry.isEncrypted()) {
        throw refused(archive, `its entry "${key}" is encrypted`);
      }
      if (type === "Directory") {
        fs.mkdirSync(dest, { recursive: true });
        continue;
      }
      keys.push(key);
      if (type === "SymbolicLink") {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        writeLink(entry.getSymlinkTarget(), dest, key, archive);
        links.add(key);
        continue;
      }
      // A hard link is a second name for a file the archive already holds: no file of its
      // own, and two names for one file have no single meaning.
      if (type !== "File" || entry.getHardlinkTarget()) {
        throw refused(
          archive,
          `its entry "${key}" is a ${entry.getHardlinkTarget() ? "hard link" : type}, ` +
            "which a source archive may not hold"
        );
      }
      // Bound decompression by the declared size before the data is read, then by the bytes
      // that came back.
      if (unpacked + entry.getSize() > maxBytes) {
        throw refused(archive, `it unpacks to more than ${maxBytes} bytes`);
      }
      const data = entry.readData() ?? new Int8Array(0);
      unpacked += data.length;
      if (unpacked > maxBytes) {
        throw refused(archive, `it unpacks to more than ${maxBytes} bytes`);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
      files.push(dest);
    }
  } finally {
    reader.free();
  }
  // Two entries naming one path, in any spelling or case: whichever was written last would
  // be the one reviewed.
  if (namesCollide(keys)) {
    throw refused(archive, "it names one path twice");
  }
  return files;
}

/**
 * The link among `links` that `key` lies inside, a folder of its own path, or undefined.
 * @param {string} key
 * @param {Set<string>} links  The keys of the links written so far.
 * @returns {string|undefined}
 */
function linkAbove(key, links) {
  const segments = key.split("/");
  for (let i = 1; i < segments.length; i++) {
    const folder = segments.slice(0, i).join("/");
    if (links.has(folder)) {
      return folder;
    }
  }
  return undefined;
}

/**
 * The entries of an open archive, a read error turned into the archive's refusal.
 * @param {ArchiveReader} reader
 * @param {string} archive
 * @returns {Generator<import("libarchive-wasm").ArchiveReaderEntry>}
 */
function* entriesOf(reader, archive) {
  const it = reader.entries();
  for (;;) {
    let next;
    try {
      next = it.next();
    } catch {
      throw refused(archive, "libarchive cannot read it");
    }
    if (next.done) {
      return;
    }
    yield next.value;
  }
}

/**
 * Create a link the archive stored, exactly as stored and never followed. A platform that
 * does not let this process create links (Windows without the right) cannot hold the tree as
 * submitted, so the extraction is refused, saying how to review it instead.
 * @param {string} target  Where the link points, as stored.
 * @param {string} dest  Where the link is created.
 * @param {string} key  Its name in the archive.
 * @param {string} archive
 * @returns {void}
 * @throws {Error}
 */
function writeLink(target, dest, key, archive) {
  try {
    fs.symlinkSync(target, dest);
  } catch (err) {
    if (
      err.code === "EPERM" ||
      err.code === "EACCES" ||
      err.code === "ENOSYS"
    ) {
      throw refused(
        archive,
        `it holds the symbolic link "${key}", which this system does not let the linter ` +
          "create. Extract the archive yourself and review it with --sca-extracted"
      );
    }
    throw err;
  }
}
