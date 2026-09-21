// Renders a finished review (findings + metadata) as either human-readable text
// or JSON. Text goes to stdout so it can be read directly. JSON is
// machine-consumable for CI.
//
// It also renders the two texts that are NOT a finished review: one pass of the review
// loop (loopPromptLines) and the prompt that PREPARES a review (scaPromptLines, the whole
// output of a run in which no review has happened and none can). Both are layout over
// values decided elsewhere, which is why they are here and not in the front-end.
//
// Belongs here: report LAYOUT and chrome - the ReviewMeta typedef, section
// titles, ordering/sorting, line wrapping, the summary line, and the text +
// JSON serialization (including stripping the internal data and the human-only
// manualReview from JSON). Section/structural strings are code-owned here.
//
// Does NOT belong here: per-finding review wording - resolving ruleId/item into
// a `message` is the resolver's job (src/report/responses.js), and that prose
// lives in assets/registry.yaml. The finding data shape is defined in
// src/report/finding.js. Verdict/escalation decisions live in
// src/checks/escalation.js. Reuse the shared canonicalJson helper in
// src/util/json.js rather than adding JSON utilities here.

import {
  SEVERITY,
  SEVERITY_ORDER,
  sortFindings,
  countByRule,
  verdictKey,
} from "./finding.js";
import { orderReview, hasLocus, manualBody, collapseBody } from "./order.js";
import { artifactLabel } from "./artifact.js";
import { red, yellow, blue, brightCyan, grey } from "../util/color.js";
import { displayLine, displayPath, wrapText } from "../util/text.js";

/** @param {string} s @returns {string} */
const identity = (s) => s;

// On an interactive screen, error findings are red and warnings yellow (info
// stays plain). A no-op unless the CLI enabled color (color.js).
const SEV_COLOR = {
  [SEVERITY.ERROR]: red,
  // A hold stops the submission as an error does, so it is read with that weight.
  [SEVERITY.HOLD]: red,
  [SEVERITY.WARNING]: yellow,
  [SEVERITY.INFO]: identity,
};

/**
 * @typedef {object} ReviewResult
 * @property {import("./finding.js").Finding[]} findings
 * @property {ReviewMeta} meta   Run metadata (addon path, schema source, etc.).
 * @property {Record<string, string>} [issueHeadings]  Per-severity Issues
 *   headings ({ error?, warning?, info? }), registry-owned.
 * @property {Record<string, string>} [verdictIntros]  Issues-section preamble
 *   ({ none?, feedback?, hold?, rejected? }), registry-owned.
 * @property {import("../lib/enum.js").ReviewMode} [mode]  The review mode. In SCA each finding's
 *   file:line is labelled by artifact ([XPI]/[SCA]) and the Found Issues section gets a
 *   legend footer; XPI reviews add neither. See src/report/artifact.js.
 * @property {Map<string, string>} [ruleInputs]  ruleId -> routed input
 *   ("xpi"|"build"|"source"|"manifest"), from registry.checkInputs(); the artifact label reads it.
 */

/**
 * @typedef {object} ReviewMeta
 * @property {string} action
 * @property {string} xpi  The shipped add-on - the artifact users install - in EVERY
 *   review, resolved. Named for the ARTIFACT, never for its role: a field meaning "the
 *   review target" names a different one in each mode, and no reader can tell which. Kept
 *   for the JSON report; neither text renderer prints it as its own row any more (see
 *   xpiRoot).
 * @property {string} xpiRoot  Where that artifact IS, readable, on disk - the folder this
 *   run extracted it into (src/addon/load.js), or the submission itself when it already
 *   was a folder. Always set, for every review: unlike summaryFile/buildFile below, this
 *   is not conditional on how the review is run.
 * @property {string} xpiFile  What was submitted, by name and not by path - the .xpi as
 *   ATN named it, or the folder's name where the submission arrived unpacked. It is what
 *   a reviewer recognises the submission by. Always set, alongside xpiRoot.
 * @property {string} [scaRoot]  SCA review: the source root the run was given
 *   (--sca-root), resolved.
 * @property {string} [scaSource]  SCA review: the add-on's own code root within that
 *   root, resolved - the root itself when no subtree was named.
 * @property {string} [scaExpSource]  SCA review: the Experiment implementation folder
 *   (--sca-exp-source), resolved, when one was named. Its files are privileged code and are
 *   excluded from the WebExtension checks, so naming it is how a reader sees that anything
 *   was.
 * @property {boolean} reviewed
 * @property {string} [schemaBranch]
 * @property {string} [schemaSource]
 * @property {string} [schemaChannel]  The auto-detected schema channel used.
 * @property {string} [applicationVersion]
 * @property {number} [manifestVersion]
 * @property {string[]} [checksRun]  Ids of the checks that ran.
 * @property {string} [summaryFile]  Where the --llm-review prompt's reader writes the
 *   add-on description for the reviewer - beside the submitted .xpi, sharing the item
 *   file's name. Named by this tool, written and read by neither.
 * @property {string} [buildFile]  The same, for what building the add-on takes: named only
 *   in a source code review, where the reviewer reproduces the build.
 * @property {boolean} [prompting]  This run handed out a PHASE of the review loop, so
 *   its whole output is that prompt: the report is not printed beside it, and neither is
 *   the header or the Summary.
 * @property {import("./finding.js").ManualItem[]} [manualReview]  The manual-review
 *   to-do list, each item tagged with `extended` (it escalated from a check) and
 *   `section` (which of the two extended lists it belongs to). The report splits it
 *   into three sections on those two tags - see src/report/order.js. Text-only;
 *   dropped from JSON.
 * @property {?{items: object[]}} [preSweep]  The blind-spot sweep to run
 *   before settling the review: the shared method, then one bare item per check that
 *   authors an instruction for what it cannot detect. ONE request, not one per check.
 *   Carries no finding and no locus - it is the job, not its result. Text-only; dropped
 *   from JSON.
 */

// The titles the report prints over its sections, keyed by the section a sequence item
// carries (src/report/order.js). One definition, because an entry names an item's
// section with the same string the prose prints - and the --llm-review prompt refers to
// both by that name.
//
// `preSweep` is the one title here that names no sequence section: it is not an item of
// the numbered review (it settles nothing and carries no index), but the report, the item
// file and the prompt still have to call it one thing, which is what this map is for.
// It is titled STANDARD because, like the standard manual checks, it is carried by every
// submission rather than raised by one - the pairing is deliberate: the two standard
// sections are the review done on everything, by reading and by hand.
// The one line above every list of things a person works through by hand - the two
// extended sections, the standard manual list, and the swept blind spots. One sentence
// rather than one per section: they differ in WHAT is listed, never in what the reader
// does with it, and four wordings for one instruction is four chances to drift.
const TODO_LEAD = "Continue manual review for the following checks:";

