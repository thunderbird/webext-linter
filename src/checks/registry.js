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
// those as manual-review items via escalation.js and is the sole authority on
// manual review, with one thing it is told rather than infers: an escalation
// marked `manualReview` is one reading the code cannot settle, so it is listed
// under Extended manual review instead of Extended code review.
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

import { finding, SEVERITY } from "../report/finding.js";
import { artifactLabel } from "../report/artifact.js";
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
const CONCRETE_SEVERITIES = new Set([
  SEVERITY.ERROR,
  SEVERITY.WARNING,
  SEVERITY.INFO,
]);
const VALID_CHECK_SEVERITIES = new Set([...CONCRETE_SEVERITIES, AUTO_SEVERITY]);

// The `input` a check entry declares - which add-on artifact is ctx.addon when the
// check runs. "source" = the REVIEW TARGET, the readable submitted code (the readable
// --sca-source in an SCA review, the built XPI in an XPI review - the only artifact
// there); "xpi" = ALWAYS the built XPI (the shipped artifact), for the structure checks
// that describe what ships; "build" = the SCA build files (the archive minus the review
// source minus node_modules), for the build review; "manifest" = the shipped manifest
// ONLY, on a ctx with an EMPTY file corpus (buildXpiCtxs' manifestCtx), for pure-manifest checks
// that read ctx.manifest and no files. Required on every check EXCEPT a
// post-summary-recheck (which declares no input - it routes to siblings.source and is
// labelled by its producer's corpus): runChecks routes each check to its artifact's
// context, so the check reads one artifact and has no way to reach another (see
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
 * @property {Severity} severity  Impact stamped onto the check's findings.
 * @property {"source"|"xpi"|"build"|"manifest"|undefined} input  Which add-on artifact is
 *   ctx.addon when the check runs. "source" = the review target, the readable submitted code
 *   (the readable --sca-source in an SCA review, the built XPI in an XPI review); "xpi" = always
 *   the built XPI (the shipped artifact), for the structure checks that describe what ships;
 *   "build" = the SCA build files, for the build review; "manifest" = the shipped manifest only,
 *   on a ctx with an empty file corpus (buildXpiCtxs' manifestCtx), for pure-manifest checks. Required for
 *   every check - runChecks routes it to that artifact's context (see buildXpiCtxs /
 *   buildScaCtxs), and it is also what the check's output is labelled as ([XPI]/[SCA]).
 * @property {boolean} [diff]  Diff-mode gate: true = run only with a --diff-to
 *   baseline, false = run only WITHOUT one (new submissions), omitted = always.
 * @property {string} [instructions]  Manual-review message.
 * @property {object[]} [permissionTokens]  The permission-prompts token entries
 *   ({permissions, tokens, version bounds} - prompt text stripped), carried by
 *   every check and read by the one that scans for them.
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
 *   computed from the SHIPPED XPI. Shipped-authoritative and shared like the manifest,
 *   so the experiment checks read ctx.experiments, not ctx.addon.experiments. Null for
 *   a non-Experiment add-on.
 * @property {{allowExperiments?: boolean,
 *   libraryHashes?: Map<string, {name: string, version: string}>}} options  The only run
 *   options a check reads (experiment-not-allowed, the lazy bundled classifier).
 * @property {import("../addon/load.js").Addon|null} [previous]  Diff baseline.
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
 * @property {string} [scaExpSource]  SCA mode: the Experiment folder as a source-
 *   relative path (runPipeline re-bases it from the scaRoot-relative --sca-exp-source
 *   flag). buildReachability excludes it from pureWebExtensionReachable so the
 *   WebExtension code checks skip privileged Experiment code.
 * @property {boolean} [invalidExperiment]  The add-on uses Experiment APIs and
 *   --allow-experiments is off: the review short-circuits to the reject check
 *   only (see runChecks and buildXpiCtxs).
 * @property {boolean} [scaNotRequired]  A submitted SCA (--sca-root) was downgraded to
 *   this plain XPI review because the shipped XPI is directly reviewable; the
 *   sca-not-required check reads this to report the redundant source submission.
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
   * Ids of every linked check, across every phase section (for --checks help).
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
   * The by-hand to-do items: every `manual-checks` entry eligible in the current
   * review mode, already in the rendered {title, instructions, response} shape
   * (these carry no `{{item}}`). Entries are diff-gated like checks (see
   * diffEligible): e.g. the "Forked add-on" reminder is `diff: false`, so it
   * shows only for a new submission, not when reviewing against a --diff-to
   * baseline. What a check escalates is surfaced by the orchestrator
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
   * The manual-review instructions template for a ref of this rule: the owning
   * check's `instructions`, or - for a `manualReview` ref - its
   * `manual-review-instructions`. The two are different texts because they ask
   * different things: the ordinary one asks the reviewer to resolve what the scan
   * could not, which for a manual-review case is not what is left to decide.
   *
   * Such a ref whose entry authors no wording RAISES. Nothing at load time can tell
   * which checks raise them - a check decides that per case, at run time - so this
   * is the first moment the omission is visible, and both quiet alternatives ship a
   * wrong report: the normal instructions misdescribe the case, an empty one asks a
   * reviewer to decide with nothing to go on. Registry authoring mistakes raise here
   * for the same reason loadChecks raises for a dangling recheck target.
   * @param {string} ruleId
   * @param {boolean} manualReview
   * @returns {?string}
   */
  instructionsFor(ruleId, manualReview) {
    const entry = this.checkEntry(ruleId);
    if (!manualReview) {
      return entry?.instructions ?? null;
    }
    const text = entry?.["manual-review-instructions"];
    if (!text) {
      throw new Error(
        `"${entry?.title ?? ruleId}" raised a manual-review item but authors no ` +
          "`manual-review-instructions` (assets/registry.yaml)"
      );
    }
    return text;
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
 * Parse registry.yaml once into a Registry, asserting every phase section is there.
 *
 * The phase sections ARE the control flow: runChecks looks each one up BY NAME and runs
 * whatever it finds. So a renamed or misspelled section does not fail loudly - it yields an
 * empty phase, and the review silently runs without every check in it. Nothing
 * downstream can tell that apart from "this phase has no checks". Assert
 * the closed set here instead, so a broken registry aborts the review - the same contract
 * loadChecks already applies to a `check:` that names a missing module.
 *
 * Only the SHIPPED registry is asserted (see assertRequiredPhaseSections). A caller naming
 * its own file (the unit tests) is deliberately exercising one section in isolation, and a
 * partial doc is the point there.
 * @param {string} [registryPath]
 * @returns {Registry}
 */
/**
 * Assert every phase in PHASE_SECTIONS has a non-empty section in the parsed registry `doc`.
 * A required section that is missing or empty (a yaml defect - a rename, a bad edit) would
 * leave that phase with no checks, and nothing downstream can tell "no checks" from "the
 * section vanished" - so the whole phase would be dropped from every review, silently. This
 * turns that into a loud abort. loadRegistry applies it to the SHIPPED registry only;
 * exported so the guard can be tested directly against a synthetic doc.
 * @param {Record<string, unknown>} doc  The parsed registry document.
 * @param {string} registryPath  For the error message.
 */
export function assertRequiredPhaseSections(doc, registryPath) {
  for (const section of Object.values(PHASE_SECTIONS)) {
    const list = doc[section];
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(
        `Registry ${registryPath}: the phase section "${section}" is missing or empty. ` +
          "Every phase in PHASE_SECTIONS must declare its checks - an absent section " +
          "would silently drop that whole phase from every review."
      );
    }
  }
}

