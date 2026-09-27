// Reads the project's lock file, for three questions. (1) Which exact version did
// a package.json range (e.g. "^3.10.0") actually install - lockedVersion, so a
// declared dependency can still be pinned and audited. (2) What does the whole
// installed tree contain - lockedPackages, which enumerates every package the
// lock records, declared or pulled in by another package, so the OSV audit can
// reach the ~90% of the tree nobody declares. (3) Can the lock install what the
// package file declares at all - lockGaps, which is what `npm ci` and
// `pnpm install --frozen-lockfile` refuse over. Reads whichever lock the
// submission ships - npm (package-lock.json / npm-shrinkwrap.json, JSON) or pnpm
// (pnpm-lock.yaml, YAML), the two supported package managers.
//
// ONE GOVERNING LOCK. All three readers below ask governingLock which file the submission
// installs from, so a submission cannot be rejected over one lock while a version is pinned
// and a whole tree audited out of another - which is what happened while each picked for
// itself (first present / first that resolves / first that yields).
//
// Belongs here: lockedVersion(addon, name), lockedPackages(addon), lockGaps(addon),
// governingLock, and the per-format readers. lockGaps is a comparison, so it needs both sides, but only this
// one is its own: what the package file DECLARES comes from ./package-file.js, and every lock-side
// detail the comparison turns on (the npm root record, the pnpm importers, the v1/v3
// split) is here and private. Does NOT belong here: reading or shaping package.json
// (-> ./package-file.js), deciding pinned/unpinned (-> ./resolve.js), and the verification
// that follows (-> ./verify.js).

import YAML from "yaml";
import semver from "semver";

import { VENDOR_LOCK_MAX_PACKAGES } from "../config.js";
import { stripBom } from "../util/json.js";
import { parseJson } from "../util/json.js";

