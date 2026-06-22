// The post-summary recheck mechanism: re-judging items an earlier check could
// not settle, using the whole-add-on context of the --full-summary pass.
//
// A check that declares `post-summary-recheck: R` hands the manual-review items
// it would have produced to the recheck consumer R (the orchestrator diverts
// them into ctx.recheck.get(R) - see runChecks - but only when the summary will
// run, ctx.recheckActive). Two helpers serve that flow:
//
//   buildRecheckSections(ctx, registry) - what summaries.js appends to the
//     add-on-summary prompt: one labeled section per recheck consumer that was
//     handed items, carrying that consumer's `summary-prompt` rubric and the list
//     of item keys to judge. The model returns a verdict per item in the review's
//     `recheck` field (ctx.addon.recheck).
//
//   resolveRecheck(ctx, check) - the shared run() of every recheck consumer (a
//     normal post-summary check). It reads the items handed to THIS consumer and
//     the summary's verdicts, then follows the ordinary check contract: pass ->
//     drop (used), fail -> finding (the issue is present), unsure or no verdict
//     (summary skipped / errored) -> manual review. The consumer's own registry
//     wording (response/instructions) renders the result, since runOneCheck
//     stamps the finding/escalation with the consumer's id and severity.
//
// The guard: resolveRecheck only ever consults verdicts for items actually handed
// to this consumer, so the summary can neither invent items nor flip anything it
// was not given.
//
// Belongs here: the prompt composition and the verdict->finding/manual mapping.
// Does NOT belong here: diverting a producer's manual items (-> runChecks), the
// summary transport and storing ctx.addon.recheck (-> src/checks/summaries.js),
// or the recheck output schema (-> src/llm/schema.js).

import { finding } from "../../report/finding.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../registry.js").LoadedCheck} LoadedCheck */

/**
 * The key that ties a handed-over manual item to the summary's verdict for it:
 * the item token when present (e.g. a permission), else the file (e.g. an unused
 * file). The recheck section lists these, and the model echoes them back.
 * @param {{item?: ?string, file?: ?string}} ref
 * @returns {?string}
 */
function itemKey(ref) {
  return ref.item ?? ref.file ?? null;
}

/**
 * The add-on-summary prompt fragment that asks the model to re-judge every item
 * handed to a recheck consumer. One section per consumer (with items), each
 * carrying that consumer's `summary-prompt` rubric and its item keys. Returns ""
 * when nothing was handed over, so the summary prompt is unchanged.
 * @param {RunContext} ctx
 * @param {import("../registry.js").Registry} registry
 * @returns {string}
 */
export function buildRecheckSections(ctx, registry) {
  const buckets = ctx.recheck;
  if (!buckets || !buckets.size) {
    return "";
  }
  const sections = [];
  for (const [id, items] of buckets) {
    if (!items.length) {
      continue;
    }
    const prompt = registry.checkEntry(id)?.["summary-prompt"];
    if (!prompt) {
      // A recheck target with no rubric: leave its items unjudged - the consumer
      // (resolveRecheck) falls them back to manual review, so none are lost.
      continue;
    }
    const keys = [];
    const seen = new Set();
    for (const ref of items) {
      const key = itemKey(ref);
      if (key != null && !seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
    sections.push(
      `=== recheck: ${id} ===\n${prompt}\n\n` +
        "Items to judge (return one entry in the recheck field for each, with " +
        `check="${id}" and the exact item text):\n` +
        keys.map((k) => `- ${k}`).join("\n")
    );
  }
  return sections.join("\n\n");
}

/**
 * The run() of a recheck consumer. Maps the summary's verdict for each handed-over
 * item to the ordinary check contract: pass -> drop, fail -> finding, unsure or
 * no verdict -> manual review (carrying the model's reason). Only items handed to
 * THIS consumer are consulted (the guard).
 * @param {RunContext} ctx
 * @param {LoadedCheck} check  The recheck consumer (its id keys ctx.recheck).
 * @returns {{findings: object[], escalations: {item: ?string, file: ?string,
 *   loc: ?object, data: object}[]}}
 */
export function resolveRecheck(ctx, check) {
  const handed = ctx.recheck?.get(check.id) ?? [];
  if (!handed.length) {
    return { findings: [], escalations: [] };
  }
  // The summary's verdicts for THIS consumer, indexed by item key. Only keys we
  // hand over are ever looked up below, so a verdict for anything else is inert.
  const verdicts = new Map();
  for (const v of ctx.addon?.recheck ?? []) {
    if (v && v.check === check.id && typeof v.item === "string") {
      verdicts.set(v.item, v);
    }
  }
  const findings = [];
  const escalations = [];
  for (const ref of handed) {
    const key = itemKey(ref);
    const v = key != null ? verdicts.get(key) : undefined;
    const verdict = v?.verdict ?? "unsure";
    const label = ref.item ?? ref.file ?? null;
    if (verdict === "pass") {
      ctx.note?.(ref.file, ref.loc, label, "pass");
      continue; // the summary confirmed it is used / justified - drop it
    }
    const data = { ...(ref.data ?? {}), reason: v?.reason ?? "" };
    if (verdict === "fail") {
      ctx.note?.(ref.file, ref.loc, label, "fail");
      findings.push(
        finding({ file: ref.file, loc: ref.loc, item: ref.item, data })
      );
    } else {
      // unsure, or no verdict at all (the summary was skipped or errored): the
      // item still needs a human, so route it to manual review.
      ctx.note?.(ref.file, ref.loc, label, "unsure");
      escalations.push({
        item: ref.item ?? null,
        file: ref.file ?? null,
        loc: ref.loc ?? null,
        data,
      });
    }
  }
  return { findings, escalations };
}
