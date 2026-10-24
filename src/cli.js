// CLI front-end for the review tool: parse argv, validate, drive the pipeline,
// and route the report + exit code. The pipeline core lives in pipeline.js (the
// test harness calls runPipeline there directly).
//
// Review runs directly as `node verify.js <xpi|folder>`, forwarding to
// main(argv) below. `npm run help` is an alias for `verify.js --help`.
//
// Belongs here: the front-end only - the OPTIONS table, usage/help text, argv
// parse and flag validation, the values -> PipelineOpts mapping, stream
// routing, exit codes, and the COMMAND a prompt hands back (the hand-back of a work
// folder). Also creating the work folder a source code review is prepared in, recording the
// flags its review is to run with, and starting that review from them - checked again, as
// a command line is - when the preparation's hand-back finds it done.
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
import { defaultWorkFolder, workPaths } from "./util/dest.js";
import {
  PREPARE_STEP,
  recordBoolean,
  startRecord,
  treeRoots,
} from "./prepare/state.js";
import {
  agentBuildsSwitchedOn,
  asksExpSource,
  copySource,
  handBack,
  recordedRoots,
  startPreparation,
} from "./prepare/steps.js";
import { settleScaRoot } from "./addon/sca-root.js";
import {
  extractXpiToTemp,
  readPackedManifest,
  manifestRecord,
  relativeInside,
} from "./addon/load.js";
import { experimentVerdict } from "./experiments/verify.js";
import { hasErrors } from "./report/finding.js";
import {
  detailRows,
  formatReview,
  scaPromptLines,
  loopPromptLines,
} from "./report/format.js";
import { readState } from "./report/state.js";
import {
  DOWNGRADE_PHASE,
  DOWNGRADE_RESTART,
} from "./checks/registry-vocabulary.js";
import { accept, issue, loopSlots, HandbackRefused } from "./report/loop.js";
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
  report,
  setVerbose,
  setProgress,
  setFeed,
  setQuiet,
  setRecording,
  writeToStderr,
  writeToStdout,
} from "./util/log.js";
import { setColor, red } from "./util/color.js";
import { shellArg, wrapText } from "./util/text.js";
import { parseJson } from "./util/json.js";
import { rethrowIfFatal } from "./lib/errors.js";
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
 * @returns {string}
 */
