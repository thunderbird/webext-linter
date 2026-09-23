// Which package manager a submission's build uses, decided from its committed
// FINGERPRINTS - a lockfile, a tool config, or the package.json `packageManager` field.
// Deterministic, no judgement and no network: a file is a fingerprint or it is not.
//
// Only npm and pnpm are supported (they share the .npmrc config format, keeping the
// reviewable surface small), so this answers one question for several checks:
// unsupported-build-tool REPORTS a disallowed tool, and the lock checks fall SILENT on one.
// That silence is the point of sharing it. "This build uses yarn" and "this build has no
// npm or pnpm lock" are one fact, so a submission that fingerprints as yarn must be told
// once, by the check whose subject the tool is - and the lock checks must decide that from
// the same files, not from whether another check happened to run first. A flag passed
// between checks would make the answer depend on registry order, which nothing asserts.
//
// Belongs here: the fingerprint table and the question `unsupportedBuildTool` answers.
// Does NOT belong here: what to DO about the answer - rejecting the tool is
// unsupported-build-tool's, staying quiet is each lock check's - and the wording, which is
// the registry's.

import { basename } from "../util/files.js";
import { parseManifest } from "../vendor/manifest.js";

/** @typedef {import("../addon/load.js").Addon} Addon */

// Lockfile / config BASENAMES that name a DISALLOWED package manager. npm's and pnpm's own
// locks are deliberately absent: they are what a supported build looks like.
const DISALLOWED_BY_BASENAME = new Map([
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["bunfig.toml", "bun"],
]);

const SUPPORTED = new Set(["npm", "pnpm"]);

/**
 * The disallowed package manager this submission fingerprints as, with the file that says
 * so, or null when nothing disallowed is committed.
 *
 * A fingerprint is matched by BASENAME at any depth: the build may run from a subfolder
 * (`cd frontend && npm ci`), and selectScaBuildFiles keeps nested build files. The
 * package.json `packageManager` field is checked after the files, because a committed
 * lockfile is evidence of what actually ran while the field is a declaration of intent.
 * @param {?{files?: Map<string, Buffer>}} addon  The SCA build corpus.
 * @returns {?{tool: string, file: string}}
 */
export function unsupportedBuildTool(addon) {
  const files = addon?.files;
  if (!files) {
    return null;
  }
  for (const path of files.keys()) {
    const tool = DISALLOWED_BY_BASENAME.get(basename(path));
    if (tool) {
      return { tool, file: path };
    }
  }
  for (const [path, buf] of files) {
    if (basename(path) !== "package.json") {
      continue;
    }
    const declared = packageManagerName(buf);
    if (declared && !SUPPORTED.has(declared)) {
      return { tool: declared, file: path };
    }
  }
  return null;
}

/**
 * The package manager named by package.json's "packageManager" field ("yarn@4.1.0" ->
 * "yarn"), lower-cased; null when the file/field is absent or unparseable.
 * @param {Buffer|undefined} buf  The package.json bytes.
 * @returns {?string}
 */
function packageManagerName(buf) {
  // Read through manifest.js, like every other read of a submission package.json: a
  // leading BOM is the developer's editor and says nothing about the build, but a parse
  // that rejects one leaves the tool unnamed - and an unnamed tool does not fall silent,
  // it leaves the lock checks to report a yarn build as a missing npm lock.
  const pm = parseManifest(buf)?.packageManager;
  if (typeof pm !== "string") {
    return null;
  }
  return pm.split("@")[0].trim().toLowerCase() || null;
}
