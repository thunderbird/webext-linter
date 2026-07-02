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
 * @property {string[]} nodeModules  Posix paths of node_modules directories
 *   skipped at load (their contents are never read); empty when none. In SCS
 *   mode the committed-node-modules check rejects each.
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
  const { files, nodeModules } = stat.isDirectory()
    ? readDir(resolved)
    : readZip(resolved);
  const addon = assembleAddon(files, {
    source: resolved,
    kind: stat.isDirectory() ? "dir" : "zip",
  });
  // Installed-dependency directories are skipped at load (never read) and only their
  // paths are recorded - a committed node_modules is a hard fail (committed-node-modules
  // in SCS mode), never reviewable input.
  addon.nodeModules = nodeModules;
  return addon;
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

// The dependency-manifest files loadScsAddon brings from the archive root into the
// review files (the root is the authoritative manifest); the lock names mirror
// src/vendor/locks.js.
const SCS_MANIFEST_FILES = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

/**
 * Resolve an SCS source-path flag (--scs-source / --scs-exp-source) to a posix path
 * relative to scsRoot. The value is either already relative to scsRoot, or an
 * absolute filesystem path (made relative to scsRoot). Throws when an absolute path
 * resolves OUTSIDE scsRoot - which also rejects an absolute path against a zip
 * scsRoot, since it can never sit under the archive file.
 * @param {string} value  The raw flag value.
 * @param {string} scsRoot  The --scs-root path.
 * @param {string} [flag]  The flag name to name in the error (e.g. "--scs-source").
 * @returns {string} A posix path relative to scsRoot ("" for the root itself).
 */
export function scsRootRelative(value, scsRoot, flag = "SCS path") {
  let v = String(value ?? "");
  if (path.isAbsolute(v)) {
    v = path.relative(path.resolve(scsRoot), path.resolve(v));
    if (v.startsWith("..") || path.isAbsolute(v)) {
      throw new Error(`${flag} "${value}" is outside --scs-root (${scsRoot})`);
    }
  }
  return v
    .replace(/\\/g, "/")
    .replace(/^[./]+/, "")
    .replace(/\/+$/, "");
}

/**
 * The Experiment folder as a path relative to the review SOURCE (scsSource), from
 * the --scs-exp-source flag which - like --scs-source - is relative to scsRoot (or
 * absolute). Both flags share the scsRoot base; this strips the scsSource prefix so
 * scsWebExtensionFiles can match it against the (already source-stripped) file keys.
 * @param {string|undefined} scsExpSource  The --scs-exp-source flag ("" when unset).
 * @param {string} scsSource  The --scs-source flag.
 * @param {string} scsRoot  The --scs-root flag.
 * @returns {string} A posix path relative to scsSource ("" when unset). Throws when
 *   the Experiment folder is not within scsSource.
 */
export function scsExpSourceRelative(scsExpSource, scsSource, scsRoot) {
  if (!scsExpSource) {
    return "";
  }
  const exp = scsRootRelative(scsExpSource, scsRoot, "--scs-exp-source");
  const src = scsRootRelative(scsSource, scsRoot, "--scs-source");
  if (!src) {
    return exp; // the review source IS the archive root
  }
  if (exp === src || !exp.startsWith(`${src}/`)) {
    throw new Error(
      `--scs-exp-source (${scsExpSource}) must be a folder within --scs-source (${scsSource})`
    );
  }
  return exp.slice(src.length + 1);
}

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
 * @param {string} scsSource  The add-on code root, relative to scsRoot or an
 *   absolute path (e.g. "src", "addon", or "/abs/path/to/root/addon").
 * @returns {Addon}
 */
