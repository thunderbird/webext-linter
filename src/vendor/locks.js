// Reads the project's lock file, for seven questions. (1) Which exact version did
// a package.json range (e.g. "^3.10.0") actually install - lockedVersion, so a
// declared dependency in a built XPI can still be pinned and audited. (2) What does the whole
// installed tree contain - lockedPackages, which enumerates every package the
// lock records, declared or pulled in by another package, which is all a source-code review
// audits. (3) Can the lock be read at all -
// unreadableLock, since the audit reads the tree out of it; whether it matches package.json
// is the package manager's question, answered when the build installs. (4) Where does the
// install take each package from - lockSourceGaps, since the audit identifies a package by
// name and version while the installer fetches the URL the lock records. (5) Which GitHub
// repository does a package the lock installs from GitHub come from - githubInstalls, so it
// can be popularity-gated by its stars. (6) Which installs does the lock take from a local
// path the review does not hold as a folder - localInstalls. (7) Does every registry entry
// install the release it names - findLockInjections, since the audit asks about the name and
// version while the installer fetches the URL. Reads whichever lock the
// submission ships - npm (package-lock.json / npm-shrinkwrap.json, JSON) or pnpm
// (pnpm-lock.yaml, YAML), the two supported package managers.
//
// ONE GOVERNING LOCK. Every reader below asks governingLock which file the submission
// installs from, so a submission cannot be rejected over one lock while a version is pinned
// and a whole tree audited out of another, as readers each picking for itself (first
// present / first that resolves / first that yields) would allow.
//
// Belongs here: lockedVersion(addon, name), lockedPackages(addon), unreadableLock(addon),
// lockSourceGaps(addon), githubInstalls(addon), localInstalls(addon),
// lockInstallTargets(addon), findLockInjections(addon), governingLock, committedLocks, and
// the per-format readers. Does NOT belong here:
// reading or shaping package.json (-> ./package-file.js), deciding pinned/unpinned
// (-> ./resolve.js), whether the lock matches package.json (the package manager's own
// question, at install), and the verification that follows (-> ./verify.js).

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  VENDOR_LOCK_MAX_PACKAGES,
  NPM_REGISTRY_TARBALLS,
  NPM_REGISTRY_CACHE,
} from "../config.js";
import { stripBom } from "../util/json.js";
import { parseJson } from "../util/json.js";
import { writeFileAtomic } from "../util/atomic.js";
import { debug } from "../util/log.js";
import { classifySource } from "./sources.js";
import { defaultNet } from "./verify.js";
import { networkSwitchedOff } from "../util/net.js";

import {
  DECLARATION_MAPS,
  aliasTarget,
  declaredDependencies,
  readPackageFile,
  submissionFiles,
  ownValue,
} from "./package-file.js";
import { rethrowIfFatal } from "../lib/errors.js";
import { cutAtFirst } from "../util/text.js";

/** @typedef {import("../addon/load.js").Addon} Addon */
/**
 * @typedef {object} LockedPackage  One package the lock file records as
 * installed, whether the submission declares it or another package pulls it in.
 * @property {string} name  npm package name (an npm alias resolves to the real one).
 * @property {string} version  The exact installed version.
 * @property {boolean} dev  Installed for the build only, never for production.
 * @property {boolean} direct  Declared by a package file in this submission - the root
 *   package.json, a workspace member, or a pnpm importer - rather than reached only
 *   through another package. Read from the lock's OWN record of what was asked for,
 *   so it covers the declaration forms the root package.json parse does not
 *   (optionalDependencies, a workspace member's own package file) and stays true when
 *   package.json and the lock disagree about a version. An npm lockfile v1 keeps no such
 *   record, so every package in one is marked declared (-> npmV1Packages).
 * @property {string} file  The lock file it was read from (the finding's anchor).
 * @property {string} token  The string locating its entry in `file`.
 */
// The lock files that record a whole tree, in the order they are consulted. Only the first
// one PRESENT is read (-> governingLock) - merging two would report the same tree twice,
// and judging the wrong one reports a tree that is never installed.
//
// npm-shrinkwrap.json comes first because npm PREFERS it: with both committed, npm
// installs from the shrinkwrap and ignores package-lock.json entirely. Reading them
// the other way round judges the file npm does not use, which both invents failures
// (a stale package-lock beside a good shrinkwrap) and misses real ones.
export const TREE_LOCKS = [
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
];

/**
 * The lock this submission installs from, or null when it commits none.
 *
 * ONE selection, shared by every reader here, so a submission cannot be rejected over
 * one lock while a version is pinned and a tree audited out of another. Chosen by NAME in
 * TREE_LOCKS order and never by whether the file parses or yields anything: that is what
 * the package managers do - npm reads the one it prefers and fails on it rather than
 * falling back to a valid lock sitting beside it (measured: the same tree installs cleanly
 * from a package-lock.json alone, and is refused with EUSAGE once an unparseable
 * npm-shrinkwrap.json is added next to it).
 *
 * Picking by "first that answers" instead would let an unreadable governing lock launder a
 * pin out of a file the install never opens.
 *
 * Also the answer to "did this submission commit a lock at all", which is what tells a
 * ranged dependency nothing resolves apart from one a committed lock simply does not cover
 * (-> ./resolve.js classifyDeps).
 * @param {?Addon} addon
 * @returns {?string}  A TREE_LOCKS filename, or null.
 */
export function governingLock(addon) {
  return committedLocks(addon)[0] ?? null;
}

/**
 * Every lock this submission commits at its root, in TREE_LOCKS order - the files
 * governingLock chooses from, so the two never disagree about which files count. A source
 * review refuses more than one (sca-lock-file-multiple, and the preparation's audit): the
 * checks read the governing lock, while the build picks its package manager by the lock it
 * finds, so with two of them the tree audited need not be the tree installed.
 * @param {?Addon} addon
 * @returns {string[]}  TREE_LOCKS filenames.
 */
export function committedLocks(addon) {
  const files = submissionFiles(addon);
  return TREE_LOCKS.filter((file) => files?.has(file));
}

// A concrete released version. Anything else in a `version` field (a git ref, a
// "file:" path, a workspace alias) names something that is not a registry
// release, so auditing it under that name would fabricate a hit.
const NUMERIC_VERSION = /^\d+\.\d+/;

// The npm registry's host, as the URL parser spells it (lowercase).
const NPM_REGISTRY_HOST = new URL(NPM_REGISTRY_TARBALLS).hostname;

