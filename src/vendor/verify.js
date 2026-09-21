// The network half of vendor resolution, run ONCE before normalize and review.
// resolveVendor (offline) settled the no-url / untrusted / unpinned cases into
// addon.vendor.results. This step does the work that needs the network and
// writes its results into the same shared store, so the review-phase checks
// only read it (nothing is fetched twice).
//
// Three sources are verified:
//   - a VENDOR entry declaring a DIRECTORY: fetch the upstream release as one
//     archive - a github /tree/ repo ZIP, or a pinned npm package's registry
//     tarball - and match every packaged file under the directory against its
//     contents. One line can then cover a library that ships as many files,
//     including the ones it does not name. A source that is neither of those two
//     cannot answer for a directory and never reaches here: resolveVendor settles
//     it offline, because such a URL is usually fetchable (a CDN directory answers
//     with an HTML listing page) and only the unpacking would fail.
//   - VENDOR entries that are trusted-host + pinned: fetch the declared URL and
//     EOL-tolerant compare against the packaged bytes (verified / modified),
//     then gate on popularity (verified / not-popular), one reading per package
//     however many entries name it - except a github source
//     from a first-party trusted org (e.g. github.com/thunderbird/...) is
//     accepted by provenance, skipping the popularity bar. An unfetchable URL
//     records the covered files as unfetchable, which applyUnverifiedVendor
//     reconciles into the untrusted family. An npm-sourced entry is also OSV-audited
//     (auditNpm); a github-sourced one (bar a first-party org) is run through
//     auditGithub, which tries to PROVE an npm twin by content-hash matching the
//     repo-name candidate, and audits it, recording the rest as unaudited.
//   - package.json dependencies pinned to a version: fetch the published file
//     listing from unpkg ONCE (it carries a per-file sha256 integrity) and mark
//     vendored any packaged file whose content hash matches a published file's
//     integrity - matched locally, no file bytes downloaded, so it scales to a
//     large package. A file that does not hash-match is left alone, as it may be
//     the author's own code or a modified copy. The same pinned name@version is
//     also audited against OSV (auditNpm); known advisories are recorded for
//     the vendor-vulnerable check.
//   - the whole installed tree, in a source-code review only: every package the
//     committed lock file records, declared or pulled in by another package, is
//     OSV-audited in one batch (auditLockedPackages). This is where almost all of
//     a submission's exposure sits, since a real tree is mostly packages nobody
//     wrote down.
//
// The popularity lookups are METERED as well as made. They go to one host per kind,
// which answers a burst by refusing - and a refusal reaching a caller as an exception
// is indistinguishable from "no such package", which demotes the library. So the
// reading is memoized per package for the run, the requests are spaced, and a refusal
// is retried; only an answer, or an exhausted retry, reaches the bar itself.
//
// Belongs here: verifyVendor and verifyScaDependencies (the two batches), the
// per-source compare, the popularity lookup and the pacing it needs, the OSV audits,
// and the default network transport. Does NOT belong here: URL classification (-> sources.js),
// the offline parse and the lock enumeration (-> resolve.js, locks.js), the host
// allowlist + thresholds (-> config.js), and the finding/manual routing (-> the
// vendor checks + registry).

import { createHash } from "node:crypto";

import { classifySource } from "./sources.js";
import { rethrowIfNetworkGone } from "../util/net.js";
import { tarballHashes, tarballFileHashes } from "./tarball.js";
import { zipHashesUnder } from "./archive.js";
import { isVendored, declaredFiles } from "./resolve.js";
import { npmNameForLibrary } from "../lib/library-hashes.js";
import { matchLibraryBlock } from "../lib/library-blocks.js";
import { normalizedSha256, eolNormalize } from "../normalize/hash.js";
import { fetchWithTimeout } from "../util/net.js";
import { debug } from "../util/log.js";
import {
  VENDOR_NPM_MIN_DOWNLOADS,
  VENDOR_GITHUB_MIN_STARS,
  VENDOR_TRUSTED_GITHUB_ORGS,
  VENDOR_NPM_DOWNLOADS_API,
  VENDOR_GITHUB_REPOS_API,
  VENDOR_POPULARITY_MIN_INTERVAL_MS,
  VENDOR_POPULARITY_RETRIES,
  VENDOR_POPULARITY_BACKOFF_MS,
  VENDOR_GROUP_MIN_ENTRIES,
  VENDOR_FETCH_TIMEOUT_MS,
  VENDOR_FETCH_MAX_BYTES,
  VENDOR_OSV_API,
  VENDOR_OSV_BATCH_API,
  VENDOR_OSV_VULN_API,
  VENDOR_OSV_BATCH_SIZE,
  VENDOR_OSV_HYDRATE_MAX,
  VENDOR_TREE_BANDS,
} from "../config.js";

/** @typedef {import("../addon/load.js").Addon} Addon */
/** @typedef {import("./resolve.js").VendorStore} VendorStore */
/** @typedef {import("./sources.js").VendorSource} VendorSource */
/**
 * @typedef {{fetchBytes: (url: string) => Promise<Buffer>,
 *   fetchJson: (url: string) => Promise<object>,
 *   postJson: (url: string, body: object) => Promise<object>}} VendorNet
 */
/**
 * @typedef {object} VendorVuln  One vulnerable npm package (OSV audit) - a
 * package.json dependency, an npm-sourced VENDOR entry, or a hash-identified
 * (undeclared) bundled library.
 * @property {string} name  npm package name.
 * @property {string} version  The bundled (pinned/identified) version audited.
 * @property {string[]} ids  Advisory ids (CVE preferred, else OSV/GHSA).
 * @property {string} severity  Highest reported severity, or "unknown".
 * @property {string[]} fixed  Versions the advisories were fixed in (may be
 *   empty).
 * @property {string} file  Where the finding anchors (package.json, the VENDOR
 *   file, or the bundled library file itself).
 * @property {string} token  The string locating the declaration line in `file`,
 *   or "" when there is none (an identified library has no declaration line, so
 *   the finding anchors at the file with no line).
 */
/**
 * @typedef {object} MetaNode  A node in an unpkg "?meta" listing. unpkg returns
 * a flat `files` array whose entries each carry a `path` and a `type` that is
 * the file's MIME type (e.g. "application/javascript") - NOT the literal
 * "file". The listing root (and any directory node in the older nested form)
 * instead carries a `files` child array, so a node is a FILE when it has a
 * `path` and no `files`.
 * @property {string} [path]  The published path.
 * @property {string} [type]  A file's MIME type, or "directory" (nested form).
 * @property {string} [integrity]  A file's Subresource-Integrity hash, e.g.
 *   "sha256-<base64>" (used to match without downloading the bytes).
 * @property {MetaNode[]} [files]  Child nodes (the listing root / a directory).
 */

/**
 * Verify the resolved vendor declarations over the network, appending per-file
 * results to (and extending the skip-set of) the shared `addon.vendor` store.
 * The shipped-XPI batch: the VENDOR declarations PLUS the declared package.json
 * dependencies, whose shipped copies are matched against the published tarball.
 * @param {Addon} addon  Must already carry `addon.vendor` from resolveVendor.
 * @param {VendorNet} [net]
 * @param {?Map<string, object>} [blocks]  The Mozilla policy blocklist, applied to
 *   these shipped/declared libraries (see auditNpm).
 * @returns {Promise<void>}
 */
export async function verifyVendor(addon, net = defaultNet, blocks) {
  await verifyVendorDeclarations(addon, net, blocks);
  const vendor = addon?.vendor;
  if (!vendor) {
    return;
  }
  for (const pkg of vendor.packages) {
    await verifyPackage(pkg, addon, vendor, net);
    await auditNpm(
      pkg.name,
      pkg.version,
      "package.json",
      pkg.name,
      vendor,
      net,
      vendor.vulnerabilities,
      blocks
    );
  }
  // A `not-popular` outcome is reconciled into addon.bundled.untrusted later, by
  // applyUnverifiedVendor (src/lib/bundled.js), because addon.bundled is
  // built AFTER this step in the pipeline. It stays in vendor.results until then.
}

