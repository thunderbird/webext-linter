// One way to write a file that must never be seen half-written: to a temp name in
// the same directory, then rename over the target. Every cache and download in the
// tool goes through here, so an interrupted run leaves either the old bytes or the
// new ones, never a truncated cache that the next run happily reads as valid.
//
// Belongs here: the write-then-rename dance (and cleaning up the temp file when it
// fails), and writing a file that is to stay read-only. Does NOT belong here: what is written, where a cache lives, or whether a
// failed write matters - each caller decides that (a download throws, a cache logs
// and carries on).

import fs from "node:fs";
import path from "node:path";

/**
 * Write `data` to `file`, atomically. The temp file is a sibling, so the rename is
 * within one filesystem; the directory is created if it does not exist yet.
 * @param {string} file  The final path.
 * @param {string|Buffer} data
 */
export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) {
      fs.rmSync(tmp, { force: true });
    }
  }
}

/** The mode a read-only file is left at: readable, and writable by nobody. */
const READ_ONLY = 0o444;

/** The mode a read-only file takes for the moment it is replaced. */
const WRITABLE = 0o644;

/**
 * Write `data` to `file` atomically, and leave it read-only. A file this wrote before is
 * read-only, and Windows will not rename over one, so the target is made writable for the
 * moment it is replaced. A rename on POSIX needs only the folder.
 * @param {string} file  The final path.
 * @param {string|Buffer} data
 */
export function writeReadOnlyFileAtomic(file, data) {
  if (fs.existsSync(file)) {
    fs.chmodSync(file, WRITABLE);
  }
  writeFileAtomic(file, data);
  fs.chmodSync(file, READ_ONLY);
}
