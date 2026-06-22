// Classifies each bundled Experiment against the allowed upstream set
// (github.com/thunderbird/webext-experiments) so the pipeline can decide whether
// to relax the gate, continue-and-flag, or abort. Two phases, like the vendor
// verifier: resolve+load the allow-list (network, once), then a deterministic
// content-hash + name comparison.
//
// Classification is NAME-FIRST: an experiment is recognised when its declared
// API namespace is one published upstream (from the upstream schema files'
// `namespace`); a recognised experiment whose files are all byte-identical
// (modulo EOL) to the latest upstream is `pristine`, otherwise `modified`; an
// unrecognised API name (or a file-less declaration) is `unsupported`.
//
// Belongs here: the allow-list (file hashes + API namespaces) and the per-group
// status. Does NOT belong here: fetching the zip (src/experiments/fetch.js),
// manifest parsing (src/checks/lib/experiments.js), the relax/abort wiring
// (src/pipeline.js), or the shadowing reason (experiment-not-allowed, which has
// the schema).

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import JSON5 from "json5";

import { debug } from "../util/log.js";
import { EXPERIMENTS_CACHE } from "../config.js";
import { manifestTokenLine } from "../checks/lib/util.js";
import { experimentGroups } from "../checks/lib/experiments.js";
import { resolveExperimentsZip } from "./fetch.js";

// A file belongs to an experiment's implementation when it sits under an
// `experiments/<name>/` directory (the upstream repo's layout, e.g.
// "calendar/experiments/calendar/parent/ext-calendar-items.js").
const IMPL_FILE = /(?:^|\/)experiments\/[^/]+\/.+/;

/**
 * EOL-normalized SHA-256 (hex): CRLF/CR collapse to LF and trailing newlines are
 * ignored, so a CRLF/LF checkout is not treated as a local change. latin1 is
 * byte-preserving. Both upstream and add-on files are hashed this way.
 * @param {Buffer} buf
 * @returns {string}
 */
export function normalizedSha256(buf) {
  const norm = Buffer.isBuffer(buf)
    ? buf.toString("latin1").replace(/\r\n?/g, "\n").replace(/\n+$/, "")
    : "";
  return createHash("sha256").update(norm, "latin1").digest("hex");
}

/**
 * Build the allow-list from the upstream repo zip or directory: the union of
 * normalized hashes of every file under an `experiments/<name>/` subtree, plus
 * the set of top-level API namespaces declared by the upstream schema files (so
 * an add-on's experiment can be recognised by name).
 * @param {string} src  Path to the fetched zip or a directory.
 * @returns {{fileHashes: Set<string>, apiNamespaces: Set<string>}}
 */
export function loadAllowList(src) {
  const fileHashes = new Set();
  const apiNamespaces = new Set();
  /**
   * Hash one experiment file into the allow-list, collecting its namespaces too
   * when it is a schema JSON.
   * @param {string} name  The file's path within the source.
   * @param {Buffer} buf  The file's contents.
   * @returns {void}
   */
  const consume = (name, buf) => {
    fileHashes.add(normalizedSha256(buf));
    if (name.endsWith(".json")) {
      collectNamespaces(buf, apiNamespaces);
    }
  };
  if (fs.statSync(src).isDirectory()) {
    for (const rel of walkDir(src)) {
      if (IMPL_FILE.test(rel)) {
        consume(rel, fs.readFileSync(path.join(src, rel)));
      }
    }
  } else {
    for (const entry of new AdmZip(src).getEntries()) {
      if (!entry.isDirectory && IMPL_FILE.test(entry.entryName)) {
        consume(entry.entryName, entry.getData());
      }
    }
  }
  return { fileHashes, apiNamespaces };
}

/**
 * Add each top-level namespace declared by a schema JSON to `set`.
 * @param {Buffer} buf  The schema JSON file's contents.
 * @param {Set<string>} set  Destination set of top-level namespaces.
 * @returns {void}
 */
function collectNamespaces(buf, set) {
  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  let data;
  try {
    data = JSON5.parse(text);
  } catch {
    return;
  }
  if (!Array.isArray(data)) {
    return;
  }
  for (const obj of data) {
    const ns = obj && typeof obj.namespace === "string" ? obj.namespace : null;
    if (ns && ns !== "manifest") {
      set.add(ns.split(".")[0]);
    }
  }
}

/**
 * Recursively list POSIX-relative file paths under a directory.
 * @param {string} root  Directory to walk.
 * @returns {string[]} POSIX-relative file paths under `root`.
 */
function walkDir(root) {
  const out = [];
  /**
   * @param {string} dir  Absolute directory to descend into.
   * @param {string} prefix  POSIX-relative path of `dir` from `root`.
   * @returns {void}
   */
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), rel);
      } else if (e.isFile()) {
        out.push(rel);
      }
    }
  };
  walk(root, "");
  return out;
}