/**
 * Verify a VENDOR file's declarations, and ONLY those: each declared path is compared
 * against the bytes its declared source serves, and the outcome recorded on
 * `vendor.results`. Split out of verifyVendor because it applies to whichever artifact
 * carries the declarations - a shipped XPI, or a submitted source archive, where the
 * declared file is likewise committed and present to hash. The package.json half of
 * verifyVendor does NOT apply to a source archive: dependencies are installed at build
 * time, so there is nothing there to compare (see verifyPackage).
 *
 * Verification is what EARNS a declaration its exemption: an entry that does not verify
 * leaves a result row that applyUnverifiedVendor reconciles into the untrusted family, so
 * the file is reviewed as the developer's own code. Without this step the exemption is
 * granted on the declaration alone.
 *
 * @param {Addon} addon  Must already carry `addon.vendor` from resolveVendor.
 * @param {VendorNet} [net]
 * @param {?Map<string, object>} [blocks]  The Mozilla policy blocklist (see auditNpm).
 * @returns {Promise<void>}
 */
export async function verifyVendorDeclarations(
  addon,
  net = defaultNet,
  blocks
) {
  const vendor = addon?.vendor;
  if (!vendor) {
    return;
  }
  // Which entries name one npm package@version, so it is fetched and audited once
  // however many files it covers. Computed up front, but each group is RESOLVED
  // lazily, at the first entry that needs it - so the walk stays in manifest order
  // and vendor.results, vendor.vulnerabilities and the feed all keep the order they
  // had when every entry stood alone.
  const groups = groupNpmSources(vendor.manifest);
  // VENDOR entries known trusted + pinned (the rest were settled offline).
  for (const entry of vendor.manifest) {
    if (!entry.trusted || !entry.pinned) {
      continue;
    }
    // A folder declaration: every packaged file under the directory is matched
    // against the upstream release fetched as one archive - a repo ZIP scoped to
    // the declared subpath, or a pinned npm package's tarball - one result each.
    if (entry.kind === "folder") {
      await verifyFolder(entry, addon, vendor, net);
      continue;
    }
    // A whole-package tarball source (npm registry) is extracted + per-file hash
    // matched; a single-file source is byte-compared, against the package its group
    // already fetched when there is one.
    const src = classifySource(entry.sourceUrl);
    const group = groups.get(groupKey(entry));
    if (group) {
      await resolveGroup(group, vendor, net, blocks);
    }
    const outcome = group?.state
      ? await verifyGrouped(entry, group, addon, vendor, net)
      : src.tarball
        ? await verifyTarball(entry, addon, vendor, net)
        : await verifyUrl(entry, addon, vendor, net);
    vendor.results.push({
      path: entry.path,
      source: entry.sourceUrl,
      outcome,
    });
    // An npm-sourced VENDOR lib is also audited for known vulnerabilities (the
    // same OSV query as a package.json dep), anchored at its VENDOR-file line -
    // once per package, which is resolveGroup's job for everything it groups.
    // A github source carries no npm identity directly, so auditGithub tries to
    // PROVE one (content-hash match against a candidate npm package) and audit
    // it too; an unprovable one is recorded as unaudited.
    if (group) {
      continue; // already audited, with the rest of its package
    }
    if (src.kind === "npm") {
      await auditNpm(
        src.pkg,
        src.version,
        vendor.vendorFile,
        entry.sourceUrl,
        vendor,
        net,
        vendor.vulnerabilities,
        blocks
      );
    } else if (src.kind === "github") {
      await auditGithub(entry, src, addon, vendor, net, blocks);
    }
  }
}

/**
 * SCA (source code archive) dependency audit: the network half for SCA mode,
 * the analogue of verifyVendor for XPI mode. The source archive's package.json
 * is the only dependency manifest (no VENDOR.md, no hash/CDN matching - the built
 * libraries are not present in the readable source and are mangled in the XPI).
 * For each pinned dependency it records (a) OSV advisories (auditNpm ->
 * vendor.vulnerabilities, read by vendor-vulnerable) and (b) a non-popular verdict
 * (-> vendor.unpopularDeps, read by unpopular-source-dependency): a dependency
 * that is not a confirmed widely-used library is pulled in at build and cannot be
 * reviewed, so the developer must ship its readable source in --sca-source. Each
 * pinned devDependency additionally gets (c) an OSV audit (-> vendor.devVulnerabilities,
 * read by vendor-vulnerable-dev) but no popularity gate: the reviewer builds from
 * source, so a vulnerable build tool is a real risk, while a niche-but-legit one
 * must not be rejected as unpopular. Finally (d) the whole installed tree from the
 * committed lock file is audited in one batch (auditLockedPackages ->
 * vendor.treeVulnerabilities / treeDevVulnerabilities), which is where almost all
 * of a submission's exposure actually sits.
 *
 * Popularity uses a direct npm-downloads lookup (npmDownloads), not isPopular, so
 * a FAILED lookup skips rather than false-rejecting a popular dependency; offline
 * runs (the listing/downloads throw) therefore record nothing.
 * @param {Addon} addon  Must already carry `addon.vendor` from resolveVendor.
 * @param {VendorNet} [net]
 * @param {?Map<string, object>} [blocks]  The Mozilla policy blocklist, applied to
 *   the declared (shipped) dependencies - NOT to devDependencies (never shipped).
 * @returns {Promise<void>}
 */
export async function verifyScaDependencies(addon, net = defaultNet, blocks) {
  const vendor = addon?.vendor;
  if (!vendor) {
    return;
  }
  for (const pkg of vendor.packages) {
    await auditNpm(
      pkg.name,
      pkg.version,
      "package.json",
      pkg.name,
      vendor,
      net,
      vendor.vulnerabilities,
      blocks
    );
    const downloads = await npmDownloads(pkg.name, net);
    if (downloads !== null && downloads < VENDOR_NPM_MIN_DOWNLOADS) {
      vendor.unpopularDeps.push({
        name: pkg.name,
        version: pkg.version,
        file: "package.json",
        token: pkg.name,
      });
    }
  }
  // GitHub-sourced deps clear the bar by stars (or a trusted-org free pass) - the
  // same popularity check a VENDOR.md github source gets. No content/OSV audit
  // here: the build pulls the code from GitHub at build time, so it is not present
  // to hash. A failed lookup records nothing (like npmDownloads above).
  for (const dep of vendor.githubDeps ?? []) {
    const popular = await githubPopular(dep.repo, net);
    if (popular === false) {
      vendor.unpopularDeps.push({
        name: dep.name,
        version: dep.spec,
        file: "package.json",
        token: dep.name,
      });
    }
  }
  // Dev dependencies never ship, but the reviewer builds the add-on from source,
  // so a vulnerable build tool runs on the reviewer's machine. Audit each pinned
  // npm dev dep for OSV only - no popularity gate (a niche-but-legit build tool is
  // fine) - recording hits on devVulnerabilities for the vendor-vulnerable-dev check.
  for (const pkg of vendor.devPackages ?? []) {
    // No blocklist here: a devDependency is never shipped, so the shipped-library
    // policy does not apply. It is OSV-audited (into devVulnerabilities) but never
    // recorded as a banned-library - auditNpm is passed no `blocks`.
    await auditNpm(
      pkg.name,
      pkg.version,
      "package.json",
      pkg.name,
      vendor,
      net,
      vendor.devVulnerabilities
    );
  }
  // Last, so every declared package is already recorded and the tree audit can
  // leave those out.
  await auditLockedPackages(vendor, net);
}

