// CLI front-end for the review tool: parse argv, validate, drive the pipeline,
// and route the report + exit code. The pipeline core lives in pipeline.js (the
// test harness calls runPipeline there directly).
//
// Review runs directly as `node verify.js <xpi|folder>`, forwarding to
// main(argv) below. `npm run help` is an alias for `verify.js --help`.
//
// Belongs here: the front-end only - the OPTIONS table, usage/help text, argv
// parse and flag validation, the values -> PipelineOpts mapping, stream
// routing and exit codes. The entry points, one per kind of submission, each setting its
// own review up (the work folder and its record, the load, the source copied and its package
// root settled), and the hand-back of a work folder, one switch on the mode its record holds,
// whose cases start a review from the flags the record holds - checked again, as a command
// line is. The one catch around every run, the one writer of a run's last message
// (printMessage) and exit handling.
//
// Does NOT belong here: the review itself (src/pipeline.js reviewLoadedSubmission), the
// review loop (src/report/loop.js), the build check's steps (src/build-check/steps.js),
// report layout and rendering (src/report/format.js formatReview and
// src/report/responses.js); the check ids and registry text (src/checks/registry.js).

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  reviewLoadedSubmission,
  runTheNormalChecks,
  populateCtx,
} from "./pipeline.js";
import { loadRegistry } from "./checks/registry.js";
import { scaSubmission } from "./addon/submission.js";
import {
  defaultWorkFolder,
  misplacedFolders,
  misplacedFoldersError,
  workPaths,
} from "./util/dest.js";
import { keepClaims, releaseClaims } from "./util/claims.js";
import { buildResults, recordBoolean } from "./build-check/state.js";
import {
  handBack,
  realSca,
  stepPromptLines,
  unpackEntries,
  unpackedExperiments,
} from "./build-check/steps.js";
import {
  ScaFoldersRejected,
  approveScaFolders,
  scaFoldersMisfit,
  settlePackageRoot,
} from "./addon/package-root.js";
import { relativeInside } from "./addon/load.js";
import { copySource, loadTheXpi } from "./review/start.js";
import {
  MODE,
  addToRecord,
  modeOf,
  namedFolders,
  readRecord,
  startMode,
} from "./review/record.js";
import { handbackIssued, issueHandbackPrompt } from "./review/issue.js";
import { settleReview } from "./review/settle.js";
import { hasErrors } from "./report/finding.js";
import {
  DOWNGRADE_PHASE,
  DOWNGRADE_RESTART,
} from "./checks/registry-vocabulary.js";
import {
  HandbackRefused,
  accept,
  advanceReview,
  closeAt,
  restartAnswer,
} from "./report/loop.js";
import {
  DEFAULT_CACHE,
  EXPERIMENTS_CACHE,
  LIBRARY_HASHES_CACHE,
  CDN_LOOKUP_CACHE,
  NPM_REGISTRY_CACHE,
  SOURCES_CACHE,
  PROMPT_SKIPS,
} from "./config.js";
import {
  info,
  setVerbose,
  setProgress,
  setFeed,
  setQuiet,
  setRecording,
  writeToStderr,
  writeToStdout,
} from "./util/log.js";
import { setColor, red } from "./util/color.js";
import { wrapText } from "./util/text.js";
import { parseJson } from "./util/json.js";
import { recordError, rethrowIfFatal } from "./lib/errors.js";
import { isExperiment, splitList } from "./lib/util.js";
import { networkSwitchedOff } from "./util/net.js";

/** @typedef {import("./pipeline.js").PipelineOpts} PipelineOpts */

