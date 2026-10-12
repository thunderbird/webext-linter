// THE SWEEP'S REQUEST AND ANSWERS: what a sweeping sub-agent is handed, and what comes
// back from it.
//
// A sweep is the one sub-agent whose findings the review CONSUMES - the description and
// the build report are the reviewer's, and the linter never opens them. So it is the one
// that needs a shape, and the round trip gives it one:
//
//   the request   TEXT, printed inline in the step that spawns the agent. Prose is the
//                 bulk of it, and the agent reads it as its whole brief.
//   the answers   JSON, returned by the sub-agent as its reply and written UNCHANGED into
//                 the answers file by the orchestrating agent. One quoting rule a writer
//                 applies by reflex, where YAML has several that bite only on certain
//                 content - an unquoted hint holding `http://host: thing` stops the file
//                 parsing, and a hint is free text about a remote host.
//
// The orchestrating agent relays and transcribes, and never composes: the linter reads
// only the answers file, and refuses one that cannot be acted on.
//
// ONE REQUEST PER TREE. A sweep names a file, so it is a request about exactly one
// artifact. Grouping every sweep of one tree into one request lets a single reader walk
// that tree once for all of them, and keeps the two trees independent.
//
// The LABEL is the identity, and it is the linter's: unique across the whole review, so
// two answers files cannot collide and no agent is ever asked which request an answer
// belongs to. Nothing here tells an agent about a check id or an artifact - those are the
// review's vocabulary, and a sweeping reader has no use for either.
//
// Belongs here: the request's text, the answers' shape, and reading an answers file back
// into results. Does NOT belong here: WHAT to look for (-> each check's sweep instruction
// in assets/registry.yaml, carried through unchanged), where the answers file lives
// (-> src/util/dest.js workPaths), what a result MEANS once read (-> src/report/sweep.js),
// or when a request is made (-> src/pipeline.js).

import fs from "node:fs";
import path from "node:path";
import { parseJson } from "../util/json.js";
import { rethrowIfFatal } from "../lib/errors.js";
import { checkedResult, RESULT_SHAPE } from "./sweep.js";
import { sweepAnswersSlot, sweepSlot } from "../checks/registry-vocabulary.js";

/** The key the answers hold everything under. A wrapper rather than a bare map, so the
 *  file says what it is to whoever opens it. */
const ANSWERS = "answers";

/**
 * The request handed to one tree's sweeping agent, as the text its spawn step prints.
 *
 * Paragraphs apart by a blank line, each prose paragraph on one line for the prompt to
 * wrap, and the parts that must not be re-flowed - the folder, the reply's shape and the
 * worked example - indented, which the prompt keeps line for line. The folder is named once, on a line of
 * its own, and the prose refers to it as "the folder above", so nothing it must open is
 * buried in a sentence. The worked example is exampleAnswers'.
 * @param {object} args
 * @param {string} args.sweepTarget  The tree to read, absolute.
 * @param {{label: number, title: string, instruction: string}[]} args.sweeps
 * @returns {string}
 */
function sweepRequest({ sweepTarget, sweeps }) {
  const n = sweeps.length;
  const example = exampleAnswers(sweeps);
  return [
    "Sweep this folder, and read nothing outside it:",
    indent(sweepTarget, 2),
    `It is asked about in ${n} ${n === 1 ? "sweep" : "separate sweeps"}, each listed below under its label. Each one is its own request: the scans could not settle it, so it is handed to you. Answer them all, from the folder above and from nothing else.`,
    "Judge by EFFECT, never by the METHOD used - an unfamiliar form counts as much as a familiar one. Where a sweep is about code, resolve values assembled or supplied at runtime and follow them through helpers and bundled libraries.",
    ...sweeps.map(
      (s) =>
        `Label ${s.label}: ${s.title}\n${s.instruction.replace(/\s+/g, " ").trim()}`
    ),
    "Return your answers as your reply, as one JSON document of this shape:",
    indent(`{"${ANSWERS}": {"<label>": [...]}}`, 2),
    "It lists every label above, each with a list of what you found for it, and an empty list where you found nothing. Put nothing else in the reply: no words before or after it, and no code fence around it.",
    `Each thing you found is one entry in that list, with a "file" (its path relative to the folder above), a "hint" - a short phrase naming what is there - and a "line" where it sits on one, left out where it does not. Nothing else: no verdict, and no wording for the developer, which is the linter's. Answered, your reply reads:\n\n${indent(example, 2)}`,
    "Write no file.",
  ].join("\n\n");
}

/**
 * The answers as they would read once answered, laid out over THIS request's labels.
 *
 * Every label, so the example doubles as the list of what must come back - an elided one
 * would leave the reader working out whether the rest are optional. The first shows a
 * find, the rest show the empty list, which is the case worth being unambiguous about.
 *
 * The entry itself is RESULT_SHAPE, the constant checkedResult refuses against
 * (src/report/sweep.js), so what an agent is shown and what the door accepts are one
 * string. Its hint is a placeholder: a plausible finding here is a suggestion about what
 * to go and find.
 * @param {{label: number}[]} sweeps
 * @returns {string}
 */
function exampleAnswers(sweeps) {
  const lines = ["{", ` "${ANSWERS}": {`];
  sweeps.forEach((s, i) => {
    const end = i === sweeps.length - 1 ? "" : ",";
    if (i === 0) {
      lines.push(`  "${s.label}": [`, `   ${RESULT_SHAPE}`, `  ]${end}`);
    } else {
      lines.push(`  "${s.label}": []${end}`);
    }
  });
  return [...lines, " }", "}"].join("\n");
}

