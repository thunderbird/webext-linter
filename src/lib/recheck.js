// The post-summary recheck mechanism: re-judging items an earlier check could
// not settle, using the whole-add-on context of the --llm-review pass.
//
// A check that declares `post-summary-recheck: R` hands the manual-review items
// it would have produced to the recheck consumer R (the orchestrator diverts
// them into ctx.recheck.get(R) - see runChecks - but only when the summary will
// run, recheckActive). Two helpers serve that flow:
//
//   buildRecheckSections(ctx, registry) - what summaries.js appends to the
//     add-on-summary prompt: one labeled section per recheck consumer that was
//     handed items, carrying that consumer's rubric and the list of item keys to
//     judge. Most consumers carry a static `summary-prompt`; a `permission-recheck`
//     consumer instead assembles its rubric per review from the permission-prompt-
//     framing + permission-prompts sections, including only the sections for the
//     permissions actually handed over. The model returns a verdict per item in the
//     review's `recheck` field (stored on ctx.recheckVerdicts).
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
// Belongs here: the prompt composition and the verdict->finding/manual mapping,
// including gating a pass on cited evidence for a require-citation consumer (the
// adjudication itself is delegated to src/lib/citation.js). Does NOT belong here:
// diverting a producer's manual items (-> runChecks), the summary transport and
// storing ctx.recheckVerdicts (-> src/checks/summaries.js), or the recheck output
// schema (-> src/llm/schema.js).

import { finding } from "../report/finding.js";
import { wrap } from "./untrusted.js";
import { versionInBounds } from "./util.js";
import { verifyCitation } from "./citation.js";
import { recheckTokenVocab } from "./permissions.js";

/** @typedef {import("../checks/registry.js").RunContext} RunContext */
/** @typedef {import("../checks/registry.js").LoadedCheck} LoadedCheck */

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
 * @param {import("../checks/registry.js").Registry} registry
 * @param {string} nonce  The per-review nonce wrapping the item lists.
 * @param {?Set<string>} [consumers]  When set, only these recheck-consumer ids are
 *   emitted - the SCA split runs one summary per corpus, each carrying the consumers
 *   anchored to that corpus. Undefined = every bucket (a single all-in-one summary).
 * @returns {{rubric: string, items: string}}
 */
export function buildRecheckSections(ctx, registry, nonce, consumers) {
  const buckets = ctx.recheck;
  if (!buckets || !buckets.size) {
    return { rubric: "", items: "" };
  }
  const rubrics = [];
  const itemBlocks = [];
  for (const [id, items] of buckets) {
    if (!items.length || (consumers && !consumers.has(id))) {
      continue;
    }
    const entry = registry.checkEntry(id);
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
    // A permission-recheck consumer assembles its rubric from the registry's
    // permission-prompts for just the permissions being rechecked (keys); every
    // other consumer carries a static summary-prompt. Either may be "" (no rubric),
    // in which case the items stay unjudged and resolveRecheck falls them to manual.
    let prompt;
    let itemKeys = keys;
    if (entry?.["permission-recheck"]) {
      const assembled = assemblePermissionPrompt(registry, ctx, keys);
      prompt = assembled.prompt;
      // Only ask the model about permissions the rubric actually grounds. A handed
      // permission whose sole prompt is version-filtered out is not grounded here, so
      // it must fall to manual (resolveRecheck's no-verdict path), never be judged blind.
      itemKeys = keys.filter((k) => assembled.grounded.has(k));
    } else {
      prompt = entry?.["summary-prompt"];
    }
    if (!prompt || !itemKeys.length) {
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
        itemKeys.map((k) => `- ${k}`).join("\n"),
        `id=${JSON.stringify(id)}`
      )
    );
  }
  return { rubric: rubrics.join("\n\n"), items: itemBlocks.join("\n\n") };
}

/**
 * Assemble the unused-permission recheck rubric for the permissions being rechecked:
 * the shared framing wraps only the permission-prompts entries that cover one of the
 * requested `permissions` and whose version bounds fit the add-on's strict_min_version,
 * deduped in registry order. A prompt's `{{note:<member>}}` placeholder is replaced
 * with the version-matched `note` annotation(s) on that schema member (the
 * dual-purpose doc/review notes). Returns the rubric AND the set of permissions it
 * actually grounds: a requested permission whose only entry is version-filtered out
 * is not in `grounded`, so the caller drops it from the items sent to the model.
 * `prompt` is "" when no entry matches at all.
 * @param {import("../checks/registry.js").Registry} registry
 * @param {import("../checks/registry.js").RunContext} ctx  For the manifest (version
 *   bounds) and the schema (member notes).
 * @param {string[]} permissions  The permissions handed to this recheck.
 * @returns {{prompt: string, grounded: Set<string>}}
 */
function assemblePermissionPrompt(registry, ctx, permissions) {
  const want = new Set(permissions);
  const entries = registry
    .permissionPrompts()
    .filter(
      (e) =>
        e.permissions.some((p) => want.has(p)) &&
        versionInBounds(ctx.manifest, e.minStrictVersion, e.maxStrictVersion)
    );
  const grounded = new Set(entries.flatMap((e) => e.permissions));
  if (!entries.length) {
    return { prompt: "", grounded };
  }
  const { preamble, closing } = registry.permissionPromptFraming();
  const prompt = [
    preamble,
    ...entries.map((e) => renderPermissionEntry(e, ctx)),
    closing,
  ]
    .filter(Boolean)
    .join("\n");
  return { prompt, grounded };
}

