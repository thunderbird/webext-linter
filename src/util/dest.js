// The naming convention for what a run puts on disk beside a submission, in BOTH
// directions: where to extract an archive without clobbering a leftover from an earlier
// run, and how to read a submission's own name back out of such a path. Shared by the XPI
// submission (src/addon/load.js) and the SCA source archive (src/addon/submission.js), so a
// reviewer sees one convention for both.
//
// Both directions live here because they are one convention: the suffix this module stamps
// on is the suffix submissionLeaf takes off, and a reader that guessed at it from elsewhere
// would drift the moment either half moved.
//
// Belongs here: choosing the destination path, the stamp that makes it unique, and
// recovering the submission's name from either. Does NOT belong here: writing anything
// there, or deciding what "beside" means for the caller's own file (each caller joins
// its own directory/basename before calling this).

import fs from "node:fs";
import path from "node:path";

/** What a run appends to a submission's path for the folder it unpacks it into. Composed
 *  by each caller onto its own base (see the header), and taken back off by
 *  submissionLeaf - so the two cannot disagree about it. */
export const EXTRACTED_SUFFIX = ".extracted";

/** A moment, spelled so it can sit in a filename: no colons, no dots. */
export function pathStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** The shape pathStamp produces, for reading one back off a path. */
const STAMP = /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/;

/**
 * What the submission is CALLED: the last segment of the path a run was given, with
 * anything this convention added taken back off.
 *
 * A reviewer re-reviewing a submission points the linter at the folder an earlier run
 * unpacked - `foo.xpi.extracted`, or `foo.xpi.extracted-<stamp>` where that folder was
 * already there - and the name they recognise is still `foo`. An unpacked submission has
 * no suffix to remove and keeps the name its folder has.
 *
 * The stamp is matched by its real shape rather than by anything-at-all, so a folder
 * someone called `foo.xpi.extracted-notes` keeps the name they gave it.
 * @param {string} p  A path, absolute or not.
 * @returns {string}  Its leaf name, never a path.
 */
export function submissionLeaf(p) {
  const leaf = path.basename(p);
  const suffix = new RegExp(
    `\\.xpi(?:${EXTRACTED_SUFFIX.replace(".", "\\.")}(?:-${STAMP.source})?)?$`
  );
  return leaf.replace(suffix, "");
}

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
  return `${base}-${pathStamp()}`;
}
