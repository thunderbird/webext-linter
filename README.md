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
analysis can optionally be delegated to an LLM (Claude or ChatGPT) when an API
key is supplied. See the LLM checks under Review checks below.


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
| `--library-hashes <path>` | Use a local known-library `hashes.txt` instead of fetching it (offline runs). |
| `--library-hashes-cache <dir>` | Where the fetched library hashes are cached (default `.library-hashes-cache`). |
| `--library-hashes-refresh` | Re-download the library hashes even if a cached copy exists. |
| `--checks-only <ids>` | Only run these checks (comma-separated). See the check list below. |
| `--checks-skip <ids>` | Skip these checks (comma-separated). See the check list below. |
| `--report-format <text\|json>` | Report output format (default `text`). |
| `--report-out <file>` | Write the report to a file in addition to stdout. |
| `--llm-enabled` | Enable the LLM checks. The key is read from the `LLM_API_KEY` environment variable (see [LLM configuration](#llm-configuration)). |
| `--llm-list-models` | List the models your token can use, then exit. |
| `--llm-review` | Shorthand for `--llm-enabled --full-summary` - run the AI add-on review in one flag. |
| `--allow-experiments` | Accept add-ons that use Experiment APIs, instead of rejecting them as unsupported. Off by default. |
| `--eslint` | Run the ESLint `code-sanity` check on authored JS. Off by default. |
| `--diff-to <xpi\|folder>` | Previously published version, to diff against. |
| `--diff-summary` | Add an AI assisted **"Summary of changes"** section: how the add-on changed since the `--diff-to` baseline. Needs `--diff-to` and `--llm-enabled`. |
| `--full-summary` | Add an AI **"Summary of add-on"** section after the report - what the add-on does, with security/privacy notes and a permission review (which declared permissions appear unused) - from its (almost) full current source (vendored and unused files excluded). The same pass also **re-checks the unsure items** other checks escalated, judging them with full-add-on context, so confident cases resolve instead of landing in manual review (see [LLM checks](#llm-checks)). Advisory, not a finding. Needs `--llm-enabled`. |
| `--scs-root <folder\|zip>` | **Source-code submission (SCS) mode.** The source archive root (holds `package.json`/lock). Requires `--scs-source`. The readable source is reviewed for code defects and its declared dependencies are audited for popularity + vulnerabilities; the built XPI (the positional path) is the shipped artifact - it supplies the manifest, experiments, file-completeness checks (bundled/web-accessible/unused), the `--diff-to` baseline, and the behavioral LLM audit. |
| `--scs-source <path>` | SCS mode: the add-on code root, relative to `--scs-root` or an absolute path (e.g. `src` or `addon`). Required together with `--scs-root`. |
| `--scs-exp-source <path>` | SCS mode: the Experiment implementation folder, relative to `--scs-root` or an absolute path, and within `--scs-source` (e.g. `addon/experiment-api`). Its privileged, non-WebExtension files are excluded from the WebExtension API/permission/eval checks. Needs `--scs-source`; required when `--allow-experiments` is used in SCS mode. |
| `--verbose` | Verbose logging. |

**Exit codes:** `0` no errors · `1` one or more error-severity findings · `2`
tool failure.

### LLM configuration

The LLM checks are configured from the environment, and enabled via the `--llm-enabled` flag:

| Variable | Description |
| --- | --- |
| `LLM_API_TYPE` | Provider: `claude` (default), `chatgpt`, or `ollama` (local). |
| `LLM_API_KEY` | The provider API key. Required for `claude`/`chatgpt`, not used by `ollama`. |
| `LLM_API_MODEL` | Model for the LLM checks (default: the provider's default). |
| `LLM_API_URL` | Override the provider's API base URL (e.g. a proxy, or a remote Ollama host). |

```sh
# Claude (the default provider)
export LLM_API_KEY=sk-ant-...
node verify.js <xpi|folder> --llm-enabled

# ChatGPT
export LLM_API_TYPE=chatgpt
export LLM_API_KEY=sk-...
node verify.js <xpi|folder> --llm-enabled

# local Ollama - no API key
export LLM_API_TYPE=ollama
node verify.js <xpi|folder> --llm-enabled
```

Each provider has a default model (`claude-sonnet-4-6` for `claude`, `gpt-4.1`
for `chatgpt`, `llama3.1` for `ollama`). Override it by setting `LLM_API_MODEL`,
or list the available models with `--llm-list-models`.

**Local model (Ollama).** With [Ollama](https://ollama.com) running, the checks
talk to its OpenAI-compatible endpoint at `http://localhost:11434/v1` — no API
key. Pull a tool-capable model first (the structured checks require tool calling),
e.g. `ollama pull llama3.1`. When the LLM is enabled, a Setup-step pre-flight
shows the chosen type and model and **fails hard** if Ollama is unreachable or the
model is not pulled. Point `LLM_API_URL` at a remote host to use a non-local Ollama.


### Source-code submission (SCS) mode

Some add-ons are submitted as **both** a built XPI (minified, what users install)
and a **readable source archive**. Reviewing the minified XPI directly is noisy, so
SCS mode reviews the readable source instead while still treating the XPI as the
authoritative shipped artifact:

```
node verify.js built.xpi --scs-root ./source-archive --scs-source src
```

- `--scs-root` is the source archive (folder or zip) that holds `package.json` /
  the lock file; `--scs-source` is the add-on code root, relative to `--scs-root`
  or an absolute path (e.g. `src`). Both are required together.
- The **readable source** is reviewed for code defects (the API/permission/eval/
  exfiltration checks run over every source file).
- The **declared dependencies** (`--scs-root`'s `package.json`) are audited: each
  must be a pinned npm package or a GitHub URL, and is gated on popularity
  (npm downloads / GitHub stars) and known vulnerabilities. Anything unpinned or
  from another source is rejected.
- The **build tooling** (everything in `--scs-root` outside `--scs-source` - build
  scripts, configs, `.npmrc`) is reviewed: the build must use **npm or pnpm** (a
  `yarn.lock` / `bun` build is rejected) and must not point the package registry
  elsewhere (an `.npmrc` `registry=` is rejected), and the LLM judges whether it pulls
  code or resources from a source not among the declared dependencies (a raw URL,
  `curl|sh`, an unpinned `git clone`, a CDN, a postinstall hook).
- The **built XPI** (the positional path) is the shipped artifact: it supplies the
  manifest, the experiments, the file-completeness checks (bundled / web-accessible
  / unused / locales), the `--diff-to` baseline, and the behavioral LLM audit.
- `--scs-exp-source` names an Experiment implementation folder - relative to
  `--scs-root` (or absolute), and within `--scs-source` (e.g. `addon/experiment-api`)
  - so its privileged, non-WebExtension code is excluded from the WebExtension checks
  (required when `--allow-experiments` is used in SCS mode).


## Review checks

A review has three kinds of check, all declared in
[assets/registry.yaml](assets/registry.yaml):

- **Deterministic** - decided entirely in code, no LLM, offline apart from the
  one-time vendor source fetch. A few are gated by review mode
  (`diff: true`/`false`).
- **LLM** - a deterministic pre-flight always runs offline, only the ambiguous
  residue is delegated to an LLM (when an API key is supplied) or routed to
  manual review.
- **Manual** - checks the tool can't make itself, surfaced as a todo list.

### Deterministic checks

Each `deterministic-checks` entry links to a module in
[src/checks/rules/](src/checks/rules/) and supplies the severity for its
findings. A deterministic check either decides each case as a finding or
escalates it straight to manual review (e.g. `vendor-unverified`,
`native-messaging`). The LLM checks escalate only their ambiguous residue.

| Check | What it flags |
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
| `eval-call` | An `eval()` call in authored JS outside the WebExtension tree (Experiment/privileged code) - dynamic code execution (error). WebExtension code is exempt: it cannot run eval without a permissive CSP, which `csp-unsafe-eval` flags. |
| `experiment-manual-review` | Every reviewed Experiment (declares `experiment_apis`) - routed to manual review with a reminder that Experiments have full access to Thunderbird's internals and need a careful human code review. Fires for pristine, modified, and `--allow-experiments` submissions; silent for non-Experiments and outright-rejected ones. |
| `experiment-missing-strict-max-version` | An accepted Experiment (`--allow-experiments`) that sets no `strict_max_version` (error). Silent when experiments are disallowed, since `experiment-not-allowed` already rejects it. |
| `experiment-modified` | A bundled Experiment that is a recognised published Thunderbird API draft but a modified or outdated copy (error) - the submission stays on the normal review path but is rejected until the unmodified latest upstream copy is bundled. |
| `experiment-not-allowed` | An Experiment (declares `experiment_apis`) when experiments are not enabled via `--allow-experiments` (error, on by default). |
| `experiment-overrides-api` | An Experiment whose declared API path overrides or grafts onto a built-in Thunderbird API instead of adding a new namespace (error). |
| `function-constructor` | A `new Function(...)` (the Function constructor) in authored JS outside the WebExtension tree (Experiment/privileged code) - dynamic code execution (error). WebExtension code is exempt (CSP-gated, see `csp-unsafe-eval`). |
| `manifest-invalid-json` | manifest.json is present but is not valid JSON (error). |
| `manifest-missing` | No manifest.json at the add-on root (error). |
| `manifest-missing-key` | A required top-level manifest key (`manifest_version`/`name`/`version`) is absent (error). |
| `manifest-unknown-permission` | A declared permission value that is neither a known permission, a data-collection permission, nor a match pattern (error). |
| `manifest-version-mismatch` | `manifest_version` disagrees with the schema set being reviewed (error). |
| `minimize-host-permissions` | Broad (`<all_urls>` / `*` host) permissions requested as required (info). |
| `missing-library` | A bundled JS or CSS file (not in the VENDOR file) whose content hash matches a known third-party library release, named as `name version` (info). Identified by a fetched known-library hash database (Mozilla dispensary's `hashes.txt`), so the match is byte-exact; a file the database doesn't recognize is left to `minified-code`/`obfuscated-code` or scanned as the developer's own code. An identified library is also audited for known vulnerabilities (`vendor-vulnerable`), so an undeclared vulnerable bundle is still caught. |
| `missing-manifest-key` | A called API needs a manifest key (e.g. `action`) that is not declared (error). The manifest-key counterpart of `missing-permission`. |
| `missing-permission` | A permission used by a called API but not declared (error). An API needing a manifest key is `missing-manifest-key`. |
| `missing-vendor-file` | A VENDOR entry (file + source URL) naming a file not present in the submission (warning). |
| `mistyped-manifest-value` | A known manifest key whose value has the wrong type, validated with ajv against a JSON Schema derived from the annotated schema (warning). Thunderbird misreads such values. |
| `native-messaging` | The `nativeMessaging` permission (in `permissions` or `optional_permissions`), which lets the add-on exchange messages with a native application outside Thunderbird - routed to manual review to confirm disclosure (No Surprises). |
| `non-experiment-strict-max-version` | A non-Experiment that pins `strict_max_version` (warning - it only blocks installs on newer Thunderbird). |
| `minified-code` | A JS file (not a recognized library, not obfuscated) shipped minified - by minified line geometry (a very long, dense line) (error). |
| `obfuscated-code` | A JS file (not a recognized library) shipped obfuscated - by `_0x…` obfuscator identifiers or `eval`/`Function`-of-decoded-string packers (error). High precision, partial recall - some obfuscators evade it. |
| `privacy-policy` | Data transmitted to a hardcoded remote host by an overt API - routed to manual review to confirm the listing carries a privacy policy disclosing the collection (the policy text is not part of the package). Complements `data-exfiltration` (which judges consent). |
| `strict-max-version-bump-only` | Diff check (needs `--diff-to`): fires (info) when a submission changes only the `version` and the gecko `strict_max_version` vs. the prior version - the developer could raise the max on ATN instead of resubmitting. Runs only with `--diff-to`. |
| `string-timer` | A code string passed to `setTimeout`/`setInterval` (it is eval'd) in authored JS outside the WebExtension tree (Experiment/privileged code) - dynamic code execution (error). WebExtension code is exempt (CSP-gated, see `csp-unsafe-eval`). |
| `sync-xhr` | Synchronous `XMLHttpRequest` (`open(..., false)`). |
| `trademark-violation` | Add-on name (resolved from `_locales` for a `__MSG__` name) using a Mozilla trademark - `Firefox`/`Mozilla`/`MZLA` anywhere, or `Thunderbird` other than as a trailing "for Thunderbird" (error, case-insensitive). The icon is a separate manual check. |
| `unknown-api` | Unknown namespaces, unknown members (incl. methods on property types like `storage.local.x`), and APIs marked `unsupported`. |
| `unparsable-file` | A JS file that failed to parse, so its API checks were skipped (info). |
| `unpinned-dependency` | A `package.json` dependency declared as a version range with no lock file, so it can't be pinned to one release and verified (error). |
| `unpinned-vendor-source` | A VENDOR-declared file whose (trusted-host) source is not pinned to an immutable version/tag/commit, so its bytes can't be verified (error). |
| `unrecognized-manifest-key` | A top-level manifest key the schema does not define - Thunderbird ignores it (warning). |
| `unsafe-html` | Any write to `innerHTML`/`outerHTML`/`srcdoc`/`insertAdjacentHTML`; only `Element.setHTML()` is sanctioned (an empty/null clear is exempt) (warning). |
| `vendor-modified` | A declared third-party file whose bytes don't match its pinned source (EOL-tolerant compare) - it appears modified from upstream (error). |
| `vendor-unparseable` | A VENDOR file is present but no block pairs a library file with a source URL that points to a file, so nothing can be verified (error). |
| `vendor-unverified` | Declarations that can't be settled automatically - an untrusted-host source, a library not confirmed widely used, or an unfetchable source - routed to manual review. |

### LLM checks

Each LLM check **always runs its deterministic pre-flight**, regardless if LLM support is enabled or not.
Cases the pre-flight can settle become findings directly, and only the
genuinely-ambiguous residue is escalated, per case. When LLM support is not enabled, unsure findings are added to the manual review queue. When LLM support *is* enabled
(`--llm-enabled` with an `LLM_API_KEY`), each escalated case is sent to the model
with the check's rubric and that case's evidence (e.g. the offending file's
source). The model returns a three-way verdict - **fail** / **pass** /
**unsure** - so a confident result is final. Any **unsure** finding is routed to manual review.

`--full-summary` adds a second pass over those unsure items. The whole-add-on
summary re-judges each one with full-add-on context (richer than the per-case
evidence of the first pass), so many resolve to a confident **pass**/**fail**
instead of staying on the manual-review list. Without `--full-summary`, each
unsure case simply goes to manual review as above.

| Check id (`check:`) | Pre-flight (always) + what the LLM judges |
| --- | --- |
| `remote-eval` | Pre-flight: the statically-undecidable `fetch()->eval` pattern (scanned only outside the WebExtension tree, like the other dynamic-execution checks - WebExtension code is CSP-gated) → the LLM judges (given the offending file) whether the executed code is fetched remotely. The definite dynamic-execution cases are the deterministic `eval-call`/`function-constructor`/`string-timer`/`csp-unsafe-eval`/`csp-unsafe-inline` checks. |
| `remote-script` | Pre-flight: remote `<script>`/`<link>`/`@import`/`url()`/media/imports/`importScripts`/runtime injection/WASM, and a CSP permitting a remote script source → a finding. Statically-undecidable cases (non-literal URLs, inline `data:`/`blob:` script sources) → the LLM judges whether the source is remote. |
| `data-exfiltration` | Pre-flight: a normal transmission (`fetch`/XHR/WebSocket/EventSource/`sendBeacon`) to a remote/dynamic host → the LLM judges, given the file and the options page, whether user data is sent without an explicit opt-in. Covert channels are the separate `disguised-*` errors. |
| `missing-english-localization` | Pre-flight: A `_locales` English directory (`en`, `en-US`, …) present → pass. A `_locales` directory but no English → a finding. No `_locales` directory → the LLM judges whether user-facing strings are hardcoded in a non-English language. |
| `minimize-web-accessible-resources` | Pre-flight: over-broad exposure (a resource pattern like `*`, or MV3 `matches` of `<all_urls>`/`*://*/*`) and concrete resources no content script/page loads → a finding. An ambiguous exposed resource (dynamic loaders, or name mentioned) → the LLM judges whether it is needlessly exposed. |
| `unused-files` | Pre-flight: hidden/junk by name, and files reachable from no manifest entry point (a reference graph over imports/`getURL`/HTML/CSS plus schema-derived file-loading APIs) - a clearly-unreferenced file is a finding. An ambiguous file (string-mentioned, or the add-on uses dynamic loaders) → the LLM judges whether it is unused. License/README/VENDOR/`_locales` are exempt. |


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

# esr channel, machine-readable, offline schema
node verify.js ./submission.xpi --schema-channel esr --report-format json --schema-zip ./schemas.zip

# Review with the LLM checks enabled, plus an AI summary of the add-on
export LLM_API_KEY=sk-…
node verify.js ./submission.xpi --llm-enabled --full-summary

# Same, but use ChatGPT instead of the default (Claude)
export LLM_API_KEY=sk-… LLM_API_TYPE=chatgpt
node verify.js ./submission.xpi --llm-enabled

# List the models your token can use, then exit (needs a token)
export LLM_API_KEY=sk-…
node verify.js --llm-list-models
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
- **The registry owns every model-facing string** - check rubrics, the LLM
  system intro, and prompts live in
  [`assets/registry.yaml`](assets/registry.yaml), never in `src/`.
- **Each source file opens with a header comment** stating what belongs in it,
  keep it accurate when you edit.
- **Golden tests are byte-exact** - regenerate intended report changes with
  `UPDATE_GOLDEN=1 npm test` and review the diff.

(See [tests/README.md](tests/README.md) for the test suite.)