export const SECTION_TITLES = Object.freeze({
  issues: "Found Issues",
  code: "Extended Code Review",
  extendedManual: "Extended Manual Review",
  preSweep: "Standard Code Review",
  standard: "Standard Manual Review",
});

/**
 * Render the review result as human-readable text.
 *
 * @param {ReviewResult} review
 * @returns {string}
 */
export function formatText(review) {
  // The complete text report: the body, then the verdict tally LAST, so the verdict
  // closes the report.
  const lines = [
    ...reviewBodyLines(review),
    ...summaryLines(
      review.findings,
      review.meta.manualReview ?? [],
      review.meta.preSweep ?? null
    ),
  ];
  // The Review Details section is printed live by the pipeline after the review
  // (src/pipeline.js), not here, so drop the blank that section() prepends to
  // the first section, opening the report body at "── Found Issues ──".
  if (lines[0] === "") {
    lines.shift();
  }
  return lines.join("\n");
}

/**
 * The report body lines - Found Issues, the three to-do sections, and the ATN tail -
 * WITHOUT the trailing Summary tally.
 *
 * The order, the entry grouping and the numbering all come from orderReview: this
 * function only draws what that sequence already decided, so the numbers a reader sees
 * are the numbers --llm-verdict resolves (src/report/order.js).
 * @param {ReviewResult} review
 * @returns {string[]}
 */
function reviewBodyLines(review) {
  const {
    findings: issues,
    meta,
    issueHeadings,
    verdictIntros,
    mode,
    ruleInputs,
  } = review;
  const ordered = orderReview(issues, meta.manualReview ?? []);
  const todo = (section) =>
    ordered.filter((x) => x.kind === "todo" && x.section === section);
  const labelOf = locusLabeler(mode, ruleInputs);
  return [
    ...issuesLines(
      ordered.filter((x) => x.kind === "finding"),
      issueHeadings,
      verdictIntros,
      labelOf,
      mode
    ),
    ...manualSection(todo("code"), SECTION_TITLES.code, brightCyan, labelOf),
    ...manualSection(
      todo("extendedManual"),
      SECTION_TITLES.extendedManual,
      brightCyan,
      labelOf
    ),
    // Beside the standard manual checks, and before them: the two STANDARD sections are
    // the review carried by every submission - this one done by reading, that one by
    // hand - so they read as a pair after the extended sections, which are raised by
    // this submission in particular.
    ...preSweepSection(meta.preSweep ?? null),
    ...manualSection(todo("standard"), SECTION_TITLES.standard, blue, labelOf),
  ];
}

/**
 * One numbered step of a prompt: the first paragraph carries the "N. " marker and every
 * paragraph after it is indented to sit beneath it.
 *
 * Both prompts lay their steps out this way, from one function, because a continuation
 * left flush-left reads as a step of its own - and so does the literal example a step
 * carries, which belongs to that step. The numbers are the caller's: it numbers what
 * survived its own filtering, which is why no step may number itself.
 *
 * Authored line breaks inside a paragraph are the layout and wrapText keeps them. `blocks`
 * let a caller render a paragraph itself, each matched by its whole authored text: its
 * lines are printed VERBATIM, however many there are, because they are not prose. Every
 * user needs that for the same reason - a command split across lines is a command to
 * reassemble (the SCA prompt's flags, and the review prompt's own hand-back), and so is a
 * table of named values (the paths a review hands its build agent).
 *
 * A LIST rather than one, because a single prompt can carry two of them: an SCA review
 * that also sweeps hands its build agent a path table and its sweep a command, and the
 * step carrying each is a different step.
 * @param {number} n  The step's number, as printed.
 * @param {string} text  The authored step.
 * @param {{name: string, lines: string[]}[]} [blocks]  Paragraphs the caller renders.
 * @returns {string[]}
 */
function stepLines(n, text, blocks = []) {
  const marker = `${n}. `;
  const indent = " ".repeat(marker.length);
  const [first, ...rest] = text.split("\n\n");
  const out = [...wrapText(`${marker}${first}`)];
  for (const paragraph of rest) {
    out.push("");
    const block = blocks.find((b) => paragraph.trim() === b.name);
    if (block) {
      // An empty line takes no indent: a line of spaces is trailing whitespace in
      // something a reader may copy out whole.
      out.push(...block.lines.map((line) => (line ? `${indent}${line}` : "")));
    } else {
      out.push(...wrapText(paragraph, indent));
    }
  }
  return out;
}

/**
 * One pass of the REVIEW LOOP, printed: the prompt the agent reads this time round.
 *
 * Five layers, and only the middle two vary by phase:
 *
 *   PREAMBLE  once, on the first run. What is about to happen, and the one standing rule
 *             about reading code against the schema. No input path is named here - a block
 *             headed "what is being reviewed" reads as an assignment, and invites the agent
 *             to go and read it before a step asks.
 *   FRAME     the file, and that it changed since the last pass. The linter's, every pass.
 *   INTRO     the phase's, and often empty: an intro earns its text only where the steps
 *             alone would let the agent do work that is not its own.
 *   STEPS     the phase's, numbered over what survived its markers. No step numbers itself.
 *   HANDOVER  ONE text, appended as the last numbered step, so no phase can forget to say
 *             how to hand back and no author has to know which phase is last.
 *
 * The values a step names are filled here rather than carried in the file: `{{paths}}`-style
 * blocks are printed by the step that uses them, which is the same rule today's prompt
 * follows - a path is printed by the thing that needs it.
 * @param {{preamble: string, frame: string, handover: string}} texts  From
 *   registry.llmPhases().
 * @param {{name: string, intro: string}} phase
 * @param {{text: string}[]} steps  Already filtered by src/report/phases.js stepsOf.
 * @param {Object<string, string>} values  What the texts and steps name: review, command,
 *   schemaCache, description, build, scaRoot.
 * @param {boolean} [first]  Print the preamble, which one run does and the rest do not.
 * @returns {string[]}
 */