// Package identity for the run banner (read once at load).
const { name: PKG_NAME, version: PKG_VERSION } = parseJson(
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
 * (info), so it is suppressed in JSON mode (quiet). The leading and trailing blank
 * lines match npm's spacing.
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
 * @param {import("./checks/registry.js").Registry} registry
 * @returns {string}
 */
function helpText(registry) {
  const { selectable, alwaysRun } = checkChoice(registry);
  const cache = [
    [
      "--cache-clear",
      `Delete every cache directory below before the review, so all fetched sources (${CACHES.map((c) => c.holds).join(", ")}) are re-downloaded from scratch - as on a first run.`,
    ],
    ...CACHES.map((c) => [
      `--${c.flag} <dir>`,
      `${c.help} (default: ${c.folder}).`,
    ]),
  ];

  const checks = [
    [
      "--checks-only <ids>",
      `Only run these checks (comma-separated). Available: ${selectable.join(", ")}.`,
    ],
    [
      "--checks-skip <ids>",
      `Skip these checks (comma-separated). A check that ends a review early always runs and cannot be named: ${alwaysRun.join(", ")}.`,
    ],
  ];

  // What an LLM agent runs, in the order it runs: --llm-auto-review prepares a source code
  // review, then --llm-review asks - leaving out whatever
  // its two --llm-skip-* flags name, given to either - and --llm-handback applies the
  // answers. They get a section of their own, because none is a report format: the first
  // two replace the report with a prompt, the last rebuilds it from settled verdicts.
  const llm = [
    [
      "--llm-review",
      "Start the review loop instead of printing the report: print the first prompt and write the file it names to the work folder. Each pass fills that file in and hands it back with --llm-handback and the work folder, which answers with the next prompt. Refused with --report-format json.",
    ],
    [
      "--llm-skip-summary",
      "With --llm-review or --llm-auto-review: leave out the summary report. The prompt does not ask for one and names no file for it; nothing else about the review changes.",
    ],
    [
      "--llm-skip-sweep",
      "With --llm-review or --llm-auto-review: leave out the sweep. The prompt neither spawns it nor stops for it, and the sweep is not handed to the reviewer either.",
    ],
    [
      "--llm-auto-review",
      "Work out the review an agent runs from a submission FOLDER - one built .xpi and, for a source code review, one archive of the source it was built from. A folder holding only the .xpi is reviewed as --llm-review reviews the .xpi, and an .xpi on its own is reviewed with --llm-review. A folder with a source archive starts a source code review: the work folder is created beside the .xpi, and the prompt has the source extracted into it, its Experiment folder named, and handed back with --llm-handback and that work folder. The linter finds the package root and runs the checks that end a review early: a review they reject is closed at once, and otherwise the next prompt has the build analyzed, and the reviewer then decides whether the build is safe and who builds it. Each hand-back prints the next prompt: where the source's dependencies have known vulnerabilities, a copy of the source (rescued/ in the work folder) is prepared with fewer or fixed dependencies, and reviewed if that resolves them. Once the build check is done, the hand-back starts the review itself, with this run's flags. Refused beside any --sca-* flag, which is what it works out.",
    ],
    [
      "--llm-handback <dir>",
      "Take one pass of the review loop, or one step of a source code review's build check: apply what the answers file in this work folder carries and print the next prompt - the last one, once nothing else is left, hands over the settled review. A build check that is done starts its review here, and prints that review's first prompt. The folder is the work folder the review started in, and nothing else is given: the review recorded every flag it runs with when it started. The only run that carries on an existing work folder. Normally run by the agent working through the review rather than by a person.",
    ],
  ];

  const sca = [
    [
      "--sca-extracted <folder>",
      "The extracted source archive, all of it. A folder, not a packed archive: a source archive comes in too many formats for this tool to open, so extract it yourself - unlike the submitted .xpi, which this tool extracts. Setting it switches the review to SCA mode, and every other --sca-* folder must lie inside it. It must not include the add-on. With --llm-review, it is copied into the work folder and the build is worked out from the copy before the review starts.",
    ],
    [
      "--sca-package-root <folder>",
      "The folder inside --sca-extracted holding package.json and its lock file (package-lock.json or pnpm-lock.yaml), where the build runs: where the package file and the lock are read, and the install runs. The review reads the whole of --sca-extracted. Left out, the linter finds it (the folder holding package.json, below any folders the archive wraps its content in). Needs --sca-extracted.",
    ],
    [
      "--sca-experiments <path>",
      "The Experiment implementation folder, inside --sca-extracted - relative to it or absolute within it, anywhere under it (e.g. addon/experiment-api, or a sibling of the source like experiment), but never --sca-extracted itself, which would exclude nothing, nor a folder holding --sca-package-root. Its files are privileged, non-WebExtension code, so they are excluded from the WebExtension API/permission checks (which would otherwise false-positive on Services/ChromeUtils). Needs --sca-extracted. Required for an Experiment add-on, and refused for any other.",
    ],
  ];

  const other = [
    [
      "--allow-experiments",
      "Accept add-ons that use Experiment APIs (off by default).",
    ],
    [
      "--cdn-lib-lookup <true|false>",
      "Identify an unrecognized bundled library (minified or readable) by a jsDelivr content-hash lookup (default: true). Results are cached. With false, no request goes to jsDelivr.",
    ],
    [
      "--eslint",
      "Run the ESLint code-sanity checks on authored JS (off by default).",
    ],
    ["--help", "Show this help."],
    ["--report-format <text|json>", "Report output format (default: text)."],
    [
      "--verbose",
      "Verbose logging. Recorded with the review, so every --llm-handback of a review started with it runs verbose.",
    ],
    [
      "--warnings-as-errors",
      "Read every warning as an error for this review (off by default): each one is reported in the rejection list rather than as something to resolve with the next release, and the run exits 1. Set once, by the run that starts a review - a --llm-handback pass reads it back from the review.",
    ],
  ];

  const commands = [
    [
      "node verify.js <xpi|folder> [options]",
      "verify an .xpi or source folder against the Thunderbird schema and review policies. The .xpi must be the file itself, never a symlink to one.",
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
    "LLM review:",
    ...llm.map(([flag, desc]) => optionLine(flag, desc)),
    "",
    "Source code archive (SCA):",
    ...sca.map(([flag, desc]) => optionLine(flag, desc)),
    "",
    "Other:",
    ...other.map(([flag, desc]) => optionLine(flag, desc)),
    "",
    "Exit codes: 0 = no errors, 1 = one or more error-severity findings",
    "            (--warnings-as-errors makes every warning one), 2 = tool failure.",
    "",
  ].join("\n");
}

/**
 * Every cache a review reads, the one list the cache flags, their help, their defaults, the
 * review's opts and --cache-clear are all made from, so a cache cannot be known to one of
 * them and missing from another. `holds` is how --cache-clear names what it deletes.
 * --cache-work-dir is not one of them: it is the run's own, which no review shares, and a
 * test's alone.
 * @type {readonly {flag: string, opt: string, holds: string, help: string,
 *   folder: string}[]}
 */
const CACHES = Object.freeze([
  {
    flag: "cache-schema-dir",
    opt: "schemaCache",
    holds: "schema",
    help: "Where the downloaded schema zips are cached",
    folder: DEFAULT_CACHE,
  },
  {
    flag: "cache-hash-db-dir",
    opt: "libraryHashesCache",
    holds: "library-hash DB",
    help: "Where the fetched library-hash database is cached",
    folder: LIBRARY_HASHES_CACHE,
  },
  {
    flag: "cache-cdn-lookup-dir",
    opt: "cdnLookupCache",
    holds: "CDN lookups",
    help: "Where the CDN hash-lookup results are cached, backing --cdn-lib-lookup",
    folder: CDN_LOOKUP_CACHE,
  },
  {
    flag: "cache-npm-registry-dir",
    opt: "npmRegistryCache",
    holds: "npm registry answers",
    help: "Where the npm registry's answers about a lock file's tarball URLs are cached",
    folder: NPM_REGISTRY_CACHE,
  },
  {
    flag: "cache-sources-dir",
    opt: "sourcesCache",
    holds: "library sources",
    help: "Where the pinned library sources a review downloads are kept",
    folder: SOURCES_CACHE,
  },
  {
    flag: "cache-experiments-dir",
    opt: "experimentsCache",
    holds: "allowed-experiments",
    help: "Where the fetched allowed-experiments zip is cached",
    folder: EXPERIMENTS_CACHE,
  },
]);

const OPTIONS = {
  "cache-clear": { type: "boolean" },
  ...Object.fromEntries(CACHES.map((c) => [c.flag, { type: "string" }])),
  "cdn-lib-lookup": { type: "string" },
  "checks-only": { type: "string" },
  "checks-skip": { type: "string" },
  eslint: { type: "boolean" },
  "allow-experiments": { type: "boolean" },
  "sca-extracted": { type: "string" },
  "sca-package-root": { type: "string" },
  "sca-experiments": { type: "string" },
  "report-format": { type: "string" },
  "llm-auto-review": { type: "boolean" },
  "llm-review": { type: "boolean" },
  "llm-skip-summary": { type: "boolean" },
  "llm-skip-sweep": { type: "boolean" },
  "llm-handback": { type: "string" },
  "warnings-as-errors": { type: "boolean" },
  verbose: { type: "boolean" },
  help: { type: "boolean" },
  // The folder a run keeps its cache in (src/util/dest.js runCache), so a test can seed the
  // answers a review reads. Declared only with the network switched off (tests/offline.js),
  // and so refused as unknown in every real run, whose cache is its own work folder's. Not
  // on the help screen, which describes a real run.
  ...(networkSwitchedOff() && { "cache-work-dir": { type: "string" } }),
};

/**
 * What a --llm-review run was told to leave out, named by the flag that said so - the same
 * name a registry step's `when:` condition reads. Read HERE and nowhere else, so
 * main()'s guards and pipelineOptsFromValues cannot drift apart about what was given -
 * they run on different paths (pipelineOptsFromArgv runs none of main's guards).
 * @param {Record<string, string|boolean>} values
 * @returns {string[]}
 */
function reviewSkips(values) {
  return PROMPT_SKIPS.filter((flag) => values[flag]);
}

/** The --sca-* flags, which --llm-auto-review exists to work out and so refuses to be given. */
const SCA_FLAGS = ["sca-extracted", "sca-package-root", "sca-experiments"];

/** Where each cache lives when the run names none. */
const CACHE_DIR_DEFAULTS = Object.freeze(
  Object.fromEntries(CACHES.map((c) => [c.flag, c.folder]))
);

/** The flags that name a folder on this machine, each taken to be its real target before
 *  anything reads it (main). --sca-experiments is not one of them: it names a folder INSIDE
 *  --sca-extracted, and is followed from there. */
const FOLDER_FLAGS = [
  "sca-extracted",
  "sca-package-root",
  "llm-handback",
  ...CACHES.map((c) => c.flag),
  "cache-work-dir",
];

/** The flags never handed on to a later review: the --sca-* ones name the source and the
 *  folders inside it, which the record names itself, three run or carry on a review
 *  rather than describing one, and two are this run's alone - its caches are cleared now
 *  (--cache-clear), and its output is its own (--report-format, and every later run prints
 *  text). A record naming a folder for a later run to delete is the one thing it must not
 *  be able to say. --verbose is recorded: every hand-back of the review runs verbose. */
const NOT_FORWARDED = new Set([
  "llm-auto-review",
  "llm-review",
  "llm-handback",
  "cache-clear",
  "report-format",
  ...SCA_FLAGS,
]);

/**
 * What was typed beside --llm-handback, which takes its work folder and nothing else: every
 * other flag and every positional, as a reader would write them. Empty where the run is no
 * hand-back, or where nothing else was typed.
 * @param {Record<string, string|boolean>} values
 * @param {string[]} typedFlags  The flags typed, before any default is filled in.
 * @param {string[]} positionals
 * @returns {string[]}
 */
function handbackExtras(values, typedFlags, positionals) {
  if (!values["llm-handback"]) {
    return [];
  }
  return [
    ...positionals.map((p) => `"${p}"`),
    ...typedFlags.filter((f) => f !== "llm-handback").map((f) => `--${f}`),
  ];
}

/**
 * The flags a review is to be run with, minus its --sca-* and one-run flags
 * (NOT_FORWARDED), as parsed and named without their dashes. The run that starts a review
 * adds them to the record's permanent part (addGiven), for the review a later
 * hand-back starts (recordedValues) and for an XPI review restarted from it. A folder among
 * them is already the real folder (main), so it means the same wherever the review is
 * started.
 *
 * Read from the PARSED values against OPTIONS, which is what knows a flag from its value.
 * Reading argv again instead means guessing that pairing from the token shapes.
 * @param {Record<string, string|boolean>} values
 * @returns {Record<string, string|boolean>}
 */
function forwardedFlags(values) {
  return Object.fromEntries(
    Object.keys(OPTIONS)
      .filter((name) => !NOT_FORWARDED.has(name) && values[name])
      .map((name) => [name, values[name]])
  );
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
  } catch (err) {
    rethrowIfFatal(err);
    return false;
  }
}

/**
 * Whether `p` is a symbolic link that does not lead to a folder - a file named through a
 * link, or a link leading nowhere, which is refused rather than followed. A path that is no
 * link at all, missing or not, is the reader's to report in its own words.
 * @param {string} p
 * @returns {boolean}
 */
function linkedFile(p) {
  const full = path.resolve(p);
  try {
    if (!fs.lstatSync(full).isSymbolicLink()) {
      return false;
    }
  } catch (err) {
    rethrowIfFatal(err);
    return false;
  }
  return !pointsAtFolder(full);
}

/**
 * The FOLDER `p` really is, as one absolute name, links followed: the name every check
 * asks of, every message quotes, and every record holds, whatever directory a later run
 * reads it from. Read for folders only: a file named through a link is refused before this
 * is asked (linkedFile). A path that does not exist yet (a work folder or a cache folder the
 * run creates) is followed as far as it exists, and the rest joined back on. A path that
 * cannot be followed is taken as it resolves, for the check that reads it to report.
 * @param {string} p
 * @returns {string}  Absolute.
 */
function realFolder(p) {
  const full = path.resolve(p);
  const rest = [];
  let at = full;
  try {
    while (!fs.existsSync(at)) {
      const up = path.dirname(at);
      if (up === at) {
        return full;
      }
      rest.unshift(path.basename(at));
      at = up;
    }
    return path.join(fs.realpathSync(at), ...rest);
  } catch (err) {
    rethrowIfFatal(err);
    return full;
  }
}

/**
 * What is wrong with a value that must name a folder, as the message saying so, or null
 * when nothing is: does it point at a FOLDER? Asked of the folder the value names, already
 * followed to its real target (main), so how it was spelled (a link, a ".." segment) makes no
 * difference, and of the resolved path, so a trailing slash cannot answer it differently. A
 * file, a missing path and an unreadable one are all "no". That a value was given at all is
 * main()'s, asked of every flag that takes one. The folders named inside --sca-extracted are
 * approved against it (src/addon/package-root.js approveScaFolders).
 * @param {string} flag  The flag's name, for the message.
 * @param {string} value  The value as it was given.
 * @returns {?{text: string}}
 */
function folderProblem(flag, value) {
  const full = path.resolve(value);
  if (!pointsAtFolder(full)) {
    return {
      text: `--${flag} must point at a folder: "${value}" does not (looked in "${full}").`,
    };
  }
  return null;
}

/**
 * Every run, a first run or a hand-back, inside the one catch, which answers an error thrown
 * in it: a refusal (HandbackRefused, thrown only in a hand-back) as the refused text, and
 * anything else as a failure. Every run then ends in exit handling.
 *
 * The registry is read and asserted FIRST, before the command line is even parsed. It is
 * this tool's own file, identical on every run, and nothing it could be asked to do means
 * anything while it is broken - not a review, not --help, not a usage error, which prints
 * the check ids the registry names.
 * @param {string[]} argv
 * @returns {Promise<number>} process exit code
 */
export async function main(argv) {
  let registry = null;
  let outcome;
  try {
    registry = loadRegistry();
    outcome = await run(argv, registry);
  } catch (err) {
    outcome = answerError(err, registry);
  }
  // A run that did its job returns a bare exit code, and is told apart from an error answer
  // (a refusal, a failure, a bad command line), which returns its own outcome.
  return exitHandling(
    typeof outcome === "number"
      ? { code: outcome, keep: true, awaitsHandback: handbackIssued() }
      : outcome
  );
}

/**
 * One run: the command line judged, then the entry point it names, or the hand-back. A run
 * that did its job returns its exit code. A bad command line returns what exit handling is
 * given for one, nothing created (badCommandLine).
 * @param {string[]} argv
 * @param {import("./checks/registry.js").Registry} registry
 * @returns {Promise<number|{code: number, keep: boolean}>}
 */
async function run(argv, registry) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
    });
  } catch (err) {
    emitBanner(argv);
    return badCommandLine(`${cleanParseError(err)}\n\n${helpText(registry)}`);
  }
  const { values, positionals } = parsed;
  // What was typed, before the cache defaults below are filled in: a hand-back is refused
  // for anything typed beside its work folder, never for a default.
  const typedFlags = Object.keys(values);

  // Output routing by format. The review and the what-is-going-on feed are standard
  // output; a message that is not part of the normal review - a degraded run, a flag
  // that cannot be honoured, a fatal error - goes to stderr (src/util/log.js
  // writeToStderr). JSON is a machine contract: quiet silences the feed so stdout
  // carries only the document.
  const format = values["report-format"] || "text";
  setQuiet(format === "json");
  setVerbose(values.verbose);
  setProgress(format === "text");
  // The runs that print a prompt for an agent: --llm-auto-review prepares a review,
  // --llm-review starts one, and --llm-handback carries it on, down to the settled report
  // a reviewer sends on. Asked once, so every such mode is treated alike.
  const prompts = Boolean(
    values["llm-review"] || values["llm-handback"] || values["llm-auto-review"]
  );
  // Their output IS the document, so the record of how it was produced - the Setup and
  // Activity sections - is noise in it. The report's own header and prompt are not feed
  // and still print.
  setFeed(!prompts);
  // They also hold their stderr messages back and write them as one block at exit: the
  // agent's harness merges both streams, and a message printed in place would read as part
  // of the prompt it is following.
  setRecording(prompts);
  // Color only on an interactive text screen. Piped/redirected runs and JSON
  // stay plain, so nothing downstream has to undo it.
  setColor(format === "text" && Boolean(process.stdout.isTTY));

  // Open every direct run with the npm-style banner (suppressed for npm runs,
  // which print their own, and for JSON via quiet). Emitted before the branches
  // below so --help and validation errors all carry it too.
  emitBanner(argv);

  // --help is a request for the usage text, not a run, so it is answered before anything
  // that judges the command line: a reader asking what the flags ARE is told, rather than
  // refused over a flag this run will never reach. Only the two things that make an answer
  // impossible come first - a registry this tool cannot read, and a command line it cannot
  // parse. Every guard below can therefore assume a run, and none of them repeats the test.
  if (values.help) {
    writeToStdout(helpText(registry));
    return 0;
  }

  // A HAND-BACK carries on the review its work folder holds, and that review recorded what
  // it runs with when it started (state.json): nothing typed beside the work folder can mean
  // anything, so anything there is a mistake, answered before any other check can answer it.
  const extras = handbackExtras(values, typedFlags, positionals);
  if (extras.length) {
    return badCommandLine(
      "--llm-handback carries on the review its work folder holds, which recorded what it " +
        "runs with when it started, so nothing goes beside the work folder: drop " +
        `${listOf(extras)}.\n`
    );
  }

  // The format decides how everything below prints, so it is judged as soon as the setters
  // above have been given it: one question, asked once, at the point the value enters, and
  // before any branch can return without asking it.
  if (format !== "text" && format !== "json") {
    return badCommandLine(
      `Invalid --report-format "${format}" (expected text or json).\n`
    );
  }

  // The other flag whose value is a closed set, asked the same way (cdnLookupProblem).
  const cdnProblem = cdnLookupProblem(values);
  if (cdnProblem) {
    return badCommandLine(`${cdnProblem}\n`);
  }

  // A flag given with no value is refused before any branch reads one (emptyFlagProblem):
  // asked HERE, once, so a run that returns early cannot skip it.
  const emptyProblem = emptyFlagProblem(values);
  if (emptyProblem) {
    return badCommandLine(`${emptyProblem}\n`);
  }

  // Every FOLDER named here is taken to be the folder it really is, links followed, before
  // anything reads it: every condition below is asked of that target, and the review reads
  // it. So a folder named through a link is the folder it names, and no link anywhere in a
  // path can carry it past a guard that compares paths. Asked before any branch returns,
  // so every mode the record goes through sees only real folders.
  //
  // A FILE is never followed: the .xpi named here, like the files of a submission folder
  // (src/addon/submission.js), must be the file itself, so a link to one is refused.
  //
  // A cache the run was not given is its default, filled in first so it is taken the same
  // way: the record carries every cache the review uses, and the review a later hand-back
  // starts reads those, whatever directory that hand-back runs from.
  for (const [flag, folder] of Object.entries(CACHE_DIR_DEFAULTS)) {
    values[flag] ??= folder;
  }
  for (const flag of FOLDER_FLAGS) {
    if (values[flag] !== undefined) {
      values[flag] = realFolder(values[flag]);
    }
  }
  if (positionals[0] !== undefined) {
    const linked = linkedFile(positionals[0]);
    if (linked) {
      return badCommandLine(
        `The add-on "${positionals[0]}" is a symlink. Name the .xpi file itself.\n`
      );
    }
    positionals[0] = realFolder(positionals[0]);
  }
  // Named inside the extracted archive, so followed from there - the folder the review
  // resolves it to. Without --sca-extracted it names nothing, which is refused below.
  if (
    values["sca-experiments"] !== undefined &&
    values["sca-extracted"] !== undefined
  ) {
    values["sca-experiments"] = realFolder(
      path.resolve(values["sca-extracted"], values["sca-experiments"])
    );
  }

  // A bad --checks-only/--checks-skip id is a bad command line whatever the run does with
  // it, so it is answered before any branch below - including the two that print a prompt.
  // --llm-auto-review records these very flags for the review a hand-back starts: an id
  // nobody can run would travel into it, and that review would fail on it.
  const checkProblem = checkIdProblem(values, registry);
  if (checkProblem) {
    return badCommandLine(`${checkProblem}\n`);
  }

  // A skip names part of the --llm-review prompt to leave out, so it says nothing without a
  // review to cut down. Two flags take them, not one: --llm-auto-review prepares a review
  // and records them for the review its hand-back starts. The loop's later passes need none - the
  // run they belong to recorded them, and every pass after reads that. Refused FIRST, so
  // every guard below can assume a skip implies one of the two.
  // Not collected by reviewSkips - no `when:` names it - so the rule the others get
  // for free is spelled out for it.
  if (
    values["llm-skip-sweep"] &&
    !values["llm-review"] &&
    values["llm-auto-review"] === undefined
  ) {
    return badCommandLine(
      "--llm-skip-sweep names part of the --llm-review prompt to leave out, so it needs " +
        "--llm-review, or --llm-auto-review to hand to the review it prepares: a run that " +
        "prints its report has no prompt to cut down.\n"
    );
  }
  const skips = reviewSkips(values);
  if (
    skips.length &&
    !values["llm-review"] &&
    values["llm-auto-review"] === undefined
  ) {
    const many = skips.length > 1;
    return badCommandLine(
      `${listOf(skips.map((flag) => `--${flag}`))} ${many ? "name parts" : "names part"} ` +
        `of the --llm-review prompt to leave out, so ${many ? "they need" : "it needs"} ` +
        "--llm-review, or " +
        "--llm-auto-review to hand to the review it prepares: a run that prints its " +
        "report has no prompt to cut down.\n"
    );
  }

  // --llm-auto-review works out which review an agent runs from the submission folder it is
  // given: one with only an .xpi is reviewed as --llm-review reviews that .xpi, and one with a
  // source starts at unpack, whose hand-back reviews it. Settled here, in full, before any
  // of the flags below are read.
  if (values["llm-auto-review"]) {
    const given = SCA_FLAGS.filter((f) => values[f]);
    if (given.length) {
      return badCommandLine(
        `--llm-auto-review works out ${listOf(given.map((f) => `--${f}`))} for you, ` +
          "so it cannot be given them. Drop them, or run --llm-review with the ones you " +
          "already have.\n"
      );
    }
    if (values["llm-review"]) {
      return badCommandLine(
        "--llm-auto-review starts its own review, so it cannot be combined with " +
          "--llm-review.\n"
      );
    }
    if (format === "json") {
      return badCommandLine(
        "--llm-auto-review is text only: it prints a prompt and no report, which is not " +
          "what --report-format json produces.\n"
      );
    }
    // The flag changes what the ADD-ON ARGUMENT means, so the argument is required here
    // exactly as it is for a review, and refused in the plural for the same reason.
    const takes =
      "--llm-auto-review reviews a submission folder - one .xpi and, for a source code " +
      "review, the archive of its source";
    if (positionals.length === 0) {
      return badCommandLine(`${takes} - and none was given.\n`);
    }
    if (positionals.length > 1) {
      return badCommandLine(
        `Only one submission can be reviewed at a time, and ${positionals.length} were ` +
          `given: ${positionals.map((p) => `"${p}"`).join(", ")}. If the path contains ` +
          "spaces, quote it.\n"
      );
    }
    // The path is the real folder by now (realFolder above): a submission folder named through
    // a link is the folder it names. An .xpi on its own is reviewed with --llm-review.
    const target = fs.lstatSync(path.resolve(positionals[0]), {
      throwIfNoEntry: false,
    });
    if (!target?.isDirectory()) {
      return badCommandLine(`${takes} - and "${positionals[0]}" is not one.\n`);
    }
    // The submission folder, as read (src/addon/submission.js).
    let submission;
    try {
      submission = scaSubmission(positionals[0]);
    } catch (err) {
      // The flag's name is this layer's: submission.js says what it found in the folder.
      return badCommandLine(
        `--llm-auto-review "${positionals[0]}": ${err.message}\n`
      );
    }
    if (!submission.source) {
      const { "llm-auto-review": _auto, ...asked } = values;
      return reviewXpi(
        { ...asked, "llm-review": true },
        submission.xpi,
        registry,
        "text"
      );
    }
    return autoReview(values, submission, registry);
  }

  // A review flag's whole output is a prompt. JSON is the machine contract for ATN, which
  // wants neither, and asking for both leaves nothing coherent to print - so say so rather
  // than silently favouring one. A hand-back given --report-format was refused above.
  if (values["llm-review"] && format === "json") {
    return badCommandLine(
      "--llm-review is text only: it prints a prompt and writes the files the review names, " +
        "which is not what --report-format json produces.\n"
    );
  }

  // A HAND-BACK: one switch on the mode the work folder's record holds (runHandback). No
  // add-on is named: the record holds it, and a loop pass reads the review from the record,
  // because the deterministic review ran ONCE, when the review started.
  if (values["llm-handback"]) {
    return runHandback(values["llm-handback"], registry);
  }

  // No add-on to review: the usage text answers what was missing, and the exit code says
  // it was a mistake rather than a question (--help returns 0, far above).
  if (positionals.length === 0) {
    return badCommandLine(helpText(registry), "stdout");
  }

  // ONE add-on per run. A silently ignored second positional is how an unquoted path with
  // a space in it ("/my sub/a.xpi") reviews "/my" and says nothing about the rest.
  if (positionals.length > 1) {
    return badCommandLine(
      `Only one add-on can be reviewed at a time, and ${positionals.length} were given: ` +
        `${positionals.map((p) => `"${p}"`).join(", ")}. If the path contains spaces, ` +
        "quote it.\n"
    );
  }

  // --sca-extracted is the SCA-mode switch: the extracted source archive, all of it. --sca-package-root
  // and --sca-experiments name folders INSIDE it, so either is meaningless on its own.
  const named = ["sca-package-root", "sca-experiments"].filter(
    (f) => values[f]
  );
  if (named.length && !values["sca-extracted"]) {
    const [names, need] =
      named.length > 1 ? ["name folders", "need"] : ["names a folder", "needs"];
    return badCommandLine(
      `${listOf(named.map((f) => `--${f}`))} ${names} inside --sca-extracted, the extracted ` +
        `source archive, and ${need} it (SCA mode). Pass --sca-extracted, and --sca-package-root only ` +
        "where the linter cannot find the package root itself.\n"
    );
  }

  // --sca-extracted names a FOLDER that is there: the extracted source - extracting it is the
  // reviewer's, whatever format it came in, unlike the submitted .xpi which this tool extracts
  // itself. The folders named inside it are approved against it by the source path itself,
  // before anything is created (reviewWithSource).
  if (values["sca-extracted"] !== undefined) {
    const problem = folderProblem("sca-extracted", values["sca-extracted"]);
    if (problem) {
      return badCommandLine(
        `${problem.text} This tool cannot open a source archive itself - extract it and ` +
          "point --sca-extracted at the folder it produced.\n"
      );
    }
  }

  // Everything under --sca-extracted is the submitted source, copied and built from, so the
  // add-on cannot lie inside it: the review would read the shipped XPI, and the work folder
  // created beside it, as files of the source. Asked of both paths already followed to what
  // they really are.
  const addonPath = path.resolve(positionals[0]);
  if (
    values["sca-extracted"] &&
    relativeInside(addonPath, values["sca-extracted"]) !== null
  ) {
    return badCommandLine(
      `--sca-extracted "${values["sca-extracted"]}" must not include the add-on "${addonPath}".\n`
    );
  }
  // One entry point per kind of submission: an .xpi, or an .xpi with its source. Plain or an
  // agent's (--llm-review) is a mode of each.
  if (values["sca-extracted"]) {
    return reviewWithSource(values, addonPath, registry, format);
  }
  return reviewXpi(values, addonPath, registry, format);
}
/**
 * Print the message a run ends with: the one writer for a failure, a bad command line and a
 * refusal, each caller giving the stream and the text. Exit handling follows it at once.
 * @param {"stdout"|"stderr"} stream
 * @param {string} text  With its own newlines.
 */