/**
 * Where a lock entry's install takes the package from, by its `resolved` URL (npm) or
 * `resolution.tarball` (pnpm). Absent means the registry: that is what npm records when it
 * omits the field. Only a "registry" entry is a release its name and version identify, so
 * it alone is audited as one. A registry or GitHub URL is read by the URL parser, so its
 * host is the one the installer connects to, whatever userinfo or backslash precedes it.
 * A value that is none of the four kinds is "foreign", which lock-foreign-source rejects:
 * what cannot be read is not passed.
 * @param {unknown} url
 * @returns {"registry"|"github"|"local"|"foreign"}
 */
function installSource(url) {
  const s = String(url ?? "");
  if (s === "") {
    return "registry";
  }
  const parsed = parseUrl(s);
  if (parsed?.protocol === "https:" && parsed.hostname === NPM_REGISTRY_HOST) {
    return "registry";
  }
  if (isGithubSource(s)) {
    return "github";
  }
  // A file:/link: spec or a relative path is the submission's own code. "//" opens a
  // scheme-relative URL, which names a host and not a path.
  const lower = s.toLowerCase();
  if (
    lower.startsWith("file:") ||
    lower.startsWith("link:") ||
    s.startsWith(".") ||
    (s.startsWith("/") && !s.startsWith("//"))
  ) {
    return "local";
  }
  return "foreign";
}

/**
 * A string read as an absolute URL, or null when it is not one.
 * @param {string} s
 * @returns {?URL}
 */
function parseUrl(s) {
  try {
    return new URL(s);
  } catch (err) {
    rethrowIfFatal(err);
    return null;
  }
}

// The path segment that marks an installed package in an npm lockfile v2/v3 `packages` key. A
// key without one is the project root ("") or a workspace member - the submission's own code.
const NODE_MODULES = "node_modules/";

// A pnpm `packages:` key, across every format pnpm has used: v5 "/name/version",
// v6-v8 "/name@version(peers)" and v9 "name@version".
const PNPM_KEY_RE = /^\/?(@?[^@/]+(?:\/[^@/]+)?)[@/]([0-9][^()/]*)/;

// Parsed lock files, per add-on, per file. Every reader here reads the same lock,
// and classifyDeps asks lockedVersion once per unpinned dependency, so the parse is
// memoized rather than repeated. Keyed weakly: the cache dies with the
// add-on it describes.
/** @type {WeakMap<Addon, Map<string, ?object>>} */
const parseCache = new WeakMap();

/**
 * One lock file's parsed contents, or null when it is absent or unparseable.
 * @param {Addon} addon
 * @param {string} file  A lock filename.
 * @returns {?object}
 */
function parsedLock(addon, file) {
  let byFile = parseCache.get(addon);
  if (!byFile) {
    byFile = new Map();
    parseCache.set(addon, byFile);
  }
  if (byFile.has(file)) {
    return byFile.get(file);
  }
  const text = submissionFiles(addon)?.get(file)?.toString("utf8");
  let data = null;
  try {
    if (text) {
      const clean = stripBom(text);
      data = file.endsWith(".json") ? parseJson(clean) : YAML.parse(clean);
    }
  } catch (err) {
    rethrowIfFatal(err);
    data = null;
  }
  byFile.set(file, data);
  return data;
}

/**
 * The exact version the governing lock pins `name` to, or null when it does not.
 *
 * Deliberately NOT rebuilt on lockedPackages: this consults the HOISTED
 * top-level entry only, so a nested copy of a package cannot pin a declared
 * range to a version the build does not use for it.
 * @param {Addon} addon
 * @param {string} name  The npm package name (may be scoped, "@scope/pkg").
 * @returns {?string}
 */
export function lockedVersion(addon, name) {
  const file = governingLock(addon);
  if (!file) {
    return null;
  }
  const data = parsedLock(addon, file);
  return file.endsWith(".json") ? npmLock(data, name) : pnpmLock(data, name);
}

/**
 * @param {?object} data  Parsed package-lock.json / npm-shrinkwrap.json.
 * @param {string} name
 * @returns {?string}
 */
function npmLock(data, name) {
  // lockfileVersion 2/3: the hoisted entry under "node_modules/<name>".
  const pkg = data?.packages?.[`node_modules/${name}`];
  if (pkg?.version) {
    return pkg.version;
  }
  // lockfileVersion 1: dependencies tree.
  return ownValue(data?.dependencies, name)?.version ?? null;
}

/**
 * @param {?object} data  Parsed pnpm-lock.yaml.
 * @param {string} name
 * @returns {?string}
 */
function pnpmLock(data, name) {
  const root = data?.importers?.["."] ?? data;
  const entry =
    ownValue(root?.dependencies, name) ?? ownValue(root?.devDependencies, name);
  const version = typeof entry === "string" ? entry : entry?.version;
  if (version) {
    return cleanVersion(version);
  }
  // Fallback: a "/<name>@<version>" or "/<name>/<version>" packages key.
  for (const key of Object.keys(data?.packages ?? {})) {
    const m = key.match(PNPM_KEY_RE);
    if (m && m[1] === name) {
      return cleanVersion(m[2]);
    }
  }
  return null;
}

/**
 * Every package the submission's lock file records as installed - the declared
 * dependencies AND everything they pull in, at whatever depth. The set the OSV
 * tree audit queries (src/vendor/verify.js auditLockedPackages).
 *
 * Read from the GOVERNING lock alone (-> governingLock): two locks describe the same
 * install, so enumerating both would report every package twice, and enumerating the one
 * that happens to answer would audit a tree the install never builds.
 * @param {Addon} addon
 * @returns {LockedPackage[]}  Sorted by name, then version, and truncated at
 *   VENDOR_LOCK_MAX_PACKAGES - which sits well above any real tree, because a
 *   package dropped here is simply never audited.
 */
export function lockedPackages(addon) {
  const file = governingLock(addon);
  const data = file ? parsedLock(addon, file) : null;
  if (!data) {
    return [];
  }
  const found = file.endsWith(".json")
    ? npmPackages(data, file)
    : pnpmPackages(data, file);
  return dedupe(found);
}

/**
 * Enumerate an npm lock: the flat `packages` map (lockfileVersion 2/3) or the
 * nested `dependencies` tree (lockfileVersion 1).
 * @param {object} data  Parsed lock. @param {string} file  Its filename.
 * @returns {LockedPackage[]}
 */
