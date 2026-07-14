# Tests

This tool uses two test layers to validate itself:

- **Add-on tests** (`run-tests.js` over `addons/`) are black-box: each is a
  whole sample add-on run through the full review pipeline, asserting each
  rule's finding *locations* (`file:line`). They prove the right checks fire (at
  the right spots, and stay quiet elsewhere) and that the pipeline composes end
  to end. Coarse, but cheap to add - a folder plus an `expected.json`, no test
  code.
- **Unit tests** (`unit/*.test.js`) are white-box: they import one module and
  assert its exact behavior - messages, edge cases, branches - that an add-on
  test (which only checks rule + location) can't pin down. Fine-grained and
  fast.

Rule of thumb: a new check gets a sample add-on proving it fires, plus unit
tests for its tricky cases (false positives, odd inputs, wording).


## Usage

```sh
npm test                # run both test layers
npm run test:addons     # run just the add-on harness
npm run test:unit       # run just the unit tests (node --test)
```


## Layout

- `run-tests.js` - the test runner.
- `addons/` - sample add-ons, one folder each, with an `expected.json`.
- `unit/` - npm unit test files (`*.test.js`).
- `schema-fixture/` - a small offline subset of the annotated WebExtension
  schema, so the suite needs no download. Used by the harness and by the
  schema/pipeline unit tests. Namespaces: `browserAction`, `clipboard`,
  `legacy`, `manifest`, `messages`, `runtime`, `storage`.


### Add-on tests (`addons/`)

Each add-on is run through `runPipeline` in **review** mode against
`schema-fixture/`. Per rule, the findings' `file:line` locations are collected
and compared (order-insensitive, duplicates significant) to that add-on's
`expected.json`:

```json
{
  "_comment": "what this add-on is meant to trigger",
  "expect": { "<rule>": ["background.js:4", "manifest.json"] }
}
```

Each location is `file:line` (or just `file` when a finding carries no line,
e.g. some manifest checks). A rule's list length is the hit count and each
entry says where. Rules with no findings are omitted. Any mismatch (or a thrown
pipeline) fails the run. The `_comment` documents each add-on's intent.

An `expected.json` may also carry an `"options"` object keyed by **real CLI
flags**, parsed the same way the CLI parses them (the core review opts always
win), so a fixture can exercise a flag-gated check - e.g.
`"options": { "--allow-experiments": true }`.

**Add an add-on test:** drop a folder under `addons/` with a `manifest.json`
(plus any JS/HTML/CSS it needs) and an `expected.json` listing the `file:line`
locations you expect per rule. (Tip: run the harness once - a mismatch prints
the actual `got [...]` list to copy from.)

**SCA fixtures:** a fixture that instead holds two subfolders - `xpi/` (the
shipped built add-on, the authoritative manifest) and `src/` (the readable source
tree, e.g. a Vue `.vue`) - is run in **SCA** mode (source-code archive) rather than
XPI mode. The layout is auto-detected (no flag needed); `expected.json` stays at the
fixture root. Use one when a check depends on the source/shipped split or on a source
format that only exists pre-build.

