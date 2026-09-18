// Where to extract an archive on disk without clobbering a leftover from an earlier
// run: one check, no retry loop. Shared by the XPI submission (src/addon/load.js) and
// the SCA source archive (src/addon/submission.js), so a reviewer sees one naming
// convention for both.
//
// Belongs here: choosing the destination path. Does NOT belong here: writing anything
// there, or deciding what "beside" means for the caller's own file (each caller joins
// its own directory/basename before calling this).

import fs from "node:fs";

/**
 * `base` if nothing is there yet, otherwise `base` with a timestamp suffix.
 *
 * A collision is not chased further than that: two runs starting in the same
 * millisecond would still collide, which reviewFileBase (src/report/items.js) already
 * accepts for the same reason - a caller polling this in a loop is not what either
 * exists for.
 * @param {string} base
 * @returns {string}
 */
export function extractionDestination(base) {
  if (!fs.existsSync(base)) {
    return base;
  }
  const at = new Date().toISOString().replace(/[:.]/g, "-");
  return `${base}-${at}`;
}
