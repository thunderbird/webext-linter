# webext-linter

Verifies Thunderbird WebExtensions against the [annotated WebExtension API
schemas](https://github.com/thunderbird/webext-annotated-schemas) and ATN review
policies. The tool will report API, manifest, permission, and bundled-code
issues. It does not modify the reviewed sources.

The schema verification works like
[`addons-linter`](https://github.com/mozilla/addons-linter) - parsing the
JavaScript, TypeScript and Vue source and matching `browser.*` / `messenger.*` /
`chrome.*` calls against the API surface - but uses Thunderbird's annotated
schema files.

A case the analysis cannot settle is not guessed at: it is handed to the reviewer
as a to-do, split into what can be settled by reading the add-on's code and what
needs a person. See Review checks below.


## Usage

```sh
npm install
```

Show all options:

```sh
npm run help
```

Run the `node` script directly:

```sh
node verify.js <xpi|folder> [options]
```

Or install it as a command and run it from anywhere:

```sh
npm install -g .    # from a clone of this repo
webext-linter <xpi|folder> [options]
```

For development, use `npm link` instead of `npm install -g .` so the command
tracks your working copy. Once the package is published to npm,
`npm install -g webext-linter` and `npx webext-linter` work as well.

The schema review picks the matching schema **automatically** from the add-on's
own manifest — no channel flag. Two dimensions:

- **Manifest version**: `manifest_version` selects `mv2` vs `mv3`. An add-on that
  omits it (or has a missing/invalid manifest) is treated as MV2.
- **Channel** (`release`, `esr`, `beta`): chosen from the add-on's supported
  version range. The **upper bound** (`strict_max_version`) decides: an add-on
  capped at a channel's own Thunderbird major targets that train, so its schema is
  used — e.g. `strict_max_version: "140.*"` with ESR at 140 → the **ESR** schema
  (whose `version_added` entries reflect APIs backported into the ESR train). With
  no cap, or a cap that matches no cached train, it falls back to **release**; the
  `version_added` checks still flag genuinely unsupported APIs.

The options, grouped as in `--help`:

**Cache:** the schema, the library-hash DB and the allowed-experiments list are each
downloaded once and reused; the CDN lookup cache fills incrementally as a best-effort
side-channel.

| Option | Description |
| --- | --- |
| `--cache-clear` | Delete every cache directory below before the review, so all fetched sources (schema, library-hash DB, CDN lookups, allowed-experiments) are re-downloaded from scratch — as on a first run. |
| `--cache-schema-dir <dir>` | Where the downloaded schema zips are cached (default `.schema-cache`). |
| `--cache-hash-db-dir <dir>` | Where the fetched library-hash database (the addons-linter "dispensary" `hashes.txt`, used by `missing-library` to identify a bundled library by its exact content hash) is cached (default `.lib-mozilla-hash-db-cache`). |
| `--cache-cdn-lookup-dir <dir>` | Where the jsDelivr CDN hash-lookup results are cached — best-effort, backing the optional `--cdn-lib-lookup` (default `.lib-cdn-lookup-cache`). |
| `--cache-experiments-dir <dir>` | Where the fetched allowed-experiments zip (the Thunderbird Draft-API list feeding the Experiment checks, e.g. `experiment-modified`) is cached (default `.experiments-cache`). |

The banned/unadvised library policy (`assets/library-blocks.yaml`, read by `banned-library`) is curated by hand from Mozilla's [addons-linter third-party library docs](https://github.com/mozilla/addons-linter/blob/master/docs/third-party-libraries.md), since Mozilla ships no machine-readable list; that page
is monitored and upstream changes are ported manually.

**Check selection:**

| Option | Description |
| --- | --- |
| `--checks-only <ids>` | Only run these checks (comma-separated). See the check list below. |
| `--checks-skip <ids>` | Skip these checks (comma-separated). See the check list below. |

**Report output:**

| Option | Description |
| --- | --- |
| `--report-format <text\|json>` | Report output format (default `text`). |
| `--report-out <file>` | Write the report to a file in addition to stdout. |

**Source code archive (SCA):**

| Option | Description |
| --- | --- |
| `--sca-root <folder\|zip>` | The source archive root (holds `package.json`/lock). Switches to SCA mode. The readable source is reviewed for code defects and its declared dependencies are audited for popularity + vulnerabilities; the built XPI (the positional path) is the shipped artifact - it supplies the manifest, experiments, file-completeness checks (bundled/web-accessible/unused), the `--diff-to` baseline, and the packaging summary. See [Source code archive (SCA) mode](#source-code-archive-sca-mode) below. |
| `--sca-source <path>` | The add-on code root, relative to `--sca-root` or an absolute path (e.g. `src` or `addon`). Optional; defaults to `.` (the whole `--sca-root` reviewed as the source - a flat layout with `manifest.json` at the root). Needs `--sca-root`. |
| `--sca-exp-source <path>` | The Experiment implementation folder, relative to `--sca-root` or an absolute path, and within `--sca-source` (e.g. `addon/experiment-api`). Its privileged, non-WebExtension files are excluded from the WebExtension API/permission/eval checks. Needs `--sca-root`; required when `--allow-experiments` is used in SCA mode. |

**Other:**

| Option | Description |
| --- | --- |
| `--allow-experiments` | Accept add-ons that use Experiment APIs, instead of rejecting them as unsupported. Off by default. |
| `--cdn-lib-lookup <true\|false>` | Identify an unrecognized bundled library (minified or readable) by a jsDelivr content-hash lookup (default `true`). Results are cached; an offline run simply finds no match. |
| `--diff-to <xpi\|folder>` | Previously published version, to diff against. |
| `--eslint` | Run the ESLint `code-sanity` check on authored JS. Off by default. |
| `--verbose` | Verbose logging. |

**Exit codes:** `0` no errors · `1` one or more error-severity findings · `2`
tool failure.

### Source code archive (SCA) mode

Some add-ons are submitted as **both** a built XPI (minified, what users install)
and a **readable source archive**. Reviewing the minified XPI directly is noisy, so
SCA mode reviews the readable source instead while still treating the XPI as the
authoritative shipped artifact:

```
node verify.js built.xpi --sca-root ./source-archive --sca-source src
```

SCA only helps when the built XPI can't be read directly. If the shipped XPI's first-party
code is **not** minified or obfuscated, the source archive adds nothing: the review is
performed on the XPI directly (a plain XPI review) and `sca-not-required` (warning) is
reported. Submit only the XPI in that case — a source archive is needed only for a
minified/obfuscated build.

- `--sca-root` is the source archive (folder or zip) that holds `package.json` /
  the lock file; setting it switches on SCA mode. `--sca-source` is the add-on code
  root within it (relative to `--sca-root` or an absolute path, e.g. `src`); it is
  **optional and defaults to `.`** - the whole `--sca-root` reviewed as the source, for
  a flat layout with `manifest.json` at the root (`node verify.js built.xpi --sca-root
  ./source-archive`).
- The **readable source** is reviewed for code defects (the API/permission/eval/
  exfiltration checks run over every source file).
- The **declared dependencies** (`--sca-root`'s `package.json`) are audited: each
  must be a pinned npm package or a GitHub URL, and is gated on popularity
  (npm downloads / GitHub stars) and known vulnerabilities. Anything unpinned or
  from another source is rejected.
- The **build tooling** (everything in `--sca-root` outside `--sca-source` - build
  scripts, configs, `.npmrc`) is reviewed. Deterministic policy: the build must use
  **npm or pnpm** (a `yarn.lock` / `bun` build is rejected), must not commit a
  `node_modules` folder or a built archive (`.xpi` / `.zip` - both are build output,
  never shipped in a source submission), must not point the package registry elsewhere
  (an `.npmrc` `registry=` is rejected), and any `package.json` install hook
  (`postinstall`, …) is flagged. The build corpus is collected once in setup (over
  the files reached from `package.json`), and two checks gate on it: it must **not
  fetch code or a resource from an undeclared source** (a raw URL, `curl|sh`, an
  unpinned `git clone`, a CDN, a postinstall hook), and must be **built from the source**
  (not packaged from committed artifacts).
- The **built XPI** (the positional path) is the shipped artifact: it supplies the
  manifest, the experiments, the file-completeness checks (bundled / web-accessible
  / unused / locales), the `--diff-to` baseline, and the packaging summary. The
- `--sca-exp-source` names an Experiment implementation folder - relative to
  `--sca-root` (or absolute), and within `--sca-source` (e.g. `addon/experiment-api`)
  - so its privileged, non-WebExtension code is excluded from the WebExtension checks
  (required when `--allow-experiments` is used in SCA mode).
- Because a review spans two artifacts, each finding's `file:line` is prefixed with the
  artifact it lives in - `[XPI]` (the built XPI) or `[SCA]` (the readable source code
  archive) - so a reviewer knows which one to open; the Issues section closes with a
  legend, and the same prefix appears on the live activity feed. A plain XPI review
  (one artifact) adds no prefix.


## Review checks

Every check is declared in [assets/registry.yaml](assets/registry.yaml), and the
section it lives in **is** its phase: the orchestrator looks up the phases it runs,
in order. A section it never asks for is inert.

- **`invalid-experiment-phase`** - the single reject check. An Experiment bundling an
  unsupported API draft (without `--allow-experiments`) is rejected outright, and this
  phase runs ALONE - no other check, no manual reminders.
- **`deterministic-phase`** - every check. Each case is decided in code, offline apart
  from the one-time vendor source fetch, and becomes either a finding or an escalation
  of a case the code cannot settle. A few checks are gated by review mode
  (`diff: true`/`false`, `sca: true`/`false`).
- **`manual-checks`** - checks the tool can't make itself, surfaced as a todo list. Not
  a phase: the orchestrator never asks for this section.

The full flow - setup, the stores it computes, the orchestrator, and how one check of
each phase runs - is described in
[docs/check-flow.html](docs/check-flow.html) ("The review pipeline").

The tables below are an illustrative selection, not the full catalogue. For the
complete, registry-synced list of every check with its own page, see
[docs/index.html](docs/index.html).

### Deterministic checks

Each `deterministic-phase` entry links to a module in
[src/checks/rules/](src/checks/rules/) and supplies the severity for its
findings. A check decides each case in code - as a finding, or as an **escalation**
of a case it cannot settle, which reaches the reviewer as a to-do.

An escalation is sorted by who can settle it. Most are questions about the add-on's
own code and land under **Extended code review**. An escalation the code cannot
answer is marked `manualReview` and lands under **Extended manual review** instead:
`privacy-policy` (the policy is a field in the ATN listing, not in the package),
`native-messaging` (likewise, what the listing discloses about the native app),
`undeclared-build-source` (reproducing the build is the reviewer's own attestation
that the source produces the shipped XPI), and `remote-resources`' upstream lane (a
remote `@import` inside a file matching a published release is that release's line,
not the developer's, so accepting it is a judgement a person owns). Such an entry
is rendered from the registry's `manual-review-instructions`.

Either way the item carries its **suggested response**: once the reviewer settles
the case against the add-on, that is the text the developer receives.

Escalations deliberately reach the human report only - the JSON report omits
`meta.manualReview` and carries just what the tool is certain of, so escalating
rather than finding is what puts the submission in front of a person instead of a
machine.

| Check | What it flags |
| --- | --- |
| `api-coverage` | Dynamic/aliased API access static analysis can't resolve (info). Files that fail to parse are `unparsable-file`. |
| `async-onmessage` | An async listener passed to the `addListener()` of an event that answers with its listener's return value (`runtime.onMessage`, `onMessageExternal`, `onUserScriptMessage`), derived from the schema. |
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
| `eval-call` | An `eval()` call in authored JS outside the WebExtension tree (Experiment/privileged code) - dynamic code execution (error). WebExtension code is exempt: it cannot run eval without a permissive CSP, which `csp-unsafe-eval` flags. |
| `experiment-manual-review` | Every reviewed Experiment (declares `experiment_apis`) - routed to manual review with a reminder that Experiments have full access to Thunderbird's internals and need a careful human code review. Fires for pristine, modified, and `--allow-experiments` submissions; silent for non-Experiments and outright-rejected ones. |
| `experiment-missing-strict-max-version` | An accepted Experiment (`--allow-experiments`) that sets no `strict_max_version` (error). Silent when experiments are disallowed, since `experiment-not-allowed` already rejects it. |
| `experiment-modified` | A bundled Experiment that is a recognised published Thunderbird API draft but a modified or outdated copy (error) - the submission stays on the normal review path but is rejected until the unmodified latest upstream copy is bundled. |
| `experiment-overrides-api` | An Experiment whose declared API path overrides or grafts onto a built-in Thunderbird API instead of adding a new namespace (error). |
| `function-constructor` | A `new Function(...)` (the Function constructor) in authored JS outside the WebExtension tree (Experiment/privileged code) - dynamic code execution (error). WebExtension code is exempt (CSP-gated, see `csp-unsafe-eval`). |
| `manifest-invalid-json` | manifest.json is present but is not valid JSON (error). |
| `manifest-missing` | No manifest.json at the add-on root (error). |
| `manifest-missing-key` | A required top-level manifest key (`manifest_version`/`name`/`version`) is absent (error). |
| `manifest-unknown-permission` | A declared permission value that is neither a known permission, a data-collection permission, nor a match pattern (error). |
| `manifest-version-mismatch` | `manifest_version` disagrees with the schema set being reviewed (error). |
| `minimize-host-permissions` | Broad (`<all_urls>` / `*` host) permissions requested as required (info). |
| `missing-english-localization` | User-facing text hardcoded in a non-English language while the add-on ships no English `_locales` (warning). Pre-flight: an English `_locales` directory (`en`, `en-US`, …) → pass; a `_locales` directory without one → a finding; no `_locales` at all → language-detect the visible HTML text plus the manifest name/description with `franc`, where a confident non-English verdict is the finding. Too little text, or a near-tie with English, escalates. |
| `missing-library` | A bundled JS or CSS file (not in the VENDOR file) whose content hash matches a known third-party library release, named as `name version` (info). Identified by a fetched known-library hash database (Mozilla dispensary's `hashes.txt`), so the match is byte-exact; a file the database doesn't recognize is left to `minified-code`/`obfuscated-code` or scanned as the developer's own code. An identified library is also audited for known vulnerabilities (`vendor-vulnerable`), so an undeclared vulnerable bundle is still caught. |
| `missing-manifest-key` | A called API needs a manifest key (e.g. `action`) that is not declared (error). The manifest-key counterpart of `missing-permission`. |
| `missing-permission` | A permission required but not declared (error) - required by a called API, or implied by a declared script-injection manifest key (`compose_scripts` → `compose`, `message_display_scripts` → `messagesModify`). An API needing a manifest key is `missing-manifest-key`. |
| `missing-vendor-file` | A VENDOR entry (file + source URL) naming a file not present in the submission (warning). |
| `mistyped-manifest-value` | A known manifest key whose value has the wrong type, validated with ajv against a JSON Schema derived from the annotated schema (warning). Thunderbird misreads such values. |
| `native-messaging` | The `nativeMessaging` permission (in `permissions` or `optional_permissions`), which lets the add-on exchange messages with a native application outside Thunderbird - routed to manual review to confirm disclosure (No Surprises). |
| `non-experiment-strict-max-version` | A non-Experiment that pins `strict_max_version` (warning - it only blocks installs on newer Thunderbird). |
| `minified-code` | A JS file (not a recognized library, not obfuscated) shipped minified - by minified line geometry (a very long, dense line) (error). |
| `obfuscated-code` | A JS file (not a recognized library) shipped obfuscated - recognized by the AST structure of a known obfuscator family via the `obfuscation-detector` library. A strong-family match is an error finding; a weak-family-only match (a structure readable code also has) escalates instead, for the reviewer to judge the file from its own content. High precision, partial recall - some obfuscators evade it. |
| `privacy-policy` | Data transmitted to a hardcoded remote host by an overt API - routed to manual review to confirm the listing carries a privacy policy disclosing the collection (the policy text is not part of the package). Complements `data-exfiltration` (which judges consent). |
| `strict-max-version-bump-only` | Diff check (needs `--diff-to`): fires (info) when a submission changes only the `version` and the gecko `strict_max_version` vs. the prior version - the developer could raise the max on ATN instead of resubmitting. Runs only with `--diff-to`. |
| `string-timer` | A code string passed to `setTimeout`/`setInterval` (it is eval'd) in authored JS outside the WebExtension tree (Experiment/privileged code) - dynamic code execution (error). WebExtension code is exempt (CSP-gated, see `csp-unsafe-eval`). |
| `sync-xhr` | Synchronous `XMLHttpRequest` (`open(..., false)`). |
| `trademark-violation` | Add-on name (resolved from `_locales` for a `__MSG__` name) using a Mozilla trademark - `Firefox`/`Mozilla`/`MZLA` anywhere, or `Thunderbird` other than as a trailing "for Thunderbird" (error, case-insensitive). The icon is a separate manual check. |
| `unknown-api` | Unknown namespaces, unknown members (incl. methods on property types like `storage.local.x`), and APIs marked `unsupported`. |
| `unparsable-file` | A JavaScript, TypeScript, or Vue `<script>` source that failed to parse, so its API checks were skipped (info). |
| `unpinned-dependency` | A `package.json` dependency declared as a version range with no lock file, so it can't be pinned to one release and verified (error). |
| `unpinned-vendor-source` | A VENDOR-declared file whose (trusted-host) source is not pinned to an immutable version/tag/commit, so its bytes can't be verified (error). |
| `unrecognized-manifest-key` | A top-level manifest key the schema does not define - Thunderbird ignores it (info). |
| `unsafe-html` | Any write to `innerHTML`/`outerHTML`/`srcdoc`/`insertAdjacentHTML`; only `Element.setHTML()` is sanctioned (an empty/null clear is exempt) (info). |
| `unused-permission` | A declared named permission (required or optional) that no reachable call provably requires (warning) - host patterns are `minimize-host-permissions`' concern. A permission is dropped as justified when an API call, a `navigator.*` Web/DOM call, or a script-injection manifest key proves it in use. It is a finding when the registry's permission prompt names its justifying usages as `tokens` and not one of them occurs anywhere in the live code (comments excluded) or the manifest - decided only while the scan can see every usage. Everything else escalates, carrying the sites where its tokens occur. |
| `update-url` | A manifest that declares an `update_url` (at `browser_specific_settings.gecko` or the deprecated `applications.gecko` alias, any manifest version). It self-hosts updates outside ATN, so the next version installs from a developer-controlled URL and bypasses review (error). |
| `vendor-modified` | A declared third-party file whose bytes don't match its pinned source (EOL-tolerant compare) - it appears modified from upstream (error). |
| `multiple-vendor-files` | More than one file in the package root names itself the VENDOR manifest (`VENDOR`, `VENDOR.md`, `VENDORS`, `VENDORS.md`), so which one the review reads would depend on the archive's order (error). None of them is read while it is ambiguous. |
| `vendor-unparseable` | A VENDOR file is present but yielded no declaration, so nothing can be verified (error). The parse is all-or-nothing: it reads only what is marked as a declaration - a path and a source URL paired by a colon, a key, or Markdown link syntax - and a fault anywhere discards the whole file. |

### Checks that escalate

These checks **always run their scan**. Cases the scan can settle become findings
directly; the genuinely-ambiguous residue escalates per case, so the reviewer is
handed a concrete `file:line` to look at rather than a verdict the tool guessed.

| Check id (`check:`) | What the scan settles, and what it escalates |
| --- | --- |
| `strict-min-version-api` | Pre-flight: a call to a real, schema-resolved API added in a Thunderbird newer than the declared `strict_min_version`. An unguarded call is a finding straight away; a call carrying a guard signal (optional chaining, a `typeof`/existence test, a `getBrowserInfo` version gate, an earlier guard clause that returned or threw when the API was missing) escalates, for the reviewer to judge from the call's file whether the guard really keeps it off the older versions. A non-existent API is `unknown-api`'s concern. |
| `remote-eval` | Pre-flight: the statically-undecidable `fetch()->eval` pattern (scanned only outside the WebExtension tree, like the other dynamic-execution checks - WebExtension code is CSP-gated) escalates, for the reviewer to judge from the offending file whether the executed code is fetched remotely. The definite dynamic-execution cases are the deterministic `eval-call`/`function-constructor`/`string-timer`/`csp-unsafe-eval`/`csp-unsafe-inline` checks. |
| `remote-resources` | Pre-flight: remote `<script>`/`<link>`/`@import`/`url()`/media/imports/`importScripts`/runtime injection/WASM, and a CSP permitting a remote script source → a finding. Statically-undecidable cases (non-literal URLs, inline `data:`/`blob:` script sources) escalate for the reviewer to resolve. In an HTML/CSS file whose content matches a published upstream release, the line is that release's, so it escalates as `manualReview` instead - accepting it is a judgement a person owns (XPI reviews only; an SCA review has no verified result to read). |
| `data-exfiltration` | Pre-flight: a normal transmission (`fetch`/XHR/WebSocket/EventSource/`sendBeacon`) to a remote/dynamic host escalates, for the reviewer to judge from the file and the options page whether user data is sent without an explicit opt-in. Covert channels are the separate `disguised-*` errors. |
| `disguised-transmission` | Pre-flight: the weak residue of the covert channels - a resource URL, a stylesheet `url()`, a `window.open()`, or a page navigation to a remote host built from a runtime value, with no user-data API call in it escalates, for the reviewer to judge whether it really smuggles user data out through that channel or is just legitimate dynamic URL building. The strong cases (a user-data call in the URL) are the deterministic `disguised-*` errors. |
| `minimize-web-accessible-resources` | Pre-flight: over-broad exposure (a resource pattern like `*`, or MV3 `matches` of `<all_urls>`/`*://*/*`) and concrete resources no content script/page loads → a finding. An ambiguous exposed resource (dynamic loaders, or name mentioned) escalates, for the reviewer to judge whether it is needlessly exposed. |
| `unused-files` | Pre-flight: hidden/junk by name, and files reachable from no manifest entry point (a reference graph over imports/`getURL`/HTML/CSS plus schema-derived file-loading APIs) - a clearly-unreferenced file is a finding. An ambiguous file (string-mentioned, or the add-on uses dynamic loaders) escalates, for the reviewer to follow the suspected loaders and judge whether it is unused. Documentation (any `.md`/`.rst`/`.license`; a `.txt` or extensionless file named like a doc), dependency manifests and `_locales` are exempt; junk by name is reported ahead of any exemption. |

### Manual checks

Some review steps can't be automated - they need hands-on testing or a human's
judgment over content the tool can't see (the store listing, screenshots, the
icon). These live under `manual-checks` in the yaml and are surfaced in the
report's **Standard manual review** to-do list.

| Check id (`check:`) | What the reviewer verifies |
| --- | --- |
| `check-submission-spam` | The listing and add-on for spam or inappropriate, misleading, or low-effort content. |
| `test-add-on` | Functionality in a test profile, fail if credentials or other info are needed to continue. |
| `no-surprises-policy` | The code diff for behavior not documented on the ATN listing that could surprise the user. |
| `missing-payment-disclosure` | Whether the add-on requires payment but the "needs payment" flag is not set on ATN. |
| `suitability-for-listing` | Whether the add-on targets a limited or non-public audience (better self-hosted than listed). |
| `acceptable-use-policy` | The name, summary, description, and screenshots against Mozilla's Acceptable Use Policy. |
| `icon-trademark-imitation` | The icon for imitation of the Thunderbird or Mozilla logo (an image the automated checks can't inspect). |
| `missing-atn-description` | The ATN listing page has usage instructions, entry points, and screenshots. |
| `missing-english-atn-localization` | The ATN listing page also has an English version. |
| `forked-add-on` | New-submission prompt (`diff: false`, skipped when reviewing against a `--diff-to` baseline): a forked add-on is clearly distinguished from the original and offers a significant difference in functionality and/or code. |


## Examples

```sh
# Review a submitted xpi against the matching schema (read-only - report only)
node verify.js ./submission.xpi

# Review an unpacked source folder
node verify.js ./my-addon

# machine-readable JSON output
node verify.js ./submission.xpi --report-format json

# Review a source-code submission (the built XPI plus its readable source)
node verify.js ./built.xpi --sca-root ./source --sca-source src
```

## Contributing

Requires Node `>=20` and `npm install` once. Before sending a change, run:

```sh
npm run lint          # ESLint over src/ and the root entry files
npm run format:check  # Prettier (run `npx prettier --write <glob>` to fix)
npm test              # add-on golden snapshots + the unit suite
```

Conventions:

- **Prettier-formatted and ESLint-clean** - double quotes, semicolons,
  `printWidth` 80.
- **The registry owns every user-facing string** - each check's severity, its
  findings' wording, its manual-review instructions and its suggested response
  live in [`assets/registry.yaml`](assets/registry.yaml), never in `src/`.
- **Each source file opens with a header comment** stating what belongs in it,
  keep it accurate when you edit.
- **Golden tests are byte-exact** - regenerate intended report changes with
  `UPDATE_GOLDEN=1 npm test` and review the diff.

(See [tests/README.md](tests/README.md) for the test suite.)
