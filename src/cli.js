// CLI front-end for the review tool: parse argv, validate, drive the pipeline,
// and route the report + exit code. The pipeline core lives in pipeline.js (the
// test harness calls runPipeline there directly).
//
// Review runs directly as `node verify.js <xpi|folder>`, forwarding to
// main(argv) below. `npm run help` is an alias for `verify.js --help`.
//
// Belongs here: the front-end only - the OPTIONS table, usage/help text, argv
// parse and flag validation, the values -> PipelineOpts mapping, stream/capture
// routing, exit codes, and the COMMAND a prompt hands back: which flags a
// prepared review is to be run with is a fact about this run's own arguments,
// known here and nowhere else, so it is composed here and laid out there.
//
// Does NOT belong here: running the stages (opts -> Review is pipeline.js
// runPipeline); report layout and rendering (src/report/format.js formatReview
// and src/report/responses.js); the check ids and registry text
// (src/checks/registry.js).

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { runPipeline } from "./pipeline.js";
import { loadRegistry } from "./checks/registry.js";
import { scaSubmission } from "./addon/submission.js";
import { hasParentSegment, scaRootRelative } from "./addon/load.js";
import { hasErrors } from "./report/finding.js";
import { formatReview, scaPromptLines } from "./report/format.js";
import {
  DEFAULT_CACHE,
  EXPERIMENTS_CACHE,
  LIBRARY_HASHES_CACHE,
  CDN_LOOKUP_CACHE,
  PROMPT_SKIPS,
} from "./config.js";
import {
  info,
  report,
  setVerbose,
  setProgress,
  setFeed,
  setQuiet,
  setCapture,
  getCapture,
} from "./util/log.js";
import { setColor, stripColor, red } from "./util/color.js";
import { wrapText } from "./util/text.js";

/** @typedef {import("./pipeline.js").PipelineOpts} PipelineOpts */

// Package identity for the run banner (read once at load).
const { name: PKG_NAME, version: PKG_VERSION } = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
);

/**
 * The two-line run banner in npm's style: a `> name@version review` line, then
 * the `node verify.js <args>` command, so a direct run opens with the same
 * identifying lines npm itself would print for the same command.
 * @param {string[]} [argv]  The args this run was invoked with, echoed after
 *   `node verify.js` (as npm does) so the banner states what ran.
 * @returns {string}
 */
export function runBanner(argv = []) {
  const args = argv.length ? ` ${argv.join(" ")}` : "";
  return `> ${PKG_NAME}@${PKG_VERSION} review\n> node verify.js${args}`;
}

/**
 * True when npm already printed its own run header for this process - i.e. we
 * were launched by `npm run verify` (whose script command invokes verify.js),
 * so runBanner() would only duplicate it. A direct `node verify.js` run, or a
 * launch under an unrelated npm script (e.g. `npm test`), prints the banner.
 * @returns {boolean}
 */
function npmPrintedRunHeader() {
  return (process.env.npm_lifecycle_script ?? "").includes("verify.js");
}

/**
 * Emit the run banner once, at the top of a direct run, unless npm already
 * printed an equivalent header (npmPrintedRunHeader). Goes through the feed
 * (info), so it is suppressed in JSON mode (quiet) and captured into a text
 * --report-out file. The leading and trailing blank lines match npm's spacing.
 * @param {string[]} argv  The args this run was invoked with.
 */
function emitBanner(argv) {
  if (npmPrintedRunHeader()) {
    return;
  }
  info(`\n${runBanner(argv)}\n`);
}

/**
 * A parse-error message with node:util's misleading positional-argument hint
 * removed. parseArgs appends a "To specify a positional argument starting with
 * a '-' ..." sentence to unknown-option errors. It does not apply here - the
 * only positional is the add-on path, and a stray dashed argument is a typo.
 * @param {unknown} err
 * @returns {string}
 */
function cleanParseError(err) {
  return String(err?.message ?? err).replace(
    / To specify a positional argument starting with a '-'[\s\S]*$/,
    ""
  );
}

// Two-column help layout: the flag in a fixed left column, its description
// wrapped to 80 columns, continuations hanging under the description column.
const HELP_COL = 32;

/**
 * Format one option row for the help screen: the flag left-aligned in the fixed
 * column, its description wrapped to 80 columns with continuation lines hanging
 * under the description.
 * @param {string} flag  The flag and its argument, e.g. "--cache-schema-dir <dir>".
 * @param {string} desc  The description prose.
 * @returns {string}
 */