function printMessage(stream, text) {
  if (stream === "stdout") {
    writeToStdout(text);
  } else {
    writeToStderr(text);
  }
}

/**
 * A bad command line: what is wrong with it printed, without "verify failed", since nothing
 * was verified, and exit 2 with nothing created.
 * @param {string} text  What is wrong, its own newlines included.
 * @param {"stdout"|"stderr"} [stream]  stderr, but for the usage text a run naming no add-on
 *   is answered with.
 * @returns {{code: number, keep: boolean}}
 */
function badCommandLine(text, stream = "stderr") {
  printMessage(stream, text);
  return { code: 2, keep: false };
}

/**
 * Answer an error thrown in a run, in the one catch around every run: a refusal
 * (HandbackRefused) to stdout as the refused text with its problem filled in, the files kept
 * so the agent redoes that pass in the same folder, and anything else as a failure, its
 * message and "verify failed" to stderr, the files this run created removed.
 * @param {unknown} err
 * @param {?import("./checks/registry.js").Registry} registry  Null where it failed to load.
 * @returns {{code: number, keep: boolean}}
 */
function answerError(err, registry) {
  if (err instanceof HandbackRefused) {
    printMessage(
      "stdout",
      `${fillSlots(registry.llmPhases().refused, { problem: err.problem })}\n`
    );
    return { code: 2, keep: true };
  }
  printMessage("stderr", failureText(err?.message ?? err));
  return { code: 2, keep: false };
}

