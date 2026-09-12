// CLI front-end for the review tool: parse argv, validate, drive the pipeline,
// and route the report + exit code. The pipeline core lives in pipeline.js (the
// test harness calls runPipeline there directly).
//
// Review runs directly as `node verify.js <xpi|folder>`, forwarding to
// main(argv) below. `npm run help` is an alias for `verify.js --help`.
//
// Belongs here: the front-end only - the OPTIONS table, usage/help text, argv
// parse and flag validation, the values -> PipelineOpts
// mapping, stream/capture routing, and exit codes.
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
import { hasErrors } from "./report/finding.js";
import { formatReview } from "./report/format.js";
import {
  DEFAULT_CACHE,
  EXPERIMENTS_CACHE,
  LIBRARY_HASHES_CACHE,
  CDN_LOOKUP_CACHE,
} from "./config.js";
import {
  info,
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
function helpText() {
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
      `Only run these checks (comma-separated). Available: ${loadRegistry().checkIds().join(", ")}.`,
    ],
    ["--checks-skip <ids>", "Skip these checks (comma-separated)."],
  ];

  const report = [
    ["--report-format <text|json>", "Report output format (default: text)."],
    [
      "--report-out <file>",
      "Write the report to a file in addition to stdout.",
    ],
  ];

  // The two halves of one round trip, in the order they run: --llm-review asks, then
  // --llm-verdict applies the answers. Their own section, because neither is a report
  // format - the first replaces the report with a prompt and a file, the second rebuilds
  // it from settled verdicts.
  const llm = [
    [
      "--llm-review [<file>]",
      "Print a verification prompt and write the review as a JSON item array instead of the report, to a temp file or to <file>. The prompt explains how to settle the items and pass them back with --llm-verdict. Refused with --report-format json.",
    ],
    [
      "--llm-verdict <file>",
      "Apply settled verdicts and print the settled report, from a JSON file written as the --llm-review prompt describes.",
    ],
  ];

  const sca = [
    [
      "--sca-root <folder|zip>",
      "The source archive root (holds package.json/lock). Switches to SCA mode - the readable source is reviewed for code defects, its declared dependencies are audited for popularity + vulnerabilities, and the built XPI (the positional path) is the shipped artifact: authoritative for the manifest, experiments, file-completeness (bundled/web-accessible/unused).",
    ],
    [
      "--sca-source <path>",
      "The add-on code root, relative to --sca-root or an absolute path (e.g. src or addon). Optional; defaults to . (the whole --sca-root reviewed as the source - a flat layout where manifest.json sits at the root). Needs --sca-root.",
    ],
    [
      "--sca-exp-source <path>",
      "The Experiment implementation folder, relative to --sca-root or an absolute path - anywhere within --sca-root (e.g. addon/experiment-api, or a sibling of the source like experiment). Its files are privileged, non-WebExtension code, so they are excluded from the WebExtension API/permission/eval checks (which would otherwise false-positive on Services/ChromeUtils). Needs --sca-root; REQUIRED when --allow-experiments is used in SCA mode.",
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
  "llm-review": { type: "string" },
  "llm-verdict": { type: "string" },
  verbose: { type: "boolean" },
  help: { type: "boolean" },
};

// --llm-review takes an OPTIONAL path: bare it writes the item file where the linter
// chooses, with a path it writes that file. parseArgs has no option type for that - a
// string option demands a value and a boolean one refuses every value - so a bare
// occurrence is rewritten to an empty value before parsing. It refuses
// `--llm-review --other` on its own ("argument is ambiguous"), which is why only the bare
// case needs rewriting: the last token, or one followed by another option.
const OPTIONAL_VALUE = new Set(["--llm-review"]);

/**
 * @param {string[]} argv
 * @returns {string[]}
 */
function withOptionalValues(argv) {
  return argv.map((arg, i) =>
    OPTIONAL_VALUE.has(arg) &&
    (i === argv.length - 1 || argv[i + 1].startsWith("-"))
      ? `${arg}=`
      : arg
  );
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} process exit code
 */
export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: withOptionalValues(argv),
      options: OPTIONS,
      allowPositionals: true,
    });
  } catch (err) {
    emitBanner(argv);
    process.stderr.write(`${cleanParseError(err)}\n\n${helpText()}`);
    return 2;
  }
  const { values, positionals } = parsed;

  // Output routing by format. Everything the tool narrates (the what-is-going-on
  // feed) is standard output, alongside the report - only real tool errors go to
  // stderr. JSON is a machine contract: quiet silences the feed so stdout
  // carries only the document. A text --report-out records the feed so the file
  // is a carbon copy of the screen.
  const format = values["report-format"] || "text";
  setQuiet(format === "json");
  setVerbose(values.verbose);
  setProgress(format === "text");
  // --llm-review hands the report to a model and --llm-verdict produces the settled
  // report a reviewer sends on. Either way the output IS the document, so the record of
  // how it was produced - the Setup and Activity sections - is noise in it. The report's
  // own header and prompt are not feed and still print.
  setFeed(values["llm-review"] === undefined && !values["llm-verdict"]);
  setCapture(format === "text" && Boolean(values["report-out"]));
  // Color only on an interactive text screen. Piped/redirected runs and JSON
  // stay plain, and the --report-out copy is stripped below either way.
  setColor(format === "text" && Boolean(process.stdout.isTTY));

  // Open every direct run with the npm-style banner (suppressed for npm runs,
  // which print their own, and for JSON via quiet). Emitted before the branches
  // below so --help and validation errors all carry it too.
  emitBanner(argv);

  // parseArgs cannot tell --llm-review's optional value from the add-on path, so
  // `--llm-review <addon>` takes the add-on as the output file and leaves nothing to
  // review. Say that, instead of printing the whole help for what looks like a missing
  // argument.
  if (!values.help && positionals.length === 0 && values["llm-review"]) {
    process.stderr.write(
      `"${values["llm-review"]}" was taken as --llm-review's output file, so no add-on ` +
        "was given. Put the add-on first, or write --llm-review=<file>.\n"
    );
    return 2;
  }

  if (values.help || positionals.length === 0) {
    process.stdout.write(helpText());
    return values.help ? 0 : 2;
  }

  if (format !== "text" && format !== "json") {
    process.stderr.write(
      `Invalid --report-format "${format}" (expected text or json).\n`
    );
    return 2;
  }

  // --llm-review's whole output is a prompt and an item file. JSON is the machine
  // contract for ATN, which wants neither, and asking for both leaves nothing coherent to
  // print - so say so rather than silently favouring one.
  if (values["llm-review"] !== undefined && format === "json") {
    process.stderr.write(
      "--llm-review is text only: it prints a prompt and writes an item file, which is " +
        "not what --report-format json produces.\n"
    );
    return 2;
  }

  // The two halves of one round trip, one run each: --llm-review asks the questions,
  // --llm-verdict applies the answers. Together they would print a prompt asking for
  // verdicts on a report that already has them, so the answer file would be written
  // against a review nobody ran. Refuse rather than pick one.
  if (values["llm-review"] !== undefined && values["llm-verdict"]) {
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

  const only = splitList(values["checks-only"]);
  const skip = splitList(values["checks-skip"]);
  // Parse the registry once and thread it into the pipeline, so the yaml is read
  // a single time per run rather than re-parsed per concern.
  const registry = loadRegistry();
  const ids = registry.checkIds();
  const badCheck = unknownId([...(only ?? []), ...(skip ?? [])], ids);
  if (badCheck) {
    process.stderr.write(
      `Unknown check "${badCheck}" (--checks-only/--checks-skip). Available: ${ids.join(", ")}.\n`
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

  // --report-out saves a carbon copy of stdout: the captured narration and the report, if
  // one was printed. Color codes are stripped so the saved file is plain even when the
  // screen was colored.
  const reportOut = values["report-out"];
  if (reportOut) {
    const copy = stripColor(getCapture() + (rendered ? `${rendered}\n` : ""));
    fs.writeFileSync(path.resolve(reportOut), copy);
  }

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
    llmReview: values["llm-review"] !== undefined,
    // The path given with the flag, if any. Empty means "you choose".
    llmReviewOut: values["llm-review"] || undefined,
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
    args: withOptionalValues(argv),
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
