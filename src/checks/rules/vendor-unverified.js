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

// Results this check owns, each mapped to its manual-review reason. The reason is
// URL-free: the source URL is listed separately on the location line (which reads
// "<VENDOR file> - <declared file> - <source URL> - <reason>"), so it is not
// repeated here.
const REASON = {
  "no-url": "no source URL declared",
  untrusted: "source not on a trusted host",
  "not-popular": "not a confirmed widely-used library",
  unfetchable: "source could not be fetched",
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
    // The escalations group under one entry (the instruction is item-free), so
    // each is located by the VENDOR file (its `file`) and lists the declared
    // file, source URL, and reason as its item -> "<VENDOR> - <file> - <url> -
    // <reason>". The per-file reason therefore stays on the report line.
    const vendorName = (addon.files && readVendorFile(addon)?.name) || "VENDOR";

    for (const { path, source, outcome } of vendor.results ?? []) {
      const reason = REASON[outcome];
      if (reason) {
        const item = [path, source, reason].filter(Boolean).join(" - ");
        ctx.note?.(vendorName, null, item, "unsure");
        escalations.push({ file: vendorName, item });
      }
    }

    // A VENDOR file present but parsed to nothing (scan empty, LLM fallback
    // unavailable or unhelpful): a human reads the declarations by hand.
    if (vendor.unparsedVendor) {
      ctx.note?.(vendorName, null, "could not be parsed", "unsure");
      escalations.push({ file: vendorName, item: "could not be parsed" });
    }

    return { findings: [], escalations };
  },
};
