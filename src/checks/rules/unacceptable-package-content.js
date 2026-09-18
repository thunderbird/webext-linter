// Carries a blind spot and detects nothing. Whether what an add-on ships - its name and
// description, an icon, a bundled image or text - is spam, misleading or low-effort is not
// decidable from the bytes, so there is no scan to run here. The whole contribution of this
// check is its registry entry: a `sweep-instruction` the report prints under Standard Code
// Review for a reviewer covering the blind spot by hand, and which an agent sweeps for when
// one is reviewing. What a sweep finds comes back as a case OF this check and is routed by
// this check's own instructions (src/report/sweep.js).
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
