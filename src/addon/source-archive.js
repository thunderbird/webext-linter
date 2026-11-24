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

import { entryKey, isSafeAddonPath, relativeInside } from "./load.js";
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

/** A rejection of the archive, told apart from any other error an entry's extraction throws. */
class SourceArchiveRefused extends Error {}

/**
 * A refusal of the archive: why it cannot be extracted, naming the archive.
 * @param {string} archive
 * @param {string} why
 * @returns {SourceArchiveRefused}
 */
function refused(archive, why) {
  return new SourceArchiveRefused(
    `Could not extract the source archive ${archive}: ${why}`
  );
}

/**
 * Extract a submitted source archive into `destDir`, a folder nothing is in yet, unpacking
 * its layers until the source appears. Refused - `destDir` removed, so no part of a tree is
 * ever reviewed - for an archive of no accepted type, one libarchive cannot read to its end,
 * an entry whose name is not UTF-8 or whose name or type it will not take, a path twice or
 * inside a link, encrypted data, a link the platform cannot create, any other error writing
 * an entry, or more than `maxBytes` unpacked.
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
 * Write one layer's entries into `destDir`, each judged before anything of it is written, and
 * return the regular files written, as absolute paths. A layer libarchive cannot read to its
 * end is rejected after the loop, so no part of one is ever reviewed.
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
  const layer = {
    destDir,
    archive,
    maxBytes,
    files: [],
    written: new Map(),
    unpacked: 0,
  };
  try {
    for (const entry of entriesOf(reader, archive)) {
      const raw = entry.getPathname();
      try {
        writeEntry(entry, raw, layer);
      } catch (err) {
        if (err instanceof SourceArchiveRefused) {
          throw err;
        }
        throw refused(
          archive,
          `its entry "${raw}" could not be extracted: ${err.message}`
        );
      }
    }
    // libarchive ends its entries the same way at the archive's end and at a read error: only
    // the error it recorded tells them apart.
    const why = lib.error_string(reader.archive);
    if (why) {
      throw refused(archive, `libarchive could not read it to the end: ${why}`);
    }
  } finally {
    reader.free();
  }
  return layer.files;
}

/**
 * Judge one entry and write it: a folder made, a link created, a file written.
 * @param {import("libarchive-wasm").ArchiveReaderEntry} entry
 * @param {string} raw  Its name as libarchive gives it, "" where that is not UTF-8.
 * @param {{destDir: string, archive: string, maxBytes: number, files: string[],
 *   written: Map<string, object>, unpacked: number}} layer  What the layer wrote so far
 *   (judgeName says what `written` holds).
 * @returns {void}
 * @throws {SourceArchiveRefused}
 */
function writeEntry(entry, raw, layer) {
  const { destDir, archive, maxBytes } = layer;
  if (raw === "") {
    throw refused(archive, "it holds an entry whose name is not UTF-8");
  }
  const key = trimEndOf(entryKey(raw), "/");
  const type = entry.getFiletype();
  // The archive's own root folder ("./"), which names nothing.
  if (key === "" && type === "Directory") {
    return;
  }
  // A name that steps out of the tree, is absolute, or can be spelled two ways: the rules the
  // XPI's extraction holds a name to.
  const dest = path.join(destDir, ...key.split("/"));
  if (!isSafeAddonPath(key) || relativeInside(dest, destDir) === null) {
    throw refused(
      archive,
      `it holds an entry named "${key}", which leaves the archive`
    );
  }
  if (entry.isEncrypted()) {
    throw refused(archive, `its entry "${key}" is encrypted`);
  }
  const kind =
    type === "Directory" ? "folder" : type === "SymbolicLink" ? "link" : "file";
  // A hard link is a second name for a file the archive already holds: no file of its own,
  // and two names for one file have no single meaning.
  if (kind === "file" && (type !== "File" || entry.getHardlinkTarget())) {
    throw refused(
      archive,
      `its entry "${key}" is a ${entry.getHardlinkTarget() ? "hard link" : type}, ` +
        "which a source archive may not hold"
    );
  }
  judgeName(key, kind, layer);
  if (kind === "folder") {
    fs.mkdirSync(dest, { recursive: true });
    return;
  }
  if (kind === "link") {
    const target = entry.getSymlinkTarget();
    if (target === "") {
      throw refused(
        archive,
        `its link "${key}" points at a name that is not UTF-8`
      );
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeLink(target, dest, key, archive);
    return;
  }
  // Bound decompression by the declared size before the data is read, then by the bytes that
  // came back.
  if (layer.unpacked + entry.getSize() > maxBytes) {
    throw refused(archive, `it unpacks to more than ${maxBytes} bytes`);
  }
  const data = entry.readData() ?? new Int8Array(0);
  layer.unpacked += data.length;
  if (layer.unpacked > maxBytes) {
    throw refused(archive, `it unpacks to more than ${maxBytes} bytes`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, data);
  layer.files.push(dest);
}

/**
 * Judge an entry's name against every name the layer wrote before it, compared case-folded,
 * since a case-insensitive disk takes `Lib` and `lib` as one name, and record it. Asked
 * before anything of the entry is written: a name written twice would be written through
 * whatever the first one left there, a link included. Rejected: a name written before (a
 * folder named again as a folder aside), a name inside a file, and a name inside a link,
 * which would be written wherever that link points.
 * @param {string} key
 * @param {"file"|"folder"|"link"} kind
 * @param {{archive: string, written: Map<string, {kind: string, key: string}>}} layer
 *   `written` maps each name written, case-folded, and every folder above one, to its kind
 *   and its name as the archive spelled it.
 * @returns {void}
 * @throws {SourceArchiveRefused}
 */
function judgeName(key, kind, { archive, written }) {
  const segments = key.toLowerCase().split("/");
  for (let i = 1; i < segments.length; i++) {
    const above = segments.slice(0, i).join("/");
    const was = written.get(above);
    if (was?.kind === "link") {
      throw refused(
        archive,
        `its entry "${key}" lies inside the symbolic link "${was.key}"`
      );
    }
    if (was?.kind === "file") {
      throw refused(archive, "it names one path twice");
    }
  }
  const folded = segments.join("/");
  const was = written.get(folded);
  if (was && !(was.kind === "folder" && kind === "folder")) {
    throw refused(archive, "it names one path twice");
  }
  const spelled = key.split("/");
  for (let i = 1; i < segments.length; i++) {
    written.set(segments.slice(0, i).join("/"), {
      kind: "folder",
      key: spelled.slice(0, i).join("/"),
    });
  }
  written.set(folded, { kind, key });
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