/** The prompt values that are handed to a step as a BLOCK rather than substituted into
 *  its prose: printed line for line, never re-wrapped. Both are tables of paths, and a
 *  wrapped path is one nobody can copy - the package block because its reader looks values
 *  up in it, the Review Details block because the reviewer is given it as it stands. */
const BLOCK_VALUES = new Set(["package", "details"]);

export function loopPromptLines(texts, phase, steps, values, first = false) {
  // Everything BUT the value blocks, which stepLines lays out unwrapped below.
  const fill = (text) =>
    Object.entries(values).reduce(
      (acc, [name, value]) =>
        BLOCK_VALUES.has(name) ? acc : acc.split(`{{${name}}}`).join(value),
      text
    );
  const lines = [...section("LLM Prompt"), ""];
  if (first) {
    lines.push(...promptProse(fill(texts.preamble)), "");
  }
  lines.push(...promptProse(fill(texts.frame)));
  if (phase.intro) {
    lines.push("", ...promptProse(fill(phase.intro)));
  }
  // A block of named values is handed to stepLines rather than substituted into the
  // prose: it must NOT be wrapped. A path split across two lines is a path nobody can
  // copy, and the agent is being told where to look.
  const blocks = [...BLOCK_VALUES]
    .filter((name) => values[name])
    .map((name) => ({ name: `{{${name}}}`, lines: values[name].split("\n") }));
  // The handover is the last numbered step, not a trailer: the agent follows a numbered
  // list, and a hand-back tacked on as prose is the one instruction it can skim past.
  const all = [...steps.map((s) => s.text), texts.handover];
  all.forEach((text, i) => {
    lines.push("", ...stepLines(i + 1, fill(text), blocks));
  });
  return lines;
}

/**
 * A block of authored prose: paragraphs wrapped to the report width and kept apart.
 *
 * The source line breaks do NOT survive. A registry text is authored as wrapped YAML, so
 * its breaks are an artefact of where the author's editor ended a line - re-wrapping here
 * is what stops one turning up mid-sentence in the prompt.
 *
 * A VALUE BLOCK is the exception, and is printed exactly as authored: every line of it is
 * a name and a path, or a path alone. Those must not be wrapped - a wrapped path is a path
 * nobody can copy - and must not be collapsed, or two values become one line.
 */
function promptProse(text) {
  const out = [];
  text.split("\n\n").forEach((paragraph, i) => {
    if (i > 0) {
      out.push("");
    }
    if (isValueBlock(paragraph)) {
      out.push(
        ...paragraph
          .trim()
          .split("\n")
          .map((l) => `  ${l.trim()}`)
      );
      return;
    }
    out.push(...wrapText(paragraph.replace(/\s+/g, " ").trim()));
  });
  return out;
}

/** Whether every line opens with a NAME - an all-caps token and then its value, which is
 *  what a block of named paths looks like and what no sentence does. Such a block is
 *  printed exactly as given: a wrapped path is one nobody can copy, and a collapsed one
 *  joins two values into a line that names neither. */
function isValueBlock(paragraph) {
  const lines = paragraph.trim().split("\n");
  return lines.every((l) => /^[A-Z][A-Z0-9_]*\s/.test(l.trim()));
}

/** The values --llm-sca-review hands its reader, in the order the steps use them. Named
 *  here because the prompt's steps name them: the facts are a table the reader looks up,
 *  never a sentence they have to extract a path from. */
const SUBMISSION_VALUES = [
  ["XPI", "xpi"],
  ["SOURCE_ARCHIVE", "source"],
  ["FOLDER", "folder"],
  ["SCA_ROOT", "extracted"],
];

/**
 * A block of NAMED values: the name on its own line, its value indented beneath it.
 *
 * Every value then starts at one known column whatever its name is, and no line holds two
 * things. Never wrapped, because these are paths: one split across lines is one a reader
 * has to reassemble. The paths are ours - a folder we were given, a file we named - but
 * they travel through a submission's own file names, so they are made safe to show
 * (displayPath), which strips what could forge a line and alters nothing else: these are
 * copied back, so a path we changed is a path the reader cannot use.
 *
 * One renderer for both blocks that use this shape - the SCA prompt's Submission and the
 * report's Review Details - because the prompt's steps look a value up in whichever of
 * them the run printed, and a reader learns the shape once.
 * @param {[string, string][]} entries  Name and value, in the order they print.
 * @returns {string[]}
 */
function valueLines(entries) {
  return entries.flatMap(([name, value]) => [
    `  ${name}`,
    `    ${displayPath(value)}`,
  ]);
}

/**
 * The whole output of a --llm-sca-review run: the prompt that turns a submission folder
 * into an SCA review, the values it works from, and the flags to run it with.
 *
 * Three parts on purpose. The VALUES are `NAME` with its value beneath it, never wrapped,
 * so a reader takes a path by looking up a name rather than by parsing a sentence -
 * SCA_ROOT among them: this tool cannot open a source archive itself, but it can still
 * name where one should land, the same way it names FOLDER or SOURCE_ARCHIVE. The STEPS
 * are prose, and they name those given values - and the ones the reader still has to work
 * out, <SCA_SOURCE>, <SCA_EXP_SOURCE> - instead of carrying paths themselves. The FLAGS
 * are the finished command, one flag per line, filled into the step that says to run it.
 *
 * What this run was given decides what is printed: a step marked `run: experiments` is
 * dropped unless Experiments are allowed, and the surviving steps are numbered 1..N here,
 * so no step may number itself. A prompt that asked for a value nothing will read would be
 * asking for work that cannot be used.
 *
 * No review has run when this prints, and none can until its reader answers it - so unlike
 * every other section here, this one describes work still to do rather than work done.
 * @param {{intro: string, outcome: {run: ?string, text: string}[]}} prompt  From
 *   registry.llmScaReviewPrompt().
 * @param {{folder: string, xpi: string, source: string, extracted: string}} submission
 *   From scaSubmission().
 * @param {{flags: string[], experiments: boolean}} review  What the review is to be run
 *   as, composed by the front-end (src/cli.js), which owns the flag names and holds the
 *   parser's answers: the finished flag lines, and whether Experiments are allowed.
 *   Laid out here, never added to, trimmed or second-guessed.
 * @returns {string[]}
 */