/**
 * Audit the packages the lock file installs that NOTHING declares - the ~90% of
 * a real dependency tree that arrives because a declared package asked for it.
 * A reviewer running the install sees these advisories; without this the linter
 * would only ever see the handful of names in package.json.
 *
 * Two things are deliberately NOT applied here, both of which the declared
 * dependencies do get:
 *   - the Mozilla policy blocklist, whose wording is about the library versions
 *     an add-on SHIPS, and whose banned verdict short-circuits the OSV query -
 *     control flow a batched request cannot express;
 *   - the popularity gate, which asks whether the developer chose a reputable
 *     library. Nobody chose these, so the question does not arise, and asking it
 *     would cost one request per package.
 * The single-package endpoint is likewise kept for declared dependencies: they
 * are reported at every severity, and it answers severity and fixed versions in
 * one request, while the batch endpoint returns bare ids that must be hydrated.
 *
 * Only high and critical are recorded (VENDOR_TREE_BANDS): a package nobody
 * declared is worth the developer's attention when it fails the review, not
 * when it merely appears in a report. A MALICIOUS-package advisory is the one
 * exception (isMaliciousAdvisory) - those state no severity at all, so a band
 * rule alone would discard exactly the records that matter most here.
 *
 * All-or-nothing: results are held until every chunk has answered, so a scan the
 * network cuts short records NOTHING rather than a partial tree that reads like
 * a clean one.
 * @param {VendorStore} vendor  Must carry lockPackages (resolveVendor).
 * @param {VendorNet} net
 * @returns {Promise<void>}
 */
async function auditLockedPackages(vendor, net) {
  const queue = (vendor.lockPackages ?? []).filter(
    (p) => !alreadyAudited(vendor, p)
  );
  if (!queue.length) {
    return;
  }
  /** @type {Map<string, ?OsvVuln>} */
  const advisories = new Map();
  /** @type {VendorVuln[]} */
  const shipped = [];
  /** @type {VendorVuln[]} */
  const buildTime = [];
  for (let at = 0; at < queue.length; at += VENDOR_OSV_BATCH_SIZE) {
    const chunk = queue.slice(at, at + VENDOR_OSV_BATCH_SIZE);
    let results;
    try {
      const res = await net.postJson(VENDOR_OSV_BATCH_API, {
        queries: chunk.map((p) => ({
          version: p.version,
          package: { name: p.name, ecosystem: "npm" },
        })),
      });
      results = Array.isArray(res?.results) ? res.results : [];
    } catch (err) {
      rethrowIfNetworkGone(err);
      return; // offline / no postJson / OSV unreachable - abandon the scan
    }
    // The endpoint answers positionally, one result per query, and says nothing
    // about which package each answer is for - hence the index, and hence the
    // tolerance for a short array rather than a trusted pairing.
    for (let i = 0; i < chunk.length; i++) {
      const pkg = chunk[i];
      const hits = results[i]?.vulns;
      const vulns = [];
      for (const hit of Array.isArray(hits) ? hits : []) {
        const full = hit?.id
          ? await hydrateAdvisory(hit.id, advisories, net)
          : null;
        if (full) {
          vulns.push(full);
        }
      }
      const record = vulnRecord(
        pkg.name,
        pkg.version,
        vulns,
        pkg.file,
        pkg.token
      );
      if (!record || !reportableInTree(record, vulns)) {
        continue;
      }
      (pkg.dev ? buildTime : shipped).push(record);
    }
  }
  vendor.treeVulnerabilities.push(...shipped);
  vendor.treeDevVulnerabilities.push(...buildTime);
}

/**
 * Whether this tree package has already been audited under another heading, so
 * the tree scan must leave it alone.
 *
 * Two different reasons, and both are needed. A package the submission DECLARES
 * belongs to vendor-vulnerable / -dev, which audit it at every severity and
 * anchor it at the line the developer wrote - and telling them it is "a package
 * this add-on does not declare" would be false. Directness is read from the lock
 * itself (LockedPackage.direct), because the root package.json parse misses the
 * forms a lock still records: an optionalDependency, a workspace member's own
 * manifest, an npm: alias, and a version the two files disagree about. Separately,
 * an exact name@version any earlier audit already recorded - an npm-sourced VENDOR
 * entry, a policy-blocked library - would simply be reported twice.
 * @param {VendorStore} vendor
 * @param {import("./locks.js").LockedPackage} pkg
 * @returns {boolean}
 */
function alreadyAudited(vendor, pkg) {
  if (pkg.direct) {
    return true;
  }
  if (
    [...vendor.packages, ...(vendor.devPackages ?? [])].some(
      (p) => p.name === pkg.name
    )
  ) {
    return true;
  }
  return [
    ...vendor.vulnerabilities,
    ...(vendor.devVulnerabilities ?? []),
    ...(vendor.blocked ?? []),
  ].some((v) => v.name === pkg.name && v.version === pkg.version);
}

/**
 * Whether a tree advisory is worth reporting. The band decides
 * (VENDOR_TREE_BANDS), with one exception: OSV's malicious-package records carry
 * no severity field at all, so they aggregate to "unknown" and a band rule would
 * discard them - while "this package is malicious" outranks every band there is.
 * @param {VendorVuln} record  The aggregated record.
 * @param {OsvVuln[]} vulns  The advisories it was built from.
 * @returns {boolean}
 */
function reportableInTree(record, vulns) {
  return (
    VENDOR_TREE_BANDS.includes(record.severity) ||
    vulns.some(isMaliciousAdvisory)
  );
}

/**
 * Whether an OSV record says the package itself is malicious rather than merely
 * vulnerable - the MAL- id scheme OSV gives its malicious-packages feed. Such a
 * record states no severity, so it is recognized by what it IS, not by a band.
 * @param {OsvVuln} v
 * @returns {boolean}
 */
function isMaliciousAdvisory(v) {
  return /^MAL-/i.test(String(v?.id ?? ""));
}

/**
 * Fetch the full OSV record for one advisory id, memoized across the scan: the
 * batch endpoint answers with bare ids, and one advisory routinely affects
 * several packages in the same tree. A failed fetch is cached as null, so a
 * missing advisory is not retried per package. `cache` also caps the scan
 * (VENDOR_OSV_HYDRATE_MAX) - past it, hits are dropped rather than fetched.
 * @param {string} id  An OSV/GHSA advisory id.
 * @param {Map<string, ?OsvVuln>} cache  Per-scan memo.
 * @param {VendorNet} net
 * @returns {Promise<?OsvVuln>}
 */
async function hydrateAdvisory(id, cache, net) {
  if (cache.has(id)) {
    return cache.get(id);
  }
  if (cache.size >= VENDOR_OSV_HYDRATE_MAX) {
    return null;
  }
  let record = null;
  try {
    record = await net.fetchJson(`${VENDOR_OSV_VULN_API}${id}`);
  } catch (err) {
    rethrowIfNetworkGone(err);
  }
  cache.set(id, record);
  return record;
}

// THE POPULARITY LOOKUPS ARE PACED BY US, NOT BY THEM. api.npmjs.org enforces a
// per-IP budget that a burst trips within about a dozen requests, and it answers a
// refusal with 429 - which arrives here as an exception indistinguishable from "no
// such package". Read as an answer, that refusal means "not widely used", which
// demotes the library and can REJECT a minified one. So an add-on vendoring many
// files was rate-limiting itself into false findings, differently on every run.
//
// Three things keep that from happening, in the order they help: the caller memoizes
// (one reading per package, not one per file - see isPopular), this gate spaces what
// is left, and a refusal is retried rather than believed. Only when all three have
// been exhausted does the unanswered lookup fall back to its old meaning.
//
// The gate is module-level because it is about OUR total rate against a host, which
// no single caller can see: the vendor step and the CDN identifier both ask, about
// different files, and neither knows what the other has spent.
const lastAsked = new Map();

let popularityIntervalMs = VENDOR_POPULARITY_MIN_INTERVAL_MS;
let popularityBackoffMs = VENDOR_POPULARITY_BACKOFF_MS;

/**
 * Shorten (or remove) the waiting, for suites that answer these requests from a
 * fixture and must not pay real time for a gate against a host they never reach.
 * Production never calls this: the shipped values are the ones in config.js.
 * @param {{intervalMs?: number, backoffMs?: number}} pacing
 */
export function setPopularityPacing({ intervalMs, backoffMs } = {}) {
  if (Number.isFinite(intervalMs)) {
    popularityIntervalMs = Math.max(0, intervalMs);
  }
  if (Number.isFinite(backoffMs)) {
    popularityBackoffMs = Math.max(0, backoffMs);
  }
}

