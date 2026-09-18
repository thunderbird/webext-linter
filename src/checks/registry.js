// registry.yaml is the check registry. Its check-bearing sections ARE the phases -
// `invalid-experiment-phase` and `deterministic-phase`
// (PHASE_SECTIONS) - so a check's phase IS the section it lives in, and no entry declares
// one. Every entry there that carries a `check:` field links to a module in ./rules/ that
// implements that test. This loader reads the yaml, imports the linked module for each
// (selected) entry, runs it, and stamps each returned finding with the entry's id (the
// check filename stem) and its severity. runChecks names the phases it runs, in order, so
// a section it never asks for is inert.
//
// A check is a pure detector: it decides verdicts and emits findings carrying
// only `file`/`loc`/`item`/`hint` - never prose. The registry entry is the
// check's declarative contract: `severity` (the source of a finding's impact,
// stamped unconditionally - UNLESS it is `auto`, which delegates the per-finding
// severity to the check), and the text shown for it (`response`, `instructions`).
// Neither half leaks into the other.
//
// A check returns `Finding[]`, or an object carrying `escalations` beside its
// findings: the cases it could not settle. The orchestrator (runChecks) repacks
// those as to-do items via escalation.js and is the sole authority on the to-do
// sections: which one a check's cases are listed under follows from the reader the
// check authored wording for, and is never a property of the case.
//
// The shared `ctx` passed to run() is the RunContext typedef below, which is the
// one description of it: what a check may read, and from where.
//
// Belongs here: the Registry class (the queried view of registry.yaml), loading
// and filtering rule modules, the RunContext type, and runChecks - the loop
// that runs checks, resolves escalations, and stamps id + severity. Does NOT
// belong here: building the ctx, which is src/checks/context.js. The per-case
// escalation policy - src/checks/escalation.js. Any check's detection logic - a
// module under src/checks/rules/* (shared analysis in src/lib/*).
// Resolving a ruleId to user text and laying out the report -
// src/report/responses.js and src/report/format.js.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
import { displayLine } from "../util/text.js";

import { finding, SECTION, SEVERITY, VERDICT_KEYS } from "../report/finding.js";
import { MAX_NOTE, PROMPT_SKIPS } from "../config.js";
import { artifactLabel } from "../report/artifact.js";
import { VERB, VERB_NAMES, verbNamed } from "../report/verbs.js";
import { progress, debug, FEED } from "../util/log.js";
import { red, green, blue } from "../util/color.js";
import { manualEscalations } from "./escalation.js";
import { VERDICT } from "../lib/enum.js";
import { verdictLabel } from "../report/verdict-label.js";
import { collapseUnusedFolders } from "../lib/unused-folders.js";

/** @typedef {import("../report/finding.js").Severity} Severity */

