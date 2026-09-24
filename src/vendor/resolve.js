// Resolves the add-on's vendored declarations ONCE, at the top of the pipeline,
// before anything reformats or reviews files. This is the OFFLINE half: it
// parses the VENDOR file and the package.json dependency
// manifest (pinning each via an exact spec, or against a committed lock file - either
// artifact may carry one), enumerates what the lock file installs where the reviewer
// installs from it, classifies each declared source, and builds the shared
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
import { governingLock, lockedVersion, lockedPackages } from "./locks.js";
import { SCHEME_RE } from "../lib/util.js";
import {
  declarationKey,
  declaredDependencies,
  readManifest,
  submissionFiles,
  resolveLocalManifests,
  BUILD_TIME_MAPS,
  MANIFEST_FILE,
} from "./manifest.js";

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
 * @property {{name: string, version: string, file: string}[]} packages  Pinned deps. `file`
 *   is the declaring manifest - "package.json" for the root, or a nested one reached by a
 *   file:/link: walk (SCA mode only - see resolveLocalManifests).
 * @property {{name: string, spec: string, file: string}[]} unpinned  Ranged deps a
 *   committed lock resolves nothing for.
 * @property {{name: string, spec: string, file: string}[]} unlocked  Ranged deps with no
 *   lock committed at all. Kept apart from `unpinned` because the two have different
 *   remedies.
 * @property {{name: string, spec: string, repo: string, ref: ?string, file: string}[]}
 *   githubDeps  GitHub-sourced package.json deps (popularity-gated like a
 *   VENDOR.md github source; audited by verifyScaDependencies in SCA mode).
 * @property {{name: string, spec: string, file: string}[]} unsupportedDeps  package.json
 *   deps from an unsupported source (not npm, not GitHub), rejected by the
 *   unsupported-dependency check. devDependencies are included where the reviewer
 *   installs from this artifact: `npm ci` clones and runs them.
 * @property {{name: string, version: string, file: string}[]} devPackages  Pinned npm
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
 *   everything they pull in. Always empty for a built XPI: nothing is installed from one,
 *   so there is no tree to audit, even where its lock does pin a declared range.
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
 * Whether a source can be fetched as one archive holding a directory's files - the
 * only thing a directory declaration can be verified against.
 *
 * Two shapes can: a github `/tree/` URL, which classifies with a subpath because it
 * resolves to the repo ZIP, and a pinned npm package, which resolves to its registry
 * tarball. Everything else that reaches here is a single file's URL - a raw.github
 * file, a jsDelivr `gh` file, a CDN directory listing - and names no archive at all.
 * @param {import("./sources.js").VendorSource} src
 * @returns {boolean}
 */
