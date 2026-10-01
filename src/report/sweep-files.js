// THE SWEEP'S OWN FILES: what a sweeping sub-agent is handed, and what it writes back.
//
// A sweep is the one sub-agent whose findings the review CONSUMES - the description and
// the build report are the reviewer's, and the linter never opens them. So it is the one
// that needs a shape, and a pair of files gives it one without the orchestrating agent
// ever touching the content: it is handed a path, and everything else is between the
// sub-agent and the linter.
//
// TWO FILES, because each direction wants a different format and only one of them is
// written by an agent:
//
//   the request   .yaml   prose is the bulk of it, and a literal block reads as prose.
//                         Write-only from the linter: nothing reads it back, so an agent
//                         that disturbs it costs nothing.
//   the answers   .json   the agent writes this one. One quoting rule it applies by
//                         reflex, where YAML has several that bite only on certain
//                         content - an unquoted hint holding `http://host: thing` stops
//                         the file parsing, and a hint is free text about a remote host.
//
// ONE FILE PER TREE. A sweep names a file, so it is a request about exactly one artifact;
// grouping every sweep of one tree into one request lets a single reader walk that tree
// once for all of them, and keeps the two trees independent.
//
// The LABEL is the identity, and it is the linter's: unique across the whole review, so
// the two files cannot collide and no agent is ever asked which request an answer belongs
// to. Nothing here tells an agent about a check id or an artifact - those are the review's
// vocabulary, and a sweeping reader has no use for either.
//
// Belongs here: the shape of both files, the prose that goes in the request, and reading
// an answers file back into results. Does NOT belong here: WHAT to look for (-> each
// check's sweep instruction in assets/registry.yaml, carried through unchanged), where
// the files live (-> src/report/items.js reviewFilePaths), what a result MEANS once read
// (-> src/report/sweep.js), or when they are written (-> src/pipeline.js).

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { parseJson } from "../util/json.js";
import { rethrowIfFatal } from "../lib/errors.js";
import { checkedResult, RESULT_SHAPE } from "./sweep.js";
import { sweepSlot } from "../checks/registry-vocabulary.js";

/** The key the answers file holds everything under. A wrapper rather than a bare map, so
 *  the file says what it is to whoever opens it. */
const ANSWERS = "answers";

/** The keys whose value is PROSE, and so is written as a literal block. Both are text a
 *  reader reads: the one telling them what to do with the file, and the one per sweep
 *  telling them what to look for. */
const PROSE = new Set(["instructions", "instruction"]);

/**
 * The request document handed to one tree's sweeping agent.
 *
 * Every path it needs is a FIELD, named once and referred to by that name in the prose -
 * `sweepTarget` and `answerFile` - so nothing it must open is buried in a sentence, and
 * the prose says which tree without repeating the path. The worked example is
 * exampleAnswers'.
 * @param {object} args
 * @param {string} args.sweepTarget  The tree to read, absolute.
 * @param {string} args.answerFile  Where to write, absolute.
 * @param {{label: number, title: string, instruction: string}[]} args.sweeps
 * @returns {string}  The YAML text.
 */
function sweepRequest({ sweepTarget, answerFile, sweeps }) {
  const n = sweeps.length;
  const example = exampleAnswers(sweeps);
  const doc = new YAML.Document({
    sweepTarget,
    answerFile,
    instructions: [
      `This file holds ${n} ${n === 1 ? "sweep" : "separate sweeps"}, listed under "sweeps" below. Each one is its own request: the scans could not settle it, so it is handed to you. Answer them all, and answer each from the folder named in "sweepTarget" above and from nothing else.`,
      "Judge by EFFECT, never by the METHOD used - an unfamiliar form counts as much as a familiar one. Where a sweep is about code, resolve values assembled or supplied at runtime and follow them through helpers and bundled libraries.",
      'Write your answers into the file named in "answerFile" above, and change nothing in this one. That file already lists every "label" below with a null beside it. Replace each null with a list of what you found for that label, and with an empty list where you found nothing. A null left behind is not an answer, and the review cannot tell it apart from a sweep nobody ran.',
      `Each thing you found is one entry in that list, with a "file" (its path relative to "sweepTarget"), a "hint" - a short phrase naming what is there - and a "line" where it sits on one, left out where it does not. Nothing else: no verdict, and no wording for the developer, which is the linter's. Answered, that file reads:\n\n${indent(example, 2)}`,
      "Write to no file but that one, and report only that you are done.",
    ].join("\n\n"),
    sweeps: sweeps.map((s) => ({
      label: s.label,
      title: s.title,
      instruction: s.instruction.replace(/\s+/g, " ").trim(),
    })),
  });
  // ONE multi-line convention for the whole file: every piece of PROSE is a literal
  // block, which is what this repo's other authored prompt texts use
  // (assets/registry.yaml). It separates paragraphs with a single blank line where a
  // folded block needs two, and it carries the indented example above through untouched -
  // a folded block would join its lines into prose.
  //
  // Chosen by KEY, not by whether the text happens to hold a newline: a one-paragraph
  // instruction holds none, and left to the emitter it becomes a plain scalar wrapped
  // across lines - valid, and a second way of writing the same kind of thing in one file.
  YAML.visit(doc, {
    Pair(_key, pair) {
      if (PROSE.has(String(pair.key.value))) {
        pair.value.type = "BLOCK_LITERAL";
      }
    },
  });
  // No folding anywhere: a literal block keeps its own lines, and the short scalars left
  // are paths, which are not text to re-wrap.
  return doc.toString({ lineWidth: 0 });
}

