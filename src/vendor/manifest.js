// Reads the submission's package.json through ONE implementation, into a shape every
// dependency reader can use. Each of them asks a question of the same file - resolveVendor
// (classifying each declaration), lockGaps (what the lock fails to cover),
// sca-lock-file-missing (whether a lock was owed) and sca-package-file-invalid (whether the
// manifest can be used at all) - and one parse answers for all of them. A parse per reader is a copy of these tolerances per
// reader, and a submission shaped in a way one copy mishandles is mishandled by that one
// alone, silently: a manifest that fails to parse reads as an absent manifest, and
// "declares nothing" is every caller's empty case. One implementation, not one call: each
// reader still parses when it asks.
//
// A submission's manifest is UNTRUSTED input, not a data structure: it is whatever bytes
// the developer packed. So nothing here trusts a shape. A file that is not a JSON object,
// a dependency map that is not an object, a version spec that is not a string - each is
// absent rather than coerced, because coercing invented findings that named `0 (l)` as a
// package.
//
// Belongs here: turning those bytes into a manifest object and a normalized list of what it
// declares. Does NOT belong here: what a declaration MEANS - pinned, supported, covered by
// the lock - which is resolve.js, locks.js and the checks respectively; and the policy of
// when a lock is owed, which is the check that asks.

import { parseJson } from "../util/json.js";
import { LOCAL_MANIFEST_MAX_DEPTH } from "../config.js";

/**
 * @typedef {object} DeclaredDependency  One dependency a manifest declares.
 * @property {string} map  The map that declared it (a DECLARATION_MAPS member).
 * @property {string} name  The package name, as written.
 * @property {string} spec  Its version spec, trimmed.
 * @property {{name: string, spec: string}} installs  What npm actually installs for it.
 *   The same name and spec for an ordinary declaration, and the TARGET of an
 *   `npm:` alias otherwise. Classify by this, report the written pair.
 */

// The dependency maps a manifest declares, in the order they are read.
// optionalDependencies is included deliberately: npm installs it, so it is in the tree and
// the reviewer's install has to resolve it. peerDependencies is not - the host supplies
// those, not this build.
export const DECLARATION_MAPS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
];

/**
 * The key that identifies one declaration within a manifest.
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
// library that ends up in the package. Read by classifyManifest, which judges these on
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

// The submission's build manifest, by name. Shared so that the checks asking whether it is
// THERE and whether it can be USED cannot come to different answers about which file they
// mean (sca-package-file-missing, sca-package-file-invalid), the way TREE_LOCKS is shared
// for the lock file.
export const MANIFEST_FILE = "package.json";

/**
 * One package.json's bytes, parsed, alongside the fault when they cannot be used. Two
 * questions over one parse, because the readers that ask them want different halves.
 * @param {?Buffer} buf  One package.json's bytes.
 * @returns {{value: ?object, fault: ?string}}
 */
