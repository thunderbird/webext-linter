# LLM review

The linter can hand its review to an LLM agent instead of printing it. The agent does
the reading a person would otherwise do - auditing each finding, settling the cases the
scans could not, putting the rest to a reviewer - and the linter stays the one deciding
what is asked, in what order, and what an answer is allowed to say.

This is the long-form version; the [README](../README.md) carries the summary and the
flags in the context of every other option.

- [The round trip](#the-round-trip)
- [The phases](#the-phases)
- [When the review is aborted](#when-the-review-is-aborted)
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
| `built` | Source code review only: show the Build Review Details block (see below) as the last thing of the turn, then, once the reviewer has replied, relay the build to-do (`build-reproduces-xpi`) to them alone as the question. Where the reviewer builds themselves, the pause after the block is the one in which they build. A step says who built the add-on, by the build result, and the agent builds and compares nothing. Issued only while that to-do is open, which is where the reviewer held the build safe in the preparation. | A process value: `Builds and reproduces` / `Does not reproduce` / `Does not build` |
| `spawn` | Start the sub-agents the review needs - the add-on description and one sweep per tree - and read back what the sweeps found. | Nothing: each sweep's reply is written to a file of its own (see below) |
| `verify` | Audit what the deterministic checks claimed, but never a finding of a check with `llm-verification: false`: a person's decision or a fact from outside the add-on. | `reported` / `withdrawn` |
| `settle` | Decide the cases a check could not settle from the package. | `reported` / `cleared` / `ask` |
| `ask` | Show the Review Details block as the last thing of the turn, then, once the reviewer has replied, put to them what only a person can answer. | The reviewer's own answer |
| `downgrade` | Source code review only, aborted only by checks a review of the XPI alone cures, with a readable XPI (`downgradable`): show the aborted review's Summary and Final Review Details as the last thing of the turn, then, once the reviewer has replied, ask them alone whether to restart as an XPI review (see [Restarting as an XPI review](#restarting-as-an-xpi-review)). | A process value: `Restart as an XPI review` / `Keep this result` |
| `close` | The last phase, once nothing else has work: hand over the settled review. It opens on whether the review is settled or was aborted, and says only what applies to it. | Nothing: the review ends with it |

A block the reviewer must read before answering is the first step of the question phase
that needs it (`built`, `ask`, `downgrade`), and ends the agent's turn. Text written before a tool call
in the same turn, a question or a hand-back, can be folded away by a client that collapses
tool rows, while the message that ends a turn stays in view. So the step tells the agent
to end its turn on the block and to go on with the question only once the reviewer has
replied, and nothing is handed back in between. The linter ends the block with the line
`Reply "next" to continue the review with` and what the reply leads to (for `built`, `the
question whether the source builds and reproduces the submitted XPI.`), so the reviewer
sees the review waits for them and what comes next. The registry refuses a turn-ending
phase whose first step, past a wait for spawned agents, shows no block, and one with no
`next` entry in `waiting`.

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
`agent-build-failed`, `rescue-failed`, `build-unsafe` or `self-build`, exactly one of them),
`sweep-xpi` / `sweep-sca` for a tree with a sweep to run, `first` on the review's first
prompt, `spawned` once `spawn` went out, `decided` once `verify` or `settle` did,
`downgradable` for a halted source review that may restart as an XPI review, and `closing`
in the closing prompt. A step with no condition prints in every run, and a phase
left with no step is not issued. The preamble's parts are conditioned the same way. A wait
for spawned agents is a step of its own (`when: spawned AND ...`), carrying its phase's own
condition so that a wait alone never issues a phase. The registry spells each one
out, for example `ask`'s `NOT aborted`, and refuses a
condition that does not parse or names a fact nothing answers.

A condition can also read a **process value** with `value(phase, id)`. A phase answering
`value` asks for one: an answer that steers the review and settles no item. It hands out
one entry offering the values the registry declares for it, each with a label and a
description, accepts only one of those labels, and records the value's id. So a step
reading `value(built, reproduces)` prints only once the reviewer has said the source
builds and reproduces the XPI. The registry refuses a call naming a phase
that asks for no value, or an id that phase never returns. A value may itself carry a
`when:`, read with the same facts: it is offered only where its condition holds, and an
answer that was not offered is refused when it comes back. The registry checks it as it
checks a step's, and refuses a phase that offers every value under a condition. A value may
`report` a check:
picking it adds that check's finding, which aborts the review like any finding of an
aborting check. The finding is the person's answer, so its check says
`llm-verification: false` and it is never put to verify. A value phase a check asks its question in (`asked-in`) relays that open
to-do's message as its question, worded as `ask` words it, and is issued only while the
to-do is open. Any answer clears the to-do, so a value that reports a check leaves that
check's finding as the one finding. A value phase no check routes a to-do to asks the
`question:` it authors itself, and is issued once.

A source code review **opens with its build**, before the sweeps and the verify and settle
passes. A source that does not build into the XPI, or that the reviewer declines to build,
aborts the review late: the passes still run, so the developer is told everything in one
round, and nobody is asked to install the add-on. The review builds nothing itself: the agent built the add-on in the
preparation, where the reviewer let it (see [Preparing a source
code review](#preparing-a-source-code-review)), and otherwise the reviewer builds it. The
review's build part is these steps:

1. **The review starts** with the source, the build judgement, the build result and output
   the preparation recorded.
2. **The deterministic checks run.** A review that was **aborted early** (a rejected
   Experiment, a forged lock) never reaches the steps below - each one reads `NOT aborted`.
   Nor does a source no build can be made from (`unbuildable`, which each one reads too): a
   finding of a check marked `review-unbuildable` (no usable package.json, or no single
   readable lock) stands, or the preparation gave its rescue up. Such a review goes straight
   on to `spawn`, and its findings abort it late.
3. **`built`** first shows the Build Review Details block as the last thing of the turn:
   `XPI_FILE`, `XPI_ROOT`, `SCA_SOURCE`, `SCA_BUILD_PROCESS`, `SCA_BUILD_SAFETY_ASSESSMENT`,
   `SCA_VULNERABILITIES` (`n moderate, n high, n critical`, the submitted lock's vulnerable
   packages as the preparation counted them, or the review's own audit where it counted
   none), and, where the agent built it, `SCA_BUILD`, `LLM_BUILD_OUTPUT`, `LLM_BUILD_RESULT`
   and `LLM_BUILD_XPI_MATCH` (`match` or `no match`, the agent's comparison
   of that output with the submitted XPI in the preparation). `LLM_BUILD_RESULT` reports the
   agent's attempt only: `build succeeded`, `build failed: see build.md`, `not built: rescue
   failed` or `not built: unsafe`. It is absent where the reviewer builds the add-on
   (`self-build`: the reviewer did not let the agent build). A
   failed rescue leaves nothing to build and skips this phase, so only the Final Review
   Details show `not built: rescue failed`.
4. Once the reviewer has replied, **`built`** asks them alone to build the add-on from the
   source and compare the result with the submitted XPI, relaying the `build-reproduces-xpi`
   to-do as the question. The step before the question is worded by the build result
   (`agent-built`, `agent-build-failed`, `self-build`), and tells the agent it builds and
   compares nothing: where it built, the reviewer reads its earlier comparison,
   `LLM_BUILD_XPI_MATCH`, beside `LLM_BUILD_OUTPUT` and `XPI_FILE`. It asks the outcome only:
   whether the build is safe was the reviewer's decision in the preparation. `built` relays
   `build-reproduces-xpi`, which runs only where that decision held the build safe
   (`when: build-judged AND build-safe`), so a build held unsafe is never asked about: it is
   reported by `build-unsafe`, with the reviewer's reasons where they gave some, and aborts the
   review late.
5. **`Does not reproduce`** and **`Does not build`** report `build-not-reproduced` and
   `build-fails`, which abort the review late for
   build issues, with that check's response telling the developer why: the review goes on to
   `spawn`, `verify` and `settle`, and then closes aborted. **`Builds and reproduces`** goes
   on to `spawn`, `verify`, `settle`, `ask` and `close`. Any other answer is refused, and the
   question is asked again.

These build steps run only where every check a build relies on ran (`build-guarded`): the
dependency-vulnerability checks, `lockfile-injection`, `lock-foreign-source` and
`build-registry-redirect` carry `build-guard` in the registry. With one of them switched off
by `--checks-only` / `--checks-skip`, nothing vouches for what an install pulls in: the
preparation asks nobody about the build and the agent builds nothing, so nobody decided
about it (`NOT build-judged`). Then there is no build phase at all. `build-review` asks the
whole build question in `ask`, with the other manual questions: whether the build uses only
the declared dependencies, and only then whether it builds and reproduces the submitted XPI.
Its own answers are `Builds fine and reproduces`, which clears it, `Build issues`, which
reports it, or the reviewer's own words, which report it with those words attached. A plain
report lists the same question under Extended Manual Review.

`build-lifecycle-hook` is still settled in `settle`, and reported there it still aborts the
review.

The build question is in a phase of its own so it is put to the reviewer ALONE - `ask`
batches, and nobody may be asked to install an XPI in the same breath as being asked whether
the source builds into it. The check names its phase (`asked-in:` in the registry), the case
carries it, and the phase relays it with its own three answers (`values`) in place of the
manual review's. Every answer clears the case, and each of the two that stop the review
reports its own check (`reports`), so the developer is told why: the passes still run, every
`ask` question is dropped, and the report ends on "Build process issues".


## When the review is aborted

Some findings settle the submission on their own. The review is then aborted rather than
asking anyone to carry on with it - above all, before anyone is asked to install or test the
add-on.

A check declares that it aborts the review by naming the reason the report gives, under one
of two keys in the registry. Twenty-three do, across seven reasons:
`experiment-not-allowed` names _Experiment APIs not accepted_, `lockfile-injection` names
_lock file entries that install another release_, `sca-xpi-fully-included-in-archive` names
_source archive contains the built XPI_, the four dependency-vulnerability checks name
*known security vulnerabilities*, `banned-library` names *disallowed library versions*,
`minified-code` and `untrusted-minified-library` name *code that cannot be reviewed*, and the
thirteen that decide a source submission cannot be built from - `sca-package-file-missing`,
`sca-package-file-invalid`, `sca-lock-file-missing`, `sca-lock-file-invalid`,
`sca-lock-file-multiple`, `build-registry-redirect`, `lock-foreign-source`,
`build-lifecycle-hook`, `build-review`, `build-reproduces-xpi`,
`build-not-reproduced`, `build-fails` and `build-unsafe` - name *build process issues*. The
threshold is the finding's severity, so an advisory that lands as a warning aborts nothing.

That threshold is also what lets `build-lifecycle-hook` abort a review while it reports
nothing itself. It escalates its install hook to the agent, and an escalated case becomes a
finding of its own check only when the agent **reports** it, at that check's severity. So a
hook the agent clears aborts nothing, and neither does a review with no agent to judge it -
the review is aborted once someone has determined the hook fetches code.

When each kind decides:

| | |
| --- | --- |
| Late (`review-late-exit`), the default | Once only `ask` and `close` are left. Every check runs, and `built`, `spawn`, `verify` and `settle` run as usual. Then `ask` is skipped, and `close` closes the aborted review with the reasons. The developer is told everything in one round. |
| Early (`review-early-exit`) | The moment the error stands. Only `experiment-not-allowed` and `lockfile-injection` do this: a submission refused whatever its code says, and a forged lock every later reading would take at its word. A deterministic check that reports it stops the checks there, and the loop closes on its first prompt: nothing is built, no agent is started, and nothing is verified or settled - every step before `downgrade` carries `NOT aborted`. |

Since verify runs first, a late-exit finding verify **withdrew** does not stand and aborts
nothing: the questions are asked and the review closes settled. A finding a person's answer
added (a `built` answer) is never put to verify, so no verdict takes it back. A late-exit
check may author a sweep, as it is judged after the sweeps. An early abort verifies nothing,
so a check that authors a sweep may not abort a review early: a sweep's hints are merged
unverified, and the registry refuses a check that does both. Every early-exit check also
comes before every late-exit one, so no late finding is counted unverified by an early abort.
The registry holds both kinds to the same other terms: severity `error` or `auto`, a reason
`review-early-exit` defines, and never both keys on one check.

What an aborted review hands over under `--llm-review`:

| | |
| --- | --- |
| The hand-over | carries no to-do item: the tally counts none, and the Final Review Details name no file an agent was never asked to write. |
| The report | ends on the reasons it is incomplete, one line per distinct cause. |
| The `close` phase | opens with a step of its own (`when: aborted`), because telling an agent "the review is settled" about one that was cut short is not true. The summary and the details that follow are the same, and where `downgrade` already showed them, they are not shown again. |

A review run without `--llm-review` is aborted on the same terms. It has no pass to wait for,
so a late-exit error aborts it at its end. An early-exit check is the last check that runs:
nothing after it is checked, and nothing it would have needed is computed. Either way the
printed report drops every to-do item a reviewer would have been **asked**, and keeps the
code-review items, because reading code is safe.

### Restarting as an XPI review

A source code review is often submitted for an add-on whose XPI could be reviewed on its own,
and then aborts for a fault of the archive: a copy of the XPI with no `package.json`, or a
build that cannot run. An aborting check of the source archive can say that a review of the
XPI alone cures its finding (`review-downgrade: true` in the registry): the
`sca-xpi-fully-included-in-archive`, `sca-package-file-*` and `sca-lock-file-*` checks,
`build-registry-redirect`, `lock-foreign-source`, `build-lifecycle-hook`,
`build-review`, `build-reproduces-xpi`, `build-not-reproduced`, `build-fails`,
`build-unsafe`, `lockfile-injection`, `vendor-vulnerable-dev` and
`vendor-vulnerable-indirect-dev`. `vendor-vulnerable-indirect` carries no marker, as it reports
code the XPI ships. The registry refuses the marker on a check that aborts nothing, and on one
whose `input` is not `sca` or `all`.

After its checks, a source review under `--llm-review` asks the classifiers whether the XPI
could be reviewed on its own: no file or inline script in it is minified first-party code,
obfuscated, or an untrusted minified library. Asked directly, so a review aborted before any
check read the XPI is answered too. The verdict per file goes to the feed, and the answer is
recorded as `xpi-reviewable` in the state. A review is `downgradable` when it is a source
review, its XPI is reviewable, it is halted (early or late), and every check whose finding
aborts it carries the marker. A review that did not abort is never asked.

Then `downgrade` goes out before `close`. It shows the aborted review's Summary and Final
Review Details, settled as `close` settles them and ending on the abort reasons, as the last
thing of the turn, with the waiting line naming the question that follows. Once the reviewer
has replied, it asks them alone: _The SCA review failed for build process issues, but it looks
like this submission does not actually need an SCA review. The XPI is not minified and could
be reviewed directly. Should the review be restarted as a pure XPI review?_, naming every
abort reason.

- **`Keep this result`** goes on to `close`, which opens with its aborted line and shows the
  Summary and the Final Review Details no second time.
- **`Restart as an XPI review`** makes the hand-back start the XPI review itself, the way a
  finished preparation starts its review: the submitted XPI, with the flags the source review
  was started with (recorded in its state, without any `--sca-*` flag), in a new
  `xpi-review-*` work folder beside it. Its first prompt is that hand-back's output. The source
  review's folder stays as it is, aborted. The XPI review carries the `sca-not-needed` finding
  (info), which tells the developer to submit just the XPI next time. If the XPI review fails
  as well, the reviewer judges which of the two reports to send.


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
folder, has every line of every file in it read (`reading-rule`), says how to judge, lists
each sweep under its label, and asks for the answers as the reply:

```text
Sweep this folder, and read nothing outside it:

  /reviews/xpi-review-addon-1.2-<timestamp>/xpi/

Read every file in the folder above in full, every line of it, before you answer: ...

It is asked about in 2 separate sweeps, each listed below under its label. ...

Label 9: Check the package for unacceptable content
Content shipped inside the package ...

Return your answers as your reply, as one JSON document of this shape:

  {"answers": {"<label>": [...]}}

It lists every label above, ...
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
what this review is and where to read it. Every details block is built from the same rows,
so each holds every row of the block before it, plus what is new:

- the preparation's **Build Review Details** (the `permission` prompt): `XPI_FILE`,
  `SCA_SOURCE`, `SCA_EXPERIMENTS` where one is named, `SCA_BUILD_PROCESS`,
  `SCA_BUILD_SAFETY_ASSESSMENT` and `SCA_BUILD_SAFETY_ISSUES`;
- the review's **Build Review Details** (`built`): every row below the review holds, but
  `ADDON_DESCRIPTION` and `REVIEW_REPORT`, since `built` goes out before the description
  agent and the report;
- the **Review Details** (`ask`): every row the review holds;
- the **Final Review Details** (`close`): every row the review holds, and the reasons where
  the review was aborted.

A row the review does not hold is left out: the build rows appear only in a source code
review whose build every guard vouches for (`build-guarded`), and `SCA_VULNERABILITIES` in
every source code review whose lock was audited.

The rows are grouped by prefix and sorted by name within each group, in the table's order.
`XPI_` and `SCA_` rows describe the submission: the build report and its safety assessment
are about how the source builds, whoever wrote them. `LLM_` rows are what the agent's own
build attempt produced. `ADDON_DESCRIPTION` and `REVIEW_REPORT`, which only the later blocks
carry, come last.

| Name | What it names |
| --- | --- |
| `XPI_FILE` | What was submitted, a link named by what it was submitted as - the .xpi as ATN named it, or the folder's own name where the submission arrived unpacked |
| `XPI_ROOT` | The shipped package, unpacked, ready to read |
| `SCA_SOURCE` | A source code review's copy of the submitted source, the work folder's `sca/`, which every review works on rather than the folder it was given - the folder every path is relative to, unless the review read a rescued copy |
| `SCA_RESCUED` | The rescued copy the review read instead, `rescued/`, labelled "rescued source (reduced/fixed dependencies)" - only where a rescue came out clean |
| `SCA_BUILD_PROCESS` | What building the add-on takes, written by the agent in the preparation, in a source code review |
| `SCA_BUILD_SAFETY_ASSESSMENT` | The verdict the preparation read off the build's safety issues: `safe` where there are none, `unsafe` otherwise |
| `SCA_BUILD_SAFETY_ISSUES` | What the build reaches for outside the declared dependencies, one line per issue, as the agent handed it back and the linter wrote it |
| `SCA_EXPERIMENTS` | The Experiment implementation folder, when one was named |
| `SCA_BUILD` | The copy of the source in `build/` the agent's build ran in - only where the agent built or tried to |
| `SCA_VULNERABILITIES` | The submitted lock's vulnerable packages, as `n moderate, n high, n critical`: the preparation's first audit, or where nothing was audited there the review's own, held once any dependency-vulnerability check read the lock |
| `LLM_BUILD_OUTPUT` | What the agent's build produced in the preparation, a file or a folder inside `build/`, named by its own name - only where the agent built it, since the reviewer may build it themselves and a build may fail |
| `LLM_BUILD_RESULT` | What came of the agent's attempt: `build succeeded`, `build failed: see build.md`, `not built: rescue failed` or `not built: unsafe` - absent where the reviewer builds the add-on |
| `LLM_BUILD_XPI_MATCH` | The agent's comparison of `LLM_BUILD_OUTPUT` with the submitted XPI in the preparation: `match` (the same files at the same paths with the same contents, only line endings may differ) or `no match` - only beside `LLM_BUILD_OUTPUT` |
| `LLM_RESCUED_VULNERABILITIES` | The rescued copy's vulnerable packages, as the linter's audit at the rescue's hand-back counted them, whether the rescue came out clean or failed - only where a rescue was attempted and its lock could be read in full |
| `ADDON_DESCRIPTION` | Where a sub-agent wrote a description of the add-on, for reading while answering |
| `REVIEW_REPORT` | The text the reviewer sends to the developer, written by the linter |

The linter names these files and reads none of them. The description is a sub-agent's,
given the extracted XPI (`XPI_ROOT`) to read in full and describe, nothing outside it, returned as its
reply, and the agent conducting the review is told only to write that reply
unchanged to `ADDON_DESCRIPTION` - not to read, summarise or print it. The build report and the build output are the agent's own, and
the Build Review Details block names them beside the submitted XPI and the source the review
read, right before the build question.

`REVIEW_REPORT` it writes itself: as the `ask` phase goes out, where one does, so the
reviewer can read the report while answering the questions that follow, and again from the settled review
once those answers are in. It is a file rather than something the agent prints: a model asked
to print a text unchanged rewords it, and this is the one text where that rewording reaches the
developer.

The block is handed over twice, for two different readings. The `ask` phase hands it
over before its questions, so the reviewer can open those files while answering, and
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
`REVIEW_REPORT` among them, and nothing of what is in any of them). Where the review was aborted,
the reasons close that block, because only the block can list what aborted this
review. Nothing is handed back after `close`: it carries no hand-back step, and a hand-back
is refused.


## Preparing a source code review

A source code submission arrives as two files - the built `.xpi` and an archive of the
source it was built from - and no review of the source is possible until someone has read
it and worked out its build. Two runs start that preparation, and from its `analyze` step on
they run the same steps:

```sh
node verify.js ./submission-folder --llm-sca-review
node verify.js ./built.xpi --sca-extracted ./extracted-source --llm-review
```

`--llm-sca-review` reads the add-on argument as the submission folder instead of as an
add-on, and does the half a program can do. It reviews nothing. It names which file is the
add-on and which is the source, creates the review's work folder at its default place beside
the `.xpi`, names its `sca/` as where the source archive is to be extracted (`EXTRACT_TO`),
and asks its reader to extract it there and hand the folder back (`unpack`), with the
directory holding the Experiment implementation (`<SCA_EXPERIMENTS>`, a name in
`<angle brackets>` being one it works out, relative to `EXTRACT_TO`) where the add-on declares
Experiments. That hand-back finds the package root, the folder holding `package.json`, inside
`sca/` by the rule the review finds one by (`src/addon/package-root.js`), the Experiment folder
known: below any folders the archive wraps its contents in, and `sca/` itself where it holds the
package file or the walk cannot decide. Then it prints the `analyze` prompt.

`--llm-review` given `--sca-extracted` (the source archive, already extracted) copies all of it into
the work folder's `sca/`, takes `--sca-package-root` and `--sca-experiments` where they were given and
finds the package root where not, and prints the `analyze` prompt itself. An Experiment add-on
needs `--sca-experiments` there, as a review given these flags does. Nothing either run hands
out names a folder outside `sca/`.

Nothing asks which directory holds the add-on's own code: the whole extracted archive is reviewed,
because a build may move or generate anything and no subtree can be shown to be the add-on's.

An add-on whose Experiment the review would reject is not prepared at all: the review
rejects it from the `.xpi` alone, before it reads any source. Without `--allow-experiments`,
the run that starts the preparation first asks the Experiment verdict of the `.xpi`, by the
rule the review itself asks it by, and where the verdict rejects, it starts that review at
once instead of printing the preparation's prompt. That review is the one `--llm-review` of the `.xpi`
starts: `experiment-not-allowed` aborts it, so its first prompt is the `close` phase.

The `analyze` prompt has its reader **work out the build**. It reads the whole extracted
archive (`SCA_SOURCE`, the work folder's `sca/`), since a build may be driven from anywhere
in it, with the node project at `SCA_PACKAGE_ROOT` inside it, and follows the release build to the
files it actually runs or reads. It writes the build report to `SCA_BUILD_PROCESS` (the work
folder's `build.md`): the release build for Thunderbird as a short numbered list, and its
install step as `npm ci` or `pnpm install --frozen-lockfile`. It runs nothing. Then it answers
the `SCA_BUILD_SAFETY_ISSUES` entry of `ANSWERS` with a list of everything the release build
reaches for outside the declared dependencies (a download, an unpinned git clone, a CDN, an
install hook that fetches or runs code, a step whose source is not in the tree), in the files it
uses and no other, one entry each, in the shape a sweep's result has: its file relative to
`SCA_SOURCE`, its
line where it sits on one, and a hint of at most 500 characters saying what it does. An empty
list is a safe build. The linter reads the verdict off the list, `unsafe` where it holds an
entry, and writes the list to the work folder's `build-issues.md`.

The reader hands the list back in the work folder's review file (`ANSWERS`, the same
`.review/review.json` a review pass uses) and runs `--llm-handback` on the folder. The preparation's
own record, `.review/prepare.json`, says where it stands, so every step is that one command. The
reader never chooses what comes next. An `sca/` that is not the folder the source was
extracted into, an Experiment folder outside `sca/`, the archive itself or one holding the package
root (at `unpack`), an issue the sweep's checker refuses (a
file outside `sca/` or not there, a line past its end, a missing or too long hint, a field it
does not take), or a missing `build.md` is refused, and the reader corrects it and hands it back
again.

That hand-back records the verdict, and after either verdict the next prompt (`permission`)
has the reader show the reviewer the **Build Review Details** (the submitted XPI, the source
copy, `build.md`, the verdict and `build-issues.md`) as the last thing of its turn, ending with `Reply "next" to
continue the review with the question how to build the add-on.` Once the
reviewer has replied, it puts them the **one decision about the build** alone, through its
question tool: the `SCA_BUILD_PERMISSION` entry, worded by the verdict.

- **After a safe verdict:** `Let the agent build`, or `Build it myself`.
- **After an unsafe verdict:** `Trust the verdict, do not build`, or `Build anyhow`, which
  clears the issues the agent found and lets it build.
- **After either:** the reviewer's own words, which override the verdict and hold the build
  unsafe for the reasons they give. They are held to the rule a note is (never empty, at most
  the note length), and recorded verbatim.

The record keeps whether the build is held safe (`buildSafe`), the reviewer's reasons, and
whether the agent may build. Only `Let the agent build` and `Build anyhow` let it build, and
go on to the audit below. Every other answer ends the preparation at once: the reviewer builds
it themselves after `Build it myself`, and nobody builds it where it is held unsafe, which the
review reports as `build-unsafe`: one finding per issue the agent listed, at its file and line
with its hint, where the reviewer trusted the verdict, and one finding carrying their own words
where they gave reasons of their own. With a check the build relies on switched off (`build-guard`
in the registry, by `--checks-only` or `--checks-skip`), the folder is done at once too, and
nobody is asked: nothing vouches for what an install pulls in, so the agent builds nothing,
and the review asks `build-review` in its place.

Where the reviewer builds it themselves, the review's Build Review Details show no
`LLM_BUILD_RESULT` (`self-build`), and the `built` question is asked of their own build. Every
review starts with the recorded verdict and `build.md` as its report, so it does not ask for
them again.

Where the reviewer let the agent build, the hand-back **audits the package root's lock**
(`src/prepare/audit.js`): every package it installs, against OSV and the policy blocklist,
exactly as the review's own dependency audit reads it. Before that it asks whether every
registry entry installs the release it names (`lockfile-injection`'s question): a lock that
names one release and installs another is not audited at all, since what OSV would be asked
about is not what the build installs. Nothing else is judged here - another reason to stop, an Experiment, `--checks-*`, the band policy: all of that stays with
the review. The record keeps the submitted lock's vulnerable packages counted by severity
(moderate, high, critical) as `vulnerabilities`, which nothing replaces, and shows them as
`SCA_VULNERABILITIES`. The outcomes:

- **The audit cannot read the lock in full** (no lock, one that does not parse, more than one
  lock, an entry from a source the audit cannot read, an entry that installs another release
  than it names): the folder is done, nothing is built, and the same hand-back starts its
  review, which stops on that lock.
- **The lock is clean**: the linter copies the whole `sca/` into the work folder's `build/`,
  and the next prompt (`build`) has the reader build in `LLM_BUILD_ROOT`, `SCA_PACKAGE_ROOT`'s place in
  that copy, as `SCA_BUILD_PROCESS` describes, installing exactly what the lock pins (`npm ci` or
  `pnpm install --frozen-lockfile`). A build that writes beside `LLM_BUILD_ROOT` still writes inside `build/`. It answers the `LLM_BUILD_OUTPUT` entry with the
  final artifact the build produced inside `build/` (an XPI or zip file, or a folder), as an
  absolute path, or with `The build failed`, after adding a "Build attempt" section (the
  failing step and its error output) to `build.md`. An output that is not inside `build/` is
  refused. Where the build produced an output, the reader compares it with `SUBMITTED_XPI`,
  which the prompt names, and answers the `LLM_BUILD_XPI_MATCH` entry with the label alone: `match`
  where it holds the same files at the same paths with the same contents, only line endings
  differing, and `no match` otherwise, with no notes and no list of differences. Beside
  `The build failed`, `LLM_BUILD_XPI_MATCH` stays null. A match answer without an output, or an
  output without one, is refused. Either answer is recorded, and the folder is done.
- **The lock installs a package with a known high or critical advisory**: the linter copies
  the whole `sca/` into `rescued/` in the same work folder, and the next prompt (`rescue`)
  hands the copy to the reader as one **autonomous loop**. It reduces the copy's
  dependencies to what the release build uses, or applies the package manager's audit fix,
  and refreshes the lock with lock-only commands and `--ignore-scripts`, so only
  `package.json` and the lock change in `rescued/`. It runs `npm audit` or `pnpm audit`, and
  builds nothing while a high or critical advisory remains. Once none does, it replaces
  `build/` with a copy of the whole `rescued/` (the two commands the prompt prints), installs
  as the lock pins and builds in `LLM_BUILD_ROOT`, `SCA_PACKAGE_ROOT`'s place in that copy. Nothing is ever
  installed or built in `rescued/`. Where the build fails it adjusts the dependencies in
  `rescued/` and audits and copies again before the next build: a `prepare` script that runs
  `husky`, for one, needs the husky the trimming removed, or the script removed. It answers
  `LLM_BUILD_OUTPUT` with the final artifact the build produced inside `build/`, or with
  `The rescue failed`, and `LLM_BUILD_XPI_MATCH` as the build prompt has it, null beside
  `The rescue failed`.
  The hand-back then audits the copy's lock itself, whatever the reader answered, and records
  its counts beside the original's as `rescuedVulnerabilities`, shown as
  `LLM_RESCUED_VULNERABILITIES`, or null where the copy's lock cannot be read in full. It also
  checks that output. Where both hold, the copy is reviewed instead of the original. A copy
  whose lock names one release and installs another is not clean.
- **The rescue failed** (the reader said so, the copy is still vulnerable, or the output is
  not inside `build/`): the copy is audited first, as above, then the copy and `build/` are
  deleted, the record says the rescue failed (`LLM_BUILD_RESULT: not built: rescue failed`), and the
  original is reviewed, **unrescued**: nothing is left to build, so no build question is
  put, every check and pass runs, and its vulnerability findings abort the review late. It
  closes as any aborted review does. Its audit of the lock asks OSV
  nothing the preparation already asked: every audit of the run reads OSV's answers from
  `.cache/osv.json` in the work folder.

A rescued copy's review tells the developer, at info, that the source was reviewed with
changed dependencies (`sca-dependencies-changed`): their own `package.json` and lock still
carry the vulnerabilities.

The reader never runs anything but `--llm-handback`. The hand-back that finds the preparation
done starts the review itself, in that folder: under `--llm-review`, with the preparation's
own flags, the add-on it was given and the settled `--sca-*` folders, all read from
`prepare.json`. That record is the linter's alone: every write leaves it read-only, and stores
a hash over it, so a record changed after the linter wrote it is refused. The reader works in
the same folder as the same user, so neither makes the file tamper-proof, and nothing in it is
taken as it stands either: only the flags a review takes, each of its own type and checked as a command line is,
with the `--sca-*` folders checked again, and a record that does not hold up is refused to the
reader. `--cache-clear` and `--verbose` belong to the run that started the preparation and
are not passed on. The hand-back prints the review's first prompt,
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
| `sca/` | The source archive, extracted: `EXTRACT_TO`, holding `SCA_PACKAGE_ROOT` | the reader of the `--llm-sca-review` prompt, or the linter, copying `--sca-extracted` |
| `rescued/` | The copy of the whole `sca/` a rescue changes the dependencies of (`RESCUE_ROOT` lies inside it), only its `package.json` and lock, never installed or built in: reviewed instead when the rescue comes out clean, and removed when it fails | the linter, and the reader of the `rescue` prompt |
| `.review/prepare.json` | Where the preparation of a source code review stands, and how its review is to be run - read-only, and hashed | the linter, at each step of the preparation |
| `.review/state.json` | The review itself, which every pass reads | the linter |
| `.review/review.json` | The file the agent fills in and hands back (`ANSWERS` while a source code review is prepared) | the linter, each pass |
| `report.md` | `REVIEW_REPORT` | the linter |
| `summary.md` | `ADDON_DESCRIPTION` | the agent, from a sub-agent's reply |
| `build.md` | `SCA_BUILD_PROCESS` | the agent, in the preparation's `analyze` step, in a source code review |
| `build-issues.md` | `SCA_BUILD_SAFETY_ISSUES` | the linter, from the issues the agent handed back in the same step |
| `build/` | Where every build of the preparation runs (`LLM_BUILD_ROOT` lies inside it), holding `LLM_BUILD_OUTPUT`: a copy of the whole `sca/` for a clean source, or of the whole `rescued/` before each build of a rescue, and removed when the rescue fails | the linter for a clean source, the reader of the `rescue` prompt for a rescue |
| `.review/sweep-<artifact>.answers.json` | One tree's sweep answers | the agent, from a sweeping agent's reply |
| `.cache/osv.json` | What OSV answered during this run, so no later invocation of the run asks again | the linter, whenever it audits |
| `.cache/popularity.json` | The npm download counts and GitHub stars read during this run, kept the same way | the linter, whenever it judges a source's popularity |

The folder is always `xpi-review-<add-on name>-<timestamp>` beside the add-on argument, or
`sca-review-<add-on name>-<timestamp>` for a source code review, named by the run that starts
the review: no flag names another. It must not exist: the run that starts a
review creates it, and an existing work folder is carried on by `--llm-handback` alone. The one review that starts in a folder already there is the one a preparation's
hand-back starts, in the folder that holds `.review/prepare.json` and `sca/`. There every name the
review will create is checked to be free - `--llm-review` claims every name above except
`sca/`, `rescued/`, `build/`, `build.md`, `build-issues.md` and `.review/prepare.json`, the preparation's, since the agents it
instructs write the rest later - and a name
already there ends the run with exit 2, naming it. A start that fails before the review exists
(a schema fetch that gets no answer, an audit that ends the review, an Experiment the command
does not say how to read) removes what it created, so it can be run again. The `--llm-handback`
passes rewrite `.review/state.json`, `.review/review.json` and `report.md` as the review moves on.
A source review the reviewer restarts as an XPI review (see [Restarting as an XPI
review](#restarting-as-an-xpi-review)) is left in its folder, and the XPI review starts in a new
`xpi-review-<add-on name>-<timestamp>` folder beside the add-on.

`--sca-extracted` must not include the add-on: the shipped XPI, and the work folder created beside
it, would be read as files of the source. Extract the source archive into a folder of its own.

The caches are not part of it: they stay in `WEBEXT-LINTER-CACHE/`.


## Flags

| Option | Description |
| --- | --- |
| `--llm-review` | Run the review and print the first phase's prompt, instead of the report. The prompt names the file to fill in and the command that hands it back. Given `--sca-extracted`, prepare the source code review first, from its `analyze` step on (see [Preparing a source code review](#preparing-a-source-code-review)). Refused with `--report-format json`. |
| `--llm-handback <dir>` | Take a phase back and hand out the next, from the review file in the work folder the prompt named - the last being `close`, which hands over the settled review. Takes no add-on path: the review ran once, under `--llm-review`, and its result is in the state file in that folder. On a folder a source code review is being prepared in (`.review/prepare.json`, and no review started), take the next step of the preparation instead, and once it is done, start its review. The only run that carries on an existing work folder. Normally run by the agent working through the review rather than by a person. |
| `--llm-sca-review` | Read the add-on argument as a submission FOLDER - one built `.xpi` and one archive of the source it was built from - and print the first prompt for preparing a source code review of it. It creates the review's work folder beside the `.xpi`, records there how the review is to be run, and its prompt ends in `--llm-handback` on that folder (see [Preparing a source code review](#preparing-a-source-code-review)). Refused beside any `--sca-*` flag, which is what the preparation works out. |
| `--llm-skip-summary` | With `--llm-review` or `--llm-sca-review`: leave out the add-on description. The prompt does not ask for one and names no file for it; nothing else about the review changes. |
| `--llm-skip-sweep` | With `--llm-review` or `--llm-sca-review`: leave out the sweep. No sweeping agent is spawned, and the sweep is not handed to the reviewer either. |