function directoryArchive(src) {
  return (
    (src.kind === "github" && src.subpath !== null) ||
    (src.kind === "npm" && Boolean(src.version))
  );
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
 * @param {boolean} [params.reviewerInstalls]  Whether the reviewer INSTALLS from this
 *   artifact - true for a submitted source archive, false (the default, and the safe
 *   direction) for a built XPI, where nothing is installed at all. Two things follow, and
 *   both are about INSTALLING rather than about the lock. The whole installed TREE is
 *   enumerated, which is only meaningful where one is installed. And devDependencies are
 *   classified for source support: `npm ci` clones and RUNS them on the reviewer's
 *   machine, while in an XPI they install nothing and vendor nothing.
 *
 *   What a ranged spec RESOLVES to is not one of them: a developer shipping a range is
 *   asked to commit the lock beside it, and what that lock records is the version that was
 *   bundled, so classifyDeps reads it in either artifact.
 * @returns {VendorStore}
 */
export function resolveVendor({ addon, reviewerInstalls = false }) {
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

  // Folder declarations whose source cannot be fetched as an archive: reported, and
  // taken out of the manifest so nothing tries to fetch them (see below).
  const unverifiableFolders = new Set();
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
    } else if (entry.kind === "folder" && !directoryArchive(src)) {
      // A directory is checked against an ARCHIVE of the upstream release - a github
      // /tree/ repo ZIP, or a pinned npm package's tarball. A source that is neither
      // cannot answer for a directory, and the way it fails is the reason this is
      // decided here rather than left to the fetch: a CDN directory URL answers 200
      // with an HTML listing page, so the fetch SUCCEEDS and the unzip is what
      // fails - recording every file under the directory as unfetchable, each then
      // reviewed as the developer's own code and each minified one REJECTED, for one
      // wrong URL on one line. Pulled out here like an ambiguous pairing, and
      // reported by the same check: the files stay vendored, nothing is fetched, and
      // the developer is told the one true thing - this source cannot verify these
      // files. The paths ride along as the finding's detail.
      ambiguousSources.push({
        source: entry.sourceUrl,
        paths: declaredFiles(addon, entry),
      });
      unverifiableFolders.add(entry.path);
    }
    // Trusted + pinned entries are left for verifyVendor to fetch.
  }
  // Removed after the walk, so the loop above reads as one pass over the manifest.
  for (let i = manifest.length - 1; i >= 0; i--) {
    if (unverifiableFolders.has(manifest[i].path)) {
      manifest.splice(i, 1);
    }
  }

  const { packages, unpinned, unlocked, githubDeps, unsupported, devPackages } =
    resolvePackages(addon, reviewerInstalls);
  return {
    set,
    folders,
    results,
    manifest,
    packages,
    unpinned,
    unlocked,
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
    //
    // Gated on INSTALLING, not on the lock being readable: a shipped XPI carries only
    // what was bundled, so the tree its lock records was never installed for this review to
    // audit - and the only consumer (auditLockedPackages, via verifyScaDependencies) is
    // SCA-only, so it was never read back either. The version a declared range resolves to
    // is a different question, and classifyDeps asks it in both artifacts.
    lockPackages: reviewerInstalls ? lockedPackages(addon) : [],
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
 * spec, or - where a lock is authoritative - a range that lock resolves) and a GitHub URL
 * (audited by popularity, like a VENDOR.md github source). The rest are surfaced, not
 * dropped: a range nothing resolves is `unpinned` (the dep is real but names no one
 * release to verify against), and any other non-registry spec
 * (file:/link:/workspace:/tarball/non-github git) is `unsupported` - UNLESS it is a
 * file:/link: spec that `resolvedLocal` already confirmed resolves to a real directory
 * inside this submission, in which case it names authored code, not a dependency: it is
 * dropped entirely (its own deps, if any, were classified separately - see
 * resolvePackages). An `npm:` alias is a registry install under another name, so it is
 * classified by what it INSTALLS.
 *
 * `packages` is what gets audited and byte-matched, so it must name an exact version. A range
 * that resolves to none is split by WHY, because the two have different remedies and a
 * submission must never be told both: `unlocked` where no lock was committed at all (commit
 * one, or pin the spec), `unpinned` where one was and it resolves nothing for that name
 * (regenerate it, or pin the spec). Split here rather than in either check, because this is
 * the only place that knows both facts at once.
 * @param {import("./manifest.js").DeclaredDependency[]} deps  Declarations to classify,
 *   already normalized by declaredDependencies.
 * @param {Addon} addon  Needed to pin a range against a lock file (lockedVersion
 *   also reads the lock's devDependencies) - always the top-level addon, even when `deps`
 *   came from a nested manifest: only the ROOT lock is ever consulted by `npm ci`.
 * @param {string} file  The declaring manifest's own store-relative path - "package.json"
 *   for the root, or a nested manifest's own path. Carried on every produced item so a
 *   finding anchors at the file that actually declared it.
 * @param {?Set<string>} resolvedLocal  Names, declared in THIS manifest, whose file:/link:
 *   spec already resolved to a real submission directory (from resolveLocalManifests).
 * @returns {{packages: {name: string, version: string, file: string}[],
 *   unpinned: {name: string, spec: string, file: string}[],
 *   unlocked: {name: string, spec: string, file: string}[],
 *   githubDeps: {name: string, spec: string, repo: string, ref: ?string, file: string}[],
 *   unsupported: {name: string, spec: string, file: string}[]}}
 */
function classifyDeps(deps, addon, file, resolvedLocal) {
  const packages = [];
  const unpinned = [];
  const unlocked = [];
  const githubDeps = [];
  const unsupported = [];
  for (const { map, name, spec, installs } of deps) {
    // Classified by what npm INSTALLS, reported by what the developer WROTE. The two come
    // apart for an `npm:` alias, where the spec names another package: the source, the pin
    // and the audited release are all the target's, while a finding has to quote the
    // spelling in the file or it names a declaration nobody can find.
    const target = installs ?? { name, spec };
    if (EXACT.test(target.spec)) {
      packages.push({
        name: target.name,
        version: target.spec.replace(/^v/, ""),
        file,
      });
    } else if (/[:/]/.test(target.spec)) {
      // A non-registry spec. A GitHub source is allowed (popularity-gated); a file:/link:
      // spec that resolves inside the submission is authored code (dropped, see above);
      // every other source (workspace:/tarball/non-github git, or a file:/link: that does
      // NOT resolve) is not supported and is rejected rather than silently ignored.
      const gh = parseGithubSpec(target.spec);
      if (gh) {
        githubDeps.push({ name, spec, repo: gh.repo, ref: gh.ref, file });
      } else if (resolvedLocal?.has(declarationKey(map, name))) {
        continue;
      } else {
        unsupported.push({ name, spec, file });
      }
    } else {
      // A range, which names one release only through a lock. Read in EITHER artifact: a
      // developer who ships a range is asked to commit the lock beside it, and what that
      // lock records is the version that was bundled.
      //
      // Looked up by the WRITTEN name, which is what keys the lock's entry - npm records
      // an alias under the name it is declared as and states the target inside it - while
      // the package that comes out is the target, because that is what OSV knows.
      const version = lockedVersion(addon, name);
      if (version) {
        packages.push({ name: target.name, version, file });
      } else if (governingLock(addon)) {
        unpinned.push({ name, spec, file });
      } else {
        unlocked.push({ name, spec, file });
      }
    }
  }
  return { packages, unpinned, unlocked, githubDeps, unsupported };
}

/**
 * Classify one manifest's package.json `dependencies` (all buckets) and `devDependencies`
 * (pinned npm only -> `devPackages`, plus its SOURCE buckets when `includeDevSource`).
 * Dev deps never ship, but whoever installs from this manifest runs them, so a pinned npm
 * dev dep is OSV-audited and popularity-gated like a production one (verifyScaDependencies)
 * and WHO it comes from is judged the same way. The one thing deliberately NOT kept is
 * pinning: nothing vendors from a dev dep, so no release is ever fetched to compare.
 * A name declared in several maps is classified once, as whichever copy npm installs:
 * `dependencies` over `devDependencies`, and `optionalDependencies` over `dependencies`.
 * So the audited spec is the resolved one, and the two vuln checks never double-report
 * one package.
 *
 * `optionalDependencies` is read as a BUILD-TIME dependency, alongside
 * `devDependencies`. npm installs it when the platform allows and records it in the lock,
 * so whoever installs from this manifest runs it, which is the whole of the dev bucket's
 * reasoning; and what it usually declares is a platform-specific binary rather than
 * anything the add-on ships. Reading it here is also what closes it: the lock's own
 * direct-dependency set spans every declaration map (src/vendor/locks.js), so an entry the
 * tree audit skips as DECLARED has to be one a declared audit actually receives.
 *
 * `peerDependencies` is the one map not read at all - the host supplies those rather than
 * this build, so they are never a declaration this review acts on.
 * @param {object} pkg  A manifest from readManifest (the root's, or a nested one's).
 * @param {Addon} addon  Always the TOP-LEVEL addon - only the root lock is ever consulted.
 * @param {string} file  This manifest's own store-relative path, carried on every item.
 * @param {?Set<string>} resolvedLocal  Names declared in THIS manifest whose file:/link:
 *   spec already resolved (see classifyDeps).
 * @param {boolean} includeDevSource  Whether a devDependency is judged on its SOURCE
 *   (unsupported/githubDeps) as well as its pin. True for the root where the reviewer
 *   installs (see resolveVendor); always true for a nested manifest, since `npm ci`
 *   installs a file:/link:-linked package's devDependencies unconditionally, regardless of
 *   what governs the root's own dev/prod split.
 * @returns {{packages: {name: string, version: string, file: string}[],
 *   unpinned: {name: string, spec: string, file: string}[],
 *   unlocked: {name: string, spec: string, file: string}[],
 *   githubDeps: {name: string, spec: string, repo: string, ref: ?string, file: string}[],
 *   unsupported: {name: string, spec: string, file: string}[],
 *   devPackages: {name: string, version: string, file: string}[]}}
 */
function classifyManifest(pkg, addon, file, resolvedLocal, includeDevSource) {
  const declared = declaredDependencies(pkg);
  // One name may appear in several maps, and npm defines which copy it installs for
  // each pair. Audit that copy alone, so a release is judged on the spec npm resolves
  // and every name is reported once.
  //
  // `optionalDependencies` overrides `dependencies` ("Entries in optionalDependencies
  // will override entries of the same name in dependencies", npm's package.json docs),
  // so the prod copy of such a name is the one npm discards.
  const optionalNames = new Set(
    declared.filter((d) => d.map === "optionalDependencies").map((d) => d.name)
  );
  const prod = declared.filter(
    (d) => d.map === "dependencies" && !optionalNames.has(d.name)
  );
  // `dependencies` in turn overrides `devDependencies`, so a surviving prod name makes
  // its dev copy the discarded one. devPackages is build-time-ONLY.
  const prodNames = new Set(prod.map((d) => d.name));
  const devOnly = declared.filter(
    (d) =>
      BUILD_TIME_MAPS.includes(d.map) &&
      !prodNames.has(d.name) &&
      (d.map === "optionalDependencies" || !optionalNames.has(d.name))
  );
  const prodBuckets = classifyDeps(prod, addon, file, resolvedLocal);
  const devBuckets = classifyDeps(devOnly, addon, file, resolvedLocal);
  return {
    ...prodBuckets,
    // Where the reviewer installs, a dev dependency is judged on WHO it comes from
    // exactly as a production one is: `npm ci` clones and RUNS it on their machine, so an
    // unidentifiable source is equally unverifiable and an obscure repo equally unvetted.
    // Not where nothing installs from this manifest, though - a dev entry installs and
    // vendors nothing there, so rejecting it would reject a declaration that does nothing.
    unsupported: includeDevSource
      ? [...prodBuckets.unsupported, ...devBuckets.unsupported]
      : prodBuckets.unsupported,
    githubDeps: includeDevSource
      ? [...prodBuckets.githubDeps, ...devBuckets.githubDeps]
      : prodBuckets.githubDeps,
    devPackages: devBuckets.packages,
  };
}

/**
 * Classify the submission's whole dependency graph: the root manifest, plus - in SCA mode -
 * every manifest reached by a chain of file:/link: local packages (resolveLocalManifests).
 * A linked package's code is authored, reviewed wherever it sits (its file:/link: entry is
 * dropped from `unsupported` entirely, not reported), but ITS OWN declared dependencies are
 * real external sources `npm ci` installs, so they are classified exactly like the root's -
 * always with BOTH `dependencies` and `devDependencies` in source scope, since a linked
 * package's devDependencies install unconditionally (verified: `npm ci` pulls them from the
 * registry regardless of what governs the root's own prod/dev split).
 * @param {Addon} addon
 * @param {boolean} reviewerInstalls  Whether the reviewer INSTALLS from this artifact - see
 *   resolveVendor. Also gates whether file:/link: targets are resolved at all: XPI mode
 *   never ships a local package source tree, so there is nothing to walk there.
 * @returns {{packages: {name: string, version: string, file: string}[],
 *   unpinned: {name: string, spec: string, file: string}[],
 *   unlocked: {name: string, spec: string, file: string}[],
 *   githubDeps: {name: string, spec: string, repo: string, ref: ?string, file: string}[],
 *   unsupported: {name: string, spec: string, file: string}[],
 *   devPackages: {name: string, version: string, file: string}[]}}
 */
function resolvePackages(addon, reviewerInstalls) {
  const pkg = readManifest(submissionFiles(addon));
  if (!pkg) {
    return {
      packages: [],
      unpinned: [],
      unlocked: [],
      githubDeps: [],
      unsupported: [],
      devPackages: [],
    };
  }
  const { targets, manifests } = reviewerInstalls
    ? resolveLocalManifests(addon)
    : { targets: [], manifests: [] };
  // Keyed by DECLARATION, never by name: one name may be written in several maps with
  // different specs, and a resolved file:/link: spec exempts the declaration that resolved
  // and no other. Keyed by name, a harmless `"x": "file:."` under devDependencies would
  // exempt whatever else the manifest declares as `x` - and npm installs that one, since
  // the dependencies copy wins over devDependencies.
  const resolvedByFile = new Map();
  for (const t of targets) {
    if (!resolvedByFile.has(t.declaringFile)) {
      resolvedByFile.set(t.declaringFile, new Set());
    }
    resolvedByFile.get(t.declaringFile).add(declarationKey(t.map, t.name));
  }

  const out = classifyManifest(
    pkg,
    addon,
    MANIFEST_FILE,
    resolvedByFile.get(MANIFEST_FILE),
    reviewerInstalls
  );
  for (const m of manifests) {
    const nested = classifyManifest(
      m.pkg,
      addon,
      m.file,
      resolvedByFile.get(m.file),
      true
    );
    out.packages.push(...nested.packages);
    out.unpinned.push(...nested.unpinned);
    out.unlocked.push(...nested.unlocked);
    out.githubDeps.push(...nested.githubDeps);
    out.unsupported.push(...nested.unsupported);
    out.devPackages.push(...nested.devPackages);
  }
  return out;
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