import {
  DECLARATION_MAPS,
  aliasTarget,
  declaredDependencies,
  readPackageFile,
  submissionFiles,
  ownValue,
  resolveLocalPackageFiles,
  PACKAGE_FILE,
} from "./package-file.js";
import { rethrowIfFatal } from "../lib/errors.js";

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
 *   package.json and the lock disagree about a version.
 * @property {string} file  The lock file it was read from (the finding's anchor).
 * @property {string} token  The string locating its entry in `file`.
 */
/**
 * @typedef {object} LockGap  One way the committed lock cannot install what the root
 * package.json declares.
 * @property {string} file  The finding's anchor, which is the file the failing value sits
 *   in: the LOCK for `unsatisfied` (the version it pins) and when the lock cannot be read
 *   at all, the declaring package file for every other declaration gap - the root
 *   package.json, or a nested one reached by a file:/link: walk (SCA mode only).
 * @property {?string} name  The declared package, or null for an unreadable lock.
 * @property {?string} spec  What package.json asks for it, or null (same).
 * @property {?string} recorded  The spec the lock's root record restates - where its pin
 *   came from, not a verdict on it. Null outside `unsatisfied` / `stale`.
 * @property {?string} installed  The version the lock pins, for `unsatisfied`; else null.
 * @property {?string} token  Locates the pinned entry inside the lock, for `unsatisfied`.
 * @property {string} reason  About one declaration: `absent` (the lock resolves nothing for
 *   it), `unsatisfied` (npm: the pinned version does not satisfy the declared range) or
 *   `stale` (pnpm: the recorded specifier is not the declared one, which is what
 *   --frozen-lockfile compares). About the FILE: `unreadable` (it does not parse) or
 *   `unrecognised` (it parses but is not a lock this comparison can read).
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
 * ONE selection, shared by all three readers here, so a submission cannot be rejected over
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
  const files = submissionFiles(addon);
  return TREE_LOCKS.find((file) => files?.has(file)) ?? null;
}

// A concrete released version. Anything else in a `version` field (a git ref, a
// "file:" path, a workspace alias) names something that is not a registry
// release, so auditing it under that name would fabricate a hit.
const NUMERIC_VERSION = /^\d+\.\d+/;

// A `resolved` pointing somewhere other than the registry - same reasoning.
const NON_REGISTRY_RESOLVED = /^(?:git\+|file:|link:)/i;

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
 * The exact version a lock file pins `name` to, or null if no lock present
 * resolves it. Tries npm, then pnpm.
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
  const marker = "node_modules/";
  // What the submission's own package files ask for. An entry with no node_modules
  // segment IS one of those package files - the project root under "", a workspace
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
 * the hoisted tree, not a package file), so nothing here is marked direct; the root
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
  // The importers ARE the submission's package files, restated by pnpm - so what they
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
 * Every way the committed lock cannot install what the root package.json declares - what
 * `npm ci` and `pnpm install --frozen-lockfile` refuse over, decided offline from the two
 * files alone - PLUS every package file a file:/link: chain reaches from the root
 * (resolveLocalPackageFiles): `npm ci` installs a locally-linked package's own declared
 * dependencies from the same ONE governing lock, so they are held to the same question.
 * Read by the sca-lock-file-invalid check.
 *
 * Returns nothing when the package file declares nothing this lock could pin, or when there is
 * no lock at all - the latter being sca-lock-file-missing's question, which also decides
 * whether one was owed. Both come first: a lock that governs no declaration is not judged,
 * whatever shape it is in, because every verdict here is about a declaration it fails.
 * Only the first lock PRESENT governs, in TREE_LOCKS order - two locks describe one
 * install, and the installer reads the one it prefers rather than the one that happens to
 * work. When that lock does not parse it is reported alone: a lock that cannot be read
 * refuses the install as flatly as one missing an entry, and nothing falls through to
 * another sitting beside it.
 * @param {Addon} addon  The SCA archive (the root package.json and its locks).
 * @returns {LockGap[]}
 */
export function lockGaps(addon) {
  const files = submissionFiles(addon);
  if (!files) {
    return [];
  }
  const pkg = readPackageFile(files);
  if (!pkg) {
    return []; // no readable package file: nothing states what the lock should cover
  }
  // Not a registry spec (file:/link:/workspace:/git/GitHub). The lock records these in
  // shapes a spec comparison cannot read, and whether such a source is allowed at all is
  // unsupported-dependency's question, not this one.
  //
  // An `npm:` alias is KEPT. It installs a registry package, and both formats record it the
  // way they record any other: keyed by the name it is WRITTEN under, with the spec stored
  // verbatim. So the comparison reads it without having to know it is an alias, and `npm
  // ci` and `pnpm install --frozen-lockfile` refuse over a missing or stale one exactly as
  // they do for the rest - which is the question this check answers.
  const nonRegistry = ({ spec }) =>
    !/[:/]/.test(spec) || Boolean(aliasTarget(spec));
  const declared = declaredDependencies(pkg)
    .filter(nonRegistry)
    .map((d) => ({ ...d, packageFile: PACKAGE_FILE, rootKey: "" }));
  // Every package file a file:/link: chain reaches (SCA mode only - resolveLocalPackageFiles
  // itself is a no-op with no lock/store to read from otherwise) declares real external
  // dependencies too, `npm ci` installs them from the same ONE governing lock the root
  // does, and they are held to the same "can the lock install this" question - see the
  // rootKey handling in npmGap/pnpmGap below for how a NESTED package file's declaration is
  // compared, which is not the same lookup as the root's.
  const { packageFiles } = resolveLocalPackageFiles(addon);
  for (const m of packageFiles) {
    for (const d of declaredDependencies(m.pkg).filter(nonRegistry)) {
      declared.push({ ...d, packageFile: m.file, rootKey: m.dir });
    }
  }
  const file = governingLock(addon);
  if (!file) {
    return []; // no lock at all is sca-lock-file-missing's question, not this one
  }
  // A governing lock that does not parse is where the install stops (-> governingLock).
  //
  // Asked BEFORE what the package file declares, because whether the file can be read at all
  // does not depend on there being anything to compare it against. `npm ci` opens the lock
  // whatever the package file holds and refuses on one it cannot parse - measured, with and
  // without declarations - so deciding "nothing is declared, so the shape does not matter"
  // first would clear exactly that submission, and reward committing a corrupt lock over
  // committing none, since the missing-lock check sees the file by NAME and falls silent.
  const data = parsedLock(addon, file);
  if (!data) {
    return [lockItself(file, "unreadable")];
  }
  // Being UNREADABLE and being the wrong SHAPE part company here, which is why the two
  // faults are not asked together. `npm ci` accepts a `{}` lock for a package file that
  // declares nothing (measured: "up to date") and refuses the same file the moment one
  // dependency is declared. So a shapeless lock is only a fault when something has to be
  // installed from it, while an unparseable one is a fault either way.
  if (!declared.length) {
    return []; // nothing is declared, so a readable lock governs nothing
  }
  const reader = READERS.get(file);
  // A lock we cannot interpret says nothing about the declarations, so it is reported as
  // ITSELF rather than judged through. Guessing the other way is the loudest possible
  // wrong answer: every declared package would come back "not recorded", rejecting a
  // submission on the strength of a file nothing here understood.
  if (!reader?.recognises(data)) {
    return [lockItself(file, "unrecognised")];
  }
  const gaps = [];
  // What npm INSTALLS for a declaration: its own spec normally, an `npm:` alias's target
  // range where the two differ. Collected per NAME because that is how npm compares - one
  // resolved node answering every declaration of it - while pnpm keys by map and judges
  // each declaration on its own.
  const rangesFor = new Map();
  for (const { name, spec, installs } of declared) {
    rangesFor.set(name, [
      ...(rangesFor.get(name) ?? []),
      installs?.spec ?? spec,
    ]);
  }
  const reported = new Set();
  for (const { map, name, spec, packageFile, rootKey } of declared) {
    const gap = reader.gap(
      data,
      map,
      name,
      spec,
      rangesFor.get(name),
      addon,
      rootKey
    );
    // The npm reader answers about the ONE resolved node, so a package declared in two
    // maps must not be reported twice for it.
    if (gap?.reason === "unsatisfied" && reported.has(name)) {
      continue;
    }
    if (gap) {
      reported.add(name);
      // An `unsatisfied` gap is about the version the LOCK pins, so it is reported there,
      // at that entry - the way a tree vulnerability is (src/lib/vuln-findings.js). Every
      // other reason is about the declaration, which lives in the declaring package file.
      const at = gap.reason === "unsatisfied" ? file : packageFile;
      gaps.push({ file: at, name, spec, ...gap });
    }
  }
  return gaps;
}

/**
 * Whether `installed` satisfies any of `ranges` - the one comparison both npmGap's precise
 * path and its flat fallback make, once each has its own idea of `recorded` (what the
 * declaration is compared against, kept only to say WHERE the pin came from) and
 * `reason` (`unsatisfied` for a real restated spec, `stale` for the fallback, which cannot
 * tell a stale pin from a genuinely undeclared one - see npmGap).
 *
 * A range this cannot read - a dist-tag, anything exotic - says nothing at all. This check
 * halts a review, so an undecidable case has to be silent rather than a guess. Satisfied by
 * ANY range declared for this name, not each in turn: npm resolves one node per name and
 * lets a second declaration win (measured: `dependencies: ^3.0.1` beside `devDependencies:
 * ^2.0.0` installs 2.0.0 and `npm ci` accepts it), so holding the pin to every declaration
 * separately rejects a lock npm is happy with.
 * @param {string} installed @param {string[]} ranges
 * @param {string} recorded @param {string} token @param {string} reason
 * @returns {?{recorded: string, installed: string, token: string, reason: string}}
 */
function satisfiesGap(installed, ranges, recorded, token, reason) {
  const readable = ranges.filter((r) => semver.validRange(r));
  if (!readable.length || !semver.valid(installed)) {
    return null;
  }
  return readable.some((r) => semver.satisfies(installed, r))
    ? null
    : { recorded, installed, token, reason };
}

/**
 * One declaration against an npm lock. lockfileVersion 2/3 restates EVERY local package file's
 * own declarations this way - the root under `packages[""]`, and (per the real submission
 * this was verified against) a file:/link:-linked package under `packages[<its own
 * relative path>]`, the same path resolveLocalPackageFiles already computes for it. `rootKey`
 * says which: `""` for the root, a nested package file's own `dir` otherwise. The installed
 * entry is checked too, since a restated record naming a package that resolved to nothing
 * installs nothing.
 *
 * A restated record is expected at `rootKey` whenever this reader was chosen at all (the
 * true root's is required by recognisesNpm) - EXCEPT that this feature's own path
 * arithmetic could in principle diverge from the lock's own key for a nested package file (an
 * unverified edge case). When no record sits at `rootKey`, this falls back to the flat,
 * hoisted, name-only lookup `lockedVersion`/`npmLock` already trust for pinning: it cannot
 * distinguish a stale pin from a genuinely undeclared one (both come back "stale"/"absent"
 * from the SAME flat fact), but it does not silently pass an uninstallable declaration.
 *
 * lockfileVersion 1 carries no restatement at all (its top level is the hoisted tree), for
 * root or nested alike - no `stale`/`unsatisfied` verdict rather than a guessed one.
 * @param {object} data  Parsed lock. @param {string} map  The declaring dependency map.
 * @param {string} name @param {string} spec  What package.json asks for.
 * @param {string[]} ranges @param {Addon} addon  For the flat-fallback lookup.
 * @param {string} [rootKey]  `""` for the root, else a nested package file's own `dir`.
 * @returns {?{recorded: ?string, reason: string}}
 */
function npmGap(data, map, name, spec, ranges, addon, rootKey = "") {
  // A recorded entry only covers a declaration if the install can read a VERSION out of it.
  // lockedVersion reads that same field, so requiring it here is what keeps the two from
  // disagreeing about one declaration. They must agree because both modes consult a lock:
  // calling a declaration covered here while failing to pin it there would leave it named
  // by no gap and pinned by no version - reported as neither, and audited as nothing.
  if (!plainObject(data.packages)) {
    // lockfileVersion 1: the hoisted tree is all there is to go on. It restates no ranges,
    // so there is nothing to satisfy and presence is the whole test.
    return ownValue(data.dependencies, name)?.version
      ? null
      : { recorded: null, reason: "absent" };
  }
  const root = data.packages[rootKey];
  if (!plainObject(root)) {
    // No restated record at this path - see the doc comment above. Falls back to the flat
    // lookup rather than reporting every correctly-installed nested dependency "absent".
    const installed = lockedVersion(addon, name);
    if (!installed) {
      return { recorded: null, reason: "absent" };
    }
    const token = `node_modules/${name}`;
    return satisfiesGap(installed, ranges, installed, token, "stale");
  }
  // Across ALL the record's maps, not the declaring one: `npm ci` compares the two
  // package files by NAME, so moving a package between dependencies and devDependencies
  // without regenerating is an install it accepts. pnpm is stricter, which is why its
  // reader keys by map.
  let recorded;
  for (const m of DECLARATION_MAPS) {
    const found = ownValue(root?.[m], name);
    if (found !== undefined) {
      recorded = found;
      break;
    }
  }
  if (recorded === undefined) {
    return { recorded: null, reason: "absent" }; // npm: "Missing: X from lock file"
  }
  const token = `node_modules/${name}`;
  const installed = ownValue(data.packages, token)?.version;
  if (!installed) {
    return { recorded: null, reason: "absent" };
  }
  // npm's OWN question, and the only one worth asking: does the version this lock pins
  // satisfy the range the package file declares? The restated record mirrors it as it
  // stood when the lock was written, so comparing the two SPECS answers a different
  // question and gets it wrong both ways - "3.0.1" against a recorded "^3.0.1" is the same
  // install (npm: "added 2 packages") while the strings differ, and "^3.0.0" against a
  // recorded ">=2.0.0" is two overlapping ranges while the pinned 6.0.0 satisfies neither
  // the declaration nor npm (npm: "Invalid: lock file's chalk@6.0.0 does not satisfy
  // chalk@3.0.0").
  return satisfiesGap(
    installed,
    ranges,
    String(recorded).trim(),
    token,
    "unsatisfied"
  );
}

/**
 * One declaration against a pnpm lock. The importers ARE the package files restated - one per
 * workspace-relative path, `"."` being the root's own - and the recorded specifier is what
 * `--frozen-lockfile` compares against. `rootKey` picks which: `""` (the default, mapped to
 * the `"."` importer below) for the root, a nested package file's own `dir` otherwise. v6+
 * carries the specifier on the entry; v5 keeps a separate `specifiers` map, per importer
 * when the lock has importers and at the top level when it does not - so a string entry
 * looks in both, nearest first.
 *
 * When no importer sits at the resolved path (expected for the root only in the flat v5/v6
 * shape that carries no `importers` map at all, where the whole lock stands in for it - and,
 * unverified against a real pnpm lockfile, possibly for a nested `file:`-linked package that
 * is not a declared pnpm workspace member), this falls back to presence alone via the same
 * flat, hoisted lookup pinning trusts. Unlike npmGap's fallback this cannot even approximate
 * `stale`: this reader's comparison is textual (the recorded SPECIFIER against the declared
 * one), and there is no restated specifier to compare without a record - so the fallback is
 * silent on staleness rather than a guessed one, `absent` only when the lock does not
 * install this name at all.
 * @param {object} data  Parsed lock. @param {string} map  The declaring dependency map.
 * @param {string} name @param {string} spec  What package.json asks for.
 * @param {string[]} _ranges  Unused - see the comment on the textual comparison.
 * @param {Addon} addon  For the flat-fallback lookup.
 * @param {string} [rootKey]  `""` for the root, else a nested package file's own `dir`.
 * @returns {?{recorded: ?string, reason: string}}
 */
function pnpmGap(data, map, name, spec, _ranges, addon, rootKey = "") {
  // Textual, deliberately, and NOT the semantic comparison npmGap makes: `pnpm install
  // --frozen-lockfile` compares the recorded specifier to the declared one as text and
  // refuses on any difference (ERR_PNPM_OUTDATED_LOCKFILE, "specifiers in the lockfile
  // don't match"). So the range plays no part here.
  const importers = plainObject(data.importers) ? data.importers : null;
  const importer =
    rootKey === "" ? (importers?.["."] ?? data) : importers?.[rootKey];
  if (!plainObject(importer)) {
    return lockedVersion(addon, name)
      ? null
      : { recorded: null, reason: "absent" };
  }
  const entry = ownValue(importer?.[map], name);
  if (entry === undefined) {
    return { recorded: null, reason: "absent" };
  }
  const recorded =
    typeof entry === "string"
      ? (ownValue(importer?.specifiers, name) ??
        ownValue(data?.specifiers, name))
      : entry?.specifier;
  if (recorded !== undefined && String(recorded).trim() !== spec) {
    return { recorded: String(recorded).trim(), reason: "stale" };
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
 * The reader for each lock, keyed by NAME rather than chosen by extension. Dispatching on
 * ".json or else pnpm" reads as "npm or pnpm" but says "JSON, or else ASSUME pnpm", which
 * is true only while pnpm's is the one non-JSON entry: a fourth format added to TREE_LOCKS
 * would inherit pnpm's reader silently and report every declaration missing. Keyed here, a
 * new lock has to be given a reader or it is not recognised at all.
 *
 * `recognises` is what keeps a guess from becoming a verdict. It asks whether the file is
 * this format AND carries the restated package file the comparison needs - npm's `packages[""]`
 * or a v1 `dependencies` tree, pnpm's `importers["."]` or its flat top level. Anything else
 * (a YAML file that is not a pnpm lock, a lock whose root record is missing) is declined
 * rather than judged through.
 */
const READERS = new Map([
  ["npm-shrinkwrap.json", { recognises: recognisesNpm, gap: npmGap }],
  ["package-lock.json", { recognises: recognisesNpm, gap: npmGap }],
  ["pnpm-lock.yaml", { recognises: recognisesPnpm, gap: pnpmGap }],
]);

/**
 * @param {unknown} data  Parsed lock.
 * @returns {boolean}  Whether it is an npm lock this comparison can read.
 */
function recognisesNpm(data) {
  if (!plainObject(data)) {
    return false;
  }
  // lockfileVersion 2/3 restates the root package file under "". npm always writes it, so a
  // `packages` map without one is not a lock we can compare against.
  if (plainObject(data.packages)) {
    return plainObject(data.packages[""]);
  }
  // lockfileVersion 1: the hoisted tree, and nothing else to go on.
  return plainObject(data.dependencies);
}

/**
 * @param {unknown} data  Parsed lock.
 * @returns {boolean}  Whether it is a pnpm lock this comparison can read.
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
 * A gap about the lock FILE rather than about a declaration: it names no package, because
 * the subject is the file we could not use.
 * @param {string} file @param {string} reason
 * @returns {LockGap}
 */
function lockItself(file, reason) {
  return { file, name: null, spec: null, recorded: null, reason };
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
  return version.replace(/\(.*$/, "").trim();
}
