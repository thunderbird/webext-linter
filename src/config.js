// Central configuration: the tool's behavior defaults and deliberate policy
// toggles, kept in one easy-to-find place rather than scattered across deep
// modules. CLI flags override the defaults at runtime. The toggles have no flag
// and are changed here, where each records why it has its value.

/** Schema channel fetched when --schema-channel is not given. */
export const DEFAULT_CHANNEL = "release";

/** The channels --schema-channel accepts. */
export const VALID_CHANNELS = ["release", "beta", "esr"];

/** Directory where fetched schema zips are cached (--schema-cache default). */
export const DEFAULT_CACHE = ".schema-cache";

/** Anthropic model used for LLM checks when --claude-model is not given. */
export const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * Cap on the tokens the model may generate in a reply (output, not input). The
 * Anthropic API requires max_tokens and returns a 400 when it exceeds a model's
 * output ceiling, so this cannot be omitted. 8192 is safe: it is within every
 * current Claude model's ceiling (never a 400) and large enough that our verdict
 * JSON and change/add-on summaries never truncate.
 */
export const MAX_RESPONSE_TOKENS = 8192;

/**
 * Max distinct add-on files an LLM check sends in one batched request. A check
 * collects all its candidates (each an id pointing at a file:line site) and asks
 * the model for a verdict per id in one call; the corpus is the union of the
 * files those candidates need. When that union would exceed this many files the
 * candidates are split across several calls (a single candidate whose own corpus
 * is larger still gets its own call). The bound is files, not bytes, because the
 * files are the real work the model reads; a call that still overruns the context
 * window errors and its candidates fall back to manual review. Tunable.
 */
export const MAX_FILES_PER_BATCH = 12;

/**
 * Cap on the TOTAL model requests one run may make before pausing - across every
 * LLM check (each candidate batch is one request), the advisory summaries, and
 * the vendor-parse fallback. MAX_FILES_PER_BATCH bounds a single request; this
 * bounds their count, so a pathological add-on cannot fan out into thousands of
 * calls. On reaching it the run asks (at an interactive terminal) whether to run
 * this many more, re-asking at every multiple; non-interactively it stops and the
 * remaining LLM work escalates to manual review. Doubles as the per-confirmation
 * increment. See src/llm/budget.js. Tunable.
 */
export const MAX_LLM_REQUESTS_PER_RUN = 25;

/** Max characters of a truncated display label (e.g. a long URL). */
export const DISPLAY_TRUNCATE_LENGTH = 80;

/**
 * Leading characters of a JS file scanned for a "/*!" minifier banner when
 * classifying it as a bundled library (see classify in checks/lib/bundled.js).
 */
export const BANNER_SCAN_CHARS = 1000;

/**
 * Display cap: the most location lines a single grouped report entry lists (an
 * Issues or Manual-review entry with many "- file:line" locations). Beyond this,
 * the rest are replaced by one "... more, excluded from this list" marker. This
 * is a rendering limit only (see src/report/format.js) - the summary counts,
 * JSON output, and LLM logic still see every finding.
 */
export const MAX_ENTRIES_PER_CATEGORY = 25;

/**
 * Whether the reference graph (reachability) skips "non-authored" JS - library,
 * minified, obfuscated, or VENDOR.md-declared files (see nonAuthoredJs in
 * src/checks/lib/bundled.js) - when extracting outgoing edges.
 *
 * FALSE (default): reachability parses EVERY file for edges. The source-level
 * finding scanners (the eval checks, unsafe-html, remote-script, code-sanity)
 * still skip those files on purpose - a bundled library legitimately uses
 * eval/innerHTML/sync-XHR, so scanning its internals is noise, and minified or
 * obfuscated code is rejected and re-reviewed as original source anyway. But
 * reachability must NOT skip them: dropping a file's loader edges
 * (import/getURL/executeScript/...) makes every file it loads look unreachable,
 * so a genuinely-used asset gets reported as unused - a wrong result. So the
 * graph follows edges everywhere.
 */
export const REACHABILITY_SKIPS_NON_AUTHORED = false;

// Vendor verification (src/vendor/verify.js) is the only stage that makes
// outbound network requests. It runs once, before the review, and the checks
// read its result.

/**
 * The only hosts vendor verification fetches a declared source from. A source
 * on any other host is sent to manual review, never requested. All four pin an
 * immutable version or tag, so a byte comparison is stable. A
 * github.com/.../blob URL is rewritten to raw.githubusercontent.com first.
 */
export const VENDOR_TRUSTED_HOSTS = [
  "unpkg.com",
  "cdn.jsdelivr.net",
  "cdnjs.cloudflare.com",
  "raw.githubusercontent.com",
];

/**
 * "Broadly used" thresholds - the bar a declared library must clear to be
 * auto-trusted (else manual review): npm monthly downloads, or GitHub stars.
 * A cdnjs library is trusted by membership (cdnjs curates its catalog).
 */
export const VENDOR_NPM_MIN_DOWNLOADS = 1000;
export const VENDOR_GITHUB_MIN_STARS = 100;

/**
 * GitHub orgs whose repos are trusted by provenance (first-party sources), so a
 * vendored file pinned to one is accepted WITHOUT meeting the stars bar above.
 * The bundled bytes are still compared to upstream, so a modified copy is still
 * reported. Owner match is exact + case-insensitive; covers every github source
 * form (github.com blob, raw.githubusercontent, jsDelivr gh) since all classify
 * to kind "github" with this owner. Thunderbird's own add-on helper repos
 * (e.g. thunderbird/webext-support) live here but are below the generic bar.
 */
export const VENDOR_TRUSTED_GITHUB_ORGS = ["thunderbird"];

/** Limits when fetching an (untrusted, submission-declared) vendor source. */
export const VENDOR_FETCH_TIMEOUT_MS = 10000;
export const VENDOR_FETCH_MAX_BYTES = 12 * 1024 * 1024;

/**
 * Timeout for the ATN API lookup that resolves an add-on's listing slug (for the
 * reviewer review-page URL printed in the text report's Manual review section).
 */
export const ATN_FETCH_TIMEOUT_MS = 10000;