// The severity token a check entry may declare. error/warning/info are stamped
// onto every finding the check emits. "auto" instead delegates the per-finding
// severity to the check itself (it sets f.severity, defaulting to error if it
// sets none or an invalid value) - see runOneCheck. "auto" is a config-only
// token: a finding never carries it.
const AUTO_SEVERITY = "auto";
// A check that emits no findings at all: it only ever escalates, so there is no band to
// report at. Declaring `error` there was a value nobody chose - inert (nothing is stamped)
// but pre-armed to auto-reject on the JSON upload filter the day the check gained a finding
// path. Saying `none` states the truth AND makes that day loud: runOneCheck refuses a
// finding from such a check rather than stamping one.
const NO_SEVERITY = "none";
// A check whose findings block the review but do not reject the add-on, UNLESS the
// review already rejects it for something else - then they are one more item on that
// list. Which of the two it is depends on what every OTHER check found, so it cannot be
// decided here: like "auto" this is a config-only token, and resolveHolds settles each
// finding once, after the run (src/report/finding.js).
const HOLD_OR_ERROR = "hold-or-error";
const CONCRETE_SEVERITIES = new Set([
  SEVERITY.ERROR,
  SEVERITY.WARNING,
  SEVERITY.INFO,
]);
const VALID_CHECK_SEVERITIES = new Set([
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
const COLLAPSE_MODES = new Set(["subject"]);

// The `input` a check entry declares - which add-on artifact is ctx.addon when the
// check runs. "source" = the REVIEW TARGET, the readable submitted code (the readable
// --sca-source in an SCA review, the built XPI in an XPI review - the only artifact
// there); "xpi" = ALWAYS the built XPI (the shipped artifact), for the structure checks
// that describe what ships; "build" = the SCA build files (the archive minus the review
// source minus node_modules), for the build review; "manifest" = the shipped manifest
// ONLY, on a ctx with an EMPTY file corpus (buildXpiCtxs' manifestCtx), for pure-manifest checks
// that read ctx.manifest and no files. Required on every check: runChecks routes each
// check to its artifact's context, so the check reads one artifact and has no way to reach another (see
// buildXpiCtxs / buildScaCtxs).
const VALID_CHECK_INPUTS = new Set(["source", "xpi", "build", "manifest"]);

// The check-bearing yaml sections ARE the phases: a check's phase IS the section it
// lives in, so the two can never disagree and no entry declares a phase of its own.
// This is a CLOSED SET - the orchestrator (runChecks) looks up the phases it wants, in
// the order it runs them, so a section it never asks for is inert: adding an
// unrecognized section to registry.yaml changes nothing. The yaml's other top-level
// sections (permission-prompts, messages, manual-checks, ...) are exactly that - never
// asked for here, and so not phases.
const PHASE_SECTIONS = Object.freeze({
  "invalid-experiment": "invalid-experiment-phase",
  deterministic: "deterministic-phase",
});

/**
 * Whether `s` is a concrete finding severity (error/warning/info) - i.e. a value
 * a finding may actually carry into the report. "auto"/null/anything else is
 * not.
 * @param {unknown} s @returns {boolean}
 */
function isConcreteSeverity(s) {
  return CONCRETE_SEVERITIES.has(/** @type {string} */ (s));
}

const here = path.dirname(fileURLToPath(import.meta.url));
const RULES_DIR = path.join(here, "rules");
const DEFAULT_REGISTRY = path.resolve(here, "../../assets/registry.yaml");

/**
 * @typedef {object} LoadedCheck
 * @property {string} id
 * @property {string} title
 * @property {Severity|"auto"|"none"|"hold-or-error"} severity  The entry's declared
 *   severity, stamped onto the check's findings unless it delegates (see runOneCheck).
 * @property {boolean} [sca]  The review-mode gate (scaEligible); undefined when unset.
 * @property {"source"|"xpi"|"build"|"manifest"|undefined} input  Which artifact is
 *   ctx.addon when the check runs (VALID_CHECK_INPUTS above), and what its output is
 *   labelled as ([XPI]/[SCA]). Required for every check; runChecks routes it (see
 *   buildXpiCtxs / buildScaCtxs).
 * @property {?string} section  Which to-do section its escalations are listed under
 *   (SECTION in src/report/finding.js), derived by sectionFor from the reader this check
 *   authored wording for; null when it never escalates. The wording itself is NOT carried
 *   here - it is resolved per reader when an item is built (src/report/responses.js).
 * @property {object[]} [permissionTokens]  The permission-prompts token entries
 *   ({permissions, tokens, version bounds}), carried by every check and read by
 *   the one that scans for them.
 * @property {Function} run
 */

/**
 * The shared context passed to every check's run(ctx, check). Built once per
 * review (built in runPipeline Phase 4) and read by the rule modules.
 * @typedef {object} RunContext
 * @property {object} addon  The routed artifact's INTRINSIC view (reviewView in
 *   context.js): its files plus the lazy file-derived caches (bundled, vendor,
 *   locales, ...). The manifest and experiment classification are NOT on it - they
 *   are shipped-authoritative and live on ctx.manifest / ctx.experiments below - so a
 *   check cannot pair one artifact's manifest with another's files.
 * @property {import("../schema/index.js").SchemaIndex} schema  Resolved schema.
 * @property {object[]} jsSources  Parsed JS sources (see addon/sources.js).
 * @property {object[]} apiUsages  Per-source extracted API usage.
 * @property {?import("../addon/load.js").Manifest} manifest  The authoritative,
 *   SHIPPED manifest (the built XPI's - what Thunderbird loads), resolved once like
 *   `schema`. Every manifest / permission / API check reads this; there is no
 *   ctx.addon.manifest (reviewView strips it), which in SCA would be the readable
 *   source's pre-build template - no check reviews the source manifest.
 * @property {?string} manifestError  The shipped manifest's JSON parse error, or null.
 * @property {?import("../addon/manifest-loc.js").ManifestLoc} manifestLoc  Position
 *   index for the shipped manifest (manifestPathLine reads it).
 * @property {string} manifestText  The shipped manifest.json raw text (manifestTokenLine
 *   reads it); "" when absent.
 * @property {?object} experiments  The Experiment classification (verifyExperiments),
 *   computed from the SHIPPED XPI, shared like the manifest. Null for a non-Experiment
 *   add-on.
 * @property {{allowExperiments?: boolean,
 *   libraryHashes?: Map<string, {name: string, version: string}>}} options  The only run
 *   options a check reads (experiment-not-allowed, the lazy bundled classifier).
 * @property {import("../lib/enum.js").ReviewMode} [mode]  Review mode: "xpi" (a built add-on, default) or
 *   "sca" (a source code archive). Gates checks via scaEligible.
 *
 *   The SHIPPED artifact (the built XPI) is deliberately NOT a ctx field: a check
 *   has no way to reach the artifact it was not routed to. The orchestrator builds a
 *   separate shipped context (buildXpiCtxs, src/checks/context.js) and routes each
 *   `input: xpi` check to it - see runChecks / runOneCheck.
 * @property {boolean} [isShippedView]  Set by buildXpiCtxs on the shipped
 *   context (never the review target). buildReachability reads it so the SCA
 *   "all readable-source files" pureWebExtensionReachable fallback applies only to
 *   the review source, not the built XPI (whose entry points resolve).
 * @property {string} [scaSource]  SCA mode: the review source root (--sca-source),
 *   absolute. Carried for the question below, never to address a file: a check addresses
 *   files by the keys of ctx.addon.files, which this prefix was already stripped from.
 * @property {string} [scaExpSource]  SCA mode: the Experiment folder (--sca-exp-source),
 *   absolute, which may sit inside the review source or elsewhere under --sca-root.
 *   buildReachability asks where it sits within scaSource and excludes that subtree from
 *   pureWebExtensionReachable, so the WebExtension code checks skip privileged Experiment
 *   code.
 * @property {boolean} [invalidExperiment]  The add-on uses Experiment APIs and
 *   --allow-experiments is off: the review short-circuits to the reject check
 *   only (see runChecks and buildXpiCtxs).
 * @property {boolean} [scaNotRequired]  The shipped XPI of a submitted SCA (--sca-root)
 *   turned out to BE its source, so an XPI-only submission would have been enough; the
 *   sca-not-required check reads this to say so. Pure advice - the review is not re-routed.
 * @property {Function} [note]  Narrate a file:line investigation note to the
 *   feed: (file, loc, item, verdict) -> void. Set by runChecks, absent in tests.
 */

/**
 * Check filename stem - the finding ruleId, also used by --checks-only/--checks-skip.
 * @param {string} checkFile
 * @returns {string}
 */
function stem(checkFile) {
  return String(checkFile).replace(/\.js$/, "");
}

/**
 * The parsed registry.yaml, read once and queried many times. It is the single
 * source for the checks to run, the manual-review to-do items, the
 * severity-group headings, and the reviewer-response templates - so the file is
 * parsed once per run rather than re-read per concern.
 */
export class Registry {
  /** @param {Record<string, any>} doc  Parsed registry document. */
  constructor(doc) {
    this.doc = doc && typeof doc === "object" ? doc : {};
  }

  /**
   * Every check entry that links to a rule module, each tagged with the `phase` it
   * runs in - which IS the section it came from (PHASE_SECTIONS). An escalating entry
   * additionally carries `instructions` (the manual-review message shown for a case it
   * could not settle).
   * @returns {object[]}  Each: { check, title, severity, phase, instructions?,
   *   response? }.
   */
  checkEntries() {
    /**
     * @param {object[]} [list]  Raw entries from one registry section.
     * @param {string} phase  The phase that section IS.
     * @returns {object[]}
     */
    const tag = (list, phase) =>
      (list || [])
        .filter((e) => e && typeof e.check === "string" && e.check)
        .map((e) => ({ ...e, phase }));
    return Object.entries(PHASE_SECTIONS).flatMap(([phase, section]) =>
      tag(this.doc[section], phase)
    );
  }

  /**
   * The registry entry for a ruleId - a rule-backed check, or one of the by-hand
   * `manual-checks`. Undefined if neither has it.
   *
   * Both kinds are included because this is the report's lookup: a to-do item asks for
   * its title, its instructions, its suggested response and the band a reported case
   * lands in, and a by-hand entry answers all four exactly as an escalating check does.
   * What separates them is whether a rule module RUNS, which is checkEntries() and
   * checkIds() - not this.
   * @param {string} ruleId
   * @returns {object|undefined}
   */
  checkEntry(ruleId) {
    return (this._byId ??= new Map(
      this.allEntries().map((e) => [stem(e.check), e])
    )).get(ruleId);
  }

  /**
   * EVERY entry a ruleId can resolve to: the linked checks of every phase and the by-hand
   * manual ones. checkEntry() indexes exactly this set, so anything asked of "an entry" is
   * asked here and no list of them can be missed by asking only one.
   *
   * A manual-checks entry is marked `manualCheck`, which is the one thing its shape does
   * not say: it is listed by being declared rather than by raising a case, so it belongs
   * to no escalation section at all.
   * @returns {object[]}
   */
  allEntries() {
    return [
      ...this.checkEntries(),
      ...(this.doc["manual-checks"] || []).map((e) => ({
        ...e,
        manualCheck: true,
      })),
    ].filter((e) => e && typeof e.check === "string" && e.check);
  }

  /**
   * Ids of every linked check, across every phase section (for the --checks-only /
   * --checks-skip help).
   * @returns {string[]}
   */
  checkIds() {
    return this.checkEntries().map((e) => stem(e.check));
  }

  /**
   * The permission-prompts token vocabulary, projected for the check that scans the
   * add-on for it. Deliberately narrow: the token entries only - wording stays the
   * report layer's business, so a check has no window into any entry's prose or
   * severity.
   * @returns {object[]}
   */
  permissionTokens() {
    return (this._permissionTokens ??= this.permissionPrompts().map(
      ({ permissions, tokens, minStrictVersion, maxStrictVersion }) => ({
        permissions,
        tokens,
        minStrictVersion,
        maxStrictVersion,
      })
    ));
  }

  /**
   * The artifact a check's OUTPUT is labelled as ([XPI]/[SCA]): the corpus it acts
   * on, which is the one it runs on, so its declared `input` is the label.
   * @param {string} ruleId
   * @returns {"xpi"|"build"|"source"|"manifest"}
   */
  labelInputFor(ruleId) {
    return this.checkEntry(ruleId)?.input ?? "source";
  }

  /**
   * The label artifact per ruleId (a `Map<ruleId, "xpi"|"build"|"source"|"manifest">`),
   * projected for the report layer so it can label a finding's file:line by
   * artifact ([XPI]/[SCA]) without touching the registry. Keyed off labelInputFor
   * (the corpus the check acts on).
   * @returns {Map<string, string>}
   */
  checkInputs() {
    return new Map(
      this.checkEntries().map((e) => {
        const id = stem(e.check);
        return [id, this.labelInputFor(id)];
      })
    );
  }

  /**
   * The by-hand to-do items: every `manual-checks` entry, already in the rendered
   * {title, instructions, response} shape (these carry no `{{item}}`). Emitted
   * unconditionally for every review - what a check ESCALATES is surfaced by the
   * orchestrator (escalation.js), not here.
   * @returns {{title: string, instructions?: string, response: ?string, ruleId: string,
   *   verdict: ?string}[]}
   */
  manualChecks() {
    return this.allEntries()
      .filter((e) => e.manualCheck)
      .map((e) => ({
        title: e.title,
        instructions: e.instructions,
        response: e.response ?? null,
        // The same two fields a rendered escalation carries, so the three to-do
        // sections are one kind of item with three origins: settling any of them
        // shows the band it lands in, and a verdict can report or clear it.
        ruleId: e.check,
        verdict: this.suggestedVerdict(e.check),
      }));
  }

  /**
   * The `check:` ids of the manual-checks entries. These are id metadata only -
   * the canonical id for each manual check (matching its docs/checks/<id>.html
   * page) - NOT runnable checks: they have no rule module and are deliberately
   * excluded from checkIds()/checkEntries(), so --checks-only/--checks-skip do
   * not act on them. Used for cross-referencing (docs, consistency tests).
   * @returns {string[]}
   */
  manualCheckIds() {
    return this.allEntries()
      .filter((e) => e.manualCheck)
      .map((e) => e.check);
  }

  /**
   * The heading shown above each severity group in the Found Issues section, as a
   * severity -> string map. Every severity has one and no other key is authored:
   * assertProse asks the registry for exactly that closed set when it is read.
   * @returns {Record<string, string>}
   */
  issueHeadings() {
    const h = this.doc["issue-headings"];
    return h && typeof h === "object" ? h : {};
  }

  /**
   * The customer-facing verdict preamble for the Found Issues section, as a VERDICT_KEYS
   * -> string map: `none` when there are no findings, `rejected` when any is an error,
   * `hold` when one is a hold and none is an error, `feedback` otherwise. All four are
   * authored and no other key is: assertProse asks for that closed set at load.
   * @returns {Record<string, string>}
   */
  verdictIntros() {
    const v = this.doc["verdict-intros"];
    return v && typeof v === "object" ? v : {};
  }

  /**
   * The severity a REPORTED case of this check carries: its entry's `severity`, or
   * null when that is `none` (nothing to suggest - settling the case produces no
   * finding) or a value no finding can carry. The report prints it beside the
   * escalation's suggested response, so whoever settles the case can see which band
   * it lands in before they send that text.
   * @param {string} ruleId
   * @returns {?string}
   */
  /**
   * How this check's repeated cases are listed - its entry's `collapse`, or null for the
   * default of one line per case. Read once per item when the review is rendered
   * (src/report/responses.js) and carried on the item, so the sequence that numbers the
   * review (src/report/order.js) needs no registry of its own and every caller of it
   * cannot help but order the same way.
   * @param {string} ruleId
   * @returns {?string}
   */
  collapseOf(ruleId) {
    return this.checkEntry(ruleId)?.collapse ?? null;
  }

  suggestedVerdict(ruleId) {
    const s = this.checkEntry(ruleId)?.severity;
    // A hold-or-error case is suggested as the hold it is on its own. It only becomes
    // an error alongside a real one, and that is not this case's own weight.
    if (s === HOLD_OR_ERROR) {
      return SEVERITY.HOLD;
    }
    return isConcreteSeverity(s) ? s : null;
  }

  /**
   * The sweep instruction a check authors for its own blind spot, or null.
   *
   * A check scans for what it can name, and code outside that boundary leaves no trace to
   * key on - an enumerated set of transmission APIs says nothing about the sender it does
   * not list. Where the boundary cannot be closed by naming more, the check authors an
   * instruction for a reader instead, and what the reader finds belongs to THIS check -
   * routed the way that check routes its own cases: to a finding in its band and its
   * words, or to the question its instructions ask. Presence is the whole declaration: a check with no blind
   * spot authors none.
   * @param {string} ruleId
   * @returns {?string}
   */
  sweepInstruction(ruleId) {
    const t = this.checkEntry(ruleId)?.["sweep-instruction"];
    return typeof t === "string" && t !== "" ? t : null;
  }

  /**
   * The sweep framing for one reader: "human" (printed in the report) or "llm" (sent to
   * the agent that does the reading under --llm-review).
   *
   * Two texts rather than one, because the readers part on what happens next: the agent
   * hands its results back in a fixed shape for the verdict file, a reviewer just writes
   * the review. Both are required whenever any check authors an instruction - a sweep
   * read without its framing is a list of subjects with no method, which is the
   * enumeration the sweeps exist to escape.
   * @param {"human"|"llm"} reader
   * @returns {string}
   */
  sweepIntro(reader) {
    return this.doc[`sweep-intro-${reader}`];
  }

  /**
   * Every check that authors a sweep instruction, in registry order - which is the order
   * the report and every phase list them in, so the two agree.
   * @returns {{check: string, title: string, severity: string, instruction: string,
   *   response: ?string}[]}
   */
  sweepInstructions() {
    return this.checkEntries()
      .map((e) => ({ entry: e, id: stem(e.check) }))
      .filter(({ id }) => this.sweepInstruction(id))
      .map(({ entry, id }) => ({
        check: id,
        title: entry.title,
        // Non-null for every entry that reaches here: the registry assert refuses a
        // sweep instruction on a check with no band to stamp a reported case with.
        severity: this.suggestedVerdict(id),
        instruction: this.sweepInstruction(id),
        // What the developer would be told if the sweep finds something - the same text
        // a reported case is worded with. For the REPORT only: the agent hands back a
        // locus and the routing is the linter's, so it has no use for the wording and is
        // told not to produce any.
        response: entry.response ?? null,
      }));
  }

  /**
   * The REVIEW LOOP's prompts: the four texts the linter owns, and the phases it hands out
   * one per pass.
   *
   * `preamble`, `frame`, `handover`, `refused` and `final` are the linter's - authored once
   * and printed the same way every time, so no phase can forget to say how to hand back, or
   * that the file has changed since the last pass. The phases author only what differs:
   * their `intro` (often empty) and their `steps`.
   *
   * A step's marker comes back as null when it carries none, the same shape the SCA
   * prompt's steps come back in, so the caller filters by one shape: `skip` against the flags the run was given,
   * `run` against the conditions this review meets.
   * @returns {{preamble: string, frame: string, handover: string, refused: string,
   *   final: string, phases: {name: string, verbs: string[], intro: string,
   *   steps: {skip: ?string, run: ?string, text: string}[]}[]}}
   */
  llmPhases() {
    const p = this.doc["llm-phases"];
    return {
      preamble: p.preamble,
      frame: p.frame,
      handover: p.handover,
      refused: p.refused,
      final: p.final,
      phases: p.phases.map((phase) => ({
        name: phase.name,
        answer: phase.answer,
        verbs: [...phase.verbs],
        intro: phase.intro,
        steps: phase.steps.map((step) => ({
          skip: step.skip ?? null,
          run: step.run ?? null,
          text: step.text,
        })),
      })),
    };
  }

  /**
   * The answers a manual review question offers, in the order the reviewer sees them.
   *
   * Each carries the `label` and `description` the reviewer reads and the `verdict` it
   * settles the item with - the last of which never leaves this process: the entry the
   * agent relays carries the first two, the answer comes back as the reviewer gave it,
   * and mapping it to a verdict happens here. Read once per review, and required: a question with no
   * answers to offer cannot be asked.
   * @returns {{label: string, verdict: string, description: string}[]}
   */
  manualReviewChoices() {
    return this.doc["llm-manual-review-choices"].map((c) => ({
      label: c.label,
      verdict: c.verdict,
      // `{{maxNote}}` is the one number in this text the linter owns: the limit it refuses
      // an answer past. Filled here so the reviewer is told what is enforced, rather than
      // what someone typed into the yaml alongside it.
      description: c.description.replace("{{maxNote}}", String(MAX_NOTE)),
    }));
  }

  /**
   * The note a REPORTED case of this check carries when the reviewer gave none, or null.
   *
   * Authoring one declares that the check's report IS what the reviewer found: its
   * response ends on a list, and the list is their words. The fallback keeps that list
   * from being empty - a marker the reviewer completes after pasting - and a check that
   * authors none never gets a note it was not given.
   * @param {string} ruleId
   * @returns {?string}
   */
  defaultNote(ruleId) {
    const note = this.checkEntry(ruleId)?.["default-note"];
    return typeof note === "string" && note !== "" ? note : null;
  }

  /**
   * The texts of the --llm-sca-review prompt: the intro, and the ordered steps that turn a
   * submission folder into the arguments an SCA review needs. Read only when that flag is
   * set, and both are required then - a run whose whole output is this prompt has nothing
   * to print without them.
   *
   * A step comes back with the `run` condition it is marked with, never filtered here:
   * which steps a run prints is layout, decided in src/report/format.js beside the flags
   * themselves. `run: experiments` marks a step that asks for the Experiment folder, which
   * only a review allowing Experiments reads - so it is printed only when one does.
   * @returns {{intro: string, outcome: {run: ?string, text: string}[]}}
   */
  llmScaReviewPrompt() {
    const p = this.doc["llm-sca-review-prompt"];
    return {
      intro: p.intro,
      // A step's `run` comes back as null when it carries no marker: every run prints it.
      // `run: experiments` asks for the Experiment folder, which only a review allowing
      // Experiments reads - so it comes back marked, and the renderer drops it when it
      // would ask for a value nothing will use.
      outcome: p.outcome.map((step) => ({
        run: step.run ?? null,
        text: step.text,
      })),
    };
  }

  /**
   * The Found Issues response template for a finding's ruleId: the owning check's
   * `response`, or a system `messages` entry for an orchestrator-emitted ruleId
   * (e.g. "check-failed"). Null if neither exists.
   * @param {string} ruleId
   * @returns {?string}
   */
  responseFor(ruleId) {
    const r = this.checkEntry(ruleId)?.response;
    return typeof r === "string" ? r : (this.message(ruleId) ?? null);
  }

  /**
   * The to-do wording a PERSON reads for a ref of this rule: the check's
   * `instructions-for-human`, or its `instructions` where one text serves either reader.
   * One text per check, because a check's cases all ask the same question.
   *
   * Raises rather than returning null. Every escalation has a human reader - a review with
   * no agent in it puts each one to a reviewer - so a check that raised a to-do and
   * authors no text a person can read is a bug in whatever raised it, and the alternative
   * is an item printed with nothing to answer.
   * @param {string} ruleId
   * @returns {string}
   */
  instructionsFor(ruleId) {
    const entry = this.checkEntry(ruleId);
    const text = entry?.["instructions-for-human"] ?? entry?.instructions;
    // Not a registry-shape rule, which is why it is asked here and not in assertRegistry:
    // a check that never escalates authors no wording and is right not to. What is wrong
    // is a to-do REF naming such a check.
    if (typeof text !== "string" || text === "") {
      throw new Error(
        `"${entry?.title ?? ruleId}" raised a to-do item but authors no ` +
          "`instructions-for-human` or `instructions` (assets/registry.yaml)"
      );
    }
    return text;
  }

  /**
   * Which to-do section a case this check escalates is listed under, derived from WHO its
   * question is for rather than declared: a check that authors wording an agent can be
   * handed is screened, so its cases are a code review step; one that authors only a
   * question for a person is a manual one.
   *
   * Null when the check authors no wording at all - it never escalates - and null for a
   * manual-checks entry, which is a to-do rather than a check that raises one and so is
   * listed by being declared, not by a section.
   * @param {string} ruleId
   * @returns {?string}
   */
  sectionFor(ruleId) {
    const entry = this.checkEntry(ruleId);
    if (!entry || entry.manualCheck) {
      return null;
    }
    const authored = (key) =>
      typeof entry[key] === "string" && entry[key] !== "";
    if (authored("instructions") || authored("instructions-for-llm")) {
      return SECTION.CODE_REVIEW;
    }
    return authored("instructions-for-human") ? SECTION.MANUAL_REVIEW : null;
  }

  /**
   * The wording an AGENT is handed for a ref of this rule: the check's
   * `instructions-for-llm`, or its `instructions` where one text serves either reader.
   *
   * Null where the other accessor raises, and the asymmetry is the point: a check may
   * author a question only a person can answer, and such a check is never screened - its
   * cases route to the phase that asks a reviewer, so nothing downstream asks it for a
   * text it does not have.
   * @param {string} ruleId
   * @returns {?string}
   */
  llmInstructionsFor(ruleId) {
    const entry = this.checkEntry(ruleId);
    const text = entry?.["instructions-for-llm"] ?? entry?.instructions;
    return typeof text === "string" && text !== "" ? text : null;
  }

  /**
   * A system-notice template (the top-level `messages` map), or null.
   * @param {string} key
   * @returns {?string}
   */
  message(key) {
    const m = this.doc.messages;
    const t = m && typeof m === "object" ? m[key] : null;
    return typeof t === "string" ? t : null;
  }

  /**
   * The per-permission-group token entries (top-level `permission-prompts` list),
   * with the comma-separated `permissions` parsed to an array, the optional
   * inclusive Thunderbird version bounds surfaced, and the optional usage `tokens`
   * (the code-level spellings that justify the permission; an entry without tokens is
   * deterministically undecidable - unused-permission then always escalates its
   * permissions).
   * @returns {{permissions: string[], tokens: string[],
   *   minStrictVersion: ?string, maxStrictVersion: ?string}[]}
   */
  permissionPrompts() {
    return (this.doc["permission-prompts"] || [])
      .filter((e) => e && e.permissions != null)
      .map((e) => ({
        permissions: String(e.permissions ?? "")
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean),
        // Filter BEFORE stringifying: String(null) is the truthy "null", which
        // would match almost any code and silently disable the entry's
        // deterministic verdict.
        tokens: Array.isArray(e.tokens)
          ? e.tokens.filter((t) => t != null && t !== "").map((t) => String(t))
          : [],
        // Coerce to string so an unquoted numeric bound (min_strict_version: 154)
        // still parses - a bare YAML number would otherwise slip past parseVersion
        // and silently void the bound (see versionInBounds).
        minStrictVersion:
          e.min_strict_version != null ? String(e.min_strict_version) : null,
        maxStrictVersion:
          e.max_strict_version != null ? String(e.max_strict_version) : null,
      }));
  }
}

/**
 * Assert every section the review reads has entries: the phases in PHASE_SECTIONS, and
 * `manual-checks`.
 * The sections ARE the control flow: runChecks looks each phase up BY NAME and runs
 * whatever it finds, and the report lists whatever `manual-checks` holds. So a renamed or
 * misspelled section does not fail loudly - it yields an empty list, and nothing downstream
 * can tell that apart from "this phase has no checks" or "this review asks nothing". This
 * turns it into a loud abort. Asked of a whole registry only, never of a caller's partial
 * one; exported so the guard can be tested directly against a synthetic doc.
 * @param {Record<string, unknown>} doc  The parsed registry document.
 * @param {string} registryPath  For the error message.
 */
export function assertRequiredPhaseSections(doc, registryPath) {
  // `manual-checks` is asked for beside the phases because it is the same failure: it is
  // the ONLY source of the Standard Manual Review questions, it is listed in every review,
  // and an absent one reads as "this review has no questions" rather than as a typo.
  for (const section of [...Object.values(PHASE_SECTIONS), "manual-checks"]) {
    const list = doc[section];
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(
        `Registry ${registryPath}: the section "${section}" is missing or empty. ` +
          "Every section the review reads must declare its entries - an absent one would " +
          "silently drop that whole list from every review."
      );
    }
  }
}

