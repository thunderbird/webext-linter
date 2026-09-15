// Renders a finished review (findings + metadata) as either human-readable text
// or JSON. Text goes to stdout so it can be read directly. JSON is
// machine-consumable for CI.
//
// It also renders the two texts that are NOT a finished review: the prompt printed above
// one (llmPromptLines) and the prompt that prepares one (scaPromptLines, the whole output
// of a run in which no review has happened and none can). Both are layout over values
// decided elsewhere, which is why they are here and not in the front-end.
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
// src/checks/escalation.js. Reuse the shared sortKeys/canonicalJson helpers in
// src/util/json.js rather than adding JSON utilities here.

import {
  SEVERITY,
  SEVERITY_ORDER,
  sortFindings,
  countByRule,
  verdictKey,
} from "./finding.js";
import {
  orderReview,
  hasLocus,
  manualBody,
  collapseBody,
  MANUAL_SECTIONS,
} from "./order.js";
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
 * @property {string} [mode]  Review mode ("sca" | "xpi"). In "sca" each finding's
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
 *   review target" names a different one in each mode, and no reader can tell which.
 * @property {string} [scaRoot]  SCA review: the source root the run was given
 *   (--sca-root), resolved.
 * @property {string} [scaSource]  SCA review: the add-on's own code root within that
 *   root, normalised, or "." when the whole root is the source.
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
 * @property {string} [itemsFile]  Path of the machine-readable item file, when one was
 *   written (--llm-review). Named in the Review Details section.
 * @property {import("./finding.js").ManualItem[]} [manualReview]  The manual-review
 *   to-do list, each item tagged with `extended` (it escalated from a check) and
 *   `section` (which of the two extended lists it belongs to). The report splits it
 *   into three sections on those two tags - see src/report/order.js. Text-only;
 *   dropped from JSON.
 * @property {?{intro: string, items: object[]}} [preSweep]  The blind-spot sweep to run
 *   before settling the review: the shared method, then one bare item per check that
 *   authors an instruction for what it cannot detect. ONE request, not one per check.
 *   Carries no finding and no locus - it is the job, not its result. Text-only; dropped
 *   from JSON.
 */

// The titles the report prints over its sections, keyed by the section a sequence item
// carries (src/report/order.js). One definition, because the item file names an item's
// section with the same string the prose prints - and the --llm-review prompt refers to
// both by that name.
//
// `preSweep` is the one title here that names no sequence section: it is not an item of
// the numbered review (it settles nothing and carries no index), but the report, the item
// file and the prompt still have to call it one thing, which is what this map is for.
// It is titled STANDARD because, like the standard manual checks, it is carried by every
// submission rather than raised by one - the pairing is deliberate: the two standard
// sections are the review done on everything, by reading and by hand.
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

/** The prompt text that asks for each section a REVIEWER answers, keyed by the section
 *  name order.js numbers it under. A section named in MANUAL_SECTIONS with no ask here is
 *  a section the prompt cannot put to anyone, so llmPromptLines refuses it rather than
 *  printing one ask fewer than the item file carries entries. */
const MANUAL_ASKS = Object.freeze({
  extendedManual: "extendedManualReview",
  standard: "standardManualReview",
});

/**
 * One numbered step of a prompt: the first paragraph carries the "N. " marker and every
 * paragraph after it is indented to sit beneath it.
 *
 * Both prompts lay their steps out this way, from one function, because a continuation
 * left flush-left reads as a step of its own - and so does the literal example a step
 * carries, which belongs to that step. The numbers are the caller's: it numbers what
 * survived its own filtering, which is why no step may number itself.
 *
 * Authored line breaks inside a paragraph are the layout and wrapText keeps them. `block`
 * lets a caller render ONE paragraph itself, matched by its whole authored text: its lines
 * are printed VERBATIM, however many there are, because they are not prose. Both users need
 * that for the same reason - a command split across lines is a command to reassemble (the
 * SCA prompt's flags), and so is a table of named values (the paths a review hands its
 * build agent).
 * @param {number} n  The step's number, as printed.
 * @param {string} text  The authored step.
 * @param {?{name: string, lines: string[]}} [block]  A paragraph the caller renders.
 * @returns {string[]}
 */
