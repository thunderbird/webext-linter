// Manifest file references: reading the packaged-file paths a manifest declares,
// normalizing a raw reference to an add-on-relative key, and resolving a
// reference (directory-aware) against the packaged file set. Two readers of
// deliberately different scope, because their consumers ask opposite questions:
//   - manifestFileRefs: the paths the SCHEMA declares, walked from the manifest's root
//     types, each with the JSON path to its slot. bundled-files uses it to warn a
//     referenced file is MISSING - which needs "this string is a file path" to hold
//     independent of the file existing, so existence cannot be the filter here.
//     Coverage is therefore the schema's: every key it types as extension-relative is
//     followed, and one it types loosely (l10n_resources) or not at all is not. Noticing
//     that a single key lost its format would need a list of the keys to expect, which is
//     the artefact this replaced - so do not add one back.
//   - manifestStringRefs: EVERY string in the manifest (outside experiment_apis).
//     reachability seeds from it, keeping only those that resolve to a packaged
//     file - so existence is the filter, and there is no per-key list to keep.
// Shared by the bundled-files check, the reachability graph, and the
// background-page-module check (a <script src> in the background page, via
// resolveRef).
//
// Belongs here: manifestFileRefs and manifestStringRefs (manifest -> paths),
// normalizeRef (raw path -> relative key, purely lexical), resolveRef (raw path +
// referrer -> packaged key, directory-aware), and resolveInDir (raw path +
// explicit base directory -> packaged key; the page-relative variant resolveRef
// delegates to).
//
// Does NOT belong here: walking the reference graph - that is reachability.js.
// web_accessible_resources shapes - web-accessible-resources.js. The
// bundled-files verdict - its rule under src/checks/rules/*. Generic shape
// guards like asArray - lib/util.js.

import { dirname } from "../util/files.js";
import { MANIFEST_ROOT_TYPES, REL_URL_FORMATS } from "../schema/index.js";

/** @typedef {import("../addon/load.js").Manifest} Manifest */

/**
 * Enumerate add-on-internal file paths the manifest declares, by walking the parsed
 * manifest against its SCHEMA TYPE and taking every leaf the schema marks as an
 * extension-relative path (a `format` in REL_URL_FORMATS, reached through $ref to
 * ExtensionURL / ExtensionFileUrl / IconPath / ImageDataOrExtensionURL / ThemeIcons).
 *
 * The schema is the authority on which keys carry a path, so there is no list to maintain
 * and no key to forget. A hand-written list of keys was one, and it did not name `icons` -
 * a shipped add-on with a manifest pointing at an icon it does not package was reported by
 * nothing.
 *
 * `where` is the JSON path to the leaf (["icons","48"]), not a label: one file named in
 * several slots is the norm rather than the exception, so the caller anchors each finding
 * with manifestPathLine rather than searching the text for the value, and dedupes by SLOT
 * so `icons.16` and `icons.48` stay two defect sites at two lines.
 *
 * The twin of this walk is walkType in src/parse/loader-files.js, which does the same
 * descent over a Babel AST for file-loading API arguments. They are deliberately separate:
 * a JSON value and an AST node differ at every branch, and merging them would mean a
 * conditional at each step. Three things differ beyond the node model, and each is a
 * correctness fix rather than a preference - see the comments below.
 * @param {Manifest} manifest  Parsed manifest.json.
 * @param {import("../schema/index.js").SchemaIndex} schema
 * @param {{experiments?: boolean}} [opts]  `experiments` includes the experiment_apis
 *   subtree. OFF by default, matching manifestStringRefs, so privileged Experiment
 *   implementation paths never enter a reachability seed built from this walk. A caller
 *   that only asks "is this file packaged" can turn it on, and bundled-files does.
 * @returns {{path: string, where: (string|number)[]}[]}
 */
export function manifestFileRefs(manifest, schema, opts = {}) {
  const refs = [];
  if (!manifest || typeof manifest !== "object" || !schema?.globalTypes) {
    return refs;
  }
  // The roots merged into one property map. Three keys are declared by two roots at once -
  // `icons`, `default_locale` and `theme_experiment` - so a later root's typing wins, and
  // that only matters if two roots disagree about whether a key holds a path. None do:
  // `theme_experiment` is the same $ref in both, `default_locale` is a plain string in
  // both, and `icons` agrees because assets/schema-annotations/theme.json retypes
  // ThemeManifest's copy, which upstream declares as a bare string. That last one is the
  // whole reason the annotation exists, and the drift lock in tests/unit/schema-index.test.js
  // is what notices if any of it stops being true.
  const props = {};
  for (const name of MANIFEST_ROOT_TYPES) {
    Object.assign(
      props,
      schema.globalTypes.get(`manifest.${name}`)?.properties || {}
    );
  }
  for (const [key, value] of Object.entries(manifest)) {
    if (key === "experiment_apis" && !opts.experiments) {
      continue;
    }
    walkValue(value, props[key], schema, [key], refs, new Set());
  }
  return refs;
}

