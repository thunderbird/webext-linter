// A Thunderbird extension with no top-level `icons` key ships no defined add-on
// icon, so Thunderbird shows the generic puzzle-piece placeholder in the Add-ons
// Manager. An advisory (info): defining an icon improves user acceptance. Static
// themes and dictionaries are not represented by an add-on icon, so they are
// exempt. Fires when the manifest parses, is not a theme/dictionary, and
// declares no usable `icons` entry.
//
// Belongs here: the present-manifest / not-a-theme / absent-icons verdict,
// treating an empty or value-less `icons` object as "no icon defined". Does NOT
// belong here: whether a referenced icon file is actually bundled (->
// bundled-files.js, which walks the schema's icon paths), authored wording (->
// assets/registry.yaml), and severity (-> that registry entry, stamped by
// src/checks/registry.js).

import { VERDICT } from "../../lib/enum.js";
import { finding } from "../../report/finding.js";
import { asObject } from "../../lib/util.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {{findings: import("../../report/finding.js").Finding[]}}
   */
  run(ctx) {
    const manifest = ctx.manifest;
    if (!manifest) {
      ctx.note?.(
        "manifest.json",
        null,
        "manifest did not parse",
        VERDICT.SKIPPED
      );
      return { findings: [] };
    }
    // Static themes and dictionaries (language packs) are not represented by an
    // add-on icon, so the advisory does not apply to them.
    if (manifest.theme || manifest.dictionaries) {
      ctx.note?.(
        "manifest.json",
        null,
        "theme or dictionary add-on",
        VERDICT.SKIPPED
      );
      return { findings: [] };
    }
    // An add-on icon is defined when `icons` holds at least one string path. An
    // absent key, a non-object, or an object with no string values all mean
    // "no icon defined".
    const hasIcon = Object.values(asObject(manifest.icons)).some(
      (p) => typeof p === "string" && p.trim() !== ""
    );
    if (hasIcon) {
      ctx.note?.("manifest.json", null, "icons declared", VERDICT.PASS);
      return { findings: [] };
    }
    ctx.note?.("manifest.json", null, "no add-on icon defined", VERDICT.FAIL);
    return { findings: [finding({ file: "manifest.json" })] };
  },
};