/** Every line of `text` moved right by `by` spaces, which the prompt keeps line for line
 *  rather than re-flowing it as prose. */
function indent(text, by) {
  const pad = " ".repeat(by);
  return text
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}

/**
 * Every sweep request this review makes, and the answers file each one comes back into.
 *
 * ONE PER TREE, grouped from the pre-sweep list: a sweep is a request about exactly one
 * artifact, and putting every sweep of a tree in one request lets a single reader walk
 * that tree once for all of them.
 *
 * Nothing is written. The request is printed in the step that spawns the agent, and the
 * answers file is the orchestrating agent's to write: a file the linter laid out first
 * would be one that agent has to overwrite, and a name already taken is refused before the
 * review begins (src/pipeline.js claimedNames).
 *
 * The tree's own path is what the request names, so a group whose artifact this review
 * has no root for cannot be asked about - and cannot arise, because preSweepOf drops such
 * a sweep while the review still knows which trees it has.
 * @param {{sweep: (artifact: string) => string}} files  The work folder's names
 *   (src/util/dest.js workPaths).
 * @param {?{items: {label: number, artifact: string, title: string,
 *   instruction: string}[]}} preSweep
 * @param {Record<string, ?string>} trees  This review's trees by artifact
 *   (artifactRoots).
 * @returns {Record<string, {request: string, answers: string}>}  By artifact: the request
 *   text and the answers file's path, for the steps that print them and the pass that
 *   reads the answers back.
 */
export function sweepRequests(files, preSweep, trees) {
  const byArtifact = new Map();
  for (const item of preSweep?.items ?? []) {
    byArtifact.set(item.artifact, [
      ...(byArtifact.get(item.artifact) ?? []),
      item,
    ]);
  }
  const asked = {};
  for (const [artifact, sweeps] of byArtifact) {
    asked[artifact] = {
      request: sweepRequest({ sweepTarget: trees[artifact], sweeps }),
      answers: files.sweep(artifact),
    };
  }
  return asked;
}

/**
 * The prompt slots for each tree's sweep, by the names its step uses: the request text
 * (sweepSlot) and the answers file's path (sweepAnswersSlot).
 *
 * Derived from the SAME map the run's conditions are (src/pipeline.js), so a step that
 * prints always has a request to hand over and a request always has a step: an unfilled
 * slot and a step pointing nowhere are both impossible rather than caught later
 * (assertFilled, src/report/format.js).
 *
 * Built for both legs of the round trip from one function, because the two callers that
 * assemble prompt values are hand-written lists and a slot added to one and not the other
 * is a prompt that names nothing on every pass but the first.
 * @param {import("./state.js").LoopState} state
 * @returns {Record<string, string>}
 */
export function sweepSlots(state) {
  return Object.fromEntries(
    Object.entries(state.paths?.sweeps ?? {}).flatMap(([artifact, sweep]) => [
      [sweepSlot(artifact), sweep.request],
      [sweepAnswersSlot(artifact), sweep.answers],
    ])
  );
}

/**
 * Read one tree's answers back, as results.
 *
 * THE DOOR for everything a sweeping agent wrote, and the only one - so a file that cannot
 * be acted on is refused here rather than half-applied downstream. Refused, never
 * repaired: every message names the one thing to fix, because the caller turns these into
 * a hand-back the agent can correct (src/report/loop.js).
 *
 * `asked` is what this review wrote into the file, so it is the authority on which labels
 * belong in it and what each one means. A label is resolved to its check and its artifact
 * HERE, from that list, and never read off the file - the agent names a label and nothing
 * else about where its finding goes.
 * @param {string} file  The answers file's path.
 * @param {{label: number, check: string, artifact: string}[]} asked  This tree's sweeps.
 * @returns {{check: string, artifact: string, file: string, line: ?number,
 *   hint: ?string}[]}
 * @throws {Error} Naming what is wrong, for the caller to refuse with.
 */
export function readSweepAnswers(file, asked) {
  const where = path.basename(file);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    rethrowIfFatal(err);
    throw new Error(
      `${where} could not be read - the sweep for it either did not run, or its reply was not written there`
    );
  }
  const doc = parseJson(raw);
  if (doc === null) {
    throw new Error(`${where} is not readable JSON`);
  }
  const answers = doc?.[ANSWERS];
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    throw new Error(
      `${where} names no "${ANSWERS}" - write the sweep's reply into it unchanged: one JSON document with a list beside each label`
    );
  }
  const wanted = new Map(asked.map((s) => [String(s.label), s]));
  for (const label of Object.keys(answers)) {
    if (!wanted.has(label)) {
      throw new Error(
        `${where} answers label ${label}, which it was not asked about`
      );
    }
  }
  const results = [];
  for (const [label, sweep] of wanted) {
    const value = answers[label];
    if (value === undefined || value === null) {
      throw new Error(
        `${where} leaves label ${label} unanswered - a sweep that found nothing answers with an empty list, and a null cannot be told apart from one nobody ran`
      );
    }
    if (!Array.isArray(value)) {
      throw new Error(
        `${where} answers label ${label} with ${typeof value}, but a sweep answers with a list of what it found (an empty list when it found nothing)`
      );
    }
    value.forEach((found, i) => {
      const at = `${where}, label ${label}, entry ${i + 1}`;
      // Shape-checked by checkedResult, so its path guards - inside the add-on, never
      // absolute, never a way out - hold here.
      const hit = checkedResult(at, found);
      // The check and the artifact come from what was ASKED, never from the file: the
      // agent names a label, and where its finding lands is the review's to know.
      results.push({ ...hit, check: sweep.check, artifact: sweep.artifact });
    });
  }
  return results;
}
