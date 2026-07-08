// registry.yaml is the check registry. Every `deterministic-checks`,
// `llm-checks`, or `post-summary-rechecks` entry that carries a `check:` field
// links to a module in ./rules/ that implements that test. This loader reads the
// yaml, imports the linked module for each (selected) entry, runs it, and stamps
// each returned finding with the entry's id (the check filename stem) and its severity.
//
// A check is a pure detector: it decides verdicts and emits findings carrying
// only `file`/`loc`/`item`/`hint` - never prose. The registry entry is the
// check's declarative contract: `severity` (the source of a finding's impact,
// stamped unconditionally - UNLESS it is `auto`, which delegates the per-finding
// severity to the check), and the text shown for it (`response`, `instructions`,
// `prompt`). Neither half leaks into the other.
//
// A deterministic check returns `Finding[]`. An llm check runs a deterministic
// pre-flight and returns `{ findings, escalations }`, where each escalation is a
// case it could not settle. The orchestrator (runChecks) - the sole authority on
// manual review - resolves every escalation via escalation.js: with a token it
// asks the LLM, otherwise (or on unsure/error) it routes the case to manual
// review. So only llm checks can defer to manual, and only the orchestrator
// decides.
//
// The shared `ctx` passed to run() holds `addon` (files, manifest,
// manifestError - see addon/load.js), `schema` (a SchemaIndex), `jsSources`
// (see addon/sources.js), `apiUsages` (per-source parsed API usage), `options`
// (CLI flags), and - when an Anthropic token is set - `ctx.llm`, the LLM client
// whose `evaluate(criterion)` an LLM check calls.
//
// Belongs here: the Registry class (the queried view of registry.yaml), loading
// and filtering rule modules, the RunContext type, and runChecks - the loop
// that runs checks, resolves escalations, and stamps id + severity. Does NOT
// belong here: building the ctx, which is src/checks/context.js. The per-case
// escalation policy - src/checks/escalation.js. Any check's detection logic - a
// module under src/checks/rules/* (shared analysis in src/checks/lib/*).
// Resolving a ruleId to user text and laying out the report -
// src/report/responses.js and src/report/format.js.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

import { finding, SEVERITY } from "../report/finding.js";
import { artifactLabel } from "../report/artifact.js";
import { progress, debug, FEED } from "../util/log.js";
import { red, green, blue } from "../util/color.js";
import { runLlmCheck, manualEscalations } from "./escalation.js";

/** @typedef {import("../report/finding.js").Severity} Severity */

// The severity token a check entry may declare. error/warning/info are stamped
// onto every finding the check emits. "auto" instead delegates the per-finding
// severity to the check itself (it sets f.severity, defaulting to error if it
// sets none or an invalid value) - see runOneCheck. "auto" is a config-only
// token: a finding never carries it.
const AUTO_SEVERITY = "auto";
const CONCRETE_SEVERITIES = new Set([
  SEVERITY.ERROR,
  SEVERITY.WARNING,
  SEVERITY.INFO,
]);
const VALID_CHECK_SEVERITIES = new Set([...CONCRETE_SEVERITIES, AUTO_SEVERITY]);

// The `input` a check entry declares - which add-on artifact is ctx.addon when the
// check runs. "auto" = the REVIEW TARGET (the built XPI in an XPI review, the
// readable --sca-source in an SCA review); "xpi" = ALWAYS the built XPI (the shipped
// artifact), for the structure checks that describe what ships; "build" = the SCA
// build files (the archive minus the review source minus node_modules), for the
// build review. Required on every check EXCEPT a post-summary-recheck (which
// declares no input - it runs on the main ctx and is labelled by its producer's
// corpus): runChecks routes each check to its artifact's context, so the check
// reads one artifact and has no way to reach another (see buildShippedCtx /
// buildScaBuildCtx).
const VALID_CHECK_INPUTS = new Set(["auto", "xpi", "build"]);

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
 * @property {Severity} severity  Impact stamped onto the check's findings.
 * @property {"auto"|"xpi"|"build"|undefined} input  Which add-on artifact is ctx.addon
 *   when the check runs. "auto" = the review target (the built XPI in an XPI review, the
 *   readable --sca-source in an SCA review); "xpi" = always the built XPI (the shipped
 *   artifact), for the structure checks that describe what ships; "build" = the SCA
 *   build files, for the build review. Required for a normal check - runChecks routes it
 *   to that artifact's context (see buildShippedCtx / buildScaBuildCtx). ABSENT for a
 *   post-summary-recheck, which always runs on the main ctx and is labelled by labelInput.
 * @property {"auto"|"xpi"|"build"} labelInput  The artifact this check's OUTPUT is
 *   labelled as ([XPI]/[SCA]) - the corpus it acts on. Equals `input` for a normal check;
 *   for a recheck consumer it is the producer's corpus (see Registry.labelInputFor).
 * @property {"deterministic"|"llm"|"post-summary-recheck"} kind  Which registry section
 *   it came from. "deterministic"/"llm" is provenance only (never read for control flow -
 *   dispatch is by run() return shape). "post-summary-recheck" is BEHAVIORAL: loadChecks
 *   keys off it to forbid an `input`, derive phase "post-summary", and require a rubric.
 * @property {boolean} [diff]  Diff-mode gate: true = run only with a --diff-to
 *   baseline, false = run only WITHOUT one (new submissions), omitted = always.
 * @property {"post-summary"|"invalid-experiment"} [phase]  Run profile, picked
 *   by runChecks: omitted = the main loop of a normal review; "post-summary" =
 *   after the AI add-on summary (reads its output); "invalid-experiment" = only
 *   when the add-on is an invalid Experiment, in which case it is the ONLY phase
 *   that runs (see runChecks).
 * @property {string} [prompt]  LLM rubric for an ambiguous case (llm checks).
 * @property {string} [instructions]  Manual-review message (llm checks).
 * @property {string} [postSummaryRecheck]  Id of a post-summary recheck consumer
 *   this check hands its manual items to when the full summary runs (see
 *   runChecks and src/checks/lib/recheck.js).
 * @property {Function} run
 */

