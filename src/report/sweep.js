// What a sweep found, and where each result belongs. The agent that swept cannot see the
// check it swept FOR - it reads the add-on, not the linter - so it classifies nothing and
// names nothing of the review: it answers a LABEL with a location and what is there, the
// label is resolved to a check and a tree where the answers are read
// (src/report/sweep-files.js), and the routing is decided here.
//
// A SWEEP IS A DETECTOR, NOTHING MORE. What comes back is a hint: a location its check's
// own detectors missed. From that point the case is one of that check's, handled exactly
// as a case that check found for itself - which is the whole rule:
//
//   the check escalates  -> an escalation of that check, in the section that check's own
//                           wording puts it in, worded by those same instructions. A swept
//                           case and a detected one ask the reader the same question.
//   it does not          -> a FINDING of that check. A check that authors no wording
//                           settles its cases as findings, so a swept one is a finding
//                           too, and the verify phase audits it like every other claim.
//
// So a sweep instruction is read in two places, neither of them here: the request handed
// to the sweep agent, and the report's Standard Code Review list, which names the blind
// spots a reviewer covers by hand when no agent is sweeping. It says what to LOOK FOR, in
// the one tree its sweep is locked onto. It never says what confirming something means -
// that is the owning check's to say.
//
// Belongs here: holding an authored result to a shape, refusing what cannot be routed, and
// building the items. The results arrive already resolved to a check and a tree, from the
// file each sweeping agent wrote (src/report/sweep-files.js), which is also where they are
// checked for being present and for being a list.
// Does NOT belong here: what a settled item becomes (-> src/report/verdicts.js), the
// wording of either (-> assets/registry.yaml), or running the sweep, which the linter
// never does - an agent does, into a file of its own.

import path from "node:path";
import { hasParentSegment } from "../addon/load.js";
import { manualEscalations } from "../checks/escalation.js";
import { renderManualItems } from "./responses.js";
import { finding } from "./finding.js";

/** @typedef {import("../checks/registry.js").Registry} Registry */

/** The fields a result may carry: where it is, and what is there. WHICH sweep it answers
 *  is not among them - that is the slot it was written into, which is why a hint cannot be
 *  misattributed. Everything about how it reads - its band, its response, the paragraph a
 *  developer gets - is the registry's, so a result that sets anything more is refused
 *  rather than quietly ignored. */
const RESULT_FIELDS = ["file", "line", "hint"];

/** What the agent writes for one thing it found. THE one spelling of the shape - the
 *  message a malformed result is refused with, and the worked example a sweeping agent is
 *  shown (src/report/sweep-files.js), so what is asked for and what is accepted cannot
 *  drift. Its hint is a placeholder, because a plausible finding in an example is a
 *  suggestion about what to go and find. */
export const RESULT_SHAPE =
  '{"file": "background.js", "line": 40, "hint": "<what is there>"}';

// A hint names what sits at one location and is printed on that location's line. Past
// roughly this it stops being an annotation and starts being a paragraph someone wrote
// for the developer, which is the registry's job.
const MAX_HINT = 200;

/**
 * One thing a sweep found, checked.
 *
 * The agent authors these - the linter cannot, since a sweep exists for what its detectors
 * miss - so this is where an authored row is held to a shape. It is refused rather than
 * repaired: a result nothing can be done with is a sweep half applied.
 *
 * The extra-field check matters more than it looks. A result says WHERE something is and
 * names it in a phrase; where it lands and how it reads to a developer are the linter's,
 * from the owning check's registry entry. A row that set its own severity or response
 * would be an agent wording the report.
 * @param {string} where  Names the slot it was written into, for the message.
 * @param {*} raw
 * @returns {{file: string, line: ?number, hint: ?string}}
 */
