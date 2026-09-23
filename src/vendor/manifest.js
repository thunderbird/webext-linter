// Reads the submission's package.json through ONE implementation, into a shape every
// dependency reader can use. Each of them asks a question of the same file - resolveVendor
// (classifying each declaration), lockGaps (what the lock fails to cover),
// sca-lock-file-missing (whether a lock was owed), sca-package-file-invalid (whether the
// manifest can be used at all) and unsupportedBuildTool (which package manager the file
// names) - and one parse answers for all of them. A parse per reader is a copy of these tolerances per
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
 * Takes the BYTES rather than the artifact, for the reader that does not want the root
 * file: unsupportedBuildTool matches a manifest at any depth, because a build may run from
 * a subfolder.
 * @param {?Buffer} buf  One package.json's bytes.
 * @returns {?object}
 */
export function parseManifest(buf) {
  return readBytes(buf).value;
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
