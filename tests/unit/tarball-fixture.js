// Build a tiny gzipped tar (ustar) in memory for the vendor-tarball tests. Not a
// test file (no `*.test.js`), so the runner does not execute it; both
// tarball.test.js and vendor-verify.test.js import makeTgz from here.

import zlib from "node:zlib";

const BLOCK = 512;

/** A 512-byte ustar header. typeflag defaults to 0x30 ('0' = regular file). */
function header(name, size, type = 0x30) {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, "utf8"); // name (0..100)
  h.write("0000644\0", 100, "ascii"); // mode
  h.write("0000000\0", 108, "ascii"); // uid
  h.write("0000000\0", 116, "ascii"); // gid
  h.write(size.toString(8).padStart(11, "0"), 124, "ascii"); // size (octal)
  h.write("00000000000", 136, "ascii"); // mtime
  h.write("        ", 148, "ascii"); // checksum placeholder (8 spaces)
  h[156] = type; // typeflag
  h.write("ustar\0", 257, "ascii"); // magic
  h.write("00", 263, "ascii"); // version
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += h[i];
  }
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii"); // checksum
  return h;
}

/**
 * @param {Record<string,string>|{name:string,content?:string,type?:number}[]} entries
 * @returns {Buffer} gzipped tar
 */
export function makeTgz(entries) {
  const list = Array.isArray(entries)
    ? entries
    : Object.entries(entries).map(([name, content]) => ({ name, content }));
  const blocks = [];
  for (const { name, content, type } of list) {
    const data = Buffer.from(content ?? "");
    blocks.push(header(name, data.length, type));
    if (data.length) {
      const padded = Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK);
      data.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(2 * BLOCK)); // end-of-archive: two zero blocks
  return zlib.gzipSync(Buffer.concat(blocks));
}
