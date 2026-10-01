// Zip-entry facts both archive readers act on before inflating: the add-on extractor
// (src/addon/load.js) and the vendor repo-archive hasher (src/vendor/archive.js).
//
// Belongs here: predicates over an adm-zip entry's header. Does NOT belong here: opening
// an archive, inflating an entry, or what a reader does with a refused entry.

// The most compressed bytes an empty file takes: 2 for an empty deflate stream, 5 for an
// empty stored block, with room for any encoder. Small enough that inflating it is free.
const EMPTY_STREAM_MAX_BYTES = 16;

/**
 * Whether an entry declares no content but carries compressed data. adm-zip bounds
 * inflation by the declared size only when it is non-zero, so such an entry inflates
 * without limit, and with a matching empty-data CRC it is then returned as an empty file
 * - its real content never reaches the reader. Checked before getData().
 * @param {import("adm-zip").IZipEntry} entry
 * @returns {boolean}
 */
export function hidesItsSize(entry) {
  return (
    entry.header.size === 0 &&
    entry.header.compressedSize > EMPTY_STREAM_MAX_BYTES
  );
}
