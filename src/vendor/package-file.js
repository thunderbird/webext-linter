// Reads the submission's package.json through ONE implementation, into a shape every
// dependency reader can use. Each of them asks a question of the same file - resolveVendor
// (classifying each declaration), lockGaps (what the lock fails to cover),
// sca-lock-file-missing (whether a lock was owed) and sca-package-file-invalid (whether the
// package file can be used at all) - and one parse answers for all of them. A parse per reader is a copy of these tolerances per
// reader, and a submission shaped in a way one copy mishandles is mishandled by that one
// alone, silently: a package file that fails to parse reads as an absent one, and
// "declares nothing" is every caller's empty case. One implementation, not one call: each
// reader still parses when it asks.
//
// A submission's package file is UNTRUSTED input, not a data structure: it is whatever bytes
// the developer packed. So nothing here trusts a shape. A file that is not a JSON object,
// a dependency map that is not an object, a version spec that is not a string - each is
// absent rather than coerced, because coercing invented findings that named `0 (l)` as a
// package.
//
// Belongs here: turning those bytes into a package.json object and a normalized list of what it
// declares. Does NOT belong here: what a declaration MEANS - pinned, supported, covered by
// the lock - which is resolve.js, locks.js and the checks respectively; and the policy of
// when a lock is owed, which is the check that asks.

import { parseJson } from "../util/json.js";
import { LOCAL_PACKAGE_FILE_MAX_DEPTH } from "../config.js";

/**
 * @typedef {object} DeclaredDependency  One dependency a package file declares.
 * @property {string} map  The map that declared it (a DECLARATION_MAPS member).
 * @property {string} name  The package name, as written.
 * @property {string} spec  Its version spec, trimmed.
 * @property {{name: string, spec: string}} installs  What npm actually installs for it.
 *   The same name and spec for an ordinary declaration, and the TARGET of an
 *   `npm:` alias otherwise. Classify by this, report the written pair.
 */

// The dependency maps a package file declares, in the order they are read.
// optionalDependencies is included deliberately: npm installs it, so it is in the tree and
// the reviewer's install has to resolve it. peerDependencies is not - the host supplies
// those, not this build.
export const DECLARATION_MAPS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
];

/**
 * The key that identifies one declaration within a package file.
 *
 * A name does not: npm accepts the same name in `dependencies`, `devDependencies` and
 * `optionalDependencies` with different specs, and defines a precedence for each pair. The
 * pair DOES, because a map is a JSON object, so a name appears at most once inside one -
 * which is why the spec is not part of it. Built here so the side that records a resolved
 * declaration and the side that asks about one cannot spell it differently.
 * @param {string} map  A DECLARATION_MAPS member.
 * @param {string} name  The package name as declared.
 * @returns {string}
 */
export function declarationKey(map, name) {
  return `${map}\u0000${name}`;
}

// Of those, the ones that declare something the INSTALL runs rather than something the
// add-on ships. An optionalDependency is one of them: npm installs it where the platform
// allows, and what it usually names is a platform-specific binary the build uses, not a
// library that ends up in the package. Read by classifyPackageFile, which judges these on
// what running them costs a reviewer rather than on what a bundled copy would be
// verified against.
export const BUILD_TIME_MAPS = ["devDependencies", "optionalDependencies"];

/**
 * Whether a value is a plain JSON object - the only shape any of the maps here may take.
 * An array is excluded: `Object.entries` walks one happily, yielding index keys that read
 * as package names.
 * @param {unknown} value
 * @returns {boolean}
 */
function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// The submission's package file, by name. Shared so that the checks asking whether it is
// THERE and whether it can be USED cannot come to different answers about which file they
// mean (sca-package-file-missing, sca-package-file-invalid), the way TREE_LOCKS is shared
// for the lock file.
export const PACKAGE_FILE = "package.json";

/**
 * One package.json's bytes, parsed, alongside the fault when they cannot be used. Two
 * questions over one parse, because the readers that ask them want different halves.
 * @param {?Buffer} buf  One package.json's bytes.
 * @returns {{value: ?object, fault: ?string}}
 */
function readBytes(buf) {
  // Absent, empty and malformed all arrive as null from the one parser, and all three are
  // the same fault to a reader: there is no package file to work from.
  const data = parseJson(buf);
  if (data === null) {
    return { value: null, fault: "unreadable" };
  }
  return plainObject(data)
    ? { value: data, fault: null }
    : { value: null, fault: "unrecognised" };
}

/**
 * Why this package.json cannot be used, or null when it can: `unreadable` (it does not
 * parse) or `unrecognised` (it parses but is not a JSON object). The same two words the
 * lock file's file-level faults carry, for the same reason - one will not open, the other
 * opens fine and is simply not the thing it is named for.
 * @param {?Buffer} buf  One package.json's bytes.
 * @returns {?string}
 */
export function packageFileFault(buf) {
  return readBytes(buf).fault;
}