/** @param {number} ms @returns {Promise<void>} */
function delay(ms) {
  return ms > 0
    ? new Promise((done) => setTimeout(done, ms))
    : Promise.resolve();
}

/** @param {string} url @returns {string} The host to meter, or the whole URL. */
function meteredHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return String(url);
  }
}

/**
 * Whether a failed request was the host REFUSING to answer rather than answering.
 *
 * The distinction is the whole point: 429 (budget spent), 403 (api.github.com says
 * the same thing that way), 408 and any 5xx say nothing about the package, and nor
 * does a timeout - so the reading is still out there to be had. A 404 is NOT one of
 * these: npm really does answer 404 for a package it has no download data for, and
 * retrying it would multiply our load to re-learn the same thing.
 *
 * Read off `status` when the transport attached one, and off the message otherwise,
 * so an injected net that throws a bare `new Error("HTTP 429")` is understood too.
 * @param {unknown} err
 * @returns {boolean}
 */
function refusedToAnswer(err) {
  const status = Number(err?.status);
  if (Number.isFinite(status) && status > 0) {
    return status === 429 || status === 403 || status === 408 || status >= 500;
  }
  const msg = String(err?.message ?? "");
  return (
    /\bHTTP (403|408|429|5\d\d)\b/.test(msg) ||
    /timed out after \d+ms$/.test(msg)
  );
}

/**
 * One popularity request: held back to the gate, and retried while the host is
 * refusing to answer.
 *
 * `rethrowIfNetworkGone` still runs first on every failure, so a dead route stops
 * the review here exactly as it did before - we retry a refusal, not an absence of
 * network. Anything that is not a refusal is re-thrown untouched on the first try,
 * leaving the caller's existing fallback to mean what it always meant.
 * @param {string} url @param {VendorNet} net
 * @returns {Promise<object>}
 */
async function askPopularity(url, net) {
  const host = meteredHost(url);
  for (let attempt = 0; ; attempt++) {
    const earliest = (lastAsked.get(host) ?? 0) + popularityIntervalMs;
    await delay(earliest - Date.now());
    lastAsked.set(host, Date.now());
    try {
      return await net.fetchJson(url);
    } catch (err) {
      rethrowIfNetworkGone(err);
      if (attempt >= VENDOR_POPULARITY_RETRIES || !refusedToAnswer(err)) {
        throw err;
      }
      // Retry-After wins when it names a delay; the npm endpoint currently sends
      // "retry-after: 0", which is not one, so the doubling backoff carries it.
      const wait = err?.retryAfterMs ?? popularityBackoffMs * 2 ** attempt;
      debug(
        `popularity lookup refused (${err.message}) for ${url} - retrying in ${wait}ms`
      );
      await delay(wait);
    }
  }
}

/**
 * Whether a GitHub repo clears the popularity bar (stargazers >=
 * VENDOR_GITHUB_MIN_STARS), with a trusted-org (VENDOR_TRUSTED_GITHUB_ORGS) free
 * pass. Returns null when the stars lookup fails - kept distinguishable from a
 * real below-bar reading (like npmDownloads) so an offline / flaky run records
 * nothing rather than false-rejecting a popular repo.
 * @param {string} repo  "owner/repo".
 * @param {VendorNet} net
 * @returns {Promise<boolean | null>}
 */
async function githubPopular(repo, net) {
  const owner = String(repo ?? "")
    .split("/")[0]
    .toLowerCase();
  if (VENDOR_TRUSTED_GITHUB_ORGS.includes(owner)) {
    return true; // first-party org (e.g. Thunderbird) - trusted by provenance
  }
  try {
    const j = await askPopularity(`${VENDOR_GITHUB_REPOS_API}${repo}`, net);
    const n = Number(j?.stargazers_count);
    return Number.isFinite(n) ? n >= VENDOR_GITHUB_MIN_STARS : null;
  } catch (err) {
    rethrowIfNetworkGone(err);
    return null;
  }
}

/**
 * Last-month npm download count for a package, or null when the lookup fails.
 * A failed lookup is kept distinguishable from a real below-threshold reading, so
 * the unpopular-source-dependency REJECT only ever fires on a reading. isPopular
 * collapses the same null to "not popular", because there the file has a fallback
 * to fall to; askPopularity is what makes that collapse rare. The npm download API
 * serves scoped packages too.
 * @param {string} name  npm package name.
 * @param {VendorNet} net
 * @returns {Promise<number | null>}
 */
async function npmDownloads(name, net) {
  try {
    const j = await askPopularity(`${VENDOR_NPM_DOWNLOADS_API}${name}`, net);
    const n = Number(j?.downloads);
    return Number.isFinite(n) ? n : null;
  } catch (err) {
    rethrowIfNetworkGone(err);
    return null;
  }
}

/**
 * Audit a pinned npm package@version against the OSV vulnerability database.
 * First consults the Mozilla policy blocklist `blocks` (when given): a banned
 * name@version is recorded on vendor.blocked and SKIPS the OSV query (rejected
 * regardless); an unadvised one is recorded but still audited (a live CVE on an
 * allowed library still matters). `blocks` is passed only for SHIPPED libraries, so
 * an SCA devDependency (never shipped) is audited but never policy-blocked.
 * Best-effort: a package with known advisories is recorded on
 * `into` (one entry aggregating its advisories, anchored at `file`/`token`). Any
 * network or parse error - or an injected net without `postJson` (offline runs,
 * the golden harness) - records nothing. Drives package.json deps and npm-sourced
 * VENDOR entries -> vendor.vulnerabilities (read by vendor-vulnerable), and SCA
 * devDependencies -> vendor.devVulnerabilities (read by vendor-vulnerable-dev); the
 * caller passes the target `into` array.
 * @param {string} name  npm package name.
 * @param {string} version  The bundled (pinned) version.
 * @param {string} file  Where the finding anchors (package.json / the VENDOR
 *   file).
 * @param {string} token  The string locating the declaration line in `file`.
 * @param {VendorStore} vendor @param {VendorNet} net
 * @param {VendorVuln[]} into  The array to record a hit on: vendor.vulnerabilities
 *   for shipped/declared deps, or vendor.devVulnerabilities for SCA dev deps.
 *   Explicit - never defaulted - so a hit is never silently mis-bucketed.
 * @param {?Map<string, object>} [blocks]  The Mozilla policy blocklist to apply
 *   (assets/library-blocks.yaml); absent/null for an SCA devDependency (never
 *   shipped, so never policy-blocked).
 * @returns {Promise<void>}
 */
async function auditNpm(name, version, file, token, vendor, net, into, blocks) {
  // The Mozilla policy blocklist is consulted BEFORE the OSV query (see the JSDoc):
  // a banned version records a hit and returns (no OSV); an unadvised one records a
  // hit and still audits. `blocks` is passed only for shipped libraries.
  const block = matchLibraryBlock(blocks, name, version);
  if (block) {
    (vendor.blocked ??= []).push({
      name,
      version,
      status: block.status,
      reason: block.reason,
      file,
      token,
    });
    if (block.status === "banned") {
      return;
    }
  }
  let vulns;
  try {
    const res = await net.postJson(VENDOR_OSV_API, {
      // OSV npm versions carry no "v" prefix. A vendored URL may (e.g.
      // "@v1.2.3").
      version: String(version).replace(/^v/i, ""),
      package: { name, ecosystem: "npm" },
    });
    vulns = Array.isArray(res?.vulns) ? res.vulns : [];
  } catch (err) {
    rethrowIfNetworkGone(err);
    return; // offline / no postJson / OSV unreachable - skip silently
  }
  const record = vulnRecord(name, version, vulns, file, token);
  if (record) {
    into.push(record);
  }
}

/**
 * Aggregate the advisories OSV returned for one package into the single record
 * a finding is built from: every advisory's preferred id, every fixed version it
 * names for this package, and the worst severity among them. Null when there are
 * no advisories.
 *
 * Shared by the two audits, which differ only in how they ASK: auditNpm queries
 * one package and is answered with whole advisory records, while
 * auditLockedPackages queries hundreds and hydrates the bare ids it gets back.
 * What an advisory MEANS is the same either way, so it is read in one place.
 * @param {string} name  npm package name.
 * @param {string} version  The version audited.
 * @param {OsvVuln[]} vulns  The advisories OSV reported for it.
 * @param {string} file  Where the finding anchors.
 * @param {string} token  The string locating the declaration line in `file`.
 * @returns {?VendorVuln}
 */
