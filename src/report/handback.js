// Belongs here: the REVIEW file - what the linter hands the agent, and what it accepts
// back. One shape in both directions, so the agent learns the file once.
//
// Does NOT belong here: which phase is issued (src/report/phases.js), the linter's own
// state (src/report/state.js), or what a verdict DOES to an item
// (src/report/verdicts.js).
//
// THE INVARIANT THAT MAKES ONE SHARED FILE SAFE: the linter never reads back anything it
// wrote here - only `base` and the answers. The entries are write-only from its side,
// regenerated from the STATE file every pass. So a mangled entry or a rewritten prompt in
// the returned file costs nothing, because nothing reads them.
import fs from "node:fs";
import path from "node:path";
import { checkedResult } from "./sweep.js";
import { VERB, verbOf } from "./verbs.js";
import { displayLine } from "../util/text.js";

/** Every entry in every phase carries this, and `null` always means unanswered. One slot,
 *  one name, one sentinel - so the handover text is one text and the agent never relearns
 *  the file. What an answer IS - a list of hints, a verb, a reviewer's words - the phase's
 *  own step has to say anyway. */
export const SLOT = "answer";

/**
 * The file handed to the agent for one phase: where the state is, and what to fill in.
 *
 * `base` is the linter's own bookkeeping, not the agent's - it is stateless between runs
 * and this is how it finds its way back. The agent never authors it, never names it, and
 * cannot get it wrong.
 * @param {string} stateFile
 * @param {object[]} entries  Already rendered for THIS phase and this reader.
 * @returns {object}
 */
export function reviewFile(stateFile, entries) {
  return { base: stateFile, entries };
}

/**
 * Write it, replacing the last pass's.
 * @param {string} file
 * @param {object} content
 */