function stepLines(n, text, block = null) {
  const marker = `${n}. `;
  const indent = " ".repeat(marker.length);
  const [first, ...rest] = text.split("\n\n");
  const out = [...wrapText(`${marker}${first}`)];
  for (const paragraph of rest) {
    out.push("");
    if (block && paragraph.trim() === block.name) {
      out.push(...block.lines.map((line) => `${indent}${line}`));
    } else {
      out.push(...wrapText(paragraph, indent));
    }
  }
  return out;
}

/**
 * What a --llm-review prompt ASKS this run's reader for, as the authored ask texts in the
 * order they print - empty when the review has nothing to settle.
 *
 * Only the instructions the report can actually be checked against are asked for, and
 * every one it can: the issues ask needs a finding to verify, and each to-do ask needs an
 * item in its OWN section - a review that happens to have no Extended Manual Review items
 * must not be told to work them. Both tests come from the same place the report's own
 * sections do, so the prompt cannot ask for a section the reader will not find.
 *
 * Exported because the asks decide more than their own lines: the steps close the prompt
 * only when an ask was made (with nothing to settle there is nothing to hand back), so the
 * step that writes the add-on description prints only then - and the pipeline names that
 * file only when it does. One computation, or the path and the step that writes it are
 * decided by two.
 * @param {object} prompt  From registry.llmReviewPrompt().
 * @param {import("./finding.js").Finding[]} findings
 * @param {import("./finding.js").ManualItem[]} manual
 * @param {?{items: object[]}} [preSweep]
 * @param {string[]} [skip]  The parts this run leaves out (PROMPT_SKIPS, src/config.js).
 * @returns {string[]}
 */
export function promptAsks(
  prompt,
  findings,
  manual,
  preSweep = null,
  skip = []
) {
  // The manual sections go together: a run that does not put them to a reviewer must not
  // be asked to work them either, or the reader hunts for entries the item file does not
  // carry.
  const skipped = new Set(skip);
  const asks = [];
  if (findings.length) {
    asks.push(prompt.issues);
  }
  // Listed first among the asks, because it is the first thing done: the sweeps add
  // findings, and everything below settles the review those findings are part of.
  if (preSweep?.items?.length) {
    asks.push(prompt.preSweep);
  }
  const sections = new Set(orderReview([], manual).map((x) => x.section));
  if (sections.has("code")) {
    asks.push(prompt.codeReview);
  }
  // The sections a reviewer answers are asked for in MANUAL_SECTIONS' own order, each
  // through the prompt text that names it: the list that decides which sections a skip
  // withholds from the item file is the list that decides which asks print, so an ask for
  // a section the file omits cannot arise.
  if (!skipped.has("manual")) {
    for (const name of MANUAL_SECTIONS) {
      if (!sections.has(name)) {
        continue;
      }
      const ask = prompt[MANUAL_ASKS[name]];
      if (!ask) {
        throw new Error(
          `no prompt ask for manual section "${name}" (src/report/format.js)`
        );
      }
      asks.push(ask);
    }
  }
  return asks;
}

