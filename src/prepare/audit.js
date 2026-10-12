// The LINTER'S OWN AUDIT of a source root, for the preparation of a source code review: does
// the lock install a package with a known high or critical advisory, and could the audit read
// the whole tree to say so.
//
// The preparation asks it of the extracted source, to decide whether a rescued copy is made:
// such a lock is often vulnerable through tooling the release build does not use, or through
// a release the package manager's audit fix moves past. And it asks it of that copy, after
// each step an agent took in it, to decide whether the copy is clean. Nothing the agent says
// about its work is read: this audit is the whole judgement, and a copy it cannot read in full
// is not clean.
//
// It is the lock audit and nothing else. A lock it cannot trust to say what is installed - one
// of several committed, an entry installed from a source the audit does not read, or one that
// installs another release than it names - is not audited at all: its tree is not read in
// full, so it is neither clean nor rescuable, and the review it is handed to stops on it.
// Whatever else a review can stop for - another abort reason, an Experiment, the run's
// --checks-* or band policy - is the review's to decide, never predicted here. It reads the
// lock the way the review reads it (src/pipeline.js loads
// the archive, src/review/products.js audits its dependencies), with the same functions,
// so the lists it answers with are the ones the review's vulnerability checks read.
//
// Belongs here: reading a root's lock into those lists, and the two answers the preparation
// takes from them: is the root clean, and is it rescuable. Does NOT belong here: what the
// preparation does with either (-> ./steps.js), the lock reading and the network audit
// themselves (-> src/vendor/locks.js, src/vendor/verify.js).

import { loadSourceArchive, scaViews } from "../addon/load.js";
import { resolveVendor } from "../vendor/resolve.js";
import { auditScaDependencies } from "../vendor/verify.js";
import {
  committedLocks,
  findLockInjections,
  governingLock,
  lockSourceGaps,
  unreadableLock,
} from "../vendor/locks.js";
import {
  parseLibraryBlocks,
  resolveLibraryBlocks,
} from "../lib/library-blocks.js";
import { rethrowIfFatal } from "../lib/errors.js";

/** The four lists the lock audit records its hits in (src/vendor/verify.js
 *  auditLockedPackages), each read by one of the review's vulnerability checks. */
export const LOCK_AUDIT_LISTS = Object.freeze([
  "vulnerabilities",
  "devVulnerabilities",
  "treeVulnerabilities",
  "treeDevVulnerabilities",
]);

/**
 * What the audit of one root found.
 * @typedef {object} RootAudit
 * @property {boolean} complete  The audit read the whole tree: the root loaded, its lock is
 *   there and parses, and no entry is installed from a source the audit cannot read or
 *   installs another release than it names. Without each of these, an empty tree would read
 *   as a clean one. An audit OSV does not answer is not incomplete: it ends the run.
 * @property {Record<string, import("../vendor/verify.js").VendorVuln[]>} lists  The
 *   lock audit's hits, by LOCK_AUDIT_LISTS name: only high, critical and malicious
 *   advisories are recorded there.
 */

/**
 * Audit one root's lock.
 * @param {{scaRoot: string, scaExpSource: ?string}} roots  Settled, absolute.
 * @param {{net?: import("../vendor/verify.js").VendorNet, cacheDir?: string}} [context]
 *   The network the audit asks, the run's, behind its cache (./steps.js handBack), and where
 *   the npm registry's answers about the lock's tarball URLs are cached.
 * @returns {Promise<RootAudit>}
 */
export async function auditRoot(roots, { net, cacheDir } = {}) {
  const none = Object.fromEntries(LOCK_AUDIT_LISTS.map((l) => [l, []]));
  // A root the loader refuses - a file it cannot read, more than it reads at all - is one
  // the review refuses too. Not read in full, so neither clean nor rescuable.
  let archive;
  try {
    archive = loadSourceArchive(roots.scaRoot);
  } catch (err) {
    rethrowIfFatal(err);
    return { complete: false, lists: none };
  }
  scaViews(archive, {
    scaRoot: roots.scaRoot,
    scaExpSource: roots.scaExpSource ?? undefined,
  });
  // Asked before the audit, which would otherwise vouch for releases the install does not
  // fetch: the review stops on each of these, and nothing is asked of OSV for such a lock.
  // More than one lock comes first, since it needs no network: the audit would read one while
  // the build installs from another.
  if (
    committedLocks(archive).length > 1 ||
    lockSourceGaps(archive).length > 0 ||
    (await findLockInjections(archive, { net, cacheDir })).length > 0
  ) {
    return { complete: false, lists: none };
  }
  archive.vendor = resolveVendor({ addon: archive, reviewerInstalls: true });
  // The policy blocklist is applied as the review applies it: a banned release is recorded
  // as blocked and never asked of OSV, so the lists hold what the review's checks will read.
  const blocks = parseLibraryBlocks((await resolveLibraryBlocks()).text);
  await auditScaDependencies(archive, net, blocks);
  const { vendor } = archive;
  return {
    complete:
      governingLock(archive) !== null && unreadableLock(archive) === null,
    lists: Object.fromEntries(LOCK_AUDIT_LISTS.map((l) => [l, vendor[l]])),
  };
}

/**
 * Whether the lock audit recorded anything.
 * @param {RootAudit} audit
 * @returns {boolean}
 */
function vulnerable(audit) {
  return LOCK_AUDIT_LISTS.some((l) => audit.lists[l].length > 0);
}

/**
 * A root whose lock the audit read in full and found nothing in.
 * @param {RootAudit} audit
 * @returns {boolean}
 */
export function isClean(audit) {
  return audit.complete && !vulnerable(audit);
}

/**
 * A root a rescued copy is made for: its lock read in full, and vulnerable.
 * @param {RootAudit} audit
 * @returns {boolean}
 */
export function isRescuable(audit) {
  return audit.complete && vulnerable(audit);
}