export function scaPromptLines(prompt, submission, review) {
  const lines = [
    ...section("SCA Review Prompt"),
    "",
    ...wrapText(prompt.intro),
    "",
    "Submission:",
  ];
  lines.push(
    ...valueLines(
      SUBMISSION_VALUES.map(([name, key]) => [name, submission[key]])
    )
  );
  // The flags are a command, composed elsewhere - but they travel through a submission's
  // own file names, so they are made safe to show like every other line here. displayPath,
  // not displayLine: this command names the very files the block above it names, and its
  // reader RUNS it. Collapsing a run of spaces inside a quoted path hands them a command
  // for a file that does not exist - or, worse, for a different one that does.
  const flags = review.flags.map(displayPath);
  const steps = prompt.outcome.filter(
    (step) => step.run !== "experiments" || review.experiments
  );
  steps.forEach((step, i) => {
    // The flags are a paragraph of their own and are NOT wrapped - a command split across
    // lines is a command to reassemble - so they are rendered here and slotted in.
    lines.push(
      "",
      ...stepLines(i + 1, step.text, [{ name: "{{flags}}", lines: flags }])
    );
  });
  return lines;
}

/**
 * What a phase that READS the add-on is told: which artifact is under review, and the
 * schema snapshot it is judged against.
 *
 * Built from the same `meta` the report's own header is, so the two can never name
 * different artifacts. An XPI review names the one it has; a source code review names the
 * extracted root and the subtree inside it that IS the add-on's code - which is the only
 * way an agent can know which files are the developer's and which are build scaffolding.
 *
 * SCHEMA is a line, not a path: the cache holds several branches, and the one this review
 * read is the only one its verdicts mean anything against.
 * @param {import("./format.js").ReviewMeta} meta
 * @param {?string} schemaCache  Where the snapshots live.
 * @returns {string[]}
 */
export function packageLines(meta, schemaCache) {
  const values = [];
  if (meta.scaRoot) {
    values.push(["SCA_ROOT", meta.scaRoot], ["SCA_SOURCE", meta.scaSource]);
    if (meta.scaExpSource) {
      values.push(["SCA_EXP_SOURCE", meta.scaExpSource]);
    }
  } else {
    values.push(["XPI", meta.xpi]);
  }
  if (schemaCache) {
    values.push(["SCHEMA_CACHE", schemaCache]);
  }
  values.push([
    "SCHEMA",
    `${meta.schemaBranch} · Thunderbird ${meta.applicationVersion ?? "?"}` +
      (meta.manifestVersion != null
        ? ` · manifest_version ${meta.manifestVersion}`
        : ""),
  ]);
  return values.map(([name, value]) => `${name} ${value}`);
}

/**
 * Review Details: what was reviewed, and against which schema.
 *
 * Printed with the REPORT, and never beside a prompt: a phase that reads the add-on prints
 * the values it needs itself (packageLines), and a name printed with no step behind it is
 * an instruction with nothing to do.
 *
 * The paths are a block of NAMED values (valueLines), the shape the --llm-sca-review
 * prompt uses for its own Submission block. Named, because the --llm-review prompt's steps
 * point at them by name rather than carrying a path through wrapped prose - and named in
 * EVERY run, not only under a review flag, because one section must not read two ways
 * depending on a flag.
 *
 * An SCA review spans TWO artifacts and the reader has to know which is which: the report
 * labels every locus [XPI]/[SCA], and the block names the artifacts behind those labels -
 * the shipped add-on as XPI_FILE (what was submitted, by name) and XPI_ROOT (where its
 * files can be READ, packed or not), and the [SCA] side as the
 * values the run was GIVEN: SCA_ROOT, SCA_SOURCE, and SCA_EXP_SOURCE when one was named.
 * Each stands on its own line rather than being composed into one path, because each is a
 * value its reader hands back - to this tool as a flag, or to an agent as a folder to read.
 *
 * The schema line stays prose beneath the block: nothing looks it up by name.
 * @param {ReviewMeta} meta
 * @returns {string[]}
 */
export function headerLines(meta) {
  // The pipeline prints this section AFTER runChecks, so every value here names
  // something the review has already read.
  //
  // XPI_FILE and XPI_ROOT, not one XPI path: what was submitted, said the way a reviewer
  // says it, and where this run put it so it can be READ. A single path row answered
  // neither question well - it named a file nothing reads any more, in a spelling nobody
  // repeats back.
  const values = [
    ["XPI_FILE", meta.xpiFile],
    ["XPI_ROOT", meta.xpiRoot],
  ];
  if (meta.scaRoot) {
    values.push(["SCA_ROOT", meta.scaRoot], ["SCA_SOURCE", meta.scaSource]);
  }
  // Only when it was given: it is the optional one of the three, and what it names was
  // excluded from the WebExtension code checks - which nothing else in the report says.
  if (meta.scaExpSource) {
    values.push(["SCA_EXP_SOURCE", meta.scaExpSource]);
  }
  // Only --llm-review writes one. It is named here rather than only in the prompt so
  // the section stays the one place that says what this review consists of.
  // Where the sweep's results GO, like the description below: this run writes no such
  // file either. Named only by a run that sweeps, because only that run prints the step
  // that writes it and the hand-back that reads it back.
  // Where the description GOES, not where it is: this run writes no such file. The
  // prompt's reader does, and the reviewer is handed a link to it.
  if (meta.summaryFile) {
    values.push(["ADDON_DESCRIPTION", meta.summaryFile]);
  }
  // Where the build report GOES, on the same terms: a source code review's reviewer
  // reproduces the build, and this names what that takes without this tool ever reading it.
  if (meta.buildFile) {
    values.push(["BUILD_PROCESS", meta.buildFile]);
  }
  return [
    ...section("Review Details"),
    "",
    ...valueLines(values),
    "",
    schemaLine(meta),
  ];
}

/** What the review's verdicts mean anything against, in one line. Shared by the two
 *  renderers below and above it, because it is the same sentence either way - only the
 *  paths differ between a terminal and a chat. */
function schemaLine(meta) {
  return (
    `schema ${meta.schemaBranch} · Thunderbird ${meta.applicationVersion ?? "?"}` +
    (meta.manifestVersion != null
      ? ` · manifest_version ${meta.manifestVersion}`
      : "")
  );
}

/**
 * The same facts as headerLines, written for a CHAT rather than a terminal.
 *
 * Two renderers rather than one with a flag, because almost nothing survives the crossing:
 * a terminal gets an aligned block of indented paths, a chat gets a list of links a reader
 * can click. The two agree on WHICH facts are named and on nothing else, and a single
 * renderer trying to be both would be a chain of conditionals around every line.
 *
 * Each row carries its own link text rather than deriving one from its path: every path
 * named here is one this tool chose, and a timestamped string is not what a reader wants
 * to click - what matters about it is what it IS.
 *
 * XPI_FILE is the one row with no link: it names what was submitted, not a location, so
 * there is nothing here for a client to open.
 * @param {ReviewMeta} meta
 * @returns {string[]}
 */