function npmPackages(data, file) {
  if (data.packages && typeof data.packages === "object") {
    return npmTreePackages(data.packages, file);
  }
  return npmV1Packages(data.dependencies, file);
}

/**
 * lockfileVersion 2/3: one entry per installed path, keyed by its location in
 * node_modules. A key with no `node_modules/` segment is the project root ("")
 * or a workspace member - the submission's own code, not an installed package.
 * @param {Record<string, object>} packages @param {string} file
 * @returns {LockedPackage[]}
 */
function npmTreePackages(packages, file) {
  const out = [];
  const direct = npmDeclaredNames(packages);
  for (const [key, entry] of Object.entries(packages)) {
    const at = key.lastIndexOf(NODE_MODULES);
    if (at === -1 || !entry || typeof entry !== "object") {
      continue;
    }
    if (entry.link === true) {
      continue; // a symlink to a workspace member, recorded under its own key
    }
    const version = String(entry.version ?? "");
    if (
      !NUMERIC_VERSION.test(version) ||
      installSource(entry.resolved) !== "registry"
    ) {
      continue;
    }
    // `name` is present when the installed package differs from its directory,
    // which is how npm records an alias - the real package is what to audit.
    const name = String(entry.name ?? key.slice(at + NODE_MODULES.length));
    if (!name) {
      continue;
    }
    // `devOptional` means dev here and production somewhere else in the tree, so
    // it is not dev-ONLY: only a plain `dev` marks a build-time-only package.
    out.push({
      name,
      version,
      dev: entry.dev === true,
      direct: direct.has(name),
      file,
      token: key,
    });
  }
  return out;
}

/**
 * What the submission's own package files ask for, in a lockfileVersion 2/3 `packages` map.
 * An entry with no node_modules segment IS one of those package files - the project root
 * under "", a workspace member under its path - so its dependency maps are declarations,
 * not installs.
 * @param {Record<string, object>} packages
 * @returns {Set<string>}
 */
function npmDeclaredNames(packages) {
  const direct = new Set();
  for (const [key, entry] of Object.entries(packages)) {
    if (key.includes(NODE_MODULES) || !entry || typeof entry !== "object") {
      continue;
    }
    for (const map of DECLARATION_MAPS) {
      for (const [name, spec] of Object.entries(entry[map] ?? {})) {
        direct.add(declaredName(name, spec));
      }
    }
  }
  return direct;
}

/**
 * lockfileVersion 1: a nested tree, each node carrying its own `dependencies`.
 *
 * Walked with an explicit stack rather than by recursion: the nesting depth is
 * whatever the submitted file says, and a lock nested a few thousand deep - a
 * couple of hundred KB to write - would otherwise exhaust the call stack and
 * abort the whole review.
 *
 * v1 keeps no record of which packages the project asked for (the top level is
 * the hoisted tree, not a package file), so no package can be told apart from another as
 * declared or pulled in. Every one is marked direct: what a declared dependency is held to
 * (the popularity gate, and the checks that say "declares") is then asked of the whole
 * tree, rather than of none of it.
 * @param {Record<string, object>|undefined} deps @param {string} file
 * @returns {LockedPackage[]}
 */
function npmV1Packages(deps, file) {
  const out = [];
  const stack = [deps];
  while (stack.length) {
    for (const [name, node] of Object.entries(stack.pop() ?? {})) {
      if (!node || typeof node !== "object") {
        continue;
      }
      const version = String(node.version ?? "");
      // v1 records a git install in `version` itself, hence the same guard as v3.
      if (
        NUMERIC_VERSION.test(version) &&
        installSource(node.resolved) === "registry"
      ) {
        out.push({
          name,
          version,
          dev: node.dev === true,
          direct: true,
          file,
          token: name,
        });
      }
      if (node.dependencies) {
        stack.push(node.dependencies);
      }
    }
  }
  return out;
}

/**
 * Enumerate a pnpm lock's `packages` map. Up to v8 each entry carries its own
 * `dev` flag; v9 dropped it, so production is derived from the graph instead
 * (pnpmProdKeys).
 * @param {object} data  Parsed lock. @param {string} file
 * @returns {LockedPackage[]}
 */
function pnpmPackages(data, file) {
  const packages = data?.packages;
  if (!packages || typeof packages !== "object") {
    return [];
  }
  const prod = data?.snapshots ? pnpmProdKeys(data) : null;
  const direct = pnpmDeclaredNames(data);
  const out = [];
  for (const [key, entry] of Object.entries(packages)) {
    const m = key.match(PNPM_KEY_RE);
    if (!m) {
      continue;
    }
    const name = m[1];
    const version = cleanVersion(m[2]);
    if (!NUMERIC_VERSION.test(version) || pnpmSource(entry) !== "registry") {
      continue;
    }
    out.push({
      name,
      version,
      dev: prod ? !prod.has(`${name}@${version}`) : entry?.dev === true,
      direct: direct.has(name),
      file,
      token: key,
    });
  }
  return out;
}

/**
 * What a pnpm lock's importers ask for. The importers ARE the submission's package files,
 * restated by pnpm - so what they ask for is what it declares.
 * @param {object} data  Parsed lock.
 * @returns {Set<string>}
 */
function pnpmDeclaredNames(data) {
  const direct = new Set();
  for (const importer of Object.values(data.importers ?? {})) {
    for (const map of DECLARATION_MAPS) {
      for (const [name, spec] of Object.entries(importer?.[map] ?? {})) {
        direct.add(declaredName(name, spec));
      }
    }
  }
  return direct;
}

/**
 * Which packages a pnpm v9 lock installs for production. v9 records no `dev`
 * flag, so the answer is reachability: walk out from each importer's production
 * dependencies through the `snapshots` edges, and whatever is never reached is
 * build-time only.
 *
 * Snapshot keys carry a peer-dependency suffix ("name@1.0.0(peer@2.0.0)") that
 * the `packages` keys do not, so the returned set is keyed by the bare
 * "name@version" both spellings reduce to.
 * @param {object} data  Parsed lock (with a `snapshots` map).
 * @returns {Set<string>}
 */
