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

The `.xpi` must be the file itself, never a symlink to one.

Or put it on your PATH and run it from anywhere:

```sh
npm link            # from a clone of this repo
webext-linter <xpi|folder> [options]
```

`npm link` points the command back at the clone, so it always runs your working
copy: edit the source and the next run picks it up.

The schema review picks the matching schema **automatically** from the add-on's
own manifest.json - no channel flag. Two dimensions:

- **Manifest version**: `manifest_version` selects `mv2` vs `mv3`. An add-on that
  omits it (or has a missing/invalid manifest.json) is treated as MV2.
- **Channel** (`release`, `esr`, `beta`): chosen from the add-on's supported
  version range. The **upper bound** (`strict_max_version`) decides: an add-on
  capped at a channel's own Thunderbird major targets that train, so its schema is
  used - e.g. `strict_max_version: "140.*"` with ESR at 140 → the **ESR** schema
  (whose `version_added` entries reflect APIs backported into the ESR train). With
  no cap, or a cap that matches no cached train, it falls back to **release**. The
  `version_added` checks still flag genuinely unsupported APIs.

The options, grouped as in `--help`:

**Cache:** every download is cached in one folder, `WEBEXT-LINTER-CACHE/`, beside wherever
the linter runs - visible on purpose, so a developer packing their add-on folder sees it and
leaves it out (the linter reports it as junk in an XPI that carries it). Folders left by
older versions (`.schema-cache`, `.experiments-cache`, `.lib-mozilla-hash-db-cache`,
`.lib-cdn-lookup-cache`) are no longer read and can be deleted.

A cached download older than a day is downloaded again before it is used: the schemas
(all six together, once any of them is that old), the library-hash DB and the
allowed-experiments list each move upstream, and a stale copy would review against what
was true when it was fetched. The CDN lookup cache keeps a hit for good - a file hash
names one release - and never keeps a miss: a 404 can be a passing fault as well as an
answer, so it is asked again on the next run. The npm registry cache behind
`lockfile-injection` does the same, and so does the sources cache: a pinned library source a
review downloads (an npm release's files or tarball, a GitHub file, archive or release asset
at a tag or commit) is kept for good and never downloaded again. A review needs every host it
asks to answer: a request that gets no answer (still refused after the retries, timed out,
not accepted) ends the review with exit 2, like no network, rather than reading the
silence as a result - so an offline machine needs the network once a day.

| Option | Description |
| --- | --- |
| `--cache-clear` | Delete every cache directory below before the review, so all fetched sources (schema, library-hash DB, CDN lookups, npm registry answers, library sources, allowed-experiments) are re-downloaded from scratch - as on a first run. |
| `--cache-schema-dir <dir>` | Where the downloaded schema zips are cached (default `WEBEXT-LINTER-CACHE/schema`). |
| `--cache-hash-db-dir <dir>` | Where the fetched library-hash database (the addons-linter "dispensary" `hashes.txt`, used by `missing-library` to identify a bundled library by its exact content hash) is cached (default `WEBEXT-LINTER-CACHE/mozilla-hash-db`). |
| `--cache-cdn-lookup-dir <dir>` | Where the jsDelivr CDN hash-lookup results are cached, backing `--cdn-lib-lookup` (default `WEBEXT-LINTER-CACHE/cdn-lookup`). |
| `--cache-npm-registry-dir <dir>` | Where the npm registry's answers about a lock file's tarball URLs are cached, backing `lockfile-injection` for a registry URL off the tarball path (default `WEBEXT-LINTER-CACHE/npm-registry`). |
| `--cache-sources-dir <dir>` | Where the pinned library sources a review downloads are kept: VENDOR sources, package tarballs and unpkg's file listings (default `WEBEXT-LINTER-CACHE/sources`). |
| `--cache-experiments-dir <dir>` | Where the fetched allowed-experiments zip (the Thunderbird Draft-API list feeding the Experiment checks, e.g. `experiment-modified`) is cached (default `WEBEXT-LINTER-CACHE/experiments`). |

The banned/unadvised library policy (`assets/library-blocks.yaml`, read by `banned-library`) is curated by hand from Mozilla's [addons-linter third-party library docs](https://github.com/mozilla/addons-linter/blob/master/docs/third-party-libraries.md), since Mozilla ships no machine-readable list, and that page
is monitored and upstream changes are ported manually.

**Check selection:**

| Option | Description |
| --- | --- |
| `--checks-only <ids>` | Only run these checks (comma-separated). See the check list below. |
| `--checks-skip <ids>` | Skip these checks (comma-separated). See the check list below. A check that ends a review early (`experiment-not-allowed`, `lockfile-injection`) always runs, and neither flag may name it. |

**LLM review:** what an LLM agent runs, instead of a person reading the report. `--llm-review`
runs the review ONCE and hands out the first of its phases. Every `--llm-handback` run after
that takes a phase back and hands out the next, until the last one hands over the settled review.
`--llm-auto-review` reviews a submission folder: its `.xpi` as `--llm-review` does, or, with a
source archive, it starts a source code review: the agent extracts the archive (the `unpack`
step), and `--llm-handback` carries the build check on until it starts the review itself.