/**
 * Assert one check entry's declarative contract - everything about it that is decided by
 * the yaml alone, whatever this run was asked to check.
 *
 * Asked of every entry the registry declares, whatever this run was told to check: a rule
 * that only holds for the entries a run happens to load is a rule the next run can break.
 * @param {object} entry  From registry.allEntries(), so a manual check is marked.
 * @param {string} at  The registry path, for the message.
 */
function assertEntry(entry, at) {
  const id = stem(entry.check);
  // A rule entry names its module; a manual check has none, so it is named by its id.
  const where = entry.manualCheck
    ? `Registry ${at}: the manual-checks entry "${id}"`
    : `rules/${id}.js`;
  if (typeof entry.title !== "string" || entry.title === "") {
    throw new Error(
      `${where} authors no \`title\` - it is how the entry is named wherever it is listed` +
        (entry.manualCheck
          ? ", and an untitled one is dropped from the review"
          : "")
    );
  }
  // Declared, never defaulted: a check's impact is configuration, so an entry that
  // omits it is a registry mistake rather than a request for the strictest value.
  // An escalate-only check declares one too - it says what a finding from it would
  // mean, should the check ever gain one.
  const severity = entry.severity;
  if (!VALID_CHECK_SEVERITIES.has(severity)) {
    throw new Error(
      `${where} has a missing or invalid severity ${JSON.stringify(severity)} ` +
        `(expected one of: ${[...VALID_CHECK_SEVERITIES].join(", ")})`
    );
  }
  for (const flag of ["sca", "eslint"]) {
    if (entry[flag] !== undefined && typeof entry[flag] !== "boolean") {
      throw new Error(
        `${where} has a non-boolean \`${flag}\` ${JSON.stringify(entry[flag])} - it is a ` +
          "gate, and anything else silently reads as false"
      );
    }
  }
  // Whether the entry authors wording a PERSON could be asked - `instructions-for-human`,
  // or an `instructions` that serves either reader. Both branches below are about that
  // reader: a manual check is only ever put to one, and an escalation must be answerable
  // in a review with no agent in it.
  const authored = (key) => typeof entry[key] === "string" && entry[key] !== "";
  const forLlm = authored("instructions-for-llm");
  const forHuman = authored("instructions-for-human");
  const wording = forHuman || authored("instructions");
  // A manual check IS a to-do item rather than a check that raises one, so it declares no
  // `escalation` and no `input`: it reads no artifact and lists its case unconditionally.
  if (entry.manualCheck) {
    if (!wording) {
      throw new Error(
        `${where} authors no \`instructions\` - the question a reviewer answers IS the entry`
      );
    }
    for (const key of ["escalation", "input", "sweep-instruction"]) {
      if (entry[key] !== undefined) {
        throw new Error(
          `${where} authors \`${key}\`, which only a check that RUNS can carry - a ` +
            "manual-checks entry lists its case unconditionally and reads no artifact"
        );
      }
    }
  } else {
    // A check does not declare where its cases are listed. It declares WHO its question
    // is for, by which wording it authors, and the section follows from that (sectionFor).
    // So an `escalation` here is a declaration nothing reads, and is refused rather than
    // ignored: an entry that means something other than what it says is worse than one
    // that fails to load.
    if (entry.escalation !== undefined) {
      throw new Error(
        `${where} declares \`escalation\`, which nothing reads - a check names its ` +
          "READER instead, by authoring `instructions` (one text, either reader), " +
          "`instructions-for-llm` beside `instructions-for-human` (one question each), " +
          "or `instructions-for-human` alone"
      );
    }
    // The three shapes, and the fourth that is refused. Both failures below would
    // otherwise surface only when a case first reached them, which may be never.
    if (authored("instructions") && (forLlm || forHuman)) {
      throw new Error(
        `${where} authors \`instructions\` beside ` +
          `\`instructions-for-${forLlm ? "llm" : "human"}\` - \`instructions\` IS the ` +
          "text for either reader, so a second one is not an override but two answers to " +
          "one question"
      );
    }
    if (forLlm && !forHuman) {
      throw new Error(
        `${where} authors \`instructions-for-llm\` with no text a person can be asked. ` +
          "A review with no agent in it puts every escalation to a reviewer, so this " +
          "check's cases would be unaskable there, and a case the agent declines to " +
          "settle would have nowhere to land. Author `instructions-for-human` beside it, " +
          "or `instructions` for one text serving either reader"
      );
    }
    // Optional, and a typo would otherwise read as "the default" - silently listing every
    // case where the entry asked for one line per subject.
    const collapse = entry.collapse;
    if (collapse !== undefined && !COLLAPSE_MODES.has(collapse)) {
      throw new Error(
        `${where} has an invalid \`collapse\` ${JSON.stringify(collapse)} ` +
          `(expected one of: ${[...COLLAPSE_MODES].join(", ")})`
      );
    }
    // Every check must declare a valid `input`, which drives runOneCheck's artifact
    // routing (routing is total - there is no default artifact to fall through to).
    const input = entry.input;
    if (!VALID_CHECK_INPUTS.has(input)) {
      throw new Error(
        `${where} is missing a valid \`input\` (got ${JSON.stringify(input)}; ` +
          `expected one of: ${[...VALID_CHECK_INPUTS].join(", ")}). ` +
          "Every check must declare which add-on artifact it reads (source = the " +
          "review target, xpi = the built XPI, build = the SCA build files, " +
          "manifest = the shipped manifest only)."
      );
    }
    // An `input: build` check reads the SCA build corpus, which exists ONLY in an SCA review -
    // so it MUST carry `sca: true`. Without it the check also runs in an XPI review, where the
    // build sibling is undefined and routeCtx would THROW (no ctx for input "build"). The
    // `sca: true` gate keeps every build check out of XPI mode; assert it at LOAD time rather
    // than trust the yaml, so the failure is a clear config error, not a mid-review throw.
    if (input === "build" && entry.sca !== true) {
      throw new Error(
        `${where} declares \`input: build\` but not \`sca: true\`. The build corpus ` +
          "exists only in an SCA review; without the gate it would run in an XPI review, where " +
          "routeCtx would throw (there is no build sibling there)."
      );
    }
    assertSweepInstruction(entry, where, severity);
  }
  assertDefaultNote(entry, where);
}