/**
 * @typedef {object} ExperimentGroupStatus
 * @property {string} name  Display name (top-level API namespace, e.g.
 *   "calendar").
 * @property {?number} line  Manifest line of the group's first entry, or null.
 * @property {"pristine"|"modified"|"unsupported"} status
 * @property {string[]} apiPaths  All API paths the group declares (for the
 *   shadowing reason).
 */

/**
 * @typedef {object} ExperimentVerification
 * @property {boolean} pristine  Every bundled experiment is a pristine upstream
 *   copy.
 * @property {Set<string>} trustedFiles  Experiment files to trust (the continue
 *   path: all of them when no group is unsupported; empty otherwise).
 * @property {ExperimentGroupStatus[]} groups
 */

/**
 * @typedef {object} VerifyExperimentsOpts  Pipeline opts (experiments source).
 * @property {string} [experimentsZip]  Explicit local zip or directory; skips
 *   the network.
 * @property {string} [experimentsCache]  Cache dir for the downloaded zip.
 * @property {boolean} [experimentsForceRefresh]  Re-download even if cached.
 */

/**
 * Classify the add-on's bundled experiment(s) against the upstream allow-list.
 * Fetches the allow-list only when some group has files to verify (may throw on
 * a network failure - the caller turns that into a hard exit, never a verdict).
 * @param {import("../addon/load.js").Addon} addon
 * @param {VerifyExperimentsOpts} [opts]
 * @returns {Promise<ExperimentVerification>}
 */
export async function verifyExperiments(addon, opts = {}) {
  const manifest = addon.manifest || {};
  const text = addon.files.get("manifest.json")?.toString("utf8") ?? "";
  const groups = experimentGroups(manifest).map((g) => ({
    ...g,
    line: manifestTokenLine(text, g.entries[0]?.key) ?? null,
    files: g.root ? filesUnder(addon, g.root) : [],
  }));

  // Fetch only when a group actually bundles files to verify (so a bare
  // experiment_apis declaration, e.g. {myapi:{}}, stays offline -> unsupported).
  const allowed = groups.some((g) => g.files.length)
    ? await loadAllowed(opts)
    : { fileHashes: new Set(), apiNamespaces: new Set() };

  for (const g of groups) {
    const recognised = g.apiNamespaces.some((ns) =>
      allowed.apiNamespaces.has(ns)
    );
    if (!recognised || g.files.length === 0) {
      g.status = "unsupported";
      continue;
    }
    // Pristine = every declared file is present AND every file under the subtree
    // is an unmodified latest upstream file (so a missing schema/script, a
    // tampered helper, or an injected file all drop it to "modified").
    const refsPresent = g.entries
      .flatMap((e) => e.refs)
      .every((ref) => addon.files.has(ref));
    const allMatch = g.files.every(([, buf]) =>
      allowed.fileHashes.has(normalizedSha256(buf))
    );
    g.status = refsPresent && allMatch ? "pristine" : "modified";
  }

  const anyUnsupported = groups.some((g) => g.status === "unsupported");
  const trustedFiles = new Set();
  if (!anyUnsupported) {
    // Continue path: trust pristine AND modified experiment files. The fix is
    // "use the unmodified latest upstream". Linting upstream-derived code is
    // noise, and the modified error keeps the submission rejected.
    for (const g of groups) {
      for (const [file] of g.files) {
        trustedFiles.add(file);
      }
    }
  }

  return {
    pristine: groups.length > 0 && groups.every((g) => g.status === "pristine"),
    trustedFiles,
    groups: groups.map((g) => ({
      name: g.name,
      line: g.line,
      status: g.status,
      apiPaths: g.entries.flatMap((e) => e.apiPaths),
    })),
  };
}

/**
 * Resolve and load the upstream allow-list (file hashes + API namespaces).
 * @param {VerifyExperimentsOpts} opts  Pipeline opts (experiments source).
 * @returns {Promise<{fileHashes: Set<string>, apiNamespaces: Set<string>}>}
 */
async function loadAllowed(opts) {
  const { zipPath, source } = await resolveExperimentsZip({
    experimentsZip: opts.experimentsZip,
    cacheDir: opts.experimentsCache || EXPERIMENTS_CACHE,
    refresh: opts.experimentsForceRefresh,
  });
  const allowed = loadAllowList(zipPath);
  debug(
    `Loaded ${allowed.fileHashes.size} allowed experiment file hashes, ` +
      `${allowed.apiNamespaces.size} API namespaces from ${source}`
  );
  return allowed;
}

/**
 * The add-on's [path, Buffer] entries under a subtree root.
 * @param {import("../addon/load.js").Addon} addon
 * @param {string} root  Subtree root prefix (with trailing "/").
 * @returns {Array<[string, Buffer]>}
 */
function filesUnder(addon, root) {
  const out = [];
  for (const [file, buf] of addon.files) {
    if (file.startsWith(root)) {
      out.push([file, buf]);
    }
  }
  return out;
}