export function checkedResult(where, raw) {
  const at = where;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${at} must be an object, e.g. ${RESULT_SHAPE}`);
  }
  const extra = Object.keys(raw).filter((k) => !RESULT_FIELDS.includes(k));
  if (extra.length) {
    throw new Error(
      `${at} carries ${extra.map((k) => JSON.stringify(k)).join(", ")} - a result may only set ${RESULT_FIELDS.map((k) => `"${k}"`).join(", ")}, because where it lands and how it reads are the linter's`
    );
  }
  if (typeof raw.file !== "string" || raw.file === "") {
    throw new Error(
      `${at} names no "file" - a result must say where it was found, e.g. ${RESULT_SHAPE}`
    );
  }
  // A result's path is AUTHORED by the agent, and it is the only path in the review that
  // is. Downstream it is resolved against the artifact's root and handed back as a file to
  // open (src/report/handback.js entriesFor), so a value that steps out of the artifact
  // would have the linter publish a path outside the submission as its own claim. Refused
  // in the same terms the reviewer's own folder flags are (src/addon/load.js
  // hasParentSegment): a path names a file in the add-on, never a way out of it.
  // "." and "./" are the two that walk nowhere: neither is absolute and neither holds a
  // `..`, so they reach the resolver, which normalises them to the root and refuses them
  // there - from a point the agent cannot be told about and before the review's state
  // advances, so every retry re-throws and the review is dead. Refused here instead, where
  // the caller turns this into a hand-back the agent can correct (src/report/handback.js).
  // normalize keeps a trailing separator ("./" stays "./"), so strip it before asking -
  // the resolver compares a RESOLVED path and would catch both.
  const within = path.normalize(raw.file).replace(/[\\/]+$/, "");
  if (
    path.isAbsolute(raw.file) ||
    hasParentSegment(raw.file) ||
    within === "" ||
    within === "."
  ) {
    throw new Error(
      `${at} has file ${JSON.stringify(raw.file)} - a result names a file INSIDE the add-on, relative to its root, never an absolute path, a way out of one, or the root itself`
    );
  }
  if (raw.line !== undefined && (!Number.isInteger(raw.line) || raw.line < 1)) {
    throw new Error(
      `${at} has line ${JSON.stringify(raw.line)} (expected a whole number from 1)`
    );
  }
  if (
    raw.hint !== undefined &&
    (typeof raw.hint !== "string" || raw.hint === "")
  ) {
    throw new Error(
      `${at} has hint ${JSON.stringify(raw.hint)} (expected a short phrase naming what is there)`
    );
  }
  if (typeof raw.hint === "string" && raw.hint.length > MAX_HINT) {
    throw new Error(
      `${at} has a ${raw.hint.length}-character hint - a hint names what sits at that location in at most ${MAX_HINT} characters; the response a developer reads is the linter's`
    );
  }
  return {
    file: raw.file,
    line: raw.line ?? null,
    hint: raw.hint ?? null,
  };
}

/**
 * Route every result the way its check routes its own cases, and hand back both lists with
 * them merged in.
 *
 * Refused rather than skipped, because a result nothing can be done with is a sweep half
 * applied: a result naming a check this review asked nobody to sweep for is a file
 * written against a different review. WHICH sweeps were asked for is settled upstream,
 * where the answers were read against the very slots this run wrote (readSweepAnswers) -
 * here the question left is only whether the check can receive a case at all.
 *
 * Deduplicated on (check, artifact, file, line) against BOTH lists: one sweep naming a
 * location twice is one case, and a location the deterministic pass already covered for
 * that check in that tree - as a to-do item or as a finding - is already in the review.
 * Both are scanned because either is what the pass would have produced, depending on
 * whether that check escalates.
 * @param {object} args
 * @param {{check: string, artifact: string, file: string, line: ?number,
 *   hint: ?string}[]} args.results  Each already saying which check it answers and which
 *   tree it was found in - resolved from its label by whoever read the answers file
 *   (src/report/sweep-files.js), because by the time a result reaches here the review is
 *   a serialized state with no artifact left to ask.
 * @param {object[]} args.manual  The rendered to-do list so far (meta.manualReview).
 * @param {object[]} args.findings  The findings so far, for dedup and for the new ones.
 * @param {Registry} args.registry
 * @param {{sca?: boolean}} [args.mode]  The review mode, for a check that words its
 *   response per mode - a swept case is worded from that same text.
 * @returns {{manual: object[], findings: object[], applied: string[]}}
 */