export function detailLinkLines(meta) {
  const rows = [];
  if (meta.xpiFile) {
    rows.push(["XPI_FILE", null, meta.xpiFile]);
  }
  if (meta.xpiRoot) {
    rows.push(["XPI_ROOT", "extracted addon", meta.xpiRoot]);
  }
  if (meta.scaRoot) {
    rows.push(
      ["SCA_ROOT", "source archive", meta.scaRoot],
      ["SCA_SOURCE", "add-on source", meta.scaSource]
    );
  }
  if (meta.scaExpSource) {
    rows.push(["SCA_EXP_SOURCE", "experiment source", meta.scaExpSource]);
  }
  if (meta.summaryFile) {
    rows.push(["ADDON_DESCRIPTION", "summary.md", meta.summaryFile]);
  }
  if (meta.buildFile) {
    rows.push(["BUILD_PROCESS", "build.md", meta.buildFile]);
  }
  return [
    ...rows.map(([name, text, target]) =>
      text === null
        ? `* ${name}: ${displayLine(target)}`
        : `* ${name}: [${text}](${displayPath(target)})`
    ),
    "",
    schemaLine(meta),
  ];
}

/**
 * Found Issues: one numbered entry per distinct message - the response printed
 * VERBATIM, then its "- file:line" locations. Grouped by severity under
 * registry-defined headings (numbering continuous across the severity groups) when
 * headings are supplied, otherwise a single flat list. The entries and their order are
 * read off the sequence, never decided here (src/report/order.js).
 *
 * A registry-owned verdict preamble opens the section: with no findings it is
 * the whole body (`verdictIntros.none`). With findings it is `rejected` (any error),
 * `hold` (a hold and no error) or `feedback` (warnings/info only), glued to the FIRST
 * severity heading - one space, no blank line - and printed verbatim (no
 * rewrap), like the findings below it.
 * @param {import("./order.js").OrderedItem[]} items  The findings half of the ordered
 *   sequence (src/report/order.js), which owns the order, the grouping and the numbers.
 * @param {Record<string, string>} [issueHeadings]
 * @param {Record<string, string>} [verdictIntros]
 * @param {(f: import("./finding.js").Finding) => string} [labelOf]  Artifact label
 *   ([XPI]/[SCA]) for a finding's file:line, "" when none (see reviewBodyLines).
 * @param {import("../lib/enum.js").ReviewMode} [mode]  The review mode; SCA appends the label legend footer.
 * @returns {string[]}
 */
function issuesLines(items, issueHeadings, verdictIntros, labelOf, mode) {
  return [
    ...section(SECTION_TITLES.issues),
    ...issuesBodyLines(items, issueHeadings, verdictIntros, labelOf, mode),
  ];
}

/**
 * The same section WITHOUT its header: the text a developer receives.
 *
 * Split out because the review loop hands this to the reviewer to paste into the response
 * box, where `── Found Issues ──` is the linter's chrome rather than anything the developer
 * needs. Everything below the header stays - the verdict preamble, the severity headings,
 * the numbered entries, the artifact legend and the pointer at this tool - because all of
 * it is addressed to the developer and all of it is sent today.
 * @param {import("./order.js").OrderedItem[]} items
 * @param {Record<string, string>} [issueHeadings]
 * @param {Record<string, string>} [verdictIntros]
 * @param {(f: import("./finding.js").Finding) => string} [labelOf]
 * @param {import("../lib/enum.js").ReviewMode} [mode]
 * @returns {string[]}
 */
export function issuesBodyLines(
  items,
  issueHeadings,
  verdictIntros,
  labelOf,
  mode
) {
  const out = [];
  const intros = verdictIntros ?? {};
  const issues = items.map((x) => x.target);
  if (issues.length === 0) {
    out.push(intros.none ?? "The automated review did not find any issues.");
    return out;
  }
  const intro = intros[verdictKey(issues)];
  let n = 0;
  let band = null;
  for (const entry of entriesOf(items)) {
    if (issueHeadings) {
      if (entry.section !== band) {
        band = entry.section;
        const tint = SEV_COLOR[band] ?? identity;
        out.push("");
        const heading = issueHeadings[band];
        const text = n === 0 && intro ? `${intro} ${heading ?? ""}` : heading;
        if (text) {
          // Verbatim, like the findings: no 80-column rewrap. The registry owns
          // the intro/heading wording on one line. Any authored break is kept.
          out.push(...text.split("\n").map(tint));
        }
      }
      out.push("");
    } else if (n > 0) {
      out.push(""); // blank line between entries
    }
    out.push(...renderGroup(++n, entry, labelOf));
  }
  // In an SCA review a finding's file:line is prefixed with the artifact it lives in;
  // a legend explains the labels. XPI reviews (one artifact) omit it.
  if (mode?.sca) {
    out.push("");
    out.push(grey("[XPI] = source file in the submitted XPI"));
    out.push(grey("[SCA] = source file in the submitted source code archive"));
  }
  // A pointer to the tool: the developer can run this same automated review before
  // submitting and fix the findings above first. Shown in both modes.
  out.push("");
  out.push(
    grey("You can run this automated review yourself before submitting:")
  );
  out.push(grey("https://github.com/thunderbird/webext-linter"));
  return out;
}

/**
 * Cut an ordered sequence into the entries it prints: a run of consecutive items
 * sharing an entry key. The sequence already decided the order, the grouping and the
 * numbering (src/report/order.js), so this only finds the boundaries - there is no
 * second opinion here about what goes where.
 * @param {import("./order.js").OrderedItem[]} items
 * @returns {{key: string, section: string, members: object[],
 *   shown: {target: object, collapsed: number}[], withheld: number}[]}
 *   `shown` carries the ORDERED items, not the bare targets: a line has to print the
 *   count of what it stands for, and that count was decided with the rest of the
 *   sequence rather than here.
 */
