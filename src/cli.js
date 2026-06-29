// CLI front-end for the review tool: parse argv, validate, drive the pipeline,
// and route the report + exit code. The pipeline core lives in pipeline.js (the
// test harness calls runPipeline there directly).
//
// Review runs directly as `node verify.js <xpi|folder>`, forwarding to
// main(argv) below. `npm run help` is an alias for `verify.js --help`.
//
// Belongs here: the front-end only - the OPTIONS table, usage/help text, argv
// parse and flag validation, --llm-list-models, the values -> PipelineOpts
// mapping, stream/capture routing, and exit codes.
//
// Does NOT belong here: running the stages (opts -> Review is pipeline.js
// runPipeline); report layout and rendering (src/report/format.js formatReview
// and src/report/responses.js); the model listing call (src/llm/provider.js);
// the check ids and registry text (src/checks/registry.js).

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";

import { runPipeline } from "./pipeline.js";
import { loadRegistry } from "./checks/registry.js";
import {
  getProvider,
  defaultModelFor,
  defaultBaseUrlFor,
  validateLlmConfig,
  DEFAULT_LLM_TYPE,
} from "./llm/provider.js";
import { hasErrors } from "./report/finding.js";
import {
  formatReview,
  formatReviewBody,
  formatSummary,
} from "./report/format.js";
import {
  DEFAULT_CHANNEL,
  VALID_CHANNELS,
  DEFAULT_CACHE,
  EXPERIMENTS_CACHE,
  LIBRARY_HASHES_CACHE,
  CDN_LOOKUP_CACHE,
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
 * activity feed (see src/pipeline.js). This only prints its prose. Writes to
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
      : summary.error
        ? `  (summary unavailable - ${summary.error})`
        : "  (summary unavailable)";
  const block = `\n── ${title} ──\n\n${body}\n`;
  process.stdout.write(block);
  return block;
}

/**
 * Resolve the LLM config for this run. `--llm-enabled` is the SOLE enabler
 * (`wants`) of the LLM CHECKS. The LLM_API_* env vars only configure the client
 * and never turn the checks on. `--self-assessment-summary` ALSO pulls the
 * provider config (its one closing model call needs it), but does NOT set `wants`
 * - so it back-doors the model without enabling the checks. The config is
 * validated later, hard-failing at the pipeline's Setup pre-flight if it is
 * unusable. LLM_API_TYPE picks the provider (claude | chatgpt | ollama, default
 * claude) and hence the default model (LLM_API_MODEL override) and default base
 * URL. LLM_API_URL overrides that base URL, and Ollama defaults to its localhost
 * endpoint. The key is the real LLM_API_KEY or undefined - a keyless provider
 * (Ollama) needs none, so it is never a fabricated placeholder here.
 * @param {Record<string, string|boolean|string[]>} values
 * @returns {{wants: boolean, apiKey?: string, apiUrl?: string, apiType?: string,
 *   model?: string}}
 */
