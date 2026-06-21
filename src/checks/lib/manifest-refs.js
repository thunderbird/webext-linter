// Manifest file references: enumerating the packaged-file paths a manifest
// declares (entry points, scripts, popups), normalizing a raw reference to an
// add-on-relative key, and resolving a reference (directory-aware) against the
// packaged file set. Shared by the bundled-files check (a referenced file must
// be packaged), the reachability graph (each reference is a seed/edge), and the
// background-page-module check (a <script src> in the background page).
//
// Belongs here: manifestFileRefs (manifest -> referenced paths), normalizeRef
// (raw path -> relative key, purely lexical), resolveRef (raw path + referrer ->
// packaged key, directory-aware), and resolveInDir (raw path + explicit base
// directory -> packaged key; the page-relative variant resolveRef delegates to).
//
// Does NOT belong here: walking the reference graph - that is reachability.js.
// web_accessible_resources shapes - web-accessible-resources.js. The
// bundled-files verdict - its rule under src/checks/rules/*. Generic shape
// guards like asArray - lib/util.js.

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

/**
 * Resolve a reference to an add-on-relative key, or null if it is not a packaged
 * file. `fromFile` null (manifest/getURL/injected) or a leading "/" means
 * extension-root-relative. Otherwise it is relative to `fromFile`'s directory.
 * @param {Map<string, Buffer>} files
 * @param {string|null} fromFile
 * @param {string} raw
 * @returns {string|null}
 */
export function resolveRef(files, fromFile, raw) {
  const dir =
    fromFile == null
      ? null
      : fromFile.includes("/")
        ? fromFile.slice(0, fromFile.lastIndexOf("/"))
        : "";
  return resolveInDir(files, dir, raw);
}

/**
 * Resolve a reference against an explicit base DIRECTORY, or null if it is not a
 * packaged file. `dir` null means extension-root-relative (as for the manifest /
 * getURL / a generated background page); `dir === ""` is the add-on root; any
 * other value is that directory. A leading "/" in `raw` is always root-relative.
 * Used to resolve a page-relative loader path against the directory of the page
 * that hosts the calling script (see script-hosts.js). `.`/`..` are normalized.
 * @param {Map<string, Buffer>} files
 * @param {string|null} dir
 * @param {string} raw
 * @returns {string|null}
 */
export function resolveInDir(files, dir, raw) {
  let p = String(raw ?? "")
    .replace(/\\/g, "/")
    .replace(/[?#].*$/, "")
    .trim();
  if (p === "") {
    return null;
  }
  if (p.startsWith("/") || dir == null) {
    p = p.replace(/^\/+/, "");
  } else {
    p = dir ? `${dir}/${p}` : p;
  }
  const parts = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  const key = parts.join("/");
  return files.has(key) ? key : null;
}