/**
 * The shared context passed to every check's run(ctx, check). Built once per
 * review (cli.js reviewAddon) and read by the rule modules.
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
 *   computed from the SHIPPED XPI. Shipped-authoritative and shared like the manifest,
 *   so the experiment checks read ctx.experiments, not ctx.addon.experiments. Null for
 *   a non-Experiment add-on.
 * @property {{llmEnabled?: boolean, llmApiKey?: string, llmApiUrl?: string,
 *   llmApiType?: string, allowExperiments?: boolean}} options
 * @property {import("../addon/load.js").Addon|null} [previous]  Diff baseline.
 * @property {"xpi"|"sca"} [mode]  Review mode: "xpi" (a built add-on, default) or
 *   "sca" (a source code archive). Gates checks via scaEligible.
 *
 *   The SHIPPED artifact (the built XPI) is deliberately NOT a ctx field: a check
 *   has no way to reach the artifact it was not routed to. The orchestrator builds a
 *   separate shipped context (buildShippedCtx, src/checks/context.js) and routes each
 *   `input: xpi` check to it - see runChecks / runOneCheck.
 * @property {boolean} [isShippedView]  Set by buildShippedCtx on the shipped
 *   context (never the review target). buildReachability reads it so the SCA
 *   "all readable-source files" pureWebExtensionReachable fallback applies only to
 *   the review source, not the built XPI (whose entry points resolve).
 * @property {string} [scaExpSource]  SCA mode: the Experiment folder as a source-
 *   relative path (runPipeline re-bases it from the scaRoot-relative --sca-exp-source
 *   flag). buildReachability excludes it from pureWebExtensionReachable so the
 *   WebExtension code checks skip privileged Experiment code.
 * @property {boolean} [invalidExperiment]  The add-on uses Experiment APIs and
 *   --allow-experiments is off: the review short-circuits to the reject check
 *   only, with no LLM (see runChecks and buildRunContext).
 * @property {{evaluate: Function}} [llm]  LLM client, present only with a token.
 * @property {boolean} [recheckActive]  Set by reviewAddon when the full summary
 *   will run: checks with a `post-summary-recheck` hand their manual items to the
 *   summary to re-judge, instead of straight to manual review.
 * @property {object[]} [recheckVerdicts]  The full add-on summary's recheck verdicts
 *   (set by the pipeline after the summary runs); resolveRecheck reads them to settle
 *   the handed-over items. Review-level data, so it is a ctx field, not on ctx.addon.
 * @property {Map<string, object[]>} [recheck]  Manual items handed to each
 *   recheck consumer (keyed by its id), awaiting the summary's verdicts.
 * @property {Function} [note]  Narrate a file:line investigation note to the
 *   feed: (file, loc, item, verdict) -> void. Set by runChecks, absent in tests.
 */

