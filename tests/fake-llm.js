// Deterministic, offline fakes for the LLM transports, so the golden harness can
// exercise the --llm-review paths without a network or a real model. The pipeline
// threads opts.llmTransport = {callVerdicts, callText, callReview} to both the review
// client (createLlmClient) and the setup-time model calls (resolveVendor / verifyVendor
// / analyzeBuild); when it is absent every site falls back to the real provider. A
// fixture that wants LLM coverage ships an `llm.js` declaring what the model "answers",
// and run-tests.js turns that into an llmTransport via makeFakeTransport.
//
// The fixture writes the RAW provider responses (the shapes the adapters return after
// coercion - see src/llm/schema.js), which then flow through the real client and
// pipeline. The three transports:
//   callVerdicts({criterion, ...}) -> { verdicts: [{id, verdict, reason, additionalInformation}] }
//   callReview({system, prompt})   -> { summary, recheck: [{check, item, verdict, reason}] }
//   callText({system, prompt})     -> string
// A fixture spells its verdicts as plain strings ("fail"/"pass"/"unsure"); like the real
// coercion, the fake wraps each into a VERDICT (src/lib/enum.js) so the transport
// return matches an adapter's post-coercion shape - a verdict is a VERDICT past the wire.
//
// A transport the spec does not mention becomes a THROWING stub, never the real
// provider - so a fixture that makes an undeclared model call fails loudly instead of
// silently reaching the network.

import { wireVerdict } from "../src/llm/schema.js";

/**
 * Recover the candidate refs from a verdict criterion. buildCriterion (llm-client.js)
 * emits a `CANDIDATES:` section of `<id>: <file>:<line> (note)` lines, ended by a blank
 * line before `FILES (...)`. The model is asked for one verdict per id; the fake sees only
 * the criterion, so it parses each line back into {id, file, line, note} - letting a fixture
 * pick a verdict by file:line rather than by the opaque orchestrator id.
 * @param {string} criterion
 * @returns {{id: string, file: string, line?: number, note?: string}[]}
 */
export function candidateRefs(criterion) {
  const lines = String(criterion).split("\n");
  const start = lines.indexOf("CANDIDATES:");
  if (start === -1) {
    return [];
  }
  const refs = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") {
      break; // the blank line before the FILES block
    }
    const sep = line.indexOf(": ");
    if (sep <= 0) {
      continue;
    }
    const id = line.slice(0, sep);
    let rest = line.slice(sep + 2);
    const noteM = rest.match(/ \((.*)\)$/);
    const note = noteM ? noteM[1] : undefined;
    if (noteM) {
      rest = rest.slice(0, noteM.index);
    }
    const locM = rest.match(/^(.*):(\d+)$/);
    refs.push({
      id,
      file: locM ? locM[1] : rest,
      line: locM ? Number(locM[2]) : undefined,
      note,
    });
  }
  return refs;
}

/** Normalize a spec verdict (a bare "fail"/"pass"/"unsure" or a {verdict,...} object)
 *  into a full transport verdict entry for one id. */
function verdictEntry(id, v) {
  const o = typeof v === "string" ? { verdict: v } : (v ?? {});
  return {
    id,
    verdict: wireVerdict(o.verdict),
    reason: o.reason ?? null,
    additionalInformation: o.additionalInformation ?? "",
  };
}

/**
 * Recover the (consumer, item) pairs the add-on-summary prompt asks the model to
 * re-judge. buildRecheckSections (lib/recheck.js) wraps each consumer's item keys in a
 * `[[[BEGIN RECHECK-ITEMS <nonce> id="<consumer>"]]] - <key> ... [[[END ...]]]` block, so
 * the fake can answer exactly the items each pass carries (in SCA the two passes carry
 * different consumers) without hardcoding brittle key strings.
 * @param {string} prompt
 * @returns {{check: string, item: string}[]}
 */
