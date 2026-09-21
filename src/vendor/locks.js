// Reads the project's lock file, for two questions. (1) Which exact version did
// a package.json range (e.g. "^3.10.0") actually install - lockedVersion, so a
// declared dependency can still be pinned and audited. (2) What does the whole
// installed tree contain - lockedPackages, which enumerates every package the
// lock records, declared or pulled in by another package, so the OSV audit can
// reach the ~90% of the tree nobody declares. Reads whichever lock the
// submission ships: npm (package-lock.json / npm-shrinkwrap.json, JSON), pnpm
// (pnpm-lock.yaml, YAML), or - for lockedVersion only - yarn (yarn.lock, v1's
// custom format or berry's YAML).
//
// Belongs here: lockedVersion(addon, name), lockedPackages(addon), and the
// per-format readers. Does NOT belong here: reading package.json itself or
// deciding pinned/unpinned (-> src/vendor/resolve.js), and the verification that
// follows (-> verify.js).

import YAML from "yaml";

import { VENDOR_LOCK_MAX_PACKAGES } from "../config.js";

/** @typedef {import("../addon/load.js").Addon} Addon */
/**
 * @typedef {object} LockedPackage  One package the lock file records as
 * installed, whether the submission declares it or another package pulls it in.
 * @property {string} name  npm package name (an npm alias resolves to the real one).
 * @property {string} version  The exact installed version.
 * @property {boolean} dev  Installed for the build only, never for production.
 * @property {boolean} direct  Declared by a manifest in this submission - the root
 *   package.json, a workspace member, or a pnpm importer - rather than reached only
 *   through another package. Read from the lock's OWN record of what was asked for,
 *   so it covers the declaration forms the root package.json parse does not
 *   (optionalDependencies, a workspace member's own manifest) and stays true when
 *   package.json and the lock disagree about a version.
 * @property {string} file  The lock file it was read from (the finding's anchor).
 * @property {string} token  The string locating its entry in `file`.
 */

// The lock files that record a whole tree, in the order they are consulted. Only
// the first one that yields anything is enumerated - merging two would report the
// same tree twice.
const TREE_LOCKS = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
];

// A concrete released version. Anything else in a `version` field (a git ref, a
// "file:" path, a workspace alias) names something that is not a registry
// release, so auditing it under that name would fabricate a hit.
const NUMERIC_VERSION = /^\d+\.\d+/;

// A `resolved` pointing somewhere other than the registry - same reasoning.
const NON_REGISTRY_RESOLVED = /^(?:git\+|file:|link:)/i;

// The dependency maps a manifest declares. optionalDependencies is included
// deliberately: npm installs it, so it is in the tree, and calling something the
// developer wrote down "a package this add-on does not declare" would be false.
const DECLARATION_MAPS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
];

// A pnpm `packages:` key, across every format pnpm has used: v5 "/name/version",
// v6-v8 "/name@version(peers)" and v9 "name@version".
const PNPM_KEY_RE = /^\/?(@?[^@/]+(?:\/[^@/]+)?)[@/]([0-9][^()/]*)/;

// Parsed lock files, per add-on, per file. Both questions above read the same
// lock, and classifyDeps asks the first one once per unpinned dependency, so the
// parse is memoized rather than repeated. Keyed weakly: the cache dies with the
// add-on it describes.
/** @type {WeakMap<Addon, Map<string, ?object>>} */
const parseCache = new WeakMap();

/**
 * One lock file's parsed contents, or null when it is absent or unparseable.
 * Covers the JSON and YAML locks; yarn v1 is a line-based format of its own and
 * is read as text by yarnLock.
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
  const text = addon.files?.get(file)?.toString("utf8");
  let data = null;
  try {
    if (text) {
      data = file.endsWith(".json") ? JSON.parse(text) : YAML.parse(text);
    }
  } catch {
    data = null;
  }
  byFile.set(file, data);
  return data;
}

/**
 * The exact version a lock file pins `name` to, or null if no lock present
 * resolves it. Tries npm, then pnpm, then yarn.
 *
 * Deliberately NOT rebuilt on lockedPackages: this consults the HOISTED
 * top-level entry only, so a nested copy of a package cannot pin a declared
 * range to a version the build does not use for it.
 * @param {Addon} addon
 * @param {string} name  The npm package name (may be scoped, "@scope/pkg").
 * @returns {?string}
 */
export function lockedVersion(addon, name) {
  if (!addon?.files) {
    return null;
  }
  return (
    npmLock(
      parsedLock(addon, "package-lock.json") ??
        parsedLock(addon, "npm-shrinkwrap.json"),
      name
    ) ??
    pnpmLock(parsedLock(addon, "pnpm-lock.yaml"), name) ??
    yarnLock(addon.files.get("yarn.lock")?.toString("utf8"), name)
  );
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
  return data?.dependencies?.[name]?.version ?? null;
}

/**
 * @param {?object} data  Parsed pnpm-lock.yaml.
 * @param {string} name
 * @returns {?string}
 */
