// A remote load inside a file whose CONTENT matched a published upstream release: the
// line is that release's, not something the developer wrote, so it is not theirs to
// defend. That does not by itself mean the add-on NEEDS this file, or that no build of
// the library avoids the remote load (verifiedVendorSource states a fact about content,
// not about intent) - so every such site is put to a person: is shipping it as published
// acceptable here?
//
// A separate check from remote-resources because it asks a separate question. That one
// asks whether a load is even remote and holds the developer to it; this one starts from
// a load that IS remote and resolvable, and asks whether the add-on needs the file at
// all. One check cannot ask both, so the two share one scan (getRemoteRefs) instead.
//
// This turns on the content match, NOT on the declaration: a declared file that could
// not be verified is reviewed as the developer's own code (applyUnverifiedVendor), so
// its remote loads stay remote-resources' findings. Two limits worth knowing: only the
// shipped XPI carries verified results (verifyVendor runs on it alone), so an SCA review
// never reaches this lane; and the JS lane never does either, because a vendored .js is
// dropped from the scan entirely.
//
// Belongs here: putting each upstream-matched site to a person. Does NOT belong here:
// the scan and its classification (-> src/lib/remote-refs.js), the developer's own
// sites (-> remote-resources.js), authored wording (-> assets/registry.yaml), and the
// escalation section (-> that registry entry, applied by src/checks/registry.js).

import { VERDICT } from "../../lib/enum.js";
import { getRemoteRefs } from "../../lib/remote-refs.js";
import { dedupe } from "../../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../escalation.js").Escalation} Escalation */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: [], escalations: Escalation[]}}
   */
  run(ctx) {
    const escalations = [];
    for (const site of getRemoteRefs(ctx).upstream) {
      escalations.push({
        // The destination whole: it is the fact the judgement turns on.
        item: site.url,
        file: site.file,
        loc: site.loc,
        // The matched release goes in the HINT, not a wording slot: it is per-locus
        // detail, so every site stays in ONE group and each line still says which
        // release it was matched against.
        hint: site.upstream,
      });
      // INFO, not UNSURE: nothing here is uncertain in the way an undecidable site is -
      // the scan reached a verdict and is recording it rather than acting on it.
      ctx.note?.(site.file, site.loc, site.note, VERDICT.INFO);
    }
    // The scanners can report one site twice (see dedupe), and a reviewer should be
    // asked once.
    return { findings: [], escalations: dedupe(escalations) };
  },
};