function helpText(checkIds) {
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
      `Only run these checks (comma-separated). Available: ${checkIds.join(", ")}.`,
    ],
    ["--checks-skip <ids>", "Skip these checks (comma-separated)."],
  ];

  // What an LLM agent runs, in the order it runs: --llm-sca-review prepares a source code
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
      "With --llm-review or --llm-sca-review: leave out the add-on description. The prompt does not ask for one and names no file for it; nothing else about the review changes.",
    ],
    [
      "--llm-skip-manual",
      "With --llm-review or --llm-sca-review: leave out the manual review items. No phase puts them to a reviewer - they stay in the report, for the reviewer to work through later, unless the review was aborted, which takes them out. The build question is still asked. Given with --llm-skip-summary, the review verifies only the add-on's code.",
    ],
    [
      "--llm-skip-sweep",
      "With --llm-review or --llm-sca-review: leave out the sweep. The prompt neither spawns it nor stops for it, and the sweep is not handed to the reviewer either.",
    ],
    [
      "--llm-sca-review",
      "Read the add-on argument as a submission FOLDER - one built .xpi and one archive of the source it was built from - and print the prompt for preparing a source code review of it. It creates the review's work folder at its default place, beside the .xpi, and the prompt has the source extracted into it and the roots its reader worked out handed back with --llm-handback and that work folder, beside the build report it wrote and its judgement whether the build is safe. An unsafe build is reviewed at once, and after a safe one the reviewer is asked whether the agent may build. Each hand-back prints the next prompt: where the source's dependencies have known vulnerabilities, a copy of the source (rescued/ in the work folder) is prepared with fewer or fixed dependencies, and reviewed if that resolves them. Once the preparation is done, the hand-back starts the review itself, with this run's flags: of the copy, or of the source as submitted, whose review the vulnerabilities then abort. An add-on whose Experiment the review would reject is not prepared: its review starts at once. Refused beside any --sca-* flag, which is what it exists to produce.",
    ],
    [
      "--llm-handback <dir>",
      "Take one pass of the review loop, or one step of preparing a source code review: apply what the review file in this work folder carries and print the next prompt - the last one, once nothing else is left, hands over the settled review. A preparation that is done starts its review here, and prints that review's first prompt. The folder is the work folder the review or its preparation started in, and no add-on is named again. The only run that carries on an existing work folder. Normally run by the agent working through the review rather than by a person.",
    ],
  ];

  const sca = [
    [
      "--sca-base <folder>",
      "The extracted source archive, all of it. A folder, not a packed archive: a source archive comes in too many formats for this tool to open, so extract it yourself - unlike the submitted .xpi, which this tool extracts. Setting it switches the review to SCA mode, and every other --sca-* folder must lie inside it. It must not include the add-on. With --llm-review, it is copied into the work folder and the build is worked out from the copy before the review starts.",
    ],
    [
      "--sca-root <folder>",
      "The folder inside --sca-base the build runs in, holding package.json and the lock file: what the review reads as the source. Left out, the linter finds it (the folder holding package.json, below any folders the archive wraps its content in). Needs --sca-base.",
    ],
    [
      "--sca-exp-source <path>",
      "The Experiment implementation folder, inside --sca-root - relative to it or absolute within it, anywhere under it (e.g. addon/experiment-api, or a sibling of the source like experiment), but never the root itself: naming the root would exclude nothing. Its files are privileged, non-WebExtension code, so they are excluded from the WebExtension API/permission checks (which would otherwise false-positive on Services/ChromeUtils). Needs --sca-base; REQUIRED in SCA mode for an Experiment add-on.",
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
    ["--verbose", "Verbose logging."],
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
  "sca-base": { type: "string" },
  "sca-root": { type: "string" },
  "sca-exp-source": { type: "string" },
  "report-format": { type: "string" },
  "llm-sca-review": { type: "boolean" },
  "llm-review": { type: "boolean" },
  "llm-skip-summary": { type: "boolean" },
  "llm-skip-manual": { type: "boolean" },
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

/** The --sca-* flags, which --llm-sca-review exists to work out and so refuses to be given. */
const SCA_FLAGS = ["sca-base", "sca-root", "sca-exp-source"];

/** Where each cache lives when the run names none. */
const CACHE_DIR_DEFAULTS = Object.freeze(
  Object.fromEntries(CACHES.map((c) => [c.flag, c.folder]))
);

/** The flags that name a folder on this machine, each taken to be its real target before
 *  anything reads it (main). --sca-exp-source is not one of them: it names a folder INSIDE
 *  --sca-root, and is followed from there. */
const FOLDER_FLAGS = [
  "sca-base",
  "sca-root",
  "llm-handback",
  ...CACHES.map((c) => c.flag),
  "cache-work-dir",
];

/** The flags never handed on to a later review: the --sca-* ones name the source and its
 *  roots, which the preparation or the review names itself, three run or carry on a review
 *  rather than describing one, and two are this run's alone - its caches are cleared now
 *  (--cache-clear), and its feed is its own (--verbose). A record naming a folder for a
 *  later run to delete is the one thing it must not be able to say. */
const NOT_FORWARDED = new Set([
  "llm-sca-review",
  "llm-review",
  "llm-handback",
  "cache-clear",
  "verbose",
  ...SCA_FLAGS,
]);

/**
 * The flags a review is to be run with, minus its --sca-* and one-run flags
 * (NOT_FORWARDED), as parsed and named without their dashes. The preparation records them
 * (src/prepare/state.js) for the review it starts (preparedReview), and every review
 * records them (`state.flags`) for an XPI review restarted from it. A folder among them is
 * already the real folder (main), so it means the same wherever the review is started.
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
 * The command that carries a preparation on: a hand-back of the work folder named.
 * @param {string} work
 * @returns {string[]}
 */
function handbackCommand(work) {
  return [`--llm-handback ${shellArg(work)}`];
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
 * What is wrong with a value that must name a folder, as the message saying so - or null
 * when nothing is. Asked of the folder the value names, already followed to its real target
 * (main), so how it was spelled - a link, a ".." segment - makes no difference; only where
 * it lands does. Two questions (that a value was given at all is main()'s, asked of every
 * flag that takes one):
 *
 * Does a flag that names a folder INSIDE another one (`within`: --sca-root inside --sca-base,
 * --sca-exp-source inside the root) LAND inside it? A value resolving outside names a folder
 * on the reviewing machine, which can be anywhere, so what it names is not part of the
 * submission and cannot be shown to be.
 *
 * Does it point at a FOLDER? Asked of the resolved path, so a trailing slash cannot answer
 * it differently. A file, a missing path and an unreadable one are all "no".
 * @param {string} flag  The flag's name, for the message.
 * @param {string} value  The value as it was given.
 * @param {string} base  What the value is relative to: the folder it names a folder inside,
 *   and the value's own path otherwise.
 * @param {?string} [within]  The flag naming the folder the value must resolve into however
 *   it was written, or null for one that names a folder of its own.
 * @returns {?{text: string, escape: boolean}}  `escape` marks the outside-the-folder
 *   refusal, which says what to do on its own - the other is worth telling what the folder
 *   is FOR.
 */
function folderProblem(flag, value, base, within = null) {
  // Resolved exactly as the arg-array reader resolves it (pipelineOptsFromValues): against
  // the folder it names a folder inside, against the working directory otherwise. One
  // expression in both places, so the folder asked about here is the folder the review goes
  // on to read rather than a second spelling of it.
  const full = within ? path.resolve(base, value) : path.resolve(value);
  // Asked with the loader's own function, so the guard and the review cannot answer it
  // differently.
  if (within && relativeInside(full, base) === null) {
    return {
      text:
        `--${flag} names a folder inside --${within}: "${value}" resolves to "${full}", ` +
        `which is outside "${path.resolve(base)}".`,
      escape: true,
    };
  }
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
    writeToStderr(`${err.message}\nverify failed\n`);
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
    writeToStderr(`${cleanParseError(err)}\n\n${helpText(checkIds)}`);
    return 2;
  }
  const { values, positionals } = parsed;

  // Output routing by format. The review and the what-is-going-on feed are standard
  // output; a message that is not part of the normal review - a degraded run, a flag
  // that cannot be honoured, a fatal error - goes to stderr (src/util/log.js
  // writeToStderr). JSON is a machine contract: quiet silences the feed so stdout
  // carries only the document.
  const format = values["report-format"] || "text";
  setQuiet(format === "json");
  setVerbose(values.verbose);
  setProgress(format === "text");
  // The runs that print a prompt for an agent: --llm-sca-review prepares a review,
  // --llm-review starts one, and --llm-handback carries it on, down to the settled report
  // a reviewer sends on. Asked once, so every such mode is treated alike.
  const prompts = Boolean(
    values["llm-review"] || values["llm-handback"] || values["llm-sca-review"]
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
    writeToStdout(helpText(checkIds));
    return 0;
  }

  // The format decides how everything below prints, so it is judged as soon as the setters
  // above have been given it: one question, asked once, at the point the value enters, and
  // before any branch can return without asking it.
  if (format !== "text" && format !== "json") {
    writeToStderr(
      `Invalid --report-format "${format}" (expected text or json).\n`
    );
    return 2;
  }

  // The other flag whose value is a closed set, asked the same way (cdnLookupProblem).
  const cdnProblem = cdnLookupProblem(values);
  if (cdnProblem) {
    writeToStderr(`${cdnProblem}\n`);
    return 2;
  }

  // A flag given with no value is refused before any branch reads one (emptyFlagProblem):
  // asked HERE, once, so a run that returns early cannot skip it.
  const emptyProblem = emptyFlagProblem(values);
  if (emptyProblem) {
    writeToStderr(`${emptyProblem}\n`);
    return 2;
  }

  // Every FOLDER named here is taken to be the folder it really is, links followed, before
  // anything reads it: every condition below is asked of that target, and the review reads
  // it. So a folder named through a link is the folder it names, and no link anywhere in a
  // path can carry it past a guard that compares paths. Asked before any branch returns,
  // so the preparation and the review alike see only real folders.
  //
  // A FILE is never followed: the .xpi named here, like the files of a submission folder
  // (src/addon/submission.js), must be the file itself, so a link to one is refused.
  //
  // A cache the run was not given is its default, filled in first so it is taken the same
  // way: the preparation records every cache it used, and the review a later hand-back
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
      writeToStderr(
        `The add-on "${positionals[0]}" is a symlink. Name the .xpi file itself.\n`
      );
      return 2;
    }
    positionals[0] = realFolder(positionals[0]);
  }
  // Named inside the root, so followed from there - the folder the review resolves it to.
  if (values["sca-exp-source"] !== undefined) {
    values["sca-exp-source"] = realFolder(
      path.resolve(rootOf(values) ?? ".", values["sca-exp-source"])
    );
  }

  // A bad --checks-only/--checks-skip id is a bad command line whatever the run does with
  // it, so it is answered before any branch below - including the two that print a prompt.
  // --llm-sca-review records these very flags for the review it prepares: an id nobody can
  // run would travel into it, and the review the preparation starts would fail on it.
  const checkProblem = checkIdProblem(values, checkIds);
  if (checkProblem) {
    writeToStderr(`${checkProblem}\n`);
    return 2;
  }

  // A skip names part of the --llm-review prompt to leave out, so it says nothing without a
  // review to cut down. Two flags take them, not one: --llm-sca-review prepares a review
  // and records them for the review its hand-back starts. The loop's later passes need none - the
  // run they belong to recorded them, and every pass after reads that. Refused FIRST, so
  // every guard below can assume a skip implies one of the two.
  // Not collected by reviewSkips - no `when:` names it - so the rule the others get
  // for free is spelled out for it.
  if (
    values["llm-skip-sweep"] &&
    !values["llm-review"] &&
    values["llm-sca-review"] === undefined
  ) {
    writeToStderr(
      "--llm-skip-sweep names part of the --llm-review prompt to leave out, so it needs " +
        "--llm-review, or --llm-sca-review to hand to the review it prepares: a run that " +
        "prints its report has no prompt to cut down.\n"
    );
    return 2;
  }
  const skips = reviewSkips(values);
  if (
    skips.length &&
    !values["llm-review"] &&
    values["llm-sca-review"] === undefined
  ) {
    const many = skips.length > 1;
    writeToStderr(
      `${listOf(skips.map((flag) => `--${flag}`))} ${many ? "name parts" : "names part"} ` +
        `of the --llm-review prompt to leave out, so ${many ? "they need" : "it needs"} ` +
        "--llm-review, or " +
        "--llm-sca-review to hand to the review it prepares: a run that prints its " +
        "report has no prompt to cut down.\n"
    );
    return 2;
  }

  // The band a review publishes a warning at belongs to the REVIEW, recorded by the run that
  // started it (state.run) and read back by every pass after. Accepting it here too would put
  // the same fact in two places, and a pass given it where the review was not would settle a
  // case in a band the rest of that review does not use.
  if (values["warnings-as-errors"] && values["llm-handback"]) {
    writeToStderr(
      "--warnings-as-errors belongs to the review, which recorded it when it started, so " +
        "a --llm-handback pass reads it back rather than being told it again. Drop it, or " +
        "start the review again with it.\n"
    );
    return 2;
  }

  // --llm-sca-review prepares a review and starts it itself, so it shares nothing with the
  // flags below and is settled here, in full, before any of them are read.
  if (values["llm-sca-review"]) {
    const given = SCA_FLAGS.filter((f) => values[f]);
    if (given.length) {
      writeToStderr(
        `--llm-sca-review works out ${listOf(given.map((f) => `--${f}`))} for you, ` +
          "so it cannot be given them. Drop them, or run --llm-review with the ones you " +
          "already have.\n"
      );
      return 2;
    }
    if (values["llm-review"] || values["llm-handback"]) {
      writeToStderr(
        "--llm-sca-review starts its own review, so it cannot be combined with the " +
          "flags that run or settle one.\n"
      );
      return 2;
    }
    if (format === "json") {
      writeToStderr(
        "--llm-sca-review is text only: it prints a prompt and no report, which is not " +
          "what --report-format json produces.\n"
      );
      return 2;
    }
    // This flag does not take the folder - it changes what the ADD-ON ARGUMENT means, from
    // the add-on to review to the submission holding one. So the argument is required here
    // exactly as it is for a review, and refused in the plural for the same reason.
    if (positionals.length === 0) {
      writeToStderr(
        "--llm-sca-review reads the add-on argument as a submission folder, and none was " +
          "given. Name the folder holding the built .xpi and the archive of its source.\n"
      );
      return 2;
    }
    if (positionals.length > 1) {
      writeToStderr(
        `Only one submission can be prepared at a time, and ${positionals.length} were ` +
          `given: ${positionals.map((p) => `"${p}"`).join(", ")}. If the path contains ` +
          "spaces, quote it.\n"
      );
      return 2;
    }
    const folder = positionals[0];
    // Asked before scaSubmission reads it, so a path that is not a folder at all is
    // answered in this tool's words rather than through a readdir errno.
    if (!pointsAtFolder(path.resolve(folder))) {
      writeToStderr(
        `--llm-sca-review reads the add-on argument as a folder, and "${folder}" is not ` +
          "one. It is the submission folder - the one holding the built .xpi and the " +
          "archive of its source.\n"
      );
      return 2;
    }
    let submission;
    try {
      submission = scaSubmission(folder);
    } catch (err) {
      // The flag's name is this layer's: submission.js says what it found in the folder.
      writeToStderr(`--llm-sca-review "${folder}": ${err.message}\n`);
      return 2;
    }
    // The caches are cleared by the run that was given --cache-clear, never by a later one:
    // the review this preparation starts reads its flags from a record the agent can write,
    // and a record that could name a folder for the linter to delete is one too many.
    // Cleared before anything below reads one.
    if (values["cache-clear"]) {
      clearCaches(cacheDirs(pipelineOptsFromValues(values)));
    }
    let experiments;
    let rejected;
    try {
      ({ experiments, rejected } = await experimentGate(
        submission.xpi,
        values
      ));
    } catch (err) {
      rethrowIfFatal(err);
      writeToStderr(`${err.message}\n${red("verify failed")}\n`);
      return 2;
    }
    // The review's work folder, created here because the source is extracted into it before
    // the review starts: at its default place, beside the .xpi, as every review's is. Not
    // recursive, and an existing one is refused: the folder is fresh by its moment, so one
    // already there belongs to another review.
    const work = defaultWorkFolder(submission.xpi, "sca");
    try {
      fs.mkdirSync(work);
    } catch (err) {
      rethrowIfFatal(err);
      writeToStderr(
        err.code === "EEXIST"
          ? `--llm-sca-review creates a fresh work folder, and "${work}" is already there. ` +
              "Run it again for a folder of its own.\n"
          : `--llm-sca-review could not create the work folder "${work}" (${err.code ?? err.message}).\n`
      );
      return 2;
    }
    if (rejected) {
      let result;
      try {
        result = await startReview(
          { ...forwardedFlags(values), "llm-review": true },
          submission.xpi,
          work,
          registry
        );
      } catch (err) {
        writeToStderr(`${err.message}\n${red("verify failed")}\n`);
        return 2;
      }
      return printReview(result, "text");
    }
    // The preparation's record, at `unpack`, written before the prompt that names its folder.
    const record = startRecord({
      submission: { xpi: submission.xpi, experiments },
      flags: forwardedFlags(values),
      agentBuilds: agentBuildsSwitchedOn(),
    });
    startPreparation(work, record);
    // The prompt IS the output: no review has run, and none can until its reader answers
    // it. Printed as the report is, and to the screen only.
    for (const line of preparationPrompt(work, record, registry, {
      first: true,
      submission,
    })) {
      report(line);
    }
    report("");
    return 0;
  }

  if (values["llm-review"] && values["llm-handback"]) {
    writeToStderr(
      "--llm-review and --llm-handback are the two ends of one review and cannot share a " +
        "run: --llm-review starts it, --llm-handback carries it on.\n"
    );
    return 2;
  }

  // A review flag's whole output is a prompt. JSON is the machine contract for ATN, which
  // wants neither, and asking for both leaves nothing coherent to print - so say so rather
  // than silently favouring one. Asked of BOTH ends of the loop, and before either one
  // branches away: --llm-handback returns just below without reading another guard, so a
  // test further down is a test it never takes - which is how it came to accept a format
  // it then ignored. The flag that was actually used is the one named, since a run that
  // said --llm-handback is not helped by being told about --llm-review.
  if ((values["llm-review"] || values["llm-handback"]) && format === "json") {
    const flag = values["llm-review"] ? "--llm-review" : "--llm-handback";
    writeToStderr(
      `${flag} is text only: it prints a prompt and writes the files the review names, ` +
        "which is not what --report-format json produces.\n"
    );
    return 2;
  }

  // A HAND-BACK: a step of preparing a source code review, or a pass of the review loop
  // after the first (runHandback). No add-on is named: a preparation's record holds it, and
  // a loop pass reads the review from the state in the work folder, because the
  // deterministic review ran ONCE, when the review started.
  if (values["llm-handback"]) {
    return runHandback(values["llm-handback"], registry);
  }

  // No add-on to review: the usage text answers what was missing, and the exit code says
  // it was a mistake rather than a question (--help returns 0, far above).
  if (positionals.length === 0) {
    writeToStdout(helpText(checkIds));
    return 2;
  }

  // ONE add-on per run. A silently ignored second positional is how an unquoted path with
  // a space in it ("/my sub/a.xpi") reviews "/my" and says nothing about the rest.
  if (positionals.length > 1) {
    writeToStderr(
      `Only one add-on can be reviewed at a time, and ${positionals.length} were given: ` +
        `${positionals.map((p) => `"${p}"`).join(", ")}. If the path contains spaces, ` +
        "quote it.\n"
    );
    return 2;
  }

  // --sca-base is the SCA-mode switch: the extracted source archive, all of it. --sca-root
  // and --sca-exp-source name folders INSIDE it, so either is meaningless on its own.
  const named = ["sca-root", "sca-exp-source"].filter((f) => values[f]);
  if (named.length && !values["sca-base"]) {
    const [names, need] =
      named.length > 1 ? ["name folders", "need"] : ["names a folder", "needs"];
    writeToStderr(
      `${listOf(named.map((f) => `--${f}`))} ${names} inside --sca-base, the extracted ` +
        `source archive, and ${need} it (SCA mode). Pass --sca-base, and --sca-root only ` +
        "where the linter cannot find the build folder itself.\n"
    );
    return 2;
  }

  // Every --sca-* flag names a FOLDER that is there. The base is the extracted source -
  // extracting it is the reviewer's, whatever format it came in, unlike the submitted
  // .xpi which this tool extracts itself - the root lies inside it, and --sca-exp-source
  // inside the root. Asked outermost first, so each folder's own validity is settled before
  // anything is looked up inside it.
  //
  // Asked here rather than left to the loader because neither fails loudly
  // there: a --sca-exp-source that names nothing is a WARNING, and the review then reads
  // the Experiment's privileged code as WebExtension code - the thing that flag exists to
  // prevent - on a typo.
  for (const flag of SCA_FLAGS) {
    const value = values[flag];
    if (value === undefined) {
      continue;
    }
    // --sca-base stands on its own. Each other one names a folder INSIDE the one before it,
    // so it is asked about after being resolved against it - the same resolution the reader
    // applies a moment later.
    const within = { "sca-root": "sca-base", "sca-exp-source": "sca-root" }[
      flag
    ];
    const base = {
      "sca-root": values["sca-base"],
      "sca-exp-source": rootOf(values),
    }[flag];
    const problem = folderProblem(flag, value, base ?? ".", within ?? null);
    if (problem) {
      const what =
        flag === "sca-base" && !problem.escape
          ? " This tool cannot open a source archive itself - extract it and point " +
            "--sca-base at the folder it produced."
          : "";
      writeToStderr(`${problem.text}${what}\n`);
      return 2;
    }
  }

  // Everything under --sca-base is the submitted source, copied and built from, so the
  // add-on cannot lie inside it: the review would read the shipped XPI, and the work folder
  // created beside it, as files of the source. Asked of both paths already followed to what
  // they really are.
  const addonPath = path.resolve(positionals[0]);
  if (
    values["sca-base"] &&
    relativeInside(addonPath, values["sca-base"]) !== null
  ) {
    writeToStderr(
      `--sca-base "${values["sca-base"]}" must not include the add-on "${addonPath}".\n`
    );
    return 2;
  }
  // The work folder is always the default, beside the add-on, and must not exist: it is
  // stamped with the moment the run starts, so only two runs started in the same moment
  // reach this, and the second is refused before it reads anything. A review given
  // --sca-base reviews source code, and its folder is named for that.
  const workFolder = defaultWorkFolder(
    addonPath,
    values["sca-base"] ? "sca" : "xpi"
  );
  if (fs.lstatSync(workFolder, { throwIfNoEntry: false })) {
    writeToStderr(`The work folder "${workFolder}" must not exist.\n`);
    return 2;
  }
  // A source review an agent runs is prepared as --llm-sca-review's is, from the build
  // analysis on: the extracted source is copied into the work folder, and the build is worked
  // out before the review starts.
  if (values["llm-review"] && values["sca-base"]) {
    return startSourcePreparation(values, addonPath, workFolder, registry);
  }

  let result;
  try {
    // Settled above, once: the default is stamped with the moment it is named.
    result = await startReview(values, addonPath, workFolder, registry);
  } catch (err) {
    // A pipeline throw is a tool failure the review could not run through (no network, a
    // host that gave no answer, an unusable schema, a bad review config, an unreadable
    // add-on): state
    // it plainly and exit 2, distinct from a completed review that found errors.
    writeToStderr(`${err.message}\n${red("verify failed")}\n`);
    return 2;
  }
  return printReview(result, format);
}

