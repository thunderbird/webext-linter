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
deterministic review ran once, and nothing re-derives it. Both files sit in the hidden `.review/`
folder of the review's work folder (see [Where a review's files go](#where-a-reviews-files-go)).

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
| `build-safety` | Source code review only: write the build report (`BUILD_PROCESS`), with a safety section listing anything the build fetches or runs from outside the declared dependencies, and judge whether building is safe. Not where the review was prepared: it starts with the judgement and the build report its preparation recorded. | A process value: `safe` / `unsafe` |
| `build-result` | Show the Build Review Details block (see below) as the last thing of the turn, and hand back once the reviewer has replied. Where the reviewer builds themselves, this is the pause in which they build. | Nothing: the block is its whole work |
| `built` | Source code review only: ask the reviewer, alone, whether the source builds and reproduces the submitted XPI. Its first step says who built the add-on, by the build result. | `Builds and reproduces` / `Does not build or reproduce`, or the reviewer's own words |
| `spawn` | Start the sub-agents the review needs - the add-on description and one sweep per tree - and read back what the sweeps found. | Nothing: each sweep's reply is written to a file of its own (see below) |
| `verify` | Audit what the deterministic checks claimed. | `reported` / `withdrawn` |
| `settle` | Decide the cases a check could not settle from the package. | `reported` / `cleared` / `ask` |
| `details` | Hand the reviewer the Review Details block, before the `ask` questions, so only where `ask` follows: not under `--llm-skip-manual`. The block is the last thing of the turn, and the pass is handed back once the reviewer has replied. | Nothing: the block is its whole work |
| `ask` | Put to a reviewer what only a person can answer. | The reviewer's own answer |
| `close` | The last phase, once nothing else has work: hand over the settled review. It opens on whether the review is settled or was aborted, and says only what applies to it. | Nothing: the review ends with it |

A block the reviewer must read before answering (`build-result`, `details`) is shown by a pass of its own and ends the agent's turn. Text written before a
tool call in the same turn, a question or a hand-back, can be folded away by a client that
collapses tool rows, while the message that ends a turn stays in view. So each such pass
costs the reviewer one reply. The linter ends the block with the line `Reply "next" to
continue the review.`, so the reviewer sees the review waits for them.

A phase is issued only when it has **work** - steps that survive their markers, or
entries to settle - and that is also what ends the loop. So a review with no sweep never
mentions one, and a review that starts no sub-agent at all skips `spawn` and opens at the
first phase that has any. The package itself is not unpacked by any of this: the linter extracts a packed
submission, or copies an unpacked one, into the work folder's `xpi/` before the first
prompt is printed, and every phase reads that one folder.

Which steps a phase prints is decided by each step's `when:` condition: `AND`, `OR`, `NOT`
and parentheses over the facts of this run - the `--llm-skip-*` flags it was given,
`aborted` once a finding has aborted the review, `sca` for a source code review,
`build-guarded` when every check a build relies on ran, the build result (`agent-built`,
`agent-build-failed`, `build-unsafe` or `self-build`, exactly one of them),
`sweep-xpi` / `sweep-sca` for a tree with a sweep to run, `first` on the review's first
prompt, `spawned` once `spawn` went out, `decided` once `verify` or `settle` did, and
`closing` in the closing prompt. A step with no condition prints in every run, and a phase
left with no step is not issued. The preamble's parts are conditioned the same way. A wait
for spawned agents is a step of its own (`when: spawned AND ...`), carrying its phase's own
condition so that a wait alone never issues a phase. The registry spells each one
out, for example `details`' `NOT aborted AND NOT llm-skip-manual`, and refuses a
condition that does not parse or names a fact nothing answers.

A condition can also read a **process value** with `value(phase, id)`. A phase answering
`value` asks for one: an answer that steers the review and settles no item. It hands out
one entry offering the values the registry declares for it, each with a label and a
description, accepts only one of those labels, and records the value's id. So
`build-safety` prints under `NOT value(build-safety, safe) AND NOT value(build-safety,
unsafe)`, only where no judgement is held yet. The registry refuses a call naming a phase
that asks for no value, or an id that phase never returns. A value may `report` a check:
picking it adds that check's finding, which aborts the review like any finding of an
aborting check.

A source code review **opens with its build**, before the sweeps and the verify and settle
passes, so a source that does not build into the XPI ends the review before any of that
work is spent. The review builds nothing itself: the agent built the add-on in the
preparation, where it judged the build safe and the reviewer let it (see [Preparing a source
code review](#preparing-a-source-code-review)), and otherwise the reviewer builds it. The
review's build part is these steps:

1. **The review starts** with the source, the build judgement, the build result and output
   the preparation recorded.
2. **The deterministic checks run.** A source whose preparation gave its rescue up aborts
   here for build issues: `build-reproduces-xpi` is reported without a question, beside the
   vulnerability findings, which stay listed. A review that was **aborted early** never
   reaches the steps below - each one reads `NOT aborted`.
3. **`build-safety`**, only where nothing was prepared: the agent writes the build report
   and records its judgement, and builds nothing.
4. **`build-result`** shows the Build Review Details block as the last thing of the turn:
   `SUBMITTED_XPI`, `SCA_ROOT`, `BUILD_PROCESS`, `BUILD_SAFETY`, `BUILD_VULNERABILITIES`
   (`n moderate, n high, n critical`, the lock's vulnerable packages counted from the
   review's own audit, with no request of its own), `BUILD_RESULT` and, where the agent
   built it, `BUILD_OUTPUT`. `BUILD_RESULT` reads `built by the agent`, `the agent's build
   failed: see build.md`, `not built: judged unsafe` or `not built: you build it` (the
   reviewer did not let the agent build, or nothing was prepared).
5. **`built`** asks the reviewer alone whether the source builds and reproduces the
   submitted XPI. Its first step is worded by the build result (`agent-built`,
   `agent-build-failed`, `build-unsafe`, `self-build`).
6. **`Does not build or reproduce`**, or words the reviewer typed instead, aborts the review
   for build issues. **`Builds and reproduces`** goes on to `spawn`, `verify`, `settle`,
   `details`, `ask` and `close`.

These build steps run only where every check a build relies on ran (`build-guarded`): the
dependency-vulnerability checks, `lockfile-injection`, `lock-foreign-source` and
`build-registry-redirect` carry `build-guard` in the registry. With one of them switched off
by `--checks-only` / `--checks-skip`, nothing vouches for what an install pulls in, and the
review opens at the build question, of a build the reviewer makes.

`undeclared-build-source` and `build-lifecycle-hook` are still settled in `settle`, and
reported there they still abort the review.

The build question is in a phase of its own so it is put to the reviewer ALONE - `ask`
batches, and nobody may be asked to install an XPI in the same breath as being asked whether
the source builds into it. The check names its phase (`asked-in:` in the registry), the case
carries it, and the phase offers its own two answers (`choices`) in place of the manual
review's. A "no" aborts the review: that case becomes its finding, every `ask` question is
dropped, and the report ends on "Build process issues". The question is asked under
`--llm-skip-manual` too: it decides whether the review goes on, which is not what that flag
withholds.


## When the review is aborted early

Some findings settle the submission on their own, and carrying on would ask someone to do
work the review has already ruled out. The case it exists for: a source submission whose
dependency tree carries known high or critical advisories, where the very next thing the
loop would do is ask a reviewer to **reproduce the build** - running that tree on their own
machine, on the strength of a question the linter issued knowing better.

A check declares that it aborts the review by naming the reason the report gives
(`review-early-exit:` in the registry). Today seventeen do, across five reasons:
`experiment-not-allowed` names _Experiment APIs not accepted_, `lockfile-injection` names
_lock file entries that install another release_, the four
dependency-vulnerability checks name *known security vulnerabilities*, `banned-library`
names *disallowed library versions*, and the ten that decide a source submission cannot
be built from - `sca-package-file-missing`,
`sca-package-file-invalid`, `sca-lock-file-missing`, `sca-lock-file-invalid`,
`sca-lock-file-multiple`, `build-registry-redirect`, `lock-foreign-source`, `build-lifecycle-hook`,
`undeclared-build-source` and `build-reproduces-xpi` -
name *a build that cannot be reproduced*. The threshold is the finding's severity, so an advisory
that lands as a warning aborts nothing.

That threshold is also what lets `build-lifecycle-hook` carry the flag while it reports
nothing itself. It escalates its install hook to the agent, and an escalated case becomes a
finding of its own check only when the agent **reports** it, at that check's severity. So a
hook the agent clears aborts nothing, and neither does a review with no agent to judge it -
the review is aborted once someone has determined the hook fetches code.

What an aborted review does under `--llm-review`:

| | |
| --- | --- |
| A review the deterministic checks aborted | asks nothing at all: its first prompt is the `close` phase. Nothing is built, no agent is started (no description, no sweep), and nothing is verified or settled - every step before `close` carries `NOT aborted`. What it hands over is decided before any pass, so no pass could change it. |
| A review a pass aborted | (a case reported that aborts it, a build that did not reproduce) stops there: the phases that would follow are not issued, so nothing further is swept or put to a reviewer. |
| The hand-over | carries no to-do item: the tally counts none, and the Final Review Details name no file an agent was never asked to write. |
| The report | ends on the reason it is incomplete, one line per distinct cause. |
| The `close` phase | opens with a step of its own (`when: aborted`), because telling an agent "the review is settled" about one that was cut short is not true. The summary and the details that follow are the same. |

A finding that aborts the review is never put to the agent to verify, so no verdict takes it
back. That is also why a check that authors a sweep may not abort a review: a sweep's hints
are merged unverified, and the registry refuses a check that does both.

A review run without `--llm-review` is aborted on the same terms. A check that aborts it is
the last check that runs: nothing after it is checked, and nothing it would have needed is
computed. The printed report holds what the checks up to the abort found, drops every to-do
item a reviewer would have been **asked**, and keeps the code-review items those checks
authored, because reading code is safe.


## What an answer may say

What an entry's `"answer"` may say depends on WHO THE PHASE ASKS.

A phase the agent settles by reading the add-on takes one of the linter's verbs:
`verify` takes `reported` or `withdrawn`; `settle` takes `reported`, `cleared` or `ask` -
the last of which does not settle the case but sends it on to the reviewer, keeping its
reference.

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
only sub-agent whose output the linter reads. So it is the only one with a shape: a
request printed inline in the step that spawns it, and a reply the linter reads back from
a file of its own.

| | Written by | Format | Read back by |
| --- | --- | --- | --- |
| the request | the linter, inline in the `spawn` step | plain text | the sweeping agent |
| `.review/sweep-<artifact>.answers.json` | the orchestrating agent, from the sweeping agent's reply | JSON - one quoting rule, where a hint holding `http://host: thing` would break YAML | the linter |

The request stands alone, because the agent is handed it and nothing else. It names the
folder to read, says how to judge, lists each sweep under its label, and asks for the
answers as the reply:

```text
Sweep this folder, and read nothing outside it:

  /reviews/addon-1.2-<timestamp>/xpi/

It is asked about in 2 separate sweeps, each listed below under its label. ...

Label 9: Check the package for unacceptable content
Content shipped inside the package ...

Return your answers as your reply: one JSON document {"answers": {"<label>": [...]}} that
lists every label above ...
```

The reply is one JSON document with a list per label:

```json
{ "answers": { "9": [], "10": [] } }
```

`label` is the identity, and it is the **linter's**: unique across the whole review, so
the two answers files cannot collide and no agent is ever asked which request an answer
belongs to. It is also the number the report prints beside that sweep, so the page a reviewer
reads and the request an agent reads are the same list under the same numbers. Nothing of
the review's vocabulary reaches the agent - not a check id, not an artifact - because
where a hint lands is the review's to know.

A list per label is the whole answer. An empty list is "swept and clean", and a label left
out or answered with `null` is refused. That is what separates "found nothing" from "never
looked", and it is the agent's own statement rather than something inferred from silence.

The orchestrating agent relays and transcribes, and composes nothing. Each `spawn` step
hands one sub-agent its request as printed, waits for it, writes its reply unchanged to
the answers file the step names, and hands back a review file whose `entries` are empty.
The linter reads only that file, and refuses one it cannot act on, naming what to fix.

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
It never says WHERE - that is the linter's, named in the request - and it never says
what confirming something means, which is the owning check's to say.

Either way the case is deduplicated against what the deterministic pass already covered
in that same tree, as a to-do item or as a finding, so nothing downstream can tell a swept
case from one a check found. The `hint` is a locus annotation naming what sits at that line; the paragraph
the developer reads stays the registry's.

`--llm-skip-sweep` withholds all of this: no request is made, the prompt spawns no
sweeping agent, and the sweep is left out of the review - it is not handed to the
reviewer, in the prompt or in the report.


## What the reviewer is handed

Before the `ask` questions, the reviewer is handed a **Review details** block naming
what this review is and where to read it:

| Name | What it names |
| --- | --- |
| `XPI_FILE` | What was submitted, by name - the .xpi as ATN named it, or the folder's own name where the submission arrived unpacked |
| `XPI_ROOT` | The shipped package, unpacked, ready to read |
| `SCA_ROOT` | A source code review's source root - the whole of which is reviewed - labelled "source archive" in `sca/`, or "rescued source (reduced/fixed dependencies)" where a rescue came out clean and the root lies in `rescued/` |
| `SCA_ROOT_ORIG` | The same root in `sca/`, the source as submitted - only after a rescue, since it is `SCA_ROOT` otherwise |
| `SCA_EXP_SOURCE` | The Experiment implementation folder, when one was named |
| `ADDON_DESCRIPTION` | Where a sub-agent wrote a description of the add-on, for reading while answering |
| `BUILD_PROCESS` | What building the add-on takes and whether it is safe, written by the agent in `build-safety`, in a source code review |
| `BUILD_ROOT` | The root in `build/`, where the agent's build ran - only where the agent built or tried to |
| `BUILD_OUTPUT` | What the agent's build produced in the preparation, a file or a folder inside `build/`, named by its own name - only where the agent built it, since the reviewer may build it themselves and a build may fail |
| `REVIEW_REPORT` | The text the reviewer sends to the developer, written by the linter |

The linter names these files and reads none of them. The description is a sub-agent's,
returned as its reply, and the agent conducting the review is told only to write that reply
unchanged to `ADDON_DESCRIPTION` - not to read, summarise or print it. The build report and the build output are the agent's own, and
the Build Review Details block names them beside the submitted XPI and the source root the
review read, right before the build question.

`REVIEW_REPORT` it writes itself: as the `details` phase goes out, where one does, so the
reviewer can read the report while answering the questions that follow, and again from the settled review
once those answers are in. It is a file rather than something the agent prints because
printing it failed - the hand-over used to carry the report and ask for it back "in a code
block and unchanged", and that is the one text where a model rewording its input reaches the
developer.

The block is handed over twice, for two different readings. The `details` phase hands it
over before the `ask` questions, so the reviewer can open those files while answering, and
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
source it was built from - and reviewing it needs two `--sca-*` arguments that nobody can
write without opening that archive. `--llm-sca-review` reads the add-on
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

An add-on whose Experiment the review would reject is not prepared at all: the review
rejects it from the `.xpi` alone, before it reads any source. Without `--allow-experiments`,
`--llm-sca-review` first asks the Experiment verdict of the `.xpi`, by the rule the review
itself asks it by, and where the verdict rejects, it starts that review at once instead of
printing the preparation's prompt. That review is the one `--llm-review` of the `.xpi`
starts: `experiment-not-allowed` aborts it, so its first prompt is the `close` phase.

Where the archive is extracted and where its build runs are two different places, which is
why `EXTRACT_TO` is not `<SCA_ROOT>`: an archive that carries its contents in a directory
of its own puts the build files a level below the destination. The review does not depend
on that being answered correctly - handed a root with no `package.json` and one subfolder
that has one, it settles the root itself before reading anything (`src/addon/sca-root.js`)
and says so in its Setup feed.

The same prompt has its reader **judge the build**. It writes the build report to
`BUILD_PROCESS` (the work folder's `build.md`): the release build for Thunderbird as a short
numbered list, its install step as `npm ci` or `pnpm install --frozen-lockfile --config.strict-dep-builds=false`, and a
"Safety" section listing anything the build fetches or runs from outside the declared
dependencies. It runs nothing. Then it answers the `BUILD_SAFETY` entry of `ANSWERS` with
`safe` or `unsafe`, the same two values the review's `build-safety` phase accepts.

The reader hands the roots and the judgement back in the work folder's review file (`ANSWERS`, the same
`.review/review.json` a review pass uses) and runs `--llm-handback` on the folder. The preparation's
own record, `.review/prepare.json`, says where it stands, so every step is that one command. The
reader never chooses what comes next. A root outside `sca/`, an Experiment folder outside
the root, a judgement that is not one of the two labels, or a missing `build.md` is refused,
and the reader corrects it and hands it back again.

That hand-back settles the roots as the review would, and records the judgement:

- **Unsafe:** the folder is done at once. Nothing is audited or rescued, and the agent builds
  nothing, so a vulnerable lock aborts the review it starts.
- **Safe:** the next prompt (`permission`) has the reader show the reviewer the **Build
  Review Details** (the source root, `build.md` and the judgement) as the last thing of its
  turn, ending with `Reply "next" to continue the review.` Once the reviewer has replied, it
  puts them one question alone, through its question tool: the `PACKAGE_MANAGERS` entry,
  "Let the agent build the add-on (including its package-manager commands), or not?". The
  reader records the label the reviewer picked, `Let it build` or `Do not let it build`, and
  any other answer is refused. `--llm-agent-builds` answers it up front with `Let it build`:
  that prompt is skipped. Not letting it build, the folder is done at once, as after an
  unsafe judgement.

Where the agent may not build, the review's Build Review Details say `not built: you build
it` (`self-build`), or `not built: judged unsafe` after an unsafe judgement, and the `built`
question is asked of the reviewer's own build. Every prepared review starts with the recorded judgement as its `build-safety`
value and `build.md` as that phase's report, so it does not ask for them again.

Where the reviewer let the agent build, the hand-back **audits the root's lock**
(`src/prepare/audit.js`): every package it installs, against OSV and the policy blocklist,
exactly as the review's own dependency audit reads it. Before that it asks whether every
registry entry installs the release it names (`lockfile-injection`'s question): a lock that
names one release and installs another is not audited at all, since what OSV would be asked
about is not what the build installs. Nothing else is judged here - another reason to stop, an Experiment, `--checks-*`, the band policy: all of that stays with
the review. The record keeps the audited lock's vulnerable packages counted by severity
(moderate, high, critical). The outcomes:

- **The audit cannot read the lock in full** (no lock, one that does not parse, more than one
  lock, an entry from a source the audit cannot read, an entry that installs another release
  than it names): the folder is done, nothing is built, and the same hand-back starts its
  review, which stops on that lock.
- **The lock is clean**: the linter copies the whole `sca/` into the work folder's `build/`,
  and the next prompt (`build`) has the reader build in `BUILD_ROOT`, `SCA_ROOT`'s place in
  that copy, as `BUILD_PROCESS` describes, installing exactly what the lock pins (`npm ci` or
  `pnpm install --frozen-lockfile --config.strict-dep-builds=false`). A build that writes
  next to its root still writes inside `build/`. It answers the `BUILD_OUTPUT` entry with the
  final artifact the build produced inside `build/` (an XPI or zip file, or a folder), as an
  absolute path, or with `The build failed`, after adding a "Build attempt" section (the
  failing step and its error output) to `build.md`. An output that is not inside `build/` is
  refused. Either answer is recorded, and the folder is done.
- **The lock installs a package with a known high or critical advisory**: the linter copies
  the whole `sca/` into `rescued/` in the same work folder, and the next prompt (`rescue`)
  hands the copy to the reader as one **autonomous loop**. It reduces the copy's
  dependencies to what the release build uses, or applies the package manager's audit fix,
  and refreshes the lock with lock-only commands and `--ignore-scripts`, so only
  `package.json` and the lock change in `rescued/`. It runs `npm audit` or `pnpm audit`, and
  builds nothing while a high or critical advisory remains. Once none does, it replaces
  `build/` with a copy of the whole `rescued/` (the two commands the prompt prints), installs
  as the lock pins and builds in `BUILD_ROOT`, the root's place in that copy. Nothing is ever
  installed or built in `rescued/`. Where the build fails it adjusts the dependencies in
  `rescued/` and audits and copies again before the next build: a `prepare` script that runs
  `husky`, for one, needs the husky the trimming removed, or the script removed. It answers
  `BUILD_OUTPUT` with the final artifact the build produced inside `build/`, or with
  `The rescue failed`.
  The hand-back then audits the copy's lock itself and checks that output. Where both hold,
  the copy is reviewed instead of the original, and its counts replace the original's. A copy
  whose lock names one release and installs another is not clean.
- **The rescue failed** (the reader said so, the copy is still vulnerable, or the output is
  not inside `build/`): the copy and `build/` are deleted, the record says the rescue failed, and the
  original is reviewed, **unrescued**: its vulnerability checks come early in the review,
  the first of them to report a vulnerable lock entry stops the checks, and the review is
  aborted for build issues too (`build-reproduces-xpi`, asked of nobody), its vulnerability
  findings listed. It closes as any aborted review does. Its audit of the lock asks OSV
  nothing the preparation already asked: every audit of the run reads OSV's answers from
  `.cache/osv.json` in the work folder.

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

### Permissions

Claude Code's auto mode may stop a command it was not told to expect. These allow rules
let the linter's own commands run without that:

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


## Where a review's files go

Every file a review creates - the linter's own, and each one an agent it instructs writes -
lives in one **work folder**, under a name that is the same in every review. The top of the
folder is what the reviewer reads. The files the linter and its agent pass between them to run
the review sit in its hidden `.review/` folder, out of the reviewer's sight:

| Name | What it is | Written by |
| --- | --- | --- |
| `xpi/` | The shipped add-on, extracted (or, for an unpacked one, copied): `XPI_ROOT` | the linter, as the review starts |
| `sca/` | The source archive, extracted: `EXTRACT_TO`, holding `SCA_ROOT` | the reader of the `--llm-sca-review` prompt |
| `rescued/` | The copy of the whole `sca/` a rescue changes the dependencies of (`RESCUE_ROOT` lies inside it), only its `package.json` and lock, never installed or built in: reviewed instead when the rescue comes out clean, and removed when it fails | the linter, and the reader of the `rescue` prompt |
| `.review/prepare.json` | Where the preparation of a source code review stands, and how its review is to be run - read-only, and hashed | the linter, at each step of the preparation |
| `.review/state.json` | The review itself, which every pass reads | the linter |
| `.review/review.json` | The file the agent fills in and hands back (`ANSWERS` while a source code review is prepared) | the linter, each pass |
| `report.md` | `REVIEW_REPORT` | the linter |
| `summary.md` | `ADDON_DESCRIPTION` | the agent, from a sub-agent's reply |
| `build.md` | `BUILD_PROCESS` | the agent, in `build-safety`, in a source code review |
| `build/` | Where every build of the preparation runs (`BUILD_ROOT` lies inside it), holding `BUILD_OUTPUT`: a copy of the whole `sca/` for a clean source, or of the whole `rescued/` before each build of a rescue, and removed when the rescue fails | the linter for a clean source, the reader of the `rescue` prompt for a rescue |
| `.review/sweep-<artifact>.answers.json` | One tree's sweep answers | the agent, from a sweeping agent's reply |
| `.cache/osv.json` | What OSV answered during this run, so no later invocation of the run asks again | the linter, whenever it audits |
| `.cache/popularity.json` | The npm download counts and GitHub stars read during this run, kept the same way | the linter, whenever it judges a source's popularity |

The folder is always `<add-on name>-<timestamp>` beside the add-on argument, named by the
run that starts the review: no flag names another. It must not exist: the run that starts a
review creates it, and an existing work folder is carried on by `--llm-handback` alone. The one review that starts in a folder already there is the one a preparation's
hand-back starts, in the folder that holds `.review/prepare.json` and `sca/`. There every name the
review will create is checked to be free - `--llm-review` claims every name above except
`sca/`, `rescued/`, `build/` and `.review/prepare.json`, the preparation's, since the agents it
instructs write the rest later - and a name
already there ends the run with exit 2, naming it. A start that fails before the review exists
(a schema fetch that gets no answer, an audit that ends the review, an Experiment the command
does not say how to read) removes what it created, so it can be run again. The `--llm-handback`
passes rewrite `.review/state.json`, `.review/review.json` and `report.md` as the review moves on.

`--sca-root` must not include the add-on: the source is reviewed where it is, so the shipped
XPI, and the work folder created beside it, would be read as files of the source. Extract the
source archive into a folder of its own.

The caches are not part of it: they stay in `WEBEXT-LINTER-CACHE/`.


## Flags

| Option | Description |
| --- | --- |
| `--llm-review` | Run the review and print the first phase's prompt, instead of the report. The prompt names the file to fill in and the command that hands it back. Refused with `--report-format json`. |
| `--llm-handback <dir>` | Take a phase back and hand out the next, from the review file in the work folder the prompt named - the last being `close`, which hands over the settled review. Takes no add-on path: the review ran once, under `--llm-review`, and its result is in the state file in that folder. On a folder a source code review is being prepared in (`.review/prepare.json`, and no review started), take the next step of the preparation instead, and once it is done, start its review. The only run that carries on an existing work folder. Normally run by the agent working through the review rather than by a person. |
| `--llm-sca-review` | Read the add-on argument as a submission FOLDER - one built `.xpi` and one archive of the source it was built from - and print the first prompt for preparing a source code review of it. It creates the review's work folder beside the `.xpi`, records there how the review is to be run, and its prompt ends in `--llm-handback` on that folder (see [Preparing a source code review](#preparing-a-source-code-review)). Refused beside any `--sca-*` flag, which is what the preparation works out. |
| `--llm-agent-builds` | With `--llm-sca-review`: answer the preparation's build question up front with `Let it build`, so it is not put to the reviewer. Where the agent judges the build safe, it may then build the add-on, its package-manager commands included. Recorded with the preparation's flags. Refused without `--llm-sca-review`, the one run that asks it. |
| `--llm-skip-summary` | With `--llm-review` or `--llm-sca-review`: leave out the add-on description. The prompt does not ask for one and names no file for it; nothing else about the review changes. |
| `--llm-skip-manual` | With `--llm-review` or `--llm-sca-review`: leave out the manual review items. No phase puts them to a reviewer - they stay in the report, for the reviewer to work through later, unless the review was aborted early, which takes them out. The build question is still asked. Given with `--llm-skip-summary`, the review verifies only the add-on's **code**. |
| `--llm-skip-sweep` | With `--llm-review` or `--llm-sca-review`: leave out the sweep. No sweeping agent is spawned, and the sweep is not handed to the reviewer either. |