/**
 * A failure as it is printed: its message, then "verify failed".
 * @param {unknown} message
 * @returns {string}
 */
function failureText(message) {
  return `${message}\n${red("verify failed")}\n`;
}

/**
 * Exit handling, which every run ends in: given whether the files this run wrote stay, the
 * exit code, and whether the run did its job and issued a hand-back prompt, it acts on them.
 * The files stay when the run did its job, a refusal included, and the files and folders this
 * run created are removed after a failure (src/util/claims.js). A run that did its job and
 * issued a hand-back prompt leaves the review unfinished, so it exits 0, whatever the review's
 * errors. A refusal or a failure is no run that did its job, so its code stands. The process
 * leaves through exitWith (src/util/log.js, verify.js).
 * @param {{code: number, keep: boolean, awaitsHandback?: boolean}} outcome
 * @returns {number}  The exit code.
 */
function exitHandling({ code, keep, awaitsHandback = false }) {
  if (keep) {
    keepClaims();
    return awaitsHandback ? 0 : code;
  }
  try {
    releaseClaims();
  } catch (err) {
    printMessage(
      "stderr",
      `Could not remove what this run created (${err.code ?? err.message}).\n`
    );
  }
  return code;
}

/**
 * --cache-clear: every cache folder wiped by the run that was given it, before its load, so
 * the resolvers re-fetch each source from scratch during this review, exactly as on a first
 * run. Never by a later run: a hand-back reads its flags from the record, and a record that
 * could name a folder for the linter to delete is one too many.
 * @param {Record<string, string|boolean>} values
 */
