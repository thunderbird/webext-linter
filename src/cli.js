// CLI front-end for the review tool: parse argv, validate, drive the pipeline,
// and route the report + exit code. The pipeline core lives in pipeline.js (the
// test harness calls runPipeline there directly).
//
// Review runs directly as `node verify.js <xpi|folder>`, forwarding to
// main(argv) below. `npm run help` is an alias for `verify.js --help`.
//
// Belongs here: the front-end only - the OPTIONS table, usage/help text, argv
// parse and flag validation, --claude-list-models, the values -> PipelineOpts
// mapping, stream/capture routing, and exit codes.
//
// Does NOT belong here: running the stages (opts -> Review is pipeline.js
// runPipeline); report layout and rendering (src/report/format.js formatReview
// and src/report/responses.js); the model listing call (src/llm/claude.js
// listModels); the check ids and registry text (src/checks/registry.js).

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";

import { runPipeline } from "./pipeline.js";
import { loadRegistry } from "./checks/registry.js";
import { listModels } from "./llm/claude.js";
import { hasErrors } from "./report/finding.js";
import { formatReview } from "./report/format.js";
import {
  DEFAULT_CHANNEL,
  VALID_CHANNELS,
  DEFAULT_CACHE,
  DEFAULT_MODEL,
  MAX_LLM_REQUESTS_PER_RUN,
} from "./config.js";
import {
  info,
  setVerbose,
  setProgress,
  setQuiet,
  setCapture,
  getCapture,
} from "./util/log.js";
import { setColor, stripColor } from "./util/color.js";
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
 * @param {string} flag  The flag and its argument, e.g. "--schema-zip <path>".
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
 * Render one advisory LLM summary after the review report: a "── title ──"
 * header, a status line naming the LLM and the transmitted payload size, then
 * (once the deferred call returns) the model's wrapped prose - or a short note
 * if it could not be produced. The summary was already generated during the
 * activity feed (see src/pipeline.js); this only prints its prose. Writes to
 * stdout and returns the whole block so the caller can also copy it into a
 * --report-out file.
 * @param {object} section
 * @param {string} section.title  Section heading, e.g. "Summary of add-on".
 * @param {import("./pipeline.js").GeneratedSummary} section.summary
 * @returns {string}
 */
function summarySection({ title, summary }) {
  const body =
    summary.text != null
      ? wrapText(summary.text, "  ").join("\n")
      : "  (summary unavailable)";
  const block = `\n── ${title} ──\n\n${body}\n`;
  process.stdout.write(block);
  return block;
}

/**
 * Resolve whether this run uses the LLM and with which key. The LLM is opt-in:
 * --claude-model or --claude-enabled signals intent. A
 * bare CLAUDE_API_KEY in the environment no longer auto-enables it, so a
 * reviewer with a global key can still run the deterministic checks alone. When
 * opted in, the key comes from the CLAUDE_API_KEY environment variable. It is
 * undefined otherwise, so every downstream LLM path stays off.
 * @param {Record<string, string|boolean|string[]>} values
 * @returns {{wants: boolean, apiKey: string|undefined}}
 */
function resolveClaude(values) {
  const wants =
    values["claude-model"] != null || values["claude-enabled"] === true;
  const apiKey = process.env.CLAUDE_API_KEY;
  return { wants, apiKey: wants ? apiKey : undefined };
}

/**
 * The central help screen: a one-line command summary and the shared options,
 * printed by `npm run help` and as the --help / usage screen (see main).
 * @returns {string}
 */