/**
 * Walk one manifest VALUE against its schema type, pushing `{path, where}` at each
 * extension-relative leaf. The cycle guard is per descent path, as in walkType.
 * @param {unknown} value  The manifest value at this position.
 * @param {object|undefined} type  Its schema type.
 * @param {import("../schema/index.js").SchemaIndex} schema
 * @param {(string|number)[]} where  JSON path to this position.
 * @param {{path: string, where: (string|number)[]}[]} out
 * @param {Set<string>} seen  $refs on the current path.
 */
function walkValue(value, type, schema, where, out, seen) {
  if (value == null || !type || typeof type !== "object") {
    return;
  }
  if (type.$ref) {
    if (!seen.has(type.$ref)) {
      const next = new Set(seen).add(type.$ref);
      walkValue(value, schema.resolveRef(type.$ref), schema, where, out, next);
    }
    return;
  }
  if (Array.isArray(type.choices)) {
    for (const choice of type.choices) {
      walkValue(value, choice, schema, where, out, seen);
    }
    return;
  }
  if (typeof type.format === "string" && REL_URL_FORMATS.has(type.format)) {
    // The leaf must hold a STRING. walkType can take its node unconditionally because a
    // non-literal yields no static path downstream; here there is no such filter, and
    // IconPath's two arms mean an object value reaches a string-formatted leaf
    // (`default_icon: {"16": "a.png"}` matches the size-map arm AND the bare-string arm).
    if (typeof value === "string") {
      out.push({ path: value, where: [...where] });
    }
    return;
  }
  if (type.items && Array.isArray(value)) {
    value.forEach((el, i) =>
      walkValue(el, type.items, schema, [...where, i], out, seen)
    );
    return;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const props = type.properties || {};
  const extra =
    type.additionalProperties && typeof type.additionalProperties === "object"
      ? type.additionalProperties
      : null;
  const patterns = Object.entries(type.patternProperties || {});
  for (const [key, child] of Object.entries(value)) {
    const at = [...where, key];
    if (Object.prototype.hasOwnProperty.call(props, key)) {
      walkValue(child, props[key], schema, at, out, seen);
      continue;
    }
    if (extra) {
      walkValue(child, extra, schema, at, out, seen);
    }
    // The key must MATCH its pattern. walkType applies every pattern type to every
    // unmatched key because an AST key may be computed and unknowable; a manifest key is
    // known. `icons` is patternProperties {"^[1-9]\d*$"} with additionalProperties:false,
    // and Gecko ignores a key like "32x32" - taking it would report a file the runtime
    // never loads as missing.
    for (const [rx, pt] of patterns) {
      if (new RegExp(rx).test(key)) {
        walkValue(child, pt, schema, at, out, seen);
      }
    }
  }
}

/**
 * Every string value anywhere in the manifest, EXCEPT under experiment_apis
 * (privileged Experiment implementation paths, which must never enter the
 * WebExtension reachability tree). Unlike manifestFileRefs, this makes no
 * assumption about which keys carry file paths - it is the reachability seed
 * source, where a value only becomes a seed if it resolves to a packaged file,
 * so non-path strings (permissions, versions, match patterns, ids) drop out
 * harmlessly at the resolve gate. This covers every current and future
 * file-reference key (message_display_scripts, compose_scripts, ...) without an
 * enumeration to maintain.
 * @param {Manifest} manifest  Parsed manifest.json.
 * @returns {string[]}
 */
export function manifestStringRefs(manifest) {
  const out = [];
  // Iterative walk over an explicit stack: a submitted manifest is untrusted, so
  // recursion could overflow the call stack on a pathologically nested one. Seed
  // order does not matter (the caller dedups into a Set).
  const stack = [manifest];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node === "string") {
      out.push(node);
    } else if (Array.isArray(node)) {
      stack.push(...node);
    } else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "experiment_apis") {
          continue;
        }
        stack.push(value);
      }
    }
  }
  return out;
}