function entriesOf(items) {
  const out = [];
  for (const item of items) {
    const last = out.at(-1);
    if (last && last.key === item.entry && last.section === item.section) {
      last.members.push(item.target);
      if (item.shown) {
        last.shown.push(item);
      } else if (!item.folded) {
        // A case folded into another's line is not "withheld": the line standing for it
        // says so itself, and counting it here too would report it twice.
        last.withheld++;
      }
      continue;
    }
    out.push({
      key: item.entry,
      section: item.section,
      members: [item.target],
      shown: item.shown ? [item] : [],
      withheld: item.shown || item.folded ? 0 : 1,
    });
  }
  return out;
}

/**
 * The locus lines of one entry: ` - file:line` (with the artifact label and any
 * per-locus hint) for each item the sequence numbered, then an "and N more" marker
 * standing for the ones it withheld. Shared by the Found Issues entries and the to-do
 * sections. What is shown and what is withheld was decided in src/report/order.js - the
 * cap is not applied a second time here, because a second opinion about it is exactly
 * how the printed numbers and the addressable ones came apart.
 * A line standing for cases of the same subject elsewhere says how many, because "this
 * host, and others like it" and "this host, in two more files" are different facts and a
 * reader cannot tell them apart from the entry alone. Counted in order.js; printed here.
 * @param {{shown: {target: object, collapsed: number}[], withheld: number}} entry
 * @param {(x: object) => string} [labelOf]  Artifact label prefix (SCA only).
 * @returns {string[]}
 */
function renderLocusList(entry, labelOf) {
  const lines = [];
  for (const { target, collapsed } of entry.shown) {
    if (hasLocus(target)) {
      // A reviewer's answer can be a LIST, and locationLine keeps their lines when the
      // answer is all this case has. Each becomes an item of its own here, which is what
      // they wrote it as - and is a single line for everything else, which is what every
      // other locus is.
      const own = locationLine(target, labelOf?.(target)).split("\n");
      // On the LAST of them, so a multi-line answer reads as one case with a count at
      // its end rather than a count buried inside it.
      if (collapsed) {
        own[own.length - 1] += ` (+${collapsed} elsewhere)`;
      }
      for (const line of own) {
        lines.push(` - ${line}`);
      }
    }
  }
  if (entry.withheld) {
    lines.push(excludedMarker(entry.withheld));
  }
  return lines;
}

/**
 * Render one Issues entry: the shared registry response VERBATIM (no 80-column
 * rewrap, no hanging indent - a long line runs off, and the registry's own
 * break before "Read more:" lands at column 0), then one location line per finding that
 * HAS one (see hasLocus - an entry whose subject is the submission as a whole has none,
 * and renders as the message alone). The locus has up to two parts: `locationLine`
 * surfaces the SUBJECT (`item`) after "file:line" when the message did not name it
 * (`listItem`), then the DETAIL (`hint`) is appended after " - ", and a reviewer's
 * `note` closes the line in parentheses - so a finding with all of them renders
 * "file:line - item - hint (note)". Manual review still wraps - see manualSection.
 * @param {number} n  1-based entry number.
 * @param {{key: string, members: import("./finding.js").Finding[], shown: object[],
 *   withheld: number}} entry  One grouped entry - its members all share a message, and
 *   the first speaks for the group.
 * @param {(f: import("./finding.js").Finding) => string} [labelOf]  Artifact label.
 * @returns {string[]}
 */
function renderGroup(n, entry, labelOf) {
  const [first, ...rest] = entry.members[0].message.split("\n");
  const lines = [`${n}) ${first}`, ...rest];
  lines.push(...renderLocusList(entry, labelOf));
  // Tint the whole entry by severity (error red, warning yellow) - a no-op
  // unless the CLI enabled color. Each line is tinted on its own, so the color
  // resets per line and stripColor cleans the --report-out copy.
  const tint = SEV_COLOR[entry.members[0].severity] ?? identity;
  return lines.map(tint);
}

/**
 * The capped-list marker that closes a grouped entry whose location list was
 * truncated to MAX_ENTRIES_PER_CATEGORY: a final "- ..." line standing in for
 * the omitted locations. Display only - the summary counts and JSON still see
 * every finding (see MAX_ENTRIES_PER_CATEGORY in src/config.js).
 * @param {number} n  How many locations were omitted.
 * @returns {string}
 */
function excludedMarker(n) {
  return ` - … and ${n} more, excluded from this list`;
}

/**
 * One manual-review section under `title`. Items sharing a "Title: instructions"
 * body collapse into one numbered entry (like Issues) - the body is still
 * 80-column wrapped. When the entry has a developer-facing `response`, it is
 * labelled "Suggested response:" and printed under the instructions in dim grey,
 * flush-left and verbatim (a ready-to-send block) so it does not pull focus
 * from the blue instructions. Each item that carries a locus is then listed
 * beneath as "- file:line - item", in the same grey as the response, which a
 * "Suggested verdict:" line precedes when the check declares a band. Standalone
 * reminders (no locus) carry no list. Returns [] when there are no items, so an
 * absent section prints nothing.
 * @param {import("./finding.js").ManualItem[]} items
 * @param {string} title  Section heading, e.g. "Extended Manual Review".
 * @param {(s: string) => string} [accent]  Color for the heading and the numbers.
 * @param {(f: import("./finding.js").Finding) => string} [labelOf]  Artifact label.
 * @returns {string[]}
 */
function manualSection(items, title, accent = blue, labelOf) {
  if (!items.length) {
    return [];
  }
  const out = section(title);
  out.push("");
  // A manual-review section is all manual work, so it is all the section's accent
  // color (a no-op unless color is enabled) - Extended uses a vivid cyan, distinct
  // from Standard's blue, so the two are easy to tell apart. Each line is tinted on
  // its own for stripColor.
  out.push(accent(TODO_LEAD));
  let n = 0;
  for (const entry of entriesOf(items)) {
    const group = entry.members;
    const body = manualBody(group[0]);
    out.push("");
    // The reviewer-facing instructions (the section's accent, 80-col wrapped).
    out.push(...wrapText(`${++n}) ${body}`).map(accent));
    // The band a reported case lands in, above the response so its weight is known
    // before the text is sent. Absent for a check that produces no finding either way.
    const verdict = group[0].verdict;
    if (verdict) {
      out.push(grey(`Suggested verdict: ${verdict}`));
    }
    // Shared across the group, so taken from the first item; verbatim like the Found
    // Issues responses (a ready-to-send block).
    const response = group[0].response;
    if (response) {
      const lines = response.split("\n");
      lines[0] = `Suggested response: ${lines[0]}`;
      for (const line of lines) {
        out.push(grey(line));
      }
    }
    // List a locus only when there is one (escalated items). Standalone
    // reminders have no file/item and render as the wrapped body alone. The
    // list is display-capped like Issues (see renderGroup). Tinted in the same
    // grey as the response (not the instructions' blue), so it reads as detail.
    out.push(...renderLocusList(entry, labelOf).map(grey));
  }
  return out;
}