function pnpmProdKeys(data) {
  const snapshots = data.snapshots ?? {};
  // A dependency value is normally the version alone ("1.0.0", or
  // "1.0.0(peer@2.0.0)"), and the snapshot it names is that appended to the
  // package name. Under an npm: alias it is instead the TARGET's own
  // "name@version", which already names the snapshot - prefixing the alias name
  // would build a key nothing answers to, and the target's whole subtree would
  // then read as build-time only. A version starts with a digit and a package
  // name does not, which is what tells the two apart.
  const edgesOf = (deps) =>
    Object.entries(deps ?? {}).map(([name, raw]) => {
      const v = typeof raw === "string" ? raw : (raw?.version ?? "");
      return /^\d/.test(v) ? `${name}@${v}` : v;
    });
  const queue = [];
  for (const importer of Object.values(data.importers ?? {})) {
    queue.push(
      ...edgesOf(importer?.dependencies),
      ...edgesOf(importer?.optionalDependencies)
    );
  }
  const seen = new Set();
  const prod = new Set();
  while (queue.length) {
    const key = queue.pop();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const m = key.match(PNPM_KEY_RE);
    if (m) {
      prod.add(`${m[1]}@${cleanVersion(m[2])}`);
    }
    const snapshot = snapshots[key];
    queue.push(
      ...edgesOf(snapshot?.dependencies),
      ...edgesOf(snapshot?.optionalDependencies)
    );
  }
  return prod;
}

/**
 * Collapse the enumeration to one entry per name@version and put it in a stable
 * order. The first entry for a version wins its anchor - insertion order puts
 * the shallower, more recognizable path first - while production wins over dev
 * (a package installed for both is shipped) and declared wins over reached (one
 * package file asking for it by name is enough to make it declared).
 *
 * Sorted so that two runs over one lock produce the same list, which is what
 * makes a golden fixture's batch answers line up with the packages they are
 * about. Compared by code point rather than by locale, so the order does not
 * depend on the reviewing machine's locale.
 * @param {LockedPackage[]} found
 * @returns {LockedPackage[]}
 */
function dedupe(found) {
  /** @type {Map<string, LockedPackage>} */
  const byKey = new Map();
  for (const pkg of found) {
    const key = `${pkg.name}@${pkg.version}`;
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, pkg);
      continue;
    }
    if (seen.dev && !pkg.dev) {
      seen.dev = false;
    }
    if (pkg.direct) {
      seen.direct = true;
    }
  }
  return [...byKey.values()]
    .sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version))
    .slice(0, VENDOR_LOCK_MAX_PACKAGES);
}

/**
 * The package a declaration actually installs. Normally that is the name it is
 * written under, but an "npm:<name>@<range>" alias installs something else, and
 * the tree records the REAL name - so matching on the written one would leave an
 * aliased dependency looking like a package nobody asked for.
 * @param {string} name  The name the declaration is written under.
 * @param {string|{specifier?: string}} spec  Its version spec, as npm writes it
 *   or as a pnpm importer entry carries it.
 * @returns {string}
 */
function declaredName(name, spec) {
  const written = typeof spec === "string" ? spec : (spec?.specifier ?? "");
  return aliasTarget(written)?.name ?? name;
}

/**
 * @typedef {object} SourceGap  A lock entry the install takes from a source the review
 * cannot audit: neither the npm registry nor GitHub.
 * @property {string} file  The governing lock it was read from.
 * @property {string} token  The entry's key in that lock, locating its line.
 * @property {string} name  The package.
 * @property {string} version  The version the entry records ("" when it records none).
 * @property {string} source  Where the install takes it from, as the lock records it.
 */

/**
 * Every lock entry the install takes from a source the dependency audit does not read.
 * The audit identifies a package by name and version, while `npm ci` and pnpm fetch it
 * from the URL the lock records - so an entry resolved anywhere else installs bytes the
 * audit vouched for under someone else's name. GitHub is accepted: a GitHub install is
 * never audited under an npm name (lockedPackages takes registry entries alone), and its
 * repository is popularity-gated instead (githubInstalls). A local path is not judged here
 * either: localInstalls answers for it. Read by the lock-foreign-source check.
 * @param {Addon} addon  The SCA archive (its governing lock).
 * @returns {SourceGap[]}
 */
export function lockSourceGaps(addon) {
  const file = governingLock(addon);
  const data = file ? parsedLock(addon, file) : null;
  if (!data) {
    return [];
  }
  const gaps = [];
  const judge = (token, name, version, source, kind) => {
    if (kind === "foreign") {
      gaps.push({ file, token, name, version, source });
    }
  };
  if (!file.endsWith(".json")) {
    for (const [token, entry] of Object.entries(data.packages ?? {})) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const m = token.match(PNPM_KEY_RE);
      const name = String(entry.name ?? m?.[1] ?? token);
      const version = String(entry.version ?? (m ? cleanVersion(m[2]) : ""));
      const source = String(
        entry.resolution?.tarball ?? entry.resolution?.repo ?? ""
      );
      judge(token, name, version, source, pnpmSource(entry));
    }
    return gaps;
  }
  if (data.packages && typeof data.packages === "object") {
    for (const [token, entry] of Object.entries(data.packages)) {
      const at = token.lastIndexOf(NODE_MODULES);
      if (at === -1 || !entry || typeof entry !== "object" || entry.link) {
        continue;
      }
      const source = String(entry.resolved ?? "");
      judge(
        token,
        token.slice(at + NODE_MODULES.length),
        String(entry.version ?? ""),
        source,
        installSource(source)
      );
    }
    return gaps;
  }
  // lockfileVersion 1: a nested tree, walked like npmV1Packages.
  const stack = [data.dependencies];
  while (stack.length) {
    for (const [name, node] of Object.entries(stack.pop() ?? {})) {
      if (!node || typeof node !== "object") {
        continue;
      }
      const source = String(node.resolved ?? "");
      judge(
        name,
        name,
        String(node.version ?? ""),
        source,
        installSource(source)
      );
      if (node.dependencies) {
        stack.push(node.dependencies);
      }
    }
  }
  return gaps;
}

/**
 * @typedef {object} LockInstallTarget  One registry entry of the governing lock.
 * @property {string} file  The governing lock.
 * @property {string} token  The entry's key in that lock, locating its line.
 * @property {string} name  The package the entry names: what the audit asks about.
 * @property {string} version  The version the entry names.
 * @property {string} url  The tarball URL the install fetches, "" when the entry records
 *   none (the registry's own tarball for the name and version, found by integrity).
 * @property {?{name: string, version: string}} installs  The release that URL is, read from
 *   the registry's tarball path; the entry's own name and version when it records no URL;
 *   null when the URL is on the registry but off that path.
 */

