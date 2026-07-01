// Loads a submitted add-on, whether it's an .xpi/.zip archive or an
// already-unpacked directory, into an in-memory file map plus the parsed
// manifest. Keeping the whole add-on in memory (paths -> Buffer) lets every
// check read files without caring how the add-on was packaged.
//
// Belongs here: unpacking the submission into the Addon model (files map +
// manifest parse + manifestError), the Manifest typedef, and the load-time path
// safety guards. Loading/parsing the package only (the tool never writes back).
//
// Does NOT belong here: reviewing the add-on - all verdicts live in the checks
// (src/checks/*). Enumerating which JS sources to scan is src/addon/sources.js.
// Parsing CSS/HTML/CSP content is src/scan/*. Schema files load via
// src/schema/load.js.

import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import JSON5 from "json5";

import { warn } from "../util/log.js";
import { buildManifestLoc } from "./manifest-loc.js";

/**
 * @typedef {object} GeckoSettings
 * @property {string} [id]  Extension id.
 * @property {string} [strict_min_version]  Lowest supported app version.
 * @property {string} [strict_max_version]  Highest supported app version.
 */

/**
 * One content_scripts entry.
 * @typedef {object} ContentScript
 * @property {string[]} [matches]  URL match patterns.
 * @property {string[]} [js]  Injected script paths.
 * @property {string[]} [css]  Injected stylesheet paths.
 */

/**
 * A web_accessible_resources entry in MV3 object form (MV2 uses bare strings).
 * @typedef {object} WebAccessibleResource
 * @property {string[]} [resources]  Exposed resource paths or globs.
 * @property {string[]} [matches]  Origins the resources are exposed to.
 */

/**
 * The background context (MV2 scripts/page or MV3 service worker).
 * @typedef {object} Background
 * @property {string[]} [scripts]  Background script paths (MV2).
 * @property {string} [service_worker]  Service worker path (MV3).
 * @property {string} [page]  Background page path.
 */

/**
 * The sidebar_action manifest key.
 * @typedef {object} SidebarAction
 * @property {string} [default_panel]  Panel document path.
 * @property {string} [default_icon]  Icon path.
 * @property {string} [default_title]  Sidebar title.
 */

/**
 * The parsed manifest.json. A WebExtension manifest is an open-ended JSON
 * object, so these are just the keys the review reads (others may be present).
 * @typedef {object} Manifest
 * @property {number} [manifest_version]  2 or 3.
 * @property {string} [name]  Add-on name.
 * @property {string} [version]  Add-on version.
 * @property {string} [default_locale]  Default _locales subdir.
 * @property {string[]} [permissions]  Declared permissions / host patterns.
 * @property {string[]} [optional_permissions]  Runtime-granted permissions.
 * @property {string[]} [host_permissions]  Host patterns (MV3).
 * @property {ContentScript[]} [content_scripts]  Declared content scripts.
 * @property {(string|WebAccessibleResource)[]} [web_accessible_resources]
 *   Resources exposed to web pages (MV2 strings, MV3 objects).
 * @property {{gecko?: GeckoSettings}} [browser_specific_settings]  Gecko data.
 * @property {{gecko?: GeckoSettings}} [applications]  Legacy gecko data.
 * @property {Record<string, object>} [experiment_apis]  Experiment API defs.
 * @property {{images?: Record<string, string>}} [theme]  Static theme.
 * @property {SidebarAction} [sidebar_action]  Sidebar action.
 * @property {{page?: string}} [options_ui]  Options UI page.
 * @property {string} [options_page]  Legacy options page path.
 * @property {Background} [background]  Background context.
 * @property {Record<string, string>} [icons]  Size -> icon path.
 * @property {Record<string, string>} [dictionaries]  Locale -> dictionary path.
 * @property {string|Record<string, string>} [content_security_policy]  CSP.
 */

/**
 * @typedef {object} Addon
 * @property {string} source                 Original path provided.
 * @property {"zip"|"dir"} kind
 * @property {Map<string, Buffer>} files  Add-on-relative path (posix "/")
 *   -> contents.
 * @property {?Manifest} manifest  Parsed; null if missing/invalid.
 * @property {string|null} manifestError     Parse error message, if any.
 * @property {?import("./manifest-loc.js").ManifestLoc} manifestLoc  Resolves a
 *   manifest JSON path to its source line; null when there is no manifest.
 */

/**
 * @param {string} source  Path to an .xpi/.zip file or an unpacked add-on
 *   directory.
 * @returns {Addon}
 */
export function loadAddon(source) {
  const resolved = path.resolve(source);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Add-on not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  const files = stat.isDirectory() ? readDir(resolved) : readZip(resolved);
  return assembleAddon(files, {
    source: resolved,
    kind: stat.isDirectory() ? "dir" : "zip",
  });
}