function clearCachesAsked(values) {
  if (values["cache-clear"]) {
    clearCaches(cacheDirs(pipelineOptsFromValues(values)));
  }
}

/**
 * The options a review runs with, from the flags it was given or recorded.
 * @param {Record<string, string|boolean>} values
 * @param {string} work  The work folder.
 * @param {string} addonPath  The add-on, absolute.
 * @param {import("./checks/registry.js").Registry} registry
 * @param {object} [extra]  What no flag says: the source folders and the package root's move,
 *   the Experiment verdict an earlier run recorded, the source review a restart comes from.
 * @returns {PipelineOpts}
 */
function reviewOpts(values, work, addonPath, registry, extra = {}) {
  return {
    addonPath,
    ...pipelineOptsFromValues(values),
    workFolder: work,
    registry,
    ...extra,
  };
}

/**
 * Add to the record what the run was given, right after the load: the submission, built
 * here once (the add-on, absolute, and whether its manifest.json declares Experiments), the
 * kind of review, the flags its review runs with, and the folder the load made, xpi/
 * (src/review/record.js addToRecord).
 * @param {import("./review/start.js").LoadedXpi} loaded
 * @param {string} addonPath  The add-on, absolute.
 * @param {"xpi"|"sca"} kind
 * @param {Record<string, string|boolean>} flags  As given or recorded (forwardedFlags).
 * @returns {object}  The record as written.
 */