export function loadRegistry(registryPath = DEFAULT_REGISTRY) {
  const registry = new Registry(
    YAML.parse(fs.readFileSync(registryPath, "utf8")) || {}
  );
  // Only the SHIPPED registry: a unit test naming its own file deliberately declares one
  // section in isolation, so the all-phases-present rule must not apply to it.
  if (registryPath === DEFAULT_REGISTRY) {
    assertRequiredPhaseSections(registry.doc, registryPath);
  }
  // ONE rule module = ONE entry = ONE phase. A check's id IS its module's filename stem, so a
  // second entry naming the same module is not a second check - it is the same check declared
  // twice. It would run once per entry, and worse, the id -> entry index (a Map, keyed by that
  // stem, and the only way a finding - which carries just a ruleId - reaches its severity and
  // response text) would resolve to the LAST declaration: a duplicate can silently restamp a
  // real check's `error` as `info`. Applies to every registry, not just the shipped one: a
  // duplicate is a mistake in any of them.
  const seen = new Set();
  for (const entry of registry.checkEntries()) {
    const id = stem(entry.check);
    if (seen.has(id)) {
      throw new Error(
        `Registry ${registryPath}: the check "${id}" is declared more than once. One rule ` +
          "module is one entry in one phase - a second declaration runs it again, and the " +
          "id -> entry lookup that stamps every finding's severity and response would " +
          "silently resolve to the last one."
      );
    }
    seen.add(id);
  }
  return registry;
}

