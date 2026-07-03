// registry.yaml is the check registry. Every `deterministic-checks` or
// `llm-checks` entry that carries a `check:` field links to a module in ./rules/
// that implements that test. This loader reads the yaml, imports the linked
// module for each (selected) entry, runs it, and stamps each returned finding
// with the entry's id (the check filename stem) and its severity.
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
import { progress, debug } from "../util/log.js";
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
// readable --scs-source in an SCS review); "xpi" = ALWAYS the built XPI (the shipped
// artifact), for the structure checks that describe what ships; "build" = the SCS
// build files (the archive minus the review source minus node_modules), for the
// build review. Required on every check: runChecks routes each check to its
// artifact's context, so the check reads one artifact and has no way to reach
// another (see buildShippedCtx / buildScsBuildCtx).
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
 * @property {"auto"|"xpi"|"build"} input  Which add-on artifact is ctx.addon when the
 *   check runs. "auto" = the review target (the built XPI in an XPI review, the
 *   readable --scs-source in an SCS review); "xpi" = always the built XPI (the shipped
 *   artifact), for the structure checks that describe what ships; "build" = the SCS
 *   build files, for the build review. Required - runChecks routes each check to its
 *   artifact's context (see buildShippedCtx / buildScsBuildCtx).
 * @property {"deterministic"|"llm"} kind  Which registry section it came from.
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
 * @property {boolean} [scsRecheck]  `false` marks a per-site (file:line) recheck
 *   producer whose source-anchored items cannot bridge to the XPI behavioral
 *   summary in SCS mode: runChecks then routes its unsure sites straight to manual
 *   review there instead of the summary.
 * @property {string} [summaryPrompt]  (recheck consumer) The rubric appended to
 *   the full-summary prompt to re-judge the items handed to this check. Its
 *   presence also classifies the check as post-summary (see loadChecks).
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
 *   ctx.addon.manifest (reviewView strips it), which in SCS would be the readable
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
 * @property {"xpi"|"scs"} [mode]  Review mode: "xpi" (a built add-on, default) or
 *   "scs" (a source-code submission). Gates checks via scsEligible.
 *
 *   The SHIPPED artifact (the built XPI) is deliberately NOT a ctx field: a check
 *   has no way to reach the artifact it was not routed to. The orchestrator builds a
 *   separate shipped context (buildShippedCtx, src/checks/context.js) and routes each
 *   `input: xpi` check to it - see runChecks / runOneCheck.
 * @property {boolean} [isShippedView]  Set by buildShippedCtx on the shipped
 *   context (never the review target). buildReachability reads it so the SCS
 *   "all readable-source files" pureWebExtensionReachable fallback applies only to
 *   the review source, not the built XPI (whose entry points resolve).
 * @property {string} [scsExpSource]  SCS mode: the Experiment folder as a source-
 *   relative path (runPipeline re-bases it from the scsRoot-relative --scs-exp-source
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
     * @param {"deterministic"|"llm"} kind
     * @returns {object[]}
     */
    const tag = (list, kind) =>
      (list || [])
        .filter((e) => e && typeof e.check === "string" && e.check)
        .map((e) => ({ ...e, kind }));
    return [
      ...tag(this.doc["deterministic-checks"], "deterministic"),
      ...tag(this.doc["llm-checks"], "llm"),
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
  // A `post-summary-recheck: X` producer must name a real check X that carries a
  // `summary-prompt` (that prompt is what re-judges the handed-over items; a
  // dangling target would divert them into ctx.recheck to be silently dropped).
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
    const prompt = consumer["summary-prompt"];
    if (typeof prompt !== "string" || !prompt) {
      throw new Error(
        `post-summary-recheck target "${target}" (from "${e.title}") has no summary-prompt`
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
    // `input` is required and drives runOneCheck's artifact routing. Rejecting a
    // missing/invalid value here makes the shipped-vs-review-target choice explicit
    // and central: a new check cannot run without deciding, in the registry, which
    // artifact it reads (there is no default to silently fall through to).
    const input = entry.input;
    if (!VALID_CHECK_INPUTS.has(input)) {
      throw new Error(
        `rules/${id}.js is missing a valid \`input\` (got ${JSON.stringify(input)}; ` +
          `expected one of: ${[...VALID_CHECK_INPUTS].join(", ")}). ` +
          "Every check must declare which add-on artifact it reads (auto = the " +
          "review target, xpi = the built XPI, build = the SCS build files)."
      );
    }
    checks.push({
      id,
      title: entry.title,
      severity,
      input,
      kind: entry.kind,
      diff: typeof entry.diff === "boolean" ? entry.diff : undefined,
      scs: typeof entry.scs === "boolean" ? entry.scs : undefined,
      // A `summary-prompt` marks a recheck consumer: it is re-judged by the add-on
      // summary, so it must run AFTER it (an explicit `phase` still wins).
      phase:
        entry.phase ?? (entry["summary-prompt"] ? "post-summary" : undefined),
      prompt: entry.prompt,
      instructions: entry.instructions,
      postSummaryRecheck:
        typeof entry["post-summary-recheck"] === "string"
          ? entry["post-summary-recheck"]
          : undefined,
      // `scs-recheck: false` -> a per-site (file:line) recheck whose source-anchored
      // items cannot bridge to the XPI behavioral summary in SCS mode; runChecks
      // routes them straight to manual review there instead.
      scsRecheck:
        typeof entry["scs-recheck"] === "boolean"
          ? entry["scs-recheck"]
          : undefined,
      summaryPrompt:
        typeof entry["summary-prompt"] === "string"
          ? entry["summary-prompt"]
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
 * Format one investigation note for the feed: a padded `[verdict]` tag then the
 * site (`file:line` when a line is known, else `file`) and the optional item.
 * @param {string} file
 * @param {?{line?: number}} loc
 * @param {?string} item
 * @param {"pass"|"fail"|"unsure"|"skipped"} verdict  A DETERMINISTIC_VERDICTS
 *   value (skipped = the check did not apply; unsure = escalated).
 * @returns {string}
 */
export function formatNote(file, loc, item, verdict) {
  if (!DETERMINISTIC_VERDICTS.has(verdict)) {
    throw new Error(
      `formatNote: unknown verdict "${verdict}" (expected one of ` +
        `${[...DETERMINISTIC_VERDICTS].join("/")})`
    );
  }
  const at = loc?.line != null ? `${file}:${loc.line}` : file;
  const line = `      • ${`[${verdict}]`.padEnd(TAG_WIDTH)} ${at}${item ? ` - ${item}` : ""}`;
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
 * Whether a registry entry runs in the current review MODE, per its `scs` field
 * (mirrors diffEligible): `scs: true` only in SCS mode (a source-code submission,
 * `--scs-root`/`--scs-source`), `scs: false` only in XPI mode (reviewing a built
 * add-on), an omitted `scs` in both. The XPI bundled/vendor checks are `scs:
 * false` (they need the XPI dependency tree, absent for a source archive); the
 * `--scs-root` dependency audit is `scs: true`.
 * @param {{scs?: boolean}} entry @param {boolean} inScsMode
 * @returns {boolean}
 */
function scsEligible(entry, inScsMode) {
  if (entry.scs === true) {
    return inScsMode;
  }
  if (entry.scs === false) {
    return !inScsMode;
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
 *   reviewed artifact; the XPI in an XPI review, the readable source in SCS).
 * @param {Registry} registry
 * @param {{only?: string[], skip?: string[]}} [opts]
 * @param {RunContext} [shippedCtx]  The SHIPPED-artifact context (built by the
 *   pipeline via buildShippedCtx); each `input: xpi` check is routed to it. IS ctx
 *   in an XPI review; omitted = every check runs over ctx.
 * @param {RunContext} [buildCtx]  The SCS BUILD-files context (buildScsBuildCtx);
 *   each `input: build` check is routed to it. SCS mode only; omitted otherwise.
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
  // The `scs` gate keys off the review mode (ctx.mode): SCS mode reviews a
  // source-code submission's readable source + its declared deps, so the
  // XPI-only bundled/vendor checks (`scs: false`) are dropped and the
  // source-dependency audit (`scs: true`) is added; XPI mode (the default) is
  // the inverse. An omitted `scs` runs in both.
  const inScsMode = ctx.mode === "scs";
  const eligible = loaded.filter(
    (c) => diffEligible(c, inDiffMode) && scsEligible(c, inScsMode)
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
  ctx.note = (file, loc, item, verdict) => {
    try {
      progress(formatNote(file, loc, item, verdict));
    } catch (err) {
      // A cosmetic feed note must never drop a check's findings - formatNote's
      // throw still guards the contract for its unit test and direct callers.
      debug(`feed note skipped: ${err.message}`);
    }
  };
  // The shipped context is a sibling object, so it needs the same feed note - an
  // `input: xpi` check narrates through the ctx it was routed to.
  if (shippedCtx && shippedCtx !== ctx) {
    shippedCtx.note = ctx.note;
  }
  if (buildCtx && buildCtx !== ctx) {
    buildCtx.note = ctx.note;
  }
  // Heading for the live activity feed, matching the report's section style. A
  // no-op when progress is off (JSON, the golden harness), so goldens are
  // unaffected.
  progress("── Activity ──");
  progress("");
  for (const [i, check] of checks.entries()) {
    // Route the check to its declared input artifact - the ONE place the choice is
    // made. `input: xpi` runs over the shipped context (the built XPI), `input: build`
    // over the SCS build files, everything else over the review target. The check
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
    // review - as do all no-summary paths, including the golden harness. In SCS
    // mode a `scs-recheck: false` producer (a per-site file:line recheck) is also
    // held back: its source line numbers cannot bridge to the XPI summary, so its
    // unsure sites go straight to manual review.
    const scsHoldsBack = ctx.mode === "scs" && check.scsRecheck === false;
    if (
      check.postSummaryRecheck &&
      ctx.recheckActive &&
      out.manualItems.length &&
      !scsHoldsBack
    ) {
      // A producer can opt an item out of the recheck (recheckEligible: false); those
      // stay manual-only even under --full-summary. The unused-permission gate uses
      // this so only property/gesture-gated permissions reach the LLM.
      const bucket = (ctx.recheck ??= new Map());
      const held = bucket.get(check.postSummaryRecheck) ?? [];
      for (const m of out.manualItems) {
        if (m.recheckEligible === false) {
          manualItems.push(m);
        } else {
          held.push(m);
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
  progress(`  ${label} ${check.id}`);
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