function optionLine(flag, desc) {
  const lines = wrapText(desc, " ".repeat(HELP_COL), 80);
  const lead = `  ${flag}`;
  if (lead.length >= HELP_COL) {
    // Flag wider than the column: description hangs on the next lines.
    return [lead, ...lines].join("\n");
  }
  lines[0] = lead.padEnd(HELP_COL) + lines[0].slice(HELP_COL);
  return lines.join("\n");
}

/**
 * The central help screen: a one-line command summary and the shared options,
 * printed by `npm run help` and as the --help / usage screen (see main).
 * @returns {string}
 */
function helpText(checkIds) {
  const cache = [
    [
      "--cache-clear",
      "Delete every cache directory before the review, so all fetched sources (schema, library-hash DB, CDN lookups, allowed-experiments) are re-downloaded from scratch - as on a first run.",
    ],
    [
      "--cache-schema-dir <dir>",
      `Where the downloaded schema zips are cached (default: ${DEFAULT_CACHE}).`,
    ],
    [
      "--cache-hash-db-dir <dir>",
      `Where the fetched library-hash database is cached (default: ${LIBRARY_HASHES_CACHE}).`,
    ],
    [
      "--cache-cdn-lookup-dir <dir>",
      `Where the CDN hash-lookup results are cached - best-effort, backing the optional --cdn-lib-lookup (default: ${CDN_LOOKUP_CACHE}).`,
    ],
    [
      "--cache-experiments-dir <dir>",
      `Where the fetched allowed-experiments zip is cached (default: ${EXPERIMENTS_CACHE}).`,
    ],
  ];

  const checks = [
    [
      "--checks-only <ids>",
      `Only run these checks (comma-separated). Available: ${checkIds.join(", ")}.`,
    ],
    ["--checks-skip <ids>", "Skip these checks (comma-separated)."],
  ];

  const report = [
    ["--report-format <text|json>", "Report output format (default: text)."],
    [
      "--report-out <file>",
      "Write the report to a file in addition to stdout. Refused with any --llm-* flag: no run of that round trip saves its output.",
    ],
  ];

  // What an LLM agent runs, in the order it runs: --llm-sca-review prepares a source code
  // review (and is over before one starts), then --llm-review asks - leaving out whatever
  // its two --llm-skip-* flags name, given to either - and --llm-verdict applies the
  // answers. Their own
  // section, because none is a report format: the first two replace the report with a
  // prompt, the last rebuilds it from settled verdicts.
  const llm = [
    [
      "--llm-review",
      "Print a verification prompt and write the review as a JSON item array to a temp file, instead of the report. The prompt explains how to settle the items and pass them back with --llm-verdict. Refused with --report-format json.",
    ],
    [
      "--llm-skip-summary",
      "With --llm-review or --llm-sca-review: leave out the add-on description. The prompt no longer asks for one and names no file for it; everything else is unchanged.",
    ],
    [
      "--llm-skip-manual",
      "With --llm-review or --llm-sca-review: leave out the manual review items. The prompt does not put them to a reviewer and the item file does not carry them - they stay in the report, for the reviewer to work through later. Given with --llm-skip-summary, the review verifies only the add-on's code.",
    ],
    [
      "--llm-sca-review <folder>",
      "Print the prompt for preparing a source code review of a submission folder - one built .xpi and one archive of the source it was built from - and exit without reviewing anything. The prompt says how to reach the source and hands back this command with --llm-review in place of this flag, for the reader to run with the --sca-* arguments they worked out. Refused beside any --sca-* flag, which is what it exists to produce.",
    ],
    [
      "--llm-verdict <file>",
      "Apply settled verdicts and print the settled report, from a JSON file written as the --llm-review prompt describes. Normally run by the agent that settled the review rather than by a person.",
    ],
  ];

  const sca = [
    [
      "--sca-root <folder>",
      "The extracted source root (holds package.json/lock) - a folder, not a packed archive: this tool unpacks the submitted .xpi and nothing else, so extract the source yourself. Switches to SCA mode - the readable source is reviewed for code defects, its declared dependencies are audited for popularity + vulnerabilities, and the built XPI (the positional path) is the shipped artifact: authoritative for the manifest, experiments, file-completeness (bundled/web-accessible/unused). Always reviewed as SCA; when the XPI turns out to BE the submitted source, sca-not-required (info) says an XPI-only submission would have been enough.",
    ],
    [
      "--sca-source <path>",
      "The add-on code root, as a path relative to --sca-root (e.g. src or addon). Optional; defaults to . (the whole --sca-root reviewed as the source - a flat layout where manifest.json sits at the root). Needs --sca-root.",
    ],
    [
      "--sca-exp-source <path>",
      "The Experiment implementation folder, as a path relative to --sca-root - anywhere within it (e.g. addon/experiment-api, or a sibling of the source like experiment). Its files are privileged, non-WebExtension code, so they are excluded from the WebExtension API/permission/eval checks (which would otherwise false-positive on Services/ChromeUtils). Needs --sca-root; REQUIRED when --allow-experiments is used in SCA mode.",
    ],
  ];

  const other = [
    [
      "--allow-experiments",
      "Accept add-ons that use Experiment APIs (off by default).",
    ],
    [
      "--cdn-lib-lookup <true|false>",
      "Identify an unrecognized bundled library (minified or readable) by a jsDelivr content-hash lookup (default: true). Results are cached; an offline run simply finds no match.",
    ],
    [
      "--eslint",
      "Run the ESLint code-sanity checks on authored JS (off by default).",
    ],
    ["--help", "Show this help."],
    ["--verbose", "Verbose logging."],
  ];

  const commands = [
    [
      "node verify.js <xpi|folder> [options]",
      "verify an .xpi or source folder against the Thunderbird schema and review policies",
    ],
  ];

  return [
    "webext-linter - verify Thunderbird WebExtensions",
    "",
    "Usage:",
    ...commands.map(([cmd, desc]) => optionLine(cmd, desc)),
    "",
    "Cache:",
    ...cache.map(([flag, desc]) => optionLine(flag, desc)),
    "",
    "Check selection:",
    ...checks.map(([flag, desc]) => optionLine(flag, desc)),
    "",
    "Report output:",
    ...report.map(([flag, desc]) => optionLine(flag, desc)),
    "",
    "LLM review:",
    ...llm.map(([flag, desc]) => optionLine(flag, desc)),
    "",
    "Source code archive (SCA):",
    ...sca.map(([flag, desc]) => optionLine(flag, desc)),
    "",
    "Other:",
    ...other.map(([flag, desc]) => optionLine(flag, desc)),
    "",
    "Exit codes: 0 = no errors, 1 = one or more error-severity findings,",
    "            2 = tool failure.",
    "",
  ].join("\n");
}

