// A new-submission manual prompt: is this a fork of an existing add-on that must
// be distinguished from the original? It always escalates one manual-review case
// - the registry entry's `diff: false` gate makes it run only for new
// submissions and skips it when reviewing an update against a --diff-to baseline
// (an established listing is not a new fork). Reusing the deterministic->manual
// escalation lane (like native-messaging) keeps the diff gate in one place
// (runChecks), rather than adding diff support to the unconditional manual-checks.
//
// Belongs here: emitting the always-on escalation. Does NOT belong here: the
// diff-mode gate (-> the registry entry's `diff` field, applied by runChecks in
// src/checks/registry.js), the deterministic->manual routing (->
// src/checks/escalation.js), and the authored instructions (-> assets/registry.yaml).

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../escalation.js").Escalation} Escalation */

export default {
  /**
   * @returns {{findings: [], escalations: Escalation[]}}
   */
  run() {
    return { findings: [], escalations: [{ item: null }] };
  },
};