// One permission entry as it appears in the rubric: its prose (schema-member notes
// resolved) followed by the accepted tokens the model must cite one of for a pass, so
// it knows the exact strings that ground the permission. An entry with no tokens
// (unlimitedStorage - not token-detectable) renders prose only.
function renderPermissionEntry(e, ctx) {
  const body = resolveNotes(e.prompt, ctx);
  if (!e.tokens?.length) {
    return body;
  }
  return `${body}\nAccepted tokens (cite the one that appears in the code): ${e.tokens.join(", ")}.`;
}

// Replace each `{{note:<ns>.<member>}}` in a prompt with the version-matched `note`
// annotation(s) on that schema member (joined). A member with no note, or none in
// version bounds, resolves to empty.
function resolveNotes(text, ctx) {
  return text.replace(/\{\{note:([\w.]+)\}\}/g, (_, path) => {
    const matched = [];
    for (const n of ctx.schema?.memberNotes?.(path) ?? []) {
      if (
        versionInBounds(ctx.manifest, n.minStrictVersion, n.maxStrictVersion)
      ) {
        matched.push(n.note);
      }
    }
    return matched.join(" ");
  });
}

/**
 * The feed suffix for a verified pass: the item label plus the location the evidence
 * was accepted at, `file:lines (token)` (token omitted for a structural-only pass),
 * so a reviewer can spot-check the accepted pass at a line.
 * @param {?string} label @param {import("../llm/schema.js").RecheckUsage} cited
 * @returns {string}
 */
function citedLabel(label, cited) {
  const loc = cited.token
    ? `${cited.file}:${cited.lines} (${cited.token})`
    : `${cited.file}:${cited.lines}`;
  return label ? `${label} — ${loc}` : loc;
}

/**
 * The run() of a recheck consumer. Maps the summary's verdict for each handed-over
 * item to the ordinary check contract: pass -> drop, fail -> finding, unsure or
 * no verdict -> manual review (carrying the model's reason). Only items handed to
 * THIS consumer are consulted (the guard).
 *
 * A consumer that requires citation (check.requireCitation) accepts a `pass` only
 * when its cited evidence verifies (verifyCitation) against the accepted-token
 * vocabulary for the item; an ungrounded pass is downgraded to unsure -> manual, the
 * safe direction, so a hallucinated "it's used" never silently drops a real issue.
 *
 * The verdicts and handed items live on the main ctx, but the citation is verified
 * against `corpusCtx` - the PRODUCER's artifact (the same corpus the summary numbered
 * and showed the model), resolved by the caller via ctxForRule. It equals `ctx` for a
 * source-anchored recheck and in any XPI review; only an SCA xpi-anchored recheck
 * differs. Callers that never cite may omit it.
 * @param {RunContext} ctx
 * @param {LoadedCheck} check  The recheck consumer (its id keys ctx.recheck).
 * @param {RunContext} [corpusCtx]  The producer's corpus for citation; defaults to ctx.
 * @returns {{findings: object[], escalations: {item: ?string, hint: ?string,
 *   file: ?string, loc: ?object, data: object}[]}}
 */
export function resolveRecheck(ctx, check, corpusCtx = ctx) {
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
  // The accepted-token vocabulary per item, assembled once, when this consumer
  // verifies cited evidence. Read from the PRODUCER's corpus (corpusCtx) so the
  // version-filtered tokens match the artifact a pass is cited against. Empty for an
  // item with no vocabulary -> the citation is checked structurally only.
  const vocab = check.requireCitation
    ? recheckTokenVocab(corpusCtx, check)
    : null;
  const findings = [];
  const escalations = [];
  for (const ref of handed) {
    const key = itemKey(ref);
    const v = key != null ? verdicts.get(key) : undefined;
    let verdict = v?.verdict ?? "unsure";
    // The feed suffix after `file:line`: the item token, else a per-locus hint
    // (e.g. a transmission method). Never the file - that only repeated the locus.
    const label = ref.item ?? ref.hint ?? null;
    // Label the feed note by the corpus this consumer ACTS ON (its producer's), not
    // the main ctx it runs on to read ctx.recheck - so a recheck's notes carry [XPI]
    // when they re-judge XPI-corpus items. check.labelInput is set at load; it falls
    // back to the note's bound input when absent.
    const labelInput = check.labelInput;
    // A pass this consumer requires to be cited: verify the evidence. A verified pass
    // drops as usual; an unverifiable one becomes unsure and falls to manual below.
    let citationReason = null;
    if (verdict === "pass" && check.requireCitation) {
      const cited = verifyCitation(v?.usages, vocab.get(key), corpusCtx);
      if (cited) {
        ctx.note?.(
          ref.file,
          ref.loc,
          citedLabel(label, cited),
          "pass",
          labelInput
        );
        continue;
      }
      verdict = "unsure";
      citationReason = "claimed used, but the cited evidence did not verify";
    }
    if (verdict === "pass") {
      ctx.note?.(ref.file, ref.loc, label, "pass", labelInput);
      continue; // the summary confirmed it is used / justified - drop it
    }
    const data = {
      ...(ref.data ?? {}),
      reason: citationReason ?? v?.reason ?? "",
    };
    if (verdict === "fail") {
      ctx.note?.(ref.file, ref.loc, label, "fail", labelInput);
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
      ctx.note?.(ref.file, ref.loc, label, "unsure", labelInput);
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