function pnpmLock(data, name) {
  const root = data?.importers?.["."] ?? data;
  const entry = root?.dependencies?.[name] ?? root?.devDependencies?.[name];
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
 * @param {?string} text  yarn.lock contents (v1 custom format or berry YAML).
 * @param {string} name
 * @returns {?string}
 */
function yarnLock(text, name) {
  if (!text) {
    return null;
  }
  // Berry (v2+) is YAML with a __metadata key.
  if (/^__metadata:/m.test(text)) {
    try {
      const data = YAML.parse(text);
      for (const [key, value] of Object.entries(data ?? {})) {
        if (
          key !== "__metadata" &&
          keyNamesPackage(key, name) &&
          value?.version
        ) {
          return cleanVersion(String(value.version));
        }
      }
    } catch {
      return null;
    }
    return null;
  }
  // Yarn v1: top-level "<keys>:" header lines, then an indented `version "x"`.
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      !line ||
      line.startsWith("#") ||
      /^\s/.test(line) ||
      !line.endsWith(":")
    ) {
      continue;
    }
    const matches = line
      .slice(0, -1)
      .split(",")
      .some((k) => keyNamesPackage(k.trim().replace(/^"|"$/g, ""), name));
    for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]); j++) {
      const v = lines[j].match(/^\s+version:?\s+"?([^"\s]+)"?/);
      if (matches && v) {
        return cleanVersion(v[1]);
      }
    }
  }
  return null;
}

/**
 * Every package the submission's lock file records as installed - the declared
 * dependencies AND everything they pull in, at whatever depth. The set the OSV
 * tree audit queries (src/vendor/verify.js auditLockedPackages).
 *
 * Only the first lock that yields entries is read, in npm-then-pnpm order: two
 * locks describe the same install, so enumerating both would report every
 * package twice.
 *
 * Yarn is deliberately absent. A committed yarn.lock is already a hard error
 * from unsupported-build-tool, so nothing is built from one, and neither yarn
 * format records whether a package is dev-only - every hit would land in the
 * shipped bucket claiming to be shipped.
 * @param {Addon} addon
 * @returns {LockedPackage[]}  Sorted by name, then version, and truncated at
 *   VENDOR_LOCK_MAX_PACKAGES - which sits well above any real tree, because a
 *   package dropped here is simply never audited.
 */
export function lockedPackages(addon) {
  if (!addon?.files) {
    return [];
  }
  for (const file of TREE_LOCKS) {
    const data = parsedLock(addon, file);
    if (!data) {
      continue;
    }
    const found = file.endsWith(".json")
      ? npmPackages(data, file)
      : pnpmPackages(data, file);
    if (found.length) {
      return dedupe(found);
    }
  }
  return [];
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
  const marker = "node_modules/";
  // What the submission's own manifests ask for. An entry with no node_modules
  // segment IS one of those manifests - the project root under "", a workspace
  // member under its path - so its dependency maps are declarations, not installs.
  const direct = new Set();
  for (const [key, entry] of Object.entries(packages)) {
    if (key.includes(marker) || !entry || typeof entry !== "object") {
      continue;
    }
    for (const map of DECLARATION_MAPS) {
      for (const [name, spec] of Object.entries(entry[map] ?? {})) {
        direct.add(declaredName(name, spec));
      }
    }
  }
  for (const [key, entry] of Object.entries(packages)) {
    const at = key.lastIndexOf(marker);
    if (at === -1 || !entry || typeof entry !== "object") {
      continue;
    }
    if (entry.link === true) {
      continue; // a symlink to a workspace member, recorded under its own key
    }
    const version = String(entry.version ?? "");
    if (
      !NUMERIC_VERSION.test(version) ||
      NON_REGISTRY_RESOLVED.test(String(entry.resolved ?? ""))
    ) {
      continue;
    }
    // `name` is present when the installed package differs from its directory,
    // which is how npm records an alias - the real package is what to audit.
    const name = String(entry.name ?? key.slice(at + marker.length));
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
 * lockfileVersion 1: a nested tree, each node carrying its own `dependencies`.
 *
 * Walked with an explicit stack rather than by recursion: the nesting depth is
 * whatever the submitted file says, and a lock nested a few thousand deep - a
 * couple of hundred KB to write - would otherwise exhaust the call stack and
 * abort the whole review.
 *
 * v1 keeps no record of which packages the project asked for (the top level is
 * the hoisted tree, not a manifest), so nothing here is marked direct; the root
 * package.json names still reach the audit through resolveVendor.
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
        !NON_REGISTRY_RESOLVED.test(String(node.resolved ?? ""))
      ) {
        out.push({
          name,
          version,
          dev: node.dev === true,
          direct: false,
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
  // The importers ARE the submission's manifests, restated by pnpm - so what they
  // ask for is what it declares.
  const direct = new Set();
  for (const importer of Object.values(data.importers ?? {})) {
    for (const map of DECLARATION_MAPS) {
      for (const [name, spec] of Object.entries(importer?.[map] ?? {})) {
        direct.add(declaredName(name, spec));
      }
    }
  }
  const out = [];
  for (const [key, entry] of Object.entries(packages)) {
    const m = key.match(PNPM_KEY_RE);
    if (!m) {
      continue;
    }
    const name = m[1];
    const version = cleanVersion(m[2]);
    if (!NUMERIC_VERSION.test(version)) {
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
 * manifest asking for it by name is enough to make it declared).
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
  const alias = /^npm:(@?[^@/]+(?:\/[^@/]+)?)(?:@|$)/.exec(written);
  return alias ? alias[1] : name;
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
 * Whether a yarn lock key (e.g. `name@^1.0.0` or `name@npm:^1.0.0`) is for
 * package `name`.
 * @param {string} key @param {string} name
 * @returns {boolean}
 */
function keyNamesPackage(key, name) {
  return key.startsWith(`${name}@`);
}

/**
 * Strip a pnpm/berry version suffix (a peer-deps "(...)" tail) down to the bare
 * semver.
 * @param {string} version
 * @returns {string}
 */
function cleanVersion(version) {
  return version.replace(/\(.*$/, "").trim();
}
