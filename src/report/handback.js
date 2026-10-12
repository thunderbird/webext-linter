// Belongs here: the REVIEW file - what the linter hands the agent, and what it accepts
// back. One shape in both directions, so the agent learns the file once. Also whether a
// phase's product (its `product` file) came back with the hand-back.
//
// Does NOT belong here: which phase is issued (src/report/phases.js), the linter's own
// state (src/report/state.js), or what a verdict DOES to an item
// (src/report/verdicts.js).
//
// THE INVARIANT THAT MAKES ONE SHARED FILE SAFE: the linter never reads back anything it
// wrote here - only the answers. The entries are write-only from its side, regenerated
// from the STATE file every pass. So a mangled entry or a rewritten prompt in the returned
// file costs nothing, because nothing reads them.
import fs from "node:fs";
import path from "node:path";
import { hasParentSegment, relativeInside } from "../addon/load.js";
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
 * The file handed to the agent for one phase: what to fill in.
 *
 * It names nothing of the linter's own. The work folder it lies in is what a pass is
 * handed back with (--llm-handback), and the state beside it is found there by its fixed
 * name (src/util/dest.js workPaths), so the file carries the entries and nothing else.
 * @param {object[]} entries  Already rendered for THIS phase and this reader.
 * @returns {{entries: object[]}}
 */
export function reviewFile(entries) {
  return { entries };
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
 * Read a returned REVIEW file's entries.
 * @param {string} file  The review file in the work folder the pass was handed back with.
 * @returns {{entries: object[]}}
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
  if (!Array.isArray(parsed?.entries)) {
    throw new HandbackRefused('"entries" is missing or is not a list');
  }
  return { entries: parsed.entries };
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
    // A process value is one of the labels the entry offered, carried as that label: it
    // steers the review and settles no item, so it never crosses into a verb.
    if (phase.answer === "value") {
      const offered = (wanted.get(key)?.answers ?? []).map((a) => a.label);
      if (!offered.includes(value)) {
        throw new HandbackRefused(
          `${key} answers "${displayLine(String(value))}", which this entry does not ` +
            `accept (expected one of: ${offered.join(", ")})`
        );
      }
      continue;
    }
    // A build's output is a path, or the `failed` label its entry offers. Which of the two,
    // and whether the path names something the build produced, is outputAt's to say.
    if (phase.answer === "output") {
      if (typeof value !== "string" || value.trim() === "") {
        throw new HandbackRefused(
          `${key} names no path and does not answer "${phase.failed.label}"`
        );
      }
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
 * One entry's file, as a path the agent can open.
 *
 * Two things can go wrong here and neither may pass quietly. A root missing from a table
 * that was GIVEN is WIRING: the state carries both roots (src/report/state.js paths), so
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

/**
 * The one entry a process-value phase (`answer: value`) hands over, keyed by the phase's
 * name: the question it puts to a person where it has one, and the values it accepts, each
 * by the label that comes back and the description that says when it applies.
 * @param {{name: string, question: ?string, values: {label: string,
 *   description: string}[]}} phase
 * @returns {object}
 */
export function valueEntry(phase) {
  return {
    index: phase.name,
    ...(phase.question ? { message: phase.question } : {}),
    answers: phase.values.map(({ label, description }) => ({
      label,
      description,
    })),
    [SLOT]: null,
  };
}

/**
 * The one entry an output phase (`answer: output`) hands over, keyed by the phase's name:
 * its question, and the one answer it offers besides a path, for a build that failed.
 * @param {{name: string, question: string, failed: {label: string,
 *   description: string}}} phase
 * @returns {object}
 */
export function outputEntry(phase) {
  return {
    index: phase.name,
    message: phase.question,
    answers: [
      { label: phase.failed.label, description: phase.failed.description },
    ],
    [SLOT]: null,
  };
}

/**
 * What an output phase's answer names: null for its `failed` label, else the file or folder
 * the build produced, as the real path it is.
 *
 * A relative path is resolved against the build copy, and links are followed before it is
 * held to that copy, so a link that points out of it is refused like any path outside it.
 * The copy itself is not an output: the build put something inside it.
 * @param {string} answer  What came back, already checked by answersOf.
 * @param {{name: string, failed: {label: string}}} phase
 * @param {?string} buildCopy  Where the agent built.
 * @returns {?string}
 * @throws {HandbackRefused}
 */
export function outputAt(answer, phase, buildCopy) {
  if (answer === phase.failed.label) {
    return null;
  }
  const named = displayLine(answer);
  const copy = realPath(buildCopy ?? "");
  if (!copy) {
    throw new HandbackRefused(
      `${phase.name} names "${named}", but the build copy "${buildCopy}" does not exist: ` +
        "build there"
    );
  }
  const real = realPath(path.resolve(copy, answer.trim()));
  if (!real) {
    throw new HandbackRefused(
      `${phase.name} names "${named}", which does not exist: name the file or folder ` +
        `the build produced inside "${copy}"`
    );
  }
  const inside = relativeInside(real, copy);
  if (inside === null || inside === "") {
    throw new HandbackRefused(
      `${phase.name} names "${named}", which is not inside the build copy "${copy}": ` +
        "name what the build produced there"
    );
  }
  const stat = fs.statSync(real);
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new HandbackRefused(
      `${phase.name} names "${named}", which is neither a file nor a folder: name the ` +
        "XPI or zip file, or the folder, the build produced"
    );
  }
  return real;
}

/**
 * The path `p` really is, links followed, or null where nothing is there.
 * @param {string} p
 * @returns {?string}
 */
function realPath(p) {
  try {
    return p ? fs.realpathSync(p) : null;
  } catch (err) {
    rethrowIfFatal(err);
    return null;
  }
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
export function entriesFor(items, phase, roots) {
  return items.map((item, i) => {
    const base = { index: item.ref };
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

/**
 * Whether a phase's product came back: a file at the path it was named, written by the
 * agent. Asked once, as the phase is handed back, so every later pass says the same thing.
 * @param {?string} file
 * @returns {boolean}
 */
export function productWritten(file) {
  try {
    return Boolean(file) && fs.statSync(file).isFile();
  } catch (err) {
    rethrowIfFatal(err);
    return false;
  }
}
