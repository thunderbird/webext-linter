# LLM review

The linter can hand its review to an LLM agent instead of printing it. The agent does
the reading a person would otherwise do - auditing each finding, settling the cases the
scans could not, putting the rest to a reviewer - and the linter stays the one deciding
what is asked, in what order, and what an answer is allowed to say.

This is the long-form version; the [README](../README.md) carries the summary and the
flags in the context of every other option.

- [The round trip](#the-round-trip)
- [The phases](#the-phases)
- [When the review is aborted early](#when-the-review-is-aborted-early)
- [What an answer may say](#what-an-answer-may-say)
- [The sweep](#the-sweep)
- [What the reviewer is handed](#what-the-reviewer-is-handed)
- [Preparing a source code review](#preparing-a-source-code-review)
- [Flags](#flags)


## The round trip

`--llm-review` runs the review **once** and prints the first phase's prompt instead of
the report. Every `--llm-handback` run after that takes a phase back and hands out the
next, until nothing else has work and the last one, `close`, hands over the settled review.

```sh
node verify.js ./submission.xpi --llm-review     # runs the review, prints prompt 1
node verify.js --llm-handback <work-folder>      # ...and each pass after it
```

The agent opens ONE file, ever: the review file the prompt names. It fills in each
entry's empty `"answer"` and hands the review's work folder back - the command is in the
prompt. Everything the linter needs between passes is in a state file beside it that the
agent is never pointed at, which is why `--llm-handback` takes no add-on path: the
deterministic review ran once, and nothing re-derives it. Both files sit in the review's work folder,
with every other file the review names (see [Where a review's files go](#where-a-reviews-files-go)).

Each prompt is assembled from the same layers, so a pass never has to be read as a
special case: a preamble on the first pass only (what is about to happen - left out where
that first pass is already the closing one, since no passes follow), the frame
(which file, and that it changed), the phase's own intro and numbered steps, and one
closing step saying how to hand the file back. A path is printed by the step that needs
it, and nowhere else.

A hand-back that cannot be accepted is **refused** rather than repaired: the prompt is
not re-printed, nothing in the state changes, and the agent is told what was wrong so it
can redo that pass. An unanswered slot, an answer of the wrong kind, and an answer the
entry never offered are all refusals.


## The phases

| Phase | What it is for | What fills its answers |
| --- | --- | --- |
| `spawn` | Start the sub-agents the review needs - the add-on description, the build report, one sweep per tree - and read back what the sweeps found. | Nothing: each sweep answers in a file of its own (see below) |
| `verify` | Audit what the deterministic checks claimed. | `reported` / `withdrawn` |
| `settle` | Decide the cases a check could not settle from the package. | `reported` / `cleared` / `ask` |
| `build` | Source code review only: with the reviewer's consent, build the add-on in the agent's own sandbox and write how the result differs from the shipped XPI. | Nothing: the diff goes to a file of its own |
| `details` | Hand the reviewer the Review Details block, before anything is put to them - whenever a question follows: every review without `--llm-skip-manual`, and every source review, whose build questions are asked under it too. | Nothing: the block is its whole work |
| `built` | Source code review only: ask the reviewer, alone, whether the build succeeded. | The reviewer's own answer |
| `reproduced` | Source code review only: ask the reviewer, alone, whether the built XPI reproduces the submitted one. | The reviewer's own answer |
| `ask` | Put to a reviewer what only a person can answer. | The reviewer's own answer |
| `close` | The last phase, once nothing else has work: hand over the settled review. It opens on whether the review is settled or was aborted, and says only what applies to it. | Nothing: the review ends with it |

A phase is issued only when it has **work** - steps that survive their markers, or
entries to settle - and that is also what ends the loop. So a review with no sweep never
mentions one, and a review that starts no sub-agent at all skips `spawn` and opens at the
first phase that has any. The package itself is not unpacked by any of this: the linter extracts a packed
submission, or copies an unpacked one, into the work folder's `xpi/` before the first
prompt is printed, and every phase reads that one folder.

Which steps a phase prints is decided by each step's `when:` condition: `AND`, `OR`, `NOT`
and parentheses over the facts of this run - the `--llm-skip-*` flags it was given,
`aborted` once a finding has aborted the review, `sca` for a source code review,
`sweep-xpi` / `sweep-sca` for a tree with a sweep to run, `first` on the review's first
prompt, `spawned` once `spawn` went out, `decided` once `verify` or `settle` did, and
`closing` in the closing prompt. A step with no condition prints in every run, and a phase
left with no step is not issued. The preamble's parts are conditioned the same way. A wait
for spawned agents is a step of its own (`when: spawned AND ...`), carrying its phase's own
condition so that a wait alone never issues a phase. The registry spells each one
out, for example `build`'s `sca AND NOT aborted`, or `details`'
`NOT aborted AND (sca OR NOT llm-skip-manual)`, and refuses a condition that does not parse
or names a fact nothing answers.

`build`, `details`, `built`, `reproduced` and `ask` have one further condition: a review that was **aborted
early** never reaches them - each of their steps reads `NOT aborted`. `build` runs the submission's own code, so it waits until every
check that can abort the review has had its say - including `build-lifecycle-hook`, which `settle`
decides. The agent asks the reviewer before building, builds in a copy of the source
archive, installing the dependencies exactly as the lock pins them (`npm ci` /
`pnpm install --frozen-lockfile`), and writes the outcome to `BUILD_DIFF`: identical,
differing (with the diff), or failed (with the failing step and its error, and saying so
where package.json and the lock file disagree). The linter judges none of it; the reviewer
reads the diff to answer the two build questions.

Before anything is built, the agent settles `undeclared-build-source` in `settle`: does any
build step reach outside the declared dependencies? Reported, it aborts the review, so the
build never runs and is never offered. After the build come the two build questions, each in
a phase of its own so it is put to the reviewer ALONE and before anything else - `ask`
batches, and nobody may be asked to install an XPI in the same breath as being asked whether
the source reproduces it. `built` asks whether the build succeeded (`build-succeeds`), then
`reproduced` whether its result matches the submitted XPI (`build-reproduces-xpi`); each
check names its phase (`asked-in:` in the registry), and the case carries it. A "no" - Report,
or the reviewer's own words - aborts the review: that case becomes its finding, the other
build question and every `ask` question are dropped, and the report ends on "Build process
issues". So a build that failed is never also reported as not reproducing the XPI. Both
questions are asked under `--llm-skip-manual` too: they decide whether the review goes on,
which is not what that flag withholds.


## When the review is aborted early

Some findings settle the submission on their own, and carrying on would ask someone to do
work the review has already ruled out. The case it exists for: a source submission whose
dependency tree carries known high or critical advisories, where the very next thing the
loop would do is ask a reviewer to **reproduce the build** - running that tree on their own
machine, on the strength of a question the linter issued knowing better.

A check declares that it aborts the review by naming the reason the report gives
(`review-early-exit:` in the registry). Today fifteen do, across three reasons: the four
dependency-vulnerability checks name *known security vulnerabilities*, `banned-library`
names *disallowed library versions*, and the ten that decide a source submission cannot
be built from - `sca-package-file-missing`,
`sca-package-file-invalid`, `sca-lock-file-missing`, `sca-lock-file-invalid`,
`build-registry-redirect`, `lock-foreign-source`, `build-lifecycle-hook`,
`undeclared-build-source`, `build-succeeds` and `build-reproduces-xpi` - name *a build
that cannot be reproduced*. The threshold is the finding's severity, so an advisory
that lands as a warning aborts nothing.

That threshold is also what lets `build-lifecycle-hook` carry the flag while it reports
nothing itself. It escalates its install hook to the agent, and an escalated case becomes a
finding of its own check only when the agent **reports** it, at that check's severity. So a
hook the agent clears aborts nothing, and neither does a review with no agent to judge it -
the review is aborted once someone has determined the hook fetches code, which is code that
would run on the reviewer's machine the moment they install.

What an aborted review does under `--llm-review`:

| | |
| --- | --- |
| A review the deterministic checks aborted | asks nothing at all: its first prompt is the `close` phase. No agent is started (no description, no build report, no sweep), and nothing is verified or settled - every step of `spawn`, `verify` and `settle` carries `NOT aborted`. What it hands over is decided before any pass, so no pass could change it. |
| A review a pass aborted | (a case reported that aborts it, a build that did not reproduce) stops there: the `build`, `details` and `ask` phases that would follow are not issued, so nothing is built and nothing further is put to a reviewer. |
| The hand-over | carries no to-do item: the tally counts none, and the Final Review Details name no file an agent was never asked to write. |
| The report | ends on the reason it is incomplete, one line per distinct cause. |
| The `close` phase | opens with a step of its own (`when: aborted`), because telling an agent "the review is settled" about one that was cut short is not true. The summary and the details that follow are the same. |

A finding that aborts the review is never put to the agent to verify, so no verdict takes it
back. That is also why a check that authors a sweep may not abort a review: a sweep's hints
are merged unverified, and the registry refuses a check that does both.

A review run without `--llm-review` is aborted on the same terms. Its printed report drops
every to-do item a reviewer would have been **asked**, and keeps both code-review sections:
reading code is safe, and what it turns up is the evidence for the halt.


## What an answer may say

What an entry's `"answer"` may say depends on WHO THE PHASE ASKS.

A phase the agent settles by reading the add-on takes one of the linter's verbs:
`verify` takes `reported` or `withdrawn`; `settle` takes `reported`, `cleared` or `ask` -
the last of which does not settle the case but sends it on to the reviewer, keeping its
number.

Which of those an entry actually offers is the owning check's to narrow: a check that can
be screened but never settled from the package alone offers `cleared` and `ask` and no
way to report, because reporting it would decide a question the package cannot answer.
Each entry carries the answers it offers, with the wording for each, and an answer it did
not offer is refused.

The `ask` phase takes what the reviewer answered: the label of one of the answers that
question offered (`Clear`, `Report`, listed under the entry's `answers`), or the words
they typed instead, which report the case and carry those words with it.

Those words are the one thing in the file a person writes, and they are printed on that
case's location line - in parentheses after the location, or as the line itself when the
case has none, where the reviewer's own line breaks are kept and each becomes an item of
its own.

Crossing the two is refused, naming the entry so the question can be asked again rather
than an answer made to fit: a verb where a reviewer was asked, a reviewer's answer where
the agent settles, an answer with nothing in it, and one past the length the question
tells the reviewer they have (`MAX_NOTE`).


## The sweep

Some checks scan for an enumerated set of forms, and the set cannot be finished, so each
one declares a **`sweep-instruction:`** describing the class of code it cannot see - see
[Blind-spot sweeps](../README.md#blind-spot-sweeps) for why they exist and which checks
declare one. Every review prints those instructions under **Standard Code Review**, for
whoever is reading the add-on to cover by hand.

A sweep names a file, so it is a request about exactly **one tree**. Which tree is settled
by the check's `input:`, except on `input: all` - the route that reads every artifact and
so names none. A check there declares **`sweep-instruction-for-xpi:`** and/or
**`sweep-instruction-for-sca:`** instead, and each declaration becomes an independent
sweep with its own words and its own tree. Every entry, printed or handed out, names the
folder to search as a path, because a source review has two trees open at once.

Under `--llm-review` that reading is a sub-agent's, **one per tree**, and the sweep is the
only sub-agent whose output the linter reads. So it is the only one with a shape, and it
gets two files of its own rather than reporting through the orchestrating agent:

| | Written by | Format | Read back by |
| --- | --- | --- | --- |
| `sweep-<artifact>.yaml` | the linter | YAML - the prose is the bulk of it | nobody |
| `sweep-<artifact>.answers.json` | the sweeping agent | JSON - one quoting rule, where a hint holding `http://host: thing` would break YAML | the linter |

The request stands alone, because the agent is handed a path and nothing else:

```yaml
sweepTarget: /reviews/addon-1.2-<timestamp>/xpi/
answerFile: /reviews/addon-1.2-<timestamp>/sweep-xpi.answers.json
instructions: |-
  This file holds 2 separate sweeps, listed under "sweeps" below. ...
sweeps:
  - label: 9
    title: Check the package for unacceptable content
    instruction: |-
      Content shipped inside the package ...
```

and the answers file is pre-created with a `null` per label:

```json
{ "answers": { "9": null, "10": null } }
```

`label` is the identity, and it is the **linter's**: unique across the whole review, so
the two files cannot collide and no agent is ever asked which request an answer belongs
to. It is also the number the report prints beside that sweep, so the page a reviewer
reads and the request an agent reads are the same list under the same numbers. Nothing of
the review's vocabulary reaches the agent - not a check id, not an artifact - because
where a hint lands is the review's to know.

Replacing a `null` with a list is the whole answer; an empty list is "swept and clean",
and a `null` left behind is refused. That is what separates "found nothing" from "never
looked", and it is the agent's own statement rather than something inferred from silence.

The orchestrating agent never touches any of this. Its two `spawn` steps each hand one
sub-agent one path and tell it to follow the `instructions` in that file; it waits, and
hands back a review file whose `entries` are empty.

What comes back is not a verdict on the sweep, and not a classification either: the agent
that sweeps reads the add-on, not the linter, so it cannot know whether what it found is
something that check would have filed, escalated, or deliberately excluded. It hands back
the location and what is there; the routing is the linter's.

A sweep is a DETECTOR and nothing more. What comes back is a hint - a location that
check's own detectors missed - and from there the case is one of that check's, handled
exactly as a case it found for itself:

| The owning check | Where a swept result lands |
| --- | --- |
| escalates | An escalation of that check, in the section that check's own wording puts it in, asking the question that check asks - its own instructions, never the text the sweep agent was sent. |
| does not escalate | A **finding** of that check. Such a check settles its cases as findings, so a swept one is a finding too, and the `verify` phase audits it like every other claim. |

So a sweep instruction says what to LOOK FOR, and is read in exactly two places: the
request handed to the sweep agent, and the Standard Code Review list every report prints.
It never says WHERE - that is the linter's, carried as `sweepTarget` - and it never says
what confirming something means, which is the owning check's to say.

Either way the case is deduplicated against what the deterministic pass already covered
in that same tree, as a to-do item or as a finding, so nothing downstream can tell a swept
case from one a check found. The `hint` is a locus annotation naming what sits at that line; the paragraph
the developer reads stays the registry's.

`--llm-skip-sweep` withholds all of this: no request is written, the prompt spawns no
sweeping agent, and the sweep is left out of the review - it is not handed to the
reviewer, in the prompt or in the report.


## What the reviewer is handed

Before anything is put to them, the reviewer is handed a **Review details** block naming
what this review is and where to read it:

| Name | What it names |
| --- | --- |
| `XPI_FILE` | What was submitted, by name - the .xpi as ATN named it, or the folder's own name where the submission arrived unpacked |
| `XPI_ROOT` | The shipped package, unpacked, ready to read |
| `SCA_ROOT` | A source code review's source root - the whole of which is reviewed |
| `SCA_EXP_SOURCE` | The Experiment implementation folder, when one was named |
| `ADDON_DESCRIPTION` | Where a sub-agent wrote a description of the add-on, for reading while answering |
| `BUILD_PROCESS` | Where another wrote what building the add-on takes, in a source code review |
| `BUILD_DIFF` | How the agent's build differs from the shipped XPI - only once the `build` phase wrote it, since the reviewer may decline the build |
| `REVIEW_REPORT` | The text the reviewer sends to the developer, written by the linter |

The linter names these files and reads none of them. The description and the build report
are a sub-agent's, and the agent conducting the review is told only to name them - not to
open, read, summarise or print what was written there.

`REVIEW_REPORT` it writes itself, twice: once as the `details` phase goes out, so the
reviewer can read the report while answering the questions that follow, and again from the settled review
once those answers are in. It is a file rather than something the agent prints because
printing it failed - the hand-over used to carry the report and ask for it back "in a code
block and unchanged", and that is the one text where a model rewording its input reaches the
developer.

The block is handed over twice, for two different readings. The `details` phase hands it
over before anything is asked, so the reviewer can open those files while answering, and
the last pass hands it over again as what they are left holding.

The last pass is the `close` phase. The linter applies every answer, writes `REVIEW_REPORT`,
and only then prints it, so it opens on whether the review settled or was aborted: of its two
opening steps, one reads `when: aborted` and the other `when: NOT aborted AND NOT first` - a
reader who never saw the review in progress learns nothing from its being settled. Each
step after them says only what applies: the wait where agents were started (`spawned`), and
**LLM decisions** where the agent judged anything (`decided`). It hands over the agent's own
account and the block, each under a heading of its own: **LLM decisions** (every finding it
withdrew and every verdict it reached, with its reasons - the only part that is the agent's
to write),
**Summary** (the tally), and **Final Review Details** (every path this review named,
`REVIEW_REPORT` among them, and nothing of what is in any of them). Where the review was aborted
early, the reasons close that block, because only the block can list what aborted this
review. Nothing is handed back after `close`: it carries no hand-back step, and a hand-back
is refused.


## Preparing a source code review

A source code submission arrives as two files - the built `.xpi` and an archive of the
source it was built from - and reviewing it needs three `--sca-*` arguments, two of which
nobody can write without opening that archive. `--llm-sca-review` reads the add-on
argument as that submission folder instead of as an add-on: it does the half a program
can do, and hands those two to a reader who can open the archive.

```sh
node verify.js ./submission-folder --llm-sca-review
```

It reviews nothing. It names which file is the add-on and which is the source, creates the
review's work folder at its default place beside the `.xpi`, names its `sca/` as where the
source archive is to be extracted (`EXTRACT_TO`), and asks its reader to extract it there and work out two things that only
reading the tree can settle: which directory is the source root, being the one holding
`package.json` (`<SCA_ROOT>`), and - for an Experiment - which holds the Experiment implementation (`<SCA_EXP_SOURCE>`). A name in `<angle brackets>` is one of
those, and every other name is given. Nothing asks which directory holds the add-on's own
code: the whole of `<SCA_ROOT>` is reviewed, because a build may move or generate anything
and no subtree can be shown to be the add-on's.

Where the archive is extracted and where its build runs are two different places, which is
why `EXTRACT_TO` is not `<SCA_ROOT>`: an archive that carries its contents in a directory
of its own puts the build files a level below the destination. The review does not depend
on that being answered correctly - handed a root with no `package.json` and one subfolder
that has one, it settles the root itself before reading anything (`src/addon/sca-root.js`)
and says so in its Setup feed.

The reader hands the two back in the work folder's review file (`ANSWERS`, the same
`review.json` a review pass uses) and runs `--llm-handback` on the folder. The preparation's
own record, `prepare.json`, says where it stands, so every step is that one command; the
reader never chooses what comes next. A root outside `sca/`, or an Experiment folder outside
the root, is refused, and the reader corrects the file and hands it back again.

That hand-back settles the roots as the review would, and then **audits the root's lock**
(`src/prepare/audit.js`): every package it installs, against OSV and the policy blocklist,
exactly as the review's own dependency audit reads it. Nothing else is judged here -
another reason to stop, an Experiment, `--checks-*`, the band policy: all of that stays with
the review. Three outcomes:

- **The lock is clean**, or the audit cannot read it in full (no lock, one that does not
  parse, an entry from a source the audit cannot read, a scan OSV refused with a 404): the
  folder is done, and the same hand-back starts its review. The review decides the rest.
- **The lock installs a package with a known high or critical advisory**: the linter copies
  the work folder to `<work folder>-rescued` and hands the copy two steps. First the reader
  **reduces** the copy's dependencies to what the release build uses, then, where that is not
  enough, applies the package manager's **audit fix** - lock-only commands with
  `--ignore-scripts`, so no submission code runs. The copy is audited after each step, and a
  clean one is reviewed instead of the original. A reader that cannot run the commands hands
  back without changing anything. The hand-back that finds the copy clean starts its review.
- **The copy is still vulnerable after the fix**: the copy is deleted, and the original is
  reviewed, **unrescued**. Its record holds the lock audit the preparation ran, and its
  review takes that as its own: it reads the add-on, the schema and the source archive, asks
  no network for the dependencies, and runs only the checks whose early-exit reason the
  registry's `rescue-for` names. They report each vulnerable lock entry, which aborts the
  review for known vulnerabilities, and it closes as any aborted review does. A record that
  says the rescue was given up but holds no high or critical entry was edited, and the
  review refuses it before it starts.

A rescued copy's review tells the developer, at info, that the source was reviewed with
changed dependencies (`sca-dependencies-changed`): their own `package.json` and lock still
carry the vulnerabilities.

The reader never runs anything but `--llm-handback`. The hand-back that finds the preparation
done starts the review itself, in that folder: under `--llm-review`, with the preparation's
own flags, the add-on it was given and the settled `--sca-*` roots, all read from
`prepare.json`. That record is the linter's alone: every write leaves it read-only, and stores
a hash over it, so a record changed after the linter wrote it is refused. The reader works in
the same folder as the same user, so neither makes the file tamper-proof, and nothing in it is
taken as it stands either: only the flags a review takes, each of its own type and checked as a command line is,
with the roots checked again as folders, and a record that does not hold up is refused to the
reader. `--cache-clear` and `--verbose` belong to the `--llm-sca-review` run and are not
passed on. The hand-back prints the review's first prompt,
and from then on the same command carries the round trip above.

The tool extracts the submitted `.xpi` itself, but not a source archive: those arrive in
too many formats for it to open, which is why that one extraction is the reader's.


## Where a review's files go

Every file a review creates - the linter's own, and each one an agent it instructs writes -
lives in one **work folder**, under a name that is the same in every review:

| Name | What it is | Written by |
| --- | --- | --- |
| `xpi/` | The shipped add-on, extracted (or, for an unpacked one, copied): `XPI_ROOT` | the linter, as the review starts |
| `sca/` | The source archive, extracted: `EXTRACT_TO`, holding `SCA_ROOT` | the reader of the `--llm-sca-review` prompt |
| `prepare.json` | Where the preparation of a source code review stands, and how its review is to be run - read-only, and hashed | the linter, at each step of the preparation |
| `state.json` | The review itself, which every pass reads | the linter |
| `review.json` | The file the agent fills in and hands back (`ANSWERS` while a source code review is prepared) | the linter, each pass |
| `report.md` | `REVIEW_REPORT` | the linter |
| `summary.md` | `ADDON_DESCRIPTION` | a sub-agent |
| `build.md` | `BUILD_PROCESS` | a sub-agent, in a source code review |
| `build/` | The copy of the source the agent builds in, never the archive itself | the agent, when the reviewer lets it build |
| `build-diff.md` | `BUILD_DIFF` | the agent, after building |
| `sweep-<artifact>.yaml` and `sweep-<artifact>.answers.json` | One tree's sweep request and answers | the linter, and a sweeping agent |

The folder is always `<add-on name>-<timestamp>` beside the add-on argument, named by the
run that starts the review: no flag names another. It must not exist: the run that starts a
review creates it, and an existing work folder is carried on by `--llm-handback` alone. The one review that starts in a folder already there is the one a preparation's
hand-back starts, in the folder that holds `prepare.json` and `sca/`. There every name the
review will create is checked to be free - `--llm-review` claims every name above except
`sca/` and `prepare.json`, since the agents it instructs write the rest later - and a name
already there ends the run with exit 2, naming it. A start that fails before the review exists
(a schema fetch that gets no answer, an audit that ends the review, an Experiment the command
does not say how to read) removes what it created, so it can be run again. The `--llm-handback`
passes rewrite `state.json`, `review.json` and `report.md` as the review moves on.

`--sca-root` must not include the add-on: the source is reviewed where it is, so the shipped
XPI, and the work folder created beside it, would be read as files of the source. Extract the
source archive into a folder of its own.

The caches are not part of it: they stay in `WEBEXT-LINTER-CACHE/`.


## Flags

| Option | Description |
| --- | --- |
| `--llm-review` | Run the review and print the first phase's prompt, instead of the report. The prompt names the file to fill in and the command that hands it back. Refused with `--report-format json`. |
| `--llm-handback <dir>` | Take a phase back and hand out the next, from the review file in the work folder the prompt named - the last being `close`, which hands over the settled review. Takes no add-on path: the review ran once, under `--llm-review`, and its result is in the state file in that folder. On a folder a source code review is being prepared in (`prepare.json`, and no review started), take the next step of the preparation instead, and once it is done, start its review. The only run that carries on an existing work folder. Normally run by the agent working through the review rather than by a person. |
| `--llm-sca-review` | Read the add-on argument as a submission FOLDER - one built `.xpi` and one archive of the source it was built from - print the first prompt for preparing a source code review of it, and exit without reviewing anything. It creates the review's work folder beside the `.xpi`, records there how the review is to be run, and its prompt ends in `--llm-handback` on that folder (see [Preparing a source code review](#preparing-a-source-code-review)). Refused beside any `--sca-*` flag, which is what the preparation works out. |
| `--llm-skip-summary` | With `--llm-review` or `--llm-sca-review`: leave out the add-on description. The prompt does not ask for one and names no file for it; nothing else about the review changes. |
| `--llm-skip-manual` | With `--llm-review` or `--llm-sca-review`: leave out the manual review items. No phase puts them to a reviewer - they stay in the report, for the reviewer to work through later, unless the review was aborted early, which takes them out. The two build questions are still asked. Given with `--llm-skip-summary`, the review verifies only the add-on's **code**. |
| `--llm-skip-sweep` | With `--llm-review` or `--llm-sca-review`: leave out the sweep. No sweeping agent is spawned, and the sweep is not handed to the reviewer either. |
