// Carries a blind spot and detects nothing. Whether an icon imitates or incorporates the
// Thunderbird, Firefox or Mozilla logo is not decidable from the bytes - it is a judgement about what
// an image looks like - so there is no scan to run here. The whole contribution of this
// check is its registry entry: a `sweep-instruction` the report prints under Standard Code
// Review for a reviewer covering the blind spot by hand, and which an agent sweeps for when
// one is reviewing. What a sweep finds comes back as a case OF this check and is routed by
// this check's own instructions (src/report/sweep.js).
//
// unacceptable-package-content briefs the same reader on the same package, and the two do not
// overlap: that one asks whether shipped content is acceptable - an icon included - this one
// whether an icon takes a mark nobody else may use. Two questions with two answers, so two
// briefs.
//
// It must exist and it must run, for the reason the check it came from must: a
// `deterministic-phase` entry with no module fails to load (src/checks/registry.js
// loadChecks), and a sweep instruction is listed only for a check that ran
// (src/pipeline.js preSweepOf). Returning nothing is the point of the file.
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
