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

A channel branch is a moving target, so a cached schema is a snapshot. When an add-on's
`strict_max_version` reaches past every cached train and the snapshot is more than a day
old, the schemas are re-downloaded before the review - otherwise an API added since the
snapshot would be reported as unknown rather than as needing a newer `strict_min_version`.

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

**LLM review:** one round trip, in the order it runs — `--llm-review` or `--llm-verify`
asks, then `--llm-verdict` applies the answers.

| Option | Description |
| --- | --- |
| `--llm-review [<file>]` | Print a verification prompt and write the review as a JSON item array instead of the report, to a temp file or to `<file>` (use `--llm-review=<file>` if the add-on path follows). The prompt explains how to settle the items and pass them back. Refused with `--report-format json`. |
| `--llm-verify [<file>]` | As `--llm-review`, but asks only for what can be settled by reading the **add-on**. No add-on description is written, and the Extended/Standard Manual Review items are neither put to a reviewer nor written to the item file — they stay in the report, for the reviewer to work through later. The sweep, the findings, the Extended Code Review, the verdict file and the `--llm-verdict` re-run are unchanged. |
| `--llm-verdict <file>` | Apply settled verdicts and print the settled report, from a JSON file written as the prompt describes. Verdicts are keyed by index and settle only what they name, so a `--llm-verify` file leaves the manual items listed. |

**Source code archive (SCA):**

