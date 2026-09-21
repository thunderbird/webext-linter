// Reads an npm-registry package tarball (.tgz) into the set of EOL-normalized
// content hashes of its files, so a vendored copy can be verified by membership -
// the same shape as the experiment allow-list (src/experiments/verify.js). The
// tarball is the whole package, so we hash every regular file and never rely on the
// in-archive path: a bundled file is "from this package" when its content hash is in
// the set, regardless of where it sits inside.
//
// gzip is node:zlib; the tar layer is a small ustar reader (the repo has adm-zip for
// ZIP but no tar lib). We only need file CONTENT, so metadata entries (PAX 'x'/'g',
// GNU longname 'L', directories, links) are skipped - their data blocks are stepped
// over by the header size, keeping the stream aligned - and never hashed.
//
// Belongs here: gunzip + tar walk + hashing. Does NOT belong here: fetching
// (src/vendor/verify.js), classification (src/vendor/sources.js), or the hash
// transform (src/normalize/hash.js).

import zlib from "node:zlib";

import { normalizedSha256 } from "../normalize/hash.js";
import { VENDOR_TARBALL_MAX_UNPACKED_BYTES } from "../config.js";

const BLOCK = 512;

/**
 * Parse a tar header's size field (octal ASCII, NUL/space padded). GNU base-256
 * (high bit of the first byte set) is not produced for the small files in an npm
 * package, so an unparsable size yields NaN and stops the walk.
 * @param {Buffer} header
 * @returns {number}
 */
function headerSize(header) {
  if (header[124] & 0x80) {
    return NaN; // base-256 encoded - not expected from npm; bail out safely
  }
  const raw = header.toString("latin1", 124, 136).replace(/[\s\0]+$/, "");
  return raw ? parseInt(raw, 8) : 0;
}

/**
 * A tar header's file name: the 100-byte `name` field, NUL-terminated, with npm's
 * single top-level `package/` directory stripped. The ustar `prefix` field is not
 * read - npm's own paths are far short of 100 bytes, and a name that did overflow
 * would come back without its prefix rather than wrong, so it simply fails to match.
 * @param {Buffer} header
 * @returns {string}
 */
function headerName(header) {
  const raw = header.toString("latin1", 0, 100);
  const end = raw.indexOf("\0");
  const name = (end === -1 ? raw : raw.slice(0, end)).trim();
  return name.startsWith("package/") ? name.slice("package/".length) : name;
}

/** @param {Buffer} block @returns {boolean} all-zero (the archive terminator). */
function isZeroBlock(block) {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) {
      return false;
    }
  }
  return true;
}

/**
 * The EOL-normalized SHA-256 of every regular file in a gzipped npm tarball, KEYED
 * BY ITS PATH INSIDE THE PACKAGE.
 *
 * The walk always read the name; only the membership caller had no use for it. A
 * caller that knows which file a declaration points AT wants the path back, so it
 * can ask "are these the bytes published at THAT path" rather than the weaker "are
 * these bytes published anywhere in this package" - the difference between a
 * declaration that checks out and one that merely names the right package.
 *
 * npm publishes every entry under a single `package/` directory, which is an
 * artifact of the tarball rather than part of any path a source URL names, so it is
 * stripped here. A duplicate path keeps the FIRST entry, the same way a tar is
 * unpacked.
 * @param {Buffer} tgz  The downloaded .tgz bytes.
 * @returns {Map<string, string>}  In-package path -> normalized content hash.
 * @throws if the stream is not gzip, exceeds the unpacked cap, or is malformed.
 */
export function tarballFileHashes(tgz) {
  const tar = zlib.gunzipSync(tgz, {
    maxOutputLength: VENDOR_TARBALL_MAX_UNPACKED_BYTES,
  });
  const byPath = new Map();
  let off = 0;
  while (off + BLOCK <= tar.length) {
    const header = tar.subarray(off, off + BLOCK);
    if (isZeroBlock(header)) {
      break; // end-of-archive marker
    }
    const size = headerSize(header);
    if (!Number.isInteger(size) || size < 0) {
      break; // malformed header - stop rather than misread
    }
    const type = header[156]; // typeflag: 0x30 '0' or 0x00 NUL = regular file
    const dataStart = off + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) {
      break; // truncated
    }
    if (type === 0x30 || type === 0x00) {
      const path = headerName(header);
      if (path && !byPath.has(path)) {
        byPath.set(path, normalizedSha256(tar.subarray(dataStart, dataEnd)));
      }
    }
    // Advance past the header + the data (padded up to the next 512 boundary).
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  return byPath;
}

/**
 * The EOL-normalized SHA-256 of every regular file in a gzipped npm tarball, as a
 * set - for the callers that ask whether bytes are published in this package at all,
 * without caring where (verifyTarball, and a folder declaration, which names no
 * per-file source to check a path against).
 * @param {Buffer} tgz  The downloaded .tgz bytes.
 * @returns {Set<string>}  Normalized content hashes (see src/normalize/hash.js).
 * @throws if the stream is not gzip, exceeds the unpacked cap, or is malformed.
 */
export function tarballHashes(tgz) {
  return new Set(tarballFileHashes(tgz).values());
}
