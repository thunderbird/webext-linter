// The CLOSED SETS the registry's keys draw their values from - the review vocabulary, as
// data. Split out of registry.js because two readers need them and neither may import the
// other: the shape schema (registry-schema.js) declares which key takes which set, while
// the semantic assertions and the orchestrator (registry.js) read them to decide and to
// route.
//
// Belongs here: the sets, and what each member means. Does NOT belong here: any rule ABOUT
// a value (-> registry-schema.js for shape, registry.js for everything semantic), or any
// behaviour keyed off one (-> modeEligible, routeCtx, runOneCheck).

import { SEVERITY } from "../report/finding.js";
import { VERB_NAMES } from "../report/verbs.js";

// The severity token a check entry may declare. error/warning/info are stamped
// onto every finding the check emits. "auto" instead delegates the per-finding
// severity to the check itself (it sets f.severity, defaulting to error if it
// sets none or an invalid value) - see runOneCheck. "auto" is a config-only
// token: a finding never carries it.
export const AUTO_SEVERITY = "auto";
// A check that emits no findings at all: it only ever escalates, so there is no band to
// report at. Declaring `error` there was a value nobody chose - inert (nothing is stamped)
// but pre-armed to auto-reject on the JSON upload filter the day the check gained a finding
// path. Saying `none` states the truth AND makes that day loud: runOneCheck refuses a
// finding from such a check rather than stamping one.
export const NO_SEVERITY = "none";
// A check whose findings block the review but do not reject the add-on, UNLESS the
// review already rejects it for something else - then they are one more item on that
// list. Which of the two it is depends on what every OTHER check found, so it cannot be
// decided here: like "auto" this is a config-only token, and resolveHolds settles each
// finding once, after the run (src/report/finding.js).
export const HOLD_OR_ERROR = "hold-or-error";
export const CONCRETE_SEVERITIES = new Set([
  SEVERITY.ERROR,
  SEVERITY.WARNING,
  SEVERITY.INFO,
]);

export const VALID_CHECK_SEVERITIES = new Set([
  ...CONCRETE_SEVERITIES,
  AUTO_SEVERITY,
  HOLD_OR_ERROR,
  NO_SEVERITY,
]);

// How an entry's repeated cases are LISTED, when listing every one of them says the same
// thing several times. Omitted is the default every entry has today: one line per case.
//
// "subject" is for a check whose cases repeat one SUBJECT in several places - the same
// remote host reached from three files. The first place keeps its line and counts the rest
// onto it; the rest are numbered and settled like any other case, they just do not print
// (src/report/order.js, the same mechanism as the display cap).
//
// Two cases fold together only when their lines would have said the SAME THING apart from
// where they are - the subject, its detail, and any note a reviewer wrote. A differing
// note is a person's own words about one case, and folding it away would lose them.
//
// A display decision, never a review one: nothing here changes what is found, what is
// asked, or what a verdict can settle.
export const COLLAPSE_MODES = new Set(["subject"]);

// The `input` a check entry declares - which add-on artifact is ctx.artifact when the
// check runs, and, where the answer can only exist in one review mode, WHICH MODE it runs
// in. "source" = the REVIEW TARGET, the readable submitted code (the readable
// --sca-root in an SCA review, the built XPI in an XPI review - the only artifact
// there); "xpi" = ALWAYS the built XPI (the shipped artifact), analysed in both modes;
// "sca" = the submitted source archive with no parsed source, for the build and
// dependency checks; "both" = the two artifacts together, named ctx.xpi and ctx.sca and
// with no ctx.artifact, for a check whose subject is the SUBMISSION rather than either
// artifact in it. "both" is the only route that sees more than one, so a cross-artifact
// comparison is a thing the registry declares rather than something setup does invisibly
// and hands down as a flag.
//
// The archive exists only in an SCA review, so `input: sca` says "an SCA review" as well
// as "that artifact" - the mode is DERIVED from the route (SCA_ONLY_INPUTS, modeEligible)
// rather than declared a second time beside it. An entry that had to say both could get
// one of them wrong; an entry that says one cannot.
//
// A check reads only the artifact its route names, and has no way to reach another (see
// buildXpiCtx / buildScaCtxs). Since the ctxs are sealed (src/lib/errors.js), reading a
// field the routed artifact never produced throws rather than answering nothing.
export const VALID_CHECK_INPUTS = new Set(["source", "xpi", "sca", "both"]);

/** What a BY-HAND entry declares instead. It runs no code and reads no artifact - it is
 *  settled by looking at the add-on listing page, or by installing the add-on and using
 *  it - so `none` is the whole vocabulary, and declaring it is what stops the absence of
 *  an `input` from being a default. A runnable check cannot say it: the set above does not
 *  hold it, and the schema gives each shape its own field. */
export const MANUAL_ENTRY_INPUTS = new Set(["none"]);

/** The routes whose artifact exists only in a source-code-archive review, so declaring one
 *  IS declaring the mode (modeEligible). buildScaCtxs builds these siblings; an XPI review
 *  has neither, and routeCtx would throw. Beside the set above because they are one axis:
 *  which artifact a check reads, and - where only one kind of review has it - which review. */
export const SCA_ONLY_INPUTS = new Set(["sca", "both"]);

// The per-review-mode response keys, keyed by the REVIEW_MODE fact that selects them
// (`mode?.sca`). An entry words its response ONCE for both modes (`response`) or ONCE PER
// mode (both keys, and no `response`) - never a mix; assertResponse enforces that, and
// responseOf is the only reader. These keys change what is PRINTED and nothing else: no
// check runs differently, no verdict or routing moves, so the mode reaches the text
// producers (findings, manual items, sweep entries) and stops there.
//
// The mode is DERIVED, not the flag: a rejected Experiment takes an --sca-root run back
// to REVIEW_MODE.XPI (src/pipeline.js), so an invalid-experiment-phase check that words
// itself per mode prints its XPI text for a source-code submission.
export const MODE_RESPONSES = Object.freeze({
  sca: "response-for-sca",
  xpi: "response-for-xpi",
});

/** What `run:` can name in each prompt: the things about a run that decide whether a step
 *  of it is printed. No flag spells these - unlike PROMPT_SKIPS, which the CLI offers - so
 *  they live here, beside the messages that name them. */
export const REVIEW_PROMPT_RUNS = ["sca", "sweep"];

/**
 * The loop texts the LINTER owns, and the placeholder each one exists to carry. An empty
 * slot means the text names no value - it is the same words every pass.
 */
export const PHASE_TEXTS = {
  preamble: "",
  frame: "{{review}}",
  handover: "{{command}}",
  refused: "{{problem}}",
  final: "",
  // The hand-over for a review that STOPPED. Required like the rest, because which of
  // the two is printed is decided at the end of the loop and a missing one would be
  // found only by the review that needed it.
  "final-early-exit": "",
};

/** What the last prompt hands the reviewer, whichever of the two texts carries it. */
export const FINAL_SLOTS = ["{{details}}", "{{tally}}"];

/**
 * Every verdict the loop knows. A PHASE accepts a subset of these, declared beside its
 * steps - `verify` takes `reported`/`withdrawn`, `settle` takes `reported`/`cleared`/`ask` -
 * because what an answer may be is a property of the phase, never of the file's shape.
 */
export const LOOP_VERBS = VERB_NAMES;

export const ANSWER_KINDS = ["hints", "verdict", "words"];

/** The one condition the SCA prompt can evaluate: whether this review allows
 *  Experiments, which decides whether it asks its reader for --sca-exp-source. */
export const SCA_PROMPT_RUNS = ["experiments"];
