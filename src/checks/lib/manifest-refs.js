// Manifest file references: enumerating the packaged-file paths a manifest
// declares (entry points, scripts, popups) and normalizing a raw reference to
// an add-on-relative key. Shared by the bundled-files check (a referenced file
// must be packaged) and the reachability graph (each reference is a seed).
//
// Belongs here: manifestFileRefs (the manifest -> referenced-path enumeration)
// and normalizeRef (raw path -> relative key). Path-cleaning that is purely
// lexical, with no need to know which files are packaged.
//
// Does NOT belong here: resolving a reference against the packaged file set or
// walking the reference graph - that is reachability.js (which has its own
// directory-aware resolve). web_accessible_resources shapes -
// web-accessible-resources.js. The bundled-files verdict - its rule under
// src/checks/rules/*. Generic shape guards like asArray - lib/util.js.

import { asArray } from "./util.js";

/** @typedef {import("../../addon/load.js").Manifest} Manifest */

/**
 * Enumerate add-on-internal file paths referenced by the manifest.
 * @param {Manifest} manifest  Parsed manifest.json.
 * @returns {{path: string, where: string}[]}
 */
export function manifestFileRefs(manifest) {
  const refs = [];
  /**
   * @param {unknown} path  Candidate path (recorded only if a string).
   * @param {string} where  Manifest location, for the message.
   */
  const add = (path, where) => {
    if (typeof path === "string") {
      refs.push({ path, where });
    }
  };

  // A submitted manifest can be malformed. Guard every shape before iterating
  // so a bad value degrades gracefully instead of throwing.
  asArray(manifest.content_scripts).forEach((cs, i) => {
    if (!cs || typeof cs !== "object") {
      return;
    }
    for (const js of asArray(cs.js)) {
      add(js, `content_scripts[${i}].js`);
    }
    for (const css of asArray(cs.css)) {
      add(css, `content_scripts[${i}].css`);
    }
  });

  const bg = manifest.background;
  if (bg && typeof bg === "object") {
    for (const s of asArray(bg.scripts)) {
      add(s, "background.scripts");
    }
    add(bg.service_worker, "background.service_worker");
    add(bg.page, "background.page");
  }

  add(manifest.options_ui?.page, "options_ui.page");
  add(manifest.options_page, "options_page");
  for (const key of [
    "action",
    "browser_action",
    "compose_action",
    "message_display_action",
  ]) {
    add(manifest[key]?.default_popup, `${key}.default_popup`);
  }

  return refs;
}

/**
 * Normalize a manifest/JS file reference to an add-on-relative key.
 * @param {string} p  Raw referenced path.
 * @returns {string}
 */
export function normalizeRef(p) {
  return String(p)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/[?#].*$/, "");
}
