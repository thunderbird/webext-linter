// Central configuration: the tool's behavior defaults and deliberate policy
// toggles, kept in one easy-to-find place rather than scattered across deep
// modules. CLI flags override the defaults at runtime. The toggles have no flag
// and are changed here, where each records why it has its value.

/** Directory where fetched schema zips are cached (--cache-schema-dir default). */
export const DEFAULT_CACHE = ".schema-cache";

/**
 * The upstream repository of allowed Thunderbird Experiments. An add-on that
 * bundles one of these UNCHANGED is auto-accepted (not treated as an invalid
 * Experiment). See src/experiments/*.
 */
export const EXPERIMENTS_REPO = "thunderbird/webext-experiments";

/** Branch of EXPERIMENTS_REPO to fetch for the allow-list. */
export const EXPERIMENTS_BRANCH = "main";

/**
 * Directory where the fetched experiments zip is cached (--cache-experiments-dir).
 */
export const EXPERIMENTS_CACHE = ".experiments-cache";

/**
 * The upstream known-library hash database: Mozilla dispensary's generated
 * hashes.txt (one "<sha256> <name>.<version>.<file>" line per library release).
 * Fetched and cached so the library classifier can identify a bundled library by
 * the raw SHA-256 of its bytes. See src/lib/library-hashes.js.
 */
export const LIBRARY_HASHES_URL =
  "https://raw.githubusercontent.com/mozilla/dispensary/master/src/hashes.txt";

/**
 * Directory where the fetched library hashes are cached (--cache-hash-db-dir).
 * The internal names (LIBRARY_HASHES_*, library-hashes.js) keep the accurate
 * "Mozilla dispensary hashes.txt" description; the user-facing --cache-* flag is
 * the discoverable label, mapped to the internal opts once, in cli.js.
 */
export const LIBRARY_HASHES_CACHE = ".lib-mozilla-hash-db-cache";

/**
 * Timeout for the MANDATORY setup downloads that back the caches above - the schema
 * zip, the allowed-experiments zip, the library-hash DB (src/util/net.js
 * fetchWithTimeout). The artifacts are small (~80-220 KB), so 60s never fails a
 * legitimately slow link (~11s even at 20 KB/s) while still bounding a half-open hang.
 * On timeout the review fails loud (exit 2) rather than hanging, because it cannot
 * proceed without these inputs.
 */
export const SETUP_FETCH_TIMEOUT_MS = 60000;

// The control-point probe (src/util/net.js): asked only when a request has already
// failed to connect, and only to learn whether the network is still there. Short,
// because the review is either about to continue or about to stop, and a slow answer
// helps neither.
export const CONTROL_TIMEOUT_MS = 5000;

/**
 * jsDelivr's content-addressed reverse lookup: GET <CDN_LOOKUP_URL><sha256-hex>
 * returns `{type, name, version, file}` for a file whose exact bytes are published
 * on the CDN, or 404 when nothing matches. A second-tier library identifier (after
 * the Mozilla hash DB above) for bundled files that DB does not list. See
 * src/lib/cdn-lookup.js.
 */
export const CDN_LOOKUP_URL = "https://data.jsdelivr.com/v1/lookup/hash/";

/** Directory where CDN hash-lookup results are cached (--cache-cdn-lookup-dir). */
export const CDN_LOOKUP_CACHE = ".lib-cdn-lookup-cache";

/**
 * Minimum size (bytes) for a READABLE file to earn a CDN identification attempt - a
 * library shipped un-minified (e.g. pdf.mjs) is large, while the developer's own files
 * are typically small, so this targets likely libraries and avoids a CDN lookup (and a
 * content fingerprint) for every authored file. 16 KB comfortably clears a typical
 * authored module while catching un-minified library builds (pdf.mjs is ~810 KB). A
 * MINIFIED file is always eligible regardless of size. See src/lib/cdn-lookup.js.
 */
export const CDN_LOOKUP_READABLE_MIN_BYTES = 16384;

