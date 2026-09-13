// "Thunderbird" in an add-on name the manifest states LITERALLY, rather than
// through a __MSG__ placeholder. Every such case is put to a person, and none is
// ever a finding.
//
// The reason is narrow: a literal name carries no locale tag, so nothing in the
// package states what language it is in. The allowed form is "<name> for
// Thunderbird", and recognising it outside English needs the meaning of the word
// before the brand, so the language has to be settled first. That is not
// answerable from the submission - which is exactly the line the registry draws
// between the two escalation sections, so this one goes to manual review while its
// sibling, whose names arrive with a locale tag that names their language, goes to
// code review.
//
// A name that looks like an obvious English violation is therefore asked about
// rather than rejected. That is the deliberate trade: the alternative is rejecting
// an unlocalized non-English name that is perfectly allowed, and a wrong rejection
// costs the developer a release while a question costs a reviewer a glance.
//
// A name carrying a brand term is left alone: trademark-violation already rejects
// it outright, so asking about its Thunderbird form as well would be a second
// question about a name that is refused either way.
//
// Belongs here: putting an unlabelled off-form name to a person. Does NOT belong
// here: a name resolved from _locales (-> trademark-thunderbird-locale.js),
// reporting a brand term (-> trademark-violation.js), the trademark facts
// themselves (-> src/lib/trademark.js), resolving the name (-> localizedNames in
// src/lib/locales.js), and the icon (a manual-checks entry). Authored wording ->
// assets/registry.yaml. Severity and the escalation section -> that registry
// entry, applied by src/checks/registry.js.

import { VERDICT } from "../../lib/enum.js";
import { localizedNames } from "../../lib/locales.js";
import { brandTerm, offFormThunderbird } from "../../lib/trademark.js";
import { manifestTokenLine } from "../../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../escalation.js").Escalation} Escalation */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: [], escalations: Escalation[]}}
   */
  run(ctx) {
    const { pairs, localized } = localizedNames(ctx);
    if (localized) {
      // A __MSG_ name produces no untagged pair, so there is nothing here to ask
      // about: its locales are the sibling's business. Saying so keeps the two
      // checks' silence distinguishable in the Activity feed.
      ctx.note?.("manifest.json", null, "name is localized", VERDICT.SKIPPED);
      return { findings: [], escalations: [] };
    }
    const literal = pairs.find((p) => p.locale === null);
    if (!literal) {
      ctx.note?.("manifest.json", null, "no add-on name", VERDICT.SKIPPED);
      return { findings: [], escalations: [] };
    }
    const line = manifestTokenLine(ctx.manifestText, "name");
    const loc = line ? { line } : null;
    if (!offFormThunderbird(literal.name) || brandTerm(literal.name)) {
      ctx.note?.("manifest.json", loc, `name "${literal.name}"`, VERDICT.PASS);
      return { findings: [], escalations: [] };
    }
    ctx.note?.("manifest.json", loc, literal.name, VERDICT.UNSURE);
    return {
      findings: [],
      escalations: [{ file: "manifest.json", loc, item: literal.name }],
    };
  },
};