/**
 * Every registry entry of the governing lock, with the release its URL installs. The audit
 * identifies a package by the name and version the entry records, while `npm ci` and pnpm
 * fetch the URL, so the two have to name the same release. Every registry entry is listed,
 * whatever its version looks like: a version that is no release at all, beside a registry
 * URL, installs something the audit never asks about. A package bundled inside another
 * (`inBundle`, or `bundled` in a lockfile v1) is installed with it and fetches nothing.
 * @param {Addon} addon  The SCA archive (its governing lock).
 * @returns {LockInstallTarget[]}
 */
export function lockInstallTargets(addon) {
  const file = governingLock(addon);
  const data = file ? parsedLock(addon, file) : null;
  if (!plainObject(data)) {
    return [];
  }
  const out = [];
  const add = (token, name, version, url) => {
    out.push({
      file,
      token,
      name,
      version,
      url,
      installs: url ? tarballRelease(url) : { name, version },
    });
  };
  if (!file.endsWith(".json")) {
    for (const [token, entry] of Object.entries(objectOr(data.packages))) {
      if (!plainObject(entry) || pnpmSource(entry) !== "registry") {
        continue;
      }
      const m = token.match(PNPM_KEY_RE);
      add(
        token,
        String(entry.name ?? m?.[1] ?? token),
        String(entry.version ?? (m ? cleanVersion(m[2]) : "")),
        String(entry.resolution?.tarball ?? "")
      );
    }
    return out;
  }
  if (plainObject(data.packages)) {
    for (const [token, entry] of Object.entries(data.packages)) {
      const at = token.lastIndexOf(NODE_MODULES);
      if (at === -1 || !plainObject(entry) || entry.link || entry.inBundle) {
        continue;
      }
      const url = String(entry.resolved ?? "");
      if (installSource(url) !== "registry") {
        continue;
      }
      // `name` is present when the installed package differs from its directory: an alias.
      add(
        token,
        String(entry.name ?? token.slice(at + NODE_MODULES.length)),
        String(entry.version ?? ""),
        url
      );
    }
    return out;
  }
  // lockfileVersion 1: a nested tree, walked like npmV1Packages.
  const stack = [data.dependencies];
  while (stack.length) {
    for (const [key, node] of Object.entries(objectOr(stack.pop()))) {
      if (!plainObject(node)) {
        continue;
      }
      if (node.dependencies) {
        stack.push(node.dependencies);
      }
      const url = String(node.resolved ?? "");
      if (node.bundled === true || installSource(url) !== "registry") {
        continue;
      }
      const { name, version } = v1Label(key, String(node.version ?? ""));
      add(key, name, version, url);
    }
  }
  return out;
}

/**
 * The package and version a lockfile v1 entry names. An npm alias records the real package
 * in `version` itself, as `npm:<package>@<version>`, under the alias's key.
 * @param {string} key  The entry's key.
 * @param {string} version  Its `version` field.
 * @returns {{name: string, version: string}}
 */
function v1Label(key, version) {
  if (version.startsWith("npm:")) {
    const spec = version.slice("npm:".length);
    const at = spec.lastIndexOf("@");
    if (at > 0) {
      return { name: spec.slice(0, at), version: spec.slice(at + 1) };
    }
  }
  return { name: key, version };
}

/**
 * A tarball URL as the installer fetches it: its query and fragment dropped, and a scoped
 * name's encoded slash (`@scope%2fname`) decoded, so two spellings of one URL read the same.
 * @param {string} url
 * @returns {string}
 */
function plainTarballUrl(url) {
  return cutAtFirst(cutAtFirst(url, "#"), "?").replace(/%2f/gi, "/");
}

/**
 * The release a registry tarball URL is, read from its path
 * (`<package>/-/<name>-<version>.tgz`), or null when the URL is off that path.
 * @param {string} url
 * @returns {?{name: string, version: string}}
 */
function tarballRelease(url) {
  const src = classifySource(plainTarballUrl(url));
  return src.trusted && src.tarball
    ? { name: src.pkg, version: src.version }
    : null;
}

/**
 * @typedef {LockInstallTarget & {installed: string}} LockInjection  A registry entry that
 *   installs another release than it names. `installed` is that release as
 *   `<package>@<version>`, or the URL itself when its path does not say.
 */

/**
 * Every registry entry of the governing lock that installs another release than the one it
 * names - a forged lock, where the audit would vouch for one release while the install
 * fetches another.
 *
 * A URL on the registry's tarball path names its release, and is compared with the entry
 * offline. One on the registry but off that path is asked of the registry itself
 * (`GET <registry>/<package>/<version>`, whose `dist.tarball` is where that release is), and
 * the answer is cached for good in `cacheDir`: a published release's tarball never moves. A
 * release the registry does not have (404) makes its entry forged, and is never cached: a 404
 * can be a passing fault of the registry too, so it is asked again on the next run.
 * @param {Addon} addon  The SCA archive (its governing lock).
 * @param {object} [opts]
 * @param {import("./verify.js").VendorNet} [opts.net]  The network the registry is asked on.
 * @param {string} [opts.cacheDir]  Where the registry's answers are cached.
 * @returns {Promise<LockInjection[]>}
 */
export async function findLockInjections(
  addon,
  { net = defaultNet, cacheDir = NPM_REGISTRY_CACHE } = {}
) {
  const forged = [];
  let cache = null;
  let dirty = false;
  for (const target of lockInstallTargets(addon)) {
    const { name, version, installs } = target;
    if (installs) {
      if (installs.name !== name || installs.version !== version) {
        forged.push({
          ...target,
          installed: `${installs.name}@${installs.version}`,
        });
      }
      continue;
    }
    cache ??= loadRegistryCache(cacheDir);
    const key = `${name}@${version}`;
    let tarball = cachedTarball(Object.hasOwn(cache, key) ? cache[key] : null);
    if (tarball === undefined) {
      tarball = await registryTarball(net, name, version);
      if (tarball !== null) {
        cache[key] = tarball;
        dirty = true;
      }
    }
    if (
      tarball === null ||
      plainTarballUrl(tarball) !== plainTarballUrl(target.url)
    ) {
      forged.push({ ...target, installed: target.url });
    }
  }
  if (dirty) {
    saveRegistryCache(cacheDir, cache);
  }
  return forged;
}

