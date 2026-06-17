// Routes the third-party declarations that cannot be settled automatically to
// manual review: a source on a host we may not fetch, a library we cannot
// confirm is widely used, a source we could not fetch, and a VENDOR file we
// could not parse at all. The verification pre-step (src/vendor/resolve.js +
// src/vendor/verify.js) recorded each of these on addon.vendor. This check
// reads them and escalates one manual-review item per case. Deterministic, no
// network - the deterministic->manual routing is wired in registry.js and
// escalation.js.
//
// Belongs here: turning each unverifiable result (and an unparsable VENDOR file)
// into a manual-review escalation (+ a feed note). Does NOT belong here: the
// fetch/classify/parse work (-> src/vendor/{verify,sources,resolve}.js) and the
// authored instructions (-> assets/registry.yaml).

import { readVendorFile } from "../../normalize/vendor.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../escalation.js").Escalation} Escalation */

// Results this check owns, each mapped to its manual-review reason.
const REASON = {
  "no-url": () => "no source URL declared",
  untrusted: (url) => `source not on a trusted host: ${url}`,
  "not-popular": (url) => `not a confirmed widely-used library: ${url}`,
  unfetchable: (url) => `could not fetch ${url}`,
};

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: [], escalations: Escalation[]}}
   */
  run(ctx) {
    const { addon } = ctx;
    const vendor = addon?.vendor ?? {};
    const escalations = [];

    for (const { path, source, outcome } of vendor.results ?? []) {
      const reasonOf = REASON[outcome];
      if (reasonOf) {
        const reason = reasonOf(source);
        ctx.note?.(path, null, reason, "unsure");
        escalations.push({ item: `${path} - ${reason}` });
      }
    }

    // A VENDOR file present but parsed to nothing (scan empty, LLM fallback
    // unavailable or unhelpful): a human reads the declarations by hand.
    if (vendor.unparsedVendor) {
      const name = readVendorFile(addon)?.name ?? "VENDOR";
      ctx.note?.(name, null, "could not be parsed", "unsure");
      escalations.push({ item: `${name} - could not be parsed` });
    }

    return { findings: [], escalations };
  },
};
