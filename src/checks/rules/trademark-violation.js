// Deterministic trademark check on the add-on NAME, for the brand terms that are
// never allowed in it: "Firefox", "Mozilla" and "MZLA". Case-insensitive, and
// applied to EVERY name the package states - the literal manifest name, or each
// locale's resolution of a __MSG__ placeholder, which a deterministic check can
// read even though a reviewer would not.
//
// This half is a fact with an exact anchor, so it is a finding and never
// escalates: no construction around the word makes it acceptable. The other
// trademark, "Thunderbird", is NOT here, because deciding it needs the meaning of
// the word before it - "X para Thunderbird" is allowed and "X de Thunderbird" is
// not - which is a judgement rather than a fact. That question is split by who can
// answer it: trademark-thunderbird-locale.js for a name whose locale states its
// language, trademark-thunderbird-name.js for an unlabelled one. The icon, the
// third vector, is an image, so it is on the manual-review list instead.
//
// Belongs here: reporting every resolved name that carries a brand term, and
// saying so when it could not read a name at all.
// Does NOT belong here: the "for Thunderbird" form (-> the two siblings above),
// resolving the names themselves (-> localizedNames in src/lib/locales.js),
// reporting a malformed locale file (its JSON validity is out of scope for a
// trademark verdict). Authored wording -> assets/registry.yaml. Severity -> that
// registry entry, stamped by runChecks (src/checks/registry.js). Report
// formatting -> src/report/format.js.

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { localizedNames } from "../../lib/locales.js";
import { brandTerm } from "../../lib/trademark.js";
import { manifestTokenLine } from "../../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    // Registry `input: xpi`: ctx.addon is the built XPI. The displayed name - and a
    // __MSG_ placeholder's _locales resolution - are properties of what actually
    // ships (a source submission's _locales may be generated or live outside
    // --sca-source), so the name, its anchor line, and the _locales all come from
    // the XPI's own files.
    const name = ctx.manifest?.name;
    if (typeof name !== "string") {
      ctx.note?.("manifest.json", null, "no add-on name", VERDICT.SKIPPED);
      return { findings: [] };
    }
    // Anchor every note/finding on the manifest's `name` property line.
    const line = manifestTokenLine(ctx.manifestText, "name");
    const loc = line ? { line } : null;
    const { pairs, resolved, unreadable } = localizedNames(ctx);
    if (!resolved) {
      ctx.note?.(
        "manifest.json",
        loc,
        `${name} not resolvable`,
        VERDICT.SKIPPED
      );
      return { findings: [] };
    }
    // Group by the offending name and list every locale that states it. Reporting
    // one case per locale would collapse to one arbitrary locale, because a finding
    // dedupes on its item and the locale is only a hint - so a reader would clear
    // the name having been shown one of the locales carrying it.
    const byName = new Map();
    for (const { locale, name: candidate } of pairs) {
      if (!brandTerm(candidate)) {
        continue;
      }
      const locales = byName.get(candidate) ?? [];
      if (locale) {
        locales.push(locale);
      }
      byName.set(candidate, locales);
    }
    const findings = [];
    for (const [candidate, locales] of byName) {
      const term = brandTerm(candidate);
      const where = locales.length ? ` (${locales.join(", ")})` : "";
      ctx.note?.(
        "manifest.json",
        loc,
        `name uses "${term}"${where}`,
        VERDICT.FAIL
      );
      findings.push(
        finding({
          file: "manifest.json",
          loc,
          item: candidate,
          hint: locales.join(", ") || null,
        })
      );
    }
    for (const locale of unreadable) {
      ctx.note?.(
        "manifest.json",
        loc,
        `${locale} messages.json could not be read`,
        VERDICT.SKIPPED
      );
    }
    if (!findings.length) {
      ctx.note?.("manifest.json", loc, `name "${name}"`, VERDICT.PASS);
    }
    return { findings };
  },
};