const OPTIONS = {
  "cache-clear": { type: "boolean" },
  "cache-schema-dir": { type: "string" },
  "cache-hash-db-dir": { type: "string" },
  "cache-cdn-lookup-dir": { type: "string" },
  "cache-experiments-dir": { type: "string" },
  "cdn-lib-lookup": { type: "string" },
  "checks-only": { type: "string" },
  "checks-skip": { type: "string" },
  eslint: { type: "boolean" },
  "allow-experiments": { type: "boolean" },
  "sca-root": { type: "string" },
  "sca-source": { type: "string" },
  "sca-exp-source": { type: "string" },
  "report-format": { type: "string" },
  "report-out": { type: "string" },
  "llm-sca-review": { type: "string" },
  "llm-review": { type: "boolean" },
  "llm-skip-summary": { type: "boolean" },
  "llm-skip-manual": { type: "boolean" },
  "llm-verdict": { type: "string" },
  verbose: { type: "boolean" },
  help: { type: "boolean" },
};

/**
 * What a --llm-review run was told to leave out, as the registry names it: "summary" for
 * --llm-skip-summary, "manual" for --llm-skip-manual. Read HERE and nowhere else, so
 * main()'s guards and pipelineOptsFromValues cannot drift apart about what was given -
 * they run on different paths (pipelineOptsFromArgv runs none of main's guards).
 * @param {Record<string, string|boolean>} values
 * @returns {string[]}
 */
function reviewSkips(values) {
  return PROMPT_SKIPS.filter((skip) => values[`llm-skip-${skip}`]);
}

/** The --sca-* flags, which --llm-sca-review exists to work out and so refuses to be given. */
const SCA_FLAGS = ["sca-root", "sca-source", "sca-exp-source"];

/**
 * One argument as it must be TYPED: quoted when it carries whitespace, because these lines
 * are a command their reader runs, and a submission folder is as likely to be "/reviews/my
 * add-on" as not. Single quotes, the shell's literal form, with the one escape that form
 * needs.
 * @param {string} value
 * @returns {string}
 */
function shellArg(value) {
  return /\s/.test(value) ? `'${value.replaceAll("'", "'\\''")}'` : value;
}

