// Resolves the add-on's vendored declarations ONCE, at the top of the pipeline,
// before anything reformats or reviews files. This is the OFFLINE half: it
// parses the VENDOR file and the package.json dependency
// manifest (pinning each via an exact spec or a lock file), enumerates what the
// lock file installs, classifies each declared source, and builds the shared
// `addon.vendor` store. The network half
// (fetch + compare + popularity) is verifyVendor (src/vendor/verify.js), which
// fills in the per-file results. The review-phase checks only read the store.
//
// Belongs here: combining the VENDOR + package.json declarations, and the
// committed lock file's whole package list, into the offline `addon.vendor` (set,
// manifest, packages, unpinned, lockPackages, offline results). lockPackages is
// the one field here that no check reads: it is the offline half of the tree
// audit, handed to verify.js, which owns the network half.
// Does NOT belong here: the network verification (-> verify.js), the
// deterministic VENDOR parse (-> src/normalize/vendor.js), lock parsing (->
// src/vendor/locks.js), and URL classification (-> src/vendor/sources.js).

import { readVendorDeclarations, readVendorFile } from "../normalize/vendor.js";
import { classifySource } from "./sources.js";
import { lockedVersion, lockedPackages } from "./locks.js";
import { SCHEME_RE } from "../lib/util.js";

/** @typedef {import("../addon/load.js").Addon} Addon */
/** @typedef {import("../normalize/vendor.js").VendorEntry} VendorEntry */
/**
 * @typedef {object} VendorStore
 * @property {Set<string>} set  Vendored file paths (exact-match skip-set).
 * @property {Set<string>} folders  Vendored directory paths (prefix-match): every
 *   file under one is vendored (a folder declaration). Use isVendored to test both.
 * @property {{path: string, source: ?string, outcome: string}[]} results
 *   Per-file outcomes (offline ones now, network ones added by verifyVendor).
 * @property {(VendorEntry & {trusted: boolean, pinned: boolean})[]} manifest
 *   Classified VENDOR-file entries.
 * @property {{name: string, version: string}[]} packages  Pinned deps.
 * @property {{name: string, spec: string}[]} unpinned  Deps with no pin.
 * @property {{name: string, spec: string, repo: string, ref: ?string}[]}
 *   githubDeps  GitHub-sourced package.json deps (popularity-gated like a
 *   VENDOR.md github source; audited by verifyScaDependencies in SCA mode).
 * @property {{name: string, spec: string}[]} unsupportedDeps  package.json deps
 *   from an unsupported source (not npm, not GitHub); rejected by the
 *   unsupported-dependency check.
 * @property {{name: string, version: string}[]} devPackages  Pinned npm
 *   devDependencies. Never shipped, but OSV-audited in SCA mode because the
 *   reviewer builds from source (verifyScaDependencies).
 * @property {VendorEntry[]} missing  VENDOR entries whose file is absent.
 * @property {{source: string, paths: string[]}[]} ambiguousSources  Source URLs
 *   paired with more than one bundled file (the developer must split them or use a
 *   folder). Read by the vendor-ambiguous-source check.
 * @property {boolean} unparsedVendor  A VENDOR file exists but yielded nothing.
 * @property {?string} vendorFile  The VENDOR filename (e.g. "VENDOR.md"), or
 *   null; the anchor file for VENDOR-sourced vulnerability/unaudited findings.
 * @property {Map<string, boolean>} popularity  One popularity reading per package
 *   for this run, shared by every gate that asks (isPopular). Per-run and
 *   in-process only; never written to disk.
 * @property {import("./verify.js").VendorVuln[]} vulnerabilities  Pinned npm
 *   packages (package.json deps + npm VENDOR entries) with known OSV advisories
 *   (filled by verifyVendor's audit; empty offline).
 * @property {import("./verify.js").VendorVuln[]} devVulnerabilities  SCA mode
 *   only: pinned npm devDependencies with known OSV advisories (filled by
 *   verifyScaDependencies; empty in XPI mode / offline). Read by the
 *   vendor-vulnerable-dev check.
 * @property {import("./locks.js").LockedPackage[]} lockPackages  Every package
 *   the committed lock file records as installed - the declared dependencies and
 *   everything they pull in. Empty in XPI mode (a shipped add-on has no lock).
 * @property {import("./verify.js").VendorVuln[]} treeVulnerabilities  SCA mode
 *   only: packages from lockPackages that NOTHING declares, carrying a high or
 *   critical advisory, installed for production (filled by verifyScaDependencies;
 *   empty in XPI mode / offline). Read by the vendor-vulnerable-indirect check.
 * @property {import("./verify.js").VendorVuln[]} treeDevVulnerabilities  The same
 *   for undeclared packages installed for the BUILD only. Read by the
 *   vendor-vulnerable-indirect-dev check.
 * @property {{path: string, source: ?string, repo: ?string}[]} unaudited
 *   GitHub-sourced VENDOR entries that could not be resolved to a verified npm
 *   identity for an OSV audit (filled by verifyVendor; empty offline). Read by
 *   the vendor-vuln-unknown check to surface them as info.
 * @property {{name: string, version: string, file: string, token: string}[]}
 *   unpopularDeps  SCA mode: declared dependencies that are not a confirmed
 *   widely-used library (filled by verifyScaDependencies; empty in XPI mode /
 *   offline). Read by the unpopular-source-dependency check.
 * @property {{name: string, version: string, status: string, reason: string,
 *   file: string, token: string}[]} blocked  Bundled library versions Mozilla
 *   add-on policy disallows (banned) or discourages (unadvised): auditNpm matches
 *   each audited (name, version) against the policy the audit is given and records a
 *   hit here (a banned one also skips the OSV query). Read by the banned-library check.
 */