/**
 * A `sweep-instruction` sends a reader after what this check cannot detect, and what they
 * find becomes a case OF this check. Three things must hold for that to be possible, and
 * all three are config, so they fail here rather than when a result first arrives - which
 * may be never.
 *
 * Note what is NOT required: that the check escalate at all. Not because a swept case
 * always becomes a finding - a check that authors wording routes it to whoever that
 * wording is for instead (src/report/sweep.js) - but because a check that authors none
 * has a route all the same, and it is the ordinary one.
 * @param {object} entry
 * @param {string} where  How the entry is named in a message.
 * @param {string} severity  The entry's (already validated) severity.
 */
function assertSweepInstruction(entry, where, severity) {
  const sweepInstruction = entry["sweep-instruction"];
  if (sweepInstruction === undefined) {
    return;
  }
  if (typeof sweepInstruction !== "string" || sweepInstruction.trim() === "") {
    throw new Error(
      `${where} has an invalid \`sweep-instruction\` ` +
        `${JSON.stringify(sweepInstruction)} (expected a non-empty string)`
    );
  }
  // A swept case that is reported is stamped with the check's own band. `auto` leaves the
  // band to each finding and `none` says the check emits none, so neither has one to give
  // - the sweep would return cases nothing could file.
  if (!isConcreteSeverity(severity) && severity !== HOLD_OR_ERROR) {
    throw new Error(
      `${where} authors a \`sweep-instruction\` but its severity ` +
        `${JSON.stringify(severity)} gives a reported case no band to carry`
    );
  }
  // A swept case carries no `item` and no `data`, so a placeholder in the response
  // would reach the developer literally, or leave the message unfilled entirely.
  if (typeof entry.response === "string" && entry.response.includes("{{")) {
    throw new Error(
      `${where} authors a \`sweep-instruction\` but its \`response\` carries a ` +
        "{{placeholder}} - a swept case brings no item to fill it with"
    );
  }
}

