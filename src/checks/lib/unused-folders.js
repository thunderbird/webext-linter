// Condenses a set of "unused" file paths against the full packaged-file list:
// when EVERY packaged file under a folder is unused, the folder collapses to a
// single entry (the top-most such folder), recursively, so a fully-unused tree
// reports as one line instead of dozens. Pure path math - no I/O, no findings.
//
// Belongs here: the folder-collapse path logic. Does NOT belong here: WHICH files
// are unused (-> src/checks/rules/unused-files.js + the escalation resolution) or
// how the collapsed entries render (-> src/report/format.js). The caller
// (src/pipeline.js) applies this to the final unused-files findings and manual
// refs, after every check has already scanned every file.

/**
 * The ancestor directories of a path, shallowest first.
 * "a/b/c.js" -> ["a", "a/b"]; "x.js" -> [].
 * @param {string} path
 * @returns {string[]}
 */
function ancestors(path) {
  const segs = path.split("/");
  const out = [];
  for (let i = 1; i < segs.length; i++) {
    out.push(segs.slice(0, i).join("/"));
  }
  return out;
}

/**
 * Collapse fully-unused folders. A directory is "fully unused" when `allFiles`
 * has at least one path under it and every such path is in `unusedFiles` (so a
 * kept/used/other-bucket file under it blocks the collapse). Each unused file is
 * mapped to its TOP-MOST fully-unused ancestor; files with none stay as-is.
 * @param {Iterable<string>} unusedFiles  Paths flagged unused (one bucket).
 * @param {Iterable<string>} allFiles  Every packaged file path (the denominator).
 * @returns {string[]}  Collapsed entries, sorted: folders end with "/", files
 *   are verbatim.
 */
export function collapseUnused(unusedFiles, allFiles) {
  const unusedSet = new Set(unusedFiles);
  // Per-directory tallies: total packaged files under it, and unused ones.
  const total = new Map();
  const unused = new Map();
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const f of allFiles) {
    for (const dir of ancestors(f)) {
      bump(total, dir);
    }
  }
  for (const f of unusedSet) {
    for (const dir of ancestors(f)) {
      bump(unused, dir);
    }
  }
  const fullyUnused = (dir) =>
    total.get(dir) > 0 && total.get(dir) === unused.get(dir);

  const folders = new Set();
  const files = [];
  for (const f of unusedSet) {
    const top = ancestors(f).find(fullyUnused); // shallowest fully-unused ancestor
    if (top) {
      folders.add(`${top}/`);
    } else {
      files.push(f);
    }
  }
  return [...folders, ...files].sort();
}