/**
 * Where the registry serves one release's tarball, or null when it has no such release.
 * Only a 404 is that answer: anything else that is no answer ends the review
 * (src/util/net.js), like every other question the review asks a host.
 * @param {import("./verify.js").VendorNet} net
 * @param {string} name  The package, possibly scoped.
 * @param {string} version
 * @returns {Promise<?string>}
 */
async function registryTarball(net, name, version) {
  const url = `${NPM_REGISTRY_TARBALLS}${name.replace("/", "%2f")}/${encodeURIComponent(version)}`;
  try {
    const j = await net.fetchJson(url);
    const tarball = j?.dist?.tarball;
    return typeof tarball === "string" && tarball !== "" ? tarball : null;
  } catch (err) {
    if (err.status !== 404) {
      throw err;
    }
    return null;
  }
}

/**
 * What a cache entry answers: the tarball URL it keeps; null for a pre-filled 404
 * (`{fake404: true}`), read only with the network switched off (src/util/net.js
 * networkSwitchedOff), since no lookup writes one and it is how a test is given that answer
 * offline; and undefined for anything else - none yet, a pre-filled 404 in a real run, an
 * older version's entry, a corrupt value - which is asked again.
 * @param {unknown} entry
 * @returns {string|null|undefined}
 */
function cachedTarball(entry) {
  if (typeof entry === "string" && entry !== "") {
    return entry;
  }
  return entry?.fake404 === true && networkSwitchedOff() ? null : undefined;
}

/** The on-disk cache file: a `{ "<package>@<version>": <tarball URL> | {fake404: true} }`
 *  JSON map. */
function registryCacheFile(cacheDir) {
  return path.join(cacheDir, "npm-registry.json");
}

/**
 * Load the registry's cached answers, or an empty map when absent or corrupt.
 * @param {string} cacheDir
 * @returns {Record<string, string|{fake404: true}>}
 */
function loadRegistryCache(cacheDir) {
  try {
    const cache = parseJson(
      fs.readFileSync(registryCacheFile(cacheDir), "utf8")
    );
    return plainObject(cache) ? cache : {};
  } catch (err) {
    rethrowIfFatal(err);
    return {};
  }
}

/**
 * Persist the cache. Best-effort: a write failure is non-fatal (the answers are just asked
 * again next run).
 * @param {string} cacheDir
 * @param {Record<string, string|{fake404: true}>} cache
 */
function saveRegistryCache(cacheDir, cache) {
  try {
    writeFileAtomic(registryCacheFile(cacheDir), JSON.stringify(cache));
  } catch (err) {
    debug(`Could not write npm registry cache: ${err.message}`);
  }
}

/**
 * A lock map's value when it is a plain object, and an empty one otherwise.
 * @param {unknown} value
 * @returns {object}
 */
function objectOr(value) {
  return plainObject(value) ? value : {};
}

/**
 * @typedef {object} GithubInstall  A package the lock installs from a GitHub repository.
 * @property {string} name  The package.
 * @property {string} version  The version the entry records, or its source when it records
 *   none.
 * @property {string} repo  The repository, "owner/repo".
 * @property {boolean} direct  Declared by a package file in this submission, read from the
 *   lock as LockedPackage.direct is (every package of an npm lockfile v1).
 * @property {string} file  The governing lock it was read from.
 * @property {string} token  The entry's key in that lock, locating its line.
 */

/**
 * Every package the lock installs from GitHub, with the repository it comes from. Such a
 * package is never audited by name and version (lockedPackages takes registry entries
 * alone), so what a source review can ask of it is how widely used its repository is - a
 * question for the declared ones, like the popularity gate on a registry package.
 *
 * The repository is read from any source isGithubSource recognises - the one classifier
 * installSource and pnpmSource use too, so whatever they accept as GitHub is read here:
 * npm's `resolved` (lockfile v1 records a git install in `version` instead), and pnpm's
 * codeload `resolution.tarball` or git `resolution.repo`. A pnpm entry's key is not a package name
 * for a git install, so the name is the one the entry records.
 * @param {Addon} addon  The SCA archive (its governing lock).
 * @returns {GithubInstall[]}
 */
export function githubInstalls(addon) {
  const file = governingLock(addon);
  const data = file ? parsedLock(addon, file) : null;
  if (!data) {
    return [];
  }
  const out = [];
  // An entry the lock gives no name cannot be matched against what the project declares, so
  // whether it is direct cannot be told - and what cannot be told apart is gated, so it
  // counts as direct. Its repository still names it.
  const take = (token, name, version, sources, direct) => {
    const source = sources.map((v) => String(v ?? "")).find(isGithubSource);
    const repo = source ? githubRepo(source) : null;
    if (repo) {
      out.push({
        name: name || repo,
        version: version || source,
        repo,
        direct: name ? direct : true,
        file,
        token,
      });
    }
  };
  if (!file.endsWith(".json")) {
    const direct = pnpmDeclaredNames(data);
    for (const [token, entry] of Object.entries(data.packages ?? {})) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const name = String(entry.name ?? "");
      take(
        token,
        name,
        String(entry.version ?? ""),
        [entry.resolution?.tarball, entry.resolution?.repo],
        direct.has(name)
      );
    }
    return out;
  }
  if (data.packages && typeof data.packages === "object") {
    const direct = npmDeclaredNames(data.packages);
    for (const [token, entry] of Object.entries(data.packages)) {
      const at = token.lastIndexOf(NODE_MODULES);
      if (at === -1 || !entry || typeof entry !== "object" || entry.link) {
        continue;
      }
      const name = String(entry.name ?? token.slice(at + NODE_MODULES.length));
      take(
        token,
        name,
        String(entry.version ?? ""),
        [entry.resolved],
        direct.has(name)
      );
    }
    return out;
  }
  // lockfileVersion 1: every package counts as declared (-> npmV1Packages).
  const stack = [data.dependencies];
  while (stack.length) {
    for (const [name, node] of Object.entries(stack.pop() ?? {})) {
      if (!node || typeof node !== "object") {
        continue;
      }
      take(name, name, "", [node.resolved, node.version], true);
      if (node.dependencies) {
        stack.push(node.dependencies);
      }
    }
  }
  return out;
}