export function recheckItems(prompt) {
  const re =
    /\[\[\[BEGIN RECHECK-ITEMS \S+ id=("(?:[^"\\]|\\.)*")\]\]\]\n([\s\S]*?)\n\[\[\[END RECHECK-ITEMS/g;
  const pairs = [];
  for (const m of String(prompt).matchAll(re)) {
    const check = JSON.parse(m[1]);
    for (const line of m[2].split("\n")) {
      if (line.startsWith("- ")) {
        pairs.push({ check, item: line.slice(2) });
      }
    }
  }
  return pairs;
}

/** Look up a per-item recheck verdict in a spec map. A consumer's entry may be a bare
 *  verdict string (applied to all its items) or an item->verdict object. For the
 *  permission recheck an item is a token-occurrence id ("<permission>#<n>") or, for a
 *  token-less permission, the permission itself. */
function recheckVerdict(map, dflt, check, item) {
  const perCheck = map?.[check];
  const v = typeof perCheck === "string" ? perCheck : perCheck?.[item];
  const o = typeof v === "string" ? { verdict: v } : v;
  return {
    check,
    item,
    verdict: wireVerdict(o?.verdict ?? dflt),
    reason: o?.reason ?? "",
  };
}

/** Resolve a spec field that may be a plain value, an ordered list consumed one per
 *  call, or a function of the call args. `next()` advances the per-field call counter. */
function pick(field, args, next) {
  if (typeof field === "function") {
    return field(args);
  }
  if (Array.isArray(field)) {
    const i = next();
    if (i >= field.length) {
      throw new Error(
        `fake-llm: more calls than declared responses (call #${i + 1})`
      );
    }
    return field[i];
  }
  return field; // one value reused for every call
}

/**
 * Build an llmTransport from a fixture's declarative spec. Every field is optional; an
 * omitted transport throws if the run calls it (so an undeclared model call is loud, not
 * a network hit).
 *
 * @param {object} spec
 * @param {Object<string, string|object> | ((ref: object) => string|object)} [spec.verdicts]
 *   Per-candidate verdict: an id->verdict map, or a function of the parsed candidate ref
 *   {id, file, line, note} (so a fixture can key on file:line). A verdict is a bare
 *   "fail"|"pass"|"unsure" or a {verdict, reason?, additionalInformation?} object. Candidates
 *   not covered fall back to spec.verdictDefault.
 * @param {string} [spec.verdictDefault]  Verdict for candidates the map/function omits
 *   (default "unsure", matching a token-less run).
 * @param {object | object[] | ((args: object) => object)} [spec.review]  The reviewAddon
 *   result. Each descriptor is `{summary, recheck?}` (recheck verbatim) OR
 *   `{summary, recheckVerdicts?, recheckDefault?}`, where the fake derives one recheck entry
 *   per item the prompt asks about (recheckItems), looking the verdict up in recheckVerdicts
 *   (a consumer->verdict string, or consumer->{item: verdict}) and falling back to
 *   recheckDefault ("unsure"). An array is consumed one per call (the SCA two-pass:
 *   [sourcePass, packagingPass]); a function receives {system, prompt}. A single descriptor
 *   is reused for every call - and since recheck is derived from each call's own prompt, one
 *   descriptor answers both SCA passes correctly.
 * @param {string | string[] | ((args: object) => string)} [spec.text]  The callText result.
 *   Shared by the diff summary and the setup-time calls (analyzeBuild build classification);
 *   an array is consumed one per call, a function receives {system, prompt}.
 * @returns {{callVerdicts: Function, callText: Function, callReview: Function}}
 */
export function makeFakeTransport(spec = {}) {
  const counters = { review: 0, text: 0 };
  const stub = (name) => () => {
    throw new Error(
      `unexpected LLM call: ${name} (not declared in this fixture's llm.js)`
    );
  };

  const callVerdicts =
    spec.verdicts === undefined
      ? stub("callVerdicts")
      : async ({ criterion }) => {
          const dflt = spec.verdictDefault ?? "unsure";
          const lookup =
            typeof spec.verdicts === "function"
              ? spec.verdicts
              : (ref) => spec.verdicts[ref.id];
          const verdicts = candidateRefs(criterion).map((ref) =>
            verdictEntry(ref.id, lookup(ref) ?? dflt)
          );
          return { verdicts };
        };

  const callReview =
    spec.review === undefined
      ? stub("callReview")
      : async (args) => {
          const r = pick(spec.review, args, () => counters.review++) ?? {};
          const recheck =
            r.recheck ??
            recheckItems(args.prompt).map(({ check, item }) =>
              recheckVerdict(
                r.recheckVerdicts,
                r.recheckDefault ?? "unsure",
                check,
                item
              )
            );
          return { summary: r.summary ?? "", recheck };
        };

  const callText =
    spec.text === undefined
      ? stub("callText")
      : async (args) => String(pick(spec.text, args, () => counters.text++));

  return { callVerdicts, callText, callReview };
}