The agent audits each finding, settles what the scans could not, and puts the rest to a
reviewer - the linter decides what is asked and what an answer may say. The whole round
trip, the phases, the answer vocabulary and what the reviewer is handed are specified in
**[docs/spec.html](docs/spec.html#agent-handed)**, section 5 "What the agent is handed".

| Option | Description |
| --- | --- |
| `--llm-review` | Run the review and print the first phase's prompt, instead of the report. Given `--sca-extracted`, the source is copied into the work folder's `sca/` and the review starts with the build check, as `--llm-auto-review` does after the `unpack` step: the first prompt is the build analysis. Refused with `--report-format json`. |
| `--llm-handback <dir>` | Take a phase back from the review's work folder and hand out the next - the last being `close`, which hands over the settled review. On a work folder in the `unpack` or `build-check` mode, take that step instead, and once the build check is done, start the review (see [the build check](docs/spec.html#the-build-check-case)). The only run that carries on an existing work folder. Takes the work folder and nothing else: the review recorded every flag it runs with when it started, so anything typed beside it is refused (exit 2). Normally run by the agent, not by a person. |
| `--llm-auto-review` | Work out the review from a submission folder. One holding only the `.xpi` is reviewed as `--llm-review` reviews the `.xpi`, and an `.xpi` on its own is reviewed with `--llm-review`. A submission folder - one built `.xpi` and one archive of its source - gets the first prompt of a source code review of it, which creates the review's work folder at its default place beside the `.xpi`, records there how the review is to be run (this run's flags), has the source extracted into its `sca/` and handed back with `--llm-handback`, finds the package root in it, and has the build reported and judged. The reviewer then makes one decision about the build, worded by that verdict: let the agent build, build it themselves, build nothing, or hold it unsafe for reasons of their own. Where the agent may build and the lock installs a package with a known high or critical advisory, the build check has a copy's dependencies reduced, then audit-fixed (`rescued/` in the work folder), and reviews the copy if that resolves them. If it does not, the source as submitted is reviewed, and its vulnerability checks abort it. The hand-back that finishes the build check starts that review itself, with this run's flags. A submission the early-exit checks reject (a disallowed Experiment, an injected lock) gets no build check: its review closes after the `unpack` step. Refused beside any `--sca-*` flag, which is what the `unpack` step works out. See [the build check](docs/spec.html#the-build-check-case). |
| `--llm-skip-summary` | Leave out the summary report: the prompt does not ask for one and names no file for it. |
| `--llm-skip-sweep` | Leave out the sweep: no sweep agent is spawned, and the sweep is not handed to the reviewer either. |

**Claude Code permissions:** Claude Code's auto mode may stop a command it was not told to
expect. These allow rules let the linter's own commands run without that:

```json
{
  "permissions": {
    "allow": [
      "Bash(node */verify.js *)",
      "Bash(npm install --package-lock-only --ignore-scripts*)",
      "Bash(npm audit fix --package-lock-only --ignore-scripts*)",
      "Bash(pnpm install --lockfile-only --ignore-scripts*)",
      "Bash(pnpm audit --fix*)",
      "Bash(npm ci*)",
      "Bash(pnpm install --frozen-lockfile*)"
    ]
  }
}
```

The first runs the linter's hand-backs, the next four are the rescue's lock-only commands,
and the last two are the build's installs. The audits (`npm audit`, `pnpm audit`) and the
add-on's own build commands have no rule: the build commands run the submission's code, and
the reviewer's permission is what allows them.

**Source code archive (SCA):**

| Option | Description |
| --- | --- |
| `--sca-extracted <folder>` | The **extracted** source archive, all of it - a folder, not a packed archive, so extract the source yourself. Switches to SCA mode. The review copies it into its work folder's `sca/` and reads the copy, never the folder itself: every path the report names is relative to it. Every other `--sca-*` folder lies inside it, and it must not include the add-on. See [Source code archive (SCA) mode](#source-code-archive-sca-mode) below. |
| `--sca-package-root <folder>` | The package root inside `--sca-extracted`: the folder holding `package.json` and its lock file (`package-lock.json` or `pnpm-lock.yaml`), where the build runs and the package file and the lock are read. Left out, the linter finds it. Needs `--sca-extracted`. |
| `--sca-experiments <path>` | The Experiment implementation folder, **inside** `--sca-extracted`, anywhere in it, relative to it or absolute. Its privileged, non-WebExtension files are excluded from the WebExtension API/permission checks. Needs `--sca-extracted`, and is required for an Experiment and refused for any other add-on. |

**Other:**

| Option | Description |
| --- | --- |
| `--allow-experiments` | Accept add-ons that use Experiment APIs, instead of rejecting them as unsupported. Off by default. |
| `--cdn-lib-lookup <true\|false>` | Identify an unrecognized bundled library (minified or readable) by a jsDelivr content-hash lookup (default `true`). Results are cached. With `false`, no request goes to jsDelivr. |
| `--eslint` | Run the ESLint `code-sanity` check on authored JS. Off by default. |
| `--report-format <text\|json>` | Report output format (default `text`). |
| `--verbose` | Verbose logging. Recorded with the review's other flags, so every `--llm-handback` of a review started with it runs verbose. In a run that prints a prompt, the debug lines go to the "Tool messages" block at the end, never into the prompt. |
| `--warnings-as-errors` | Read every warning as an error for this review. Each one is listed among the issues that rejected the submission rather than as something to resolve with the next release, and the run exits `1`. Off by default. Set once, by the run that starts a review: a `--llm-handback` pass reads it back from the review and is refused if given it again. |

**Exit codes:** `0` no errors · `1` one or more error-severity findings (with
`--warnings-as-errors`, every warning is one) · `2` tool failure.

### Source code archive (SCA) mode

Some add-ons are submitted as **both** a built XPI (minified, what users install)
and a **readable source archive**. Reviewing the minified XPI directly is noisy, so
SCA mode reviews the readable source instead while still treating the XPI as the
authoritative shipped artifact:

```
node verify.js built.xpi --sca-extracted ./source-archive
```

A source archive is always reviewed as one - the review is never re-routed to the XPI on
the strength of what the XPI looks like. SCA is what you need when the shipped XPI is not
the code you wrote: minified, obfuscated, transpiled, or bundled.

Two rules govern the shape of such a submission, and each is its own check (neither
re-routing the review to the XPI). `sca-xpi-declares-vendoring` (a warning) - the built XPI
must not carry a VENDOR file, or a `package.json` or lock file at its root, because those are the
archive's, the copy the reviewer reads and the build installs from. It names the offending
files. `sca-xpi-fully-included-in-archive` (an error that aborts the review late) - the archive
must not hold the built XPI entire, which means either nothing was built or the build output
was committed beside the source. Such an archive could trick the build into handing back
that copy, so the submission is rejected. The rest of the review still runs, as the archive
may hold the real source beside the copy.

- `--sca-extracted` is the **extracted** source archive. Setting it switches on SCA mode. It
  must be a folder: unlike the submitted `.xpi`, which this tool extracts itself, a source
  archive comes in too many formats for this tool to open - extract it first, and every
  format then works, because `tar` handles what this tool does not. The review copies it
  into its work folder's `sca/` and reads only the copy, as it reads the `.xpi` in `xpi/`.
- **The whole extracted archive is the review source,** and every path the report names is
  relative to it. A build may take code from anywhere in the archive (a Makefile beside the
  node project, a shared folder, a workspace sibling), and that code ships in the XPI, so it is
  reviewed like the rest. There is no flag naming a subtree of
  it, because no subtree can be called the add-on's: a build may move, rename or generate
  anything, so a path in a source archive cannot be trusted and nothing can say which files
  are used. Every file in the archive is assumed used and is reviewed.
- The **package root** is the folder inside it the build runs in, the one holding
  `package.json` and the lock file, where both are read and the install runs. Where the
  archive wraps its contents in folders of its own, the linter finds it below them, and
  `--sca-package-root` names it where the linter cannot.
- The **readable source** is reviewed for code defects (the API/permission/
  exfiltration checks run over every source file).
- The **dependencies** are read from the committed lock file alone, never from
  `package.json`: the lock is what the install follows, so an override, a workspace
  member's own declarations and an optional dependency are all audited as installed. The
  packages the lock marks as declared, build dependencies included, are gated on
  popularity (npm downloads, or GitHub stars for one installed from GitHub). An npm
  lockfile v1 records no declared set, so every package in one counts as declared. A
  local install the archive does not hold as a folder (outside the extracted archive, absent,
  or a local tarball) is rejected, as is any other source the review cannot verify. Build
  dependencies are held to that same bar because the reviewer installs and RUNS them to
  reproduce the build, so refusing only the risks we can name would leave the ones we
  cannot. In a shipped XPI the `package.json` declaration must name a bare version, or a
  committed lock must resolve it.
- The **whole installed tree** is audited: the committed lock file records every
  package the install actually pulls in, at any depth, and almost all of a real
  submission's vulnerable packages are ones nobody declared. Every installed package is
  matched against the banned-library policy and queried against the advisory database in
  one batch, but reported only at **high and critical** - a package is worth reporting
  when it fails the review, not when it merely appears in one. An advisory saying the
  package itself is malicious states no band, and counts as critical. Declared and pulled-in cases are separate checks, because the developer fixes them
  differently: update this package, or update the one that pulls it in.
- The **build tooling** (build scripts, configs, `.npmrc`) is reviewed as part of the
  submission like everything else, and additionally feeds the build checks below. Two requirements decide whether the build
  can be reproduced at all: the archive must **carry a build** (no `package.json` at
  the package root means there is nothing to reproduce), and it must commit a **lock file**
  that installs exactly what `package.json` declares. npm and pnpm are the only package
  managers the review installs from, so those are the only locks that count and a build
  using anything else is rejected for having none. Each aborts the review, and nobody is
  asked to build a source that breaks either. A third requirement aborts the review from
  the other side: an `.npmrc` **in the package root** that points the package
  **registry** elsewhere is rejected (npm reads its config from the directory the install
  runs in), because the install would run but fetch something other than what is declared,
  so reproducing it attests nothing and it pulls code from a developer-chosen host onto the
  reviewer's machine. Beyond those, the build must not commit a `node_modules` folder or a
  built archive (`.xpi` / `.zip` - both are build output, never shipped in a source
  submission), and any `package.json` install hook (`postinstall`, …) escalates and aborts
  the review once reported.
  Nothing in those files says for certain what the build **does**, so a person decides it,
  and one of three build checks asks, depending on who decided:
  - **`build-review`**, where nobody decided about the build in a build check: a plain
    report, under Extended Manual Review, or an agent review run with a check the build
    relies on switched off, in `ask`. It is the whole build question, in the order it has to
    be taken: whether the build pulls from the declared dependencies alone - no raw URL,
    `curl|sh`, unpinned `git clone`, CDN or postinstall hook - and if it does not, not to
    build it, else to build it and compare the result with the shipped XPI. In `ask` its
    answers are `Builds fine and reproduces`, `Build issues`, or the reviewer's own words.
  - Under `--llm-review` the reviewer decides about the build in the build check, right
    after reading the Build Review Details with the agent's build report and its verdict.
    After an unsafe verdict they first skip building, or override the verdict and continue
    as if the build were safe. A build held safe is then put to them as the build decision:
    they let the agent build or build it themselves, or hold it unsafe for reasons of their
    own. Where the lock has a high or critical advisory, the agent's answer is to try to
    rescue the build: in a copy, it removes the dependencies the release build does not use
    and updates the rest to fixed releases. The rescue counts only where its build
    reproduces the shipped XPI, since only then did none of the vulnerable code ship.
  - Where the agent built it, the linter compares its build with the shipped XPI itself. A
    match answers the build question, and nobody is asked.
  - **`build-reproduces-xpi`**, where the reviewer held the build safe and built it
    themselves: the review opens with its build, before the sweeps, and asks alone how it
    came out, `Builds and reproduces`, `The built add-on does not match the submitted XPI`
    or `The build failed`. The last two report `build-not-reproduced` or `build-fails`, so
    the developer is told why the review stopped.
  - **`build-not-reproduced-confirm`**, where the agent's build did not match or failed: the
    same place in the review, asking "It seems as if the XPI could not be reproduced.
    Please confirm." with `The built add-on does not match the submitted XPI`, `The build
    failed` or `The XPI was correctly reproduced [override]`.
  - **`build-unsafe`**, where it held the build unsafe: it is reported at once, and nobody is
    asked to build. Skipping the build reports each issue the agent's build analysis listed,
    at its file and line, and the reviewer's own reasons report those reasons instead. The
    agent hands its issues back as a list, which the linter writes to `build-issues.md` and
    links in the Build Review Details, and reads the verdict off: none is a safe build.

  Any of them reported aborts the review late. A source whose build check gave its rescue up,
  or whose rescued build did not reproduce the XPI, is reviewed as submitted: it ends the
  review through its vulnerability findings, and is not built. A source with no
  usable package.json or no single readable lock skips the build question. The review
  itself builds nothing.
- The **built XPI** (the positional path) is the shipped artifact: it supplies the
  manifest.json, the experiments and the file-completeness checks (bundled /
  web-accessible / unused / locales). It gets the same library and parse passes in either
  mode (the vendor pass reads the review target only), so those checks see the
  shipped add-on the same way whether or not a source archive came with it.
- `--sca-experiments` names an Experiment implementation folder - anywhere in the
  extracted archive, relative to it or absolute inside it (e.g. `addon/experiment-api`),
  but never the archive itself, which would exclude nothing, nor a folder holding the build
  folder - so its privileged,
  non-WebExtension code is excluded from the WebExtension checks (required for an
  Experiment).
- Because a review spans two artifacts, each finding's `file:line` is prefixed with the
  artifact it lives in - `[XPI]` (the built XPI) or `[SCA]` (the readable source code
  archive) - so a reviewer knows which one to open. The Found Issues section closes with a
  legend, and the same prefix appears on the live activity feed. A plain XPI review
  (one artifact) adds no prefix.


## Review checks

Every check is declared in [assets/registry.yaml](assets/registry.yaml), and the
section it lives in **is** its phase: the orchestrator looks up the one phase it runs.
A section it never asks for is inert.

- **`deterministic-phase`** - every check, in order. The first, `experiment-not-allowed`,
  rejects an Experiment bundling an unsupported API draft (without `--allow-experiments`)
  and aborts the review, so no other check runs. Each case is decided in code, offline apart
  from the one-time vendor source fetch, and becomes either a finding or an escalation
  of a case the code cannot settle. A check's `input` mostly settles where it runs, and a
  check may carry a `when:` condition for what a route cannot say, over the facts known
  before any check runs (`sca`, `eslint`, `build-judged`, `build-safe`,
  `build-attempted`, `build-reproduced`), in the syntax the loop's steps use:
  `when: NOT sca` keeps the two that judge the shipped XPI's own lock out of a source review,
  `when: eslint` runs `code-sanity` only under `--eslint`, and the reviewer's build decision
  and what came of the agent's build pick which of `build-review`, `build-reproduces-xpi`,
  `build-not-reproduced-confirm` and `build-unsafe` asks about the build, or that none does.
- **`manual-checks`** - checks the tool can't make itself, surfaced as a todo list. Not
  a phase: the orchestrator never asks for this section.

The full flow - the entry points, the record and the hand-back, how the review data is
made, how the checks are run, and how a case the code cannot settle is escalated - is
specified in [docs/spec.html](docs/spec.html) ("The specification").

The tables below are an illustrative selection, not the full catalogue. For the
complete, registry-synced list of every check with its own page, see
[docs/index.html](docs/index.html).

### Deterministic checks

Each `deterministic-phase` entry links to a module in
[src/checks/rules/](src/checks/rules/) and supplies the severity for its
findings. A check decides each case in code - as a finding, or as an **escalation**
of a case it cannot settle, which reaches the reviewer as a to-do.

An escalation is sorted by who can settle it, and a check says that by naming its
READER: the wording it authors is either `instructions` (one text, for whoever is
asked), an `instructions-for-llm` beside an `instructions-for-human` (a different
question for each), or an `instructions-for-human` alone. A check with wording an
agent can be handed is screened, and its cases land under **Extended Code Review**.
A check whose cases the code cannot answer authors only the human half, and its cases
land under **Extended Manual Review**: `native-messaging` (what the listing discloses
about the native app), `build-review` (reproducing the build is
the reviewer's own attestation that the source produces the shipped XPI),
`trademark-thunderbird-name` (an
add-on name written directly in the manifest.json carries no locale tag, so the language has
to be settled before the trademark form can be judged at all), `vendored-remote-resources`
(a remote `@import` inside a file matching a published release is that release's line,
not the developer's, so accepting it is a judgement a person owns), and
`experiment-manual-review` (an Experiment runs with Thunderbird's own internals in reach,
so no scan of its surface settles what it does).

A finding is audited by the agent in the verify phase, unless its check says
`llm-verification: false` (a person's decision or a fact from outside the add-on, which
stands as reported). A check the agent audits says what its findings claim in
`llm-verification-instruction`, the text each finding is judged against, so that a
finding the check means to report whatever surrounds it is not withdrawn for what
surrounds it.

Some findings abort the review. A check declares that it does by naming the reason the
report gives, under one of two keys in the registry.

**Late** (`review-late-exit:`) is the default, and twenty-one checks use it:
`sca-xpi-fully-included-in-archive` names *source archive contains the built XPI*, the four
dependency-vulnerability checks name *known security vulnerabilities*, `banned-library`
names *disallowed library versions*, `minified-code` and `untrusted-minified-library` name
*code that cannot be reviewed*, and the fourteen that decide a source submission cannot be
built from - `sca-package-file-missing`, `sca-package-file-invalid`,
`sca-lock-file-missing`, `sca-lock-file-invalid`, `sca-lock-file-multiple`,
`lock-foreign-source`, `build-registry-redirect`, `build-lifecycle-hook`,
`build-review`, `build-reproduces-xpi`, `build-not-reproduced-confirm`,
`build-not-reproduced`, `build-fails` and
`build-unsafe` - name *build process issues*. Their error stops nothing while the review
runs: every check still runs, and under `--llm-review` the build question, the sweeps,
verify and settle run as usual, so verify can withdraw a wrong finding first (never a person's
decision or an outside fact, `llm-verification: false`) and the
developer is told everything in one round. A finding that still stands ends the review
before anyone is asked a question or to install the add-on, and a review without
`--llm-review` is aborted the same way at its end. The package.json and lock checks also
say that no build can be made from the source (`review-unbuildable: true`), so a review
holding one of their findings, or one whose build check gave its rescue up or whose rescue
did not reproduce the XPI, asks nobody to build it.

**Early** (`review-early-exit:`) is for the two cases where the rest of the review is no
use: `experiment-not-allowed` (*Experiment APIs not accepted*), a submission refused
whatever its code says, and `lockfile-injection` (*lock file entries that install another
release*), a forged lock every later reading would take at its word. They lead the review,
ahead of every late check. When one of them reports at error severity, the review stops
there: no check after it runs, and nothing further is put to a reviewer. An XPI-only review
halts on the same terms, and cancels the by-hand listing checks too.

Either way, the report of an aborted review drops every to-do item a reviewer would have
been **asked** - the two manual-review sections and their tally counts, plus any case an
agent had routed onward to a reviewer - keeps the code-review items, and the developer's
text ends on the reasons it is incomplete.

An aborting check of the source archive can say that a review of the XPI alone cures its
finding (`review-downgrade: true` in the registry): the shape, package.json and lock checks,
the build checks, `lockfile-injection` and the two build-dependency vulnerability checks.
`vendor-vulnerable-indirect` cannot, as it reports code the XPI ships. A source review under
`--llm-review` aborted only by such checks, whose XPI holds no minified, obfuscated or
untrusted minified code, shows its closing block and then asks the reviewer whether to
restart as an XPI review (see [When a restart as an XPI review is offered](docs/spec.html#close-the-review)).

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
| `background-module` | A background script (`background.scripts`/`service_worker`) that uses static ES module syntax (`import`/`export`) while the manifest.json's background is not declared `"type": "module"` - it won't load as a module (error). Background pages and content scripts are out of scope. |
| `bundled-files` | Referenced files that aren't packaged. Both halves come from the schema, not a hardcoded list: every manifest.json key the schema types as an extension-relative path (scripts, pages, popups, `icons` and every `default_icon`/`theme_icons`, ruleset paths, theme images, Experiment schema and parent scripts), and packaged-file paths passed to file-loading API calls (script registration, `setIcon`, `executeScript`/`insertCSS`, `getURL`, ...) - the same schema-derived loader set that fuels the reference graph. |
| `cleartext-transmission` | Data transmitted to a remote host over an unencrypted scheme (`http://`/`ws://`/`ftp://`) by an overt API (`fetch`, XHR, WebSocket, `sendBeacon`) - any cleartext send, regardless of payload (warning). A URL channel (a resource, a stylesheet, a window, a navigation) that carries data is `data-exfiltration`'s. |
| `code-sanity` | Opt-in (only runs with `--eslint`). ESLint-based code errors: `no-redeclare`, `no-shadow`, dupe/unreachable/self-* rules, empty blocks (`no-empty`, e.g. an error-swallowing empty `catch`) (info). Style/fixable rules (e.g. `prefer-const`) are excluded - a review never rewrites the add-on's code, so "rewrite this" is not a review concern. No `no-undef` (WebExtension scripts share a global scope). |
| `csp-unsafe-eval` | A `content_security_policy` that allows `'unsafe-eval'` - permits dynamic code execution (error). |
| `csp-unsafe-inline` | A `content_security_policy` that allows `'unsafe-inline'` - permits dynamic code execution via inline scripts (error). |
| `debugger-statement` | Unconditional `debugger` statements. |
| `locale-messages-invalid` | A `_locales/<lang>/` folder whose `messages.json` is missing or that Thunderbird cannot read (not UTF-8 or UTF-16 text, not JSON with only `//` comments, or not messages data) - Thunderbird refuses to install the add-on (error). |
| `default-locale-missing` | A packaged `_locales/<lang>/` folder but no `default_locale` manifest.json key - Thunderbird refuses to load the add-on (error). |
| `default-locale-unused` | A `default_locale` manifest.json key that names no packaged `_locales/<lang>/` folder (or no `_locales/` at all) - Thunderbird refuses to load the add-on (error). |
| `deprecated-api` | Deprecated APIs (member or namespace level). An API newer than the declared range is the `strict-*-version-api` checks. |
| `eval-call` | An `eval()` call in authored JS outside the WebExtension tree (Experiment/privileged code) - dynamic code execution (error). WebExtension code is exempt: it cannot run eval without a permissive CSP, which `csp-unsafe-eval` flags. |
| `experiment-manual-review` | Every reviewed Experiment (declares `experiment_apis`) - routed to manual review with a reminder that Experiments have full access to Thunderbird's internals and need a careful human code review. Fires for pristine, modified, and `--allow-experiments` submissions. Silent for non-Experiments and outright-rejected ones. |
| `experiment-missing-strict-max-version` | A reviewed Experiment (allowed by `--allow-experiments`, or a recognised upstream draft) that sets no `strict_max_version` (error). Never reached for one `experiment-not-allowed` rejects, which aborts the review. |
| `experiment-schema-invalid` | A packaged Experiment schema file Thunderbird cannot read (not UTF-8 or UTF-16 text, or not JSON with only `//` comments) - Thunderbird refuses to install the add-on (error). A declared schema that is not packaged is `bundled-files`'. |
| `experiment-modified` | A bundled Experiment that is a recognised published Thunderbird API draft but a modified or outdated copy (error) - the submission stays on the normal review path but is rejected until the unmodified latest upstream copy is bundled. |
| `experiment-overrides-api` | An Experiment whose declared API path overrides or grafts onto a built-in Thunderbird API instead of adding a new namespace (error). |
| `function-constructor` | A `new Function(...)` (the Function constructor) in authored JS outside the WebExtension tree (Experiment/privileged code) - dynamic code execution (error). WebExtension code is exempt (CSP-gated, see `csp-unsafe-eval`). |
| `manifest-invalid-json` | manifest.json is present but is not a JSON object - Thunderbird cannot read it (not UTF-8 or UTF-16 text, or not JSON with only `//` comments), or it reads as a primitive or array (error). |
| `manifest-missing` | No manifest.json at the add-on root (error). |
| `manifest-missing-key` | A required top-level manifest.json key (`manifest_version`/`name`/`version`) is absent (error). |
| `manifest-unknown-permission` | A declared permission value that is neither a known permission, a data-collection permission, nor a match pattern (error). |
| `manifest-version-mismatch` | `manifest_version` disagrees with the schema set being reviewed (error). |
| `minimize-host-permissions` | Broad (`<all_urls>` / `*` host) permissions requested as required (info). |
| `missing-english-localization` | User-facing text hardcoded in a non-English language while the add-on ships no English `_locales` (warning). Pre-flight: an English `_locales` directory (`en`, `en-US`, …) → pass, a `_locales` directory without one → a finding, and no `_locales` at all → language-detect the visible HTML text plus the manifest.json name/description with `franc`, where a confident non-English verdict is the finding. Too little text, or a near-tie with English, escalates. |
| `missing-library` | A bundled JS or CSS file (not in the VENDOR file) whose content hash matches a known third-party library release, named as `name version` (info). Identified by a fetched known-library hash database (Mozilla dispensary's `hashes.txt`), so the match is byte-exact. A file the database doesn't recognize is left to `minified-code`/`obfuscated-code` or scanned as the developer's own code. An identified library is also audited for known vulnerabilities (`vendor-vulnerable`), so an undeclared vulnerable bundle is still caught. |
| `missing-manifest-key` | A called API needs a manifest.json key (e.g. `action`) that is not declared (error). The manifest-key counterpart of `missing-permission`. |
| `missing-permission` | A permission required but not declared (error) - required by a called API, or implied by a declared script-injection manifest.json key (`compose_scripts` → `compose`, `message_display_scripts` → `messagesModify`). An API needing a manifest.json key is `missing-manifest-key`. |
| `missing-vendor-file` | A VENDOR entry (file + source URL) naming a file not present in the submission (warning). |
| `mistyped-manifest-value` | A known manifest.json key whose value has the wrong type, validated with ajv against a JSON Schema derived from the annotated schema (warning). Thunderbird misreads such values. |
| `native-messaging` | The `nativeMessaging` permission (in `permissions` or `optional_permissions`), which lets the add-on exchange messages with a native application outside Thunderbird - routed to manual review to confirm disclosure (No Surprises). |
| `non-experiment-strict-max-version` | A non-Experiment that pins `strict_max_version` (warning - it only blocks installs on newer Thunderbird). |
| `minified-code` | A script or stylesheet (not a recognized library, not obfuscated) shipped minified - by minified line geometry (a very long, dense line) (error, aborts the review late). A script that will not parse or walk counts as minified, since nothing there can be reviewed either. |
| `obfuscated-code` | A JS file (not a recognized library) shipped obfuscated - recognized by the AST structure of a known obfuscator family via the `obfuscation-detector` library. The families a match is drawn from are pinned, so a family the library gains later decides nothing and a match needs no second opinion. High precision, partial recall - some obfuscators evade it. |
| `privacy-policy` | Data transmitted by an overt API to a remote host the developer chose (fixed in the add-on, not entered by the user) - one case per transmission site, naming its host. A host the add-on assembles while it runs is reported too, marked rather than named, since dropping it would hide the site the tool can say least about. Routed to manual review to confirm the listing carries a privacy policy disclosing the collection (the policy text is not part of the package). Complements `data-exfiltration` (which judges consent). |
| `sca-package-file-missing` | A source submission with no `package.json` in its package root, so nothing seeds a build and the shipped add-on cannot be reproduced from the archive (error, aborts the review late). Reported as the bare fact: whether the build files were left out or never existed is not decidable from the archive. An archive holding the whole XPI is reported here and by `sca-xpi-fully-included-in-archive`. |
| `sca-package-file-invalid` | A `package.json` that is present but unusable - it does not parse, or it parses to something other than a JSON object - so the build it defines cannot be run (error, aborts the review late). Presence is decided by name and usability by reading, so exactly one of this and the check above ever speaks. |
| `sca-lock-file-multiple` | A source submission that commits more than one lock file in its package root (any two of `npm-shrinkwrap.json`, `package-lock.json`, `pnpm-lock.yaml`) (error, aborts the review late). Every check reads one lock, while the build picks its package manager by the lock it finds, so with two the tree audited need not be the tree installed. The build check neither audits nor rescues such a source. |
| `sca-lock-file-invalid` | A committed lock file that cannot be read: it does not parse, or it is not a recognisable npm or pnpm lock (error). The dependency audit reads the installed tree from it, so the review is aborted. Whether a readable lock matches `package.json` is left to `npm ci` / `pnpm install --frozen-lockfile` at the build. |
| `sca-dependencies-changed` | The source reviewed is a rescued copy (see [the build check](docs/spec.html#the-build-check-case)): its dependencies were reduced to what the release build uses, or audit-fixed, to get past known vulnerabilities. Says so once, at `package.json`, and tells the developer to run their package manager's audit, since their own files still have the vulnerabilities (info). Compared lock to lock: silent for a source that is no rescued copy, or a copy whose lock installs what the original's did. |
| `sca-not-needed` | An XPI review restarted from a source review that did not need its archive (see [When a restart as an XPI review is offered](docs/spec.html#close-the-review)): tells the developer to submit just the XPI next time (info). Raised by nothing in the files, only by that restart. |
| `lockfile-injection` | A lock entry that names one release and installs another: its `version` says 1.2.2 while its `resolved` URL (or pnpm's `resolution.tarball`) fetches 1.2.1, or another package (error, aborts the review). The audit asks about the name and version, the install fetches the URL. A URL on the registry's tarball path is compared offline, any other registry URL is asked of the registry once and cached (`--cache-npm-registry-dir`). It runs before the vulnerability checks, so a forged lock stops the review before the lock is audited, and the build check does not audit or rescue such a lock. |
| `lock-foreign-source` | A lock entry the install takes from a source other than the npm registry or GitHub (error, aborts the review late). The audit identifies a package by name and version, while the installer fetches the URL the lock records, so such an entry installs bytes the audit never read. |
| `sca-lock-file-missing` | A source submission that ships a `package.json` and no npm or pnpm lock file, so the reviewer's install refuses to run and the build cannot be reproduced (error, aborts the review late). The lock is owed by the `package.json`, not by what it declares: both installers refuse without one whatever it holds. A build using a package manager the review does not install from commits no lock that counts, so it is rejected here. |
| `string-timer` | A code string passed to `setTimeout`/`setInterval` (it is eval'd) in authored JS outside the WebExtension tree (Experiment/privileged code) - dynamic code execution (error). WebExtension code is exempt (CSP-gated, see `csp-unsafe-eval`). |
| `sync-xhr` | Synchronous `XMLHttpRequest` (`open(..., false)`). |
| `trademark-violation` | Add-on name (resolved from `_locales` for a `__MSG__` name) using a Mozilla brand term - `Firefox`/`Mozilla`/`MZLA` anywhere, in any locale (error, case-insensitive). Needs no knowledge of the language, so it is always a finding, and each offending name is reported once naming every locale that states it. `Thunderbird` is the two checks below, and a name carrying a brand term is left to this one alone, since it is refused either way. The icon is checked separately, on the listing and in the package. |
| `trademark-thunderbird-locale` | `Thunderbird` in a name resolved from `_locales`, other than as a trailing "for Thunderbird". A name from an `en*` locale is a finding - the policy is written in English - and a name decided that way is not also escalated because another locale states it. A name from any other locale escalates to code review, because the allowed and forbidden readings share one shape ("X para Thunderbird" is allowed, "X de Thunderbird" is not), word order and word boundaries both vary, and telling them apart needs the meaning of a word. Answerable from the package, since every locale file ships in it and its directory names the language. |
| `trademark-thunderbird-name` | The same question for a name the manifest.json states literally. It carries no locale tag, so nothing in the package says what language it is in and the language must be settled first - not answerable from the submission, so it escalates to manual review and never rejects on its own. |
| `unknown-api` | Unknown namespaces, unknown members (incl. methods on property types like `storage.local.x`), and APIs marked `unsupported`. |
| `unparsable-file` | A JavaScript, TypeScript, or Vue `<script>` source that failed to parse, so its API checks were skipped (info). |
| `unanalysable-file` | A source the parser read but whose code could not be walked, so none of it was analysed - a `let`, `const` or `class` declared twice, which no engine runs and no bundler builds. Reported in either artifact, at the line the parser named (error). |
| `unpinned-vendor-source` | A VENDOR-declared file whose (trusted-host) source is not pinned to an immutable version/tag/commit, so its bytes can't be verified (error). |
| `unrecognized-manifest-key` | A top-level manifest.json key the schema does not define - Thunderbird ignores it (info). |
| `unsafe-html` | Any write to `innerHTML`/`outerHTML`/`srcdoc`/`insertAdjacentHTML`. Only `Element.setHTML()` is sanctioned (an empty/null clear is exempt) (info). |
| `unused-permission` | A declared named permission (required or optional) that no reachable call provably requires (warning) - host patterns are `minimize-host-permissions`' concern. A permission is dropped as justified when an API call, a `navigator.*` Web/DOM call, or a script-injection manifest.json key proves it in use. It is a finding when the registry's permission prompt names its justifying usages as `tokens` and not one of them occurs anywhere in the live code (comments excluded) or the manifest.json - decided only while the scan can see every usage. Everything else escalates, carrying the sites where its tokens occur. |
| `update-url` | A manifest.json that declares an `update_url` (at `browser_specific_settings.gecko` or the deprecated `applications.gecko` alias, any manifest version). It self-hosts updates outside ATN, so the next version installs from a developer-controlled URL and bypasses review (error). |
| `vendor-modified` | A declared third-party file whose bytes don't match its pinned source (EOL-tolerant compare) - it appears modified from upstream (error). |
| `multiple-vendor-files` | More than one file in the package root names itself the VENDOR file (`VENDOR`, `VENDOR.md`, `VENDORS`, `VENDORS.md`), so which one the review reads would depend on the archive's order (error). None of them is read while it is ambiguous. |
| `vendor-unparseable` | A VENDOR file is present but yielded no declaration, so nothing can be verified (error). The parse is all-or-nothing: it reads only what is marked as a declaration - a path and a source URL paired by a colon, a key, or Markdown link syntax - and a fault anywhere discards the whole file. |
| `xpi-lock-file-missing` | A dependency in a SHIPPED `package.json` declared as a range, with no lock file committed to resolve it (error). The declaration states that a bundled file was copied from that release, and the review fetches that release to compare the shipped bytes against it, so a range names nothing to compare against until a lock says which version was bundled. Any of `package-lock.json`, `npm-shrinkwrap.json` or `pnpm-lock.yaml` is accepted. XPI submissions only: a source archive answers pinning against the tree the reviewer installs. |
| `xpi-lock-file-invalid` | The same declaration where a lock file IS committed and records no version for it (error) - regenerated from another `package.json`, keyed under another name, or unparseable. Kept apart from the row above because the remedy is: regenerate the lock rather than commit one. A dependency is never reported by both. |

### Checks that escalate

These checks **always run their scan**. Cases the scan can settle become findings
directly. The genuinely-ambiguous residue escalates per case, so the reviewer is
handed a concrete `file:line` to look at rather than a verdict the tool guessed.

| Check id (`check:`) | What the scan settles, and what it escalates |
| --- | --- |
| `strict-min-version-api` | Pre-flight: a call to a real, schema-resolved API added in a Thunderbird newer than the declared `strict_min_version`. Every call escalates, for the reviewer to judge from the call's file whether a guard (optional chaining, a `typeof`/existence test, a `getBrowserInfo` version gate, an earlier guard clause that returned or threw when the API was missing) keeps it off the older versions. A non-existent API is `unknown-api`'s concern. |
| `remote-eval` | Pre-flight: the statically-undecidable `fetch()->eval` pattern (scanned only outside the WebExtension tree, like the other dynamic-execution checks - WebExtension code is CSP-gated) escalates, for the reviewer to judge from the offending file whether the executed code is fetched remotely. The definite dynamic-execution cases are the deterministic `eval-call`/`function-constructor`/`string-timer`/`csp-unsafe-eval`/`csp-unsafe-inline` checks. |
| `remote-resources` | Pre-flight: remote `<script>`/`<link>`/`@import`/`url()`/media/imports/`importScripts`/runtime injection/WASM, and a CSP permitting a remote script source → a finding. Statically-undecidable cases (non-literal URLs, inline `data:`/`blob:` script sources) escalate for the reviewer to resolve. |
| `vendored-remote-resources` | The same scan's other question: a remote load inside an HTML/CSS file whose content matches a published upstream release. The line is that release's, not the developer's, so it emits no finding and every site goes to a person - accepting it as published is a judgement they own. Turns on the content match, never on a declaration. |
| `data-exfiltration` | Pre-flight: a transmission (`fetch`/XHR/WebSocket/EventSource/`sendBeacon`/a form) to a remote or dynamic host, and a URL channel (a resource `src`/`href`, a stylesheet `url()`, `window.open()`, a page navigation) to a non-local host built with a runtime value or a user-data call, escalates, labelled with its route. It is reported unless no sensitive data leaves, the user set the transmission up, or it is the add-on's stated single purpose. |
| `minimize-web-accessible-resources` | Pre-flight: over-broad exposure (a resource pattern like `*`, or MV3 `matches` of `<all_urls>`/`*://*/*`) and concrete resources no content script/page loads → a finding. An ambiguous exposed resource (dynamic loaders, or name mentioned) escalates, for the reviewer to judge whether it is needlessly exposed. |
| `unused-files` | Pre-flight: hidden/junk by name, and files reachable from no manifest.json entry point (a reference graph over imports/`getURL`/HTML/CSS plus schema-derived file-loading APIs) - a clearly-unreferenced file is a finding. An ambiguous file (string-mentioned, or the add-on uses dynamic loaders) escalates, for the reviewer to follow the suspected loaders and judge whether it is unused. Documentation (any `.md`/`.rst`/`.license`, or a `.txt` or extensionless file named like a doc), `package.json`, lock files and `_locales` are exempt. Junk by name is reported ahead of any exemption. |

### Blind-spot sweeps

Some checks scan for an enumerated set of forms, and the set cannot be finished:
the ways data can leave an add-on are a property of the platform, not a bounded
API surface, so a sender the scan does not name leaves no trace in the report.
Extending the list moves that boundary without closing it.

Such a check declares a **`sweep-instruction:`** in the yaml, describing the
*class* of code it cannot see and the test to judge it by - never a list of
candidate forms, which would only rebuild the same blind spot in prose. Every
check that declares one is listed in the report's **Standard Code Review** section, whether
or not it found anything: a check that found nothing is exactly the one whose
blind spot is worth reading.

A sweep names a file, so it is a request about exactly one **tree**, and every
entry names the folder to search - a source review has two open at once. The
check's `input:` says which tree, except on `input: all`, which reads every
artifact and so names none: a check there declares
**`sweep-instruction-for-xpi:`** and/or **`sweep-instruction-for-sca:`**, and
each becomes an independent sweep of its own tree.

Under `--llm-review` each tree gets its own sweep agent, handed the
request the prompt prints - the folder to read, and the sweeps to answer - and
returning its answers as its reply, which the orchestrating agent writes
unchanged to an answers file the linter reads. The instruction says what to look
for. Where to look, and where each answer belongs, are the linter's.

A `sweep-instruction` says what to LOOK FOR, and never what confirming something
means - that is the owning check's to say, in its own wording, so a swept case
and a scanned one put the same question to the same reader.

Who does the looking is the one thing that varies. In a review with no agent in
it, the reviewer works that list by hand. Under `--llm-review` a sweep agent reads
for the same things and hands back what it found, and the linter routes each
result into the owning check - described in
[docs/spec.html](docs/spec.html#sweep), section 5.4 "The sweep".

| Check id (`check:`) | The blind spot its sweep covers |
| --- | --- |
| `build-modifies-code` | A build step that changes a third-party file in any way, or adds or changes code in the add-on's own files beyond filling in a placeholder (source reviews only). |
| `data-exfiltration` | The user's sensitive data leaving the machine where the user would not expect it: at least by a network request, a resource, stylesheet, window or navigation URL, or mail the add-on sends, then by any other route. |
| `cleartext-transmission` | Anything reaching an `http://`/`ws://`/`ftp://` endpoint by an unlisted route, whatever the payload, a URL the user enters that the code does not refuse or upgrade included. A host permission on its own is not a case. |
| `privacy-policy` | The add-on reaching a developer-chosen remote service by an unlisted route. |
| `unacceptable-package-content` | Content the add-on ships - its name and description, an icon, or bundled text, images or media - that is spam, inappropriate, misleading or low-effort, or breaches Mozilla's Acceptable Use Policy. |
| `shipped-icon-trademark-imitation` | An icon the add-on ships that imitates or incorporates the Thunderbird, Firefox or Mozilla logo. Acceptability is the row above, this row is the trademark. |

### Manual checks

Some review steps can't be automated - they need hands-on testing or a human's
judgment over content the tool can't see (the store listing, screenshots, the
icon). These live under `manual-checks` in the yaml and are surfaced in the
report's **Standard Manual Review** to-do list, unless the review was aborted. They carry a severity like every other entry, so a reviewer settles one exactly as they settle an escalation: the item names the band a confirmed case lands in, and `--llm-handback` can confirm it into a finding or clear it away.

| Check id (`check:`) | What the reviewer verifies |
| --- | --- |
| `suitability-for-listing` | Whether the add-on targets a limited or non-public audience (better self-hosted than listed). |
| `unacceptable-listing-content` | The ATN listing page - its summary, description and screenshots - for spam, inappropriate or misleading content, and against Mozilla's Acceptable Use Policy. Every fix here is a listing edit, so no new version is needed. |
| `missing-atn-description` | The ATN listing page has usage instructions, entry points, and screenshots. |
| `missing-english-atn-localization` | The ATN listing page also has an English version. |
| `icon-trademark-imitation` | The icon on the ATN listing page, for imitation of the Thunderbird, Firefox or Mozilla logo (an image the automated checks can't inspect). The icons the package ships are a separate check. |
| `add-on-functionality` | The add-on running in a test profile: whether it acts as its ATN listing describes, generally works, reaches the described functionality with the developer's credentials, and makes clear what it sends to any remote server. |
| `testing-information` | Whether the review needs anything the submission does not carry - credentials for a service the add-on signs in to, a test account, or instructions for reaching a feature. Asked after the test above, because that is where the need shows itself. |
| `no-surprises-policy` | The code diff for behavior not documented on the ATN listing that could surprise the user. |
| `missing-payment-disclosure` | Whether the add-on requires payment but the "needs payment" flag is not set on ATN. |
| `forked-add-on` | A forked add-on is clearly distinguished from the original and offers a significant difference in functionality and/or code. |


## Examples

```sh
# Review a submitted xpi against the matching schema (report only - the submission
# is never modified, though it is extracted to ./xpi-review-submission-<timestamp>/xpi/ to be read)
node verify.js ./submission.xpi

# Review an already-unpacked folder (copied to ./xpi-review-my-addon-<timestamp>/xpi/ and read there)
node verify.js ./my-addon

# machine-readable JSON output
node verify.js ./submission.xpi --report-format json

# Review a source-code submission (the built XPI plus its readable source, in
# ./sca-review-built-<timestamp>/)
node verify.js ./built.xpi --sca-extracted ./source
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