/**
 * What --llm-sca-review hands its reader: the flags the REVIEW is run with, one finished
 * line each, and whether that review allows Experiments.
 *
 * The whole command, not a template to assemble: the flags are known here, so printing
 * them saves its reader the one step where a flag can go missing. This run's own flags
 * first - with --llm-sca-review replaced by --llm-review and the add-on the submission
 * folder holds - then the three the reader works out. Anything dropped or invented here
 * reviews a different submission than the reviewer asked about, --allow-experiments above
 * all, which is also why --sca-exp-source is named only when Experiments are allowed:
 * nothing reads it otherwise.
 *
 * Composed from the PARSED values against OPTIONS, which is what knows a flag from its
 * value. Reading argv again instead means guessing that pairing from the token shapes, and
 * the guess lives in whichever file prints the command - so both spellings of every flag
 * collapse here, once, and the renderer lays out what it is handed.
 *
 * A --llm-skip-* is carried like any other flag: it names part of the prompt the prepared
 * review will print, which is the run this command starts. A flag given no value never
 * reaches here - main() refuses one before any branch - so the truth test below only skips
 * the flags this run was not given.
 * --llm-review, --llm-verdict and the --sca-* flags cannot appear - --llm-sca-review
 * refuses to be given them - and neither can --help, which returns above.
 * @param {Record<string, string|boolean>} values
 * @param {string} xpi  The built add-on's path, which the review takes as its positional.
 * @returns {{flags: string[], experiments: boolean}}
 */
function reviewCommand(values, xpi) {
  const flags = [`--llm-review ${shellArg(xpi)}`];
  for (const [name, { type }] of Object.entries(OPTIONS)) {
    if (name === "llm-sca-review" || !values[name]) {
      continue;
    }
    flags.push(
      type === "string" ? `--${name} ${shellArg(values[name])}` : `--${name}`
    );
  }
  flags.push("--sca-root <SCA_ROOT>", "--sca-source <SCA_SOURCE>");
  const experiments = Boolean(values["allow-experiments"]);
  if (experiments) {
    flags.push("--sca-exp-source <SCA_EXP_SOURCE>");
  }
  return { flags, experiments };
}

/**
 * A list as prose: "a", "a and b", "a, b and c". Joining with " and " throughout reads as
 * a chain rather than a list once there are three.
 * @param {string[]} items
 * @returns {string}
 */