function vulnRecord(name, version, vulns, file, token) {
  if (!vulns.length) {
    return null;
  }
  const ids = new Set();
  const fixed = new Set();
  let severity = "unknown";
  for (const v of vulns) {
    ids.add(advisoryId(v));
    for (const f of fixedVersions(v, name)) {
      fixed.add(f);
    }
    severity = worseSeverity(severity, vulnSeverity(v));
  }
  return {
    name,
    version,
    ids: [...ids],
    severity,
    fixed: [...fixed],
    file,
    token,
  };
}

/**
 * OSV-audit the libraries identified by content hash (addon.bundled.classified
 * entries carrying a libraryId) - the undeclared third-party libraries the hash
 * classifier recognized. A declared/vendored copy is excluded before
 * classification, so this catches exactly the bundles a developer shipped without
 * a VENDOR declaration: the same auditNpm an npm dep gets, so an undeclared
 * vulnerable jquery is flagged just like a declared one. The dispensary name is
 * mapped to its npm package (npmNameForLibrary); the finding anchors at the
 * bundled file with no line (an undeclared library has no declaration line, so
 * the token is empty). Each release is audited at most once: a package already
 * flagged as a declared dep / VENDOR entry, or the same library bundled in more
 * than one file, is not re-queried or double-reported. Best-effort: runs after
 * classifyBundled, shares the OSV transport, and skips silently offline. Requires
 * addon.vendor (resolveVendor) for the shared vulnerabilities store.
 * @param {Addon} addon  Must carry addon.vendor and addon.bundled.
 * @param {VendorNet} [net]
 * @param {?Map<string, object>} [blocks]  The Mozilla policy blocklist (applied to
 *   these identified, hence shipped, libraries; see auditNpm).
 * @returns {Promise<void>}
 */