/** Max characters of a truncated display label (e.g. a long URL). */
export const DISPLAY_TRUNCATE_LENGTH = 80;

/**
 * Display cap: the most location lines a single grouped report entry lists (an
 * Issues or Manual-review entry with many "- file:line" locations). Beyond this,
 * the rest are replaced by one "... more, excluded from this list" marker. This
 * is a rendering limit only (see src/report/format.js) - the summary counts,
 * JSON output still sees every finding.
 */
export const MAX_ENTRIES_PER_CATEGORY = 25;

/**
 * How much a reviewer may write when they answer a manual review question in their own
 * words, in code points - an emoji is one character to the person who typed it.
 *
 * Read from BOTH ends of that round trip, which is why it lives here: the answer's own
 * description states it to the reviewer (assets/registry.yaml fills it in), and
 * src/report/verdicts.js refuses an answer past it. A reviewer typing a sentence or a
 * short list never meets it; it is here so that a model pasting half a review does.
 */
export const MAX_NOTE = 2000;

/**
 * What a --llm-review run can be told to leave out, as the prompt's steps declare it and
 * the flags spell it: --llm-skip-summary and --llm-skip-manual.
 *
 * Read from every layer of that round trip, which is why it lives here: src/cli.js offers
 * the flags, src/checks/registry.js refuses a step marked with anything else, and
 * src/report/format.js drops the steps and asks that a skip names.
 */
export const PROMPT_SKIPS = ["summary", "manual"];

// Vendor verification (src/vendor/verify.js) is the only stage that makes
// outbound network requests. It runs once, before the review, and the checks
// read its result.

/**
 * The hosts vendor verification fetches a declared source from. A source on any
 * other host is sent to manual review, never requested. All four pin an immutable
 * version or tag, so a byte comparison is stable. A github.com/.../blob URL is
 * rewritten to raw.githubusercontent.com first; a github.com/.../tree/ folder source
 * is fetched as the repo archive ZIP from github.com itself.
 */
export const VENDOR_TRUSTED_HOSTS = [
  "unpkg.com",
  "cdn.jsdelivr.net",
  "raw.githubusercontent.com",
  "registry.npmjs.org",
];

/**
 * "Broadly used" thresholds - the bar a declared library must clear to be
 * auto-trusted (else manual review): npm monthly downloads, or GitHub stars.
 */
export const VENDOR_NPM_MIN_DOWNLOADS = 1000;
export const VENDOR_GITHUB_MIN_STARS = 100;

/**
 * Where the two popularity readings come from. Named here like every other
 * endpoint the tool talks to, so the hosts a review contacts can be read off
 * config rather than found inline in the code that asks.
 */
export const VENDOR_NPM_DOWNLOADS_API =
  "https://api.npmjs.org/downloads/point/last-month/";
export const VENDOR_GITHUB_REPOS_API = "https://api.github.com/repos/";

/**
 * Where a source review's install may take a package from: the npm registry, or GitHub
 * (the only non-registry source a package.json may declare). A lock entry resolved
 * anywhere else installs bytes the dependency audit never read (lock-foreign-source).
 */
export const NPM_REGISTRY_TARBALLS = "https://registry.npmjs.org/";
export const GITHUB_INSTALL_SOURCE =
  /^(?:git\+)?(?:https?|ssh|git):\/\/(?:[^@/]+@)?(?:codeload\.)?github\.com\//i;

/**
 * The smallest gap between two requests to the same host, for every request the tool
 * makes through its one transport (src/util/net.js). The sole exception is that
 * transport's own control-point probe, which runs from inside a failure to decide
 * whether the network is gone and must not be held back from saying so.
 *
 * This is OUR restraint, not theirs: api.npmjs.org enforces a per-IP budget that
 * a burst trips within about a dozen requests, and a refusal that outlasts the retries
 * ends the review (src/util/net.js NoAnswerError). Measured against THAT endpoint: 40 consecutive requests 250ms apart
 * were never refused, so this doubles that margin, and the same figure is applied
 * to every host rather than guessing a budget per host nobody has measured.
 *
 * Requests are sequential, so the gate only has to delay the next one - and a gap
 * is therefore paid rather than overlapped, which is what makes the number visible
 * in a review's wall clock.
 */