/**
 * Build an Addon record from an in-memory file map: parse its manifest.json
 * (BOM-tolerant, JSON5) and stamp the source/kind. Shared by loadAddon and the
 * source-code-submission loader.
 * @param {Map<string, Buffer>} files
 * @param {{source: string, kind: "dir"|"zip"}} meta
 * @returns {Addon}
 */
function assembleAddon(files, { source, kind }) {
  const addon = {
    source,
    kind,
    files,
    manifest: null,
    manifestError: null,
    manifestLoc: null,
  };
  const manifestBuf = files.get("manifest.json");
  if (manifestBuf) {
    let text = manifestBuf.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }
    addon.manifestLoc = buildManifestLoc(text);
    try {
      addon.manifest = JSON5.parse(text);
    } catch (err) {
      addon.manifestError = err.message;
    }
  }
  return addon;
}

// The dependency-manifest files the source-code-submission audit reads; the lock
// names mirror src/vendor/locks.js.
const SCS_MANIFEST_FILES = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

/**
 * Load a source-code submission. The readable add-on code lives at `scsSource`
 * within the `scsRoot` archive (folder or zip); package.json/lock live at the
 * archive root. Returns a review Addon whose `files` are the scsSource subtree
 * (the prefix stripped, so `<scsSource>/manifest.json` becomes `manifest.json`)
 * PLUS the archive-root package.json + lock (so the dependency audit, which reads
 * addon.files, sees them).
 *
 * The source addon is PURE source - its own files and its own manifest.json. The
 * authoritative manifest is the built XPI's, exposed separately as ctx.manifest (the
 * orchestrator resolves it - see src/checks/context.js); nothing reviews the source
 * manifest, so it is left untouched here.
 * @param {string} scsRoot  Path to the source archive root (folder or zip).
 * @param {string} scsSource  Relative add-on code root within it (e.g. "src").
 * @returns {Addon}
 */
export function loadScsAddon(scsRoot, scsSource) {
  const archive = loadAddon(scsRoot);
  const rel = String(scsSource)
    .replace(/^[./]+/, "")
    .replace(/\/+$/, "");
  const prefix = rel ? `${rel}/` : "";
  const files = new Map();
  for (const [p, buf] of archive.files) {
    if (!prefix) {
      files.set(p, buf);
    } else if (p.startsWith(prefix)) {
      files.set(p.slice(prefix.length), buf);
    }
  }
  if (files.size === 0) {
    throw new Error(
      `--scs-source "${scsSource}" matched no files under ${scsRoot}`
    );
  }
  // Bring the archive-root dependency manifest into the review files (overriding
  // any same-named file inside scsSource - the root is authoritative).
  for (const name of SCS_MANIFEST_FILES) {
    const buf = archive.files.get(name);
    if (buf) {
      files.set(name, buf);
    }
  }
  return assembleAddon(files, {
    source: rel ? `${archive.source}:${rel}` : archive.source,
    kind: archive.kind,
  });
}

/**
 * @param {string} zipPath  Path to the .xpi/.zip archive.
 * @returns {Map<string, Buffer>}
 */
function readZip(zipPath) {
  const zip = new AdmZip(zipPath);
  const files = new Map();
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) {
      continue;
    }
    const name = normalize(entry.entryName);
    // Reject path-traversal / absolute entry names from a (possibly malicious)
    // archive so they can never reach a filesystem write or the output package.
    if (!isSafeAddonPath(name)) {
      warn(`Skipping unsafe archive entry: ${entry.entryName}`);
      continue;
    }
    files.set(name, entry.getData());
  }
  return files;
}

/**
 * @param {string} dir  Root directory of the unpacked add-on.
 * @returns {Map<string, Buffer>}
 */
function readDir(dir) {
  const files = new Map();
  /** @param {string} current  Directory to recurse into. */
  const walk = (current) => {
    for (const e of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, e.name);
      if (e.isSymbolicLink()) {
        // Skip symlinks rather than follow them: a real .xpi has none, and
        // following could pull in host files or loop. Warn so it is not silent.
        warn(`Skipping symlink (not packaged): ${path.relative(dir, full)}`);
      } else if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        const rel = path.relative(dir, full);
        files.set(normalize(rel), fs.readFileSync(full));
      }
    }
  };
  walk(dir);
  return files;
}

/**
 * Normalize an add-on-internal path to posix style without a leading "./".
 * @param {string} p  Raw path (may use backslashes or a leading "./").
 * @returns {string}
 */
function normalize(p) {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * True when a normalized add-on-relative path stays inside the add-on root: not
 * empty, not absolute, no Windows drive, and no ".." segment.
 * @param {string} p  Normalized posix path.
 * @returns {boolean}
 */
function isSafeAddonPath(p) {
  if (!p || p.startsWith("/") || /^[a-zA-Z]:/.test(p)) {
    return false;
  }
  return !p.split("/").includes("..");
}
