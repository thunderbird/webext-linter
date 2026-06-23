// Classifies a declared vendor source URL, with no network. It decides whether
// the host is one we may fetch from, whether the ref is immutable (so a byte
// comparison against it is stable), the raw URL to fetch, and the identifier
// used for the popularity lookup (npm package or GitHub owner/repo).
//
// Belongs here: parsing the trusted host shapes (unpkg, jsDelivr npm + gh,
// raw.githubusercontent) plus the github.com/.../blob -> raw rewrite, and the
// pinned-ref heuristic. Does NOT belong here: the host allowlist policy itself
// (-> src/config.js VENDOR_TRUSTED_HOSTS), fetching/comparing/popularity
// (-> src/vendor/verify.js), or the finding/manual routing (-> the check).

/**
 * @typedef {object} VendorSource
 * @property {boolean} trusted  Host is one we may fetch from.
 * @property {boolean} pinned  Ref is immutable (a version/tag/commit).
 * @property {?string} rawUrl  The raw URL to fetch (blob URLs rewritten to raw).
 * @property {?("npm"|"github")} kind  Source family, for popularity.
 * @property {?string} pkg  npm package name (npm kind).
 * @property {?string} version  npm version, when given (npm kind); else null.
 * @property {?string} repo  "owner/repo" (github kind).
 * @property {?string} ref  Git ref (version tag or commit) (github kind); else
 *   null. The npm-resolution audit derives the version from this.
 */

const UNTRUSTED = Object.freeze({
  trusted: false,
  pinned: false,
  rawUrl: null,
  kind: null,
  pkg: null,
  version: null,
  repo: null,
  ref: null,
});

// A concrete npm version (not a dist-tag like "latest"/"next").
const VERSION = /^v?\d+(\.\d+)*([.-][0-9a-z.-]+)?$/i;
// A pinned git ref: a version tag or a full 40-hex commit SHA.
const GIT_REF = /^(v?\d+(\.\d+)*([.-][0-9a-z.-]+)?|[0-9a-f]{40})$/i;

/**
 * Classify a declared source URL.
 * @param {?string} url
 * @returns {VendorSource}
 */
export function classifySource(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return UNTRUSTED;
  }
  if (u.protocol !== "https:") {
    return UNTRUSTED;
  }
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split("/").filter(Boolean);

  if (host === "unpkg.com") {
    const { pkg, version } = npmFromPath(segs);
    return pkg ? npm(pkg, version, url) : UNTRUSTED;
  }
  if (host === "cdn.jsdelivr.net") {
    if (segs[0] === "npm") {
      const { pkg, version } = npmFromPath(segs.slice(1));
      return pkg ? npm(pkg, version, url) : UNTRUSTED;
    }
    if (segs[0] === "gh" && segs.length >= 3) {
      const { repo, ref } = ghSpec(segs[1], segs[2]);
      return github(repo, ref, url);
    }
    return UNTRUSTED;
  }
  if (host === "raw.githubusercontent.com" && segs.length >= 4) {
    return github(`${segs[0]}/${segs[1]}`, segs[2], url);
  }
  if (host === "github.com" && segs[2] === "blob" && segs.length >= 5) {
    const [owner, repo, , ref, ...rest] = segs;
    const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest.join("/")}`;
    return github(`${owner}/${repo}`, ref, raw);
  }
  return UNTRUSTED;
}

/**
 * @param {string} pkg @param {?string} version @param {string} rawUrl
 * @returns {VendorSource}
 */
function npm(pkg, version, rawUrl) {
  return {
    ...UNTRUSTED,
    trusted: true,
    kind: "npm",
    pkg,
    version: version ?? null,
    rawUrl,
    pinned: Boolean(version) && version !== "latest" && VERSION.test(version),
  };
}

/**
 * @param {string} repo  "owner/repo" @param {?string} ref @param {string} rawUrl
 * @returns {VendorSource}
 */
function github(repo, ref, rawUrl) {
  return {
    ...UNTRUSTED,
    trusted: true,
    kind: "github",
    repo,
    ref: ref ?? null,
    rawUrl,
    pinned: Boolean(ref) && GIT_REF.test(ref),
  };
}

/**
 * Split an npm path into {pkg, version}, handling a scoped "@scope/name@ver".
 * @param {string[]} segs  Path segments after the host (and after "npm" for
 *   jsDelivr).
 * @returns {{pkg: ?string, version: ?string}}
 */
function npmFromPath(segs) {
  if (!segs.length) {
    return { pkg: null, version: null };
  }
  if (segs[0].startsWith("@") && segs.length >= 2) {
    const at = segs[1].indexOf("@");
    const name = at >= 0 ? segs[1].slice(0, at) : segs[1];
    return {
      pkg: `${segs[0]}/${name}`,
      version: at >= 0 ? segs[1].slice(at + 1) : null,
    };
  }
  const at = segs[0].indexOf("@");
  return {
    pkg: at >= 0 ? segs[0].slice(0, at) : segs[0],
    version: at >= 0 ? segs[0].slice(at + 1) : null,
  };
}

/**
 * Split a jsDelivr "gh" repo segment "<repo>@<ref>" into {repo, ref}.
 * @param {string} owner @param {string} repoSeg
 * @returns {{repo: string, ref: ?string}}
 */
function ghSpec(owner, repoSeg) {
  const at = repoSeg.indexOf("@");
  const repo = at >= 0 ? repoSeg.slice(0, at) : repoSeg;
  return {
    repo: `${owner}/${repo}`,
    ref: at >= 0 ? repoSeg.slice(at + 1) : null,
  };
}
