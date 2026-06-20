// registry.yaml is the check registry. Every `deterministic-checks` or
// `llm-checks` entry that carries a `check:` field links to a module in ./rules/
// that implements that test. This loader reads the yaml, imports the linked
// module for each (selected) entry, runs it, and stamps each returned finding
// with the entry's id (the check filename stem) and its severity.
//
// A check is a pure detector: it decides verdicts and emits findings carrying
// only `file`/`loc`/`item`/`hint` - never prose. The registry entry is the
// check's declarative contract: `severity` (the only source of a finding's
// impact, stamped unconditionally), and the text shown for it (`response`,
// `instructions`, `prompt`). Neither half leaks into the other.
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

const here = path.dirname(fileURLToPath(import.meta.url));
const RULES_DIR = path.join(here, "rules");
const DEFAULT_REGISTRY = path.resolve(here, "../../assets/registry.yaml");

/**
 * @typedef {object} LoadedCheck
 * @property {string} id
 * @property {string} title
 * @property {Severity} severity  Impact stamped onto the check's findings.
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
 * @property {Function} run
 */

/**
 * The shared context passed to every check's run(ctx, check). Built once per
 * review (cli.js reviewAddon) and read by the rule modules.
 * @typedef {object} RunContext
 * @property {import("../addon/load.js").Addon} addon  Files + parsed manifest.
 * @property {import("../schema/index.js").SchemaIndex} schema  Resolved schema.
 * @property {object[]} jsSources  Parsed JS sources (see addon/sources.js).
 * @property {object[]} apiUsages  Per-source extracted API usage.
 * @property {{llmApiKey?: string, allowExperiments?: boolean}} options
 * @property {import("../addon/load.js").Addon|null} [previous]  Diff baseline.
 * @property {boolean} [invalidExperiment]  The add-on uses Experiment APIs and
 *   --allow-experiments is off: the review short-circuits to the reject check
 *   only, with no LLM (see runChecks and buildRunContext).
 * @property {{evaluate: Function}} [llm]  LLM client, present only with a token.
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
   * diffEligible): e.g. the "Forked add-on" reminder is `diff: false`, so it shows
   * only for a new submission, not when reviewing against a --diff-to baseline. An
   * llm check that escalates with no token is surfaced by the orchestrator
   * (escalation.js), not here.
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
  const checks = [];
  for (const entry of registry.checkEntries()) {
    const id = stem(entry.check);
    if (onlySet && !onlySet.has(id)) {
      continue;
    }
    if (skipSet && skipSet.has(id)) {
      continue;
    }
    const file = path.join(RULES_DIR, entry.check);
    if (!fs.existsSync(file)) {
      throw new Error(
        `check module not found: rules/${entry.check} (referenced by "${entry.title}")`
      );
    }
    const mod = await import(pathToFileURL(file).href);
    const run = mod.default?.run ?? mod.run;
    if (typeof run !== "function") {
      throw new Error(`rules/${entry.check} exports no run() function`);
    }
    checks.push({
      id,
      title: entry.title,
      severity: entry.severity || "error",
      kind: entry.kind,
      diff: typeof entry.diff === "boolean" ? entry.diff : undefined,
      phase: entry.phase,
      prompt: entry.prompt,
      instructions: entry.instructions,
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
 * Whether a registry entry runs in the current review mode, per its `diff` field:
 * `diff: true` only with a --diff-to baseline, `diff: false` only without one (a
 * new submission), an omitted `diff` in both. Shared by the check gate (runChecks)
 * and the manual-checks gate (Registry.manualChecks).
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
 * Run the selected checks. A check returns its verdicts as findings, and may
 * also return `escalations` (cases it could not settle), which this orchestrator
 * - the sole authority on manual review - resolves an llm check's via
 * escalation.js (LLM if a token is set, else manual) and a deterministic
 * check's straight to manual review. Every finding (direct or from a confirmed
 * escalation) is stamped with the owning check's id and severity (the registry
 * entry is the only source of severity). A check that throws is reported as a
 * system finding and the rest still run.
 * @param {RunContext} ctx  The shared check context.
 * @param {Registry} registry
 * @param {{only?: string[], skip?: string[]}} [opts]
 * @returns {Promise<{findings: object[], checks: object[], deferred: object[],
 *   total: number, manualItems: {ruleId: string, item: ?string,
 *   kind: string}[]}>}  `checks` ran in this loop; `deferred` are the
 *   post-summary checks for the caller to run next (continuing the [i/total]
 *   numbering); `total` is the whole-review check count.
 */
export async function runChecks(ctx, registry, opts = {}) {
  // Two gates pick which checks run. The `diff` gate (a registry field) keys off
  // the mode: `diff: true` (e.g. strict-max-version-bump-only) needs a --diff-to
  // baseline (ctx.previous), `diff: false` is new-submission only (the same gate
  // also applies to manual-checks entries - see diffEligible/manualChecks, used by
  // the new-submission-only "Forked add-on" reminder), an omitted `diff` runs in
  // both. The `phase` gate then picks the review
  // PROFILE: an invalid Experiment (ctx.invalidExperiment - Experiment APIs with
  // --allow-experiments off) runs ONLY the `phase: invalid-experiment` reject
  // check and nothing else; a normal review runs the default-phase checks in this
  // loop and returns the `phase: post-summary` checks as `deferred` for the
  // caller to run after the AI add-on summary. A filtered-out check never runs
  // and never appears in the feed or meta.checksRun.
  const loaded = await loadChecks(registry, opts);
  const inDiffMode = Boolean(ctx.previous);
  const eligible = loaded.filter((c) => diffEligible(c, inDiffMode));
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
  // Heading for the live activity feed, matching the report's section style. A
  // no-op when progress is off (JSON, the golden harness), so goldens are
  // unaffected.
  progress("── Activity ──");
  progress("");
  for (const [i, check] of checks.entries()) {
    const out = await runOneCheck(ctx, check, `[${i + 1}/${total}]`);
    findings.push(...out.findings);
    manualItems.push(...out.manualItems);
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
    for (const f of produced) {
      f.ruleId = check.id;
      f.severity = check.severity;
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