/**
 * Normalize a manifest/JS file reference to an add-on-relative key.
 *
 * A backslash is NOT folded to a slash. These paths are resolved by the platform as URLs
 * under moz-extension:, where a backslash separates nothing - so "icons\\16.png" does not
 * name icons/16.png to Thunderbird either, and matching it here would pass a reference the
 * add-on cannot resolve at runtime. The file it names is reported missing, which is what
 * the reviewer needs to know.
 * @param {string} p  Raw referenced path.
 * @returns {string}
 */
export function normalizeRef(p) {
  return String(p)
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
  const dir = fromFile == null ? null : dirname(fromFile);
  return resolveInDir(files, dir, raw);
}

/**
 * Resolve a reference against an explicit base DIRECTORY, or null if it is not a
 * packaged file. `dir` null means extension-root-relative (as for the manifest /
 * getURL); `dir === ""` is the add-on root; any other value is that directory. A
 * leading "/" in `raw` is always root-relative. Used (via script-hosts.js) to
 * resolve a page-relative loader path against the calling script's HOST PAGE
 * directory. `.`/`..` are normalized, with ".." clamped at the package root.
 * @param {Map<string, Buffer>} files
 * @param {string|null} dir
 * @param {string} raw
 * @returns {string|null}
 */
/**
 * Normalize `raw` against base directory `dir` and collapse `.`/`..` to a packaged
 * key. Returns the collapsed key (null for an empty/blank reference) AND whether a
 * ".." climbed above the package root - which resolveInDir clamps silently but
 * resolveInDirStatus reports. `dir` null (or a leading "/" in raw) is root-relative.
 * @param {string|null} dir @param {string} raw
 * @returns {{key: string|null, escaped: boolean}}
 */
function normalizeRefInDir(dir, raw) {
  // No backslash folding, for the reason normalizeRef gives: these resolve as URLs.
  let p = String(raw ?? "")
    .replace(/[?#].*$/, "")
    .trim();
  if (p === "") {
    return { key: null, escaped: false };
  }
  if (p.startsWith("/") || dir == null) {
    p = p.replace(/^\/+/, "");
  } else {
    p = dir ? `${dir}/${p}` : p;
  }
  const parts = [];
  let escaped = false;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      if (parts.length === 0) {
        escaped = true; // climbed above the package root
      } else {
        parts.pop();
      }
    } else {
      parts.push(seg);
    }
  }
  return { key: parts.join("/"), escaped };
}

export function resolveInDir(files, dir, raw) {
  const { key } = normalizeRefInDir(dir, raw);
  return key != null && files.has(key) ? key : null;
}

/**
 * @typedef {object} RefStatus
 * @property {"ok"|"missing"|"escapes"} kind
 *   - "ok": the reference resolves within the package and the file is bundled
 *     (`key` is the resolved add-on-relative path);
 *   - "missing": it resolves within the package but no such file is bundled;
 *   - "escapes": a ".." segment climbs ABOVE the package root, so the path points
 *     outside the add-on - a wrong path, regardless of whether a file happens to
 *     sit at the root-clamped location.
 * @property {string} [key]  Resolved packaged path, present only when kind ="ok".
 */

/**
 * Like resolveInDir, but distinguishes a path that escapes the package root from
 * one that merely points at a missing file. resolveInDir silently clamps ".."
 * at the root (so an escaping path can masquerade as a present file); this
 * variant reports that escape instead, which the bundled-files check needs to
 * tell "wrong path" apart from "not bundled". An empty/blank reference is
 * reported as "missing".
 * @param {Map<string, Buffer>} files
 * @param {string|null} dir  Base directory; null = extension-root-relative.
 * @param {string} raw  Raw referenced path.
 * @returns {RefStatus}
 */
export function resolveInDirStatus(files, dir, raw) {
  const { key, escaped } = normalizeRefInDir(dir, raw);
  if (key == null) {
    return { kind: "missing" };
  }
  if (escaped) {
    return { kind: "escapes" };
  }
  return files.has(key) ? { kind: "ok", key } : { kind: "missing" };
}

/**
 * Directory-aware variant of resolveInDirStatus: resolve `raw` against
 * `fromFile`'s directory (null/leading "/" = extension-root-relative), reporting
 * a root escape. Mirrors resolveRef.
 * @param {Map<string, Buffer>} files
 * @param {string|null} fromFile
 * @param {string} raw
 * @returns {RefStatus}
 */
export function resolveRefStatus(files, fromFile, raw) {
  const dir = fromFile == null ? null : dirname(fromFile);
  return resolveInDirStatus(files, dir, raw);
}