export function writeReviewFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(content, null, 1)}\n`);
}

/**
 * A refusal the agent is shown, carrying WHAT is wrong in the words the prompt's
 * `{{problem}}` slot expects.
 *
 * Its own class, because the caller answers it differently from every other failure: the
 * prompt is not re-printed (the agent still has it, and re-issuing the same text against
 * the same input invites a loop), and nothing in the state changes, so a corrected
 * hand-back resumes exactly where it was.
 */
export class HandbackRefused extends Error {
  constructor(problem) {
    super(problem);
    this.name = "HandbackRefused";
    this.problem = problem;
  }
}

/**
 * Read a returned REVIEW file and say which state it belongs to.
 *
 * `base` is the linter's own value, written into the file it handed out (`reviewFile`,
 * below) - so it is the authority on which state this hand-back belongs to, not a claim
 * to be checked against anything else. A name a person or an agent supplied has nowhere
 * safer to come from.
 * @param {string} file  What the agent passed to --llm-verdict.
 * @returns {{state: string, entries: object[]}}
 */
export function readHandback(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new HandbackRefused(`"${file}" could not be read`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HandbackRefused(`"${file}" is not readable JSON`);
  }
  if (typeof parsed?.base !== "string" || parsed.base === "") {
    throw new HandbackRefused(
      `"${file}" names no "base" - hand back the file the prompt named, unedited`
    );
  }
  if (!Array.isArray(parsed.entries)) {
    throw new HandbackRefused('"entries" is missing or is not a list');
  }
  return { state: parsed.base, entries: parsed.entries };
}

/**
 * Check what came back against what was handed out, and return the answers.
 *
 * Four ways a hand-back can be wrong, and each is named exactly so the agent can fix the
 * one thing rather than redo the pass blind:
 *
 *   - an entry nobody asked about, or one that was asked about and is gone
 *   - a slot still `null`, which is the "settled the ones I was handed, the rest pass
 *     unexamined" failure this file exists to prevent
 *   - a verb outside the phase's own set, which is the agent doing what some OTHER phase
 *     told it
 *   - an answer of the wrong shape for what the phase asks
 *
 * `keyOf` differs by phase because the setup phase's rows are keyed by the check they
 * answer: a sweep takes no verdict, produces cases rather than being one, and so must not
 * consume an index from a sequence it is not in.
 * @param {object[]} handed  What came back.
 * @param {object[]} asked  What was handed out.
 * @param {{name: string, verbs: string[]}} phase
 * @param {(entry: object) => string} keyOf
 * @returns {Map<string, *>}
 */
export function answersOf(handed, asked, phase, keyOf) {
  const wanted = new Map(asked.map((e) => [keyOf(e), e]));
  const got = new Map();
  for (const entry of handed) {
    const key = keyOf(entry);
    if (key === undefined || key === "undefined") {
      throw new HandbackRefused(
        `an entry has no ${phase.answer === "hints" ? '"check"' : '"index"'}`
      );
    }
    if (!wanted.has(key)) {
      throw new HandbackRefused(
        `${key} is not one of the entries this pass asked about`
      );
    }
    if (got.has(key)) {
      throw new HandbackRefused(`${key} appears twice`);
    }
    got.set(key, entry[SLOT]);
  }
  const missing = [...wanted.keys()].filter((k) => !got.has(k));
  if (missing.length) {
    throw new HandbackRefused(
      `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing from the file`
    );
  }
  const blank = [...got].filter(([, v]) => v === null || v === undefined);
  if (blank.length) {
    throw new HandbackRefused(
      `${blank.map(([k]) => k).join(", ")} still has no "${SLOT}"`
    );
  }
  for (const [key, value] of got) {
    // `hints` is what a sweep found - a list, empty when that check is clean. `null` was
    // unanswered and is already refused above, which is what separates "found nothing"
    // from "never looked".
    if (phase.answer === "hints") {
      if (!Array.isArray(value)) {
        throw new HandbackRefused(
          `${key} answers with ${typeof value}, but a sweep answers with a list of what ` +
            "it found (an empty list when it found nothing)"
        );
      }
      // The agent AUTHORS these rows - the linter cannot, since a sweep exists for what
      // its detectors miss - so each is held to a shape here, at the only point one
      // enters the review.
      value.forEach((found, i) => {
        try {
          checkedResult(`${key}, hint ${i + 1}`, { ...found, check: key });
        } catch (err) {
          throw new HandbackRefused(err.message);
        }
      });
      continue;
    }
    // `words` are a person's own answer, and those are not ours to judge - only to carry.
    if (phase.answer === "words") {
      if (typeof value !== "string" || value === "") {
        throw new HandbackRefused(
          `${key} answers with nothing a reviewer said`
        );
      }
      continue;
    }
    // The one crossing from text to verb. What comes back from here is a Verb, so every
    // question after it is asked by identity - a phase answering with `words` never
    // reaches this line, and the sentence it carries can never be one.
    //
    // Checked against what THIS entry offered, read off the copy that was handed out
    // rather than off the returned file: an answer is accepted because the linter asked
    // for it, never because the hand-back says it was asked for.
    const offered = (wanted.get(key)?.answers ?? []).map((a) => a.label);
    const verb = verbOf(offered, value);
    if (!verb) {
      // Stripped of control characters before display: this is the one place `value`
      // stops being data and becomes text a person may read in a terminal, and nothing
      // upstream constrains what an unrecognised answer contains.
      throw new HandbackRefused(
        `${key} answers "${displayLine(String(value))}", which this entry does not ` +
          `accept (expected one of: ${offered.join(", ")})`
      );
    }
    got.set(key, verb);
  }
  return got;
}

/**
 * The entries one phase hands over: this phase's open items, each stripped to what its
 * steps actually name, plus the one empty slot.
 *
 * Stripped rather than handed whole because the REVIEW file holds what the prompt needs in
 * order to be followed, and nothing that merely decided what the prompt says. A finding's
 * severity, a to-do's suggested verdict: both are the linter's, and neither is a step's
 * business.
 *
 * Rendered HERE, when the phase is handed out - never stored - so the same item can be
 * worded one way for the agent and another for the reviewer without either being baked in.
 * @param {object[]} items  From reviewItems, filtered to this phase.
 * @param {{answer: string}} phase  The phase handing them over. Its `answer` says what one
 *   of its entries is answered WITH, and so which of the two wordings an entry carries -
 *   read as data, never off the phase's name, so a phase's shape is authored beside its
 *   verbs rather than spelled again here.
 * @returns {object[]}
 */
export function entriesFor(items, phase) {
  return items.map((item, i) => {
    const base = { index: item.index };
    if (phase.answer === "words") {
      // Opaque strings the agent relays: the question, its label, and the answers it
      // offers. It reads nothing into them and composes nothing of its own.
      //
      // The label is a progress counter over THIS hand-over, so it counts what is
      // actually put to a person on this pass and nothing else.
      return {
        ...base,
        label: `${i + 1}/${items.length}`,
        message: item.message,
        answers: item.answers,
        [SLOT]: null,
      };
    }
    // A finding is judged against the package, so it carries where it is and what it
    // claims. A case a check could not settle carries its own instruction too - the one
    // addressed to the agent, not the one a reviewer would read.
    return {
      ...base,
      ruleId: item.ruleId,
      ...(item.file ? { file: item.file } : {}),
      ...(item.loc?.line ? { line: item.loc.line } : {}),
      ...(item.item ? { item: item.item } : {}),
      ...(item.hint ? { hint: item.hint } : {}),
      ...(item.instructions ? { instructions: item.instructions } : {}),
      answers: offeredBy(item, phase),
      [SLOT]: null,
    };
  });
}

/**
 * What one verdict entry may be answered with, each verb beside what it means here.
 *
 * Same shape as the answers a person is offered, so the agent reads one thing in either
 * phase: pick a `label`, and the `description` says when it applies.
 *
 * The SET is the item's where its check narrows it and the phase's otherwise - so a
 * finding, which no check narrows, offers exactly what its phase accepts. The WORDING is
 * the phase's either way, because what `reported` means is a property of the question
 * being asked, not of the check that raised the case.
 *
 * `says-when-last-resort` is the one wording that depends on the set rather than the
 * phase. A verb authors it for the case where the entry offers `cleared` and no `ask`:
 * clearing was the way out and it was not taken, which is a different sentence from the
 * same verb chosen with a hand-off still available. Keyed on `cleared` and not on `ask`
 * alone, because the wording claims clearing was tried - it may only be shown where
 * clearing was on offer.
 * @param {{settleVerbs: ?string[]}} item
 * @param {{verbs: string[], verbProse: Object<string, {says: string}>}} phase
 * @returns {{label: string, description: string}[]}
 */
function offeredBy(item, phase) {
  const labels = item.settleVerbs ?? phase.verbs;
  const lastResort =
    labels.includes(String(VERB.cleared)) && !labels.includes(String(VERB.ask));
  return labels.map((label) => {
    const prose = phase.verbProse?.[label] ?? {};
    return {
      label,
      description:
        (lastResort ? prose["says-when-last-resort"] : null) ?? prose.says,
    };
  });
}

/**
 * The setup phase's rows: one per check that declared a sweep instruction.
 *
 * Keyed by `check` and carrying no index, because a sweep takes no verdict and produces
 * cases rather than being one - an index would consume a number from a sequence it is not
 * in, and every real case would start at 2.
 *
 * ONE ROW PER CHECK is the part the linter DOES know in advance. It cannot write the
 * hints - a sweep exists precisely for what the detectors miss - but it knows exactly
 * which checks it asked about, so a check left unanswered is visible - and `null` is that
 * check unanswered where `[]` is that check swept and clean. Without the row, a sweep that
 * covered three checks of eight would be indistinguishable from one that covered all
 * eight and found nothing.
 * @param {{items: {check: string, instruction: string}[]}} preSweep
 * @returns {object[]}
 */
export function sweepRows(preSweep) {
  return preSweep.items.map((s) => ({
    check: s.check,
    instruction: s.instruction,
    [SLOT]: null,
  }));
}