/**
 * Whether a recorded source installs from GitHub: it names a repository there
 * (githubRepoOf). The ONE classifier for it - installSource, pnpmSource and
 * githubInstalls all ask it - so what lock-foreign-source accepts as GitHub is exactly
 * what the popularity gate reads a repository from. A source naming no repository is not
 * GitHub, and stays foreign.
 * @param {string} source
 * @returns {boolean}
 */
function isGithubSource(source) {
  return githubRepoOf(source) !== null;
}

/**
 * The "owner/repo" a GitHub install source names, or null when it names none.
 * @param {string} source
 * @returns {?string}
 */
function githubRepo(source) {
  const gh = githubRepoOf(source);
  return gh ? `${gh.owner}/${gh.repo}` : null;
}

/**
 * The GitHub repository a source names, or null when it names none. A leading "git+" is
 * dropped. A URL is read by the URL parser, so its host is the one a fetch connects to:
 * it must be github.com or codeload.github.com, and owner and repo are the first two path
 * segments (github.com/owner/repo.git#sha, codeload.github.com/owner/repo/tar.gz/sha).
 * The scp form git writes, `[user@]github.com:owner/repo`, is no URL (the parser rejects
 * it, or reads the owner as a port), so it is read by hand: an optional `scheme://`
 * (pnpm writes `git+ssh://git@github.com:owner/repo`), the host before the first ":"
 * with no "/" ahead of it (git reads a "/" there as a local path) and its userinfo cut at
 * the last "@", then owner and repo after the ":" up to a "#". A ".git" suffix is not
 * part of the repo.
 * @param {string} source
 * @returns {?{owner: string, repo: string}}
 */
export function githubRepoOf(source) {
  let s = String(source ?? "");
  if (s.slice(0, 4).toLowerCase() === "git+") {
    s = s.slice(4);
  }
  const url = parseUrl(s);
  // An empty hostname is a string the parser took for a scheme and an opaque path: the
  // scp form `github.com:owner/repo` reads that way.
  if (url && url.hostname !== "") {
    if (
      url.hostname !== "github.com" &&
      url.hostname !== "codeload.github.com"
    ) {
      return null;
    }
    const segs = url.pathname.split("/");
    return ownerRepo(segs[1], segs[2]);
  }
  const scheme = s.indexOf("://");
  if (scheme !== -1 && scheme === s.indexOf(":")) {
    s = s.slice(scheme + 3);
  }
  const colon = s.indexOf(":");
  if (colon === -1) {
    return null;
  }
  const userHost = s.slice(0, colon);
  const host = userHost.slice(userHost.lastIndexOf("@") + 1);
  if (userHost.includes("/") || host.toLowerCase() !== "github.com") {
    return null;
  }
  const [owner, repo] = cutAtFirst(s.slice(colon + 1), "#").split("/");
  return ownerRepo(owner, repo);
}

/**
 * Owner and repo as a pair, the repo without a ".git" suffix, or null when either is empty.
 * @param {string|undefined} owner @param {string|undefined} repo
 * @returns {?{owner: string, repo: string}}
 */
function ownerRepo(owner, repo) {
  let name = String(repo ?? "");
  if (name.toLowerCase().endsWith(".git")) {
    name = name.slice(0, -".git".length);
  }
  return owner && name ? { owner, repo: name } : null;
}

/**
 * @typedef {object} LocalInstall  A package the lock installs from a local path that is
 * not a folder of the submission.
 * @property {string} name  The package.
 * @property {string} spec  The path, as the lock records it.
 * @property {string} file  The governing lock it was read from.
 * @property {string} token  The string locating the entry in that lock.
 */

/**
 * Every install the lock takes from a local path, other than a folder the submission
 * holds. A folder inside the source root is the submission's own code, reviewed like any
 * other file, so nothing is said about it. Anything else local cannot be reviewed: a path
 * outside the root, one the submission does not hold, or a local tarball - which
 * installSource counts as local, so lock-foreign-source never sees it. Read by the
 * unsupported-dependency check in a source review.
 *
 * Where each format records the path: npm lockfile v2/v3 in a `link: true` entry's
 * `resolved` (relative to the root) and in a `resolved: "file:..."` for a tarball; npm
 * lockfile v1 in `version: "file:..."`; pnpm in an importer's `link:...` version (relative
 * to that importer's folder) and in a package's `resolution.directory` or
 * `resolution.tarball: "file:..."`.
 *
 * Whether a path is a folder is asked of what the LOADER saw (addon.directories): the key
 * set names files, so a path that IS a file would pass a prefix test against it as a real
 * folder does, and an empty folder would fail one although it is exactly what a local
 * install may name.
 * @param {Addon} addon  The SCA archive (its governing lock and the folders it holds).
 * @returns {LocalInstall[]}
 */
export function localInstalls(addon) {
  const file = governingLock(addon);
  const data = file ? parsedLock(addon, file) : null;
  if (!data) {
    return [];
  }
  const directories = new Set(addon?.directories ?? []);
  const out = [];
  const judge = (token, name, spec, baseDir, target) => {
    const dir = resolveLocalDir(baseDir, target);
    // The source root itself ("") is always a folder the submission holds.
    if (dir === null || (dir !== "" && !directories.has(dir))) {
      out.push({ name, spec, file, token });
    }
  };
  if (!file.endsWith(".json")) {
    const importers = data.importers ?? { ".": data };
    for (const [path, importer] of Object.entries(importers)) {
      const baseDir = path === "." ? "" : path;
      for (const map of DECLARATION_MAPS) {
        for (const [name, raw] of Object.entries(importer?.[map] ?? {})) {
          const v = typeof raw === "string" ? raw : String(raw?.version ?? "");
          if (/^link:/i.test(v)) {
            judge(name, name, v, baseDir, v.slice("link:".length));
          }
        }
      }
    }
    for (const [token, entry] of Object.entries(data.packages ?? {})) {
      const resolution = entry?.resolution;
      const name = String(entry?.name ?? token);
      if (typeof resolution?.directory === "string") {
        judge(token, name, resolution.directory, "", resolution.directory);
      } else if (/^file:/i.test(String(resolution?.tarball ?? ""))) {
        const tarball = String(resolution.tarball);
        judge(token, name, tarball, "", tarball.slice("file:".length));
      }
    }
    return out;
  }
  if (data.packages && typeof data.packages === "object") {
    for (const [token, entry] of Object.entries(data.packages)) {
      const at = token.lastIndexOf(NODE_MODULES);
      if (at === -1 || !entry || typeof entry !== "object") {
        continue;
      }
      const name = String(entry.name ?? token.slice(at + NODE_MODULES.length));
      const resolved = String(entry.resolved ?? "");
      if (entry.link === true) {
        judge(token, name, resolved, "", resolved);
      } else if (/^file:/i.test(resolved)) {
        judge(token, name, resolved, "", resolved.slice("file:".length));
      }
    }
    return out;
  }
  // lockfileVersion 1: a nested tree, walked like npmV1Packages.
  const stack = [data.dependencies];
  while (stack.length) {
    for (const [name, node] of Object.entries(stack.pop() ?? {})) {
      if (!node || typeof node !== "object") {
        continue;
      }
      const version = String(node.version ?? "");
      if (/^file:/i.test(version)) {
        judge(name, name, version, "", version.slice("file:".length));
      }
      if (node.dependencies) {
        stack.push(node.dependencies);
      }
    }
  }
  return out;
}