/**
 * A package.json's bytes as an object, or null when they are absent, unreadable, or not a
 * JSON object.
 *
 * Parsed through src/util/json.js, the one parser in src/ - which is what makes a BOM'd
 * package file readable here, since npm reads one perfectly well and `JSON.parse` does not.
 *
 * Module-private: every reader wants the submission's root package file, which readPackageFile
 * below names. This is the half of it that holds the tolerances, kept apart so they are
 * stated once rather than once per caller.
 * @param {?Buffer} buf  One package.json's bytes.
 * @returns {?object}
 */
function parsePackageFile(buf) {
  return readBytes(buf).value;
}

/**
 * The SUBMISSION's own files - the frame a package file and a lock are written in.
 *
 * For a built XPI it is the artifact itself. For a source archive it is the whole
 * --sca-root: `addon.files` there is a VIEW that gives up every manifest.json, so only
 * the store answers what the submission contains. An addon with no separate store (a hand-built file map) answers with its
 * files, which is the same thing for a single-artifact submission.
 * @param {?object} addon
 * @returns {?object}  The Map surface, or undefined.
 */
export function submissionFiles(addon) {
  return addon?.store ?? addon?.files;
}

/**
 * The submission's ROOT package.json, parsed, or null when it is absent, unreadable, or
 * not a JSON object.
 * @param {?Map<string, Buffer>} files  The artifact's files.
 * @returns {?object}
 */
export function readPackageFile(files) {
  return parsePackageFile(files?.get(PACKAGE_FILE));
}

/**
 * Everything the package file declares, across DECLARATION_MAPS, as one flat list.
 *
 * A map that is not an object contributes nothing, and so does a spec that is not a string:
 * npm rejects both outright, so there is no install to reason about, and coercing them
 * produces findings about packages the developer never named.
 * @param {?object} pkg  A package file from readPackageFile.
 * @returns {DeclaredDependency[]}
 */
export function declaredDependencies(pkg) {
  const out = [];
  for (const map of DECLARATION_MAPS) {
    const deps = pkg?.[map];
    if (!plainObject(deps)) {
      continue;
    }
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === "string") {
        const written = spec.trim();
        out.push({
          map,
          name,
          spec: written,
          installs: aliasTarget(written) ?? { name, spec: written },
        });
      }
    }
  }
  return out;
}

/**
 * The package an `npm:<name>@<range>` alias installs, or null when the spec is not one.
 *
 * An alias declares one package under another name, so the name it is WRITTEN under says
 * nothing about what is fetched: `"@typescript/lib-dom": "npm:@types/web@^0.0.353"` is an
 * ordinary public npm package, and reading the spec as an unknown source rejects a
 * submission over its own spelling. The registry is still the source, and the target is
 * still what gets audited, so both questions are answered from here.
 *
 * The range is optional (`npm:@types/web` installs the latest), and an absent one is
 * returned empty rather than guessed - the callers that care read that as "names no single
 * release", which is what it is.
 * @param {string} spec  A version spec, as written.
 * @returns {?{name: string, spec: string}}
 */
export function aliasTarget(spec) {
  const m = /^npm:(@?[^@/]+(?:\/[^@/]+)?)(?:@(.*))?$/.exec(spec ?? "");
  return m ? { name: m[1], spec: m[2] ?? "" } : null;
}

/**
 * Read a property whose KEY came from the submission, OWN properties only.
 *
 * A package name is submission text, and `constructor` and `toString` are real npm
 * packages - so a plain `obj[name]` answers from Object.prototype for those, which is how
 * a lock came to be reported as recording `function Object() { [native code] }`. Every
 * lookup keyed by a declared name goes through here.
 * @param {unknown} obj  The container to read, of any shape.
 * @param {string} key  A name taken from the package file.
 * @returns {unknown}  The value, or undefined when absent or inherited.
 */