/**
 * The Standard Code Review section: ONE sweep, carried by every submission - the shared
 * method, then the bare class of code each check cannot detect for itself.
 *
 * Unlike every other section here this one lists CHECKS, not cases, and it is printed
 * whether or not any of them found something: a check that found nothing is exactly the
 * one whose blind spot is worth reading. It carries no locus and takes no verdict - what
 * a sweep finds is filed as a finding of the named check, not as an answer to this.
 *
 * The same text the --llm-review prompt carries, so the reviewer reading this page and
 * the agent doing the reading are told the same thing in the same words.
 *
 * Blue, like Standard Manual Review and unlike the vivid cyan of the extended sections:
 * the colour says which pair a section belongs to - carried by every submission, or
 * raised by this one.
 * @param {?{intro: string, items: object[]}} sweep
 * @returns {string[]}
 */
function preSweepSection(sweep) {
  if (!sweep?.items?.length) {
    return [];
  }
  const out = section(SECTION_TITLES.preSweep);
  out.push("");
  out.push(blue(TODO_LEAD));
  let n = 0;
  for (const entry of sweep.items) {
    out.push("");
    // Laid out exactly like a manual-review entry (manualBody): "N) title: body", with
    // the authored newlines collapsed so the item re-wraps to the report's width instead
    // of keeping the yaml's. The check id and its band are NOT repeated here - the agent
    // reads them as fields of the entry, and the title already says which check this
    // is in the words the rest of the report uses.
    const body = entry.instruction.replace(/\s+/g, " ").trim();
    out.push(...wrapText(`${++n}) ${entry.title}: ${body}`).map(blue));
    // The band and the wording a find would carry, laid out exactly as a manual-review
    // entry lays them out: this section asks the same kind of question, so it should
    // answer the same question a reviewer asks of one - if I find this, what happens,
    // and what does the developer read? A swept case is worded from this same text.
    if (entry.severity) {
      out.push(grey(`Suggested verdict: ${entry.severity}`));
    }
    if (entry.response) {
      const lines = entry.response.split("\n");
      lines[0] = `Suggested response: ${lines[0]}`;
      for (const line of lines) {
        out.push(grey(line));
      }
    }
  }
  return out;
}

/**
 * Summary: issue counts by severity plus one count per to-do section, in the body's
 * section order (the two extended sections, then the two standard ones every submission
 * carries).
 *
 * Also printed on its own by a --llm-review run, which has no report body for it to close:
 * without it that run's output would not say whether the add-on is ready to sign off or
 * still has work waiting.
 * @param {import("./finding.js").Finding[]} issues
 * @param {import("./finding.js").ManualItem[]} [manual]
 * @param {?object} [preSweep]  The blind-spot sweep this review carries, counted with the
 *   to-do items; null when the review has none to run.
 * @returns {string[]}
 */
export function summaryLines(issues, manual = [], preSweep = null) {
  return [
    ...section("Summary"),
    "",
    ...summaryBodyLines(issues, manual, preSweep),
  ];
}

/**
 * The same counts WITHOUT the `── Summary ──` header, for the review loop, which titles
 * the block itself.
 * @param {import("./finding.js").Finding[]} issues
 * @param {object[]} [manual]
 * @param {?{items: object[]}} [preSweep]
 * @returns {string[]}
 */
export function summaryBodyLines(issues, manual = [], preSweep = null) {
  return tallyLines(issues, bucketCounts(manual), preSweep);
}

/**
 * The counts, on three lines: what the review FOUND, then what it raised about this
 * submission in particular, then what it carries for every submission. One run-on line
 * reads as a first number followed by noise, and the three groups are three different
 * questions about the review.
 *
 * "item(s)", not "step(s)": each one is a thing listed in a section above, and a reader
 * comparing the tally to those sections is counting entries, not actions.
 * @param {import("./finding.js").Finding[]} issues
 * @param {{code: number, manual: number, standard: number}} counts
 * @param {?{items: object[]}} [preSweep]
 * @returns {string[]}
 */
function tallyLines(issues, counts, preSweep = null) {
  const c = tally(issues);
  // What the section actually lists: it numbers its entries 1..N, so the tally counts
  // them. That the reader answers all of them in one pass is how the sweep is RUN, not
  // how much is on the page.
  const sweep = preSweep?.items?.length ?? 0;
  return [
    `${c.error} error(s), ${c.hold} hold, ${c.warning} warning(s), ${c.info} info,`,
    `${counts.code} extended code review item(s), ` +
      `${counts.manual} extended manual review item(s),`,
    `${sweep} standard code review item(s), ` +
      `${counts.standard} standard manual review item(s)`,
  ];
}

/**
 * How many to-dos fall in each of the three sections, for the Summary tally. Counted
 * off the same ordered sequence the sections are printed from, so the tally and the
 * lists above it cannot disagree about which section an item is in.
 * @param {import("./finding.js").ManualItem[]} manual
 * @returns {{code: number, manual: number, standard: number}}
 */
function bucketCounts(manual) {
  const ordered = orderReview([], manual);
  const count = (section) =>
    ordered.filter((x) => x.section === section).length;
  return {
    code: count("code"),
    manual: count("extendedManual"),
    standard: count("standard"),
  };
}

/**
 * Render the review result as JSON.
 *
 * @param {ReviewResult} review
 * @returns {string}
 */
export function formatJson(review) {
  // The manual-review to-do list is human-only, not machine-verifiable, so it is
  // dropped from JSON (ATN consumes this for auto-verification). The pre-sweep list goes for
  // the same reason and a sharper one: it is an instruction TO A READER, not a statement
  // about the add-on, so it says nothing this document is for. What a sweep finds does
  // reach here - as a finding of the check that owns it, indistinguishable from one the
  // scan made itself, which is the point.
  const { manualReview: _omitted, preSweep: _sweeps, ...meta } = review.meta;
  const issues = review.findings;
  // `data` (template-resolution input, baked into `message`), `listItem` and `collapse`
  // (text-layout flags) are internal, so they are dropped from the machine output.
  // Consumed by tooling rather than a terminal, but a consumer may print it, so the
  // submission-derived fields carry no more than the text report shows.
  const publicFindings = sortFindings(issues).map(
    ({ data: _d, listItem: _li, collapse: _c, note, ...f }) => ({
      ...f,
      ...(f.file == null ? {} : { file: displayLine(f.file) }),
      ...(f.item == null ? {} : { item: displayLine(f.item) }),
      ...(f.hint == null ? {} : { hint: displayLine(f.hint) }),
      // A reviewer's note only when there is one: every other finding's document is
      // the shape it always was.
      ...(note == null ? {} : { note: displayLine(note) }),
    })
  );
  return JSON.stringify(
    {
      meta,
      summary: { ...tally(issues), byRule: countByRule(issues) },
      findings: publicFindings,
    },
    null,
    2
  );
}