function addGiven(loaded, addonPath, kind, flags) {
  return addToRecord(loaded.work, loaded.record, {
    submission: {
      xpi: addonPath,
      experiments: isExperiment(loaded.manifest.json),
    },
    kind,
    flags,
    folders: { xpi: workPaths(loaded.work).xpi },
  });
}

/**
 * The path of an XPI review, plain or --llm-review (①a and ②a), and of --llm-auto-review given
 * an .xpi alone: the .xpi loaded into a work folder of its own beside it, then reviewed.
 * @param {Record<string, string|boolean>} values  Parsed and checked.
 * @param {string} addonPath  The add-on, absolute.
 * @param {import("./checks/registry.js").Registry} registry
 * @param {string} format  The report's format.
 * @returns {Promise<number>}
 */
async function reviewXpi(values, addonPath, registry, format) {
  clearCachesAsked(values);
  const loaded = loadTheXpi(addonPath, defaultWorkFolder(addonPath, "xpi"));
  const record = addGiven(loaded, addonPath, "xpi", forwardedFlags(values));
  const { code } = await reviewLoadedSubmission({
    opts: reviewOpts(values, loaded.work, addonPath, registry),
    llm: Boolean(values["llm-review"]),
    format,
    record,
  });
  return code;
}

/**
 * What is wrong with --sca-package-root or --sca-experiments, as approveScaFolders threw it,
 * said as a bad command line.
 * @param {import("./addon/package-root.js").ScaFoldersRejected} problem
 * @param {Record<string, string|boolean>} values
 * @returns {string}
 */
function scaFlagProblem({ which, problem, real }, values) {
  const flag = {
    packageRoot: "sca-package-root",
    experiments: "sca-experiments",
  }[which];
  const value = values[flag];
  const base = values["sca-extracted"];
  const why = {
    outside:
      `--${flag} names a folder inside --sca-extracted: "${value}" resolves to "${real}", ` +
      `which is outside "${base}".`,
    "not-folder": `--${flag} must point at a folder: "${value}" does not (looked in "${real}").`,
    "is-source": `--sca-experiments "${value}" is the extracted source archive itself.`,
    "holds-root": `--sca-experiments "${value}" holds the package root "${
      values["sca-package-root"] ?? base
    }".`,
    empty:
      `--sca-experiments "${value}" holds no file, so it would exclude nothing from the ` +
      "WebExtension code checks. Name the folder holding the Experiment implementation.",
  }[problem];
  const named =
    problem === "is-source" || problem === "holds-root"
      ? " It names the Experiment implementation, a folder of its own inside the extracted " +
        "source archive beside or below the WebExtension code, so it cannot be the whole " +
        "archive or hold the package root: the wrong code would be excluded, and the " +
        "Experiment's privileged code would be reviewed as WebExtension code. Name the " +
        "subfolder holding it."
      : "";
  return `${why}${named}\n`;
}

/**
 * The path of a source code review given the extracted source (①b plain, ②b --llm-review):
 * the folders named inside it approved before anything is created, the .xpi loaded and what
 * was given added to the record, the Experiment folder held to whether the add-on declares
 * one, the source copied into the work folder's sca/ and that folder added to the record, its
 * package root settled there, then the review.
 * @param {Record<string, string|boolean>} values  Parsed and checked, with --sca-extracted.
 * @param {string} addonPath  The built add-on, absolute.
 * @param {import("./checks/registry.js").Registry} registry
 * @param {string} format  The report's format.
 * @returns {Promise<number|{code: number, keep: boolean}>}
 */
async function reviewWithSource(values, addonPath, registry, format) {
  const extracted = values["sca-extracted"];
  let approved;
  try {
    approved = approveScaFolders(extracted, {
      packageRoot: values["sca-package-root"],
      experiments: values["sca-experiments"],
    });
  } catch (err) {
    if (!(err instanceof ScaFoldersRejected)) {
      throw err;
    }
    return badCommandLine(scaFlagProblem(err, values));
  }
  clearCachesAsked(values);
  const loaded = loadTheXpi(addonPath, defaultWorkFolder(addonPath, "sca"));
  const record = addGiven(loaded, addonPath, "sca", forwardedFlags(values));
  // The Experiment folder is named exactly for an add-on with Experiments, as a review given
  // these flags needs it. Refused before the source is copied.
  const misfit = scaFoldersMisfit(approved, isExperiment(loaded.manifest.json));
  if (misfit) {
    throw new Error(misfit);
  }
  const sca = copySource(loaded.work, extracted);
  const copied = addToRecord(loaded.work, record, { folders: { sca } });
  const { folders, moved } = settlePackageRoot(sca, approved);
  const { code } = await reviewLoadedSubmission({
    opts: reviewOpts(values, loaded.work, addonPath, registry, {
      scaFolders: folders,
      ...(moved ? { scaMoved: moved } : {}),
    }),
    llm: Boolean(values["llm-review"]),
    format,
    record: copied,
  });
  return code;
}

/**
 * The path of --llm-auto-review given a submission folder with a source archive (③): the
 * .xpi loaded, what the run was given added to the record, then mode unpack started, whose
 * prompt has the agent extract the archive into the work folder's sca/.
 * @param {Record<string, string|boolean>} values  Parsed and checked.
 * @param {{folder: string, xpi: string, source: string}} submission  The folder, as read
 *   (src/addon/submission.js).
 * @param {import("./checks/registry.js").Registry} registry
 * @returns {number}
 */
function autoReview(values, submission, registry) {
  clearCachesAsked(values);
  const loaded = loadTheXpi(
    submission.xpi,
    defaultWorkFolder(submission.xpi, "sca")
  );
  const record = startMode(
    addGiven(loaded, submission.xpi, "sca", forwardedFlags(values)),
    MODE.unpack,
    {},
    "unpack"
  );
  issueHandbackPrompt(
    loaded.work,
    record,
    unpackEntries(record),
    stepPromptLines(loaded.work, record, registry, { first: true, submission })
  );
  return 0;
}

/**
 * The fields of the record the review a hand-back starts cannot do without, each with the
 * phrase a refusal names it by. A list, so a field the start comes to depend on is one more
 * entry - and a record missing several is told all of them at once.
 * @type {{holds: (record: object) => boolean, missing: string}[]}
 */
const RECORD_FIELDS = [
  {
    holds: (r) =>
      typeof r.submission?.xpi === "string" && r.submission.xpi !== "",
    missing: "no submission to review",
  },
];

/**
 * The values a review a hand-back starts is run with, rebuilt from the flags the record holds
 * (`flags`, added to its permanent part by the run that started the review).
 *
 * The record is a file the agent can write, so nothing is taken from it as it stands: only
 * the flags a review forwards (NOT_FORWARDED) and OPTIONS declares, each of its declared type
 * - a boolean `true` or `false` (recordBoolean), `false` being a flag not given - and then
 * checked as a command line is. A record that does not hold them so is a failure
 * (recordError), which the agent cannot repair.
 * @param {object} record
 * @param {import("./checks/registry.js").Registry} registry
 * @returns {Record<string, string|boolean>}
 * @throws {Error}
 */