/**
 * The --llm-review verification prompt, printed above the header so the model that
 * is handed the report reads its instructions before the report itself.
 *
 * Only the instructions the report can actually be checked against are printed, and every
 * one it can: the issues ask needs a finding to verify, and each to-do ask needs an item in
 * its OWN section. One ask per section, because a review that happens to have no Extended
 * Manual Review items must not be told to work them. Both tests come from the same place the
 * report's own sections do - `findings` and the ordered sequence - so the prompt cannot
 * ask for a section the reader will not find. The ordered steps - how the work is done and
 * the verdicts come back - close the prompt whenever any ask was made, and are absent when
 * none was: with nothing to settle there is nothing to hand back.
 *
 * `skip` is what the run was told to leave out: "summary" (--llm-skip-summary) withholds
 * the add-on description steps, "manual" (--llm-skip-manual) the steps that put the manual
 * entries to a reviewer AND the asks for those sections. The surviving steps are
 * renumbered, which is why no step authors its own number. src/report/items.js withholds
 * the same two sections from the item file under the same skip, so the prompt and the file
 * agree about what the reader is being asked to settle.
 *
 * `sca` decides the other marker: a step marked `run: sca` is printed only in a source code
 * review, because the work it asks for - discovering how the add-on is built, so the
 * reviewer can reproduce it - has nothing to read in an XPI review. It carries the PATHS
 * rather than a flag because those steps PRINT them, filling their `{{paths}}` paragraph:
 * the request they hand a sub-agent has to carry the folder to read and the file to write,
 * and a request relayed "and nothing else" cannot have either added to it afterwards. The
 * caller passes what the review resolved, so the prompt and the header name the same paths
 * or neither does.
 * @param {{intro: string, issues: string, preSweep: string, codeReview: string,
 *   extendedManualReview: string, standardManualReview: string, outcomeIntro: string,
 *   outcome: {skip: ?string, run: ?string, text: string}[]}} prompt
 * @param {import("./finding.js").Finding[]} findings
 * @param {import("./finding.js").ManualItem[]} manual
 * @param {?{items: object[]}} [preSweep]
 * @param {string[]} [skip]  The parts this run leaves out (PROMPT_SKIPS, src/config.js).
 * @param {?{root: string, buildFile: string}} [sca]  What a source code review's own steps
 *   name: the source root to read, and the file to write. Null in an XPI review.
 * @returns {string[]}
 */
export function llmPromptLines(
  prompt,
  findings,
  manual,
  preSweep = null,
  skip = [],
  sca = null
) {
  const skipped = new Set(skip);
  const asks = promptAsks(prompt, findings, manual, preSweep, skip);
  const lines = [...section("LLM Prompt"), "", ...wrapText(prompt.intro), ""];
  for (const ask of asks) {
    lines.push(...wrapText(`- ${ask.replace(/\s+/g, " ").trim()}`));
  }
  if (asks.length) {
    lines.push("", ...wrapText(prompt.outcomeIntro));
    const steps = prompt.outcome.filter(
      (step) => !skipped.has(step.skip) && (step.run !== "sca" || sca)
    );
    // The values a step carries rather than names, laid out as the block the reader already
    // knows from Review Details: never wrapped, so a path with a space in it is handed on
    // whole rather than in halves.
    const paths = sca
      ? {
          name: "{{paths}}",
          lines: valueLines([
            ["SCA_ROOT", sca.root],
            ["BUILD_PROCESS", sca.buildFile],
          ]),
        }
      : null;
    steps.forEach((step, i) => {
      // Numbered HERE, over what survived the skips, so the steps a run prints read
      // 1..N with no gaps.
      lines.push("", ...stepLines(i + 1, step.text, paths));
    });
  }
  return lines;
}

/** The values --llm-sca-review hands its reader, in the order the steps use them. Named
 *  here because the prompt's steps name them: the facts are a table the reader looks up,
 *  never a sentence they have to extract a path from. */
const SUBMISSION_VALUES = [
  ["XPI", "xpi"],
  ["SOURCE_ARCHIVE", "source"],
  ["FOLDER", "folder"],
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
 * so a reader takes a path by looking up a name rather than by parsing a sentence. The
 * STEPS are prose, and they name those values - and the ones the reader works out,
 * <SCA_ROOT>, <SCA_SOURCE>, <SCA_EXP_SOURCE> - instead of carrying paths themselves. The
 * FLAGS are the finished command, one flag per line, filled into the step that says to
 * run it.
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
 * @param {{folder: string, xpi: string, source: string}} submission  From scaSubmission().
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
      ...stepLines(i + 1, step.text, { name: "{{flags}}", lines: flags })
    );
  });
  return lines;
}

/**
 * Review Details: what was reviewed, against which schema, and - when --llm-review wrote
 * one - where the machine-readable item file is.
 *
 * The paths are a block of NAMED values (valueLines), the shape the --llm-sca-review
 * prompt uses for its own Submission block. Named, because the --llm-review prompt's steps
 * point at them by name rather than carrying a path through wrapped prose - and named in
 * EVERY run, not only under a review flag, because one section must not read two ways
 * depending on a flag.
 *
 * An SCA review spans TWO artifacts and the reader has to know which is which: the report
 * labels every locus [XPI]/[SCA], and the block names the artifacts behind those labels -
 * the shipped add-on as XPI, whether it was submitted packed or as an unpacked folder, and
 * the [SCA] side as the two values it was given, SCA_ROOT and SCA_SOURCE, rather than as
 * one path composed from them. The source is named as the two values the run was GIVEN,
 * SCA_ROOT and SCA_SOURCE, rather than as the one path they compose: an agent told to read
 * the source root cannot be handed a value it has to split on a colon first.
 *
 * The schema line stays prose beneath the block: nothing looks it up by name.
 * @param {ReviewMeta} meta
 * @returns {string[]}
 */