/**
 * The artifact label ([XPI]/[SCA]) for one finding/manual item's file:line - "" in an
 * XPI review (one artifact). Applied wherever locationLine renders a locus, and by the
 * verdict enumeration, so an item's reference string is the line the report printed.
 * @param {import("../lib/enum.js").ReviewMode} [mode]
 * @param {Map<string, string>} [ruleInputs]
 * @returns {(x: object) => string}
 */
export function locusLabeler(mode, ruleInputs) {
  return (f) =>
    artifactLabel({ file: f.file, input: ruleInputs?.get(f.ruleId), mode });
}

/**
 * Return a titled section header preceded by a blank line.
 *
 * @param {string} title
 * @returns {string[]}
 */
function section(title) {
  return ["", `── ${title} ──`];
}

/**
 * The whole location line listed under an Issue: the path ("file:line", ":line" only
 * when a line is known), then the finding's identifier when its message did not consume
 * it (`listItem`), then the supplementary detail (`hint`) - each joined by " - ". With no
 * path at all whichever of those exists leads instead; hasLocus guarantees at least one
 * does, so there is nothing to stand in for.
 *
 * A reviewer's `note` closes the line in PARENTHESES rather than after another " - ":
 * every other part is a short phrase, a note is a sentence a person typed, and a viewer
 * wrapping the line would make a dash-joined sentence read as a location of its own. It is
 * collapsed to one line there, because it shares that line.
 *
 * With nothing before it the note IS the location, and then the reviewer's own lines are
 * kept: they answered a check that asked what they found, and a list of findings is a
 * list. The caller splits on them (renderLocusList), so each becomes a location line.
 *
 * A segment equal to one already on the line is DROPPED rather than printed twice. A
 * check whose subject is its own locus repeats the path otherwise - an untrusted library
 * with no identified name falls back to its path, and the line read
 * "lib/x.js - lib/x.js - <source>". The guard lives here, not in the rules, so no rule
 * can reintroduce it and none has to know that its subject might BE the locus. The
 * finding still carries both fields: this decides what is printed, not what is recorded,
 * so the JSON report carries both.
 *
 * In an SCA review a `[XPI] `/`[SCA] ` artifact label prefixes the file (only when
 * there is a file - an item-only locus names no path to disambiguate).
 * @param {import("./finding.js").Finding} f
 * @param {string} [label]  Artifact label ("XPI"/"SCA"), or "" for none.
 * @returns {string}
 */
export function locationLine(f, label = "") {
  // The path comes from an archive entry name, and the item and hint from the
  // submission, so all three are made safe to show. The label is ours.
  const file = f.file ? displayLine(f.file) : null;
  const where = file
    ? `${label ? `[${label}] ` : ""}${file}${f.loc?.line != null ? `:${f.loc.line}` : ""}`
    : null;
  // Compared against the bare path, not `where`: the label and :line are ours, and it is
  // the path a subject repeats.
  const seen = new Set(file ? [file] : []);
  const segments = where ? [where] : [];
  for (const value of [f.listItem ? f.item : null, f.hint]) {
    const text = value == null ? "" : displayLine(value);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    segments.push(text);
  }
  const line = segments.join(" - ");
  // Last, after everything the linter knows about the location: the line reads as the
  // case first and what a person added about it second.
  // A note that ANNOTATES a location is a phrase and shares that line, so it is collapsed
  // into one; a note that IS the location keeps the reviewer's lines, and the caller gives
  // each one its own bullet.
  const note = f.note == null ? "" : f.note;
  if (!note || seen.has(note)) {
    return line;
  }
  return line ? `${line} (${displayLine(note)})` : note;
}

/**
 * The question ONE manual-review item is put to the reviewer as, for the entry
 * --llm-review writes (src/report/items.js): the check's title in brackets, its
 * instructions, and the case it is about in parentheses.
 *
 * Composed here rather than by whoever reads that file, for the reason every other
 * user-facing string in this review is: the wording is the linter's, and a reader
 * assembling it from the parts assembles it differently each time. It is the report's
 * own entry body in a different frame - the same collapsed instructions (manualBody) and
 * the same locationLine, artifact label and all - so a question and the settled report
 * name one case in one set of words.
 *
 * The words are the coupling, not the page: past the per-entry display cap the report
 * prints "and N more" where that location line would have been, while the item file
 * carries every case and so asks about every one of them.
 *
 * The report collapses repeats of a check into a single entry with a list of locations;
 * the questions do not. Each case is settled on its own and carries its own verdict, so
 * the locus is what tells two questions of one check apart, and it is the only part of a
 * question quoted from the submission.
 * @param {import("./finding.js").ManualItem} m
 * @param {(x: object) => string} [labelOf]  Artifact label ([XPI]/[SCA]) for the locus.
 * @returns {string}
 */
export function manualQuestion(m, labelOf) {
  const body = `[${m.title}] ${collapseBody(m.instructions)}`.trim();
  // A standard by-hand check names no file and no subject; empty parentheses would say
  // it does.
  const locus = hasLocus(m) ? locationLine(m, labelOf?.(m)) : "";
  return locus ? `${body} (${locus})` : body;
}

/**
 * Count findings by severity.
 *
 * @param {import("./finding.js").Finding[]} findings
 * @returns {{error: number, hold: number, warning: number, info: number}}
 */
function tally(findings) {
  // Keyed off the one severity ordering, so a new band is counted the day it exists
  // rather than silently missing from the tally and the JSON summary.
  const counts = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0]));
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }
  return counts;
}

/**
 * Render the review result in the requested format.
 *
 * @param {ReviewResult} review
 * @param {"text"|"json"} format
 * @returns {string}
 */
export function formatReview(review, format) {
  return format === "json" ? formatJson(review) : formatText(review);
}
