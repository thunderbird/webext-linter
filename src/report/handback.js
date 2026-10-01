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
import { hasParentSegment } from "../addon/load.js";
import { VERB, verbOf } from "./verbs.js";
import { displayLine } from "../util/text.js";
import { parseJson } from "../util/json.js";
import { rethrowIfFatal } from "../lib/errors.js";

/** Every entry in every phase carries this, and `null` always means unanswered. One slot,
 *  one name, one sentinel - so the handover text is one text and the agent never relearns
 *  the file. What an answer IS - a verb, a reviewer's words - the phase's own step has to
 *  say anyway. */
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
 * below), so it is where the state is looked up - a name a person or an agent supplied
 * has nowhere safer to come from. It is not taken on trust past that: the state names
 * the one review file it hands out, and the caller refuses a file that is not it
 * (src/cli.js runLoopPass).
 * @param {string} file  What the agent passed to --llm-verdict.
 * @returns {{state: string, entries: object[]}}
 */
export function readHandback(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    rethrowIfFatal(err);
    throw new HandbackRefused(`"${file}" could not be read`);
  }
  const parsed = parseJson(raw);
  if (parsed === null) {
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
 * `keyOf` is the caller's, because what identifies an entry is the phase's business and
 * not this function's.
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
      throw new HandbackRefused('an entry has no "index"');
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
 * @param {{XPI: ?string, SCA: ?string}} [roots]  Where each artifact is on disk, keyed by
 *   the value a finding's `artifact` carries. An entry's paths are resolved against the
 *   one its own artifact names, so nothing the agent is handed has to be joined by hand.
 * @returns {object[]}
 */
/**
 * One entry's file, as a path the agent can open.
 *
 * Two things can go wrong here and neither may pass quietly. A root missing from a table
 * that was GIVEN is WIRING: the state carries both roots from v6 (src/report/state.js), so
 * its absence means the table was built wrongly, and handing out a relative path instead
 * would leave the agent resolving it against its own directory. A caller that passes no
 * table is not resolving at all, which is a different thing and is left alone.
 * A file that escapes its root is UNTRUSTED INPUT that got past its door - only a sweep result
 * authors a path, and checkedResult refuses one that steps out (src/report/sweep.js) - so
 * reaching here means that door failed, and composing the path anyway would publish a
 * location outside the submission as the linter's own claim.
 * @param {?string} root @param {string} file @param {string} ruleId
 * @param {boolean} resolving  Whether a roots table was given at all.
 * @returns {string}
 */
function resolvedIn(root, file, ruleId, resolving) {
  if (!root) {
    if (!resolving) {
      return file; // no table at all: this caller is not resolving paths.
    }
    throw new Error(
      `${ruleId} names "${file}" but this review has no root for the artifact it is in - an entry cannot hand over a path the agent would resolve against its own directory`
    );
  }
  const at = path.resolve(root, file);
  const inside = path.relative(path.resolve(root), at);
  if (inside === "" || path.isAbsolute(inside) || hasParentSegment(inside)) {
    throw new Error(
      `${ruleId} names "${file}", which resolves outside the artifact it claims to be in (${root})`
    );
  }
  return at;
}

export function entriesFor(items, phase, roots) {
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
    // The paths this entry is about, RESOLVED. A relative path is one the agent has to
    // join to a root, and in a source review it would have to pick the right root first -
    // a step it can get wrong silently, and the artifact label is not a path.
    //
    // `root` rides along whenever the ARTIFACT is known, with or without a file: it is
    // the scope a claim about ABSENCE is checked in, and the strongest such claim has no
    // file by definition - `manifest-missing` says a file is not there, and the agent
    // needs the tree to see that for itself. An entry names no root only when its subject
    // is in neither artifact - a by-hand reminder settled by reading the add-on's listing
    // page, or by installing it - and then there is no tree to open, which is the answer.
    const root = roots?.[item.artifact] ?? null;
    const at = item.file
      ? resolvedIn(root, item.file, item.ruleId, Boolean(roots))
      : null;
    return {
      ...base,
      ruleId: item.ruleId,
      ...(at ? { file: at } : {}),
      ...(root ? { root } : {}),
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