/**
 * Start the preparation of a source review given --sca-base, at `analyze`: the work folder
 * created, the source copied into its `sca/` (copySource), and the build analysis's prompt
 * printed - the step --llm-sca-review reaches once its reader has extracted the archive. An
 * Experiment the review would reject is not prepared (experimentGate): its review starts at
 * once, as an XPI review, as --llm-sca-review's does.
 * @param {Record<string, string|boolean>} values  Parsed and checked, the root settled.
 * @param {string} addonPath  The built add-on, absolute.
 * @param {string} work  The work folder to create, absolute.
 * @param {import("./checks/registry.js").Registry} registry
 * @returns {Promise<number>}
 */
async function startSourcePreparation(values, addonPath, work, registry) {
  if (values["cache-clear"]) {
    clearCaches(cacheDirs(pipelineOptsFromValues(values)));
  }
  let experiments;
  let rejected;
  try {
    ({ experiments, rejected } = await experimentGate(addonPath, values));
  } catch (err) {
    rethrowIfFatal(err);
    writeToStderr(`${err.message}\n${red("verify failed")}\n`);
    return 2;
  }
  try {
    fs.mkdirSync(work);
  } catch (err) {
    rethrowIfFatal(err);
    writeToStderr(
      `--llm-review could not create the work folder "${work}" (${err.code ?? err.message}).\n`
    );
    return 2;
  }
  if (rejected) {
    let result;
    try {
      result = await startReview(
        { ...forwardedFlags(values), "llm-review": true },
        addonPath,
        work,
        registry
      );
    } catch (err) {
      writeToStderr(`${err.message}\n${red("verify failed")}\n`);
      return 2;
    }
    return printReview(result, "text");
  }
  let roots;
  try {
    roots = copySource(work, {
      base: values["sca-base"],
      scaRoot: rootOf(values),
      scaExpSource: values["sca-exp-source"] ?? null,
    });
  } catch (err) {
    rethrowIfFatal(err);
    writeToStderr(`${err.message}\n${red("verify failed")}\n`);
    return 2;
  }
  const record = startRecord({
    submission: { xpi: addonPath, experiments },
    flags: forwardedFlags(values),
    agentBuilds: agentBuildsSwitchedOn(),
    roots,
  });
  startPreparation(work, record);
  for (const line of preparationPrompt(work, record, registry, {
    first: true,
  })) {
    report(line);
  }
  report("");
  return 0;
}

