// "Thunderbird" in the add-on name is allowed only as the trailing "<name> for
// Thunderbird". This check judges that form for every name the add-on's _locales
// state, and it is the ONE check for both outcomes because they are two branches
// of a single question, not two questions:
//
//   - a name from a locale whose tag says ENGLISH is decided here. The policy is
//     written in English, so "Thunderbird Conversations" in _locales/en is a fact
//     and a finding.
//   - a name from any other locale is ESCALATED. Outside English the form cannot
//     be recognised structurally: the allowed and forbidden readings share one
//     surface shape ("X para Thunderbird" is allowed, "X de Thunderbird" is not),
//     word order is not fixed (a postposition puts the brand first), and neither
//     are token boundaries (a particle can be glued on, and the brand itself can
//     take a case suffix). Answering it needs the meaning of a word, so a reader
//     answers it - which they can do from the package alone, because every
//     _locales/<locale>/messages.json ships inside it and the directory tag names
//     the language.
//
// A name carrying a brand term is left alone: trademark-violation already rejects
// it outright, so asking a reader to weigh its Thunderbird form as well would be
// two questions about a name that is refused either way.
//
// A name the manifest states literally is NOT here: it carries no locale tag, so
// nothing declares its language and the question is not answerable from the
// package at all (-> trademark-thunderbird-name.js, which puts it to a human). All
// three checks read one shared name resolution.
//
// Belongs here: the "for Thunderbird" form for each locale-tagged name, and which
// of the two branches its locale puts it in. Does NOT belong here: resolving the
// names (-> localizedNames in src/lib/locales.js), the trademark facts themselves
// (-> src/lib/trademark.js), an unlabelled name (-> trademark-thunderbird-name.js),
// the icon (a manual-checks entry). Authored wording -> assets/registry.yaml.
// Severity and the escalation section -> that registry entry, applied by
// src/checks/registry.js.

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { isEnglishLocale, localizedNames } from "../../lib/locales.js";
import { brandTerm, offFormThunderbird } from "../../lib/trademark.js";
import { manifestTokenLine } from "../../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../escalation.js").Escalation} Escalation */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[],
   *   escalations: Escalation[]}}
   */
  run(ctx) {
    const { pairs, resolved, localized, unreadable } = localizedNames(ctx);
    // Anchor on the manifest's `name` line: that is where the placeholder sits, and
    // it is the line a developer edits to rename the add-on.
    const line = manifestTokenLine(ctx.manifestText, "name");
    const loc = line ? { line } : null;
    if (!localized) {
      ctx.note?.(
        "manifest.json",
        loc,
        "name is not localized",
        VERDICT.SKIPPED
      );
      return { findings: [], escalations: [] };
    }
    // Every locale that could not be read is said out loud. Nothing else in the
    // review reports an unparsable messages.json, so staying quiet here would
    // leave a name that Thunderbird displays reviewed by nobody.
    for (const locale of unreadable) {
      ctx.note?.(
        "manifest.json",
        loc,
        `${locale} messages.json could not be read`,
        VERDICT.SKIPPED
      );
    }
    if (!resolved) {
      // The name is a placeholder no locale file defines. That is not a pass: no
      // name was examined, and saying PASS would read as "verified clean".
      ctx.note?.(
        "manifest.json",
        loc,
        `${ctx.manifest?.name} not resolvable`,
        VERDICT.SKIPPED
      );
      return { findings: [], escalations: [] };
    }
    // Group by the offending name, listing every locale that states it. One case
    // per locale would dedupe down to one arbitrary locale (a case dedupes on its
    // item, and the locale is only a hint), and a name decided in English must not
    // also be asked about because of another locale carrying the same string.
    const byName = new Map();
    for (const { locale, name } of pairs) {
      if (locale === null || !offFormThunderbird(name) || brandTerm(name)) {
        continue;
      }
      const entry = byName.get(name) ?? { locales: [], english: false };
      entry.locales.push(locale);
      entry.english ||= isEnglishLocale(locale);
      byName.set(name, entry);
    }
    const findings = [];
    const escalations = [];
    for (const [name, { locales, english }] of byName) {
      // The locales go in the HINT, not a wording slot: they are per-locus detail,
      // so every case stays in one group and each line still says where it came
      // from.
      const where = locales.join(", ");
      const target = english ? findings : escalations;
      target.push(
        english
          ? finding({ file: "manifest.json", loc, item: name, hint: where })
          : { file: "manifest.json", loc, item: name, hint: where }
      );
      ctx.note?.(
        "manifest.json",
        loc,
        `${where}: ${name}`,
        english ? VERDICT.FAIL : VERDICT.UNSURE
      );
    }
    if (!findings.length && !escalations.length) {
      ctx.note?.(
        "manifest.json",
        loc,
        `${pairs.length} localized name(s)`,
        VERDICT.PASS
      );
    }
    return { findings, escalations };
  },
};
