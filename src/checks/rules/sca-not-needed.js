// An XPI review restarted from a source review that did not need its archive: the source
// review aborted only for faults of the archive or its build, its XPI was readable, and the
// reviewer chose to restart it as an XPI review (the `downgrade` phase, assets/registry.yaml).
// Nothing in the files decides it, so this rule raises nothing. Its one finding is added by
// the pipeline to a review started with `downgradedFrom` (src/pipeline.js), and tells the
// developer to submit just the XPI next time.
//
// Belongs here: being the check that restart reports. Does NOT belong here: the question
// (-> the `downgrade` phase, assets/registry.yaml), starting the XPI review
// (-> src/cli.js runLoopPass), adding the finding (-> src/pipeline.js), or the wording
// (-> assets/registry.yaml).

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @returns {{findings: []}}
   */
  run() {
    return { findings: [] };
  },
};