/**
 * Authoring a `default-note` declares that this check's report IS what the reviewer found:
 * its response ends on a list, and the marker stands in that list when they reported the
 * case without writing one.
 *
 * So it must be prose: an empty one leaves the response ending on a list introduction with
 * nothing beneath it, which is the defect the fallback exists to prevent.
 *
 * WHO the case was put to is not asked here. The marker is only ever consulted for a case
 * that was reported (src/report/verdicts.js), and a check that authors one is saying what
 * its response needs when nobody wrote the list - which is true of a case an agent settled
 * as much as of one a reviewer did.
 * @param {object} entry
 * @param {string} where  How the entry is named in a message.
 */
function assertDefaultNote(entry, where) {
  const note = entry["default-note"];
  if (note === undefined) {
    return;
  }
  if (typeof note !== "string" || note.trim() === "") {
    throw new Error(
      `${where} has an invalid \`default-note\` ${JSON.stringify(note)} ` +
        "(expected a non-empty string)"
    );
  }
}

/**
 * Assert every entry the registry declares, in one walk over the one set a ruleId can
 * resolve to - so no list of entries can be missed by asking only one of them.
 *
 * The id rule lives here because it is the same walk: one rule module is one entry in one
 * phase, and a manual check may not take a rule's id either. A second declaration would run
 * the check twice, and worse, the id -> entry index (a Map, keyed by that stem, and the
 * only way a finding - which carries just a ruleId - reaches its severity and response
 * text) would resolve to the LAST declaration: a duplicate can silently restamp a real
 * check's `error` as `info`.
 * @param {Registry} registry
 * @param {string} at  The registry path, for the message.
 */
export function assertEntries(registry, at) {
  // The id first, and asked of the RAW lists: allEntries() drops an entry that authors no
  // `check`, so asking this of its result asks it only of the entries that already passed.
  // An entry with no id is a check that never runs - or, in manual-checks, a to-do printed
  // in every review that no verdict can name and no reviewer can settle into anything.
  for (const [section, list] of [
    ...Object.values(PHASE_SECTIONS).map((name) => [name, registry.doc[name]]),
    ["manual-checks", registry.doc["manual-checks"]],
  ]) {
    for (const [i, entry] of (list ?? []).entries()) {
      const nth = `Registry ${at}: ${section} entry ${i + 1}`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`${nth} is not a mapping`);
      }
      if (typeof entry.check !== "string" || entry.check.trim() === "") {
        throw new Error(
          `${nth} ("${entry.title ?? "untitled"}") authors no \`check\` - it is the id ` +
            "everything else addresses the entry by"
        );
      }
    }
  }
  const seen = new Set();
  for (const entry of registry.allEntries()) {
    const id = stem(entry.check);
    if (seen.has(id)) {
      throw new Error(
        `Registry ${at}: the check "${id}" is declared more than once. One rule module is ` +
          "one entry in one phase - a second declaration runs it again, and the id -> " +
          "entry lookup that stamps every finding's severity and response would silently " +
          "resolve to the last one."
      );
    }
    seen.add(id);
    assertEntry(entry, at);
  }
}

/**
 * Assert one authored prompt step: what BOTH prompts need of one, because both render
 * through the same layout (stepLines, src/report/format.js).
 *
 * A step must be a mapping carrying prose, and it must not number itself: the renderer
 * numbers what survived that run's own filtering, so a literal number would print twice
 * and the second one would be wrong as soon as anything above it was withheld.
 *
 * It may carry ONE marker, from those its own prompt acts on, and nothing else. Each
 * prompt reads only its own - `skip` and `run` here, `run` there - so any other key is
 * dropped at load and the step prints in every run: a typo of a marker, or the other
 * prompt's marker, both read as a step that was never marked.
 *
 * ONE of them, never two: what withholds a step is a single answer, so a reader works out
 * whether a step prints by looking at one marker rather than composing two.
 * @param {unknown} step
 * @param {number} i  Its position, for the message.
 * @param {string} where  Which prompt, for the message.
 * @param {string[]} markers  The markers this prompt acts on.
 */
function assertStep(step, i, where, markers) {
  const nth = `${where} \`outcome\` step ${i + 1}`;
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    throw new Error(`${nth} is not a step mapping`);
  }
  if (typeof step.text !== "string" || step.text === "") {
    throw new Error(`${nth} authors no \`text\``);
  }
  if (/^\d+[.)]\s/.test(step.text)) {
    throw new Error(
      `${nth} numbers itself; the prompt numbers the steps it prints, so an authored ` +
        "number would render twice"
    );
  }
  const named = markers.map((m) => `\`${m}\``).join(" or ");
  const stray = Object.keys(step).find(
    (key) => key !== "text" && !markers.includes(key)
  );
  if (stray) {
    throw new Error(
      `${nth} authors \`${stray}\`, which this prompt cannot act on (expected ` +
        `${named}) - the step would print in every run`
    );
  }
  const carried = markers.filter((m) => step[m] !== undefined);
  if (carried.length > 1) {
    throw new Error(
      `${nth} carries ${carried.map((m) => `\`${m}\``).join(" and ")} - a step takes ` +
        "ONE marker, or whether it prints depends on two answers at once"
    );
  }
}

/** What `run:` can name in each prompt: the things about a run that decide whether a step
 *  of it is printed. No flag spells these - unlike PROMPT_SKIPS, which the CLI offers - so
 *  they live here, beside the messages that name them. */
const REVIEW_PROMPT_RUNS = ["sca", "sweep"];

/**
 * The loop texts the LINTER owns, and the placeholder each one exists to carry. An empty
 * slot means the text names no value - it is the same words every pass.
 */
const PHASE_TEXTS = {
  preamble: "",
  frame: "{{review}}",
  handover: "{{command}}",
  refused: "{{problem}}",
  final: "",
};

/**
 * Every verdict the loop knows. A PHASE accepts a subset of these, declared beside its
 * steps - `verify` takes `reported`/`withdrawn`, `settle` takes `reported`/`cleared`/`ask` -
 * because what an answer may be is a property of the phase, never of the file's shape.
 */
const LOOP_VERBS = VERB_NAMES;

/** What one entry of a phase is answered WITH, which decides the shape the entry is handed
 *  over in and what the linter accepts back: `hints` is what a sweep found, a list per
 *  check; `verdict` is one of the phase's own verbs; `words` is a person's answer, theirs
 *  to write and not ours to judge. Named as data because the loop reads it rather than the
 *  phase's name - a phase carries its vocabulary AND the kind of answer that vocabulary
 *  belongs to, and neither is inferred from what it is called. */
const ANSWER_KINDS = ["hints", "verdict", "words"];

/** The one condition the SCA prompt can evaluate: whether this review allows
 *  Experiments, which decides whether it asks its reader for --sca-exp-source. */
const SCA_PROMPT_RUNS = ["experiments"];

/**
 * The REVIEW LOOP's texts, checked at load: the five the linter owns, and every phase's
 * intro and steps.
 *
 * The placeholders are checked because each one is the only way a value reaches the agent:
 * a `handover` with no `{{command}}` leaves it holding a decision and no way to hand it
 * back, and a `frame` with no `{{review}}` names no file at all.
 *
 * `verbs` is checked BOTH WAYS against the phase's own steps. A verb the phase accepts but
 * no step names is one the agent is never told it may use; a verb a step names but the
 * phase does not accept is one the agent will be refused for using. Either is a drafting
 * error, and neither is visible by reading one of the two alone.
 * @param {Registry} registry
 * @param {string} at
 */
export function assertPhases(registry, at) {
  const doc = registry.doc["llm-phases"];
  const where = `llm-phases (${at})`;
  if (!doc || typeof doc !== "object") {
    throw new Error(`${where} authors no loop prompts`);
  }
  for (const [key, slot] of Object.entries(PHASE_TEXTS)) {
    if (typeof doc[key] !== "string" || doc[key] === "") {
      throw new Error(`${where} authors no \`${key}\``);
    }
    if (slot && !doc[key].includes(slot)) {
      throw new Error(
        `${where} \`${key}\` carries no ${slot} - the linter fills it there, and nothing ` +
          "else names that value"
      );
    }
  }
  const phases = doc.phases;
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new Error(`${where} authors no \`phases\``);
  }
  const seen = new Set();
  for (const phase of phases) {
    const name = phase?.name;
    if (typeof name !== "string" || name === "") {
      throw new Error(`${where} authors a phase with no \`name\``);
    }
    if (seen.has(name)) {
      throw new Error(`${where} authors \`${name}\` twice`);
    }
    seen.add(name);
    const at2 = `${where} phase \`${name}\``;
    if (typeof phase.intro !== "string") {
      throw new Error(
        `${at2} authors no \`intro\` (empty string when it needs none)`
      );
    }
    if (!ANSWER_KINDS.includes(phase.answer)) {
      throw new Error(
        `${at2} authors \`answer: ${phase.answer}\`, which is not a kind of answer this ` +
          `review knows (expected one of: ${ANSWER_KINDS.join(", ")})`
      );
    }
    // A verdict phase states its vocabulary; the other two take no verb, and a verb
    // authored beside them would never be offered to anyone.
    if ((phase.answer === "verdict") !== phase.verbs?.length > 0) {
      throw new Error(
        `${at2} answers with \`${phase.answer}\` but accepts \`${(phase.verbs ?? []).join(", ")}\` - ` +
          "only a `verdict` phase names verbs, and it must name at least one"
      );
    }
    if (!Array.isArray(phase.verbs)) {
      throw new Error(
        `${at2} authors no \`verbs\` (empty list when it takes none)`
      );
    }
    for (const verb of phase.verbs) {
      if (!LOOP_VERBS.includes(verb)) {
        throw new Error(
          `${at2} accepts \`${verb}\`, which is not a verdict this review knows ` +
            `(expected one of: ${LOOP_VERBS.join(", ")})`
        );
      }
    }
    if (!Array.isArray(phase.steps) || phase.steps.length === 0) {
      throw new Error(`${at2} authors no \`steps\``);
    }
    phase.steps.forEach((step, i) => {
      assertStep(step, i, `llm-phases phase \`${name}\``, ["skip", "run"]);
      if (step.skip !== undefined && !PROMPT_SKIPS.includes(step.skip)) {
        throw new Error(
          `${at2} step ${i + 1} is skipped by \`${step.skip}\`, which no flag gives ` +
            `(expected one of: ${PROMPT_SKIPS.join(", ")})`
        );
      }
      if (step.run !== undefined && !REVIEW_PROMPT_RUNS.includes(step.run)) {
        throw new Error(
          `${at2} step ${i + 1} runs on \`${step.run}\`, which this prompt cannot ` +
            `evaluate (expected one of: ${REVIEW_PROMPT_RUNS.join(", ")})`
        );
      }
    });
    // Both ways, over the phase's own step text. A verb is named the way the agent reads
    // it: quoted, as `"reported"`.
    const prose = phase.steps.map((x) => x.text).join("\n");
    for (const verb of phase.verbs) {
      if (!prose.includes(`"${verb}"`)) {
        throw new Error(
          `${at2} accepts \`${verb}\` but no step names it, so the agent is never told ` +
            "it may answer that"
        );
      }
    }
    for (const verb of LOOP_VERBS) {
      if (prose.includes(`"${verb}"`) && !phase.verbs.includes(verb)) {
        throw new Error(
          `${at2} names \`${verb}\` in a step but does not accept it, so the agent ` +
            "would be refused for doing what it was told"
        );
      }
    }
  }
}

