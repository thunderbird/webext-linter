// web_accessible_resources manifest.json semantics: normalizing the MV2/MV3 entry
// shapes, expanding a resource pattern to concrete packaged files, and spotting
// patterns that expose the whole package. Shared by the minimize-web-
// accessible-resources check and the reachability graph (exposed resources are
// seeds).
//
// Belongs here: warResourceList (normalize MV2/MV3 entries),
// expandResourcePattern (glob a pattern to packaged files), and
// isOverBroadResource.
//
// Does NOT belong here: the minimize-web-accessible-resources verdict and its
// text - the rule under src/checks/rules/* and assets/registry.yaml. Walking
// reachability from the exposed seeds - reachability.js. The lexical path
// normalizer - normalizeRef in manifest-refs.js. The glob matcher - globMatch in
// src/util/files.js. Generic shape guards -
// lib/util.js.

import { asArray } from "./util.js";
import { normalizeRef } from "./manifest-refs.js";
import { globMatch } from "../util/files.js";

/** @typedef {import("../addon/load.js").Manifest} Manifest */

/**
 * web_accessible_resources as {resources, matches, paths} entries (MV3 objects and MV2
 * bare-string arrays normalized to one shape).
 * @param {Manifest} manifest
 * @returns {{resources: string[], matches: string[], paths: (string|number)[][]}[]}
 *   `paths[j]` is where `resources[j]` was declared, for a finding that points at it.
 */
export function warResourceList(manifest) {
  const out = [];
  // `paths[j]` is where `resources[j]` was declared, as a JSON path - built here because
  // here is where the index is known, and a finding has to point at the pattern itself
  // rather than at the file's coincidental other mention of the same string.
  const key = "web_accessible_resources";
  asArray(manifest.web_accessible_resources).forEach((entry, i) => {
    if (typeof entry === "string") {
      // MV2: bare strings, exposed to all origins inherently (no `matches` to
      // scope), so there is no over-broad-matches concern to flag. The entry IS the
      // resource, so its own path is the resource's.
      out.push({ resources: [entry], matches: [], paths: [[key, i]] });
    } else if (entry && typeof entry === "object") {
      const resources = asArray(entry.resources);
      out.push({
        resources,
        matches: asArray(entry.matches),
        paths: resources.map((_, j) => [key, i, "resources", j]),
      });
    }
  });
  return out;
}

/**
 * Concrete packaged files matching a web_accessible_resources resource pattern.
 * @param {Map<string, Buffer>} files
 * @param {string} pattern
 * @returns {string[]}
 */
export function expandResourcePattern(files, pattern) {
  const pat = normalizeRef(pattern);
  if (pat === "") {
    return [];
  }
  if (!pat.includes("*") && !pat.includes("?")) {
    return files.has(pat) ? [pat] : [];
  }
  return [...files.keys()].filter((f) => globMatch(pat, f));
}

/**
 * True for a resource pattern that exposes essentially the whole package.
 * @param {string} pattern
 * @returns {boolean}
 */
export function isOverBroadResource(pattern) {
  const p = normalizeRef(pattern);
  return p === "*" || p === "**" || p === "**/*" || p === "*.*";
}