function readBytes(buf) {
  // Absent, empty and malformed all arrive as null from the one parser, and all three are
  // the same fault to a reader: there is no manifest to work from.
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
export function manifestFault(buf) {
  return readBytes(buf).fault;
}

/**
 * A package.json's bytes as an object, or null when they are absent, unreadable, or not a
 * JSON object.
 *
 * Parsed through src/util/json.js, the one parser in src/ - which is what makes a BOM'd
 * manifest readable here, since npm reads one perfectly well and `JSON.parse` does not.
 *
 * Module-private: every reader wants the submission's root manifest, which readManifest
 * below names. This is the half of it that holds the tolerances, kept apart so they are
 * stated once rather than once per caller.
 * @param {?Buffer} buf  One package.json's bytes.
 * @returns {?object}
 */
function parseManifest(buf) {
  return readBytes(buf).value;
}

/**
 * The SUBMISSION's own corpus - the frame a build manifest and a lock are written in.
 *
 * For a built XPI it is the artifact itself. For a source archive it is the whole
 * --sca-root: `addon.files` there is the add-on's own subtree, whose root is NOT where the
 * build runs, so reading a manifest from it would take a package.json the build never
 * installs from. An addon with no separate store (a hand-built file map) answers with its
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
export function readManifest(files) {
  return parseManifest(files?.get(MANIFEST_FILE));
}

/**
 * Everything the manifest declares, across DECLARATION_MAPS, as one flat list.
 *
 * A map that is not an object contributes nothing, and so does a spec that is not a string:
 * npm rejects both outright, so there is no install to reason about, and coercing them
 * produces findings about packages the developer never named.
 * @param {?object} pkg  A manifest from readManifest.
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
 * @param {string} key  A name taken from the manifest.
 * @returns {unknown}  The value, or undefined when absent or inherited.
 */
export function ownValue(obj, key) {
  return plainObject(obj) && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/** @typedef {object} LocalTarget  One file:/link: declaration that resolves to a real
 * directory inside the submission - whether or not that directory has its own readable
 * package.json (see LocalManifest).
 * @property {string} declaringFile  The package.json (store-relative) that declared it -
 *   MANIFEST_FILE for the root, a LocalManifest.file otherwise.
 * @property {string} map  The declaration map it was written in (a DECLARATION_MAPS
 *   member). Carried because a NAME does not identify a declaration: npm accepts the same
 *   name in several maps with different specs, so what resolved has to say which one.
 * @property {string} name  The name it was declared under.
 * @property {string} dir  The store-relative posix directory the spec resolves to.
 */
/** @typedef {object} LocalManifest  One nested package.json reachable by the walk.
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
 * manifest's OWN store-relative directory, "" for the root) into a store-relative posix
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
 * Every file:/link: target reachable from the submission's root manifest, walked
 * recursively - the SCA-only case where `npm ci`/`npm install` resolves a dependency
 * entirely from a LOCAL directory already inside the submission (never the registry,
 * whatever the package name looks like) and additionally installs THAT package's own
 * dependencies and devDependencies, fetched from the real registry like any other source.
 *
 * Two lists, because the two questions a caller asks are different. `targets`: is this
 * declaration ITSELF a real, present directory in the store - the fact that lets
 * classifyDeps drop it from `unsupported` (authored code, reviewed wherever it sits,
 * nothing to reject) whether or not that directory turns out to hold a readable manifest.
 * `manifests`: which of those directories has ITS OWN readable package.json to recurse
 * into - a directory that exists but carries no manifest (or one that fails to parse) is
 * still authored code with nothing further to check, so it contributes to `targets` alone.
 *
 * A spec that escapes the store (resolveLocalDir) or names a directory the store does not
 * actually hold anything under is left out of BOTH lists - the caller's classifyDeps still
 * buckets that spec as `unsupported`, exactly as today.
 *
 * The loop guard is the manifests already found, not a separate tracking structure:
 * `manifests` is recorded keyed by resolved directory as the walk proceeds, and a directory
 * already present there is not walked again - still added to `targets` (the declaration is
 * honestly satisfied) but not re-entered into `manifests` or recursed into, which is what
 * breaks a cycle (A -> B -> A) and a self-reference (a manifest declaring `file:.`/`file:..`
 * back at its own directory or the root). Depth is capped at LOCAL_MANIFEST_MAX_DEPTH.
 * @param {object} addon
 * @returns {{targets: LocalTarget[], manifests: LocalManifest[]}}
 */
export function resolveLocalManifests(addon) {
  const files = submissionFiles(addon);
  const root = readManifest(files);
  const targets = [];
  /** @type {Map<string, LocalManifest>} */
  const manifests = new Map();
  if (!files || !root) {
    return { targets, manifests: [] };
  }
  const dirHasFiles = (dir) => {
    // The store root itself: trivially true whenever we get this far (root was just read
    // above), and `key.startsWith("" + "/")` would never match a normal relative key, so
    // this has to be its own case rather than falling into the loop below.
    if (dir === "") {
      return true;
    }
    for (const key of files.keys()) {
      if (key === dir || key.startsWith(`${dir}/`)) {
        return true;
      }
    }
    return false;
  };
  const walk = (pkg, baseDir, declaringFile, depth) => {
    if (depth > LOCAL_MANIFEST_MAX_DEPTH) {
      return;
    }
    for (const { map, name, spec } of declaredDependencies(pkg)) {
      const m = LOCAL_SPEC.exec(spec.trim());
      if (!m) {
        continue;
      }
      const dir = resolveLocalDir(baseDir, m[1]);
      if (dir === null || !dirHasFiles(dir)) {
        continue; // escapes the store, or nothing there
      }
      targets.push({ declaringFile, map, name, dir });
      if (dir === "" || manifests.has(dir)) {
        continue; // the store root, or a directory already walked - cycle/self-reference
      }
      const file = `${dir}/${MANIFEST_FILE}`;
      const pkgData = parseManifest(files.get(file));
      if (!pkgData) {
        continue; // directory exists, no readable manifest - nothing to recurse into
      }
      manifests.set(dir, { dir, file, pkg: pkgData });
      walk(pkgData, dir, file, depth + 1);
    }
  };
  walk(root, "", MANIFEST_FILE, 1);
  return { targets, manifests: [...manifests.values()] };
}