/**
 * The --llm-sca-review prompt, checked at load.
 *
 * Its whole output is that prompt - no review runs beside it - so a missing key is a run
 * with nothing to print, and it refuses rather than printing half an instruction.
 * @param {Registry} registry
 * @param {string} at
 */
export function assertScaPrompt(registry, at) {
  const sca = registry.doc["llm-sca-review-prompt"];
  const scaAt = `llm-sca-review-prompt (${at})`;
  if (!sca || typeof sca !== "object") {
    throw new Error(`${scaAt} authors no prompt`);
  }
  if (typeof sca.intro !== "string" || sca.intro === "") {
    throw new Error(`${scaAt} authors no \`intro\``);
  }
  const scaSteps = sca.outcome;
  if (!Array.isArray(scaSteps) || scaSteps.length === 0) {
    throw new Error(`${scaAt} authors no \`outcome\` steps`);
  }
  scaSteps.forEach((step, i) => {
    assertStep(step, i, "llm-sca-review-prompt", ["run"]);
    // Checked against what this prompt can EVALUATE, the way `skip` is checked against the
    // flags that give it: the marker decides whether the step is printed at all, so a
    // condition nothing answers would print it in every run - which is the one case a
    // reader cannot tell from a step that was never marked.
    if (step.run !== undefined && !SCA_PROMPT_RUNS.includes(step.run)) {
      throw new Error(
        `llm-sca-review-prompt \`outcome\` step ${i + 1} has \`run: ${step.run}\`, which ` +
          `this prompt cannot evaluate (expected one of: ${SCA_PROMPT_RUNS.join(", ")}) ` +
          `(${at})`
      );
    }
  });
}

/**
 * Assert the answers a manual review question offers: each authors the label and the
 * description a reviewer reads, and the verdict the linter settles it with - which never
 * leaves the linter, but without it an answer settles nothing.
 * @param {Registry} registry
 * @param {string} at  The registry path, for the message.
 */
export function assertChoices(registry, at) {
  const choices = registry.doc["llm-manual-review-choices"];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error(`llm-manual-review-choices authors no answers (${at})`);
  }
  choices.forEach((c, i) => {
    for (const key of ["label", "verdict", "description"]) {
      if (!c || typeof c[key] !== "string" || c[key] === "") {
        throw new Error(
          `llm-manual-review-choices answer ${i + 1} authors no \`${key}\` (${at})`
        );
      }
    }
    // The verdict must NAME one, and one that settles. A word that spells no verb reaches
    // the apply step as nothing at all, where every branch declines it and the case is
    // dropped with no finding - a reviewer's "Report" silently clearing the thing they
    // reported. `ask` is refused for its own reason: it moves an item to the phase that
    // asks a person, and a person is already answering.
    const verb = verbNamed(c.verdict);
    if (!verb || verb === VERB.ask) {
      throw new Error(
        `llm-manual-review-choices answer ${i + 1} settles with \`${c.verdict}\`, which is ` +
          "not a verdict a reviewer's answer can carry " +
          `(expected one of: ${VERB_NAMES.filter((v) => v !== String(VERB.ask)).join(", ")}) (${at})`
      );
    }
  });
}

/**
 * Assert the report's own authored prose: the per-severity Issues headings, the section
 * preamble for each verdict the report can reach, the system-notice templates, and the two
 * sweep introductions.
 *
 * Every one of these is read through an accessor that returns {} or null when it is
 * missing, so a mistyped key does not fail - it prints a section with no heading, a report
 * with no preamble, or a finding with no response.
 *
 * Two of the maps are indexed by a CLOSED vocabulary - a heading per severity, a preamble
 * per verdict the report can reach - so they are asserted against it in both directions: a
 * name the report will look up must be authored, and a name it can never look up is dead
 * yaml, which is how a rename hides (the old key still reads as prose, the new one is
 * missing). `messages` is open, because message() is a lookup by whatever key a caller
 * names, so only the one the report itself reaches is required.
 * @param {Registry} registry
 * @param {string} at  The registry path, for the message.
 */
export function assertProse(registry, at) {
  const maps = [
    ["issue-headings", Object.values(SEVERITY), true],
    ["verdict-intros", VERDICT_KEYS, true],
    ["messages", ["check-failed"], false],
  ];
  for (const [key, required, closed] of maps) {
    const map = registry.doc[key];
    if (!map || typeof map !== "object" || Array.isArray(map)) {
      throw new Error(`registry authors no \`${key}\` map (${at})`);
    }
    for (const name of required) {
      if (typeof map[name] !== "string" || map[name].trim() === "") {
        throw new Error(
          `\`${key}\` authors no \`${name}\` - the report reaches that case and would ` +
            `print nothing for it (${at})`
        );
      }
    }
    for (const [name, text] of Object.entries(map)) {
      if (closed && !required.includes(name)) {
        throw new Error(
          `\`${key}\` authors \`${name}\`, which no report can reach ` +
            `(expected one of: ${required.join(", ")}) (${at})`
        );
      }
      if (typeof text !== "string" || text.trim() === "") {
        throw new Error(
          `\`${key}.${name}\` is not prose ${JSON.stringify(text)} (${at})`
        );
      }
    }
  }
  for (const reader of ["human", "llm"]) {
    const key = `sweep-intro-${reader}`;
    if (
      typeof registry.doc[key] !== "string" ||
      registry.doc[key].trim() === ""
    ) {
      throw new Error(`registry authors no \`${key}\` (${at})`);
    }
  }
}

/**
 * Assert everything the registry says about ITSELF: its entries, the two prompts, the
 * answers a question offers, and the report's authored prose.
 *
 * Called from loadRegistry, so an invalid registry aborts the run that READ it rather than
 * the run that happens to print the part that is wrong. Every rule here is decided by the
 * yaml alone - nothing needs a rule module, a flag, or an add-on - which is why they can
 * all be asked in one place, and why anything that does need one (a module's `run` export,
 * the --eslint gate) stays in loadChecks.
 *
 * `partial` is for a caller naming its OWN file - the unit tests, which declare one section
 * to exercise it in isolation. A partial doc is the point there, so the document-level
 * rules (every phase present, both prompts, the answers, the report's prose) are not asked
 * of it. Its ENTRIES are asked, because an entry is an entry wherever it is declared.
 * @param {Registry} registry
 * @param {string} at  The registry path, for the messages.
 * @param {{partial?: boolean}} [opts]
 */