export const NETWORK_MIN_INTERVAL_MS = 500;

/**
 * How many times a refusal that NAMES NO TIME is retried, and the base its waiting
 * doubles from.
 *
 * These govern the guessing half of the gate, and only it. A refusal (429, 403, 408,
 * any 5xx) says nothing about what was asked, so the answer is worth waiting for - but
 * a host that does not say when to come back has told us nothing about when either, so
 * we escalate blindly and give up after a bounded number of tries. api.npmjs.org is
 * this case: it answers every 429 with "retry-after: 0", which names nothing.
 *
 * A host that DOES name a time has no count to configure - it is asked once more, when
 * it said (src/util/net.js). An answer is never retried at all, including a 404, which
 * is npm's real "no download data" response and what the offline fixture harness serves
 * for every URL a fixture did not declare. Neither is a TIMEOUT: a host that does not
 * respond is not a host declining, and retrying it multiplies the slowest failure the
 * tool has.
 */
export const NETWORK_RETRIES = 3;
export const NETWORK_BACKOFF_MS = 1000;

/**
 * The longest we will wait, however long a host asks for.
 *
 * A named Retry-After is obeyed as given, because the host knows its own window and we
 * do not. But "as given" has to end somewhere: a limiter naming a day is telling us to
 * come back tomorrow, and a review is something a person is waiting on. An hour is past
 * any transient refusal worth waiting out and short of the timer's own limit, so the
 * wait that happens is always the wait that was asked for, up to here.
 */
export const NETWORK_MAX_WAIT_MS = 60 * 60 * 1000;

/**
 * How long a wait has to be before the review says out loud that it is waiting.
 *
 * A honoured Retry-After is however long the host asked for, which can be a minute or
 * more. Nothing on screen for that long is indistinguishable from a hang, and the
 * difference between the two is the whole reason the wait is acceptable - so past this
 * the reason is printed. Below it, the review just gets on with it.
 *
 * It is a threshold on the WAIT, not on which path set it: the guessed backoff crosses
 * it from its second rung on, so a host refusing without saying when is narrated too.
 * That is deliberate - seven seconds of silence per refused package reads as a hang
 * whether or not the host explained itself.
 */
export const NETWORK_ANNOUNCE_WAIT_MS = 2000;

/**
 * GitHub orgs whose repos are trusted by provenance (first-party sources), so a
 * vendored file pinned to one is accepted WITHOUT meeting the stars bar above.
 * The bundled bytes are still compared to upstream, so a modified copy is still
 * reported. Owner match is exact + case-insensitive. It covers every github
 * source form (github.com blob, raw.githubusercontent, jsDelivr gh) since all
 * classify to kind "github" with this owner. Thunderbird's own add-on helper
 * repos (e.g. thunderbird/webext-support) live here but are below the generic
 * bar.
 */
export const VENDOR_TRUSTED_GITHUB_ORGS = ["thunderbird"];

/** Limits when fetching an (untrusted, submission-declared) vendor source. */
export const VENDOR_FETCH_TIMEOUT_MS = 10000;
export const VENDOR_FETCH_MAX_BYTES = 12 * 1024 * 1024;

/**
 * How many VENDOR entries must name one npm package@version before the package is
 * fetched whole (its registry tarball) instead of a file at a time.
 *
 * Both routes answer the same question - are these the bytes published at that
 * path - so this is only ever a question of which costs less. One tarball is a
 * single request but the whole package; N files are N requests but only what the
 * add-on ships. At two entries the tarball already removes a request, and a lone
 * entry never pays a whole package for one file.
 */
export const VENDOR_GROUP_MIN_ENTRIES = 2;