/**
 * The answers file as it would read once answered, laid out over THIS request's labels.
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

/** Every line of `text` moved right by `by` spaces, so a block sits inside the paragraph
 *  that introduces it. Blank lines are left blank rather than padded, which is what keeps
 *  the literal scalar's paragraph breaks readable. */
function indent(text, by) {
  const pad = " ".repeat(by);
  return text
    .split("\n")
    .map((line) => (line === "" ? line : `${pad}${line}`))
    .join("\n");
}

/**
 * The answers file as the linter lays it out: every label this tree was asked about, each
 * with a null.
 *
 * PRE-CREATED rather than left to the agent, for the same reason the review file's rows
 * are: the slots are what the linter knows in advance, `null` is a sweep nobody has run
 * yet, and an empty list is one that was run and found nothing. An agent inventing the
 * file from scratch could return three answers to eight requests and nothing would say so.
 * @param {{label: number}[]} sweeps
 * @returns {string}  The JSON text.
 */
function sweepAnswerSlots(sweeps) {
  return `${JSON.stringify(
    {
      [ANSWERS]: Object.fromEntries(sweeps.map((s) => [String(s.label), null])),
    },
    null,
    1
  )}\n`;
}

/**
 * Write every sweep request this review makes, and the empty answers beside each.
 *
 * ONE PAIR PER TREE, grouped from the pre-sweep list: a sweep is a request about exactly
 * one artifact, and putting every sweep of a tree in one request lets a single reader
 * walk that tree once for all of them.
 *
 * The tree's own path is what the request names, so a group whose artifact this review
 * has no root for cannot be written - and cannot arise, because preSweepOf drops such a
 * sweep while the review still knows which trees it has.
 * @param {{sweep: (artifact: string) => {request: string, answers: string}}} files
 *   The review's paths (src/report/items.js reviewFilePaths).
 * @param {?{items: {label: number, artifact: string, title: string,
 *   instruction: string}[]}} preSweep
 * @param {Record<string, ?string>} trees  This review's trees by artifact
 *   (artifactRoots).
 * @returns {Record<string, {request: string, answers: string}>}  By artifact, for the
 *   steps that name them and the pass that reads them back.
 */
export function writeSweepFiles(files, preSweep, trees) {
  const byArtifact = new Map();
  for (const item of preSweep?.items ?? []) {
    byArtifact.set(item.artifact, [
      ...(byArtifact.get(item.artifact) ?? []),
      item,
    ]);
  }
  const written = {};
  for (const [artifact, sweeps] of byArtifact) {
    const paths = files.sweep(artifact);
    fs.writeFileSync(
      paths.request,
      sweepRequest({
        sweepTarget: trees[artifact],
        answerFile: paths.answers,
        sweeps,
      })
    );
    fs.writeFileSync(paths.answers, sweepAnswerSlots(sweeps));
    written[artifact] = paths;
  }
  return written;
}

/**
 * The prompt slots naming each tree's request, by the name its step uses.
 *
 * Derived from the SAME map the run's conditions are (src/pipeline.js), so a step that
 * prints always has a path to name and a path that exists always has a step: an unfilled
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
    Object.entries(state.paths?.sweeps ?? {}).map(([artifact, paths]) => [
      sweepSlot(artifact),
      paths.request,
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
      `${where} could not be read - the sweep for it either did not run or did not write its answers`
    );
  }
  const doc = parseJson(raw);
  if (doc === null) {
    throw new Error(`${where} is not readable JSON`);
  }
  const answers = doc?.[ANSWERS];
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    throw new Error(
      `${where} names no "${ANSWERS}" - hand back the file as it was written, with a list beside each label`
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