export function ownValue(obj, key) {
  return plainObject(obj) && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/** @typedef {object} LocalTarget  One file:/link: declaration that resolves to a real
 * directory inside the submission - whether or not that directory has its own readable
 * package.json (see LocalPackageFile).
 * @property {string} declaringFile  The package.json (store-relative) that declared it -
 *   PACKAGE_FILE for the root, a LocalPackageFile.file otherwise.
 * @property {string} map  The declaration map it was written in (a DECLARATION_MAPS
 *   member). Carried because a NAME does not identify a declaration: npm accepts the same
 *   name in several maps with different specs, so what resolved has to say which one.
 * @property {string} name  The name it was declared under.
 * @property {string} dir  The store-relative posix directory the spec resolves to.
 */
/** @typedef {object} LocalPackageFile  One nested package.json reachable by the walk.
 * @property {string} dir  Its store-relative posix directory ("" excluded - that's root).
 * @property {string} file  `${dir}/package.json` - what a finding built from ITS OWN
 *   declarations anchors at.
 * @property {object} pkg  Its parsed contents.
 */

// file:/link: only - not workspace:, whose value is normally a bare range ("workspace:*",
// "workspace:^1.0.0") rather than a path. Resolving a REAL workspace: dependency needs
// matching its name against the root's own "workspaces" glob patterns, a different
// algorithm this does not implement; such a spec is left to fall through to `unsupported`
// exactly as it does today.
const LOCAL_SPEC = /^(?:file|link):(.*)$/i;

/**
 * Resolve `target` (the text after `file:`/`link:`) against `baseDir` (the declaring
 * package file's OWN store-relative directory, "" for the root) into a store-relative posix
 * directory, or null when it steps outside the store (a leading "/" - never inside a store
 * that has no filesystem root of its own to collide with - or a ".." with nothing left to
 * pop). Pure path arithmetic: does not touch the store, so it never says whether the
 * directory is actually THERE.
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
 * Every file:/link: target reachable from the submission's root package file, walked
 * recursively - the SCA-only case where `npm ci`/`npm install` resolves a dependency
 * entirely from a LOCAL directory already inside the submission (never the registry,
 * whatever the package name looks like) and additionally installs THAT package's own
 * dependencies and devDependencies, fetched from the real registry like any other source.
 *
 * Two lists, because the two questions a caller asks are different. `targets`: is this
 * declaration ITSELF a directory the submission holds - the fact that lets classifyDeps
 * drop it from `unsupported`, because the code is right there and is reviewed like any
 * other authored file, so there is no unverifiable source to reject. Nothing is exempted
 * from review by this; only the DECLARATION stops being an unidentifiable one. True
 * whether or not the directory turns out to hold a readable package file, and whether or not
 * it holds anything at all - what npm's own docs require of a local path is a directory
 * ("a path to a local directory that contains a package"), so that is the question asked.
 * `packageFiles`: which of those directories has ITS OWN readable package.json to recurse
 * into - a directory that exists but carries no package file (or one that fails to parse) is
 * still authored code with nothing further to check, so it contributes to `targets` alone.
 *
 * A spec that escapes the submission (resolveLocalDir) or names anything that is not a
 * directory - a local tarball, a stray file, a path that is not there - is left out of
 * BOTH lists, and the caller's classifyDeps buckets it as `unsupported`: a source the
 * reviewer cannot verify, which is the whole of what that check exists to say.
 *
 * The loop guard is the package files already found, not a separate tracking structure:
 * `packageFiles` is recorded keyed by resolved directory as the walk proceeds, and a directory
 * already present there is not walked again - still added to `targets` (the declaration is
 * honestly satisfied) but not re-entered into `packageFiles` or recursed into, which is what
 * breaks a cycle (A -> B -> A) and a self-reference (a package file declaring `file:.`/`file:..`
 * back at its own directory or the root). Depth is capped at LOCAL_PACKAGE_FILE_MAX_DEPTH.
 * @param {object} addon
 * @returns {{targets: LocalTarget[], packageFiles: LocalPackageFile[]}}
 */
export function resolveLocalPackageFiles(addon) {
  const files = submissionFiles(addon);
  const root = readPackageFile(files);
  const targets = [];
  /** @type {Map<string, LocalPackageFile>} */
  const packageFiles = new Map();
  if (!files || !root) {
    return { targets, packageFiles: [] };
  }
  // What the LOADER saw, which is the only thing that can answer this: the key set names
  // files, so a path that IS a file would pass a prefix test against it just as a real
  // directory does - and an empty directory would fail one although it is exactly what a
  // local spec may name.
  const directories = new Set(addon?.directories ?? []);
  const isDirectory = (dir) =>
    // The store root itself: trivially true whenever we get this far (its package file was
    // just read above), and the walk records what it ENTERS, never the root it starts at.
    dir === "" || directories.has(dir);
  const walk = (pkg, baseDir, declaringFile, depth) => {
    if (depth > LOCAL_PACKAGE_FILE_MAX_DEPTH) {
      return;
    }
    for (const { map, name, spec } of declaredDependencies(pkg)) {
      const m = LOCAL_SPEC.exec(spec.trim());
      if (!m) {
        continue;
      }
      const dir = resolveLocalDir(baseDir, m[1]);
      if (dir === null || !isDirectory(dir)) {
        continue; // escapes the submission, or does not name a directory in it
      }
      targets.push({ declaringFile, map, name, dir });
      if (dir === "" || packageFiles.has(dir)) {
        continue; // the store root, or a directory already walked - cycle/self-reference
      }
      const file = `${dir}/${PACKAGE_FILE}`;
      const pkgData = parsePackageFile(files.get(file));
      if (!pkgData) {
        continue; // directory exists, no readable package file - nothing to recurse into
      }
      packageFiles.set(dir, { dir, file, pkg: pkgData });
      walk(pkgData, dir, file, depth + 1);
    }
  };
  walk(root, "", PACKAGE_FILE, 1);
  return { targets, packageFiles: [...packageFiles.values()] };
}
