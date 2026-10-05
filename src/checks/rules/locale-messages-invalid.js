// A _locales directory whose messages.json Thunderbird cannot read. At install Thunderbird
// reads every directory under _locales and refuses the whole add-on when one holds no
// messages.json, one that is not UTF-8 / UTF-16 text or not JSON as its loader reads it, or
// one that is not messages data ("Extension is invalid"). One finding per directory, at its messages.json, with which of
// the two it was as the hint, so every case collapses under one entry.
//
// Belongs here: turning the locale scan (src/lib/locales.js localeMessages) into findings.
// Does NOT belong here: reading the files (-> localeMessages, shared with the trademark
// checks' localized-name scan), wording and severity (-> assets/registry.yaml).

import { VERDICT } from "../../lib/enum.js";
import { localeMessages } from "../../lib/locales.js";
import { finding } from "../../report/finding.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

const HINTS = {
  missing: "missing",
  unreadable: "cannot be read",
  invalid: "not messages data",
};

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const findings = [];
    for (const { file, state } of localeMessages(ctx)) {
      if (state === "ok") {
        continue;
      }
      ctx.note?.(ctx.artifact.at(file), HINTS[state], VERDICT.FAIL);
      findings.push(finding({ ...ctx.artifact.at(file), hint: HINTS[state] }));
    }
    return { findings };
  },
};