function recordedValues(record, registry) {
  const missing = RECORD_FIELDS.filter((field) => !field.holds(record)).map(
    (field) => field.missing
  );
  if (missing.length) {
    throw recordError(`the review's record names ${listOf(missing)}`);
  }
  const flags =
    record.flags && typeof record.flags === "object" ? record.flags : {};
  const values = {};
  for (const [name, { type }] of Object.entries(OPTIONS)) {
    if (NOT_FORWARDED.has(name) || !Object.hasOwn(flags, name)) {
      continue;
    }
    const value = flags[name];
    if (type === "boolean") {
      // `false` is a flag not given, so it is left out.
      if (recordBoolean(value, `--${name}`)) {
        values[name] = true;
      }
      continue;
    }
    if (typeof value !== "string") {
      throw recordError(
        `the review's record holds --${name} as a value it does not take`
      );
    }
    values[name] = value;
  }
  values["llm-review"] = true;
  const problem =
    cdnLookupProblem(values) ??
    emptyFlagProblem(values) ??
    checkIdProblem(values, registry);
  if (problem) {
    // Without its full stop: the failure's text goes on after it.
    throw recordError(problem.endsWith(".") ? problem.slice(0, -1) : problem);
  }
  return values;
}

/**
 * One hand-back of a work folder. Its entry asks three things in order, each "no" a failure
 * with nothing written and the files kept, since a hand-back has made nothing yet: is there a
 * record the reader takes (readRecord), is it in a mode (a record with no mode holds no
 * review in progress), and are the folders the record names still there and real folders
 * (namedFolders, misplacedFolders). Then one switch on the mode picks the case. The
 * hand-back reads what earlier runs settled from the record, and rebuilds only ctx.
 * @param {string} work  The work folder, the real folder (main).
 * @param {import("./checks/registry.js").Registry} registry  The authored registry.
 * @returns {Promise<number|{code: number, keep: boolean}>}
 */
async function runHandback(work, registry) {
  let record;
  try {
    record = readRecord(work);
  } catch (err) {
    rethrowIfFatal(err);
    return handbackFailure(err.message);
  }
  const mode = modeOf(record);
  if (mode === undefined) {
    return handbackFailure(
      `The work folder "${work}" holds no review in progress: its review was not run by an ` +
        "agent (--llm-review), or its run ended before it issued a prompt, so there is " +
        "nothing to hand back. Start the review again from the submission."
    );
  }
  const misplaced = misplacedFolders(namedFolders(record));
  if (misplaced.length) {
    return handbackFailure(misplacedFoldersError(work, misplaced).message);
  }
  // A review started with --verbose runs every hand-back verbose: the flag is recorded, and
  // never typed beside --llm-handback.
  const flags = record.flags ?? {};
  if (
    Object.hasOwn(flags, "verbose") &&
    recordBoolean(flags.verbose, "--verbose")
  ) {
    setVerbose(true);
  }
  switch (mode) {
    case MODE.unpack:
      return unpackCase(work, record, registry);
    case MODE.buildCheck:
      return buildCheckCase(work, record, registry);
    case MODE.review:
      return reviewCase(work, record, registry);
    case MODE.downgrade:
      return downgradeCase(work, record, registry);
  }
}

/**
 * A hand-back that cannot start on the record it found: no record the reader takes, one with
 * no review in progress, or one whose folders are no longer those the linter made. Not the
 * agent's to correct, so printed as a failure is, and the files are kept, since they are no
 * run's of this hand-back.
 * @param {string} text  The message, without its newline.
 * @returns {{code: number, keep: boolean}}
 */
function handbackFailure(text) {
  printMessage("stderr", failureText(text));
  return { code: 2, keep: true };
}

/**
 * What is wrong with the Experiment folder the agent named at unpack, as approveScaFolders
 * threw it, said as the problem a refusal fills in.
 * @param {import("./addon/package-root.js").ScaFoldersRejected} problem
 * @param {string} sca  The real sca/.
 * @returns {string}
 */
function unpackProblem({ problem, real }, sca) {
  if (problem === "outside" || problem === "not-folder") {
    return `SCA_EXPERIMENTS "${real}" is not a folder inside "${sca}"`;
  }
  if (problem === "empty") {
    return (
      `SCA_EXPERIMENTS "${real}" holds no file: name the folder holding the Experiment ` +
      "implementation"
    );
  }
  return (
    `SCA_EXPERIMENTS "${real}" is EXTRACT_TO itself, which holds the add-on's own code: ` +
    "name the subfolder holding the Experiment implementation"
  );
}

/**
 * The unpack case: the agent's sca/ a real folder, the Experiment folder it named approved
 * against it, the folder sca/ added to the record, the package root settled there, and the
 * review of the loaded submission, LLM.
 * @param {string} work
 * @param {object} record  In mode unpack.
 * @param {import("./checks/registry.js").Registry} registry
 * @returns {Promise<number>}
 * @throws {HandbackRefused}
 */
async function unpackCase(work, record, registry) {
  const sca = realSca(workPaths(work));
  const experiments = unpackedExperiments(work, record);
  let approved;
  try {
    approved = approveScaFolders(
      sca,
      experiments === undefined ? {} : { experiments }
    );
  } catch (err) {
    if (!(err instanceof ScaFoldersRejected)) {
      throw err;
    }
    throw new HandbackRefused(unpackProblem(err, sca));
  }
  const unpacked = addToRecord(work, record, {
    folders: { sca: workPaths(work).sca },
  });
  const { folders, moved } = settlePackageRoot(sca, approved);
  const values = recordedValues(unpacked, registry);
  const { code } = await reviewLoadedSubmission({
    opts: reviewOpts(values, work, record.submission.xpi, registry, {
      scaFolders: folders,
      ...(moved ? { scaMoved: moved } : {}),
      // The verdict a review started here before recorded, which this one takes as its own.
      ...(Object.hasOwn(unpacked, "verification")
        ? { verification: unpacked.verification }
        : {}),
    }),
    llm: true,
    format: "text",
    record: unpacked,
  });
  return code;
}

/**
 * The build-check case: the step the record is at takes the agent's answer, or refuses it.
 * Not done, the record at the next step is issued with its prompt. Done, the build results
 * are added to the record (buildResults), then the review starts: ctx populated, the normal
 * checks run, since the early-exit checks ran in an earlier run, and the review loop started.
 * A review start that fails leaves the folder done, and the next hand-back finds the build
 * results there.
 * @param {string} work
 * @param {object} record  In mode build-check.
 * @param {import("./checks/registry.js").Registry} registry
 * @returns {Promise<number>}
 * @throws {HandbackRefused}
 */
async function buildCheckCase(work, record, registry) {
  const out = await handBack(work, record, registry);
  if (out.next === "step") {
    issueHandbackPrompt(
      work,
      out.record,
      out.entries,
      stepPromptLines(work, out.record, registry)
    );
    return 0;
  }
  const done = addToRecord(work, out.record, {
    build: buildResults(work, out.record.current),
  });
  const values = recordedValues(done, registry);
  const opts = reviewOpts(values, work, done.submission.xpi, registry, {
    scaFolders: done.build.roots,
    verification: done.verification ?? null,
  });
  const ctx = await populateCtx(opts, workPaths(work), done.build);
  const { code } = await runTheNormalChecks(ctx, {
    opts,
    llm: true,
    format: "text",
    record: done,
    earlyIds: done.earlyExit?.checksRun ?? [],
  });
  return code;
}

/**
 * The review case: the pass handed back, its answers well formed, settled with the verdicts
 * so far and the new answers. One the loop cannot take, or whose settle throws, is refused
 * with nothing stored. One that settles is accepted, its answers stored, and the review
 * advanced with that settled review. A failure after the pass was accepted is the tool's,
 * not a refusal: the agent did nothing to correct.
 * @param {string} work
 * @param {object} record  In mode review.
 * @param {import("./checks/registry.js").Registry} base  The authored registry.
 * @returns {number}  0, the close 0 or 1 by the settled review.
 * @throws {HandbackRefused}
 */