function listOf(items) {
  return items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * Whether `p` points at a folder. Resolved first, because that is the path the loader
 * will open: `existsSync("x.zip/")` is false while `path.resolve` drops the slash, so
 * asking about the raw string answers a different question than the one that matters.
 * Anything unreadable is "no" - the caller says what it wanted, and no stat escapes
 * main() to print a stack where a usage line belongs.
 * @param {string} p
 * @returns {boolean}
 */
function pointsAtFolder(p) {
  try {
    return fs.statSync(path.resolve(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * What is wrong with a value that must name a folder, as the message saying so - or null
 * when nothing is. Two questions, asked of every such flag (that a value was given at all
 * is main()'s, asked of every flag that takes one):
 *
 * Does it stay INSIDE the tree it names? A ".." segment names a folder by the way out of
 * another, which is a value someone will misread whether or not it lands back inside;
 * hasParentSegment is the same test the loader applies to every value it resolves, so the
 * two cannot part company. A flag that names a folder INSIDE --sca-root (`inRoot`) answers
 * the same question about an ABSOLUTE path: it names a folder on the reviewing machine,
 * which can be anywhere, so what it names is not part of the submission and cannot be
 * shown to be.
 *
 * Does it point at a FOLDER? Asked of the resolved path, so a trailing slash cannot answer
 * it differently. A file, a missing path and an unreadable one are all "no".
 * @param {string} flag  The flag's name, for the message.
 * @param {string} value  The value as it was given.
 * @param {string} base  What the value is relative to: --sca-root for a flag that names a
 *   folder inside it, and the value's own path otherwise.
 * @param {boolean} [inRoot]  Whether the flag names a folder inside --sca-root, which an
 *   absolute path cannot be written as.
 * @returns {?{text: string, escape: boolean}}  `escape` marks the ".." refusal, which says
 *   what to do on its own - the others are worth telling what the folder is FOR.
 */
function folderProblem(flag, value, base, inRoot = false) {
  if (inRoot && path.isAbsolute(value)) {
    return {
      text:
        `--${flag} names a folder inside --sca-root, written relative to it: ` +
        `"${value}" is an absolute path. Name it relative to --sca-root.`,
      escape: true,
    };
  }
  if (hasParentSegment(value)) {
    return {
      text:
        `--${flag} names a folder, never a way out of one: "${value}" carries a ".." ` +
        "segment. Name the folder itself.",
      escape: true,
    };
  }
  // Resolved by the LOADER's own function for a flag that names a folder inside
  // --sca-root: the two refusals above are the two shapes it throws on, so by here it
  // answers rather than throws, and the folder asked about is the folder the review reads.
  const rel = inRoot ? scaRootRelative(value, base, `--${flag}`) : null;
  const full = inRoot ? (rel ? path.join(base, rel) : base) : value;
  if (!pointsAtFolder(full)) {
    return {
      text:
        `--${flag} must point at a folder: "${value}" does not (looked in ` +
        `"${path.resolve(full)}").`,
      escape: false,
    };
  }
  return null;
}

/**
 * --report-out saves a carbon copy of stdout: the captured narration and the report, if
 * one was printed. Color codes are stripped so the saved file is plain even when the
 * screen was colored.
 *
 * Only a run that prints a REPORT reaches this: the flag is refused beside every --llm-*
 * flag, and those are the runs whose output is a prompt.
 * @param {Record<string, string|boolean>} values
 * @param {string} [rendered]  The report, when one was printed.
 * @returns {void}
 */
function writeReportOut(values, rendered = "") {
  const reportOut = values["report-out"];
  if (!reportOut) {
    return;
  }
  const copy = stripColor(getCapture() + (rendered ? `${rendered}\n` : ""));
  fs.writeFileSync(path.resolve(reportOut), copy);
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} process exit code
 */
export async function main(argv) {
  // The registry is read and asserted FIRST, before the command line is even parsed. It is
  // this tool's own file, identical on every run, and nothing it could be asked to do means
  // anything while it is broken - not a review, not --help, not a usage error, which prints
  // the check ids the registry names. One load, one answer, and no path that reaches for it
  // before it has been judged.
  let registry;
  try {
    registry = loadRegistry();
  } catch (err) {
    process.stderr.write(`${err.message}\nverify failed\n`);
    return 2;
  }
  const checkIds = registry.checkIds();
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
    });
  } catch (err) {
    emitBanner(argv);
    process.stderr.write(`${cleanParseError(err)}\n\n${helpText(checkIds)}`);
    return 2;
  }
  const { values, positionals } = parsed;

  // Output routing by format. Everything the tool narrates (the what-is-going-on
  // feed) is standard output, alongside the report - only real tool errors go to
  // stderr. JSON is a machine contract: quiet silences the feed so stdout
  // carries only the document. A text --report-out records the feed so the file
  // is a carbon copy of the screen.
  const format = values["report-format"] || "text";
  // Checked HERE, before a single line below acts on it: every setter in this block
  // branches on the format, and so does every branch that prints - one of which used to
  // print nothing at all for an unknown value and exit 0. One question, asked once, at
  // the point the value enters.
  if (format !== "text" && format !== "json") {
    emitBanner(argv);
    process.stderr.write(
      `Invalid --report-format "${format}" (expected text or json).\n`
    );
    return 2;
  }
  setQuiet(format === "json");
  setVerbose(values.verbose);
  setProgress(format === "text");
  // A review flag hands the report to a model and --llm-verdict produces the settled
  // report a reviewer sends on. Either way the output IS the document, so the record of
  // how it was produced - the Setup and Activity sections - is noise in it. The report's
  // own header and prompt are not feed and still print.
  setFeed(!values["llm-review"] && !values["llm-verdict"]);
  setCapture(format === "text" && Boolean(values["report-out"]));
  // Color only on an interactive text screen. Piped/redirected runs and JSON
  // stay plain, and the --report-out copy is stripped below either way.
  setColor(format === "text" && Boolean(process.stdout.isTTY));

  // Open every direct run with the npm-style banner (suppressed for npm runs,
  // which print their own, and for JSON via quiet). Emitted before the branches
  // below so --help and validation errors all carry it too.
  emitBanner(argv);

  // A flag given with no value names something and says nothing, so it is refused before
  // any branch reads one. Asked HERE, once, for every option that takes a value: what a
  // value MEANS is each reader's question - a report format is checked where the format is
  // read, a folder where the folder is opened - but whether one was given at all is the
  // parser's, and a run that returns early must not be able to skip it. parseArgs hands
  // "--flag=" down as "", which every reader below tests for truth and so reads as "not
  // given": a named cache silently became the default one, a named verdict file printed an
  // unsettled report, and a named format fell back to text.
  if (!values.help) {
    const empty = Object.entries(OPTIONS).find(
      ([name, opt]) =>
        opt.type === "string" &&
        values[name] !== undefined &&
        !values[name].trim()
    );
    if (empty) {
      process.stderr.write(
        `--${empty[0]} needs a value, and none was given.\n`
      );
      return 2;
    }
  }

  // A bad --checks-only/--checks-skip id is a bad command line whatever the run does with
  // it, so it is answered before any branch below - including the two that print a prompt.
  // --llm-sca-review hands its reader a command built from these very flags: an id nobody
  // can run would travel into it, and the review it starts would exit 2 on a line the
  // prompt told them to run.
  const badCheck =
    !values.help &&
    unknownId(
      [
        ...(splitList(values["checks-only"]) ?? []),
        ...(splitList(values["checks-skip"]) ?? []),
      ],
      checkIds
    );
  if (badCheck) {
    process.stderr.write(
      `Unknown check "${badCheck}" (--checks-only/--checks-skip). Available: ${checkIds.join(", ")}.\n`
    );
    return 2;
  }

  // --report-out saves a copy of the REPORT, and no run of the --llm-* round trip is one to
  // save: the first two print a prompt, and the last prints the settled report for the
  // agent to hand back in its own answer. One rule for all of them, so there is nothing to
  // work out per flag - and no saved prompt for the command it hands back to overwrite.
  const llmFlags = Object.keys(OPTIONS).filter(
    (name) => name.startsWith("llm-") && values[name] !== undefined
  );
  if (!values.help && values["report-out"] && llmFlags.length) {
    process.stderr.write(
      `--report-out cannot be given with ${listOf(llmFlags.map((f) => `--${f}`))}: ` +
        "no run of the --llm-* round trip saves its output.\n"
    );
    return 2;
  }

  // A skip names part of the --llm-review prompt to leave out, so it says nothing without a
  // review to cut down. --llm-sca-review takes them too: it prepares a review, and hands
  // them back in the command it prints. Refused FIRST, so every guard below can assume a
  // skip implies one of the two.
  const skips = reviewSkips(values);
  if (
    !values.help &&
    skips.length &&
    !values["llm-review"] &&
    values["llm-sca-review"] === undefined
  ) {
    const many = skips.length > 1;
    process.stderr.write(
      `${listOf(skips.map((s) => `--llm-skip-${s}`))} ${many ? "name parts" : "names part"} ` +
        `of the --llm-review prompt to leave out, so ${many ? "they need" : "it needs"} ` +
        "--llm-review, or --llm-sca-review to hand to the review it prepares: a run that " +
        "prints its report has no prompt to cut down.\n"
    );
    return 2;
  }

  // --llm-sca-review prepares a review rather than running one, so it shares nothing with
  // the flags below and is settled here, in full, before any of them are read.
  if (!values.help && values["llm-sca-review"] !== undefined) {
    const given = SCA_FLAGS.filter((f) => values[f]);
    if (given.length) {
      process.stderr.write(
        `--llm-sca-review works out ${listOf(given.map((f) => `--${f}`))} for you, ` +
          "so it cannot be given them. Drop them, or run --llm-review with the ones you " +
          "already have.\n"
      );
      return 2;
    }
    if (values["llm-review"] || values["llm-verdict"]) {
      process.stderr.write(
        "--llm-sca-review comes BEFORE a review: it prints how to start one and runs " +
          "none, so it cannot be combined with the flags that run or settle one.\n"
      );
      return 2;
    }
    if (format === "json") {
      process.stderr.write(
        "--llm-sca-review is text only: it prints a prompt and no report, which is not " +
          "what --report-format json produces.\n"
      );
      return 2;
    }
    if (positionals.length) {
      process.stderr.write(
        `--llm-sca-review names the submission folder, so "${positionals[0]}" is one ` +
          "add-on too many. The review it prepares takes the add-on from that folder.\n"
      );
      return 2;
    }
    // The same two questions every folder flag is asked - a ".." segment names a folder by
    // the way out of another, and the folder has to be there. That a value was given at all
    // is settled far above, for every flag that takes one.
    const problem = folderProblem(
      "llm-sca-review",
      values["llm-sca-review"],
      values["llm-sca-review"]
    );
    if (problem) {
      const what = problem.escape
        ? ""
        : " It is the submission folder - the one holding the built .xpi and the archive " +
          "of its source.";
      process.stderr.write(`${problem.text}${what}\n`);
      return 2;
    }
    let submission;
    try {
      submission = scaSubmission(values["llm-sca-review"]);
    } catch (err) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    // The prompt IS the output: no review has run, and none can until its reader answers
    // it. Printed as the report is, and to the screen only - --report-out saves a report,
    // and is refused above beside this flag.
    for (const line of scaPromptLines(
      registry.llmScaReviewPrompt(),
      submission,
      reviewCommand(values, submission.xpi)
    )) {
      report(line);
    }
    report("");
    return 0;
  }

  if (values.help || positionals.length === 0) {
    process.stdout.write(helpText(checkIds));
    return values.help ? 0 : 2;
  }

  // ONE add-on per run. A second positional was silently ignored, which is how an
  // unquoted path with a space in it ("/my sub/a.xpi") reviewed "/my" and said nothing
  // about the rest. Anything that is not a flag and is not the add-on is a mistake.
  if (positionals.length > 1) {
    process.stderr.write(
      `Only one add-on can be reviewed at a time, and ${positionals.length} were given: ` +
        `${positionals.map((p) => `"${p}"`).join(", ")}. If the path contains spaces, ` +
        "quote it.\n"
    );
    return 2;
  }

  // A review flag's whole output is a prompt and an item file. JSON is the machine
  // contract for ATN, which wants neither, and asking for both leaves nothing coherent to
  // print - so say so rather than silently favouring one.
  if (values["llm-review"] && format === "json") {
    process.stderr.write(
      "--llm-review is text only: it prints a prompt and writes an item file, " +
        "which is not what --report-format json produces.\n"
    );
    return 2;
  }

  // The two halves of one round trip, one run each: a review flag asks the questions,
  // --llm-verdict applies the answers. Together they would print a prompt asking for
  // verdicts on a report that already has them, so the answer file would be written
  // against a review nobody ran. Refuse rather than pick one.
  if (values["llm-review"] && values["llm-verdict"]) {
    process.stderr.write(
      "--llm-review and --llm-verdict are the two halves of one round trip and cannot " +
        "be used together: run --llm-review first, then --llm-verdict with the answers.\n"
    );
    return 2;
  }

  // --sca-root is the SCA-mode switch. --sca-source and --sca-exp-source name locations
  // INSIDE it, so they are meaningless on their own. --sca-root alone is fine:
  // --sca-source defaults to "." (the whole root reviewed as the source).
  if (
    (values["sca-source"] || values["sca-exp-source"]) &&
    !values["sca-root"]
  ) {
    process.stderr.write(
      "--sca-source and --sca-exp-source require --sca-root (SCA mode).\n"
    );
    return 2;
  }

  // Every --sca-* flag names a FOLDER that is there. The root is the extracted source -
  // this tool unpacks the submitted .xpi and nothing else, so extracting is the reviewer's,
  // and then every format works because tar handles what we do not - and the other two name
  // directories inside it. Asked in root-first order, so the root's own validity is settled
  // before anything is looked up inside it.
  //
  // Asked here rather than left to the loader because only one of the three failed loudly:
  // a --sca-exp-source that names nothing was a WARNING, and the review then read the
  // Experiment's privileged code as WebExtension code - the thing that flag exists to
  // prevent - on a typo.
  for (const flag of SCA_FLAGS) {
    const value = values[flag];
    if (value === undefined) {
      continue;
    }
    // --sca-root stands on its own; the other two name folders INSIDE it, and the path
    // they name is resolved BY THE LOADER'S OWN function - so the folder asked about here
    // is the folder the review goes on to read, rather than a second spelling of it.
    // scaRootRelative refuses the same two shapes folderProblem does (an absolute path, a
    // ".." segment), which is why it is safe to call only once those are answered.
    const inRoot = flag !== "sca-root";
    const problem = folderProblem(
      flag,
      value,
      values["sca-root"] ?? ".",
      inRoot
    );
    if (problem) {
      const what =
        flag === "sca-root" && !problem.escape
          ? " This tool unpacks the submitted .xpi and nothing else - extract the source " +
            "archive and point --sca-root at the folder it produced."
          : "";
      process.stderr.write(`${problem.text}${what}\n`);
      return 2;
    }
  }

  // In SCA mode there is no manifest trace to separate Experiment code from
  // WebExtension code (the readable source is reviewed whole), so allowing
  // Experiments REQUIRES naming their folder via --sca-exp-source. Without it the
  // privileged Experiment code would be reviewed as WebExtension code and flood the
  // report with false positives.
  if (
    values["sca-root"] &&
    values["allow-experiments"] &&
    !values["sca-exp-source"]
  ) {
    process.stderr.write(
      "--sca-exp-source is required with --allow-experiments in source code " +
        "archive (SCA) mode (it locates the Experiment code so it is not reviewed " +
        "as WebExtension code).\n"
    );
    return 2;
  }

  let result;
  try {
    // Reading the options can fail the same way the review can - a bad option value
    // is a bad config, not a bad add-on - so it is inside the catch below and reported
    // like one, rather than as a stack trace from verify.js's last-resort handler.
    const opts = pipelineOptsFromValues(values);
    // --cache-clear: wipe every cache dir up front so the resolvers re-fetch each
    // source from scratch during this review, exactly as on a first run. Lists every
    // cache dir opt - a new cache added to pipelineOptsFromValues must be added here
    // too, or --cache-clear would silently skip it.
    if (values["cache-clear"]) {
      clearCaches([
        opts.schemaCache,
        opts.libraryHashesCache,
        opts.cdnLookupCache,
        opts.experimentsCache,
      ]);
    }
    result = await runPipeline({
      addonPath: positionals[0],
      ...opts,
      registry,
    });
  } catch (err) {
    // A pipeline throw is a tool failure the review could not run through (an
    // unreachable/unusable schema, a bad review config, an unreadable add-on): state
    // it plainly and exit 2, distinct from a completed review that found errors.
    process.stderr.write(`${err.message}\n${red("verify failed")}\n`);
    return 2;
  }

  // The full report comes from the report layer: formatReview assembles the body, the advisory
  // review summaries (text only), and the verdict tally LAST, in the shipped order. The CLI just
  // writes it.
  //
  // Except under --llm-review, which produced the item file INSTEAD: the prompt tells its
  // reader to work from that array, and printing the same review as prose alongside it
  // would invite them to settle the report they can see rather than the items they can
  // address. The settled report comes from the --llm-verdict run that follows.
  const rendered = result.meta.itemsFile ? "" : formatReview(result, format);
  if (rendered) {
    process.stdout.write(rendered + "\n");
  }

  writeReportOut(values, rendered);

  return hasErrors(result.findings) ? 1 : 0;
}

/**
 * Delete cache directories so the next review re-fetches every source from
 * scratch (--cache-clear). `force:true` makes an already-absent dir a no-op.
 * @param {string[]} dirs
 * @returns {void}
 */
function clearCaches(dirs) {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Map parsed CLI `values` (from parseArgs with OPTIONS) to runPipeline opts.
 * Shared by main() and the test harness so both honor the real flag names.
 * Does not include `action`/`addonPath` (those come from the command/path).
 * @param {Record<string, string|boolean|string[]>} values
 * @returns {Partial<PipelineOpts>}
 */
function pipelineOptsFromValues(values) {
  return {
    schemaCache: values["cache-schema-dir"] || DEFAULT_CACHE,
    libraryHashesCache: values["cache-hash-db-dir"] || LIBRARY_HASHES_CACHE,
    cdnLookupCache: values["cache-cdn-lookup-dir"] || CDN_LOOKUP_CACHE,
    experimentsCache: values["cache-experiments-dir"] || EXPERIMENTS_CACHE,
    // --cdn-lib-lookup true|false (default true); only an explicit "false" disables.
    cdnLookup: values["cdn-lib-lookup"] !== "false",
    checksOnly: splitList(values["checks-only"]),
    checksSkip: splitList(values["checks-skip"]),
    eslint: values.eslint,
    allowExperiments: values["allow-experiments"],
    scaRoot: values["sca-root"],
    scaSource: values["sca-source"],
    scaExpSource: values["sca-exp-source"],
    llmReview: Boolean(values["llm-review"]),
    llmSkip: reviewSkips(values),
    llmVerdict: values["llm-verdict"],
  };
}

/**
 * Parse CLI flag args into runPipeline opts (no validation). Lets the test
 * harness drive runPipeline with real flag names (e.g. ["--allow-experiments"]).
 * @param {string[]} argv
 * @returns {Partial<PipelineOpts>}
 */
export function pipelineOptsFromArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
  });
  return pipelineOptsFromValues(values);
}

/**
 * Return the first id not in `valid`, or undefined when all are known.
 *
 * @param {string[]} ids
 * @param {string[]} valid
 * @returns {string|undefined}
 */
function unknownId(ids, valid) {
  return ids.find((id) => !valid.includes(id));
}

/**
 * Split a comma-separated string into a trimmed array, or return undefined.
 *
 * @param {string|undefined} value
 * @returns {string[]|undefined}
 */
function splitList(value) {
  if (!value) {
    return undefined;
  }
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
