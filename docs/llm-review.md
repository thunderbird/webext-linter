# LLM review

The linter can hand its review to an LLM agent instead of printing it. The agent does
the reading a person would otherwise do — auditing each finding, settling the cases the
scans could not, putting the rest to a reviewer — and the linter stays the one deciding
what is asked, in what order, and what an answer is allowed to say.

This is the long-form version; the [README](../README.md) carries the summary and the
flags in the context of every other option.

- [The round trip](#the-round-trip)
- [The phases](#the-phases)
- [What an answer may say](#what-an-answer-may-say)
- [The sweep](#the-sweep)
- [What the reviewer is handed](#what-the-reviewer-is-handed)
- [Preparing a source code review](#preparing-a-source-code-review)
- [Flags](#flags)


## The round trip

`--llm-review` runs the review **once** and prints the first phase's prompt instead of
the report. Every `--llm-verdict` run after that takes a phase back and hands out the
next, until nothing is left to issue and the last one carries the report.

```sh
node verify.js ./submission.xpi --llm-review     # runs the review, prints prompt 1
node verify.js --llm-verdict <review-file>       # ...and each pass after it
```

The agent opens ONE file, ever: the review file the prompt names. It fills in each
entry's empty `"answer"` and hands the same path back — the command is in the prompt.
Everything the linter needs between passes is in a state file beside it that the agent is
never pointed at, which is why `--llm-verdict` takes no add-on path: the deterministic
review ran once, and nothing re-derives it.

Each prompt is assembled from the same layers, so a pass never has to be read as a
special case: a preamble on the first pass only (what is about to happen), the frame
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
| `spawn` | Start the sub-agents the review needs — the add-on description, the build report, the sweep — and record what the sweep found. | One row per swept check (see below) |
| `verify` | Audit what the deterministic checks claimed. | `reported` / `withdrawn` |
| `settle` | Decide the cases a check could not settle from the package. | `reported` / `cleared` / `ask` |
| `ask` | Put to a reviewer what only a person can answer. | The reviewer's own answer |

A phase is issued only when it has **work** — steps that survive their markers, or
entries to settle — and that is also what ends the loop. So a review with no sweep never
mentions one, and a review that starts no sub-agent at all skips `spawn` and opens at
`verify`. The package itself is not unpacked by any of this: the linter extracts a packed
submission before the first prompt is printed, and every phase reads that one folder.


## What an answer may say

What an entry's `"answer"` may say depends on WHO THE PHASE ASKS.

A phase the agent settles by reading the add-on takes one of the linter's verbs:
`verify` takes `reported` or `withdrawn`; `settle` takes `reported`, `cleared` or `ask` —
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
case's location line — in parentheses after the location, or as the line itself when the
case has none, where the reviewer's own line breaks are kept and each becomes an item of
its own.

Crossing the two is refused, naming the entry so the question can be asked again rather
than an answer made to fit: a verb where a reviewer was asked, a reviewer's answer where
the agent settles, an answer with nothing in it, and one past the length the question
tells the reviewer they have (`MAX_NOTE`).


## The sweep

Some checks scan for an enumerated set of forms, and the set cannot be finished, so each
one declares a **`sweep-instruction:`** describing the class of code it cannot see — see
[Blind-spot sweeps](../README.md#blind-spot-sweeps) for why they exist and which checks
declare one. Every review prints those instructions under **Standard Code Review**, for
whoever is reading the add-on to cover by hand.

Under `--llm-review` that reading is a sub-agent's. The `spawn` phase carries one row per
swept check for what it found — an empty list where that check is clean, which is what
separates "found nothing" from "never looked":

```json
{ "check": "data-exfiltration",
  "instruction": "Message content and headers, attachments, contacts, ...",
  "answer": [ { "file": "background.js", "line": 40,
                "hint": "<a ping> attribute carries the message digest" } ] }
```

What comes back is not a verdict on the sweep, and not a classification either: the agent
that sweeps reads the add-on, not the linter, so it cannot know whether what it found is
something that check would have filed, escalated, or deliberately excluded. It hands back
the location and what is there; the routing is the linter's.

A sweep is a DETECTOR and nothing more. What comes back is a hint — a location that
check's own detectors missed — and from there the case is one of that check's, handled
exactly as a case it found for itself:

| The owning check | Where a swept result lands |
| --- | --- |
| escalates | An escalation of that check, in the section that check's own wording puts it in, asking the question that check asks - its own instructions, never the text the sweep agent was sent. |
| does not escalate | A **finding** of that check. Such a check settles its cases as findings, so a swept one is a finding too, and the `verify` phase audits it like every other claim. |

So a `sweep-instruction` says what to LOOK FOR, and is read in exactly two places: the
request handed to the sweep agent, and the Standard Code Review list every report prints.
It never says what confirming something means — that is the owning check's to say.

Either way the case is deduplicated against what the deterministic pass already covered,
as a to-do item or as a finding, so nothing downstream can tell a swept case from one a
check found. The `hint` is a locus annotation naming what sits at that line; the paragraph
the developer reads stays the registry's.

`--llm-skip-sweep` withholds all of this: the prompt neither spawns the agent nor asks for
its rows, and the Standard Code Review list stays in the report for the reviewer to sweep
by hand, exactly as in a review with no agent in it.


## What the reviewer is handed

Before anything is put to them, the reviewer is handed a **Review details** block naming
what this review is and where to read it:

| Name | What it names |
| --- | --- |
| `ADDON_ID` | Which add-on this is — its manifest id, or its name |
| `XPI_ROOT` | The shipped package, unpacked, ready to read |
| `SCA_ROOT` / `SCA_SOURCE` | A source code review's source root, and the add-on's own code inside it |
| `SCA_EXP_SOURCE` | The Experiment implementation folder, when one was named |
| `ADDON_DESCRIPTION` | Where a sub-agent wrote a description of the add-on, for reading while answering |
| `BUILD_PROCESS` | Where another wrote what building the add-on takes, in a source code review |

The linter names those last two; it writes neither and reads neither. They are the
reviewer's, and the agent conducting the review is told only to name them — not to open,
read, summarise or print what the sub-agent wrote there.

The block is handed over once, by whichever comes first: the `ask` phase before it asks
anything, or the finished report when nothing is ever put to a reviewer.

The last pass prints the report, and the agent's own account of it, each under a heading
of its own: **LLM decisions** (every finding it withdrew and every verdict it reached,
with its reasons — the only part that is the agent's to write), **Summary** (the tally),
and **Review report** (the text the reviewer sends to the developer, unchanged).


## Preparing a source code review

A source code submission arrives as two files — the built `.xpi` and an archive of the
source it was built from — and reviewing it needs three `--sca-*` arguments, two of which
nobody can write without opening that archive. `--llm-sca-review <folder>` does the half a
program can do and hands those two to a reader who can open it:

```sh
node verify.js --llm-sca-review ./submission-folder
```

It reviews nothing. It names which file is the add-on and which is the source, computes
where the source archive should be extracted (`SCA_ROOT`, beside the archive and named
after it), and asks its reader to extract it there and work out two things that only
reading the tree can settle: which directory holds the add-on's own code
(`<SCA_SOURCE>`), and — when Experiments are allowed — which holds the Experiment
implementation (`<SCA_EXP_SOURCE>`). A name in `<angle brackets>` is one of those; every
other name is given.

It then prints the review command to run, which is this run's own flags with
`--llm-review` in place of `--llm-sca-review` and the `--sca-*` arguments filled in. That
review prints a prompt of its own, and the round trip above takes over from there.

The tool extracts the submitted `.xpi` itself, but not a source archive: those arrive in
too many formats for it to open, which is why that one extraction is the reader's.


## Flags

| Option | Description |
| --- | --- |
| `--llm-review` | Run the review and print the first phase's prompt, instead of the report. The prompt names the file to fill in and the command that hands it back. Refused with `--report-format json`. |
| `--llm-verdict <file>` | Take a phase back and hand out the next, from the review file the prompt named — or, when nothing is left to issue, print the settled report. Takes no add-on path: the review ran once, under `--llm-review`, and its result is in the state file beside this one. Normally run by the agent working through the review rather than by a person. |
| `--llm-sca-review <folder>` | Print the prompt for preparing a source code review of a submission folder — one built `.xpi` and one archive of the source it was built from — and exit without reviewing anything. Refused beside any `--sca-*` flag, which is what it exists to produce. |
| `--llm-skip-summary` | With `--llm-review` or `--llm-sca-review`: leave out the add-on description. The prompt does not ask for one and names no file for it; nothing else about the review changes. |
| `--llm-skip-manual` | With `--llm-review` or `--llm-sca-review`: leave out the manual review items. No phase puts them to a reviewer — they stay in the report, for the reviewer to work through later. Given with `--llm-skip-summary`, the review verifies only the add-on's **code**. |
| `--llm-skip-sweep` | With `--llm-review` or `--llm-sca-review`: leave out the sweep. The prompt neither spawns it nor asks for it, and the Standard Code Review section stays in the report for the reviewer to sweep by hand. |

`--report-out` is refused with any `--llm-*` flag: no run of this round trip saves its
output.