export function helpText() {
  const schema = [
    [
      "--schema-channel <name>",
      `Channel to use (default: ${DEFAULT_CHANNEL}). One of: ${VALID_CHANNELS.join(", ")}.`,
    ],
    [
      "--schema-zip <path>",
      "Use a local schema zip (or directory) instead of downloading.",
    ],
    [
      "--schema-cache <dir>",
      `Where downloaded schema zips are cached (default: ${DEFAULT_CACHE}).`,
    ],
    [
      "--schema-force-refresh",
      "Re-download the schema even if a cached copy exists.",
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

  const claude = [
    [
      "--claude-enabled",
      "Enable the LLM checks (the key comes from the CLAUDE_API_KEY environment variable).",
    ],
    [
      "--claude-model <id>",
      `Model for LLM checks (default: ${DEFAULT_MODEL}).`,
    ],
    [
      "--claude-list-models",
      "List the Anthropic models available to your token, then exit.",
    ],
  ];

  const other = [
    [
      "--allow-experiments",
      "Accept add-ons that use Experiment APIs (off by default).",
    ],
    [
      "--diff-to <xpi|folder>",
      "Previously published version, to diff against.",
    ],
    [
      "--diff-summary",
      "Adds an AI Summary of the changes between the current and last version (needs --diff-to and a Claude API key).",
    ],
    [
      "--full-summary",
      "Add an AI Summary of the full add-on, what the add-on does, with security notes and a permission review (needs a Claude API key).",
    ],
    [
      "--eslint",
      "Run the ESLint code-sanity checks on authored JS (off by default).",
    ],
    ["--help", "Show this help."],
    ["--verbose", "Verbose logging (text mode only)."],
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
    "Schema selection (manifest_version is auto-detected, you pick the channel):",
    ...schema.map(([flag, desc]) => optionLine(flag, desc)),
    "",
    "Check selection:",
    ...checks.map(([flag, desc]) => optionLine(flag, desc)),
    "",
    "Report output:",
    ...report.map(([flag, desc]) => optionLine(flag, desc)),
    "",
    "LLM checks (Claude):",
    ...claude.map(([flag, desc]) => optionLine(flag, desc)),
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
  "schema-channel": { type: "string" },
  "schema-zip": { type: "string" },
  "schema-cache": { type: "string" },
  "schema-force-refresh": { type: "boolean" },
  "checks-only": { type: "string" },
  "checks-skip": { type: "string" },
  eslint: { type: "boolean" },
  "allow-experiments": { type: "boolean" },
  "diff-to": { type: "string" },
  "diff-summary": { type: "boolean" },
  "full-summary": { type: "boolean" },
  "report-format": { type: "string" },
  "report-out": { type: "string" },
  "claude-enabled": { type: "boolean" },
  "claude-model": { type: "string" },
  "claude-list-models": { type: "boolean" },
  verbose: { type: "boolean" },
  help: { type: "boolean" },
};

/**
 * The interactive "the LLM request cap was reached - run more?" prompt, handed
 * to the pipeline's request budget (src/llm/budget.js). Reads stdin and writes
 * the question to stderr so it never mixes into the stdout report. Only wired up
 * for an interactive text run; a non-"y" answer (or EOF) stops, and the run's
 * remaining LLM work escalates to manual review.
 * @param {number} used  Requests already made this run.
 * @returns {Promise<boolean>}  Whether to allow MAX_LLM_REQUESTS_PER_RUN more.
 */
async function confirmMoreLlmRequests(used) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await rl.question(
      `\nReached the LLM request limit (${used} requests this run). ` +
        `Run ${MAX_LLM_REQUESTS_PER_RUN} more? [y/N] `
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} process exit code
 */
export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
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
  setCapture(format === "text" && Boolean(values["report-out"]));
  // Color only on an interactive text screen. Piped/redirected runs and JSON
  // stay plain, and the --report-out copy is stripped below either way.
  setColor(format === "text" && Boolean(process.stdout.isTTY));

  // Open every direct run with the npm-style banner (suppressed for npm runs,
  // which print their own, and for JSON via quiet). Emitted before the branches
  // below so --help, list-models, and validation errors all carry it too.
  emitBanner(argv);

  if (values["claude-list-models"]) {
    return runListModels();
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

  const schemaChannel = values["schema-channel"] || DEFAULT_CHANNEL;
  if (!VALID_CHANNELS.includes(schemaChannel)) {
    process.stderr.write(
      `Invalid --schema-channel "${schemaChannel}" (expected one of: ${VALID_CHANNELS.join(", ")}).\n`
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

  // The LLM is opt-in (resolveClaude): a --claude-enabled/-model flag turns it on.
  // If the run asked for it but no token resolved, fail fast instead of silently
  // reviewing without the LLM.
  const claude = resolveClaude(values);
  if (claude.wants && !claude.apiKey) {
    process.stderr.write(
      "Enabling the LLM checks needs an Anthropic API token " +
        "(set CLAUDE_API_KEY in the environment).\n"
    );
    return 2;
  }

  // The run-wide LLM request cap prompts to continue only at an interactive text
  // terminal; JSON/piped/CI runs have no one to ask, so they hard-stop at the cap
  // (remaining LLM work escalates to manual review).
  const interactive =
    format === "text" && Boolean(process.stdin.isTTY && process.stdout.isTTY);

  let result;
  try {
    result = await runPipeline({
      addonPath: positionals[0],
      ...pipelineOptsFromValues(values),
      // The reviewer review-page URL is a text-report extra (JSON omits it).
      reviewUrl: format === "text",
      confirmMore: interactive ? confirmMoreLlmRequests : undefined,
      registry,
    });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }

  const rendered = formatReview(result, format);
  // Always emit the report to stdout (the report phase). The advisory summaries
  // (text only) were already generated during the activity feed; their prose is
  // printed after the report so the review lands first.
  process.stdout.write(rendered + "\n");
  let summaryBlock = "";
  if (format === "text") {
    // Add-on overview first, then the change delta. Both were generated during
    // the activity feed (src/pipeline.js); here we only print their prose.
    if (result.summarizeAddon) {
      summaryBlock += summarySection({
        title: "Summary of add-on",
        summary: result.summarizeAddon,
      });
    } else if (values["full-summary"] && !claude.apiKey) {
      const note =
        "\n  (--full-summary needs the LLM; add --claude-enabled with " +
        "CLAUDE_API_KEY set. Skipped.)\n";
      process.stdout.write(note);
      summaryBlock += note;
    }
    if (result.summarize) {
      summaryBlock += summarySection({
        title: "Summary of changes",
        summary: result.summarize,
      });
    } else if (values["diff-summary"]) {
      const note =
        "\n  (--diff-summary needs --diff-to and the LLM; skipped.)\n";
      process.stdout.write(note);
      summaryBlock += note;
    }
  }

  // --report-out saves a carbon copy of stdout: the captured feed, the report,
  // and the summaries. JSON captures nothing and has no summaries, so the file
  // is just the document. Color codes are stripped so the saved file is plain
  // even when the screen was colored.
  const reportOut = values["report-out"];
  if (reportOut) {
    const copy = stripColor(getCapture() + rendered + "\n" + summaryBlock);
    fs.writeFileSync(path.resolve(reportOut), copy);
  }

  return hasErrors(result.findings) ? 1 : 0;
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
    schemaChannel: values["schema-channel"] || DEFAULT_CHANNEL,
    schemaZip: values["schema-zip"],
    schemaCache: values["schema-cache"] || DEFAULT_CACHE,
    schemaForceRefresh: values["schema-force-refresh"],
    checksOnly: splitList(values["checks-only"]),
    checksSkip: splitList(values["checks-skip"]),
    eslint: values.eslint,
    allowExperiments: values["allow-experiments"],
    diffTo: values["diff-to"],
    diffSummary: values["diff-summary"],
    fullSummary: values["full-summary"],
    claudeApiKey: resolveClaude(values).apiKey,
    claudeModel: values["claude-model"],
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
 * Print the Anthropic models available to the token, then exit (the
 * --claude-list-models command). Needs a token, but no add-on path.
 *
 * @returns {Promise<number>} process exit code
 */
async function runListModels() {
  const token = process.env.CLAUDE_API_KEY;
  if (!token) {
    process.stderr.write(
      "--claude-list-models needs an Anthropic API token " +
        "(set CLAUDE_API_KEY in the environment).\n"
    );
    return 2;
  }
  let models;
  try {
    models = await listModels({ token });
  } catch (err) {
    process.stderr.write(`Could not list models: ${err.message}\n`);
    return 2;
  }
  const lines = models.map((m) => {
    const name = m.displayName ? `  (${m.displayName})` : "";
    const def = m.id === DEFAULT_MODEL ? "  [default]" : "";
    return `  ${m.id}${name}${def}`;
  });
  process.stdout.write(
    `Available Anthropic models (default: ${DEFAULT_MODEL}):\n${lines.join("\n")}\n`
  );
  return 0;
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
