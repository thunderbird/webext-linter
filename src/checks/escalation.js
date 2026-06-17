// The orchestrator's escalation policy: how a case a check could not settle on
// its own becomes a finding or a manual-review note. Two lanes:
//
//   - LLM checks return a candidate set plus a `resolve` closure (run(ctx) ->
//     {findings, llm}). runLlmCheck asks the model for one verdict per candidate
//     id (or, with no token, defaults every candidate to "unsure") and hands the
//     verdicts back to the check's resolve, which maps ids to findings/manual
//     using its own id->data table. The model only ever returns verdicts keyed
//     to ids we minted, so it can never name a subject we did not ask about.
//   - Deterministic checks return `escalations` of cases a human must inspect;
//     manualEscalations routes them straight to manual review (never the model).
//
// Belongs here: runLlmCheck, manualEscalations, the ManualRef shape, and
// narrating each batch to the live feed. Does NOT belong here: judging verdicts
// or building candidates - that is a check under src/checks/rules/*. The batched
// transport (one model call per file-bounded batch) is src/checks/llm-client.js.
// Looping over checks and stamping severity is runChecks (src/checks/registry.js).
// Turning a ManualRef into user text is src/report/responses.js via the registry.

import { progress } from "../util/log.js";
import { red, green, blue } from "../util/color.js";
import { wrapText } from "../util/text.js";

/** @typedef {import("./registry.js").RunContext} RunContext */
/** @typedef {import("./registry.js").LoadedCheck} LoadedCheck */

/**
 * @typedef {object} Escalation  A deterministic case a human must inspect.
 * @property {?string} item  The offending token, for the `{{item}}` slot.
 * @property {Record<string, string|number>} [data]  Extra `{{slot}}` values for
 *   the manual instructions (e.g. a reason), filled like a finding's data.
 */

/**
 * @typedef {object} ManualRef  A pointer to a manual-review to-do (resolved to
 *   text from the registry later).
 * @property {string} ruleId  The owning check.
 * @property {?string} item  The offending token, for the `{{item}}` slot.
 * @property {"escalation"|"llm-error"} kind  Picks the registry message used.
 * @property {Record<string, string|number>|null} data  Extra `{{slot}}` values
 *   for the instructions template (null when the case carries none).
 */

/**
 * @typedef {object} LlmStep  What an LLM check returns under `run().llm`.
 * @property {Array<{id: string, file?: string, line?: number, note?: string,
 *   corpus?: string[]}>} candidates  The sites to judge; the check owns the ids.
 * @property {(verdicts: Map<string, {verdict: string, reason: ?string}>) =>
 *   {findings: object[], manual?: {item: ?string}[]}} resolve  Maps the per-id
 *   verdicts to findings + manual notes via the check's own id->data table.
 */

/**
 * Run an LLM check's candidates through the model and let the check interpret
 * the verdicts. With a token, one verdict per id (batched in llm-client); with
 * none, every candidate defaults to "unsure" so resolve routes it to manual.
 * Findings come back unstamped (runChecks stamps ruleId/severity).
 * @param {RunContext} ctx
 * @param {LoadedCheck} check
 * @param {LlmStep} step
 * @returns {Promise<{findings: object[], manualItems: ManualRef[]}>}
 */
export async function runLlmCheck(ctx, check, step) {
  const candidates = step.candidates ?? [];
  let verdicts;
  if (ctx.llm && candidates.length) {
    // Print the header BEFORE the request so the feed shows what is being waited
    // on while the (often slow, many-candidate) model call runs; verdicts follow.
    narrateBatchHeader(check, candidates);
    verdicts = await ctx.llm.evaluate({ rubric: check.prompt, candidates });
    narrateBatchVerdicts(candidates, verdicts);
  } else {
    verdicts = new Map(
      candidates.map((c) => [c.id, { verdict: "unsure", reason: null }])
    );
  }
  const { findings = [], manual = [] } = step.resolve(verdicts) || {};
  return {
    findings,
    manualItems: manual.map((m) => manualRef(check, m.item, "escalation")),
  };
}

/**
 * @param {LoadedCheck} check
 * @param {?string} item
 * @param {"escalation"|"llm-error"} kind
 * @param {Record<string, string|number>} [data]  Extra instruction slots.
 * @returns {ManualRef}
 */
function manualRef(check, item, kind, data) {
  return { ruleId: check.id, item: item ?? null, kind, data: data ?? null };
}

/**
 * Route a deterministic check's escalations straight to manual review. The LLM
 * is the authority for judgment cases; a deterministic check escalates only
 * cases a human must inspect, so they never reach the model.
 * @param {LoadedCheck} check
 * @param {Escalation[]} escalations
 * @returns {{findings: object[], manualItems: ManualRef[]}}
 */
export function manualEscalations(check, escalations) {
  return {
    findings: [],
    manualItems: escalations.map((e) =>
      manualRef(check, e.item, "escalation", e.data)
    ),
  };
}

// The live activity feed (stderr, TTY only; off for piped/JSON/test runs).
const HEAD = "      ↳ ";
const SECTION = "        ";
// pass green, fail red, unsure blue - a no-op unless the CLI enabled color.
const VERDICT_COLOR = { pass: green, fail: red, unsure: blue };

/**
 * Narrate the header of a batched LLM review (printed before the model call, so
 * the reviewer sees what the tool is waiting on while it runs).
 * @param {LoadedCheck} check
 * @param {LlmStep["candidates"]} candidates
 */
function narrateBatchHeader(check, candidates) {
  progress(
    `${HEAD}LLM review: ${check.title} (${candidates.length} candidate(s))`
  );
}

/**
 * Narrate the verdicts of a batched LLM review (printed after the model call):
 * each candidate as a bullet `<file>:<line> VERDICT - reason`, tinted by verdict.
 * The internal id is never shown - the reviewer sees the file:line site it points
 * at.
 * @param {LlmStep["candidates"]} candidates
 * @param {Map<string, {verdict: string, reason: ?string}>} verdicts
 */
function narrateBatchVerdicts(candidates, verdicts) {
  for (const c of candidates) {
    const v = verdicts.get(c.id) ?? { verdict: "unsure", reason: null };
    const loc = c.line != null ? `:${c.line}` : "";
    const where = `${c.file ?? "(add-on)"}${loc}`;
    const why = v.reason ? ` - ${v.reason}` : "";
    const tint = VERDICT_COLOR[v.verdict] ?? ((s) => s);
    // A bullet per candidate so the verdicts read as a separated list; wrapText
    // hangs continuation lines past the marker.
    wrapText(`• ${where} ${v.verdict.toUpperCase()}${why}`, SECTION).forEach(
      (line) => progress(tint(line))
    );
  }
}