/**
 * Load and filter the check modules named by the registry, GROUPED BY PHASE - a check's
 * phase is which list it lands in (its registry section), so no LoadedCheck carries one.
 * Every phase in PHASE_SECTIONS gets a list (loadRegistry has already asserted that none of
 * their sections is missing or empty; a list can still come out empty here once the
 * diff/sca gates and --checks/--skip have been applied). A `check:` that names a missing
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
    // The `--eslint` opt-in gate, applied HERE (unlike diff/sca, which gate in runChecks
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
    // Declared, never defaulted: a check's impact is configuration, so an entry that
    // omits it is a registry mistake rather than a request for the strictest value.
    // An escalate-only check declares one too - it says what a finding from it would
    // mean, should the check ever gain one.
    const severity = entry.severity;
    if (!VALID_CHECK_SEVERITIES.has(severity)) {
      throw new Error(
        `rules/${id}.js has a missing or invalid severity ${JSON.stringify(severity)} ` +
          `(expected one of: ${[...VALID_CHECK_SEVERITIES].join(", ")})`
      );
    }
    // Every check must declare a valid `input`, which drives runOneCheck's artifact
    // routing (routing is total - there is no default artifact to fall through to).
    const input = entry.input;
    if (!VALID_CHECK_INPUTS.has(input)) {
      throw new Error(
        `rules/${id}.js is missing a valid \`input\` (got ${JSON.stringify(input)}; ` +
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
        `rules/${id}.js declares \`input: build\` but not \`sca: true\`. The build corpus ` +
          "exists only in an SCA review; without the gate it would run in an XPI review, where " +
          "routeCtx would throw (there is no build sibling there)."
      );
    }
    byPhase.get(entry.phase).push({
      id,
      title: entry.title,
      severity,
      input,
      diff: typeof entry.diff === "boolean" ? entry.diff : undefined,
      sca: typeof entry.sca === "boolean" ? entry.sca : undefined,
      instructions: entry.instructions,
      // The permission-prompts token entries, like `prompt` and `instructions`
      // above: registry data every check carries, read by the one that scans for
      // them. It version-filters at run time (versionInBounds) with the reviewed
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
 * Whether a registry entry runs in the current review REVIEW_MODE, per its `sca` field
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
 * Whether a registry entry runs given the `--eslint` flag, per its `eslint` field
 * (mirrors diffEligible): `eslint: true` is opt-in - it runs only with `--eslint` - and an
 * omitted `eslint` runs always. Unlike the diff/sca gates this is applied in loadChecks
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
 * artifact routing is decided - shared by runChecks (the main loop) and the deferred
 * post-summary loop, so the two can never drift. Routing is TOTAL and explicit: there is
 * no default artifact to fall through to - `source` is a first-class sibling like the rest.
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
  // No `input` => a post-summary recheck consumer (loader-guaranteed): it reads the
  // review-level recheck state, which lives on the source ctx.
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
 * - the sole authority on manual review - repacks every check's escalations as
 * manual items via escalation.js. Every finding is stamped with the owning
 * check's id and severity (the registry
 * entry is the only source of severity). A check that throws is reported as a
 * system finding and the rest still run.
 * @param {Registry} registry
 * @param {{only?: string[], skip?: string[], eslint?: boolean}} [opts]
 *   `only`/`skip`/`eslint` thread to loadChecks (the `--eslint` opt-in gates code-sanity).
 * @param {Record<string, RunContext>} siblings  The artifact contexts, keyed by the `input`
 *   that routes to each: `source` = the review target (readable source in SCA, the XPI in an
 *   XPI review), `xpi` = the shipped XPI, `build` = the SCA build files, `manifest` = the
 *   shipped manifest (no file corpus). Consumed via routeCtx (the matrix is documented there).
 * @returns {Promise<{findings: object[],
 *   manualItems: {ruleId: string, item: ?string, manualReview: boolean}[],
 *   checksRun: object[]}>}  The finished review: every finding and manual item, and
 *   the checks that ran (for meta.checksRun).
 */
