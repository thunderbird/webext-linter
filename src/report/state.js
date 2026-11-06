// Belongs here: the shape of the REVIEW's part of the record - the review itself, written
// once as the review loop starts and moved on by every pass (src/report/loop.js).
//
// Does NOT belong here: reading and writing the record (src/review/record.js), what a phase
// asks (src/report/phases.js), what a hand-back must look like (src/report/handback.js), how
// a prompt is printed (src/report/format.js), or where the files live (src/util/dest.js
// workPaths).
//
// WHY A RECORD AT ALL: the loop runs one deterministic review, in the run that starts it,
// and every pass after it reads this. Nothing is re-derived - so anything the report reads
// must be in here, and the invariant test (equivalent decisions produce today's report byte
// for byte) is really a completeness check on this shape.
//
// WHY THE AGENT NEVER SEES IT: what the linter needs across passes would otherwise become
// a contract. A value a step names (SCA_BUILD_PROCESS, say) is handed over in the prompt, and
// the rest stays here.

/**
 * The review's own part of the record, its current part in mode review (src/review/record.js),
 * beside the permanent part every mode reads: the submission, the flags, the Experiment
 * verdict, the early-exit result, and the build results of a build check done first
 * (`build`, src/build-check/state.js buildResults), which the details blocks show and the
 * `built` step is worded by.
 * @typedef {object} LoopState
 * @property {object} report  Everything formatText needs that the registry cannot
 *   recompute: the findings as the checks produced them, unworded and their holds undecided,
 *   which every pass settles a copy of (src/review/settle.js), meta, and whether it is a
 *   source code review (`sca`). NOT issueHeadings /
 *   verdictIntros - those are the registry's, and a stale copy here would outlive an edit
 *   to it.
 * @property {object[]} manual  The to-do items, kept beside the findings because
 *   orderReview orders the two together.
 * @property {?object} preSweep  The blind-spot sweeps as the registry authored them, or
 *   null when no check that ran authors one.
 * @property {{skip: string[], sca: boolean, warningsAsErrors: boolean}} run
 *   What this run was told to leave out (PROMPT_SKIPS), whether it is a source code review,
 *   whether every check a build relies on runs (`build-guarded`), whether the built XPI
 *   of a source review could be reviewed on its own (`xpi-reviewable`), which trees it
 *   sweeps (one sweepRun key each), and the band it publishes a warning at
 *   (--warnings-as-errors). One record, read by everything that asks: a step prints by it,
 *   the routing drops entries by it, the registry is read under it, and both legs of a
 *   hand-over ask it the same question.
 * @property {object} paths  The values a step names: description and build (both in the
 *   review's work folder, src/util/dest.js workPaths, which also holds report.md, the record
 *   and the answers file at fixed names that are not recorded), schemaCache, schema, the
 *   add-on's copy an entry's paths are resolved against (xpiRoot), and `sweeps` - each tree's
 *   sweep request (the text its step hands over) and answers file, by artifact, which is also
 *   what says WHICH trees this review asked about. Held here because a later pass prints them
 *   and cannot re-derive a moment.
 * @property {import("../addon/package-root.js").ScaFolders} [roots]  In a source review,
 *   the source folders the review reads: the tree an entry's paths in the source are resolved
 *   against (src/lib/artifacts.js artifactRoots).
 * @property {?{moderate: number, high: number, critical: number}} vulnerabilities  The
 *   submitted lock's vulnerable packages as this review's own audit counted them, shown
 *   where the build check counted none, null where no audit happened.
 * @property {?string} phase  The phase in flight - what went out last, and so what the
 *   next hand-back is read as. Unset until the first prompt goes out, which is how a prompt
 *   knows it is the first (`first`, src/report/loop.js runOf). At the close it is `close`,
 *   and every later hand-back is refused.
 * @property {string[]} issued  Every phase that has been handed back, in order. What a
 *   later prompt reads to know what already happened: whether agents were started
 *   (`spawned`) and whether the agent judged anything (`decided`).
 * @property {Object<string, string>} [values]  The process values returned so far: a
 *   phase answering `value` -> the id it returned. Read by value(phase, id) in a `when:`.
 * @property {Object<string, *>} answers  An item's reference (`ref`, src/report/order.js
 *   assignRefs) -> what came back, once it is settled.
 * @property {?object[]} sweep  Everything the sweeping agents found, read back off their
 *   answers files and already resolved to the check and the artifact each belongs to
 *   (src/report/sweep-files.js). Null where no tree was asked, which is not the same as
 *   every tree answering with nothing. Written and read inside the one `accept` that
 *   starts them; what stops a second pass starting them again is `issued`.
 * @property {string[]} [products]  The build check's files the Review Details link
 *   (`build`, `buildIssues`) that its agent wrote (src/report/handback.js productWritten),
 *   recorded once as the review starts (src/report/loop.js reviewBody).
 */

export {};