| Option | Description |
| --- | --- |
| `--sca-root <folder\|zip>` | The source archive root (holds `package.json`/lock). Switches to SCA mode. The readable source is reviewed for code defects and its declared dependencies are audited for popularity + vulnerabilities; the built XPI (the positional path) is the shipped artifact - it supplies the manifest, experiments, file-completeness checks (bundled/web-accessible/unused). See [Source code archive (SCA) mode](#source-code-archive-sca-mode) below. |
| `--sca-source <path>` | The add-on code root, relative to `--sca-root` or an absolute path (e.g. `src` or `addon`). Optional; defaults to `.` (the whole `--sca-root` reviewed as the source - a flat layout with `manifest.json` at the root). Needs `--sca-root`. |
| `--sca-exp-source <path>` | The Experiment implementation folder, relative to `--sca-root` or an absolute path, and within `--sca-source` (e.g. `addon/experiment-api`). Its privileged, non-WebExtension files are excluded from the WebExtension API/permission/eval checks. Needs `--sca-root`; required when `--allow-experiments` is used in SCA mode. |

**Other:**

| Option | Description |
| --- | --- |
| `--allow-experiments` | Accept add-ons that use Experiment APIs, instead of rejecting them as unsupported. Off by default. |
| `--cdn-lib-lookup <true\|false>` | Identify an unrecognized bundled library (minified or readable) by a jsDelivr content-hash lookup (default `true`). Results are cached; an offline run simply finds no match. |
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

A source archive is always reviewed as one — the review is never re-routed to the XPI on
the strength of what the XPI looks like. SCA is what you need when the shipped XPI is not
the code you wrote: minified, obfuscated, transpiled, or bundled.

When the shipped XPI turns out to BE the submitted source — readable, no transpiled source
kind, and every script it ships byte-identical to one in the archive — the review reports
`sca-not-required` (info) to say an XPI-only submission would have done, and would have
been reviewed faster. That is advice for next time; it does not change the review it
appears in.

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
  manifest, the experiments and the file-completeness checks (bundled /
  web-accessible / unused / locales). The
- `--sca-exp-source` names an Experiment implementation folder - relative to
  `--sca-root` (or absolute), and within `--sca-source` (e.g. `addon/experiment-api`)
  - so its privileged, non-WebExtension code is excluded from the WebExtension checks
  (required when `--allow-experiments` is used in SCA mode).
- Because a review spans two artifacts, each finding's `file:line` is prefixed with the
  artifact it lives in - `[XPI]` (the built XPI) or `[SCA]` (the readable source code
  archive) - so a reviewer knows which one to open; the Found Issues section closes with a
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
own code and land under **Extended Code Review**. A check whose cases the code cannot
answer declares `escalation: manual-review` instead, and its cases land under
**Extended Manual Review**: `privacy-policy` (the policy is a field in the ATN listing,
not in the package), `native-messaging` (likewise, what the listing discloses about the
native app), `undeclared-build-source` (reproducing the build is the reviewer's own
attestation that the source produces the shipped XPI), `trademark-thunderbird-name` (an
add-on name written directly in the manifest carries no locale tag, so the language has
to be settled before the trademark form can be judged at all), and `vendored-remote-resources`
(a remote `@import` inside a file matching a published release is that release's line,
not the developer's, so accepting it is a judgement a person owns).

Which section a check's cases land in is the check's own property, declared in the
registry beside its severity - never decided per case. A check that would need both
sections is asking two questions, and is two checks: `remote-resources` and
`vendored-remote-resources` are that split, sharing one scan.

Either way the item carries its **suggested response**: once the reviewer settles
the case against the add-on, that is the text the developer receives, and its
**suggested verdict**: the band that response lands the submission in.

Most bands are fixed - `error`, `warning`, `info`. Two are decided at run time.
`auto` lets the check set each finding's band (an advisory's own rating, say).
`hold-or-error` marks a fault the developer cannot fix in code, because the fix is on
the ATN listing: a missing privacy policy, an undisclosed native app. On its own such a
finding puts the review **on hold** - its own section, first, under its own preamble -
and the run still exits `0`, because nothing is wrong with the add-on and a person
continues the review. Alongside a real error the submission is rejected anyway, so the
hold is not the verdict: it becomes one more item on the rejection list. That is settled
once, before anything reads a severity, so the report, the tally and the JSON always
agree.

Escalations deliberately reach the human report only - the JSON report omits
`meta.manualReview` and carries just what the tool is certain of, so escalating
rather than finding is what puts the submission in front of a person instead of a
machine.

| Check | What it flags |
| --- | --- |
| `async-onmessage` | An async listener passed to the `addListener()` of an event that answers with its listener's return value (`runtime.onMessage`, `onMessageExternal`, `onUserScriptMessage`), derived from the schema. |
| `background-module` | A background script (`background.scripts`/`service_worker`) that uses static ES module syntax (`import`/`export`) while the manifest's background is not declared `"type": "module"` - it won't load as a module (error). Background pages and content scripts are out of scope. |
| `bundled-files` | Referenced files that aren't packaged. Both halves come from the schema, not a hardcoded list: every manifest key the schema types as an extension-relative path (scripts, pages, popups, `icons` and every `default_icon`/`theme_icons`, ruleset paths, theme images, Experiment schema and parent scripts), and packaged-file paths passed to file-loading API calls (script registration, `setIcon`, `executeScript`/`insertCSS`, `getURL`, ...) - the same schema-derived loader set that fuels the reference graph. |
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
| `obfuscated-code` | A JS file (not a recognized library) shipped obfuscated - recognized by the AST structure of a known obfuscator family via the `obfuscation-detector` library. The families a match is drawn from are pinned, so a family the library gains later decides nothing and a match needs no second opinion. High precision, partial recall - some obfuscators evade it. |
| `privacy-policy` | Data transmitted to a hardcoded remote host by an overt API - routed to manual review to confirm the listing carries a privacy policy disclosing the collection (the policy text is not part of the package). Complements `data-exfiltration` (which judges consent). |
| `string-timer` | A code string passed to `setTimeout`/`setInterval` (it is eval'd) in authored JS outside the WebExtension tree (Experiment/privileged code) - dynamic code execution (error). WebExtension code is exempt (CSP-gated, see `csp-unsafe-eval`). |
| `sync-xhr` | Synchronous `XMLHttpRequest` (`open(..., false)`). |
| `trademark-violation` | Add-on name (resolved from `_locales` for a `__MSG__` name) using a Mozilla brand term - `Firefox`/`Mozilla`/`MZLA` anywhere, in any locale (error, case-insensitive). Needs no knowledge of the language, so it is always a finding, and each offending name is reported once naming every locale that states it. `Thunderbird` is the two checks below, and a name carrying a brand term is left to this one alone, since it is refused either way. The icon is a separate manual check. |
| `trademark-thunderbird-locale` | `Thunderbird` in a name resolved from `_locales`, other than as a trailing "for Thunderbird". A name from an `en*` locale is a finding - the policy is written in English - and a name decided that way is not also escalated because another locale states it. A name from any other locale escalates to code review, because the allowed and forbidden readings share one shape ("X para Thunderbird" is allowed, "X de Thunderbird" is not), word order and word boundaries both vary, and telling them apart needs the meaning of a word. Answerable from the package, since every locale file ships in it and its directory names the language. |
| `trademark-thunderbird-name` | The same question for a name the manifest states literally. It carries no locale tag, so nothing in the package says what language it is in and the language must be settled first - not answerable from the submission, so it escalates to manual review and never rejects on its own. |
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
| `remote-resources` | Pre-flight: remote `<script>`/`<link>`/`@import`/`url()`/media/imports/`importScripts`/runtime injection/WASM, and a CSP permitting a remote script source → a finding. Statically-undecidable cases (non-literal URLs, inline `data:`/`blob:` script sources) escalate for the reviewer to resolve. |
| `vendored-remote-resources` | The same scan's other question: a remote load inside an HTML/CSS file whose content matches a published upstream release. The line is that release's, not the developer's, so it emits no finding and every site goes to a person - accepting it as published is a judgement they own. Turns on the content match, never on a declaration (XPI reviews only; an SCA review has no verified result to read). |
| `data-exfiltration` | Pre-flight: a normal transmission (`fetch`/XHR/WebSocket/EventSource/`sendBeacon`) to a remote/dynamic host escalates, for the reviewer to judge from the file and the options page whether user data is sent without an explicit opt-in. Covert channels are the separate `disguised-*` errors. |
| `disguised-transmission` | Pre-flight: the weak residue of the covert channels - a resource URL, a stylesheet `url()`, a `window.open()`, or a page navigation to a remote host built from a runtime value, with no user-data API call in it escalates, for the reviewer to judge whether it really smuggles user data out through that channel or is just legitimate dynamic URL building. The strong cases (a user-data call in the URL) are the deterministic `disguised-*` errors. |
| `minimize-web-accessible-resources` | Pre-flight: over-broad exposure (a resource pattern like `*`, or MV3 `matches` of `<all_urls>`/`*://*/*`) and concrete resources no content script/page loads → a finding. An ambiguous exposed resource (dynamic loaders, or name mentioned) escalates, for the reviewer to judge whether it is needlessly exposed. |
| `unused-files` | Pre-flight: hidden/junk by name, and files reachable from no manifest entry point (a reference graph over imports/`getURL`/HTML/CSS plus schema-derived file-loading APIs) - a clearly-unreferenced file is a finding. An ambiguous file (string-mentioned, or the add-on uses dynamic loaders) escalates, for the reviewer to follow the suspected loaders and judge whether it is unused. Documentation (any `.md`/`.rst`/`.license`; a `.txt` or extensionless file named like a doc), dependency manifests and `_locales` are exempt; junk by name is reported ahead of any exemption. |

### Blind-spot sweeps

Some checks scan for an enumerated set of forms, and the set cannot be finished:
the ways data can leave an add-on are a property of the platform, not a bounded
API surface, so a sender the scan does not name leaves no trace in the report.
Extending the list moves that boundary without closing it.

Such a check declares a **`sweep-instruction:`** in the yaml, describing the
*class* of code it cannot see and the test to judge it by - never a list of
candidate forms, which would only rebuild the same blind spot in prose. Every
check that declares one is listed in the report's **Pre-Sweep** section, whether
or not it found anything: a check that found nothing is exactly the one whose
blind spot is worth reading.

What a reader finds is not a verdict on the sweep. It enters through
`--llm-verdict` as an **addition**, carrying the check it belongs to and where it
was found, and is filed as a finding **of that check** - its ruleId, its band, and
the response text its own registry entry authors:

```json
{
  "addon": "/path/to/the-reviewed.xpi",
  "additions": [
    { "check": "data-exfiltration", "file": "background.js", "line": 40,
      "hint": "<a ping> attribute carries the message digest" }
  ],
  "verdicts": {
    "3": "cleared",
    "9": "Clear",
    "11": "the German listing text is outdated too"
  }
}
```

An addition carries no item index - an index belongs to the linter's numbering of
the document it wrote, and an addition was never in it. The `hint` is a locus
annotation naming what sits at that line; the paragraph the developer reads stays
the registry's.

Every value is a string, and which strings are legal depends on **who settles the
item**. Item 3 is settled by reading the add-on - a finding, or an Extended Code
Review case - so it takes one of the linter's verbs: `reported`, `cleared`, or
`withdrawn` (a finding takes only `withdrawn`). Items 9 and 11 were put to a
reviewer as questions, so they carry what the reviewer answered: the label of one
of the answers that question offered (`Clear`, `Report` - the item file lists
them under `answers`), or the words they typed instead, which report the case and
travel with it.

Those words are the one thing in this file a person writes. They are printed on
that case's location line - in parentheses after the location, or as the line
itself when the case has none, where the reviewer's own line breaks are kept and
each line becomes an item of its own. The response paragraph above stays the
registry's, word for word.

The crossings are refused, each naming the item so the question can be asked
again rather than an answer being made to fit: a verb on a question, a
reviewer's answer on an item nobody was asked, an answer with nothing in it, and
one past the length the question tells the reviewer they have (`MAX_NOTE`).

| Check id (`check:`) | The blind spot its sweep covers |
| --- | --- |
| `data-exfiltration` | User data leaving the machine by any route the enumerated senders do not name. |
| `cleartext-transmission` | Anything reaching an `http://`/`ws://`/`ftp://` endpoint by an unlisted route, whatever the payload. |
| `disguised-transmission` | Data carried outward by a mechanism whose apparent purpose is something else. |
| `disguised-resource` | Data in the URL of a resource loaded to be rendered or embedded. |
| `disguised-stylesheet` | Data in a URL consumed as styling. |
| `disguised-window` | Data in the URL of a window or tab the add-on opens. |
| `disguised-navigation` | Data in the URL an already-open context is sent to. |
| `privacy-policy` | The add-on reaching a developer-chosen remote service by an unlisted route. |

### Manual checks

Some review steps can't be automated - they need hands-on testing or a human's
judgment over content the tool can't see (the store listing, screenshots, the
icon). These live under `manual-checks` in the yaml and are surfaced in the
report's **Standard Manual Review** to-do list. They carry a severity like every other entry, so a reviewer settles one exactly as they settle an escalation: the item names the band a confirmed case lands in, and `--llm-verdict` can confirm it into a finding or clear it away.

| Check id (`check:`) | What the reviewer verifies |
| --- | --- |
| `unacceptable-package-content` | What the add-on ships - its name and description in `manifest.json`, its icons, and any bundled text, images or media - for spam, inappropriate, misleading or low-effort content, and against Mozilla's Acceptable Use Policy. Every fix here needs a new version. |
| `test-add-on` | Functionality in a test profile, fail if credentials or other info are needed to continue. |
| `no-surprises-policy` | The code diff for behavior not documented on the ATN listing that could surprise the user. |
| `missing-payment-disclosure` | Whether the add-on requires payment but the "needs payment" flag is not set on ATN. |
| `suitability-for-listing` | Whether the add-on targets a limited or non-public audience (better self-hosted than listed). |
| `unacceptable-listing-content` | The ATN listing page - its summary, description and screenshots - for spam, inappropriate or misleading content, and against Mozilla's Acceptable Use Policy. Every fix here is a listing edit, so no new version is needed. |
| `icon-trademark-imitation` | The icon for imitation of the Thunderbird or Mozilla logo (an image the automated checks can't inspect). |
| `missing-atn-description` | The ATN listing page has usage instructions, entry points, and screenshots. |
| `missing-english-atn-localization` | The ATN listing page also has an English version. |
| `forked-add-on` | A forked add-on is clearly distinguished from the original and offers a significant difference in functionality and/or code. |


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
