// A packaged _locales directory requires a default_locale manifest key;
// without it Thunderbird refuses to load the add-on. Errors when _locales is
// present but default_locale is absent. The inverse (default_locale with no
// _locales) is default-locale-unused.js.
//
// Belongs here: the present-_locales / absent-default_locale verdict. Does NOT
// belong here: the _locales scan (-> getLocales in src/checks/lib/locales.js,
// memoized and shared with default-locale-unused), authored wording (->
// assets/registry.yaml), and severity (-> that registry entry).

import { finding } from "../../report/finding.js";
import { getLocales } from "../lib/locales.js";

/** @typedef {import("../registry.js").RunContext} RunContext */

export default {
  /**
   * @param {RunContext} ctx
   * @returns {import("../../report/finding.js").Finding[]}
   */
  run(ctx) {
    const manifest = ctx.addon.manifest;
    if (!manifest) {
      ctx.note?.("manifest.json", null, "manifest did not parse", "skipped");
      return [];
    }
    if (!getLocales(ctx).hasLocales) {
      ctx.note?.("manifest.json", null, "no _locales directory", "skipped");
      return [];
    }
    if (manifest.default_locale) {
      ctx.note?.("manifest.json", null, "default_locale declared", "pass");
      return [];
    }
    ctx.note?.(
      "manifest.json",
      null,
      "_locales without default_locale",
      "fail"
    );
    return [finding({ file: "manifest.json" })];
  },
};