export function headerLines(meta) {
  // Past tense throughout: the pipeline prints this header AFTER runChecks, so the
  // review is over by the time a reader sees it.
  const values = [["XPI", meta.xpi]];
  if (meta.scaRoot) {
    values.push(["SCA_ROOT", meta.scaRoot], ["SCA_SOURCE", meta.scaSource]);
  }
  // Only --llm-review writes one. It is named here rather than only in the prompt so
  // the section stays the one place that says what this review consists of.
  if (meta.itemsFile) {
    values.push(["REVIEW_ITEMS", meta.itemsFile]);
  }
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
    `schema ${meta.schemaBranch} · Thunderbird ${meta.applicationVersion ?? "?"}` +
      (meta.manifestVersion != null
        ? ` · manifest_version ${meta.manifestVersion}`
        : ""),
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
 * the whole body (`verdictIntros.none`). With findings it is `rejected` (any
 * error) or `feedback` (warnings/info only), glued directly to the FIRST
 * severity heading - one space, no blank line - and printed verbatim (no
 * rewrap), like the findings below it.
 * @param {import("./order.js").OrderedItem[]} items  The findings half of the ordered
 *   sequence (src/report/order.js), which owns the order, the grouping and the numbers.
 * @param {Record<string, string>} [issueHeadings]
 * @param {Record<string, string>} [verdictIntros]
 * @param {(f: import("./finding.js").Finding) => string} [labelOf]  Artifact label
 *   ([XPI]/[SCA]) for a finding's file:line, "" when none (see reviewBodyLines).
 * @param {string} [mode]  Review mode; "sca" appends the label legend footer.
 * @returns {string[]}
 */
function issuesLines(items, issueHeadings, verdictIntros, labelOf, mode) {
  const out = section(SECTION_TITLES.issues);
  const intros = verdictIntros ?? {};
  const issues = items.map((x) => x.target);
  if (issues.length === 0) {
    out.push(intros.none ?? "The automated review did not find any issues.");
    return out;
  }
  // One preamble for the whole section, glued onto the first rendered heading.
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
 * @returns {{section: string, members: object[], shown: object[], withheld: number}[]}
 */
function entriesOf(items) {
  const out = [];
  for (const item of items) {
    const last = out.at(-1);
    if (last && last.key === item.entry && last.section === item.section) {
      last.members.push(item.target);
      if (item.shown) {
        last.shown.push(item.target);
      } else {
        last.withheld++;
      }
      continue;
    }
    out.push({
      key: item.entry,
      section: item.section,
      members: [item.target],
      shown: item.shown ? [item.target] : [],
      withheld: item.shown ? 0 : 1,
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
 * @param {{shown: object[], withheld: number}} entry
 * @param {(x: object) => string} [labelOf]  Artifact label prefix (SCA only).
 * @returns {string[]}
 */
function renderLocusList(entry, labelOf) {
  const lines = [];
  for (const x of entry.shown) {
    if (hasLocus(x)) {
      // A reviewer's answer can be a LIST, and locationLine keeps their lines when the
      // answer is all this case has. Each becomes an item of its own here, which is what
      // they wrote it as - and is a single line for everything else, which is what every
      // other locus is.
      for (const line of locationLine(x, labelOf?.(x)).split("\n")) {
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
 * "file:line - item - hint (note)". Manual review still wraps - see manualLines.
 * @param {number} n  1-based entry number.
 * @param {import("./finding.js").Finding[]} findings  All sharing one message.
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
 * beneath as "- file:line - item", in the same grey as the response. Standalone
 * reminders (no locus) carry no list. Returns [] when there are no items, so an
 * absent section prints nothing.
 * @param {import("./finding.js").ManualItem[]} items
 * @param {string} title  Section heading, e.g. "Extended Manual Review".
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
  out.push(accent("Continue manual review for the following checks:"));
  let n = 0;
  for (const entry of entriesOf(items)) {
    const group = entry.members;
    const body = manualBody(group[0]);
    out.push("");
    // The reviewer-facing instructions (the section's accent, 80-col wrapped).
    out.push(...wrapText(`${++n}) ${body}`).map(accent));
    // The developer-facing response, if any: labelled "Suggested response:" and
    // printed in dim grey, flush-left at column 0 (verbatim, like the Found Issues
    // responses), sitting between the instructions and the locus list so it
    // reads as a ready-to-send block without pulling focus from the blue
    // instructions. Shared across the group, so taken from the first item.
    // The band a confirmed case lands in, above the response so its weight is known
    // before the text is sent. Absent for a check that produces no finding either way.
    const verdict = group[0].verdict;
    if (verdict) {
      out.push(grey(`Suggested verdict: ${verdict}`));
    }
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
  // The method first, its authored paragraphs kept: it is prose to be read, not a list
  // item, and the breaks are how it reads.
  for (const para of sweep.intro.split("\n\n")) {
    out.push("");
    out.push(...wrapText(para.replace(/\s+/g, " ").trim()).map(blue));
  }
  let n = 0;
  for (const entry of sweep.items) {
    out.push("");
    // Laid out exactly like a manual-review entry (manualBody): "N) title: body", with
    // the authored newlines collapsed so the item re-wraps to the report's width instead
    // of keeping the yaml's. The check id and its band are NOT repeated here - the agent
    // reads them as fields of the item file, and the title already says which check this
    // is in the words the rest of the report uses.
    const body = entry.instruction.replace(/\s+/g, " ").trim();
    out.push(...wrapText(`${++n}) ${entry.title}: ${body}`).map(blue));
    // The band and the wording a find would carry, laid out exactly as a manual-review
    // entry lays them out: this section asks the same kind of question, so it should
    // answer the same question a reviewer asks of one - if I find this, what happens,
    // and what does the developer read? An addition is worded from this same text.
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
 * section order (code review, manual review, then the always-shown checklist).
 *
 * Also printed on its own by a --llm-review run, which has no report body for it to close:
 * without it that run's output would not say whether the add-on is ready to sign off or
 * still has work waiting.
 * @param {import("./finding.js").Finding[]} issues
 * @param {import("./finding.js").ManualItem[]} [manual]
 * @returns {string[]}
 */
export function summaryLines(issues, manual = [], preSweep = null) {
  const out = section("Summary");
  out.push("");
  out.push(...tallyLines(issues, bucketCounts(manual), preSweep));
  return out;
}

/**
 * The counts, on three lines: what the review FOUND, then what it raised about this
 * submission in particular, then what it carries for every submission. One run-on line
 * read as a first number followed by noise, and the three groups are three different
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
  // The manual-review to-do list is human-only, not
  // machine-verifiable, so they are dropped from JSON (ATN consumes this for
  // auto-verification). findings are already issues only. The pre-sweep list goes for
  // the same reason and a sharper one: it is an instruction TO A READER, not a statement
  // about the add-on, so it says nothing this document is for. What a sweep finds does
  // reach here - as a finding of the check that owns it, indistinguishable from one the
  // scan made itself, which is the point.
  const { manualReview: _omitted, preSweep: _sweeps, ...meta } = review.meta;
  const issues = review.findings;
  // `data` (template-resolution input, baked into `message`) and `listItem` (a
  // text-layout flag) are internal, so they are dropped from the machine output.
  // Consumed by tooling rather than a terminal, but a consumer may print it, so the
  // submission-derived fields carry no more than the text report shows.
  const publicFindings = sortFindings(issues).map(
    ({ data: _d, listItem: _li, note, ...f }) => ({
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
 * @param {string} [mode]
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
 * so the JSON report is unchanged.
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
 * The question ONE manual-review item is put to the reviewer as, for the item file
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
 * @returns {{error: number, warning: number, info: number}}
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