// An exact semver (no range operators) - a concrete pinned version.
const EXACT = /^v?\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;

/**
 * Whether a packaged file is vendored: an exact VENDOR-file entry, or a file under
 * a vendored folder declaration (prefix). The single test for "skip this file" used
 * by the normalizer-adjacent checks (bundled.js, unused-files.js) and verifyPackage.
 * @param {?{set?: Set<string>, folders?: Set<string>}} vendor  The vendor store.
 * @param {string} file  Add-on-relative path.
 * @returns {boolean}
 */
export function isVendored(vendor, file) {
  if (!vendor) {
    return false;
  }
  if (vendor.set?.has(file)) {
    return true;
  }
  for (const dir of vendor.folders ?? []) {
    if (file.startsWith(`${dir}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * The files one declaration covers: the declared path itself, or - for a folder
 * declaration - every packaged file under it. This is the unit a `results` row is
 * written about WHEN the outcome has a per-file consequence - one that leaves each
 * covered file to be re-decided on its own (no-url, untrusted, unfetchable). Such a
 * row must never name a DIRECTORY. An outcome that rejects instead (unpinned-source,
 * modified) re-decides nothing per file, so its row names the declaration.
 *
 * That matters: a row naming a directory reaches markUntrusted, which withdraws a
 * file's exemption by removing it from the non-authored set. Removing "lib" is a
 * no-op - the skipped entries are "lib/..." - so a folder declaration against a
 * source we cannot check would leave its files exempt AND unscanned, while the same
 * source declared file-by-file is reviewed. Expanding here means the consumers are
 * right by construction rather than by remembering.
 *
 * Only files with reviewable content are reconciled (CODE_EXTENSIONS, see
 * applyUnverifiedVendor): a folder covers whatever sits under it, and nothing reads
 * a font or an image, so there is no exemption to withdraw for one.
 *
 * A declared FILE is returned as declared, packaged or not: whether a declaration
 * names something absent is missing-vendor-file's question, not this one.
 * @param {Addon} addon
 * @param {VendorEntry} entry
 * @returns {string[]}
 */
export function declaredFiles(addon, entry) {
  if (entry.kind !== "folder") {
    return [entry.path];
  }
  const prefix = `${entry.path}/`;
  return [...(addon.files?.keys() ?? [])].filter((f) => f.startsWith(prefix));
}

/**
 * The upstream release a packaged file's content was matched against, or null.
 * Two paths reach a `verified` result and both are legitimate grounds:
 *   - a VENDOR declaration whose source was fetched and whose content matched
 *     (verifyUrl / verifyTarball / verifyFolder - the compare is EOL-normalized,
 *     so CRLF/LF and trailing-newline differences do not count as a change);
 *   - an UNDECLARED file whose exact content hash matches a published file of a
 *     pinned package.json dependency (verifyPackage's SRI match, which fetches
 *     only the package listing). Here the developer claimed nothing - we
 *     recognized the bytes - so the file need not be integral to the release.
 * Either way the statement is about CONTENT, not about intent: this file's bytes
 * are a published file of that release. It says nothing about whether the
 * developer needs this particular file, or could ship a different build.
 *
 * A file the untrusted reconciliation touched is refused whatever its results say
 * (applyUnverifiedVendor -> markUntrusted): a contradictory submission - a file
 * covered by a FOLDER declaration that did not verify and separately declared
 * against a source that did - would otherwise be told to the reviewer twice, once
 * as "reviewed as authored code" and once as vouched for. The stricter half wins.
 * An untrusted entry always names a packaged FILE - declaredFiles is what keeps a
 * folder declaration from putting a directory there - so an exact match is enough.
 *
 * Distinct from isVendored, which asks the DECLARATION question ("skip scanning
 * this file") and is deliberately verification-independent. Use this one only
 * where the content match itself is the argument.
 * @param {?import("../addon/load.js").Addon} addon  The routed artifact. Read
 *   whole because the answer spans its vendor results AND its untrusted list.
 * @param {string} file  Add-on-relative path.
 * @returns {?string}  The upstream source URL, or null. With more than one
 *   verified row for a path (a file and a folder declaration can both produce
 *   one) the last wins - any of them is a true statement about the content.
 */
export function verifiedVendorSource(addon, file) {
  for (const entry of addon?.bundled?.untrusted ?? []) {
    if (entry.file === file) {
      return null;
    }
  }
  let source = null;
  for (const result of addon?.vendor?.results ?? []) {
    if (result.path !== file) {
      continue;
    }
    if (result.outcome !== "verified") {
      return null; // anything else said about this file withdraws the vouching
    }
    source = result.source;
  }
  return source;
}

/**
 * Resolve the offline vendored declarations into `addon.vendor`.
 * @param {object} params
 * @param {Addon} params.addon
 * @returns {VendorStore}
 */
export function resolveVendor({ addon }) {
  const vendorFile = readVendorFile(addon);
  // Both halves of one reading: what the VENDOR file declares that the submission
  // holds, and what it declares that the submission does not. Taking them together
  // is why the file is read once rather than once per half.
  const { resolved, missing } = readVendorDeclarations(addon);
  const manifest = resolved;

  const set = new Set();
  const folders = new Set();
  const results = [];

  // One source URL paired with more than one bundled FILE is ambiguous: the
  // developer must give each file its own source, or declare the containing
  // folder as a single source. Pull those entries out of the manifest (we do not
  // verify a guessed pairing) but keep their paths vendored (skip-set), and
  // surface them via the vendor-ambiguous-source check. Folder entries are exempt
  // - a folder legitimately covers many files.
  const ambiguousSources = [];
  {
    const byUrl = new Map();
    for (const e of manifest) {
      if (e.kind === "folder" || !e.sourceUrl) {
        continue;
      }
      const list = byUrl.get(e.sourceUrl) ?? [];
      list.push(e.path);
      byUrl.set(e.sourceUrl, list);
    }
    const bad = new Set();
    for (const [source, paths] of byUrl) {
      if (paths.length > 1) {
        ambiguousSources.push({ source, paths });
        bad.add(source);
      }
    }
    for (let i = manifest.length - 1; i >= 0; i--) {
      if (manifest[i].kind !== "folder" && bad.has(manifest[i].sourceUrl)) {
        set.add(manifest[i].path); // still vendored, just unverifiable
        manifest.splice(i, 1);
      }
    }
  }

  for (const entry of manifest) {
    const src = classifySource(entry.sourceUrl);
    entry.trusted = src.trusted;
    entry.pinned = src.pinned;
    // A declared file/folder is vendored regardless of its outcome. A folder path
    // is a directory PREFIX (its files are skipped/verified by prefix - see
    // isVendored / verifyFolder), so it goes to `folders`, not the exact-path set.
    if (entry.kind === "folder") {
      folders.add(entry.path);
    } else {
      set.add(entry.path);
    }
    // A row records a PER-FILE consequence, so who it names follows from whether the
    // outcome has one. no-url and untrusted do: no rejection follows from them, so
    // each covered file is re-decided by its own readability (applyUnverifiedVendor),
    // and a row naming a folder would reach markUntrusted with a path that is not a
    // packaged file. An unpinned source does not: it is already an error, the
    // submission is rejected until the developer pins it, and nothing about the files
    // is re-decided meanwhile - so the row names the DECLARATION, which is what the
    // complaint is about and what unpinned-vendor-source reports.
    if (!entry.sourceUrl || !src.trusted) {
      const outcome = entry.sourceUrl ? "untrusted" : "no-url";
      for (const path of declaredFiles(addon, entry)) {
        results.push({ path, source: entry.sourceUrl ?? null, outcome });
      }
    } else if (!src.pinned) {
      results.push({
        path: entry.path,
        source: entry.sourceUrl,
        outcome: "unpinned-source",
      });
    }
    // Trusted + pinned entries are left for verifyVendor to fetch.
  }

  const { packages, unpinned, githubDeps, unsupported, devPackages } =
    resolvePackages(addon);
  return {
    set,
    folders,
    results,
    manifest,
    packages,
    unpinned,
    // GitHub-sourced package.json deps (popularity-gated like a VENDOR.md github
    // source). Audited by verifyScaDependencies in SCA mode.
    githubDeps,
    // package.json deps from an unsupported source (not npm, not GitHub). Read by
    // the unsupported-dependency check, which rejects them.
    unsupportedDeps: unsupported,
    // Pinned npm devDependencies. Never shipped, but OSV-audited in SCA mode
    // because the reviewer builds from source (verifyScaDependencies).
    devPackages,
    missing,
    ambiguousSources,
    vendorFile: vendorFile?.name ?? null,
    // One popularity reading per package, for the length of THIS review. It is a
    // request budget, not a result cache: a package declared once per file was
    // asked about once per file, and the host answers a burst by refusing. Never
    // persisted - popularity is time-varying, the same reason the CDN identifier
    // keeps it out of its on-disk cache (src/lib/cdn-lookup.js).
    popularity: new Map(),
    // Filled by verifyVendor's OSV audit (network). Empty for offline runs.
    vulnerabilities: [],
    // Bundled library versions Mozilla add-on policy disallows (banned) or
    // discourages (unadvised): auditNpm matches each audited (name, version) against
    // the policy the audit is given (assets/library-blocks.yaml) and records a hit
    // here - a banned one also skips the OSV query. Read by the banned-library check.
    blocked: [],
    // SCA mode only: pinned npm devDependencies with known OSV advisories (filled
    // by verifyScaDependencies; empty in XPI mode / offline). Read by the
    // vendor-vulnerable-dev check.
    devVulnerabilities: [],
    // Every package the committed lock file records as installed, declared or
    // pulled in by another package. The offline half of the tree audit: what to
    // query is settled here, whether it has an advisory is verify.js's half.
    lockPackages: lockedPackages(addon),
    // SCA mode only: undeclared packages from lockPackages carrying a high or
    // critical advisory (filled by verifyScaDependencies; empty in XPI mode /
    // offline), split by whether the build installs them for production or only
    // to build with. Read by the two vendor-vulnerable-indirect checks.
    treeVulnerabilities: [],
    treeDevVulnerabilities: [],
    // Filled by verifyVendor when a github source cannot be resolved to a
    // verified npm identity (network). Empty for offline runs.
    unaudited: [],
    // SCA mode only: declared dependencies that are not a confirmed widely-used
    // library (filled by verifyScaDependencies; empty in XPI mode / offline).
    // Read by the unpopular-source-dependency check.
    unpopularDeps: [],
    // "Unparsed" only when we extracted nothing at all - neither a matched entry
    // nor a missing-file declaration. A parseable-but-missing VENDOR goes to the
    // missing-vendor-file check instead of a "could not be parsed" manual item.
    unparsedVendor:
      Boolean(vendorFile) && manifest.length === 0 && missing.length === 0,
  };
}

/**
 * Classify one package.json dependency map (`dependencies` or `devDependencies`)
 * by each spec. Only two sources are supported: a pinned npm package (an exact
 * spec, or a range a lock file pins) and a GitHub URL (audited by popularity, like
 * a VENDOR.md github source). The rest are surfaced, not dropped: a range with no
 * lock is `unpinned` (the dep is real but unverifiable), and any other non-registry
 * spec (file:/link:/workspace:/npm: alias/tarball/non-github git) is `unsupported`.
 * @param {Record<string, string>|undefined} deps  A dependency map, or undefined.
 * @param {Addon} addon  Needed to pin a range against a lock file (lockedVersion
 *   also reads the lock's devDependencies).
 * @returns {{packages: {name: string, version: string}[],
 *   unpinned: {name: string, spec: string}[],
 *   githubDeps: {name: string, spec: string, repo: string, ref: ?string}[],
 *   unsupported: {name: string, spec: string}[]}}
 */
function classifyDeps(deps, addon) {
  const packages = [];
  const unpinned = [];
  const githubDeps = [];
  const unsupported = [];
  for (const [name, rawSpec] of Object.entries(deps ?? {})) {
    const spec = String(rawSpec).trim();
    if (EXACT.test(spec)) {
      packages.push({ name, version: spec.replace(/^v/, "") });
    } else if (/[:/]/.test(spec)) {
      // A non-registry spec. A GitHub source is allowed (popularity-gated); every
      // other source (file:/link:/workspace:/npm: alias/tarball/non-github git) is
      // not supported and is rejected rather than silently ignored.
      const gh = parseGithubSpec(spec);
      if (gh) {
        githubDeps.push({ name, spec, repo: gh.repo, ref: gh.ref });
      } else {
        unsupported.push({ name, spec });
      }
    } else {
      const version = lockedVersion(addon, name);
      if (version) {
        packages.push({ name, version });
      } else {
        unpinned.push({ name, spec });
      }
    }
  }
  return { packages, unpinned, githubDeps, unsupported };
}

/**
 * Classify package.json `dependencies` (all buckets) and `devDependencies` (pinned
 * npm only -> `devPackages`). Dev deps never ship, but the SCA reviewer builds the
 * add-on from source, so a pinned npm dev dep is OSV-audited too
 * (verifyScaDependencies). Only its pinned-npm bucket is kept: dev deps are not
 * popularity-gated, and their pinning / source support are shipping concerns.
 * A name in `dependencies` is a production dependency (npm ignores a same-named
 * `devDependencies` entry), so it is classified once as prod and dropped from the
 * dev set - the two vuln checks never double-report one package. Only
 * `dependencies` + `devDependencies` are read: `optionalDependencies` may be absent
 * at build, and `peerDependencies` are supplied by the host, not this build.
 * @param {Addon} addon
 * @returns {{packages: {name: string, version: string}[],
 *   unpinned: {name: string, spec: string}[],
 *   githubDeps: {name: string, spec: string, repo: string, ref: ?string}[],
 *   unsupported: {name: string, spec: string}[],
 *   devPackages: {name: string, version: string}[]}}
 */
function resolvePackages(addon) {
  let pkg;
  try {
    pkg = JSON.parse(addon.files.get("package.json").toString("utf8"));
  } catch {
    return {
      packages: [],
      unpinned: [],
      githubDeps: [],
      unsupported: [],
      devPackages: [],
    };
  }
  // A dev dep also declared in `dependencies` is a production dependency (the
  // dependencies copy wins, as in npm) - drop it from the dev set so it is audited
  // and reported once, as prod. devPackages is dev-ONLY.
  const prodNames = new Set(Object.keys(pkg.dependencies ?? {}));
  const devOnly = Object.fromEntries(
    Object.entries(pkg.devDependencies ?? {}).filter(
      ([name]) => !prodNames.has(name)
    )
  );
  return {
    ...classifyDeps(pkg.dependencies, addon),
    devPackages: classifyDeps(devOnly, addon).packages,
  };
}

/**
 * Parse a package.json dependency spec pointing at GitHub into {repo, ref}, or
 * null when it is not a GitHub source. Covers npm's recognized GitHub forms: the
 * bare "owner/repo" shorthand, "github:owner/repo", and git / git+http(s) /
 * git+ssh / https URLs whose host is github.com. A trailing "#ref" (tag, commit,
 * or "semver:RANGE") becomes the ref; repo is normalized to "owner/repo".
 * @param {string} spec
 * @returns {{repo: string, ref: ?string} | null}
 */
function parseGithubSpec(spec) {
  const s = String(spec).trim();
  const split = (rest) => {
    const i = rest.indexOf("#");
    const repo = (i === -1 ? rest : rest.slice(0, i))
      .replace(/\.git$/i, "")
      .split("/")
      .slice(0, 2)
      .join("/");
    const ref = i === -1 ? null : rest.slice(i + 1).replace(/^semver:/i, "");
    return { repo, ref: ref || null };
  };
  // Bare "owner/repo" shorthand (npm reads this as GitHub): one slash, no scheme.
  if (!SCHEME_RE.test(s) && /^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(s)) {
    return split(s);
  }
  if (/^github:/i.test(s)) {
    return split(s.slice("github:".length));
  }
  const url = s.match(
    /^(?:git\+)?(?:https?|git|ssh):\/\/(?:[^@/]+@)?github\.com\/(.+)$/i
  );
  if (url) {
    return split(url[1]);
  }
  // SCP-style git URL: [git+][user@]github.com:owner/repo[.git][#ref] - the form
  // npm accepts for a GitHub source without a scheme (a ":" after the host, not "/").
  const scp = s.match(/^(?:git\+)?(?:[^@/]+@)?github\.com:(.+)$/i);
  if (scp) {
    return split(scp[1]);
  }
  return null;
}