/**
 * Whether the add-on declares Experiments, and whether the review rejects one, asked of the
 * built add-on before a source review is prepared: the Experiment decides whether the roots
 * include the Experiment folder, and one the review would reject is not worth preparing - the
 * review rejects it from the add-on alone, before it reads a line of the source. So the verdict
 * is asked here, by the rule the review asks it by (experimentVerdict), of the add-on's folder
 * or a temporary extraction of the .xpi, and where it rejects, the review starts at once,
 * decides the same, and ends where it always does. --allow-experiments is not asked here: the
 * verdict reads it, and with it rejects nothing.
 * @param {string} addon  The built add-on, a .xpi or its folder, absolute.
 * @param {Record<string, string|boolean>} values
 * @returns {Promise<{experiments: boolean, rejected: boolean}>}
 */
async function experimentGate(addon, values) {
  const isFolder = pointsAtFolder(addon);
  const manifest = isFolder
    ? manifestRecord(
        fs.existsSync(path.join(addon, "manifest.json"))
          ? fs.readFileSync(path.join(addon, "manifest.json"))
          : null
      )
    : readPackedManifest(addon);
  const experiments = isExperiment(manifest.json);
  if (!experiments) {
    return { experiments, rejected: false };
  }
  let temporary = null;
  try {
    const folder = isFolder ? addon : (temporary = extractXpiToTemp(addon));
    const { invalid } = await experimentVerdict(
      folder,
      pipelineOptsFromValues(values)
    );
    return { experiments, rejected: invalid };
  } finally {
    if (temporary) {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}

/**
 * Run a review from parsed values: the one start every caller shares. A command line naming
 * an add-on (main), --llm-sca-review for an Experiment the review rejects (main), the
 * hand-back that finds a source code review prepared (runPreparePass), which builds the
 * values from the preparation's record, and the hand-back that restarts an aborted source
 * review as an XPI review (runLoopPass), from the flags that review recorded.
 *
 * The review records the values it was started with, minus the --sca-* ones and those of
 * one run alone (forwardedFlags), for an XPI review restarted from it.
 *
 * Reading the options can fail the same way the review can - a bad option value is a bad
 * config, not a bad add-on - so it is inside the caller's catch and reported like one.
 * @param {Record<string, string|boolean>} values  Parsed, and checked by the caller.
 * @param {string} addonPath  The add-on, absolute.
 * @param {string} workFolder  The work folder, absolute.
 * @param {import("./checks/registry.js").Registry} registry
 * @param {{downgradedFrom?: string}} [internal]  Pipeline options no command-line flag
 *   sets: the work folder of the source review an XPI review is restarted from.
 * @returns {Promise<import("./pipeline.js").PipelineResult>}
 */
async function startReview(
  values,
  addonPath,
  workFolder,
  registry,
  internal = {}
) {
  const opts = pipelineOptsFromValues(values);
  // --cache-clear: wipe every cache dir up front so the resolvers re-fetch each source from
  // scratch during this review, exactly as on a first run. cacheDirs lists every cache dir
  // opt - a new cache added to pipelineOptsFromValues must be added there too, or
  // --cache-clear would silently skip it.
  if (values["cache-clear"]) {
    clearCaches(cacheDirs(opts));
  }
  return runPipeline({
    // Absolute from here on, like every other path opt (pipelineOptsFromValues).
    addonPath,
    ...opts,
    workFolder,
    registry,
    flags: forwardedFlags(values),
    ...internal,
  });
}

/**
 * Print what a review hands its reader, and answer with the run's exit code.
 *
 * The full report comes from the report layer: formatReview assembles the body - Found
 * Issues and the to-do sections - and the verdict tally LAST. The CLI just writes it.
 *
 * Except under --llm-review, which hands out the first PHASE instead (printed by the
 * pipeline): the prompt tells its reader to work from the file it names, and printing the
 * same review as prose alongside it would invite them to settle the report they can see
 * rather than the entries they can address. The settled report comes from the last pass of
 * the loop.
 * @param {import("./pipeline.js").PipelineResult} result
 * @param {string} format
 * @returns {number}
 */
function printReview(result, format) {
  const rendered = result.meta.prompting ? "" : formatReview(result, format);
  if (rendered) {
    writeToStdout(rendered + "\n");
  }
  return hasErrors(result.findings) ? 1 : 0;
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
 * A --checks-only/--checks-skip id no check has.
 * @param {Record<string, string|boolean>} values
 * @param {string[]} checkIds
 * @returns {?string}  The problem, or null.
 */
function checkIdProblem(values, checkIds) {
  const badCheck = unknownId(
    [
      ...(splitList(values["checks-only"]) ?? []),
      ...(splitList(values["checks-skip"]) ?? []),
    ],
    checkIds
  );
  return badCheck
    ? `Unknown check "${badCheck}" (--checks-only/--checks-skip). Available: ${checkIds.join(", ")}.`
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
 * The build folder the review reads as the source: --sca-root where it was named, else the
 * one found inside --sca-base by the rule the review finds one by (settleScaRoot), the base
 * itself where it holds the package file or the walk cannot decide. Undefined outside SCA
 * mode, and where the base names no folder, which its own check refuses.
 * @param {Record<string, string|boolean|string[]>} values
 * @returns {string|undefined}
 */
function rootOf(values) {
  if (values["sca-root"] !== undefined || values["sca-base"] === undefined) {
    return values["sca-root"];
  }
  return pointsAtFolder(values["sca-base"])
    ? settleScaRoot({ scaRoot: values["sca-base"] }).scaRoot
    : undefined;
}

/**
 * Map parsed CLI `values` (from parseArgs with OPTIONS) to runPipeline opts.
 * Shared by main() and the test harness so both honor the real flag names.
 * Does not include `addonPath` (that comes from the positional path).
 *
 * Every path opt leaves here ABSOLUTE. This is the one layer that knows what each flag is
 * written relative to - the working directory for --sca-base and --sca-root, and the root for
 * --sca-exp-source, which names a folder inside it - so it is the layer that resolves them. Downstream then
 * derives what it needs (an archive key, a containment test) from real paths rather than
 * re-deciding what a relative string meant: one spelling reaching several functions is one
 * spelling answered several ways.
 * @param {Record<string, string|boolean|string[]>} values
 * @returns {Partial<PipelineOpts>}
 */
function pipelineOptsFromValues(values) {
  // Resolved FIRST, because --sca-exp-source is resolved against it. A root left out is
  // passed on left out, and the review finds it inside the base (src/pipeline.js).
  const scaRoot = values["sca-root"]
    ? path.resolve(values["sca-root"])
    : undefined;
  const inRoot = (value) =>
    value === undefined
      ? undefined
      : path.resolve(scaRoot ?? rootOf(values) ?? ".", value);
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
    scaBase: values["sca-base"] ? path.resolve(values["sca-base"]) : undefined,
    scaRoot,
    scaExpSource: inRoot(values["sca-exp-source"]),
    llmReview: Boolean(values["llm-review"]),
    llmSkip: reviewSkips(values),
    // Not a PROMPT_SKIPS member: no `when:` names it. What it withholds is every
    // sweep REQUEST, and with them the per-tree conditions derived from the requests - so
    // no step that starts a sweeping agent prints (src/report/phases.js stepsOf).
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

/**
 * One hand-back of a work folder: a step of preparing a source code review, while the folder
 * holds the preparation's record and no review has started there, and otherwise a pass of
 * the review loop. The folder decides, so the agent runs one command whichever it is.
 * @param {string} work  The work folder, the real folder (main).
 * @param {import("./checks/registry.js").Registry} registry  The authored registry.
 * @returns {Promise<number>}
 */
function runHandback(work, registry) {
  const paths = workPaths(work);
  return fs.existsSync(paths.prepare) && !fs.existsSync(paths.state)
    ? runPreparePass(work, registry)
    : runLoopPass(work, registry);
}

/**
 * One step of preparing a source code review (src/prepare/steps.js), then what it hands out
 * next: the permission question, the build or the rescue, or - once the preparation is
 * done - the review itself, which this hand-back starts, so the agent runs no command but
 * this one. The review's first
 * prompt is then printed by the pipeline, and the run exits as a started review does.
 *
 * A refusal is answered as the review loop answers one: the prompt is not re-printed, and
 * nothing changed, so a corrected hand-back resumes where it was.
 * @param {string} work
 * @param {import("./checks/registry.js").Registry} registry
 * @returns {Promise<number>}
 */
async function runPreparePass(work, registry) {
  let out;
  try {
    out = await handBack(work, registry);
  } catch (err) {
    return refusedOrFailed(err, registry);
  }
  const { record } = out;
  if (out.next === "step") {
    for (const line of preparationPrompt(out.work, record, registry)) {
      writeToStdout(`${line}\n`);
    }
    writeToStdout("\n");
    return 0;
  }
  let result;
  try {
    const values = preparedReview(record, registry.checkIds(), out.work);
    result = await startReview(
      values,
      record.submission.xpi,
      out.work,
      registry
    );
  } catch (err) {
    return refusedOrFailed(err, registry);
  }
  return printReview(result, "text");
}

/**
 * The prompt a preparation's record is waiting on, its step's own (`llm-sca-review-prompt`):
 * printed by the run that starts the preparation (`first`, with the intro) and by every
 * hand-back that moves it on. What each prompt names beside its steps follows its step: the
 * submission and where to extract it (`unpack`), the root and the build report (`analyze`),
 * the Build Review Details (`permission`), and the folders a build runs in. Every build runs at
 * the root's place in `build/`, its output is compared with the submitted XPI, and the rescue's
 * agent makes `build/` a copy of the whole `rescued/` before each build, with the two commands
 * named here.
 * @param {string} work
 * @param {import("./prepare/state.js").PrepareRecord} record  At the step its prompt is for.
 * @param {import("./checks/registry.js").Registry} registry
 * @param {{first?: boolean, submission?: {folder: string, xpi: string, source: string}}}
 *   [start]  On the run that starts the preparation: the intro, and for `unpack` the
 *   submission (scaSubmission).
 * @returns {string[]}
 */
function preparationPrompt(work, record, registry, start = {}) {
  const prompt = registry.llmScaReviewPrompt();
  const paths = workPaths(work);
  const buildRoot = () => treeRoots(work, record.roots.scaRoot).buildRoot;
  const named = {
    [PREPARE_STEP.unpack]: () => ({
      submission: start.submission,
      extractTo: `${paths.sca}${path.sep}`,
    }),
    [PREPARE_STEP.analyze]: () => ({
      answers: paths.review,
      scaRoot: record.roots.scaRoot,
      buildProcess: paths.build,
      findExperiment: asksExpSource(record),
    }),
    [PREPARE_STEP.permission]: () => ({
      answers: paths.review,
      buildDetails: buildDetailLines(work, record, prompt, registry),
    }),
    [PREPARE_STEP.build]: () => ({
      answers: paths.review,
      scaRoot: record.roots.scaRoot,
      buildRoot: buildRoot(),
      buildProcess: paths.build,
      submittedXpi: record.submission.xpi,
    }),
    [PREPARE_STEP.rescue]: () => ({
      answers: paths.review,
      rescueRoot: record.roots.scaRoot,
      buildRoot: buildRoot(),
      buildProcess: paths.build,
      submittedXpi: record.submission.xpi,
      copy: [
        `rm -rf ${shellArg(paths.buildCopy)}`,
        `cp -a ${shellArg(paths.rescued)} ${shellArg(paths.buildCopy)}`,
      ],
    }),
  }[record.step]();
  return scaPromptLines(prompt, record.step, {
    first: Boolean(start.first),
    ...named,
    flags: handbackCommand(work),
  });
}

/**
 * The Build Review Details the permission prompt shows: the submitted XPI, the source root,
 * the build report, the verdict and the issues it was read off, as the review loop's blocks name them (detailRows), so
 * the review's Build Review Details hold every row of it. It ends with the line telling the
 * reviewer the review waits for their reply, as a turn-ending block does.
 * @param {string} work
 * @param {import("./prepare/state.js").PrepareRecord} record  At `permission`.
 * @param {ReturnType<import("./checks/registry.js").Registry["llmScaReviewPrompt"]>} prompt
 * @param {import("./checks/registry.js").Registry} registry
 * @returns {string[]}
 */
function buildDetailLines(work, record, prompt, registry) {
  return [
    ...detailRows({
      xpiFile: path.basename(record.submission.xpi),
      xpi: record.submission.xpi,
      scaRoot: record.roots.scaRoot,
      buildFile: workPaths(work).build,
      buildSafety: record.buildSafety,
      buildIssuesFile: workPaths(work).buildIssues,
    }),
    "",
    registry.llmPhases().waiting("permission"),
  ];
}

/**
 * The fields of a preparation's record the review it starts cannot do without, each with
 * the phrase a refusal names it by. A list, so a field the start comes to depend on is one
 * more entry - and a record missing several is told all of them at once.
 * @type {{holds: (record: object) => boolean, missing: string}[]}
 */
const RECORD_FIELDS = [
  {
    holds: (r) =>
      typeof r.submission?.xpi === "string" && r.submission.xpi !== "",
    missing: "no submission to review",
  },
  {
    holds: (r) => typeof r.roots?.scaRoot === "string",
    missing: "no settled source root",
  },
];

/**
 * The values a prepared review is started with, rebuilt from the preparation's record.
 *
 * The record is a file the agent can write, so nothing is taken from it as it stands: only
 * the flags the preparation forwards (NOT_FORWARDED) and OPTIONS declares, each of its
 * declared type - a boolean `true` or `false` (recordBoolean), `false` being a flag not
 * given - and then checked as a command line is. The add-on and the roots are set
 * last, from the record's own fields, so no flag can name another; and the roots are asked
 * again as the extract step asked them (recordedRoots): followed to the folders they really
 * are, the root inside the work folder's `sca/` and the Experiment folder inside the root,
 * because the agent works in the folder between the step that settled them and this one.
 * The review reads the real folders that answered.
 * @param {import("./prepare/state.js").PrepareRecord} record  At `done`.
 * @param {string[]} checkIds
 * @param {string} work  The work folder the review starts in.
 * @returns {Record<string, string|boolean>}
 * @throws {HandbackRefused}
 */
function preparedReview(record, checkIds, work) {
  const missing = RECORD_FIELDS.filter((field) => !field.holds(record)).map(
    (field) => field.missing
  );
  if (missing.length) {
    throw new HandbackRefused(
      `the preparation's record names ${listOf(missing)}`
    );
  }
  const roots = recordedRoots(work, record.roots);
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
      throw new HandbackRefused(
        `the preparation's record holds --${name} as a value it does not take`
      );
    }
    values[name] = value;
  }
  values["llm-review"] = true;
  // The base is the copy the root sits in: the rescued one where a rescue came out clean,
  // else `sca/`.
  const paths = workPaths(work);
  const rescued = fs.existsSync(paths.rescued)
    ? fs.realpathSync(paths.rescued)
    : null;
  values["sca-base"] =
    rescued && relativeInside(roots.scaRoot, rescued) !== null
      ? rescued
      : fs.realpathSync(paths.sca);
  values["sca-root"] = roots.scaRoot;
  if (roots.scaExpSource !== null) {
    values["sca-exp-source"] = roots.scaExpSource;
  }
  const within = { "sca-root": "sca-base", "sca-exp-source": "sca-root" };
  const problem =
    cdnLookupProblem(values) ??
    emptyFlagProblem(values) ??
    checkIdProblem(values, checkIds) ??
    SCA_FLAGS.map((flag) =>
      values[flag] === undefined
        ? null
        : folderProblem(
            flag,
            values[flag],
            within[flag] ? values[within[flag]] : ".",
            within[flag] ?? null
          )
    ).find(Boolean)?.text;
  if (problem) {
    // Without its full stop: the refusal text goes on after it.
    throw new HandbackRefused(
      problem.endsWith(".") ? problem.slice(0, -1) : problem
    );
  }
  return values;
}

/**
 * Answer a failed hand-back: a refusal goes to the agent as the `refused` text, which has
 * it redo the pass once, and anything else ends the run as the tool's own failure.
 * @param {unknown} err
 * @param {import("./checks/registry.js").Registry} registry
 * @returns {number}  The exit code, 2 either way.
 */
function refusedOrFailed(err, registry) {
  if (err instanceof HandbackRefused) {
    writeToStdout(
      `${fillSlots(registry.llmPhases().refused, { problem: err.problem })}\n`
    );
  } else {
    writeToStderr(`${err.message}\n${red("verify failed")}\n`);
  }
  return 2;
}

/**
 * One pass of the review loop: take a phase back, then hand out the next - the closing
 * phase, once nothing else has work, which carries the finished review.
 *
 * A REFUSAL is answered differently from every other failure here. The prompt is NOT
 * re-printed: the agent still has it, and re-issuing the same text against the same input
 * invites a loop where the same mistake is made again. Nothing in the state changed, so a
 * corrected hand-back resumes exactly where it was - and "abort and say why" is the loud
 * failure, because a review that cannot finish has to say so rather than quietly produce a
 * report out of half a pass.
 * The report format is not a parameter: every pass of the loop prints a prompt, and the
 * one format that is not a prompt is refused before the loop is entered.
 * The work folder is the review: its state and its review file are read there, each by
 * its fixed name (src/util/dest.js workPaths), so nothing the agent edits says where the
 * review is.
 * @param {string} work  The work folder the review started in, as --llm-handback named it.
 * @param {import("./checks/registry.js").Registry} base  The authored registry. Read under
 *   the REVIEW's own band policy below, which only the state can say.
 * @returns {Promise<number>}
 */
async function runLoopPass(work, base) {
  const texts = base.llmPhases();
  const folder = path.resolve(work);
  const stateFile = workPaths(folder).state;
  let state, registry;
  try {
    // A folder holding no review this pass can read is a hand-back gone wrong - the agent
    // ran the command with another folder, or before the review was started - so it is
    // refused to the agent, who has the prompt it was following and can run it again.
    try {
      state = readState(stateFile);
    } catch (err) {
      rethrowIfFatal(err);
      throw new HandbackRefused(
        `"${work}" holds no review this command can carry on (${err.message})`
      );
    }
    // The band policy is the REVIEW's, recorded by the run that started it: this pass was
    // never given the flag, and a case reported HERE becomes a finding here
    // (src/report/verdicts.js asFinding), which has to land in the band the rest of the
    // review was published at.
    registry = base.withPolicy({
      warningsAsErrors: state.run.warningsAsErrors,
    });
    accept(state, folder, texts.phases, registry);
  } catch (err) {
    if (err instanceof HandbackRefused) {
      writeToStdout(`${fillSlots(texts.refused, { problem: err.problem })}\n`);
      return 2;
    }
    writeToStderr(`${err.message}\n${red("verify failed")}\n`);
    return 2;
  }
  // The reviewer chose to restart this aborted source review as an XPI review: it starts
  // here, the way a finished preparation starts its review, and its first prompt is this
  // pass's output. This review's folder stays as it is.
  if (
    state.phase === DOWNGRADE_PHASE &&
    state.values?.[DOWNGRADE_PHASE] === DOWNGRADE_RESTART
  ) {
    return restartAsXpiReview(state, folder, base);
  }
  // A failure from here on is the tool's: the hand-back was accepted. So it is not a
  // refusal - the agent did nothing to correct - and it cannot be redone either: the answer
  // a closing settle refuses is already recorded, and nothing re-prints a prompt for one
  // that was already accepted. The review ends here - a clean failure, not a stack trace.
  // The prompt is built in full before any of it is printed, so a failure part-way leaves
  // no half a prompt behind.
  let next, lines;
  try {
    next = issue(state, folder, texts.phases, registry);
    lines = loopPromptLines(
      texts,
      next.phase,
      next.steps,
      loopSlots(state, next, folder, registry),
      next.preamble
    );
  } catch (err) {
    writeToStderr(`${err.message}\n${red("verify failed")}\n`);
    return 2;
  }
  // The closing phase ends the review. Audible, and printed BEFORE the prompt: what the
  // verdicts did is this tool's note to whoever ran the command, and a line inside the
  // prompt is a line that can be copied along with it. The report the prompt links is
  // already written (issue), so the link is live the moment the reviewer is told to open it.
  // The downgrade phase carries the settled review too, and is not the close.
  const settled = next.phase.answer === "end" ? next.settled : null;
  if (settled?.applied.length) {
    writeToStdout(
      `Applied ${settled.applied.length} verdict(s): ${settled.applied.join(", ")}\n\n`
    );
  }
  for (const line of lines) {
    writeToStdout(`${line}\n`);
  }
  writeToStdout("\n");
  return settled && hasErrors(settled.review.findings) ? 1 : 0;
}

/**
 * Start the XPI review an aborted source review is restarted as: with the flags that review
 * was started with (which hold no --sca-* flag), of the XPI it was submitted with, in a new
 * work folder of its own beside it, named as an XPI review's is. `downgradedFrom` names the
 * source review's folder, which adds the finding telling the developer to submit just the
 * XPI (src/pipeline.js).
 * @param {import("./report/state.js").LoopState} state  The source review's.
 * @param {string} folder  The source review's work folder.
 * @param {import("./checks/registry.js").Registry} registry  The authored registry.
 * @returns {Promise<number>}
 */
async function restartAsXpiReview(state, folder, registry) {
  const addonPath = state.report.meta.xpi;
  const workFolder = defaultWorkFolder(addonPath, "xpi");
  if (fs.lstatSync(workFolder, { throwIfNoEntry: false })) {
    writeToStderr(`The work folder "${workFolder}" must not exist.\n`);
    return 2;
  }
  let result;
  try {
    result = await startReview(
      { ...state.flags, "llm-review": true },
      addonPath,
      workFolder,
      registry,
      { downgradedFrom: folder }
    );
  } catch (err) {
    writeToStderr(`${err.message}\n${red("verify failed")}\n`);
    return 2;
  }
  return printReview(result, "text");
}

/** Fill a linter-owned text's placeholders. The same substitution the prompt uses, so a
 *  slot means the same thing wherever it appears. */
function fillSlots(text, values) {
  return Object.entries(values).reduce(
    (acc, [name, value]) => acc.split(`{{${name}}}`).join(value),
    text
  );
}