function reviewCase(work, record, base) {
  const registry = base.withPolicy(bandPolicyOf(record));
  const accepted = accept(record, work, registry);
  const { issued, settled } = advanceReview(
    work,
    accepted.record,
    accepted.settled,
    registry
  );
  return issued === "close" && hasErrors(settled.findings) ? 1 : 0;
}

/**
 * The band policy a review was started with, read off the flags the record's permanent part
 * holds (--warnings-as-errors), so every later pass reads the review under it.
 * @param {object} record
 * @returns {{warningsAsErrors: boolean}}
 */
function bandPolicyOf(record) {
  return { warningsAsErrors: record.flags?.["warnings-as-errors"] === true };
}

/**
 * The downgrade case: the reviewer's answer to the restart prompt. `xpi` loads the .xpi into
 * a new work folder of its own and reviews it, LLM, with the recorded flags and the source
 * review it restarts (`downgradedFrom`), and this review's folder stays as it is. `keep`
 * settles the review again from the record's permanent part and issues the closing prompt,
 * with the reviewer's `keep` among its values, so it leaves out the summary and the details
 * the restart prompt already showed. Any other answer is refused.
 * @param {string} work
 * @param {object} record  In mode downgrade.
 * @param {import("./checks/registry.js").Registry} base  The authored registry.
 * @returns {Promise<number>}
 * @throws {HandbackRefused}
 */
async function downgradeCase(work, record, base) {
  const registry = base.withPolicy(bandPolicyOf(record));
  const answer = restartAnswer(work, record, registry);
  if (answer === DOWNGRADE_RESTART) {
    const values = recordedValues(record, base);
    const addonPath = record.submission.xpi;
    const loaded = loadTheXpi(addonPath, defaultWorkFolder(addonPath, "xpi"));
    const restarted = addGiven(
      loaded,
      addonPath,
      "xpi",
      forwardedFlags(values)
    );
    const { code } = await reviewLoadedSubmission({
      opts: reviewOpts(values, loaded.work, addonPath, base, {
        downgradedFrom: work,
      }),
      llm: true,
      format: "text",
      record: restarted,
    });
    return code;
  }
  const review = record.review;
  const settled = settleReview(review, review.answers ?? {}, registry);
  closeAt(work, record, settled, registry, { [DOWNGRADE_PHASE]: answer });
  return hasErrors(settled.findings) ? 1 : 0;
}

/**
 * Every cache folder a review reads, for --cache-clear.
 * @param {Partial<PipelineOpts>} opts  From pipelineOptsFromValues.
 * @returns {string[]}
 */
function cacheDirs(opts) {
  return CACHES.map((c) => opts[c.opt]);
}

/**
 * --cdn-lib-lookup is the one flag whose value is a closed set besides the report format.
 * It reads as a boolean but arrives as a string, and the derivation disables the lookup on
 * the exact lowercase "false" alone - so "False", "no" and "flase" would all leave it ON.
 * The lookup sends content hashes of the submission to a third party, which is the thing a
 * reviewer turning it off for a sensitive submission, or to work offline, asked it not to
 * do. There is no reading of a misspelt value that is safe to guess.
 * @param {Record<string, string|boolean>} values
 * @returns {?string}  The problem, or null.
 */
function cdnLookupProblem(values) {
  const cdnLookup = values["cdn-lib-lookup"];
  return cdnLookup !== undefined &&
    cdnLookup !== "true" &&
    cdnLookup !== "false"
    ? `Invalid --cdn-lib-lookup "${cdnLookup}" (expected true or false).`
    : null;
}

/**
 * A flag given with no value names something and says nothing, so it is refused before any
 * reader takes it. What a value MEANS is each reader's question, but whether one was given
 * at all is the parser's. parseArgs hands "--flag=" down as "", which every reader tests for
 * truth and so reads as "not given": a named cache would silently be the default one, and
 * a named format would fall back to text.
 * @param {Record<string, string|boolean>} values
 * @returns {?string}  The problem, or null.
 */
function emptyFlagProblem(values) {
  const empty = Object.entries(OPTIONS).find(
    ([name, opt]) =>
      opt.type === "string" &&
      values[name] !== undefined &&
      !values[name].trim()
  );
  return empty ? `--${empty[0]} needs a value, and none was given.` : null;
}

/**
 * The check ids --checks-only/--checks-skip may name, and the ones they may not: a check that
 * ends a review early always runs (checkSelected).
 * @param {import("./checks/registry.js").Registry} registry
 * @returns {{selectable: string[], alwaysRun: string[]}}
 */
function checkChoice(registry) {
  const ids = registry.checkIds();
  return {
    selectable: ids.filter((id) => registry.earlyExitFor(id) === null),
    alwaysRun: ids.filter((id) => registry.earlyExitFor(id) !== null),
  };
}

/**
 * A --checks-only/--checks-skip id no check has, or one of a check that always runs.
 * @param {Record<string, string|boolean>} values
 * @param {import("./checks/registry.js").Registry} registry
 * @returns {?string}  The problem, or null.
 */
function checkIdProblem(values, registry) {
  const { selectable, alwaysRun } = checkChoice(registry);
  const named = [
    ...(splitList(values["checks-only"]) ?? []),
    ...(splitList(values["checks-skip"]) ?? []),
  ];
  const fixed = named.find((id) => alwaysRun.includes(id));
  if (fixed) {
    return `"${fixed}" ends a review early and always runs, so --checks-only/--checks-skip cannot name it.`;
  }
  const badCheck = unknownId(named, selectable);
  return badCheck
    ? `Unknown check "${badCheck}" (--checks-only/--checks-skip). Available: ${selectable.join(", ")}.`
    : null;
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
 * Does not include `addonPath` (that comes from the positional path).
 *
 * Every path opt leaves here ABSOLUTE. The source folders are no options: the source path
 * approves them, copies the source and settles its package root (reviewWithSource), and
 * hands the review the folders in its work folder.
 * @param {Record<string, string|boolean|string[]>} values
 * @returns {Partial<PipelineOpts>}
 */
function pipelineOptsFromValues(values) {
  return {
    ...Object.fromEntries(
      CACHES.map((c) => [c.opt, values[c.flag] || c.folder])
    ),
    // --cdn-lib-lookup true|false, default true. Only those two values reach here (main
    // refuses the rest), so this is the default-when-absent expression and nothing more.
    cdnLookup: values["cdn-lib-lookup"] !== "false",
    checksOnly: splitList(values["checks-only"]),
    checksSkip: splitList(values["checks-skip"]),
    eslint: values.eslint,
    allowExperiments: values["allow-experiments"],
    warningsAsErrors: values["warnings-as-errors"],
    llmReview: Boolean(values["llm-review"]),
    llmSkip: reviewSkips(values),
    // Not a PROMPT_SKIPS member: no `when:` names it. What it withholds is every
    // sweep REQUEST, and with them the per-tree conditions derived from the requests - so
    // no step that starts a sweep agent prints (src/report/phases.js stepsOf).
    llmSkipSweep: Boolean(values["llm-skip-sweep"]),
    workCache: values["cache-work-dir"]
      ? path.resolve(values["cache-work-dir"])
      : undefined,
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
/** Fill a linter-owned text's placeholders. The same substitution the prompt uses, so a
 *  slot means the same thing wherever it appears. */
function fillSlots(text, values) {
  return Object.entries(values).reduce(
    (acc, [name, value]) => acc.split(`{{${name}}}`).join(value),
    text
  );
}