function assertRegistry(registry, at, { partial = false } = {}) {
  assertEntries(registry, at);
  if (partial) {
    return;
  }
  assertRequiredPhaseSections(registry.doc, at);
  assertPhases(registry, at);
  assertScaPrompt(registry, at);
  assertChoices(registry, at);
  assertProse(registry, at);
}

/**
 * Parse a registry file into a Registry, and assert what it says about itself.
 *
 * Reading it IS asserting it: everything assertRegistry asks is decided by the yaml alone,
 * so a malformed entry, prompt, answer or heading aborts the run that read the file rather
 * than the one that happens to print the part that is wrong. A caller naming its own file -
 * the unit tests, which declare one section on purpose - has its entries asserted and the
 * document-level rules skipped.
 * @param {string} [registryPath]
 * @returns {Registry}
 */
export function loadRegistry(registryPath = DEFAULT_REGISTRY) {
  const registry = new Registry(
    YAML.parse(fs.readFileSync(registryPath, "utf8")) || {}
  );
  assertRegistry(registry, registryPath, {
    partial: registryPath !== DEFAULT_REGISTRY,
  });
  return registry;
}

/**
 * Load and filter the check modules named by the registry, GROUPED BY PHASE - a check's
 * phase is which list it lands in (its registry section), so no LoadedCheck carries one.
 * Every phase in PHASE_SECTIONS gets a list (loadRegistry has already asserted that none of
 * their sections is missing or empty; a list can still come out empty here once the
 * sca gate and --checks-only/--checks-skip have been applied). A `check:` that names a missing
 * module, or a module without a `run` export, throws hard - a broken registry should abort
 * the review, not silently drop a check.
 * @param {Registry} registry
 * @param {object} [opts]
 * @param {string[]} [opts.only]  If set, only these ids load.
 * @param {string[]} [opts.skip]  These ids are excluded.
 * @param {boolean} [opts.eslint]  The `--eslint` flag: an `eslint: true` check (code-sanity)
 *   loads only when set (eslintEligible). Gated here, before the import, so the eslint
 *   dependency is not pulled in when the check will not run.
 * @returns {Promise<Map<string, LoadedCheck[]>>}  Phase -> its checks, in registry order.
 */
export async function loadChecks(registry, { only, skip, eslint } = {}) {
  const onlySet = only?.length ? new Set(only) : null;
  const skipSet = skip?.length ? new Set(skip) : null;
  const byPhase = new Map(Object.keys(PHASE_SECTIONS).map((p) => [p, []]));
  for (const entry of registry.checkEntries()) {
    const id = stem(entry.check);
    if (onlySet && !onlySet.has(id)) {
      continue;
    }
    if (skipSet && skipSet.has(id)) {
      continue;
    }
    // The `--eslint` opt-in gate, applied HERE (unlike the sca gate, which gates in runChecks
    // after the import): code-sanity top-level imports the eslint dependency, so skipping it
    // before the import below avoids loading eslint when it will not run.
    if (!eslintEligible(entry, Boolean(eslint))) {
      continue;
    }
    // `check:` is the check id; the module is rules/<id>.js (a stray trailing
    // ".js" in the id is tolerated by stem()).
    const file = path.join(RULES_DIR, `${id}.js`);
    if (!fs.existsSync(file)) {
      throw new Error(
        `check module not found: rules/${id}.js (referenced by "${entry.title}")`
      );
    }
    const mod = await import(pathToFileURL(file).href);
    const run = mod.default?.run ?? mod.run;
    if (typeof run !== "function") {
      throw new Error(`rules/${id}.js exports no run() function`);
    }
    // Every declarative rule about this entry - severity, input, the escalation pair, the
    // sweep trio, the default note - was asserted when the registry was READ
    // (assertRegistry), where every entry is seen whatever this run was told to check.
    byPhase.get(entry.phase).push({
      id,
      title: entry.title,
      severity: entry.severity,
      input: entry.input,
      sca: typeof entry.sca === "boolean" ? entry.sca : undefined,
      section: registry.sectionFor(id),
      // The permission-prompts token entries, like `instructions` above: registry
      // data every check carries, read by the one that scans for them. It version-filters at run time (versionInBounds) with the reviewed
      // manifest, so every entry is handed over here.
      permissionTokens: registry.permissionTokens(),
      run,
    });
  }
  return byPhase;
}

// Tag column width, sized to the widest "[label]" so the file column aligns. The
// note vocabulary is every VERDICT (fail/pass/unsure judgments + the note-only
// skipped/info); a check's own judgement is only ever
// fail/pass/unsure.
const TAG_WIDTH = Math.max(
  ...Object.values(VERDICT).map((v) => verdictLabel(v).length + 2)
);

// On an interactive screen, a fail note is red, a pass note green, and an unsure
// (escalated) note blue (skipped/info stay plain), keyed by the rendered label. A
// no-op unless the CLI enabled color (color.js).
const VERDICT_COLOR = { fail: red, pass: green, unsure: blue };

/**
 * Format one investigation note for the feed (unindented - the printer applies
 * the DETAIL indent): a padded `[label]` tag then the site (`file:line` when a
 * line is known, else `file`) and the optional item.
 * @param {string} file
 * @param {?{line?: number}} loc
 * @param {?string} item
 * @param {import("../lib/enum.js").Verdict} verdict  A shared VERDICT; its
 *   verdictLabel is the tag rendered here (the one place a verdict becomes text).
 * @param {string} [label]  Artifact label ("XPI"/"SCA") prepended before the site
 *   in an SCA review, else "" (an XPI review has one artifact). See report/artifact.js.
 * @returns {string}
 */
export function formatNote(file, loc, item, verdict, label = "") {
  const status = verdictLabel(verdict); // throws if not a VERDICT
  const at = loc?.line != null ? `${file}:${loc.line}` : file;
  const site = label ? `[${label}] ${at}` : at;
  const line = `• ${`[${status}]`.padEnd(TAG_WIDTH)} ${site}${item ? ` - ${item}` : ""}`;
  return (VERDICT_COLOR[status] ?? ((s) => s))(line);
}

/**
 * Whether a registry entry runs in the current review REVIEW_MODE, per its `sca` field:
 * `sca: true` only in SCA mode (a source code archive,
 * triggered by `--sca-root`), `sca: false` only in XPI mode (reviewing a built
 * add-on), an omitted `sca` in both. The `--sca-root` build and dependency checks are
 * `sca: true`; nothing declares `sca: false` today, and the gate is there for a check
 * that genuinely cannot run on a source archive. It is not a way to exempt a source
 * archive's declared files from review - a declaration nothing verified exempts nothing.
 * @param {{sca?: boolean}} entry @param {boolean} inScaMode
 * @returns {boolean}
 */
function scaEligible(entry, inScaMode) {
  if (entry.sca === true) {
    return inScaMode;
  }
  if (entry.sca === false) {
    return !inScaMode;
  }
  return true;
}

/**
 * Whether a registry entry runs given the `--eslint` flag, per its `eslint` field:
 * `eslint: true` is opt-in - it runs only with `--eslint` - and an
 * omitted `eslint` runs always. Unlike the sca gate this is applied in loadChecks
 * (BEFORE the module import), because the sole `eslint: true` check (code-sanity) top-level
 * imports the heavy `eslint` dependency: gating it here skips that import when it will not run.
 * @param {{eslint?: boolean}} entry @param {boolean} inEslintMode
 * @returns {boolean}
 */
function eslintEligible(entry, inEslintMode) {
  if (entry.eslint === true) {
    return inEslintMode;
  }
  return true;
}

/**
 * The ctx a check runs on: the sibling for its declared `input` artifact. The ONE place
 * artifact routing is decided, so no caller can route differently. Routing is TOTAL and
 * explicit: there is no default artifact to fall through to - `source` is a first-class
 * sibling like the rest.
 *
 * A check declares an `input` and reads ONLY its routed ctx.addon - it has no way to
 * reach another artifact. What `input` resolves to, per review mode:
 *
 *     input \ mode | SCA (readable source + built XPI) | XPI review (one artifact)
 *     -------------+----------------------------------+--------------------------
 *     source       | siblings.source = readable source| siblings.source (the XPI)
 *     xpi          | siblings.xpi = the built XPI      | siblings.xpi (the XPI)
 *     build        | siblings.build = the build files | (sca-only)
 *     manifest     | siblings.manifest                | siblings.manifest
 *
 * In an XPI review there is a single artifact, so siblings.source and siblings.xpi are the
 * SAME ctx (the pipeline aliases siblings.source to xpiCtx). A declared `input` with no
 * matching sibling (e.g. a stray `input: build` in XPI mode) THROWS rather than silently
 * running on the wrong artifact.
 * @param {LoadedCheck} check
 * @param {Record<string, RunContext>} siblings  Keyed by input value (source/xpi/build/manifest).
 * @returns {RunContext}
 */
export function routeCtx(check, siblings) {
  // No `input` => the review-level source ctx. assertEntry requires an input on every
  // check, so this is a floor, not a routing rule.
  if (check.input === undefined) {
    return siblings.source;
  }
  const ctx = siblings[check.input];
  if (!ctx) {
    throw new Error(
      `routeCtx: no ctx for input "${check.input}" (check ${check.id}) - a declared ` +
        "input must have a sibling (an input:build check needs sca:true to stay out of XPI mode)."
    );
  }
  return ctx;
}