function resolveLlm(values) {
  const wants = values["llm-enabled"] === true;
  const apiType = (process.env.LLM_API_TYPE || DEFAULT_LLM_TYPE).toLowerCase();
  const apiKey = process.env.LLM_API_KEY || undefined;
  const apiUrl = process.env.LLM_API_URL || defaultBaseUrlFor(apiType);
  const model = process.env.LLM_API_MODEL || defaultModelFor(apiType);
  // The provider config is forwarded whenever the LLM will be called - the checks
  // (`wants`) or the self-assessment's single closing call - but `wants` alone
  // enables the LLM checks.
  const needsConfig = wants || values["self-assessment-summary"] === true;
  return {
    wants,
    apiKey: needsConfig ? apiKey : undefined,
    apiUrl: needsConfig ? apiUrl : undefined,
    apiType: needsConfig ? apiType : undefined,
    model: needsConfig ? model : undefined,
  };
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
    [
      "--library-hashes <path>",
      "Use a local known-library hashes.txt instead of fetching it (offline runs).",
    ],
    [
      "--library-hashes-cache <dir>",
      `Where the fetched library hashes are cached (default: ${LIBRARY_HASHES_CACHE}).`,
    ],
    [
      "--library-hashes-refresh",
      "Re-download the library hashes even if a cached copy exists.",
    ],
    [
      "--experiments-zip <path>",
      "Use a local allowed-experiments repo (zip or directory) instead of downloading.",
    ],
    [
      "--experiments-cache <dir>",
      `Where the fetched allowed-experiments zip is cached (default: ${EXPERIMENTS_CACHE}).`,
    ],
    [
      "--experiments-force-refresh",
      "Re-download the allowed-experiments list even if a cached copy exists.",
    ],
  ];

  const cdn = [
    [
      "--cdn-lookup <true|false>",
      "Identify an unrecognized minified bundle by a jsDelivr content-hash lookup (default: true). Results are cached; an offline run simply finds no match.",
    ],
    [
      "--cdn-lookup-cache <dir>",
      `Where the CDN hash-lookup results are cached (default: ${CDN_LOOKUP_CACHE}).`,
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

  const llmFlags = [
    [
      "--llm-enabled",
      "Enable the LLM checks - cloud (Claude/ChatGPT) or a local model (Ollama), configured via the LLM_API_* environment variables; see the README.",
    ],
    ["--llm-list-models", "List the models your token can use, then exit."],
    [
      "--llm-review",
      "Shorthand for --llm-enabled --full-summary: run an extended AI add-on review.",
    ],
  ];

  const other = [
    [
      "--allow-experiments",
      "Accept add-ons that use Experiment APIs (off by default).",
    ],
    [
      "--scan-minified",
      "Review minified/built code: treat a minified (unidentified) bundle as authored and run all checks on it. Hash-identified libraries, obfuscated code, and VENDOR-declared files stay excluded. Off by default.",
    ],
    [
      "--diff-to <xpi|folder>",
      "Previously published version, to diff against.",
    ],
    [
      "--diff-summary",
      "Adds an AI Summary of the changes between the current and last version (needs --diff-to and an LLM configuration, see README.md).",
    ],
    [
      "--full-summary",
      "Add an AI Summary of the full add-on, what the add-on does, with security notes and a permission review (needs an LLM configuration, see README.md).",
    ],
    [
      "--self-assessment-summary",
      "After the deterministic review, make ONE AI call that audits the findings for false positives and scans the sources for false negatives (a linter self-check). Tries the LLM whether or not --llm-enabled is set, and just logs if no key is configured.",
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
    "CDN library identification:",
    ...cdn.map(([flag, desc]) => optionLine(flag, desc)),
    "",
    "Check selection:",
    ...checks.map(([flag, desc]) => optionLine(flag, desc)),
    "",
    "Report output:",
    ...report.map(([flag, desc]) => optionLine(flag, desc)),
    "",
    "LLM checks:",
    ...llmFlags.map(([flag, desc]) => optionLine(flag, desc)),
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
  "library-hashes": { type: "string" },
  "library-hashes-cache": { type: "string" },
  "library-hashes-refresh": { type: "boolean" },
  "cdn-lookup": { type: "string" },
  "cdn-lookup-cache": { type: "string" },
  "experiments-zip": { type: "string" },
  "experiments-cache": { type: "string" },
  "experiments-force-refresh": { type: "boolean" },
  "checks-only": { type: "string" },
  "checks-skip": { type: "string" },
  eslint: { type: "boolean" },
  "allow-experiments": { type: "boolean" },
  "scan-minified": { type: "boolean" },
  "diff-to": { type: "string" },
  "diff-summary": { type: "boolean" },
  "full-summary": { type: "boolean" },
  "self-assessment-summary": { type: "boolean" },
  "report-format": { type: "string" },
  "report-out": { type: "string" },
  "llm-enabled": { type: "boolean" },
  "llm-list-models": { type: "boolean" },
  "llm-review": { type: "boolean" },
  verbose: { type: "boolean" },
  help: { type: "boolean" },
};

/**
 * The interactive "the LLM request cap was reached - run more?" prompt, handed
 * to the pipeline's request budget (src/llm/budget.js). Reads stdin and writes
 * the question to stderr so it never mixes into the stdout report. Only wired up
 * for an interactive text run. A non-"y" answer (or EOF) stops, and the run's
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
  expandAliasFlags(values);

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

  if (values["llm-list-models"]) {
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

  // The LLM is opt-in (--llm-enabled). Its config (key requirement, an unknown
  // type, a missing/unreachable local model) is validated at the pipeline's
  // Setup pre-flight, which hard-fails there - so there is nothing to check
  // here.

  // The run-wide LLM request cap prompts to continue only at an interactive text
  // terminal. JSON/piped/CI runs have no one to ask, so they hard-stop at the
  // cap (remaining LLM work escalates to manual review).
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

  // The report body (Issues + manual sections) lands first. The advisory LLM
  // summaries (text only) were already generated during the activity feed. Their
  // prose prints next, and the review tally (── Summary ──) prints LAST so the
  // verdict closes the report after the add-on and change summaries.
  let rendered;
  let summaryBlock = "";
  if (format === "text") {
    rendered = formatReviewBody(result);
    process.stdout.write(rendered + "\n");
    // Add-on overview first, then the change delta. Both were generated during
    // the activity feed (src/pipeline.js). Here we only print their prose.
    if (result.summarizeAddon) {
      summaryBlock += summarySection({
        title: "Summary of add-on",
        summary: result.summarizeAddon,
      });
    } else if (values["full-summary"] && !values["llm-enabled"]) {
      const note =
        "\n  (--full-summary needs the LLM; add --llm-enabled with " +
        "LLM_API_KEY set. Skipped.)\n";
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
    if (result.selfAssessment) {
      summaryBlock += summarySection({
        title: "Self-assessment (FP/FN audit)",
        summary: result.selfAssessment,
      });
    }
    // The review tally closes the report, after the advisory summaries above.
    const reviewSummary = formatSummary(result) + "\n";
    process.stdout.write(reviewSummary);
    summaryBlock += reviewSummary;
    // Nudge toward --full-summary only when it would actually help: it would have
    // re-judged the escalated (`extended`) manual items with full-add-on context.
    // Gate strictly on that count - with no unsure items a re-run gains nothing,
    // so we never push the user to spend tokens for nothing.
    const unsureCount = (result.meta.manualReview ?? []).filter(
      (m) => m.extended
    ).length;
    if (!values["full-summary"] && unsureCount > 0) {
      const note =
        "\n  (tip: re-run with --llm-review to have the AI " +
        `re-check the ${unsureCount} unsure item(s) above with full-add-on ` +
        "context, instead of leaving them for manual review.)\n";
      process.stdout.write(note);
      summaryBlock += note;
    }
  } else {
    rendered = formatReview(result, format);
    process.stdout.write(rendered + "\n");
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
  const llm = resolveLlm(values);
  return {
    schemaChannel: values["schema-channel"] || DEFAULT_CHANNEL,
    schemaZip: values["schema-zip"],
    schemaCache: values["schema-cache"] || DEFAULT_CACHE,
    schemaForceRefresh: values["schema-force-refresh"],
    libraryHashes: values["library-hashes"],
    libraryHashesCache: values["library-hashes-cache"] || LIBRARY_HASHES_CACHE,
    libraryHashesForceRefresh: values["library-hashes-refresh"],
    // --cdn-lookup true|false (default true); only an explicit "false" disables.
    cdnLookup: values["cdn-lookup"] !== "false",
    cdnLookupCache: values["cdn-lookup-cache"] || CDN_LOOKUP_CACHE,
    experimentsZip: values["experiments-zip"],
    experimentsCache: values["experiments-cache"] || EXPERIMENTS_CACHE,
    experimentsForceRefresh: values["experiments-force-refresh"],
    checksOnly: splitList(values["checks-only"]),
    checksSkip: splitList(values["checks-skip"]),
    eslint: values.eslint,
    allowExperiments: values["allow-experiments"],
    scanMinified: values["scan-minified"],
    diffTo: values["diff-to"],
    diffSummary: values["diff-summary"],
    fullSummary: values["full-summary"],
    selfAssessmentSummary: values["self-assessment-summary"],
    llmEnabled: llm.wants,
    llmApiKey: llm.apiKey,
    llmModel: llm.model,
    llmApiUrl: llm.apiUrl,
    llmApiType: llm.apiType,
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
  expandAliasFlags(values);
  return pipelineOptsFromValues(values);
}

/**
 * Expand convenience alias flags into the underlying flags so every existing
 * flag-driven path fires unchanged. `--llm-review` is shorthand for
 * "--llm-enabled --full-summary"; it is deliberately referenced nowhere else.
 * @param {Record<string, string|boolean|string[]>} values  Parsed flag values
 *   (mutated in place).
 */
function expandAliasFlags(values) {
  if (values["llm-review"] === true) {
    values["llm-enabled"] = true;
    values["full-summary"] = true;
  }
}

/**
 * Print the models the configured provider's token can use, then exit (the
 * --llm-list-models command). Needs a token, but no add-on path. The provider is
 * LLM_API_TYPE (default claude). LLM_API_URL overrides the endpoint.
 *
 * @returns {Promise<number>} process exit code
 */
async function runListModels() {
  const type = (process.env.LLM_API_TYPE || DEFAULT_LLM_TYPE).toLowerCase();
  const token = process.env.LLM_API_KEY || undefined;
  // The provider owns the requirements: an unknown type, or a key required but
  // missing (Ollama is keyless, so it lists without one).
  const configError = validateLlmConfig(type, { apiKey: token });
  if (configError) {
    process.stderr.write(`${configError}\n`);
    return 2;
  }
  const baseURL = process.env.LLM_API_URL || defaultBaseUrlFor(type);
  let models;
  try {
    models = await getProvider(type).listModels({ token, baseURL });
  } catch (err) {
    process.stderr.write(`Could not list models: ${err.message}\n`);
    return 2;
  }
  const defaultModel = defaultModelFor(type);
  const lines = models.map((m) => {
    const name = m.displayName ? `  (${m.displayName})` : "";
    const def = m.id === defaultModel ? "  [default]" : "";
    return `  ${m.id}${name}${def}`;
  });
  process.stdout.write(
    `Available ${type} models (default: ${defaultModel}):\n${lines.join("\n")}\n`
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
