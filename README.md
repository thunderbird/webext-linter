# webext-linter

Verifies Thunderbird WebExtensions against the [annotated WebExtension API
schemas](https://github.com/thunderbird/webext-annotated-schemas) and ATN review
policies. The tool will report API, manifest, permission, and bundled-code
issues. It does not modify the reviewed sources.

The schema verification works like
[`addons-linter`](https://github.com/mozilla/addons-linter) - parsing the
JavaScript and matching `browser.*` / `messenger.*` / `chrome.*` calls against
the API surface - but uses Thunderbird's annotated schema files.

Beyond the deterministic checks, a few review judgments that resist static
analysis can optionally be delegated to Claude (Anthropic) when an API token is
supplied. See the LLM checks under Review checks below.


## Usage

```sh
npm install
```

Run via `npm` (the `--` separator stops npm from eating the parameters):

```sh
npm run help
npm run verify -- <xpi|folder> [options]
```

Run the `node` script directly:

```sh
node verify.js <xpi|folder> [options]
```

The schema review **always** reads `manifest_version` and uses the matching
schema (MV2 → `<channel>-mv2`, MV3 → `<channel>-mv3`). An add-on that omits
`manifest_version` (or has a missing/invalid manifest) is treated as MV2.

| Option | Description |
| --- | --- |
| `--schema-cache <dir>` | Where downloaded schema zips are cached (default `.schema-cache`). |
| `--schema-channel <name>` | Schema channel (default `release`). One of `release`, `beta`, `esr`. |
| `--schema-force-refresh` | Re-download the schema even if a cached copy exists. |
| `--schema-zip <path>` | Use a local schema zip (or directory) instead of downloading. |
| `--checks-only <ids>` | Only run these checks (comma-separated). See the check list below. |
| `--checks-skip <ids>` | Skip these checks (comma-separated). See the check list below. |
| `--report-format <text\|json>` | Report output format (default `text`). |
| `--report-out <file>` | Write the report to a file in addition to stdout. |
| `--claude-enabled` | Enable the LLM checks. The key is read from the `CLAUDE_API_KEY` environment variable. |
| `--claude-list-models` | List the Anthropic models available to your token, then exit. |
| `--claude-model <id>` | Model for the LLM checks. See `--claude-list-models` for the choices and the default. |
| `--allow-experiments` | Accept add-ons that use Experiment APIs, instead of rejecting them as unsupported. Off by default. |
| `--eslint` | Run the ESLint `code-sanity` check on authored JS. Off by default. |
| `--diff-to <xpi\|folder>` | Previously published version, to diff against. |
| `--diff-summary` | Add an AI assisted **"Summary of changes"** section: how the add-on changed since the `--diff-to` baseline. Needs `--diff-to` and the LLM enabled (`--claude-enabled`). |
| `--full-summary` | Add an AI **"Summary of add-on"** section after the report - what the add-on does, with security/privacy notes and a permission review (which declared permissions appear unused) - from its (almost) full current source (vendored and unused files excluded). Advisory, not a finding. Needs the LLM enabled (`--claude-enabled`). |
| `--verbose` | Verbose logging. |

The LLM checks need an Anthropic API key, supplied via the `CLAUDE_API_KEY`
environment variable (there is no API-key flag):

```sh
export CLAUDE_API_KEY=sk-ant-...
node verify.js <xpi|folder> --claude-enabled
```

**Exit codes:** `0` no errors · `1` one or more error-severity findings · `2`
tool failure.


## Review checks

A review has three kinds of check, all declared in
[assets/registry.yaml](assets/registry.yaml):

- **Deterministic** - decided entirely in code, no LLM; offline apart from the
  one-time vendor source fetch (noted below). A few are gated by review mode
  (`diff: true`/`false`).
- **LLM** - a deterministic pre-flight always runs offline; only the ambiguous
  residue is delegated to Claude (when an API key is supplied) or routed to
  manual review.
- **Manual** - checks the tool can't make itself, surfaced as a todo list.

Every user-facing string lives in the registry; a check emits only structured
data - an `item` (the offending token: an API path, permission, host pattern,
file, …), a file and a line - never prose. A check that emits Issues findings
defines a `response` (the Issues wording); a check that routes a case to manual
review defines `instructions` (the manual-review wording), and an `llm` check
also a `prompt` (the rubric sent to the LLM); a `manual` entry has only
`instructions`. Each may contain an `{{item}}` placeholder, filled per
finding with that finding's `item` (one per occurrence); a string without
`{{item}}` is used as-is. So the **Issues** list reads as ready-to-send wording,
e.g. `browser.contextMenus is not supported. …`. In the review report it is
grouped by severity (error, then warning, then info) under the headings
configured in `issue-headings:` in the registry, with the numbering continuous
across the groups.

When run interactively (a terminal), the tool also prints live progress to
stderr - the check currently being evaluated and any LLM escalations in flight -
so stdout stays reserved for the report. Piped or redirected runs (CI, a JSON
consumer) stay quiet.


### Deterministic checks

Each `deterministic-checks` entry carries a `check:` field linking to a module
in [src/checks/rules/](src/checks/rules/) - adding a check means adding an entry
plus its module. The entry supplies the severity stamped onto every finding the
check emits (a check cannot override it); an escalate-only check that emits no
findings - only a manual-review item - carries no severity. A deterministic
check either decides each case as a finding or escalates it straight to manual
review (e.g. `vendor-unverified`, `native-messaging`, `fork-check`); LLM checks
escalate only their ambiguous residue.

| Check id (`check:`) | What it flags |
| --- | --- |
| `api-coverage` | Dynamic/aliased API access static analysis can't resolve (info). Files that fail to parse are `unparsable-file`. |
| `async-onmessage` | An async listener passed to `runtime.onMessage.addListener()`. |
| `background-module` | A background script (`background.scripts`/`service_worker`) that uses static ES module syntax (`import`/`export`) while the manifest's background is not declared `"type": "module"` - it won't load as a module (error). Background pages and content scripts are out of scope. |
| `bundled-files` | Referenced files that aren't packaged: `content_scripts`/`background`/popup/options manifest entries, and packaged-file paths passed to file-loading API calls (script registration, `setIcon`, `executeScript`/`insertCSS`, `getURL`, ...) - the same schema-derived loader set that fuels the reference graph, not a hardcoded list. |
| `cleartext-transmission` | Data transmitted to a remote host over an unencrypted scheme (`http://`/`ws://`/`ftp://`) by an overt API (`fetch`, XHR, WebSocket, `sendBeacon`) - any cleartext send, regardless of payload (error). Covert disguised channels are the `disguised-*` checks. |
| `code-sanity` | Opt-in (only runs with `--eslint`). ESLint-based code errors: `no-redeclare`, `no-shadow`, dupe/unreachable/self-* rules, empty blocks (`no-empty`, e.g. an error-swallowing empty `catch`) (info). Style/fixable rules (e.g. `prefer-const`) are excluded - the tool is read-only, so "rewrite this" is not a review concern. No `no-undef` (WebExtension scripts share a global scope). |
| `csp-unsafe-eval` | A `content_security_policy` that allows `'unsafe-eval'` - permits dynamic code execution (error). |
| `csp-unsafe-inline` | A `content_security_policy` that allows `'unsafe-inline'` - permits dynamic code execution via inline scripts (error). |
| `debugger-statement` | Unconditional `debugger` statements. |
| `default-locale-missing` | A packaged `_locales/` directory but no `default_locale` manifest key - Thunderbird refuses to load the add-on (error). |
| `default-locale-unused` | A `default_locale` manifest key but no packaged `_locales/` directory - Thunderbird refuses to load the add-on (error). |
| `deprecated-api` | Deprecated APIs (member or namespace level), and APIs whose `version_added` is newer than the target Thunderbird. |
| `disguised-navigation` | Data smuggled out through a page navigation (`location.assign`/`replace`) built with appended runtime data (error, regardless of consent). |
| `disguised-resource` | Data smuggled out through a resource-load URL (image/iframe/media `src`, `setAttribute`) built with appended runtime data (error, regardless of consent). |
| `disguised-stylesheet` | Data smuggled out through a stylesheet or CSS `url()` built with appended runtime data (error, regardless of consent). |
| `disguised-window` | Data smuggled out through a `window.open()` to a remote URL built with appended runtime data (error, regardless of consent). |
| `eval-call` | An `eval()` call in authored JS - dynamic code execution (error). |
| `experiment-missing-strict-max-version` | An accepted Experiment (`--allow-experiments`) that sets no `strict_max_version` (error). Silent when experiments are disallowed, since `experiment-not-allowed` already rejects it. |
| `experiment-not-allowed` | An Experiment (declares `experiment_apis`) when experiments are not enabled via `--allow-experiments` (error, on by default). |
| `fork-check` | New-submission manual prompt (`diff: false` - the inverse of a diff check, so it is skipped when reviewing an update against a `--diff-to` baseline): confirm a forked add-on is clearly distinguished from the original and offers a significant difference in functionality and/or code - routed to manual review. |
| `function-constructor` | A `new Function(...)` (the Function constructor) in authored JS - dynamic code execution (error). |
| `manifest-invalid-json` | manifest.json is present but is not valid JSON (error). |
| `manifest-missing` | No manifest.json at the add-on root (error). |
| `manifest-missing-key` | A required top-level manifest key (`manifest_version`/`name`/`version`) is absent (error). |
| `manifest-unknown-permission` | A declared permission value that is neither a known permission, a data-collection permission, nor a match pattern (error). |
| `manifest-version-mismatch` | `manifest_version` disagrees with the schema set being reviewed (error). |
| `minimize-host-permissions` | Broad (`<all_urls>` / `*` host) permissions requested as required (info). |
| `missing-library` | A JS file (not in the VENDOR file) that looks like a bundled third-party library - by a `/*! … */` banner, UMD wrapper, `.min.js` name, or known library filename (warning). Heuristic, no hash DB: it can't say which library or verify the version. |
| `missing-manifest-key` | A called API needs a manifest key (e.g. `action`) that is not declared (error). The manifest-key counterpart of `missing-permission`. |
| `missing-permission` | A permission used by a called API but not declared (error). An API needing a manifest key is `missing-manifest-key`. |
| `missing-vendor-file` | A VENDOR entry (file + source URL) naming a file not present in the submission (warning). |
| `mistyped-manifest-value` | A known manifest key whose value has the wrong type, validated with ajv against a JSON Schema derived from the annotated schema (warning). Thunderbird misreads such values. |
| `native-messaging` | The `nativeMessaging` permission (in `permissions` or `optional_permissions`), which lets the add-on exchange messages with a native application outside Thunderbird - routed to manual review to confirm disclosure (No Surprises). |
| `non-experiment-strict-max-version` | A non-Experiment that pins `strict_max_version` (warning - it only blocks installs on newer Thunderbird). |
| `obfuscated-code` | A JS file (not a recognized library) shipped minified or obfuscated - by minified line geometry, `_0x…` obfuscator identifiers, or `eval`/`Function`-of-decoded-string packers (error). High precision, partial recall - some obfuscators evade it. |
| `privacy-policy` | Data transmitted to a hardcoded remote host by an overt API - routed to manual review to confirm the listing carries a privacy policy disclosing the collection (the policy text is not part of the package). Complements `data-exfiltration` (which judges consent). |
| `strict-max-version-bump-only` | Diff check (needs `--diff-to`): fires (info) when a submission changes only the `version` and the gecko `strict_max_version` vs. the prior version - the developer could raise the max on ATN instead of resubmitting. Runs only with `--diff-to`. |
| `string-timer` | A code string passed to `setTimeout`/`setInterval` (it is eval'd) - dynamic code execution (error). |
| `sync-xhr` | Synchronous `XMLHttpRequest` (`open(..., false)`). |
| `trademark-violation` | Add-on name (resolved from `_locales` for a `__MSG__` name) using a Mozilla trademark - `Firefox`/`Mozilla`/`MZLA` anywhere, or `Thunderbird` other than as a trailing "for Thunderbird" (error, case-insensitive). The icon is a separate manual check. |
| `unknown-api` | Unknown namespaces, unknown members (incl. methods on property types like `storage.local.x`), and APIs marked `unsupported`. |
| `unparsable-file` | A JS file that failed to parse, so its API checks were skipped (info). |
| `unpinned-dependency` | A `package.json` dependency declared as a version range with no lock file, so it can't be pinned to one release and verified (error). |
| `unpinned-vendor-source` | A VENDOR-declared file whose (trusted-host) source is not pinned to an immutable version/tag/commit, so its bytes can't be verified (error). |
| `unrecognized-manifest-key` | A top-level manifest key the schema does not define - Thunderbird ignores it (warning). |
| `unsafe-html` | Dynamic content written to `innerHTML`/`outerHTML`/`srcdoc`/`insertAdjacentHTML` (warning). |
| `vendor-modified` | A declared third-party file whose bytes don't match its pinned source (EOL-tolerant compare) - it appears modified from upstream (error). |
| `vendor-unverified` | Declarations that can't be settled automatically - an untrusted-host source, a library not confirmed widely used, an unfetchable source, or an unparsable VENDOR file - routed to manual review. |

The vendor checks are fed by a one-time pre-step that fetches each declared
source and byte-compares it (the tool's only outbound requests, and only to
unpkg / jsDelivr / cdnjs / raw.githubusercontent); the checks above just read
its result.

The per-file JS checks (`code-sanity`, the eval checks, `unsafe-html`,
`remote-script`) skip files that are not the developer's authored source - JS
classified as a library/minified/obfuscated bundle, or declared in the VENDOR
file - to save time and noise. This loses nothing: minified/obfuscated code is
rejected anyway (`obfuscated-code`/`missing-library` flag it and request the
original, reviewable sources), and vendored files are declared third-party.
(`remote-script` still scans HTML/CSS and the CSP regardless.) A future
hash-based allow/block-list is meant to replace this surface-signal heuristic.


### LLM checks

Each LLM check is a `rules/` module linked by `check:`, with a `prompt:` (the
rubric sent to the LLM) and an `instructions:` (the manual-review wording). It
**always runs its deterministic pre-flight**, token or not: cases the pre-flight
can settle become findings directly, and only the genuinely-ambiguous residue is
escalated - **per case**. The orchestrator alone resolves an escalation: when
the LLM is enabled (`--claude-enabled` with a `CLAUDE_API_KEY`) it sends the case
to Claude as the `prompt` plus that
case's evidence (e.g. the offending file's source), over a shared, prompt-cached
add-on context. Claude returns a three-way verdict - **fail** / **pass**  and
**unsure** - so a confident result is final, but an **unsure** one routes that
case to manual review (the same place it goes with no token, or if the call
errors). So an add-on with no ambiguity never spends tokens, and nothing is
silently dropped: a case is auto-decided only when the model is confident. Pick
the model with `--claude-model`, or run `--claude-list-models` to see the choices
and the default.

| Check id (`check:`) | Pre-flight (always) + what the LLM judges |
| --- | --- |
| `remote-eval` | Pre-flight: the statically-undecidable `fetch()->eval` pattern → the LLM judges (given the offending file) whether the executed code is fetched remotely. The definite dynamic-execution cases are the deterministic `eval-call`/`function-constructor`/`string-timer`/`csp-unsafe-eval`/`csp-unsafe-inline` checks. |
| `remote-script` | Pre-flight: remote `<script>`/`<link>`/`@import`/`url()`/media/imports/`importScripts`/runtime injection/WASM, and a CSP permitting a remote script source → a finding. Statically-undecidable cases (non-literal URLs, inline `data:`/`blob:` script sources) → the LLM judges whether the source is remote. |
| `data-exfiltration` | Pre-flight: a normal transmission (`fetch`/XHR/WebSocket/EventSource/`sendBeacon`) to a remote/dynamic host → the LLM judges, given the file and the options page, whether user data is sent without an explicit opt-in. Covert channels are the separate `disguised-*` errors. |
| `missing-english-localization` | Pre-flight: a `_locales` English directory (`en`, `en-US`, …) present → pass; `_locales` but no English → a finding. No `_locales` → the LLM judges whether user-facing strings are hardcoded in a non-English language. |
| `minimize-web-accessible-resources` | Pre-flight: over-broad exposure (a resource pattern like `*`, or MV3 `matches` of `<all_urls>`/`*://*/*`) and concrete resources no content script/page loads → a finding. An ambiguous exposed resource (dynamic loaders, or name mentioned) → the LLM judges whether it is needlessly exposed. |
| `unused-files` | Pre-flight: hidden/junk by name, and files reachable from no manifest entry point (a reference graph over imports/`getURL`/HTML/CSS plus schema-derived file-loading APIs) - a clearly-unreferenced file is a finding. An ambiguous file (string-mentioned, or the add-on uses dynamic loaders) → the LLM judges whether it is unused. License/README/VENDOR/`_locales` are exempt. |


### Manual checks

Some review steps can't be automated - they need hands-on testing or a human's
judgment over content the tool can't see (the store listing, screenshots, the
icon). These live under `manual-checks` in the yaml and are surfaced in the
report's **Manual review** to-do list (each with its `instructions`) for the
reviewer to carry out, rather than run. An LLM check whose pre-flight can't
settle a case joins the same list when no token is set, when Claude's verdict is
`unsure`, or when the call errors, so a check is never silently dropped - and a
check only appears here when it actually needs a human, not by default. The list
appears only in the text report - it is omitted from JSON output (which ATN
consumes for auto-verification).

| Check | What the reviewer verifies |
| --- | --- |
| Check the submission for spam | The listing and add-on for spam or inappropriate, misleading, or low-effort content. |
| Test the add-on and request testing information if needed | Functionality in a test profile; fail if credentials or other info are needed to continue. |
| Check for "No Surprises" policy violations | The code diff for behavior not documented on the ATN listing that could surprise the user. |
| Check for a missing payment disclosure | Whether the add-on requires payment but the "needs payment" flag is not set on ATN. |
| Check suitability for listing | Whether the add-on targets a limited or non-public audience (better self-hosted than listed). |
| Acceptable Use Policy | The name, summary, description, and screenshots against Mozilla's Acceptable Use Policy. |
| Check the icon for trademark or logo imitation | The icon for imitation of the Thunderbird or Mozilla logo (an image the automated checks can't inspect). |


## Examples

```sh
# Review a submitted xpi against the matching schema (read-only - report only)
node verify.js ./submission.xpi

# Review an unpacked source folder
node verify.js ./my-addon

# esr channel; machine-readable; offline schema
node verify.js ./submission.xpi --schema-channel esr --report-format json --schema-zip ./schemas.zip

# Review with the LLM checks enabled, plus an AI summary of the add-on
CLAUDE_API_KEY=sk-… node verify.js ./submission.xpi --claude-enabled --full-summary

# List the Claude models your token can use, then exit (needs a token)
CLAUDE_API_KEY=sk-… node verify.js --claude-list-models
```

## Contributing

Requires Node `>=20`; run `npm install` once to fetch the dependencies. Review
runs directly (see [Usage](#usage)) - there is no `npm run` wrapper for it;
`npm run help` prints the help screen.

Before sending a change, run the checks:

```sh
npm run lint          # ESLint over src/ and the root entry files
npm run format:check  # Prettier (run `npx prettier --write <glob>` to fix)
npm test              # add-on golden snapshots + the unit suite
```

Conventions:

- **Prettier-formatted and ESLint-clean** - double quotes, semicolons,
  `printWidth` 80. `npm run format:check` and `npm run lint` must pass.
- **The registry owns every model-facing string.** Check rubrics, the LLM
  system intro, notices, and prompts all live in
  [`assets/registry.yaml`](assets/registry.yaml) - never hardcode
  them in `src/`.
- **Each source file opens with a header comment** stating what belongs in it
  and what does not; keep it accurate when you edit, and comments describe the
  current code (not the diff).
- **Golden tests are byte-exact.** If a change is meant to alter report output,
  regenerate with `UPDATE_GOLDEN=1 npm test` and review the diff.

(See [tests/README.md](tests/README.md) for the test suite and how it's
organized.)