/**
 * Decompressed-size cap when extracting an npm-registry tarball source, to bound a
 * decompression bomb (the compressed download is already capped by
 * VENDOR_FETCH_MAX_BYTES). gunzip aborts past this.
 */
export const VENDOR_TARBALL_MAX_UNPACKED_BYTES = 64 * 1024 * 1024;

/**
 * Decompressed-size cap when unpacking a submitted add-on (.xpi/.zip or folder),
 * to bound a decompression bomb: a small archive can inflate to gigabytes and
 * exhaust memory before any check runs. Sits well above a real Thunderbird add-on
 * (tens of MB unpacked) while stopping a bomb long before RAM is exhausted.
 */
export const ADDON_MAX_UNPACKED_BYTES = 128 * 1024 * 1024;

/**
 * OSV vulnerability database query endpoint (https://osv.dev). A pinned
 * package.json dependency (name@version, exact or lock-resolved) is POSTed here
 * to learn whether the bundled version has known advisories. No API token is
 * needed. OSV ingests the GitHub Advisory DB, so it covers `npm audit`'s npm
 * data and more. A query it does not answer ends the review (src/util/net.js).
 */
export const VENDOR_OSV_API = "https://api.osv.dev/v1/query";

/**
 * OSV batch query endpoint, used for the LOCK-FILE tree audit (hundreds of
 * packages per submission, which one-at-a-time queries would not carry). Its
 * response is deliberately thin - each hit is only `{id, modified}`, with no
 * severity, aliases or fixed versions - so every hit must be hydrated through
 * VENDOR_OSV_VULN_API before it can be reported. Declared dependencies keep the
 * single-query endpoint above, which answers all of that in one request.
 */
export const VENDOR_OSV_BATCH_API = "https://api.osv.dev/v1/querybatch";

/** OSV single-advisory endpoint; an id is appended to hydrate a batch hit. */
export const VENDOR_OSV_VULN_API = "https://api.osv.dev/v1/vulns/";

/**
 * Packages per batch request. A few hundred answer in well under a second, while
 * a request carrying a whole large tree at once is refused by the endpoint.
 */
export const VENDOR_OSV_BATCH_SIZE = 200;

/**
 * Distinct advisories hydrated per tree audit. A runaway bound, not a policy: a
 * dropped advisory is invisible in the report, so this has to sit far above what
 * an honest submission reaches. The worst real submission measured carried about
 * a hundred distinct advisories across its whole tree, and the batch step is
 * already bounded by VENDOR_LOCK_MAX_PACKAGES, so this only ever stops a tree
 * that is pathological rather than merely neglected.
 */
export const VENDOR_OSV_HYDRATE_MAX = 2000;

/**
 * Packages enumerated from one lock file. Real trees run to a few thousand; past
 * this the submission is not something a reviewer builds by hand anyway.
 */
export const VENDOR_LOCK_MAX_PACKAGES = 10000;

/**
 * How deep a chain of file:/link: local packages is walked (the root's own target is depth
 * 1). A real monorepo-style split nests one, occasionally two levels; this is a runaway
 * bound, not a policy - a genuine cycle (A -> B -> A) is already stopped by the package files
 * already found, so this only stops a long CHAIN of distinct directories a submission could
 * otherwise make the walk follow indefinitely.
 */
export const LOCAL_PACKAGE_FILE_MAX_DEPTH = 8;

/**
 * The OSV bands a lock-tree advisory is reported at. A package nobody declared is
 * only worth the developer's attention when it would fail the review, so a
 * moderate or low one deep in the tree produces nothing at all. Declared
 * dependencies are reported at every band (src/lib/vuln-findings.js).
 *
 * NOT the whole threshold: an advisory saying the package itself is malicious is
 * reported whatever its band, because those state none at all. Widening or
 * narrowing this list moves the band rule and nothing else (src/vendor/verify.js
 * reportableInTree).
 */
export const VENDOR_TREE_BANDS = ["high", "critical"];