export async function runChecks(registry, opts = {}, siblings) {
  // `siblings` is the whole set of routing ctxs, keyed by input value; there is no separate
  // review-target argument. The review-level state (recheck / recheckVerdicts / the base feed
  // note) lives on the source ctx, so name it once here. `source` is required - routing is
  // total, so a siblings map without it is a caller bug, not a run to default around.
  const sourceCtx = siblings?.source;
  if (!sourceCtx) {
    throw new Error(
      "runChecks: siblings.source is required (the review-target ctx)."
    );
  }
  // Two gates pick which checks run. The `diff` gate (a registry field) keys off
  // the mode: `diff: true` (e.g. strict-max-version-bump-only) needs a --diff-to
  // baseline (ctx.previous), `diff: false` is new-submission only (the same gate
  // also applies to manual-checks entries - see diffEligible/manualChecks, used
  // by the new-submission-only "Forked add-on" reminder), an omitted `diff` runs
  // in both. A gated-out check never runs and never appears in the feed or
  // meta.checksRun.
  const byPhase = await loadChecks(registry, opts);
  const inDiffMode = Boolean(sourceCtx.previous);
  // The `sca` gate keys off the review mode (ctx.mode): SCA mode reviews a
  // source-code submission's readable source + its declared deps, so the
  // XPI-only bundled/vendor checks (`sca: false`) are dropped and the
  // source-dependency audit (`sca: true`) is added; XPI mode (the default) is
  // the inverse. An omitted `sca` runs in both.
  const inScaMode = sourceCtx.mode?.sca;
  // The orchestrator NAMES the phases it runs, in the order it runs them - a check's
  // phase is simply which list it is in, so a phase never asked for here does not run
  // (that is what makes an unrecognized registry section inert). An invalid Experiment
  // short-circuits the whole review to the reject phase and nothing else; a normal
  // review runs the deterministic phase, then the add-on-summary interleave (which
  // fills ctx.recheckVerdicts), then the post-summary phase. The two gates above
  // apply within each phase.
  const inPhase = (phase) =>
    (byPhase.get(phase) ?? []).filter(
      (c) => diffEligible(c, inDiffMode) && scaEligible(c, inScaMode)
    );
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
  // Each sibling ctx gets a note bound to the input that routes to it, so a feed note
  // is labelled by the artifact its check ran over. siblings.source (the source ctx) is
  // set explicitly; the loop then labels the rest, skipping any that alias it (in an XPI
  // review siblings.xpi IS the source ctx).
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
    // made (shared with the pipeline's deferred loop via routeCtx). The check reads
    // only its ctx.addon and has no way to reach another artifact.
    const checkCtx = routeCtx(check, siblings);
    const out = await runOneCheck(checkCtx, check, `[${i + 1}/${total}]`);
    findings.push(...out.findings);
    manualItems.push(...out.manualItems);
  }
  // Close the activity list with a blank line. A no-op when progress is off.
  progress("");

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
 * runChecks, extracted so a check can also be run on its own (a post-summary
 * recheck consumer runs after the add-on summary, outside the loop - see
 * runChecks below). Identical behavior either way: a check's `escalations` route to
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
    // ctx is already the artifact the caller routed this check to (runChecks /
    // pipeline, keyed on check.input). The check reads only ctx.addon; there is no
    // way here to reach the other artifact.
    const result = (await check.run(ctx, check)) || [];
    const produced = Array.isArray(result)
      ? [...result]
      : [...(result.findings ?? [])];
    const escalations = Array.isArray(result) ? [] : (result.escalations ?? []);
    if (escalations.length) {
      // Cases a person must inspect, straight to manual review.
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