/**
 * Resolve `target` (a local path the lock records) against `baseDir` (the store-relative
 * folder it is relative to, "" for the root) into a store-relative posix path, or null when
 * it steps outside the store (a leading "/", or a ".." with nothing left to pop). Pure path
 * arithmetic: it does not say whether anything is THERE.
 * @param {string} baseDir @param {string} target
 * @returns {?string}
 */
function resolveLocalDir(baseDir, target) {
  const t = target.trim();
  if (!t || t.startsWith("/")) {
    return null;
  }
  const parts = [];
  for (const seg of (baseDir ? `${baseDir}/${t}` : t).split("/")) {
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      if (parts.length === 0) {
        return null; // escapes the store root
      }
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join("/"); // "" only when this names the store root itself
}

/**
 * Where a pnpm `packages` entry installs from: its `resolution.tarball` when it records
 * one, a git `repo` when it is a git install, and the registry otherwise (a registry
 * entry carries only an integrity).
 * @param {object} entry
 * @returns {"registry"|"github"|"local"|"foreign"}
 */
function pnpmSource(entry) {
  const resolution = entry?.resolution ?? {};
  if (resolution.tarball !== undefined) {
    return installSource(resolution.tarball);
  }
  if (resolution.type === "git" || resolution.repo !== undefined) {
    return isGithubSource(String(resolution.repo ?? "")) ? "github" : "foreign";
  }
  if (resolution.type === "directory") {
    return "local";
  }
  return "registry";
}

/**
 * Why the governing lock cannot be read, or null when it can (or there is none). The
 * dependency audit reads the installed tree out of this file (lockedPackages), so a lock it
 * cannot read would leave that audit seeing nothing - and a review saying nothing is not a
 * review saying the tree is clean. Whether the lock matches package.json is not asked here:
 * that is the package manager's own question, which `npm ci` and
 * `pnpm install --frozen-lockfile` answer when the build installs. Read by the
 * sca-lock-file-invalid check.
 *
 * `unreadable`: the file does not parse. `unrecognised`: it parses but is not a lock the
 * readers here know - which matters only when the package file declares something to
 * install from it (`npm ci` accepts a `{}` lock for a package file that declares nothing).
 * @param {Addon} addon  The SCA archive (the root package.json and its locks).
 * @returns {?{file: string, reason: string}}
 */
export function unreadableLock(addon) {
  const file = governingLock(addon);
  if (!file) {
    return null; // no lock at all is sca-lock-file-missing's question, not this one
  }
  const data = parsedLock(addon, file);
  if (!data) {
    return { file, reason: "unreadable" };
  }
  const declares = declaredDependencies(
    readPackageFile(submissionFiles(addon))
  ).length;
  if (declares && !READERS.get(file)?.(data)) {
    return { file, reason: "unrecognised" };
  }
  return null;
}

/**
 * Whether a value is a plain JSON/YAML object - the only shape a lock's maps may take.
 * An array is excluded: reading one by key answers undefined for every name.
 * @param {unknown} value
 * @returns {boolean}
 */
function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Whether a parsed file is the lock its name says, per lock - keyed by NAME rather than
 * chosen by extension, so a fourth format added to TREE_LOCKS is not recognised until it is
 * given one. A lock is recognised by the root record npm and pnpm always write: npm's
 * `packages[""]` or a v1 `dependencies` tree, pnpm's `importers["."]` or its flat top
 * level. Anything else (a YAML file that is not a pnpm lock, a lock whose root record is
 * missing) is not a lock the readers here can read.
 */
const READERS = new Map([
  ["npm-shrinkwrap.json", recognisesNpm],
  ["package-lock.json", recognisesNpm],
  ["pnpm-lock.yaml", recognisesPnpm],
]);

/**
 * @param {unknown} data  Parsed lock.
 * @returns {boolean}  Whether it is an npm lock.
 */
function recognisesNpm(data) {
  if (!plainObject(data)) {
    return false;
  }
  // lockfileVersion 2/3 restates the root package file under "". npm always writes it, so a
  // `packages` map without one is not an npm lock.
  if (plainObject(data.packages)) {
    return plainObject(data.packages[""]);
  }
  // lockfileVersion 1: the hoisted tree, and nothing else to go on.
  return plainObject(data.dependencies);
}

/**
 * @param {unknown} data  Parsed lock.
 * @returns {boolean}  Whether it is a pnpm lock.
 */
function recognisesPnpm(data) {
  if (!plainObject(data)) {
    return false;
  }
  // v6+ and every v9: the importers ARE the package files restated, and pnpm always writes the
  // root one. With importers present but no ".", the root package file is not in the file.
  if (plainObject(data.importers)) {
    return plainObject(data.importers["."]);
  }
  // v5 and the flat v6 shape: the declaration maps sit at the top level, beside specifiers.
  return (
    DECLARATION_MAPS.some((m) => plainObject(data[m])) ||
    plainObject(data.specifiers)
  );
}

/**
 * Order two strings by code point. Not localeCompare: that reorders names by the
 * reviewing machine's locale, so the same lock would enumerate differently on two
 * machines.
 * @param {string} a @param {string} b
 * @returns {number}
 */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Strip a pnpm/berry version suffix (a peer-deps "(...)" tail) down to the bare
 * semver.
 * @param {string} version
 * @returns {string}
 */
function cleanVersion(version) {
  return cutAtFirst(version, "(").trim();
}
