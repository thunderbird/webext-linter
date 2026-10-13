// SCA only: a source that builds, but not into the shipped XPI. Nothing in the files decides
// it, so this rule raises nothing. Its one finding is added by the review loop, when the
// reviewer answers the build question with "Does not reproduce" (the `built` value that
// `reports` this check, assets/registry.yaml), and the review then ends through the early
// exit with this check's reason and response.
//
// Belongs here: being the check that answer reports. Does NOT belong here: the question
// and its values (-> the `built` phase, assets/registry.yaml), adding the finding
// (-> src/report/loop.js recordValue), or the wording (-> assets/registry.yaml).

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @returns {{findings: []}}
   */
  run() {
    return { findings: [] };
  },
};
