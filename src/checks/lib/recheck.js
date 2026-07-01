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
//     `recheck` field (stored on ctx.recheckVerdicts).
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
// summary transport and storing ctx.recheckVerdicts (-> src/checks/summaries.js),
// or the recheck output schema (-> src/llm/schema.js).

import { finding } from "../../report/finding.js";
import { wrap } from "./untrusted.js";

/** @typedef {import("../registry.js").RunContext} RunContext */
/** @typedef {import("../registry.js").LoadedCheck} LoadedCheck */

/**
 * The key that ties a handed-over manual item to the summary's verdict for it:
 * the item token when present (e.g. a permission), else the file (e.g. an unused
 * file) - narrowed to `file:line` when the item carries a locus, so a per-site
 * producer (several sinks in one file) does not collapse to a single key. The
 * recheck section lists these keys, and the model echoes them back. So a per-site
 * recheck case (data-exfiltration, disguised-transmission) MUST leave `item` null
 * and key on `file:line`; its descriptor (the method/channel) rides on `hint`, not
 * `item` - else two sinks of the same kind would collide (see report/finding.js).
 * @param {{item?: ?string, file?: ?string, loc?: ?{line?: number}}} ref
 * @returns {?string}
 */
function itemKey(ref) {
  if (ref.item != null) {
    return ref.item;
  }
  if (ref.file == null) {
    return null;
  }
  return ref.loc?.line != null ? `${ref.file}:${ref.loc.line}` : ref.file;
}

/**
 * The recheck contribution to the add-on-summary prompt, split by trust: the trusted
 * `rubric` (each consumer's `summary-prompt` plus a uniform instruction to surface
 * fail/unsure verdicts as a labeled bullet) joins the SYSTEM prompt, while the
 * untrusted `items` (file paths etc.) are wrapped in nonce markers for the USER data,
 * each tagged with its check id so the model can correlate. Attaching the bullet
 * instruction here, in the orchestrator, is what makes every recheck reach the
 * summary - not each consumer's own rubric. Both are "" when nothing was handed over.
 * @param {RunContext} ctx
 * @param {import("../registry.js").Registry} registry
 * @param {string} nonce  The per-review nonce wrapping the item lists.
 * @returns {{rubric: string, items: string}}
 */
export function buildRecheckSections(ctx, registry, nonce) {
  const buckets = ctx.recheck;
  if (!buckets || !buckets.size) {
    return { rubric: "", items: "" };
  }
  const rubrics = [];
  const itemBlocks = [];
  for (const [id, items] of buckets) {
    if (!items.length) {
      continue;
    }
    const entry = registry.checkEntry(id);
    const prompt = entry?.["summary-prompt"];
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
    if (!keys.length) {
      continue;
    }
    const label = entry.title || id;
    rubrics.push(
      `=== recheck: ${id} ===\n${prompt}\n\n` +
        `Judge each item in the data block tagged RECHECK-ITEMS id=${JSON.stringify(id)}; ` +
        `return one recheck entry per item with check="${id}" and the exact item ` +
        'text. For every item you judge "fail" or "unsure", add a separate bullet ' +
        `point to the prose "summary" field, labeled "${label}", naming those items ` +
        "with a one-line reason, so the reviewer sees them in the overview and not " +
        "only in the structured result."
    );
    itemBlocks.push(
      wrap(
        nonce,
        "RECHECK-ITEMS",
        keys.map((k) => `- ${k}`).join("\n"),
        `id=${JSON.stringify(id)}`
      )
    );
  }
  return { rubric: rubrics.join("\n\n"), items: itemBlocks.join("\n\n") };
}

/**
 * The run() of a recheck consumer. Maps the summary's verdict for each handed-over
 * item to the ordinary check contract: pass -> drop, fail -> finding, unsure or
 * no verdict -> manual review (carrying the model's reason). Only items handed to
 * THIS consumer are consulted (the guard).
 * @param {RunContext} ctx
 * @param {LoadedCheck} check  The recheck consumer (its id keys ctx.recheck).
 * @returns {{findings: object[], escalations: {item: ?string, hint: ?string,
 *   file: ?string, loc: ?object, data: object}[]}}
 */
export function resolveRecheck(ctx, check) {
  const handed = ctx.recheck?.get(check.id) ?? [];
  if (!handed.length) {
    return { findings: [], escalations: [] };
  }
  // The summary's verdicts for THIS consumer, indexed by item key. Only keys we
  // hand over are ever looked up below, so a verdict for anything else is inert.
  const verdicts = new Map();
  for (const v of ctx.recheckVerdicts ?? []) {
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
    // The feed suffix after `file:line`: the item token, else a per-locus hint
    // (e.g. a transmission method). Never the file - that only repeated the locus.
    const label = ref.item ?? ref.hint ?? null;
    if (verdict === "pass") {
      ctx.note?.(ref.file, ref.loc, label, "pass");
      continue; // the summary confirmed it is used / justified - drop it
    }
    const data = { ...(ref.data ?? {}), reason: v?.reason ?? "" };
    if (verdict === "fail") {
      ctx.note?.(ref.file, ref.loc, label, "fail");
      findings.push(
        finding({
          file: ref.file,
          loc: ref.loc,
          item: ref.item,
          hint: ref.hint,
          data,
        })
      );
    } else {
      // unsure, or no verdict at all (the summary was skipped or errored): the
      // item still needs a human, so route it to manual review.
      ctx.note?.(ref.file, ref.loc, label, "unsure");
      escalations.push({
        item: ref.item ?? null,
        hint: ref.hint ?? null,
        file: ref.file ?? null,
        loc: ref.loc ?? null,
        data,
      });
    }
  }
  return { findings, escalations };
}
