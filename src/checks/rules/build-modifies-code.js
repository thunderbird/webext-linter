// Carries a blind spot and detects nothing. A build step that edits code on its way into the
// add-on - a patch applied to a dependency, a piece appended to or cut out of a file, a value
// substituted into it - ships a file nobody read, and no byte comparison of the shipped files
// finds that reliably. The edit itself sits in the source archive, so the whole contribution
// of this check is its registry entry: a `sweep-instruction` the report prints under Standard
// Code Review for a reviewer covering the blind spot by hand, and which an agent sweeps the
// archive for when one is reviewing. What a sweep finds comes back as a case OF this check and
// is routed by this check's own instructions (src/report/sweep.js).
//
// It must exist and it must run. A `deterministic-phase` entry with no module fails to load
// (src/checks/registry.js loadChecks), and a sweep instruction is listed only for a check
// that ran (src/pipeline.js preSweepOf). Returning nothing is the point of the file, not an
// omission in it.
//
// Belongs here: nothing else. Does NOT belong here: the wording (-> assets/registry.yaml),
// or what a swept case becomes (-> src/report/sweep.js).

export default {
  /**
   * @returns {{findings: []}}
   */
  run() {
    return { findings: [] };
  },
};