/**
 * The ctx whose artifact a RULE'S OUTPUT belongs to - the corpus its findings' file paths
 * live in. It resolves through `registry.labelInputFor`, the same resolution the report's
 * [XPI]/[SCA] labelling uses, so the two can never disagree about a finding.
 *
 * Anything post-processing a check's OUTPUT (the pipeline's folder collapse, the report's
 * labels) must resolve its artifact through here, never through `ctx.addon`: once findings
 * come back as a flat list carrying only a ruleId, the check -> artifact binding routeCtx
 * enforced is gone, and this is the only way to recover it.
 * @param {Registry} registry
 * @param {string} ruleId
 * @param {Record<string, RunContext>} siblings
 * @returns {RunContext}
 */
export function ctxForRule(registry, ruleId, siblings) {
  return siblings[registry.labelInputFor(ruleId)];
}

/**
 * Run the selected checks. A check returns its verdicts as findings, and may
 * also return `escalations` (cases it could not settle), which this orchestrator
 * - the sole authority on manual review - repacks as manual items via escalation.js. Every finding is stamped with the owning
 * check's id and severity (the registry entry is the source of severity, unless it
 * declares `auto`). A check that throws is reported as a
 * system finding and the rest still run.
 * @param {Registry} registry
 * @param {{only?: string[], skip?: string[], eslint?: boolean}} [opts]
 *   `only`/`skip`/`eslint` thread to loadChecks (the `--eslint` opt-in gates code-sanity).
 * @param {Record<string, RunContext>} siblings  The artifact contexts, keyed by the `input`
 *   that routes to each: `source` = the review target (readable source in SCA, the XPI in an
 *   XPI review), `xpi` = the shipped XPI, `build` = the SCA build files, `manifest` = the
 *   shipped manifest (no file corpus). Consumed via routeCtx (the matrix is documented there).
 * @returns {Promise<{findings: object[],
 *   manualItems: {ruleId: string, item: ?string, section: ?string}[],
 *   checksRun: object[]}>}  The finished review: every finding and manual item, and
 *   the checks that ran (for meta.checksRun).
 */
export async function runChecks(registry, opts = {}, siblings) {
  // `siblings` is the whole set of routing ctxs, keyed by input value; there is no separate
  // review-target argument. The review-level state (the base feed note) lives on the source
  // ctx, so name it once here. `source` is required - routing is
  // total, so a siblings map without it is a caller bug, not a run to default around.
  const sourceCtx = siblings?.source;
  if (!sourceCtx) {
    throw new Error(
      "runChecks: siblings.source is required (the review-target ctx)."
    );
  }
  const byPhase = await loadChecks(registry, opts);
  // The `sca` gate (scaEligible) keys off the review mode. A gated-out check never runs
  // and never appears in the feed or meta.checksRun.
  const inScaMode = sourceCtx.mode?.sca;
  // An invalid Experiment short-circuits the whole review to the reject phase and
  // nothing else; a normal review runs the deterministic phase. The gates apply within
  // each phase.
  const inPhase = (phase) =>
    (byPhase.get(phase) ?? []).filter((c) => scaEligible(c, inScaMode));
  const checks = sourceCtx.invalidExperiment
    ? inPhase("invalid-experiment")
    : inPhase("deterministic");
  // The whole-review count, for the [i/total] feed counter.
  const total = checks.length;
  const findings = [];
  const manualItems = [];
  // Let checks narrate the file:line sites they investigated (network loads,
  // eval, HTML sinks) to the feed with their per-site verdict, so a reviewer has
  // a trail regardless of the finding. The format is owned here (formatNote);
  // checks emit only {file, loc, item, verdict}. Lines nest under the check's
  // [i/N] line above.
  // The ctx a note fires on IS its artifact (matching the input routing below), so
  // each sibling context gets a note bound to its input: the review target is the
  // source archive (source), the shipped context the built XPI, the build context the
  // build files. artifactLabel prepends [XPI]/[SCA] in SCA mode (and always [XPI] for
  // manifest.json - the shipped manifest); an XPI review adds no label.
  const makeNote = (input) => (file, loc, item, verdict) => {
    try {
      const label = artifactLabel({
        file,
        input,
        mode: sourceCtx.mode,
      });
      // The note is composed by ~140 call sites out of paths and submission
      // text. Made safe here, once, rather than at each of them - and on the
      // PARTS, so the feed's own colouring downstream is untouched.
      progress(
        formatNote(
          displayLine(file),
          loc,
          item == null ? item : displayLine(item),
          verdict,
          label
        ),
        FEED.DETAIL
      );
    } catch (err) {
      // A cosmetic feed note must never drop a check's findings - formatNote's
      // throw still guards the contract for its unit test and direct callers.
      debug(`feed note skipped: ${err.message}`);
    }
  };
  // The loop skips any sibling that aliases the source ctx (in an XPI review
  // siblings.xpi IS the source ctx), which is why source is set explicitly first.
  sourceCtx.note = makeNote("source");
  for (const [input, sib] of Object.entries(siblings)) {
    if (sib && sib !== sourceCtx) {
      sib.note = makeNote(input);
    }
  }
  // Heading for the live activity feed, matching the report's section style. A
  // no-op when progress is off (JSON, the golden harness), so goldens are
  // unaffected.
  progress("── Activity ──");
  progress("");
  for (const [i, check] of checks.entries()) {
    // Route the check to its declared input artifact - the ONE place the choice is
    // made (routeCtx, also asked directly by the routing tests). The check reads
    // only its ctx.addon and has no way to reach another artifact.
    const checkCtx = routeCtx(check, siblings);
    const out = await runOneCheck(checkCtx, check, `[${i + 1}/${total}]`);
    findings.push(...out.findings);
    manualItems.push(...out.manualItems);
  }
  const checksRun = [...checks];

  // Condense the unused-files report: when every packaged file under a folder is unused,
  // collapse it to the top-most such folder. Output-only, after every check has scanned every
  // file. Applied separately to findings and manual escalations so certainty is not mixed. It
  // is handed a RESOLVER (filesOfRule), not a file list: ctxForRule is the one answer to which
  // artifact a rule's OUTPUT describes (the same resolution the report's [XPI]/[SCA] label
  // uses), so nothing here picks an artifact and none can be picked wrongly.
  const filesOfRule = (ruleId) => [
    ...ctxForRule(registry, ruleId, siblings).addon.files.keys(),
  ];
  collapseUnusedFolders(findings, filesOfRule);
  collapseUnusedFolders(manualItems, filesOfRule);

  return { findings, manualItems, checksRun };
}

/**
 * Run one loaded check and return its findings + manual refs, stamping each
 * finding with the check's id and severity. This is the per-check body of
 * runChecks, extracted so a check can also be run on its own, outside the loop.
 * Identical behavior either way: a check's `escalations` route to
 * manual review through escalation.js, and a thrown check becomes a single
 * "check-failed" finding so the rest still run.
 * @param {RunContext} ctx
 * @param {LoadedCheck} check
 * @param {string} label  The feed prefix before the id, e.g. "[3/12]".
 * @returns {Promise<{findings: object[], manualItems: object[]}>}
 */
export async function runOneCheck(ctx, check, label) {
  progress(`${label} ${check.id}`, FEED.STEP);
  const findings = [];
  const manualItems = [];
  try {
    // ONE return shape: { findings, escalations? }. A bare array is refused rather
    // than read as findings, because that shorthand made the two lanes look optional:
    // a rule that grew an escalation path and kept returning its findings array lost
    // every escalation silently, with nothing to catch it - `expect` cannot assert an
    // escalation, so only a golden covering that fixture would have noticed.
    const result = await check.run(ctx, check);
    if (
      Array.isArray(result) ||
      (result != null && typeof result !== "object")
    ) {
      throw new Error(
        `${check.id} returned ${Array.isArray(result) ? "an array" : typeof result} - ` +
          "a check returns { findings, escalations }"
      );
    }
    const produced = [...(result?.findings ?? [])];
    const escalations = result?.escalations ?? [];
    if (escalations.length) {
      // Cases a person must inspect, straight to manual review.
      manualItems.push(...manualEscalations(check, escalations).manualItems);
    }
    if (check.severity === NO_SEVERITY && produced.length) {
      // The entry says this check emits no findings, so there is no band to stamp. A
      // finding here would otherwise be published at an invented severity - the exact
      // silent auto-reject the declaration exists to prevent. Fail loudly instead.
      throw new Error(
        `${check.id} is severity:none but emitted ${produced.length} finding(s) - ` +
          "give the entry a concrete severity, or return only escalations"
      );
    }
    const auto = check.severity === AUTO_SEVERITY;
    // Provisional: hold is what this check knows on its own. resolveHolds settles it
    // against the rest of the review once every check has run.
    const stamp =
      check.severity === HOLD_OR_ERROR ? SEVERITY.HOLD : check.severity;
    for (const f of produced) {
      f.ruleId = check.id;
      if (!auto) {
        // Fixed severity: the entry is the sole authority. Whatever the check
        // may have set on f.severity is ignored (overwritten) here.
        f.severity = stamp;
      } else if (!isConcreteSeverity(f.severity)) {
        // The severity:auto case - the check owns each finding's severity, but
        // it must produce a concrete one. A missing/invalid value is a check
        // bug. Fail safe to error (the report consumers all assume a concrete
        // severity).
        debug(
          `[registry] ${check.id} is severity:auto but emitted ${JSON.stringify(
            f.severity
          )} - defaulting to error`
        );
        f.severity = SEVERITY.ERROR;
      }
      findings.push(f);
    }
  } catch {
    findings.push(
      finding({
        ruleId: "check-failed",
        severity: SEVERITY.ERROR,
        item: check.id,
      })
    );
  }
  return { findings, manualItems };
}