export function mergeSweepResults({
  results,
  manual,
  findings,
  registry,
  mode,
}) {
  const seen = new Set();
  const refs = [];
  const found = [];
  const applied = [];
  for (const r of results) {
    const { check, artifact } = r;
    // Not named after a file, and not a refusal the agent can act on: every result got
    // here by answering a label this review wrote, so a check that cannot receive one
    // means the REGISTRY changed under a review in flight.
    if (!registry.sweepTargets(check).length) {
      throw new Error(
        `a swept case is for "${check}", which authors no sweep instruction - this review asked nobody to sweep for it`
      );
    }
    // Identified by the tree as well as the check: one check may sweep both, and the same
    // relative path exists in each, so a hit in the XPI is not a repeat of one in the
    // archive.
    const listed = { ruleId: check, file: r.file, line: r.line, artifact };
    const key = JSON.stringify([check, artifact, r.file, r.line]);
    if (
      seen.has(key) ||
      listedAlready(manual, listed) ||
      listedAlready(findings, listed)
    ) {
      continue;
    }
    seen.add(key);
    const where = `${check} [${artifact}] (${r.file}${r.line == null ? "" : `:${r.line}`})`;
    const section = registry.sectionFor(check);
    if (section) {
      // An escalation of that check, in the section that check's own wording puts it in.
      // renderManualItems words it from that check's instructions, so a swept case and a
      // detected one put the same question to the same reader.
      //
      // Built by the SHAPE'S OWNER rather than spelled again here. A hand copy of the ref
      // is a copy that goes out of step the next time the shape gains a field, which is
      // exactly how a swept case once reached a reader with no artifact on it. The check
      // is synthesized from what the registry answers for this id, because a sweep result
      // names a check rather than carrying one.
      refs.push(
        ...manualEscalations({ id: check, section }, [
          {
            hint: r.hint,
            file: r.file,
            loc: r.line == null ? null : { line: r.line },
            artifact,
          },
        ]).manualItems
      );
      applied.push(`${where} -> ${section}`);
    } else {
      // No escalation: this check settles its cases as findings, so a swept one is a
      // finding. Built the way applyVerdicts builds one from a reported case
      // (src/report/verdicts.js asFinding) - the band from the registry, the locus and the
      // agent's hint carried over, and the message left to renderFindings.
      found.push(
        finding({
          ruleId: check,
          severity: registry.suggestedVerdict(check),
          file: r.file,
          loc: r.line == null ? null : { line: r.line },
          hint: r.hint,
          artifact,
        })
      );
      applied.push(`${where} -> finding`);
    }
  }
  return {
    manual: [
      ...manual,
      ...renderManualItems(refs, registry, mode).map((m) => ({
        ...m,
        extended: true,
      })),
    ],
    findings: [...findings, ...found],
    applied,
  };
}

/**
 * Whether this location is already covered for this check.
 *
 * Asked of the to-do list and of the findings, because the same four fields identify a
 * case in either - a check that escalates listed it as one, a check that does not filed it
 * as the other, and a sweep that names it again is naming what is already there.
 *
 * The ARTIFACT is one of the four. A check that sweeps both trees sees the same relative
 * path in each, and dropping the second as a repeat of the first would lose a real case in
 * whichever tree the deterministic pass happened to reach.
 * @param {object[]} listed  To-do items or findings.
 * @param {{ruleId: string, file: string, line: ?number, artifact: string}} r
 * @returns {boolean}
 */
function listedAlready(listed, r) {
  return listed.some(
    (m) =>
      m.ruleId === r.ruleId &&
      m.file === r.file &&
      (m.loc?.line ?? null) === r.line &&
      m.artifact === r.artifact
  );
}