export async function auditIdentifiedLibraries(
  addon,
  net = defaultNet,
  blocks
) {
  const vendor = addon?.vendor;
  const classified = addon?.bundled?.classified;
  if (!vendor || !classified) {
    return;
  }
  // Skip a release already recorded - as a declared dep / VENDOR entry
  // (vulnerabilities), or as a policy hit (blocked, which a BANNED library never adds
  // to vulnerabilities) - and collapse the same library bundled in several files to
  // one audit. Seeding `seen` from `blocked` too keeps a declared-AND-bundled banned
  // library from being recorded twice.
  const seen = new Set(
    [...vendor.vulnerabilities, ...vendor.blocked].map(
      (v) => `${v.name}@${v.version}`
    )
  );
  for (const tag of classified) {
    if (!tag.libraryId) {
      continue;
    }
    // A CDN match identified via a GitHub source has no npm identity (its name is
    // "owner/repo"), so the npm OSV query would be meaningless - skip it. Hash-DB
    // and npm-CDN matches are npm packages and audited normally.
    if (tag.cdn && tag.cdn.type !== "npm") {
      continue;
    }
    const name = npmNameForLibrary(tag.libraryId.name);
    const key = `${name}@${tag.libraryId.version}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    await auditNpm(
      name,
      tag.libraryId.version,
      tag.file,
      "",
      vendor,
      net,
      vendor.vulnerabilities,
      blocks
    );
  }
}

/**
 * Try to audit a github-sourced VENDOR entry via its npm twin. A first-party
 * trusted org (VENDOR_TRUSTED_GITHUB_ORGS) stays completely silent - no audit,
 * no unaudited record. Otherwise an npm identity is PROVEN by content-hash
 * matching the bundled bytes against the candidate package's published files
 * (npmHashMatches - path-independent, no bytes downloaded), the candidate being
 * repo name @ ref-without-v. The hash is the proof, so a package whose name differs
 * from its repo (a scoped or renamed one) stays unresolved rather than guessed at.
 * A proven identity is audited (auditNpm, anchored at the VENDOR-file
 * source line - the developer sees the declared github URL, never the resolved
 * npm one); an unresolved entry is recorded on vendor.unaudited for the
 * vendor-vuln-unknown check.
 * @param {import("../normalize/vendor.js").VendorEntry & {trusted: boolean, pinned: boolean}} entry
 * @param {VendorSource} src  The classified github source (carries repo + ref).
 * @param {Addon} addon @param {VendorStore} vendor @param {VendorNet} net
 * @param {?Map<string, object>} [blocks]  The Mozilla policy blocklist (applied to a
 *   proven npm twin; see auditNpm).
 * @returns {Promise<void>}
 */
async function auditGithub(entry, src, addon, vendor, net, blocks) {
  const owner = String(src.repo ?? "")
    .split("/")[0]
    .toLowerCase();
  if (VENDOR_TRUSTED_GITHUB_ORGS.includes(owner)) {
    // First-party (e.g. Thunderbird) - trusted by provenance: no OSV audit, and no
    // policy blocklist check either (a first-party org is not expected to ship a
    // banned upstream). The same boundary the OSV audit already draws.
    return;
  }
  const bundled = addon.files.get(entry.path) ?? Buffer.alloc(0);
  const version = String(src.ref ?? "").replace(/^v/i, "");

  // (a) Deterministic: the npm package usually shares the repo name.
  const repoName = String(src.repo ?? "")
    .split("/")
    .slice(1)
    .join("/");
  if (
    repoName &&
    version &&
    (await npmHashMatches(repoName, version, bundled, net))
  ) {
    await auditNpm(
      repoName,
      version,
      vendor.vendorFile,
      entry.sourceUrl,
      vendor,
      net,
      vendor.vulnerabilities,
      blocks
    );
    return;
  }

  // (b) Unresolved - hand to vendor-vuln-unknown. A scoped or renamed package the
  // bare repo name misses lands here: nothing else proposes a name to hash-check.
  vendor.unaudited.push({
    path: entry.path,
    source: entry.sourceUrl,
    repo: src.repo,
  });
}

/**
 * Whether `bytes` content-hash-matches ANY published file of the npm package
 * name@version - a path-independent Subresource-Integrity match from the package
 * "?meta" listing (the same proof verifyPackage uses, but for one buffer and
 * fetching only the listing, no file bodies). Best-effort: any error, a net
 * without fetchJson (offline / the golden harness), or a non-existent candidate
 * package returns false, so the caller falls back / records the entry as
 * unaudited rather than guessing.
 * @param {string} name @param {string} version @param {Buffer} bytes
 * @param {VendorNet} net
 * @returns {Promise<boolean>}
 */
async function npmHashMatches(name, version, bytes, net) {
  let listing;
  try {
    listing = await net.fetchJson(`https://unpkg.com/${name}@${version}/?meta`);
  } catch (err) {
    rethrowIfNetworkGone(err);
    return false;
  }
  const byHash = indexBySri(listing);
  for (const algo of new Set([...byHash.keys()].map((k) => k.split("-")[0]))) {
    if (
      byHash.has(`${algo}-${createHash(algo).update(bytes).digest("base64")}`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Index an unpkg "?meta" listing's published files by their SRI hash
 * ("<algo>-<base64>" -> published path), first occurrence winning. unpkg emits
 * standard padded base64, which matches Node's digest("base64"). Shared by
 * verifyPackage (which needs the path) and npmHashMatches (which needs only
 * membership).
 * @param {MetaNode} listing
 * @returns {Map<string, string>}
 */
function indexBySri(listing) {
  const byHash = new Map();
  for (const f of metaFiles(listing)) {
    for (const sri of String(f.integrity ?? "")
      .trim()
      .split(/\s+/)) {
      if (/^sha\d+-./.test(sri) && !byHash.has(sri)) {
        byHash.set(sri, f.path);
      }
    }
  }
  return byHash;
}

/**
 * @typedef {object} OsvAffected  One `affected` range group of an OSV record.
 * @property {{ecosystem?: string, name?: string}} [package]  The affected
 *   package (ecosystem + name).
 * @property {{events?: {fixed?: string}[]}[]} [ranges]  Version ranges, each
 *   carrying `fixed` events.
 */
/**
 * @typedef {object} OsvVuln  An OSV vulnerability record (the fields this module
 *   reads from the OSV query response).
 * @property {string} [id]  The OSV/GHSA id.
 * @property {string[]} [aliases]  Alias ids (a CVE may appear here).
 * @property {OsvAffected[]} [affected]  Affected package/version ranges.
 * @property {{severity?: string}} [database_specific]  Database-specific data,
 *   e.g. GHSA's severity label.
 * @property {{score?: string}[]} [severity]  Severity entries (e.g. a CVSS
 *   vector string under `score`).
 */
/**
 * The advisory's preferred id: a CVE alias if present, else the OSV/GHSA id.
 * @param {OsvVuln} v  An OSV vuln record.
 * @returns {string}
 */
function advisoryId(v) {
  const cve = (v?.aliases ?? []).find((a) => /^CVE-/i.test(String(a)));
  return cve || v?.id || "unknown";
}

/**
 * The fixed versions OSV lists for `name` (npm) in this advisory: the `fixed`
 * events of every matching `affected` range.
 * @param {OsvVuln} v  An OSV vuln record. @param {string} name
 * @returns {string[]}
 */
function fixedVersions(v, name) {
  const out = [];
  for (const a of v?.affected ?? []) {
    if (a?.package?.ecosystem !== "npm" || a?.package?.name !== name) {
      continue;
    }
    for (const range of a?.ranges ?? []) {
      for (const ev of range?.events ?? []) {
        if (ev?.fixed) {
          out.push(String(ev.fixed));
        }
      }
    }
  }
  return out;
}

// OSV / GitHub Advisory severity labels, low to high. Unknown sorts lowest.
const SEVERITY_RANK = [
  "unknown",
  "low",
  "moderate",
  "medium",
  "high",
  "critical",
];

/**
 * A human severity label for an OSV vuln: the database-specific label (GHSA's
 * LOW/MODERATE/HIGH/CRITICAL) when present, else "unknown" - a CVSS vector carries no
 * numeric base score here, so it is left unlabelled rather than guessed.
 * @param {OsvVuln} v  An OSV vuln record.
 * @returns {string}
 */
function vulnSeverity(v) {
  const ds = v?.database_specific?.severity;
  if (typeof ds === "string" && ds) {
    return ds.toLowerCase();
  }
  // A CVSS vector string under severity[]: map its base score band if present.
  const score = (v?.severity ?? []).find((s) => s?.score)?.score;
  if (typeof score === "string" && /^CVSS:/i.test(score)) {
    return "unknown"; // a vector without a numeric base - leave unlabelled
  }
  return "unknown";
}

/** The higher of two severity labels. @param {string} a @param {string} b */
function worseSeverity(a, b) {
  return SEVERITY_RANK.indexOf(b) > SEVERITY_RANK.indexOf(a) ? b : a;
}

// WHY ENTRIES ARE GROUPED BEFORE THEY ARE VERIFIED: a bundled library is many files
// from ONE release, and each is declared separately because each is a separate file.
// Verified a file at a time, that release is fetched once per file, asked about once
// per file, and audited once per file - which is how an add-on shipping 34 files of
// one package made 102 requests for what three would answer, and would have recorded
// the same advisory 34 times.
//
// The group is the unit of NETWORK work, never of reporting: one tarball, one
// popularity reading, one OSV audit, while every entry still gets its own result row
// naming its own declared source. The comparison each entry then makes is the one it
// always made - its bytes against the bytes published at ITS path - because the
// tarball is keyed by path (tarballFileHashes) rather than flattened to a set. So
// grouping changes what is fetched, and nothing about what is decided.

/**
 * @typedef {object} NpmGroup  The trusted+pinned VENDOR file entries whose declared
 *   sources all resolve to one npm package@version.
 * @property {string} pkg @property {string} version
 * @property {object[]} entries  In manifest order.
 * @property {?{byPath: Map<string, string>}} state  The package's per-path hashes,
 *   or null for "verify these one file at a time".
 * @property {boolean} resolved  resolveGroup runs exactly once per group.
 */

/**
 * Group the entries that name one npm package@version, so the package can be fetched
 * once. Only FILE entries on a trusted, pinned, non-tarball npm source: a folder
 * declaration is verified as a folder, a declared .tgz already fetches the package
 * whole, and a github source has no package to group by.
 * @param {object[]} manifest  vendor.manifest.
 * @returns {Map<string, NpmGroup>}  Keyed `<pkg>@<version>`.
 */
function groupNpmSources(manifest) {
  const groups = new Map();
  for (const entry of manifest) {
    const key = groupKey(entry);
    if (!key) {
      continue;
    }
    const src = classifySource(entry.sourceUrl);
    const group = groups.get(key) ?? {
      pkg: src.pkg,
      version: src.version,
      entries: [],
      state: null,
      resolved: false,
    };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return groups;
}

/**
 * The group an entry belongs to, or null when it is verified on its own terms.
 * @param {object} entry  A vendor.manifest entry.
 * @returns {?string}
 */
function groupKey(entry) {
  if (entry.kind === "folder" || !entry.trusted || !entry.pinned) {
    return null;
  }
  const src = classifySource(entry.sourceUrl);
  return src.kind === "npm" && src.version && !src.tarball
    ? `${src.pkg}@${src.version}`
    : null;
}

/**
 * The npm registry tarball for a pinned package - CONSTRUCTED, not looked up.
 *
 * Asking the registry where its tarball is would put back one request per group,
 * which is the cost this path exists to remove. Constructing it cannot produce a
 * wrong verdict: the URL goes through the same classifier every declared source
 * does, and anything it does not recognise - or that the registry does not serve -
 * drops the group back to verifying its entries one at a time.
 * @param {string} pkg  Package name, possibly scoped.
 * @param {string} version
 * @returns {?string}  The tarball URL, or null when it does not classify as one.
 */
function registryTarballUrl(pkg, version) {
  const plain = String(version).replace(/^v/i, "");
  const name = pkg.split("/").pop();
  const url = `https://registry.npmjs.org/${pkg}/-/${name}-${plain}.tgz`;
  const src = classifySource(url);
  return src.trusted && src.tarball && src.pkg === pkg && src.version === plain
    ? url
    : null;
}

/**
 * Where inside its package a declared source URL points.
 *
 * The CDN hosts serve a package's published files at their own paths, so the
 * segments after `<pkg>@<version>` ARE the in-package path - which is what lets a
 * grouped entry be held to the same claim as an ungrouped one. A URL whose shape
 * this does not recognise returns null, and its entry is verified on its own rather
 * than guessed at.
 * @param {VendorSource} src  The classified source.
 * @param {string} sourceUrl
 * @returns {?string}
 */
function inPackagePath(src, sourceUrl) {
  let segs;
  try {
    segs = new URL(sourceUrl).pathname.split("/").filter(Boolean);
  } catch {
    return null;
  }
  if (segs[0] === "npm") {
    segs = segs.slice(1); // jsDelivr namespaces npm packages under /npm/
  }
  // The package name is one segment, or two when it is scoped (@scope/name@ver).
  const rest = segs.slice(String(src.pkg).startsWith("@") ? 2 : 1);
  return rest.length ? rest.join("/") : null;
}

/**
 * Resolve a group once: audit the package, and fetch it whole when that is cheaper
 * than fetching its files one at a time.
 *
 * The audit happens HERE, for every group including a group of one, which is what
 * makes "once per package@version" true by construction rather than by remembering -
 * auditNpm appends a record per call, so a package declared 34 times was recorded 34
 * times.
 * @param {NpmGroup} group
 * @param {VendorStore} vendor @param {VendorNet} net
 * @param {?Map<string, object>} blocks
 * @returns {Promise<void>}
 */
async function resolveGroup(group, vendor, net, blocks) {
  if (group.resolved) {
    return;
  }
  group.resolved = true;
  await auditNpm(
    group.pkg,
    group.version,
    vendor.vendorFile,
    group.entries[0].sourceUrl,
    vendor,
    net,
    vendor.vulnerabilities,
    blocks
  );
  if (group.entries.length < VENDOR_GROUP_MIN_ENTRIES) {
    return; // one file is not worth a whole package
  }
  const url = registryTarballUrl(group.pkg, group.version);
  if (!url) {
    return;
  }
  try {
    group.state = { byPath: tarballFileHashes(await net.fetchBytes(url)) };
  } catch (err) {
    rethrowIfNetworkGone(err);
    // The package could not be had - absent, too large, or not a tarball. Each entry
    // then verifies against its own URL, which is what it would have done anyway, so
    // a failed grouping costs the old number of requests and nothing else.
    debug(`vendor group ${group.pkg}@${group.version}: ${err.message}`);
  }
}

/**
 * Verify one entry of a grouped package against the copy fetched for the group.
 *
 * The same claim verifyUrl makes - these bytes are the ones published at this path -
 * asked of the tarball instead of the CDN. normalizedSha256 hashes eolNormalize, and
 * verifyUrl compares with eolEqual, which IS eolNormalize on both sides, so the two
 * agree on every input, including the EOL differences both forgive.
 * @param {object} entry @param {NpmGroup} group
 * @param {Addon} addon @param {VendorStore} vendor @param {VendorNet} net
 * @returns {Promise<"verified"|"modified"|"not-popular"|"unfetchable">}
 */
async function verifyGrouped(entry, group, addon, vendor, net) {
  const src = classifySource(entry.sourceUrl);
  const path = inPackagePath(src, entry.sourceUrl);
  const published = path ? group.state.byPath.get(path) : undefined;
  if (published === undefined) {
    // The package publishes nothing at that path, so it cannot answer this
    // declaration. Ask the declared URL rather than call the file modified: a CDN
    // may serve a path the tarball spells differently, and being wrong here would
    // reject a file over the shape of its URL.
    return verifyUrl(entry, addon, vendor, net);
  }
  const mine = addon.files?.get(entry.path) ?? Buffer.alloc(0);
  if (published !== normalizedSha256(mine)) {
    return "modified";
  }
  return (await isPopular(src, net, vendor?.popularity))
    ? "verified"
    : "not-popular";
}

/**
 * Compare a packaged file against its declared trusted+pinned URL.
 * @param {{path: string, sourceUrl: string}} entry
 * @param {Addon} addon @param {VendorStore} vendor @param {VendorNet} net
 * @returns {Promise<"verified"|"modified"|"not-popular"|"unfetchable">}
 */
async function verifyUrl(entry, addon, vendor, net) {
  const src = classifySource(entry.sourceUrl);
  const mine = addon.files.get(entry.path) ?? Buffer.alloc(0);
  let fetched;
  try {
    fetched = await net.fetchBytes(src.rawUrl);
  } catch (err) {
    rethrowIfNetworkGone(err);
    return "unfetchable";
  }
  if (!eolEqual(mine, fetched)) {
    return "modified";
  }
  return (await isPopular(src, net, vendor?.popularity))
    ? "verified"
    : "not-popular";
}

/**
 * Verify a packaged file against a whole-package npm-registry tarball: download the
 * .tgz, hash every file inside (EOL-normalized), and accept the bundled file when its
 * normalized hash is among them - the same content-match the experiment allow-list
 * uses, just sourced from the tarball instead of a remote hash listing. A fetch,
 * gunzip, or parse failure is reported as unfetchable (the bytes to compare against
 * could not be obtained).
 * @param {{path: string, sourceUrl: string}} entry
 * @param {Addon} addon @param {VendorStore} vendor @param {VendorNet} net
 * @returns {Promise<"verified"|"modified"|"not-popular"|"unfetchable">}
 */
async function verifyTarball(entry, addon, vendor, net) {
  const src = classifySource(entry.sourceUrl);
  const mine = addon.files.get(entry.path) ?? Buffer.alloc(0);
  let hashes;
  try {
    hashes = tarballHashes(await net.fetchBytes(src.rawUrl));
  } catch (err) {
    rethrowIfNetworkGone(err);
    return "unfetchable";
  }
  if (!hashes.has(normalizedSha256(mine))) {
    return "modified";
  }
  return (await isPopular(src, net, vendor?.popularity))
    ? "verified"
    : "not-popular";
}

/**
 * The upstream files a DIRECTORY declaration is checked against, as content hashes.
 *
 * Two kinds of source can answer for a directory, because two kinds can be fetched
 * as one archive of many files: a github /tree/ URL, resolved to the repo ZIP and
 * scoped to the declared subpath, and a pinned npm package, resolved to its registry
 * tarball. A CDN directory URL is neither - it answers 200 with an HTML listing
 * page, so the fetch SUCCEEDS and only the unzip fails - which is why the
 * declaration is settled offline (resolveVendor) rather than found out here.
 *
 * The npm route takes the package whole and matches by membership, with no subpath
 * to scope to: `dist/` in the declared URL selects nothing, exactly as a whole-repo
 * /tree/<ref> selects nothing. That is also why tar's unreadable long-name entries
 * cost nothing here - the paths are not what is being asked about.
 * @param {VendorSource} src  The classified folder source.
 * @param {VendorNet} net
 * @returns {Promise<Set<string>>}  Normalized content hashes of the upstream files.
 */
async function folderHashes(src, net) {
  if (src.kind === "npm") {
    const url = src.tarball
      ? src.rawUrl
      : registryTarballUrl(src.pkg, src.version);
    if (!url) {
      throw new Error(`no registry tarball for ${src.pkg}@${src.version}`);
    }
    return tarballHashes(await net.fetchBytes(url));
  }
  return zipHashesUnder(await net.fetchBytes(src.rawUrl), src.subpath ?? "");
}

/**
 * Verify a vendored FOLDER: fetch the upstream release as one archive (folderHashes),
 * then match EACH packaged file under the directory by content hash (the same
 * membership test as verifyTarball, one result per file). A file not in the upstream
 * set is `modified`; a fetch/parse failure records every file the folder covers as
 * `unfetchable`, which applyUnverifiedVendor reconciles into the untrusted family -
 * so each is reviewed as authored code or rejected as unreadable, per file, never
 * silently exempt.
 *
 * Matching is by membership rather than by path, unlike a file declaration: a
 * directory names ONE source for many files, so there is no declared path to hold
 * any one of them to.
 * @param {{path: string, sourceUrl: string}} entry  Folder entry (path = directory).
 * @param {Addon} addon @param {VendorStore} vendor @param {VendorNet} net
 * @returns {Promise<void>}
 */
async function verifyFolder(entry, addon, vendor, net) {
  const src = classifySource(entry.sourceUrl);
  let hashes;
  try {
    hashes = await folderHashes(src, net);
  } catch (err) {
    rethrowIfNetworkGone(err);
    // One row per covered file, like the success path below - a row naming the
    // DIRECTORY would reach markUntrusted, which cannot withdraw an exemption from
    // a path that is not a packaged file (see declaredFiles).
    for (const path of declaredFiles(addon, entry)) {
      vendor.results.push({
        path,
        source: entry.sourceUrl,
        outcome: "unfetchable",
      });
    }
    return;
  }
  let popular = null; // looked up once, lazily, only if a file actually matches
  for (const addonPath of declaredFiles(addon, entry)) {
    const mine = addon.files.get(addonPath);
    if (!hashes.has(normalizedSha256(mine))) {
      vendor.results.push({
        path: addonPath,
        source: entry.sourceUrl,
        outcome: "modified",
      });
      continue;
    }
    if (popular === null) {
      popular = await isPopular(src, net, vendor?.popularity);
    }
    vendor.results.push({
      path: addonPath,
      source: entry.sourceUrl,
      outcome: popular ? "verified" : "not-popular",
    });
  }
}

/**
 * Match packaged files against a pinned npm package's published files by
 * Subresource-Integrity hash (the per-file sha256 in the "?meta" listing),
 * recording each match as vendored. The match is purely local - the listing is
 * the only fetch and no file bytes are downloaded - so it scales to large
 * packages.
 * @param {{name: string, version: string}} pkg
 * @param {Addon} addon @param {VendorStore} vendor @param {VendorNet} net
 * @returns {Promise<void>}
 */
async function verifyPackage(pkg, addon, vendor, net) {
  // A declared dependency whose files match nothing in the package is silently
  // ignored, by design: dependencies are installed/bundled at build time, so a
  // not-yet-built submission legitimately omits them (unlike a VENDOR entry,
  // whose file must be present - see missing-vendor-file.js). We only record the
  // files that DO match.
  const base = `https://unpkg.com/${pkg.name}@${pkg.version}`;
  let listing;
  try {
    listing = await net.fetchJson(`${base}/?meta`);
  } catch (err) {
    rethrowIfNetworkGone(err);
    return; // can't list the package - its files (if shipped) are scanned as-is
  }
  const byHash = indexBySri(listing);
  const algos = [...new Set([...byHash.keys()].map((k) => k.split("-")[0]))];
  let popular = null; // looked up once, lazily, only if a file actually matches
  for (const [addonPath, mine] of addon.files) {
    if (isVendored(vendor, addonPath)) {
      continue; // already vendored (a VENDOR file entry or folder)
    }
    // A packaged file is vendored when its exact content hash matches a
    // published file (basename-independent - a renamed verbatim copy still
    // matches). A file that does not hash-match is left alone (it may be the
    // author's own code, or a modified copy).
    let path = null;
    for (const algo of algos) {
      const sri = `${algo}-${createHash(algo).update(mine).digest("base64")}`;
      if (byHash.has(sri)) {
        path = byHash.get(sri);
        break;
      }
    }
    if (!path) {
      continue;
    }
    if (popular === null) {
      popular = await isPopular(
        { kind: "npm", pkg: pkg.name },
        net,
        vendor?.popularity
      );
    }
    vendor.set.add(addonPath);
    vendor.results.push({
      path: addonPath,
      source: `${base}${path}`,
      outcome: popular ? "verified" : "not-popular",
    });
  }
}

/**
 * Whether two buffers are equal once end-of-line differences are normalized:
 * CRLF / CR collapse to LF and trailing newlines are ignored (the developer's
 * "allow EOL diffs"). Compared via latin1, which is byte-preserving.
 * @param {Buffer} a @param {Buffer} b
 * @returns {boolean}
 */
function eolEqual(a, b) {
  return eolNormalize(a) === eolNormalize(b);
}

/**
 * The published file nodes (each `{path, integrity, ...}`) an unpkg "?meta"
 * listing contains. A node is a file when it has a `path` and no `files` child
 * of its own - which covers both unpkg's flat listing (every entry is a file,
 * its `type` a MIME type) and the older nested tree (directories carry a `files`
 * array). Keying off `type === "file"` would miss the flat form, whose entries
 * carry a MIME type instead.
 * @param {MetaNode} node @param {MetaNode[]} [out]
 * @returns {MetaNode[]}
 */
function metaFiles(node, out = []) {
  if (!node || typeof node !== "object") {
    return out;
  }
  if (typeof node.path === "string" && node.files === undefined) {
    out.push(node);
  }
  for (const child of node.files ?? []) {
    metaFiles(child, out);
  }
  return out;
}

/**
 * Whether the source clears the trust bar: a broadly-used library (npm monthly
 * downloads or GitHub stars over the configured bar) OR a github source from a
 * first-party trusted org (VENDOR_TRUSTED_GITHUB_ORGS, e.g. Thunderbird), which
 * is accepted by provenance regardless of stars and without a popularity lookup.
 * Shared by verifyVendor's per-source checks (VENDOR / package.json) and the CDN
 * identifier (src/lib/cdn-lookup.js), so all identification paths gate on
 * the same bar. `src` need only carry {kind, pkg} (npm) or {kind, repo} (github).
 *
 * A lookup that is never answered still counts as "not popular": the file keeps
 * its declaration and is reviewed as the developer's own code, which is the safe
 * reading. The dangerous one would be the opposite - an add-on's own entries are
 * what spend the request budget, so trusting an unanswered lookup would let a
 * submission pad its VENDOR file until the package it cares about goes unasked.
 * askPopularity is what keeps that fallback rare enough to be honest.
 *
 * `memo` holds one answer per package for the length of ONE review (never across
 * runs - popularity is time-varying, the same reason cdn-lookup does not cache it
 * to disk). Without it a package declared 34 times was asked about 34 times.
 * @param {VendorSource} src @param {VendorNet} net
 * @param {Map<string, boolean>} [memo]  Per-run, in-process; see above.
 * @returns {Promise<boolean>}
 */
export async function isPopular(src, net, memo) {
  const key =
    src.kind === "npm"
      ? `npm:${src.pkg}`
      : src.kind === "github"
        ? `gh:${String(src.repo ?? "").toLowerCase()}`
        : null;
  if (key === null) {
    return false;
  }
  if (memo?.has(key)) {
    return memo.get(key);
  }
  let popular = false;
  if (src.kind === "npm") {
    const downloads = await npmDownloads(src.pkg, net);
    popular = downloads !== null && downloads >= VENDOR_NPM_MIN_DOWNLOADS;
  } else {
    popular = (await githubPopular(src.repo, net)) === true;
  }
  memo?.set(key, popular);
  return popular;
}

/**
 * The default network transport: a timeout- and size-capped HTTPS fetch. The
 * caller only ever passes an already trusted-host URL.
 * @type {VendorNet}
 */
export const defaultNet = {
  fetchBytes(url) {
    return fetchWithTimeout(url, readBytes, VENDOR_FETCH_TIMEOUT_MS);
  },
  fetchJson(url) {
    return fetchWithTimeout(url, readJson, VENDOR_FETCH_TIMEOUT_MS);
  },
  postJson(url, body) {
    return fetchWithTimeout(url, readJson, VENDOR_FETCH_TIMEOUT_MS, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  },
};

/**
 * The error a non-ok response becomes, carrying what the caller may need to tell a
 * REFUSAL from an answer (askPopularity) without re-reading the response.
 *
 * The message keeps its old shape, because that is what callers already read: the
 * CDN identifier tells a genuine 404 from a transient failure with a regex over it
 * (src/lib/cdn-lookup.js), and an injected test net throws the same shape by hand.
 * @param {Response} res
 * @returns {Error}
 */
function httpError(res) {
  const err = new Error(`HTTP ${res.status}`);
  err.status = res.status;
  // Seconds, per RFC 9110; the HTTP-date form and a "0" (which npm sends with
  // every 429) both leave this unset, so the caller falls back to its own backoff.
  const after = Number(res.headers?.get("retry-after"));
  if (Number.isFinite(after) && after > 0) {
    err.retryAfterMs = after * 1000;
  }
  return err;
}

/**
 * Read a fetch Response as bytes, enforcing the size cap (fetchBytes' consumer). A
 * consume callback for fetchWithTimeout, so the read runs under the abort timeout.
 * @param {Response} res
 * @returns {Promise<Buffer>}
 */
async function readBytes(res) {
  if (!res.ok) {
    throw httpError(res);
  }
  const declared = Number(res.headers.get("content-length"));
  if (declared && declared > VENDOR_FETCH_MAX_BYTES) {
    throw new Error("source exceeds size cap");
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > VENDOR_FETCH_MAX_BYTES) {
    throw new Error("source exceeds size cap");
  }
  return buf;
}

/**
 * Read a fetch Response as JSON, enforcing the size cap. Shared by fetchJson and
 * postJson.
 * @param {Response} res
 * @returns {Promise<object>}
 */
async function readJson(res) {
  if (!res.ok) {
    throw httpError(res);
  }
  const declared = Number(res.headers.get("content-length"));
  if (declared && declared > VENDOR_FETCH_MAX_BYTES) {
    throw new Error("response exceeds size cap");
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > VENDOR_FETCH_MAX_BYTES) {
    throw new Error("response exceeds size cap");
  }
  return JSON.parse(buf.toString("utf8"));
}