| Add-on | Exercises |
| --- | --- |
| `all-checks` | Triggers every deterministic violation check at once - the broad smoke test. (`missing-library` / `obfuscated-code` need a bundled or minified file, and `api-coverage` a parse/resolution gap, so those three don't show here.) |
| `clean` | A well-formed add-on - expects zero findings. |
| `unknown-api` | `unknown-api`: an unknown namespace + an unknown member. |
| `deprecated` | `deprecated-api`: a deprecated member + an API newer than the target Thunderbird. |
| `deprecated-namespace` | `deprecated-api` via a namespace-level annotation. |
| `missing-permission` | `missing-permission`: a called API needs permissions that aren't declared. |
| `storage-permission` | `missing-permission` for the namespace-level `storage` permission. |
| `optional-permission` | An optional (runtime-granted) permission is not flagged as unused. |
| `manifest-key-ok` | A required manifest key (`action`) is declared - no false positive, and `manifest:action` is not reported as a missing permission. |
| `manifest-key-wrong-version` | A wrong-MV manifest key (`browser_action` on MV3) → `missing-permission` + `unrecognized-manifest-entries`. |
| `invalid-manifest` | `invalid-manifest` (a missing required key, a bad permission value) + `unrecognized-manifest-entries` (an unknown top-level key). |
| `bundled-files` | `bundled-files`: a referenced file (`content_scripts`) isn't packaged. |
| `remote-code` | `remote-script` (remote `<script src>` + remote `@import`) and `eval-usage`. |
| `unsafe-html` | `unsafe-html`: every `innerHTML` write is flagged (static and dynamic alike); only an empty/null clear is exempt. |
| `experiment-disallowed` | An Experiment (`experiment_apis`) reviewed with experiments off (default): `experiment-not-allowed` on the `experiment_apis` line. |
| `experiment-allowed-no-strict-max` | An Experiment with no `strict_max_version`, reviewed with `"options": { "--allow-experiments": true }`: `experiment-missing-strict-max-version` (and `experiment-not-allowed` stays silent). |
| `strict-max-not-experiment` | `non-experiment-strict-max-version`: a non-Experiment that pins `strict_max_version` (warning). |
| `vue-sca-handler` | SCA mode (`xpi/`+`src/` layout): a Vue `.vue` whose multi-statement `@` handler carries an `innerHTML` sink - `unsafe-html` fires on the handler line, proving the handler is parsed (no `unparsable-file` coverage gap) and still scanned. |


### Unit tests (`unit/`)

Simple npm unit test files, one per module or scanner. Each imports the unit
directly and asserts its behavior, so a failure pinpoints the cause instead of
a whole-pipeline mismatch. Most need no fixtures, and a few load the offline
`schema-fixture/`.

**Add a unit test:** drop a `<name>.test.js` under `unit/` that imports the
module under test and asserts with `node:test` and `node:assert`. The
`npm run test:unit` glob picks it up automatically - no registration. For a
check module, fake a minimal `ctx` instead of running the pipeline (a check
returns its findings + escalations; the LLM/manual decision is the orchestrator's
job, covered by `escalation.test.js` with a stub `ctx.llm`).

| File | Covers |
| --- | --- |
| `api-usage.test.js` | The Babel-based API-usage extractor - `browser`/`messenger`/`chrome` call chains, plus the aliasing/dynamic-access limitations it reports. |
| `bundled-files.test.js` | `bundled-files` robustness against malformed/partial manifests, plus schema-directed / bridge detection of files referenced by loader API calls. |
| `claude.test.js` | The pure pieces of the Claude client (result coercion, and that the shipped default model is a Sonnet). No network. |
| `escalation.test.js` | The escalation resolver - token→verdict mapping (fail→finding, pass→nothing, unsure/error→manual) and the no-token→manual path. |
| `format.test.js` | The text / JSON report renderers - notably that the Manual review list is in the text report but omitted from JSON. |
| `html-parse.test.js` | HTML parsing via parse5 - inline vs `src` scripts, and `>` inside attribute values - the cases the old regex scanner mishandled. |
| `invalid-manifest.test.js` | The `invalid-manifest` check (error-level defects) and `unrecognized-manifest-entries` (unknown keys + deep ajv value-type validation). |
| `llm.test.js` | The LLM client (`createLlmClient`) as pure transport (returns the verdict, propagates errors, one cached system context), and the missing-english pre-flight. No network. |
| `load.test.js` | Add-on directory loading - symlinks are skipped, real files kept. |
| `loader-files.test.js` | The file-loader extractor (`scanLoaderRefs`) - schema-directed type walking for derived loaders, plus the bridge for `getURL`/`executeScript`/`insertCSS`/`tabs.create`/`setPopup`. |
| `pipeline.test.js` | End-to-end `review` pipeline against the schema fixture (read-only: line numbers match the source, nothing written back). |
| `remote-code.test.js` | The remote-code scanners and the `remote-script` / `eval-usage` checks. |
| `responses.test.js` | The report-assembly resolver - filling a finding's message from the registry `response` (by ruleId), system `messages`, and manual-item `instructions`, with `{{item}}` substitution. |
| `rules.test.js` | The deterministic rule modules and the `Registry`-driven loader (`loadRegistry`, `loadChecks` - including its hard-throw on a missing module). |
| `schema-index.test.js` | The `SchemaIndex` resolver (namespaces, `$extend` merge, permission/manifest-key sets) against the schema fixture. |
| `unsafe-html.test.js` | The unsanitized-HTML scanner (`innerHTML`/`outerHTML`/`srcdoc`/`insertAdjacentHTML`). |
| `vendor.test.js` | `VENDOR.md` parsing (which files are treated as third-party and left untouched). |


### Schema fixture (`schema-fixture/`)

The review matches API calls against Thunderbird's [annotated WebExtension
schemas](https://github.com/thunderbird/webext-annotated-schemas). Downloading
the real set would make the suite slow, online, and prone to drift as upstream
changes, so `schema-fixture/` is instead a tiny hand-built subset in the **same
JSON format** the tool consumes. (The real download nests its files under a
`schema-files/` subfolder - the loader also accepts a flat directory, which the
fixture uses.)

One file per namespace (`action`, `clipboard`, `compose`, `legacy`, `manifest`,
`messageDisplayScripts`, `messages`, `runtime`, `storage`, `tabs`), each an
array of namespace objects with `functions` / `events` / `properties` /
`types`. The entries are deliberately seeded with the annotations the checks
key off:

| Annotation | Drives | In the fixture |
| --- | --- | --- |
| `permissions` (namespace / function) | `missing-permission`, `unused-permission` | `messages` → `messagesRead`; `messages.move` → `accountsRead` + `messagesMove` |
| `deprecated` | `deprecated-api` | the whole `legacy` namespace; `messages.oldOne` |
| `version_added` vs `manifest.applicationVersion` | `deprecated-api` (API newer than the target) | target `128.0`, so `messages.future` (added `200`) is too new |
| `$extend` of `manifest` types | the valid permission + manifest-key sets for `missing-permission` / `invalid-manifest` | the `Permission` enum; `manifest:action` |

To exercise a new schema shape, add or extend a file here (and update the
affected add-on's `expected.json`).