/**
 * Check filename stem - the finding ruleId, also used by --checks/--skip.
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
   * Check entries (deterministic + llm) that link to a rule module, each tagged
   * with its `kind`. An llm entry additionally carries a `prompt` (LLM rubric)
   * and `instructions` (manual-review message).
   * @returns {object[]}  Each: { check, title, severity, kind, prompt?,
   *   instructions?, response? }.
   */
  checkEntries() {
    /**
     * @param {object[]} [list]  Raw entries from one registry section.
     * @param {"deterministic"|"llm"|"post-summary-recheck"} kind
     * @returns {object[]}
     */
    const tag = (list, kind) =>
      (list || [])
        .filter((e) => e && typeof e.check === "string" && e.check)
        .map((e) => ({ ...e, kind }));
    return [
      ...tag(this.doc["deterministic-checks"], "deterministic"),
      ...tag(this.doc["llm-checks"], "llm"),
      // Recheck consumers live in their own section: they are re-judged by the
      // add-on summary (phase post-summary), always run on the main ctx, and are
      // labelled by their producer's corpus - so they declare no `input`. The
      // `kind` tag is the section-membership signal loadChecks keys off.
      ...tag(this.doc["post-summary-rechecks"], "post-summary-recheck"),
    ];
  }

  /**
   * The check entry for a ruleId (the check filename stem), or undefined.
   * @param {string} ruleId
   * @returns {object|undefined}
   */
  checkEntry(ruleId) {
    return (this._byId ??= new Map(
      this.checkEntries().map((e) => [stem(e.check), e])
    )).get(ruleId);
  }

  /**
   * Ids of every linked check, across both sections (for --checks help).
   * @returns {string[]}
   */
  checkIds() {
    return this.checkEntries().map((e) => stem(e.check));
  }

  /**
   * The artifact a check's OUTPUT is labelled as ([XPI]/[SCA]) - the corpus it
   * ACTS ON, not the ctx it runs on. For a post-summary-recheck consumer this is
   * its producer's corpus (recheckConsumersByCorpus), NOT its own `input`: `input`
   * only routes the consumer onto the main ctx so it can read ctx.recheck, but the
   * items it re-judges belong to the producer's artifact. Every other check acts on
   * the artifact it runs on, so its declared `input` is the label.
   * @param {string} ruleId
   * @returns {"xpi"|"build"|"auto"}
   */
  labelInputFor(ruleId) {
    const { xpi, source } = this.recheckConsumersByCorpus();
    if (xpi.has(ruleId)) {
      return "xpi";
    }
    if (source.has(ruleId)) {
      return "auto";
    }
    return this.checkEntry(ruleId)?.input ?? "auto";
  }

  /**
   * The label artifact per ruleId (a `Map<ruleId, "xpi"|"build"|"auto">`),
   * projected for the report layer so it can label a finding's file:line by
   * artifact ([XPI]/[SCA]) without touching the registry. Keyed off labelInputFor
   * (the corpus the check acts on), so a recheck consumer's items carry their
   * producer's artifact rather than the consumer's routing `input`.
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
   * The by-hand to-do items: every `manual-checks` entry eligible in the current
   * review mode, already in the rendered {title, instructions, response} shape
   * (these carry no `{{item}}`). Entries are diff-gated like checks (see
   * diffEligible): e.g. the "Forked add-on" reminder is `diff: false`, so it
   * shows only for a new submission, not when reviewing against a --diff-to
   * baseline. An llm check that escalates with no token is surfaced by the
   * orchestrator (escalation.js), not here.
   * @param {boolean} [inDiffMode]  Reviewing against a --diff-to baseline.
   * @returns {{title: string, instructions?: string, response: ?string}[]}
   */
  manualChecks(inDiffMode = false) {
    return (this.doc["manual-checks"] || [])
      .filter((e) => e && e.title && diffEligible(e, inDiffMode))
      .map((e) => ({
        title: e.title,
        instructions: e.instructions,
        response: e.response ?? null,
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
    return (this.doc["manual-checks"] || [])
      .map((e) => e && e.check)
      .filter(Boolean);
  }

  /**
   * The headings shown above each severity group in the Issues section, as a
   * { error?, warning?, info? } -> string map (a missing key renders that group
   * with no heading).
   * @returns {Record<string, string>}
   */
  issueHeadings() {
    const h = this.doc["issue-headings"];
    return h && typeof h === "object" ? h : {};
  }

  /**
   * The customer-facing verdict preamble for the Issues section, as a
   * { none?, feedback?, rejected? } -> string map: `none` when there are no
   * findings, `rejected` when any finding is an error, `feedback` otherwise.
   * @returns {Record<string, string>}
   */
  verdictIntros() {
    const v = this.doc["verdict-intros"];
    return v && typeof v === "object" ? v : {};
  }

  /**
   * The Issues response template for a finding's ruleId: the owning check's
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
   * A named tool-defining prompt from the top-level `prompts` map (e.g.
   * "system-intro", "change-summary"), or null if absent. These are model-facing
   * strings the registry owns, like check rubrics and `messages`.
   * @param {string} name
   * @returns {?string}
   */
  prompt(name) {
    const p = this.doc.prompts;
    const t = p && typeof p === "object" ? p[name] : null;
    return typeof t === "string" ? t : null;
  }

  /**
   * The shared framing for the unused-permission recheck rubric (top-level
   * `permission-prompt-framing` map): { preamble, closing }, each "" if absent.
   * @returns {{preamble: string, closing: string}}
   */
  permissionPromptFraming() {
    const f = this.doc["permission-prompt-framing"];
    const s = (v) => (typeof v === "string" ? v : "");
    return { preamble: s(f?.preamble), closing: s(f?.closing) };
  }

  /**
   * The per-permission-group recheck prompts (top-level `permission-prompts` list),
   * with the comma-separated `permissions` parsed to an array and the optional
   * inclusive Thunderbird version bounds surfaced.
   * @returns {{permissions: string[], prompt: string, minStrictVersion: ?string,
   *   maxStrictVersion: ?string}[]}
   */
  permissionPrompts() {
    return (this.doc["permission-prompts"] || [])
      .filter((e) => e && typeof e.prompt === "string")
      .map((e) => ({
        permissions: String(e.permissions ?? "")
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean),
        prompt: e.prompt,
        // Coerce to string so an unquoted numeric bound (min_strict_version: 154)
        // still parses - a bare YAML number would otherwise slip past parseVersion
        // and silently void the bound (see versionInBounds).
        minStrictVersion:
          e.min_strict_version != null ? String(e.min_strict_version) : null,
        maxStrictVersion:
          e.max_strict_version != null ? String(e.max_strict_version) : null,
      }));
  }

  /**
   * The permissions the unused-permission recheck can judge: the union of every
   * `permission-prompts` entry's permissions. A permission absent here has no rubric
   * grounding, so it is not worth an LLM recheck and stays manual. The registry
   * prompts are the single source of truth (there is no separate hardcoded set).
   * This is version-INDEPENDENT (a permission counts if ANY entry lists it); the
   * assembler then narrows to the entries whose version bounds fit the add-on, so a
   * permission recheckable here can still fall to manual when its only prompt is out
   * of range (see assemblePermissionPrompt's `grounded` set in lib/recheck.js).
   * @returns {Set<string>}
   */
  recheckablePermissions() {
    return (this._recheckable ??= new Set(
      this.permissionPrompts().flatMap((e) => e.permissions)
    ));
  }

  /**
   * Whether a manual item may be handed to the recheck consumer `consumerId` (asked
   * by the runChecks divert). A `permission-recheck` consumer takes only permissions
   * it has a prompt for; every other consumer takes all its items. Keeps permission
   * knowledge in the registry, not the orchestrator. This is the permissive,
   * version-independent gate: a handed permission may still fall to manual at assembly
   * if no version-matching prompt grounds it (see recheckablePermissions).
   * @param {string} consumerId
   * @param {{item: ?string}} item
   * @returns {boolean}
   */
  rechecks(consumerId, item) {
    if (!this.checkEntry(consumerId)?.["permission-recheck"]) {
      return true;
    }
    return this.recheckablePermissions().has(item.item);
  }

  /**
   * Partition the post-summary recheck CONSUMERS by the corpus their PRODUCER read, so
   * the SCA split can run one summary per corpus - each carrying only the consumers whose
   * items live in that corpus. A producer reads the review target when `input: auto`
   * (the source in SCA) and the shipped XPI when `input: xpi`; its items are anchored
   * accordingly, so its consumer bridges only to a summary of that same artifact. Derived
   * from the producers' declared `input` - no separate tag. `input: build` producers (none
   * today) belong to no summary corpus and are omitted.
   * @returns {{source: Set<string>, xpi: Set<string>}}
   */
  recheckConsumersByCorpus() {
    return (this._recheckByCorpus ??= (() => {
      const source = new Set();
      const xpi = new Set();
      for (const e of this.checkEntries()) {
        const target = e["post-summary-recheck"];
        if (typeof target !== "string") {
          continue;
        }
        const input = e.input ?? "auto";
        if (input === "xpi") {
          xpi.add(target);
        } else if (input === "auto") {
          source.add(target);
        }
      }
      return { source, xpi };
    })());
  }
}

/**
 * Parse registry.yaml once into a Registry.
 * @param {string} [registryPath]
 * @returns {Registry}
 */
export function loadRegistry(registryPath = DEFAULT_REGISTRY) {
  return new Registry(YAML.parse(fs.readFileSync(registryPath, "utf8")) || {});
}

/**
 * Load and filter the check modules named by the registry. A `check:` that names
 * a missing module, or a module without a `run` export, throws hard - a broken
 * registry should abort the review, not silently drop a check.
 * @param {Registry} registry
 * @param {object} [opts]
 * @param {string[]} [opts.only]  If set, only these ids load.
 * @param {string[]} [opts.skip]  These ids are excluded.
 * @returns {Promise<LoadedCheck[]>}
 */
export async function loadChecks(registry, { only, skip } = {}) {
  const onlySet = only?.length ? new Set(only) : null;
  const skipSet = skip?.length ? new Set(skip) : null;
  // A `post-summary-recheck: X` producer must name a real check X that carries the
  // rubric that re-judges the handed-over items: a static `summary-prompt`, or
  // `permission-recheck` (assembled per review from the permission-prompts). A
  // dangling target would divert items into ctx.recheck to be silently dropped.
  // Validated over the whole registry - config integrity is independent of
  // --only/--skip.
  for (const e of registry.checkEntries()) {
    const target = e["post-summary-recheck"];
    if (typeof target !== "string" || !target) {
      continue;
    }
    const consumer = registry.checkEntry(target);
    if (!consumer) {
      throw new Error(
        `post-summary-recheck target "${target}" (from "${e.title}") is not a check`
      );
    }
    const hasPrompt =
      (typeof consumer["summary-prompt"] === "string" &&
        consumer["summary-prompt"]) ||
      consumer["permission-recheck"];
    if (!hasPrompt) {
      throw new Error(
        `post-summary-recheck target "${target}" (from "${e.title}") has no summary-prompt or permission-recheck`
      );
    }
    // A recheck is judged by the source OR packaging summary pass, which cover the
    // `auto` and `xpi` corpora (recheckConsumersByCorpus). A `build` producer belongs
    // to neither, so its diverted items would silently never be judged - reject it.
    if ((e.input ?? "auto") === "build") {
      throw new Error(
        `"${e.title}" reads input: build and cannot declare a post-summary-recheck (no summary pass carries the build corpus)`
      );
    }
  }
  // A recheck consumer is defined by section membership (post-summary-rechecks): that
  // is what drives its phase and forbids an `input` below. Keep the rubric in lock-step
  // - a check carries a recheck rubric (summary-prompt / permission-recheck) IFF it
  // lives in that section - so phase, the divert, and validation can never disagree (a
  // rubric-bearing consumer left in deterministic-/llm-checks would otherwise get no
  // post-summary phase and never be re-judged).
  for (const e of registry.checkEntries()) {
    const hasRubric = !!(e["summary-prompt"] || e["permission-recheck"]);
    const inSection = e.kind === "post-summary-recheck";
    if (hasRubric !== inSection) {
      throw new Error(
        hasRubric
          ? `"${e.title}" carries a recheck rubric (summary-prompt/permission-recheck) but is not in the post-summary-rechecks section`
          : `"${e.title}" is in the post-summary-rechecks section but carries no recheck rubric (summary-prompt/permission-recheck)`
      );
    }
  }
  const checks = [];
  for (const entry of registry.checkEntries()) {
    const id = stem(entry.check);
    if (onlySet && !onlySet.has(id)) {
      continue;
    }
    if (skipSet && skipSet.has(id)) {
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
    const severity = entry.severity || "error";
    if (!VALID_CHECK_SEVERITIES.has(severity)) {
      throw new Error(
        `rules/${id}.js has an invalid severity "${severity}" ` +
          `(expected one of: ${[...VALID_CHECK_SEVERITIES].join(", ")})`
      );
    }
    // A post-summary-recheck consumer (its own section) always runs on the main ctx
    // and is labelled by its producer's corpus - so it declares no `input`, and doing
    // so would be misleading. Every OTHER check must declare a valid `input`, which
    // drives runOneCheck's artifact routing (no silent default to fall through to).
    const isRecheck = entry.kind === "post-summary-recheck";
    const input = entry.input;
    if (isRecheck && input !== undefined) {
      throw new Error(
        `rules/${id}.js is a post-summary-recheck and must not declare \`input\` ` +
          `(got ${JSON.stringify(input)}): it runs on the main ctx and is labelled ` +
          "by its producer's corpus."
      );
    }
    if (!isRecheck && !VALID_CHECK_INPUTS.has(input)) {
      throw new Error(
        `rules/${id}.js is missing a valid \`input\` (got ${JSON.stringify(input)}; ` +
          `expected one of: ${[...VALID_CHECK_INPUTS].join(", ")}). ` +
          "Every check must declare which add-on artifact it reads (auto = the " +
          "review target, xpi = the built XPI, build = the SCA build files)."
      );
    }
    checks.push({
      id,
      title: entry.title,
      severity,
      // undefined for a post-summary-recheck (routes to the main ctx); its output is
      // labelled by labelInput (the producer's corpus), not this.
      input,
      // The artifact this check's output is labelled as (the corpus it acts on) -
      // equals `input` for every check except a recheck consumer, which runs on the
      // main ctx but acts on its producer's corpus. See labelInputFor.
      labelInput: registry.labelInputFor(id),
      kind: entry.kind,
      diff: typeof entry.diff === "boolean" ? entry.diff : undefined,
      sca: typeof entry.sca === "boolean" ? entry.sca : undefined,
      // A recheck consumer (post-summary-rechecks section) is re-judged by the add-on
      // summary, so it must run AFTER it (an explicit `phase` still wins).
      phase: entry.phase ?? (isRecheck ? "post-summary" : undefined),
      prompt: entry.prompt,
      instructions: entry.instructions,
      postSummaryRecheck:
        typeof entry["post-summary-recheck"] === "string"
          ? entry["post-summary-recheck"]
          : undefined,
      run,
    });
  }
  return checks;
}

// The verdicts a deterministic check may narrate to the feed via ctx.note:
// skipped = the check did not apply (with a reason), unsure = the pre-flight's
// decision to escalate. Distinct from LLM_VERDICTS (the model's answer in
// claude.js), which is never "skipped".
const DETERMINISTIC_VERDICTS = new Set(["pass", "fail", "unsure", "skipped"]);

// Tag column width, sized to the widest "[verdict]" so the file column aligns.
const TAG_WIDTH = Math.max(
  ...[...DETERMINISTIC_VERDICTS].map((v) => v.length + 2)
);

// On an interactive screen, a fail note is red, a pass note green, and an unsure
// (escalated) note blue (skipped stays plain). A no-op unless the CLI enabled
// color (color.js).
const VERDICT_COLOR = { fail: red, pass: green, unsure: blue };

/**
 * Format one investigation note for the feed (unindented - the printer applies
 * the DETAIL indent): a padded `[verdict]` tag then the site (`file:line` when a
 * line is known, else `file`) and the optional item.
 * @param {string} file
 * @param {?{line?: number}} loc
 * @param {?string} item
 * @param {"pass"|"fail"|"unsure"|"skipped"} verdict  A DETERMINISTIC_VERDICTS
 *   value (skipped = the check did not apply; unsure = escalated).
 * @param {string} [label]  Artifact label ("XPI"/"SCA") prepended before the site
 *   in an SCA review, else "" (an XPI review has one artifact). See report/artifact.js.
 * @returns {string}
 */
export function formatNote(file, loc, item, verdict, label = "") {
  if (!DETERMINISTIC_VERDICTS.has(verdict)) {
    throw new Error(
      `formatNote: unknown verdict "${verdict}" (expected one of ` +
        `${[...DETERMINISTIC_VERDICTS].join("/")})`
    );
  }
  const at = loc?.line != null ? `${file}:${loc.line}` : file;
  const site = label ? `[${label}] ${at}` : at;
  const line = `• ${`[${verdict}]`.padEnd(TAG_WIDTH)} ${site}${item ? ` - ${item}` : ""}`;
  return (VERDICT_COLOR[verdict] ?? ((s) => s))(line);
}

/**
 * Whether a registry entry runs in the current review mode, per its `diff`
 * field: `diff: true` only with a --diff-to baseline, `diff: false` only without
 * one (a new submission), an omitted `diff` in both. Shared by the check gate
 * (runChecks) and the manual-checks gate (Registry.manualChecks).
 * @param {{diff?: boolean}} entry @param {boolean} inDiffMode
 * @returns {boolean}
 */
function diffEligible(entry, inDiffMode) {
  if (entry.diff === true) {
    return inDiffMode;
  }
  if (entry.diff === false) {
    return !inDiffMode;
  }
  return true;
}

/**
 * Whether a registry entry runs in the current review MODE, per its `sca` field
 * (mirrors diffEligible): `sca: true` only in SCA mode (a source code archive,
 * triggered by `--sca-root`), `sca: false` only in XPI mode (reviewing a built
 * add-on), an omitted `sca` in both. The XPI bundled/vendor checks are `sca:
 * false` (they need the XPI dependency tree, absent for a source archive); the
 * `--sca-root` dependency audit is `sca: true`.
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
 * Run the selected checks. A check returns its verdicts as findings, and may
 * also return `escalations` (cases it could not settle), which this orchestrator
 * - the sole authority on manual review - resolves an llm check's via
 * escalation.js (LLM if a token is set, else manual) and a deterministic
 * check's straight to manual review. Every finding (direct or from a confirmed
 * escalation) is stamped with the owning check's id and severity (the registry
 * entry is the only source of severity). A check that throws is reported as a
 * system finding and the rest still run.
 * @param {RunContext} ctx  The review-target check context (ctx.addon = the
 *   reviewed artifact; the XPI in an XPI review, the readable source in SCA).
 * @param {Registry} registry
 * @param {{only?: string[], skip?: string[]}} [opts]
 * @param {RunContext} [shippedCtx]  The SHIPPED-artifact context (built by the
 *   pipeline via buildShippedCtx); each `input: xpi` check is routed to it. IS ctx
 *   in an XPI review; omitted = every check runs over ctx.
 * @param {RunContext} [buildCtx]  The SCA BUILD-files context (buildScaBuildCtx);
 *   each `input: build` check is routed to it. SCA mode only; omitted otherwise.
 * @returns {Promise<{findings: object[], checks: object[], deferred: object[],
 *   total: number, manualItems: {ruleId: string, item: ?string,
 *   kind: string}[]}>}  `checks` ran in this loop; `deferred` are the
 *   post-summary checks for the caller to run next (continuing the [i/total]
 *   numbering); `total` is the whole-review check count.
 */
export async function runChecks(
  ctx,
  registry,
  opts = {},
  shippedCtx,
  buildCtx
) {
  // Two gates pick which checks run. The `diff` gate (a registry field) keys off
  // the mode: `diff: true` (e.g. strict-max-version-bump-only) needs a --diff-to
  // baseline (ctx.previous), `diff: false` is new-submission only (the same gate
  // also applies to manual-checks entries - see diffEligible/manualChecks, used
  // by the new-submission-only "Forked add-on" reminder), an omitted `diff` runs
  // in both. The `phase` gate then picks the review PROFILE: an invalid
  // Experiment (ctx.invalidExperiment - Experiment APIs with --allow-experiments
  // off) runs ONLY the `phase: invalid-experiment` reject check and nothing
  // else. A normal review runs the default-phase checks in this loop and returns
  // the `phase: post-summary` checks as `deferred` for the caller to run after
  // the AI add-on summary. A filtered-out check never runs and never appears in
  // the feed or meta.checksRun.
  const loaded = await loadChecks(registry, opts);
  const inDiffMode = Boolean(ctx.previous);
  // The `sca` gate keys off the review mode (ctx.mode): SCA mode reviews a
  // source-code submission's readable source + its declared deps, so the
  // XPI-only bundled/vendor checks (`sca: false`) are dropped and the
  // source-dependency audit (`sca: true`) is added; XPI mode (the default) is
  // the inverse. An omitted `sca` runs in both.
  const inScaMode = ctx.mode === "sca";
  const eligible = loaded.filter(
    (c) => diffEligible(c, inDiffMode) && scaEligible(c, inScaMode)
  );
  const checks = ctx.invalidExperiment
    ? eligible.filter((c) => c.phase === "invalid-experiment")
    : eligible.filter((c) => !c.phase);
  const deferred = ctx.invalidExperiment
    ? []
    : eligible.filter((c) => c.phase === "post-summary");
  // The whole-review count, so [i/total] is continuous across this loop AND the
  // caller's deferred post-summary checks (they carry on from checks.length).
  const total = checks.length + deferred.length;
  const findings = [];
  const manualItems = [];
  // Let checks narrate the file:line sites they investigated (network loads,
  // eval, HTML sinks) to the feed with their per-site verdict, so a reviewer has
  // a trail regardless of the finding. The format is owned here (formatNote);
  // checks emit only {file, loc, item, verdict}. Lines nest under the check's
  // [i/N] line above.
  // The ctx a note fires on IS its artifact (matching the input routing below), so
  // each sibling context gets a note bound to its input: the review target is the
  // source archive (auto), the shipped context the built XPI, the build context the
  // build files. artifactLabel prepends [XPI]/[SCA] in SCA mode (and always [XPI] for
  // manifest.json - the shipped manifest); an XPI review adds no label. A caller may
  // override the label artifact (5th arg) when its output belongs to a corpus other
  // than the ctx it runs on - a recheck consumer runs on the main ctx (auto) but acts
  // on its producer's corpus, so it passes its check.labelInput.
  const makeNote =
    (input) =>
    (file, loc, item, verdict, labelInput = input) => {
      try {
        const label = artifactLabel({
          file,
          input: labelInput,
          mode: ctx.mode,
        });
        progress(formatNote(file, loc, item, verdict, label), FEED.DETAIL);
      } catch (err) {
        // A cosmetic feed note must never drop a check's findings - formatNote's
        // throw still guards the contract for its unit test and direct callers.
        debug(`feed note skipped: ${err.message}`);
      }
    };
  ctx.note = makeNote("auto");
  if (shippedCtx && shippedCtx !== ctx) {
    shippedCtx.note = makeNote("xpi");
  }
  if (buildCtx && buildCtx !== ctx) {
    buildCtx.note = makeNote("build");
  }
  // Heading for the live activity feed, matching the report's section style. A
  // no-op when progress is off (JSON, the golden harness), so goldens are
  // unaffected.
  progress("── Activity ──");
  progress("");
  for (const [i, check] of checks.entries()) {
    // Route the check to its declared input artifact - the ONE place the choice is
    // made. `input: xpi` runs over the shipped context (the built XPI), `input: build`
    // over the SCA build files, everything else over the review target. The check
    // reads only its ctx.addon and has no way to reach another artifact.
    const checkCtx =
      check.input === "xpi"
        ? (shippedCtx ?? ctx)
        : check.input === "build"
          ? (buildCtx ?? ctx)
          : ctx;
    const out = await runOneCheck(checkCtx, check, `[${i + 1}/${total}]`);
    findings.push(...out.findings);
    // A check with `post-summary-recheck: R` hands its manual items to the
    // recheck consumer R, but only when the full summary will actually run to
    // re-judge them (ctx.recheckActive). Otherwise they go straight to manual
    // review - as do all no-summary paths, including the golden harness. In SCA the
    // summary runs once per corpus (recheckConsumersByCorpus), so a producer's items
    // always reach the summary of the artifact they are anchored to - no hold-back.
    if (
      check.postSummaryRecheck &&
      ctx.recheckActive &&
      out.manualItems.length
    ) {
      // The registry decides per item whether this consumer can re-judge it: a
      // permission-recheck consumer takes only the permissions it has a rubric prompt
      // for (registry.rechecks); the rest stay manual. Other rechecks take every item.
      const bucket = (ctx.recheck ??= new Map());
      const held = bucket.get(check.postSummaryRecheck) ?? [];
      for (const m of out.manualItems) {
        if (registry.rechecks(check.postSummaryRecheck, m)) {
          held.push(m);
        } else {
          manualItems.push(m);
        }
      }
      bucket.set(check.postSummaryRecheck, held);
    } else {
      manualItems.push(...out.manualItems);
    }
  }
  // Close the live activity list with a blank line, so it is separated from the
  // report that follows. A no-op when progress is disabled.
  progress("");
  return { findings, checks, deferred, total, manualItems };
}

/**
 * Run one loaded check and return its findings + manual refs, stamping each
 * finding with the check's id and severity. This is the per-check body of
 * runChecks, extracted so a check can also be run on its own (the
 * unused-permission check runs after the add-on summary, outside the loop - see
 * src/pipeline.js). Identical behavior either way: an LLM check's candidates go
 * through escalation.js, a deterministic check's escalations route to manual
 * review, and a thrown check becomes a single "check-failed" finding so the rest
 * still run.
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
    // ctx is already the artifact the caller routed this check to (runChecks /
    // pipeline, keyed on check.input). The check - and its LLM adjudication below -
    // read only ctx.addon; there is no way here to reach the other artifact.
    const result = (await check.run(ctx, check)) || [];
    const direct = Array.isArray(result) ? result : (result.findings ?? []);
    const escalations = Array.isArray(result) ? [] : (result.escalations ?? []);
    const llmStep = Array.isArray(result) ? null : (result.llm ?? null);
    const produced = [...direct];
    if (llmStep) {
      // An LLM check: judge its candidates (one verdict per id, batched), then
      // let the check map those verdicts to findings / manual via its own
      // id->data table. The model never names a subject, so it cannot drift.
      const out = await runLlmCheck(ctx, check, llmStep);
      produced.push(...out.findings);
      manualItems.push(...out.manualItems);
    } else if (escalations.length) {
      // A deterministic check may escalate cases a human must inspect - these
      // go straight to manual review (never the LLM, which is for judgment).
      manualItems.push(...manualEscalations(check, escalations).manualItems);
    }
    const auto = check.severity === AUTO_SEVERITY;
    for (const f of produced) {
      f.ruleId = check.id;
      if (!auto) {
        // Fixed severity: the entry is the sole authority. Whatever the check
        // may have set on f.severity is ignored (overwritten) here.
        f.severity = check.severity;
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
  } catch (err) {
    ctx.lastError = err; // surfaced via debug only; text comes from the registry
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