export function loadScsAddon(scsRoot, scsSource) {
  const archive = loadAddon(scsRoot);
  const rel = scsRootRelative(scsSource, scsRoot, "--scs-source");
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
 * Load the BUILD files of a source-code submission: EVERY file in the scsRoot archive
 * EXCEPT the review source (scsSource), the Experiment source (scsExpSource), and
 * dotfiles/dotfolders (at any depth, except .npmrc). node_modules never appears here -
 * loadAddon skips it at load (its contents are never read); its directories are passed
 * through as `nodeModules` for the committed-node-modules check. This is the tooling
 * that BUILDS the add-on - build scripts, bundler configs, Makefiles, package.json/lock,
 * READMEs - which the add-on review (loadScsAddon) deliberately drops. Keys keep their
 * real archive-relative paths (nothing is prefix-stripped). buildScsBuildCtx wraps these
 * as the SCS-only `input: build` checks' ctx.addon, so its files never enter the review
 * addon that the other checks scan.
 *
 * A pure EXCLUDE rule (no allow-list to maintain): whatever remains after removing the
 * add-on source, the Experiment source, and dot-prefixed paths is the build corpus,
 * shown to the model wholesale. Dotfiles/folders (.git, .github, .idea, .yarnrc, ...)
 * are dropped as VCS/editor/CI noise - EXCEPT .npmrc, the npm/pnpm registry config the
 * build-tooling checks read.
 *
 * When scsSource IS the archive root, every file is review source, so there are no
 * build files (empty corpus -> the check skips).
 * @param {string} scsRoot  Path to the source archive root (folder or zip).
 * @param {string} scsSource  The --scs-source flag (the review source subtree).
 * @param {string} [scsExpSource]  The --scs-exp-source flag; excluded too (it sits
 *   inside scsSource, so this is defensive).
 * @returns {{files: Map<string, Buffer>, nodeModules: string[]}}
 */
export function loadScsBuildFiles(scsRoot, scsSource, scsExpSource) {
  const archive = loadAddon(scsRoot);
  const files = new Map();
  const src = scsRootRelative(scsSource, scsRoot, "--scs-source");
  if (!src) {
    // The review source IS the archive root: every file is add-on source, so there
    // are no build files outside it.
    return { files, nodeModules: archive.nodeModules };
  }
  const prefixes = [src];
  if (scsExpSource) {
    const exp = scsRootRelative(scsExpSource, scsRoot, "--scs-exp-source");
    if (exp) {
      prefixes.push(exp);
    }
  }
  for (const [p, buf] of archive.files) {
    // node_modules never reaches here - loadAddon skips it at load (never read) and
    // reports it as archive.nodeModules for the committed-node-modules check.
    // Dot-prefixed paths at any depth are VCS/editor/CI noise (.git, .github, .idea,
    // .yarnrc, ...) - EXCEPT a plain .npmrc, the npm/pnpm registry config the
    // build-registry-redirect check reads (kept unless itself buried in a dotfolder).
    const segments = p.split("/");
    const dotSegments = segments.filter((s) => s.startsWith("."));
    if (
      dotSegments.length > 0 &&
      !(dotSegments.length === 1 && segments[segments.length - 1] === ".npmrc")
    ) {
      continue;
    }
    // The review source + Experiment subtree are reviewed as the add-on, not the build.
    if (prefixes.some((pre) => p === pre || p.startsWith(`${pre}/`))) {
      continue;
    }
    files.set(p, buf);
  }
  return { files, nodeModules: archive.nodeModules };
}

/**
 * @param {string} zipPath  Path to the .xpi/.zip archive.
 * @returns {{files: Map<string, Buffer>, nodeModules: string[]}}
 */
function readZip(zipPath) {
  const zip = new AdmZip(zipPath);
  const files = new Map();
  const nodeModules = new Set();
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
    // Never decompress an installed-dependency tree: record the outer node_modules
    // directory and skip BEFORE getData(), so its contents never enter memory.
    const segs = name.split("/");
    const nm = segs.indexOf("node_modules");
    if (nm !== -1 && nm < segs.length - 1) {
      nodeModules.add(segs.slice(0, nm + 1).join("/"));
      continue;
    }
    files.set(name, entry.getData());
  }
  return { files, nodeModules: [...nodeModules] };
}

/**
 * @param {string} dir  Root directory of the unpacked add-on.
 * @returns {{files: Map<string, Buffer>, nodeModules: string[]}}
 */
function readDir(dir) {
  const files = new Map();
  const nodeModules = [];
  /** @param {string} current  Directory to recurse into. */
  const walk = (current) => {
    for (const e of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, e.name);
      if (e.isSymbolicLink()) {
        // A symlink named node_modules is a committed dependency tree too: record it
        // by name (its target is never followed or read) so committed-node-modules
        // still fires. Other symlinks are skipped rather than followed: a real .xpi
        // has none, and following could pull in host files or loop. Warn on those so
        // the skip is not silent.
        if (e.name === "node_modules") {
          nodeModules.push(normalize(path.relative(dir, full)));
        } else {
          warn(`Skipping symlink (not packaged): ${path.relative(dir, full)}`);
        }
      } else if (e.isDirectory()) {
        // Never read an installed-dependency tree: record it and do NOT recurse, so
        // its (huge) contents never enter memory.
        if (e.name === "node_modules") {
          nodeModules.push(normalize(path.relative(dir, full)));
        } else {
          walk(full);
        }
      } else if (e.isFile()) {
        const rel = path.relative(dir, full);
        files.set(normalize(rel), fs.readFileSync(full));
      }
    }
  };
  walk(dir);
  return { files, nodeModules };
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
